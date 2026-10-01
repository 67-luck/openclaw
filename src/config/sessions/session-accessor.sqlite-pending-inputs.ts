import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import type { GatewayPendingInputWorkerAuthority } from "../../gateway/server-methods/session-mutation-guards.js";
import {
  isAgentEventLifecycleGenerationCurrent,
  registerAgentEventLifecycleRotationHandler,
} from "../../infra/agent-events.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { captureSqliteWorkerCallerTransaction } from "../../infra/sqlite-worker-host-context.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { assertCapturedSessionEntryReadSource } from "./session-accessor.sqlite-exact-read.js";
import {
  isFinalInputCompletion,
  readSessionPendingInputByKey,
  readSessionPendingInputAppendInTransaction,
  consumeSessionPendingInputInTransaction,
} from "./session-accessor.sqlite-pending-input-rows.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import type {
  PendingInputWorkerReservation,
  SessionPendingInputAppend,
  SessionPendingInputAppendIdentity,
  SessionPendingInputOwner,
  SessionPendingInputRow,
  SessionPendingInputState,
  SessionPendingInputTerminalRequest,
  SessionPendingInputWorkerAppend,
  SessionPendingInputWorkerAssociation,
  SessionPendingInputWorkerFacts,
} from "./session-pending-input.types.js";

type PendingInputDatabase = Pick<OpenClawAgentDatabase, "db" | "path">;

export class SessionPendingInputSettlementUnknownError extends Error {
  constructor(cause?: unknown) {
    super("Pending input storage outcome is unknown; its original custody remains retained", {
      cause,
    });
    this.name = "SessionPendingInputSettlementUnknownError";
  }
}

export function isSessionPendingInputSettlementUnknown(error: unknown): boolean {
  return (
    error instanceof SessionPendingInputSettlementUnknownError ||
    (error instanceof AggregateError && error.errors.some(isSessionPendingInputSettlementUnknown))
  );
}

export function bindSessionPendingInputWorkerOwner(
  owner: SessionPendingInputOwner,
  authority: GatewayPendingInputWorkerAuthority,
): void {
  if (owner.worker || owners.live.get(owner.inputId) !== owner || owner.sources) {
    throw new Error("Pending input worker authority requires its original unbound live receipt");
  }
  const read = authority.workerRead;
  const target = read.expected;
  if (
    target.sessionId !== owner.sessionId ||
    target.canonicalKey !== owner.sessionKey ||
    !(read.kind === "volatile"
      ? read.source.path === owner.databasePath
      : read.sources.some((source) => source.path === owner.databasePath))
  ) {
    throw new Error("Pending input worker authority belongs to another physical session");
  }
  owner.worker = { authority, uses: new Set(), revoked: false };
}

async function settlePendingInputTerminal(
  owner: SessionPendingInputOwner,
  request: SessionPendingInputTerminalRequest,
): Promise<AgentRunTerminalOutcome | undefined> {
  const worker = owner.worker!;
  await Promise.allSettled(worker.uses);
  if (worker.unresolved) {
    throw new SessionPendingInputSettlementUnknownError();
  }
  if (request.kind === "finish" && owner.consumed) {
    return undefined;
  }
  const result = await worker.association!.settle(request, (facts) => {
    if (request.kind === "complete") {
      if (owners.live.get(owner.inputId) !== owner) {
        throw new Error("Input completion owner has already been released");
      }
      worker.authority.assertCurrent(facts, true);
    }
  });
  if (result.kind === "unknown") {
    worker.unresolved = true;
    throw new SessionPendingInputSettlementUnknownError(result.error);
  }
  if (result.kind !== "committed") {
    throw result.error;
  }
  // A receipt, not delivery success, makes consumption final.
  if (result.outcome && isFinalInputCompletion(result.outcome)) {
    owner.consumed = true;
  }
  if (result.failures.length) {
    throw new AggregateError(result.failures, "Pending input committed but delivery failed");
  }
  return result.outcome;
}

/** Revocation is synchronous; only the retained worker may settle an in-flight owner's rows. */
function finishSessionPendingInputWorkerOwner(
  owner: SessionPendingInputOwner,
  disposition: "cancelled" | "interrupted",
): boolean {
  const worker = owner.worker;
  if (!worker) {
    return false;
  }
  worker.revoked = true;
  if (!worker.association) {
    return false;
  }
  const release = async () => {
    releaseSessionPendingInputOwner(owner);
    try {
      worker.authority.release();
    } finally {
      await worker.releaseAssociation?.();
    }
  };
  worker.finish ??= settlePendingInputTerminal(owner, {
    kind: "finish",
    disposition,
    owner: pendingInputAppendIdentity(owner),
  }).then(release, async (error: unknown) => {
    let releaseFailure: { error: unknown } | undefined;
    if (!worker.unresolved) {
      try {
        await release();
      } catch (releaseError) {
        releaseFailure = { error: releaseError };
      }
    }
    if (releaseFailure) {
      throw new AggregateError(
        [error, releaseFailure.error],
        "Pending input settlement and release failed",
      );
    }
    throw error;
  });
  void worker.finish.catch(() => {});
  return true;
}

export function joinSessionPendingInputWorkerOwner(
  owner: SessionPendingInputOwner,
): Promise<void> | undefined {
  return owner.worker?.finish;
}

export function completeSessionPendingInputWorkerOwner(
  owner: SessionPendingInputOwner,
  outcome: AgentRunTerminalOutcome,
): Promise<AgentRunTerminalOutcome> | undefined {
  const worker = owner.worker;
  if (!worker?.association || !owner.completionScope) {
    return undefined;
  }
  worker.completion ??= settlePendingInputTerminal(owner, {
    kind: "complete",
    owner: pendingInputAppendIdentity(owner),
    completionScope: owner.completionScope,
    outcome,
    authorization: worker.authority.workerRead,
  }).then((committed) => {
    if (!committed) {
      throw new Error("Input completion committed without its required outcome");
    }
    return committed;
  });
  worker.uses.add(worker.completion);
  void worker.completion.finally(() => worker.uses.delete(worker.completion!)).catch(() => {});
  void worker.completion.catch(() => {});
  return worker.completion;
}

const owners = resolveGlobalSingleton(Symbol.for("openclaw.sessionPendingInputOwners"), () => ({
  live: new Map<string, SessionPendingInputOwner>(),
  current: new AsyncLocalStorage<SessionPendingInputOwner>(),
  relocation: new AsyncLocalStorage<{
    owner: SessionPendingInputOwner;
    sourceInputId: string;
  }>(),
  transactionRelocations: new WeakMap<DatabaseSync, Map<SessionPendingInputOwner, string>>(),
}));

const recoveredDedupeOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPendingInputDedupeRecoveries"),
  () => new WeakSet<SessionPendingInputOwner>(),
);

registerAgentEventLifecycleRotationHandler("session-pending-inputs", () => {
  const failures: unknown[] = [];
  for (const owner of owners.live.values()) {
    try {
      owner.finish("interrupted");
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "Failed to record interrupted pending inputs");
  }
});

export function registerSessionPendingInputOwner(owner: SessionPendingInputOwner): void {
  if (owners.live.has(owner.inputId)) {
    throw new Error("Pending input already has a live owner");
  }
  owners.live.set(owner.inputId, owner);
}

function releaseSessionPendingInputOwner(owner: SessionPendingInputOwner): void {
  if (owners.live.get(owner.inputId) === owner) {
    owners.live.delete(owner.inputId);
  }
}

export function finishSessionPendingInputOwner(
  owner: SessionPendingInputOwner,
  disposition: Exclude<SessionPendingInputState, "queued">,
  source: CapturedSessionEntryReadSource,
  options: OpenClawAgentDatabaseOptions,
): void {
  if (finishSessionPendingInputWorkerOwner(owner, disposition)) {
    return;
  }
  // Release authority even if recording the terminal disposition fails.
  releaseSessionPendingInputOwner(owner);
  owner.worker?.authority.release();
  if (owner.consumed) {
    return;
  }
  const capturedOptions = { ...options, agentId: source.agentId, path: source.path };
  assertCapturedSessionEntryReadSource(source, getOpenClawAgentDatabaseIfOpen(capturedOptions));
  runOpenClawAgentWriteTransaction(
    (current) => {
      assertCapturedSessionEntryReadSource(source, current);
      executeSqliteQuerySync(
        current.db,
        getSessionKysely(current.db)
          .updateTable("session_pending_inputs")
          .set({ state: disposition })
          .where("input_id", "=", owner.inputId)
          .where("lifecycle_generation", "=", owner.lifecycleGeneration)
          .where("state", "=", "queued")
          .where("consumed_event_id", "is", null),
      );
    },
    capturedOptions,
    { operationLabel: "session.pending-input.finish-owner" },
  );
}

function assertPendingInputOwnerCurrent(owner: SessionPendingInputOwner, scopeEntry = false): void {
  if (owner.sources) {
    for (const source of owner.sources) {
      assertPendingInputOwnerCurrent(source, scopeEntry);
    }
    return;
  }
  if (
    owners.live.get(owner.inputId) !== owner ||
    owner.worker?.revoked ||
    owner.worker?.reservation ||
    !isAgentEventLifecycleGenerationCurrent(owner.lifecycleGeneration)
  ) {
    throw new SessionPendingInputCustodyError(
      "Pending input ownership ended; submit a new turn to continue",
    );
  }
  // Entering the original ALS scope does not authorize a write. The native row
  // kernel or worker's final admission still checks the current target policy.
  if (scopeEntry && owner.worker) {
    owner.worker.authority.assertLifetimeCurrent();
  } else {
    owner.assertCurrent();
  }
}

export function runWithSessionPendingInput<T>(owner: SessionPendingInputOwner, run: () => T): T {
  assertPendingInputOwnerCurrent(owner, true);
  return owners.current.run(owner, run);
}

/** Persistence alone may mirror a closed turn; the append owner proves exact committed bytes. */
export function runWithSessionPendingInputPersistence<T>(
  owner: SessionPendingInputOwner,
  persist: () => T,
): T {
  return owners.current.run(owner, persist);
}

/** A transcript rewrite may move only the exact current user owned by the live admitted turn. */
export function withSessionPendingInputRelocation<T>(
  sourceInputId: string,
  message: unknown,
  append: () => T,
): T {
  const owner = owners.current.getStore();
  const record = asOptionalRecord(message);
  const ownsSource = owner?.transcriptInputId === sourceInputId;
  const claimsOwner = record?.role === "user" && record.idempotencyKey === owner?.idempotencyKey;
  if (!owner || (!ownsSource && !claimsOwner)) {
    return append();
  }
  assertPendingInputOwnerCurrent(owner, true);
  if (JSON.stringify(message) !== owner.messageJson) {
    throw new Error("Pending input relocation does not match its admitted transcript entry");
  }
  return owners.relocation.run({ owner, sourceInputId }, append);
}

/** Registration owns disposition; execution and promotion check the private operational predicates. */
export function readSessionPendingInputOwnerIds(
  database: PendingInputDatabase,
  rows: readonly Pick<
    SessionPendingInputRow,
    "input_id" | "session_key" | "session_id" | "lifecycle_generation"
  >[],
): Set<string> {
  const candidates = rows.filter((row) => {
    const owner = owners.live.get(row.input_id);
    return (
      owner?.databasePath === database.path &&
      owner.sessionId === row.session_id &&
      owner.sessionKey === row.session_key &&
      owner.lifecycleGeneration === row.lifecycle_generation &&
      isAgentEventLifecycleGenerationCurrent(owner.lifecycleGeneration)
    );
  });
  if (!candidates.length) {
    return new Set();
  }
  const sessions = executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_nodes")
      .select(["session_key", "current_session_id"])
      .where("session_key", "in", [...new Set(candidates.map((row) => row.session_key))]),
  ).rows;
  const current = new Map(sessions.map((row) => [row.session_key, row.current_session_id]));
  return new Set(
    candidates
      .filter((row) => current.get(row.session_key) === row.session_id)
      .map((row) => row.input_id),
  );
}

export {
  parseSessionPendingInputMessage,
  isFinalInputCompletion,
  readSessionInputCompletion,
  writeSessionInputCompletion,
  projectSessionPendingInput,
  readSessionPendingInputByKey,
  consumeSessionPendingInputInTransaction,
  deleteSessionPendingInputs,
} from "./session-accessor.sqlite-pending-input-rows.js";

/** Only a current recovered source can supersede its previous request receipt, once. */
export function claimCurrentSessionPendingInputDedupeRecovery(
  database: PendingInputDatabase,
  scope: Pick<ResolvedTranscriptScope, "sessionId" | "sessionKey">,
  runId: string,
): boolean {
  const owner = owners.current.getStore();
  if (
    !owner ||
    owner.sources ||
    owner.restartRecovered !== true ||
    recoveredDedupeOwners.has(owner) ||
    owner.databasePath !== database.path ||
    owner.sessionId !== scope.sessionId ||
    owner.sessionKey !== scope.sessionKey ||
    owner.idempotencyKey !== `${runId}:user`
  ) {
    return false;
  }
  assertPendingInputOwnerCurrent(owner);
  const row = readSessionPendingInputByKey(database, scope, owner.idempotencyKey);
  const current = Boolean(
    row &&
    row.input_id === owner.inputId &&
    row.run_id === runId &&
    row.message_json === owner.messageJson &&
    row.state === "queued" &&
    row.consumed_event_id == null &&
    readSessionPendingInputOwnerIds(database, [row]).has(owner.inputId),
  );
  if (current) {
    recoveredDedupeOwners.add(owner);
  }
  return current;
}

function pendingInputAppendIdentity(
  owner: SessionPendingInputOwner,
  transcriptInputId = owner.transcriptInputId,
): SessionPendingInputAppendIdentity {
  return {
    inputId: owner.inputId,
    transcriptInputId,
    sessionId: owner.sessionId,
    sessionKey: owner.sessionKey,
    databasePath: owner.databasePath,
    idempotencyKey: owner.idempotencyKey,
    lifecycleGeneration: owner.lifecycleGeneration,
    messageJson: owner.messageJson,
    ...(owner.sources
      ? { sources: owner.sources.map((source) => pendingInputAppendIdentity(source)) }
      : {}),
  };
}

/** The ALS carries the original receipt; only selectors and accepted bytes cross the worker boundary. */
export function captureSessionPendingInputWorkerAppend(
  target: { databasePath: string; sessionId: string; sessionKey: string },
  message: unknown,
  association: SessionPendingInputWorkerAssociation,
) {
  const record = asOptionalRecord(message);
  const owner = owners.current.getStore();
  if (
    record?.role !== "user" ||
    typeof record.idempotencyKey !== "string" ||
    !owner ||
    record.idempotencyKey.trim() !== owner.idempotencyKey ||
    target.databasePath !== owner.databasePath ||
    target.sessionId !== owner.sessionId ||
    target.sessionKey !== owner.sessionKey
  ) {
    return undefined;
  }
  const sources = owner.sources ?? [owner];
  const transaction = captureSqliteWorkerCallerTransaction();
  const previous = sources[0]?.worker?.reservation;
  const stagedPrevious =
    previous?.staged &&
    previous.owner === owner &&
    transaction !== undefined &&
    previous.transaction === transaction
      ? previous
      : undefined;
  const ownerTranscriptInputId = owner.transcriptInputId;
  const identity = pendingInputAppendIdentity(owner, stagedPrevious?.relocatedInputId);
  const relocation = owners.relocation.getStore();
  if (relocation?.owner === owner && relocation.sourceInputId !== identity.transcriptInputId) {
    throw new Error("Pending input relocation differs from its original receipt");
  }
  const states = sources.map((source) => {
    const worker = source.worker;
    if (!worker) {
      throw new Error("Pending input has no certified worker authority; use its native owner");
    }
    if (worker.unresolved) {
      throw new SessionPendingInputSettlementUnknownError();
    }
    if (worker.reservation && worker.reservation !== stagedPrevious) {
      throw new Error("Pending input is reserved by its unsettled native operation");
    }
    if (!worker.revoked) {
      if (worker.association && worker.association !== association) {
        throw new Error("Pending input is already associated with another message worker");
      }
      if (!worker.association) {
        worker.releaseAssociation = association.retain();
        worker.association = association;
      }
    }
    return { source, worker, transcriptInputId: source.transcriptInputId };
  });
  const input: SessionPendingInputWorkerAppend = {
    identity,
    ...(relocation?.owner === owner ? { relocationSourceId: relocation.sourceInputId } : {}),
    authorizations: states.map(({ source, worker }) => ({
      inputId: source.inputId,
      read: worker.authority.workerRead,
    })),
  };
  const assertCurrent = (facts: SessionPendingInputWorkerFacts) => {
    const requiresCurrent = facts.requiresCurrent || Boolean(input.relocationSourceId);
    if (
      owner.transcriptInputId !== ownerTranscriptInputId ||
      facts.authorizations.length !== (requiresCurrent ? states.length : 0)
    ) {
      throw new Error("Pending input admission differs from its captured source");
    }
    for (const { source, worker, transcriptInputId } of states) {
      if (
        source.worker !== worker ||
        source.transcriptInputId !== transcriptInputId ||
        worker.unresolved
      ) {
        throw new Error("Pending input source changed during worker admission");
      }
      if (requiresCurrent) {
        const current = facts.authorizations.find((value) => value.inputId === source.inputId);
        if (!current) {
          throw new Error("Pending input admission omitted an original source");
        }
        if (
          worker.revoked ||
          owners.live.get(source.inputId) !== source ||
          !isAgentEventLifecycleGenerationCurrent(source.lifecycleGeneration)
        ) {
          throw new Error("Pending input ownership ended before worker admission");
        }
        worker.authority.assertCurrent(current.facts);
      }
    }
  };
  return {
    input,
    assertCurrent,
    unknown() {
      for (const { worker } of states) {
        worker.unresolved = true;
      }
    },
    retain(operation: Promise<unknown>) {
      for (const { worker } of states) {
        worker.uses.add(operation);
        void operation.finally(() => worker.uses.delete(operation)).catch(() => {});
      }
    },
    reserve(facts: SessionPendingInputWorkerFacts) {
      assertCurrent(facts);
      const reservation: PendingInputWorkerReservation = {
        owner,
        transaction,
        staged: false,
        relocatedInputId: facts.relocatedInputId ?? stagedPrevious?.relocatedInputId,
        previous,
      };
      if (states.some(({ worker }) => worker.reservation !== previous)) {
        throw new Error("Pending input already has a reserved native operation");
      }
      const consumed = new Set(facts.consumedInputIds);
      if (
        consumed.size !== facts.consumedInputIds.length ||
        (consumed.size > 0 &&
          (consumed.size !== sources.length ||
            sources.some((source) => !consumed.has(source.inputId)))) ||
        (facts.relocatedInputId && !input.relocationSourceId)
      ) {
        throw new Error("Pending input receipt differs from its captured effects");
      }
      for (const { worker } of states) {
        worker.reservation = reservation;
      }
      const release = () => {
        for (const { worker } of states) {
          if (worker.reservation === reservation) {
            worker.reservation = reservation.previous;
          } else {
            let current = worker.reservation;
            while (current && current.previous !== reservation) {
              current = current.previous;
            }
            if (current) {
              current.previous = reservation.previous;
            }
          }
        }
      };
      return {
        stage() {
          if (!transaction || states.some(({ worker }) => worker.reservation !== reservation)) {
            throw new Error("Tentative pending input lost its original transaction reservation");
          }
          // Consumption is still uncommitted. Only this scope can observe its
          // staged relocation, without changing the public input owner's receipt.
          reservation.staged = true;
        },
        commit() {
          if (
            states.some(({ worker }) => {
              let current = worker.reservation;
              while (current && current !== reservation) {
                current = current.previous;
              }
              return !current;
            })
          ) {
            throw new Error("Pending input lost its native reservation");
          }
          for (const { source } of states) {
            if (facts.consumedInputIds.includes(source.inputId)) {
              source.consumed = true;
            }
          }
          if (facts.relocatedInputId) {
            owner.transcriptInputId = facts.relocatedInputId;
          }
          release();
        },
        rollback() {
          release();
        },
      };
    },
  };
}

/** The private call-path owner, not a copied id or durable row, permits promotion. */
export function resolveSessionPendingInputAppend(
  database: PendingInputDatabase,
  scope: ResolvedTranscriptScope,
  message: unknown,
): SessionPendingInputAppend | undefined {
  if (asOptionalRecord(message)?.role !== "user") {
    return undefined;
  }
  const owner = owners.current.getStore();
  const identity = owner
    ? pendingInputAppendIdentity(owner, owners.transactionRelocations.get(database.db)?.get(owner))
    : undefined;
  const pending = readSessionPendingInputAppendInTransaction(database, scope, message, identity);
  if (!pending || !owner) {
    return pending;
  }
  const relocation = owners.relocation.getStore();
  if (relocation?.owner === owner && relocation.sourceInputId !== identity?.transcriptInputId) {
    throw new Error("Pending input relocation does not match its admitted transcript entry");
  }
  if (pending.requiresCurrent || relocation?.owner === owner) {
    assertPendingInputOwnerCurrent(owner);
  }
  if (pending.alreadyPromoted && relocation?.owner === owner) {
    pending.stageRelocation = (destinationInputId) => {
      let staged = owners.transactionRelocations.get(database.db);
      const hadPrevious = staged?.has(owner) ?? false;
      const previous = staged?.get(owner);
      if (
        !stageSqliteTransactionState(database.db, {
          stage: () => {
            staged ??= new Map();
            owners.transactionRelocations.set(database.db, staged);
            staged.set(owner, destinationInputId);
          },
          rollback: () => {
            if (hadPrevious && previous !== undefined) {
              staged?.set(owner, previous);
            } else {
              staged?.delete(owner);
            }
            if (staged?.size === 0) {
              owners.transactionRelocations.delete(database.db);
            }
          },
          commit: () => {
            owner.transcriptInputId = destinationInputId;
            if (staged?.get(owner) === destinationInputId) {
              staged.delete(owner);
            }
            if (staged?.size === 0) {
              owners.transactionRelocations.delete(database.db);
            }
          },
        })
      ) {
        throw new Error("Pending input relocation requires a transcript write transaction");
      }
    };
  }
  return pending;
}

export function consumeSessionPendingInput(
  database: PendingInputDatabase,
  pending: SessionPendingInputAppend,
): void {
  const inputIds = new Set(consumeSessionPendingInputInTransaction(database, pending));
  if (!inputIds.size) {
    return;
  }
  const owner = owners.current.getStore();
  const consumedOwners = (owner?.sources ?? (owner ? [owner] : [])).filter(
    (candidate) =>
      owners.live.get(candidate.inputId) === candidate &&
      candidate.databasePath === database.path &&
      inputIds.has(candidate.inputId),
  );
  // Outer commit publishes this fact before observers; rollback leaves finish responsible.
  stageSqliteTransactionState(database.db, {
    stage: () => {},
    rollback: () => {},
    commit: () => {
      for (const consumedOwner of consumedOwners) {
        consumedOwner.consumed = true;
      }
    },
  });
}

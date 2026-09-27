import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { serialize } from "node:v8";
import { resolveTimestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptMessageAppendOptions,
  SessionTranscriptContextVersion,
} from "../../config/sessions/session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { ensureSessionEntryInTransaction } from "../../config/sessions/session-accessor.sqlite-initial-entry.js";
import {
  readSessionInputCompletion,
  readSessionPendingInputAppendInTransaction,
  writeSessionInputCompletion,
} from "../../config/sessions/session-accessor.sqlite-pending-input-rows.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
  getSessionKysely,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type {
  PreparedTranscriptMessageAppend,
  TranscriptMessageAppendPreparation,
} from "../../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import { canRebasePreparedAssistantInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-prepared.js";
import { readBoundedContextFromRawSnapshot } from "../../config/sessions/session-accessor.sqlite-transcript-raw-snapshot.js";
import { SqliteTranscriptMutationConflictError } from "../../config/sessions/session-accessor.sqlite-transcript-write-guard.js";
import { appendTranscriptMessageSnapshotInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { assertCanonicalSessionKeyWrite } from "../../config/sessions/session-canonical-key.js";
import type {
  SessionPendingInputWorkerAppend,
  SessionPendingInputWorkerFacts,
  SessionPendingInputTerminalRequest,
} from "../../config/sessions/session-pending-input.types.js";
import { prepareTranscriptPayloadForReuse } from "../../config/sessions/transcript-payload.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/transcript-write-context.js";
import { readSessionMutationFactsInWorker } from "../../gateway/session-sharing-worker-read.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerHostStep } from "../../infra/sqlite-worker-native-scope.js";
import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  preparePendingToolResultDelta,
  type PendingToolResultFact,
} from "../session-tool-result-pending-facts.js";
import type { SessionWorkerInitialEntryCommit } from "./session-manager-metadata-contract.js";
import type { SessionMessageEntry } from "./session-manager-types.js";
import type {
  SessionManagerBoundedContextLimits,
  PreparedSessionTranscriptReload,
} from "./session-manager-view-types.js";
import type { SessionMessageCommitFacts } from "./session-message-append-receipt.js";

export type SessionMessageWorkerTarget = Omit<SessionTranscriptWriteScope, "env" | "sessionId"> & {
  sessionId: string;
};
export type SessionMessageWorkerAppend = {
  operationId: string;
  scope: SessionMessageWorkerTarget;
  messageJson: string;
  options: Omit<
    TranscriptMessageAppendOptions<AgentMessage>,
    "message" | "prepareMessageAfterIdempotencyCheck" | "beforeFreshMessageCommit"
  > & { eventId: string; now: number };
} & (
  | {
      kind: "manager";
      prepared?: { parentId: string | null; admittedUserId?: string };
      limits?: SessionManagerBoundedContextLimits;
      pendingInput?: SessionPendingInputWorkerAppend;
      initialize?: { initialWriterRunId?: string };
      loadedVersion?: SessionTranscriptContextVersion;
      freshInput?: boolean;
      freshInputHost?: true;
    }
  | { kind: "target-note" }
);

export type SessionMessagePendingPreparation = {
  operationId: string;
  calls: readonly PendingToolResultFact[];
  repairedToken?: number;
};

export type SessionMessageWorkerTerminal = {
  operationId: string;
  scope: SessionMessageWorkerTarget;
  terminal: SessionPendingInputTerminalRequest;
};

export type SessionMessageWorkerOperations = {
  "session.message.append": {
    input: SessionMessageWorkerAppend;
    output: {
      facts: SessionMessageCommitFacts;
      message: AgentMessage;
      context?: ReturnType<typeof readBoundedContextFromRawSnapshot>;
      reload?: PreparedSessionTranscriptReload;
    };
  };
  "session.input.settle": {
    input: SessionMessageWorkerTerminal;
    output: { outcome?: import("../agent-run-terminal-outcome.types.js").AgentRunTerminalOutcome };
  };
};

/** This domain borrows the admitted connection. It never opens storage or owns pending objects. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  context: {
    databasePath: string;
    database: DatabaseSync;
    takePreparation(): unknown;
    admit(stage: "transaction" | "commit", facts?: unknown): void;
    assertTransactionBoundary?(): void;
  },
): SqliteWorkerBackend<SessionMessageWorkerOperations> {
  let closed = false;
  let prepared:
    | {
        input: SessionMessageWorkerAppend;
        message: PreparedTranscriptMessageAppend<AgentMessage>;
        pending?: SessionMessagePendingPreparation;
      }
    | undefined;
  const assertOpen = () => {
    if (closed || !context.database.isOpen) {
      throw new Error("Session message worker lost its bound connection");
    }
    assertTransactionUsable(context.database);
  };
  return {
    prepare(command) {
      assertOpen();
      if (command.type === "session.input.settle") {
        return;
      }
      const input = command.input;
      // This attachment was captured when the original FIFO job dispatched,
      // after its predecessor's private custody settled, not at Promise delivery.
      const attachment = input.kind === "manager" ? context.takePreparation() : undefined;
      // The manager factory captured this attachment for this original FIFO admission.
      // SAFETY: the bound owner consumes the domain payload once; operationId is checked below.
      const pending = attachment as SessionMessagePendingPreparation | undefined;
      if (pending && pending.operationId !== input.operationId) {
        throw new Error("Session pending preparation belongs to another operation");
      }
      // The host already ran hooks and canonical JSON serialization. Compression
      // is connection-local preparation, before the synchronous commit section.
      // SAFETY: the paired host serialized AgentMessage or supplied exact retained pending bytes.
      const message = JSON.parse(input.messageJson) as AgentMessage;
      const envelope = {
        type: "message" as const,
        id: input.options.eventId,
        parentId: input.options.parentId ?? null,
        timestamp: resolveTimestampMsToIsoString(input.options.now),
      };
      const eventJson = `${JSON.stringify(envelope).slice(0, -1)},"message":${input.messageJson}}`;
      prepared = {
        input,
        pending,
        message: {
          messageJson: input.messageJson,
          persistedMessage: message,
          physicalPayload: prepareTranscriptPayloadForReuse(context.database, eventJson, {
            ...envelope,
            message,
          }),
        },
      };
    },
    execute(command) {
      assertOpen();
      if (command.type === "session.input.settle") {
        const input = command.input;
        const scope = { ...input.scope, env: getSqliteWorkerStateContext().environment };
        const resolved = resolveSqliteTranscriptScope(scope);
        const options = toDatabaseOptions(resolved);
        const terminal = input.terminal;
        const owner = terminal.owner;
        if (
          resolveOpenClawAgentSqlitePath(options) !== context.databasePath ||
          owner.databasePath !== context.databasePath ||
          owner.sessionKey !== resolved.sessionKey ||
          owner.sessionId !== resolved.sessionId ||
          owner.sources
        ) {
          throw new Error("Input settlement differs from its retained physical source");
        }
        let facts: Record<string, unknown> | undefined;
        let authorization: ReturnType<typeof readSessionMutationFactsInWorker> | undefined;
        let boundDatabase: Parameters<typeof readSessionMutationFactsInWorker>[0] | undefined;
        return runOpenClawAgentWriteTransaction(
          (database) => {
            boundDatabase = database;
            if (database.db !== context.database) {
              throw new Error("Input settlement lost its admitted writer connection");
            }
            deferSqliteWorkerCommitReceipt(database.db, { operationId: input.operationId });
            authorization =
              terminal.kind === "complete"
                ? readSessionMutationFactsInWorker(database, terminal.authorization)
                : undefined;
            const domain = {
              operationId: input.operationId,
              inputId: owner.inputId,
              kind: terminal.kind,
              ...(authorization ? { authorization } : {}),
            };
            context.admit("transaction", domain);
            let outcome;
            if (terminal.kind === "finish") {
              executeSqliteQuerySync(
                database.db,
                getSessionKysely(database.db)
                  .updateTable("session_pending_inputs")
                  .set({ state: terminal.disposition })
                  .where("input_id", "=", owner.inputId)
                  .where("session_id", "=", owner.sessionId)
                  .where("session_key", "=", owner.sessionKey)
                  .where("lifecycle_generation", "=", owner.lifecycleGeneration)
                  .where("message_json", "=", owner.messageJson)
                  .where("state", "=", "queued")
                  .where("consumed_event_id", "is", null),
              );
            } else {
              if (
                readSessionEntryRow(database, resolved.sessionKey)?.entry.sessionId !==
                owner.sessionId
              ) {
                throw new Error("Input completion no longer owns the admitted session");
              }
              const completion = {
                ...resolved,
                ...terminal.completionScope,
                idempotencyKey: owner.idempotencyKey,
                lifecycleGeneration: owner.lifecycleGeneration,
              };
              const previous = readSessionInputCompletion(database, completion);
              if (
                previous &&
                (previous.run_id !== completion.runId ||
                  previous.request_hash !== completion.requestHash)
              ) {
                throw new Error("Input completion differs from its original accepted request");
              }
              outcome = writeSessionInputCompletion(database, completion, terminal.outcome);
            }
            facts = { ...domain, ...(outcome ? { outcome } : {}) };
            const value = outcome ? { outcome } : {};
            serialize(value);
            return value;
          },
          options,
          {
            withCommit(commit) {
              if (!facts) {
                throw new Error("Input settlement has no prepared commit facts");
              }
              context.admit("commit", facts);
              if (terminal.kind === "complete") {
                // Native permissions and the last host grant have both returned.
                // Re-selection here catches external duplicates without a local publication.
                if (!boundDatabase) {
                  throw new Error("Input settlement lost its original writer");
                }
                const current = readSessionMutationFactsInWorker(
                  boundDatabase,
                  terminal.authorization,
                );
                if (!isDeepStrictEqual(current, authorization)) {
                  throw new Error("Input authorization changed after its final grant");
                }
              }
              commit();
            },
          },
        );
      }
      const input = command.input;
      const manager = input.kind === "manager" ? input : undefined;
      const preparedMessage = prepared;
      prepared = undefined;
      if (!preparedMessage || preparedMessage.input !== input) {
        throw new Error("Session message has no matching connection-local preparation");
      }
      const scope = { ...input.scope, env: getSqliteWorkerStateContext().environment };
      const resolved = resolveSqliteTranscriptScope(scope);
      const options = toDatabaseOptions(resolved);
      if (resolveOpenClawAgentSqlitePath(options) !== context.databasePath) {
        throw new Error("Session message target changed its physical database");
      }
      assertCanonicalSessionKeyWrite(resolved.sessionKey, resolved.agentId);
      const operationOwner = {
        kind: input.kind,
        operationId: input.operationId,
        owner: {
          databasePath: context.databasePath,
          sessionId: resolved.sessionId,
          sessionKey: resolved.sessionKey,
        },
      };
      let commitFacts: SessionMessageCommitFacts | undefined;
      let pendingFacts: SessionPendingInputWorkerFacts | undefined;
      let initial: SessionWorkerInitialEntryCommit | undefined;
      let boundDatabase: Parameters<typeof readSessionMutationFactsInWorker>[0] | undefined;
      const nestedTransaction = context.database.isTransaction;
      const admitCommit = () => {
        if (!commitFacts) {
          throw new Error("Session message has no prepared commit facts");
        }
        context.admit("commit", commitFacts);
        if (manager?.pendingInput && pendingFacts && boundDatabase) {
          for (const admitted of pendingFacts.authorizations) {
            const read = manager.pendingInput.authorizations.find(
              (value) => value.inputId === admitted.inputId,
            )?.read;
            if (!read) {
              throw new Error("Input authorization lost its original selection");
            }
            const current = readSessionMutationFactsInWorker(boundDatabase, read);
            if (!isDeepStrictEqual(current, admitted.facts)) {
              throw new Error("Input authorization changed after its final grant");
            }
          }
        }
      };
      return runOpenClawAgentWriteTransaction(
        (database) => {
          boundDatabase = database;
          if (database.db !== context.database) {
            throw new Error("Session message lost its admitted writer connection");
          }
          // Queue this before append owners can enqueue fallible publications.
          // Native settlement retains COMMIT even when their delivery later fails.
          deferSqliteWorkerCommitReceipt(database.db, operationOwner);
          if (manager?.pendingInput) {
            const pending = readSessionPendingInputAppendInTransaction(
              database,
              resolved,
              preparedMessage.message.persistedMessage,
              manager.pendingInput.identity,
            );
            if (!pending || pending.messageJson !== input.messageJson) {
              throw new Error("Worker input differs from its accepted pending bytes");
            }
            if (manager.pendingInput.relocationSourceId) {
              if (
                manager.pendingInput.relocationSourceId !==
                manager.pendingInput.identity.transcriptInputId
              ) {
                throw new Error("Worker relocation differs from its original input");
              }
              if (pending.alreadyPromoted) {
                pending.stageRelocation = (id) => {
                  preparedMessage.message.pendingInput!.relocatedInputId = id;
                };
              }
            }
            preparedMessage.message.pendingInput = { append: pending, consumedInputIds: [] };
            pendingFacts = {
              requiresCurrent: pending.requiresCurrent,
              consumedInputIds: [],
              authorizations: (pending.requiresCurrent || manager.pendingInput.relocationSourceId
                ? manager.pendingInput.authorizations
                : []
              ).map(({ inputId, read }) => ({
                inputId,
                facts: readSessionMutationFactsInWorker(database, read),
              })),
            };
          }
          context.admit("transaction", {
            ...operationOwner,
            pendingInput: pendingFacts,
          });
          if (manager?.initialize) {
            const physical = readOpenClawAgentDatabaseIdentity(database);
            const committed = ensureSessionEntryInTransaction(
              database,
              resolved,
              scope,
              { sessionId: resolved.sessionId, updatedAt: input.options.now },
              manager.initialize.initialWriterRunId,
            );
            // Publish the admitted incarnation, never a path reopened after worker settlement.
            initial = {
              ...committed,
              identity: committed.identity && {
                ...committed.identity,
                databaseIdentity:
                  typeof physical.identity === "string" ? physical.identity : physical.incarnation,
              },
            };
            if (!initial.owned) {
              throw new SessionTranscriptWriterClaimReboundError();
            }
            if (initial.fence) {
              Object.assign(scope, initial.fence);
            }
          }
          if (
            manager?.prepared &&
            !canRebasePreparedAssistantInTransaction(
              database,
              resolved.sessionId,
              manager.prepared.parentId,
              manager.prepared.admittedUserId,
            )
          ) {
            throw new SqliteTranscriptMutationConflictError(resolved.sessionId);
          }
          const preparation: {
            delta?: Extract<SessionMessageCommitFacts, { kind: "manager" }>["delta"];
            context?: ReturnType<typeof readBoundedContextFromRawSnapshot>;
            reload?: PreparedSessionTranscriptReload;
          } = {};
          let preparePending: TranscriptMessageAppendPreparation | undefined;
          // Only manager appends reserve actual pending occurrences and adopt a view.
          // A keyed target note may replay a durable row outside the active branch.
          if (manager) {
            preparePending = ({ result, snapshot, before, after }) => {
              const anchor = result.anchor;
              if (
                !anchor ||
                anchor.storePath !== database.path ||
                anchor.sessionId !== resolved.sessionId
              ) {
                throw new SqliteTranscriptMutationConflictError(resolved.sessionId);
              }
              const entry: SessionMessageEntry = {
                type: "message",
                id: result.messageId,
                parentId: result.effectiveParentId ?? null,
                timestamp: resolveTimestampMsToIsoString(input.options.now),
                // SAFETY: the canonical append kernel returned its stored/replayed message.
                message: result.message as AgentMessage,
              };
              if (!preparedMessage.pending) {
                throw new Error("Session manager lost its pending preparation");
              }
              preparation.delta = preparePendingToolResultDelta({
                entry,
                appended: result.appended,
                calls: preparedMessage.pending.calls,
                repairedToken: preparedMessage.pending.repairedToken,
                events: () => snapshot().rows.map((row) => row.event),
              });
              if (manager.limits) {
                preparation.context = readBoundedContextFromRawSnapshot(snapshot(), manager.limits);
                preparation.reload = { kind: "bounded", snapshot: preparation.context };
              } else if (
                // Initialization owns the stored header, not the caller's provisional copy.
                initial !== undefined ||
                (manager.loadedVersion &&
                  (manager.loadedVersion.generation !== before.generation ||
                    manager.loadedVersion.rawSeq !== before.rawSeq ||
                    result.effectiveParentId !== input.options.parentId ||
                    result.messageId !== input.options.eventId))
              ) {
                const raw = snapshot();
                preparation.reload = {
                  kind: "full",
                  snapshot: {
                    events: [...raw.readPayloads(raw.rows.map((row) => row.seq)).values()],
                    version: after,
                  },
                };
              }
              return undefined;
            };
          }
          let projectionNeedsReconcile = false;
          const result = appendTranscriptMessageSnapshotInTransaction(
            database,
            scope,
            {
              ...input.options,
              message: preparedMessage.message.persistedMessage,
              beforeFreshMessageCommit: manager?.freshInput
                ? () => {
                    if (manager.freshInputHost) {
                      requestSqliteWorkerHostStep({
                        kind: "fresh-input",
                        value: { operationId: input.operationId },
                      });
                    }
                    context.admit("transaction", {
                      ...operationOwner,
                      pendingInput: pendingFacts,
                      checkpoint: "fresh-input",
                    });
                  }
                : undefined,
            },
            preparedMessage.message,
            {
              messageAlreadyRedacted: true,
              preparePending,
              scheduleProjectionReconcile:
                manager || isIncognitoOpenClawAgentSqlitePath(database.path, options)
                  ? undefined
                  : false,
              onProjectionReconcileNeeded: () => {
                projectionNeedsReconcile = true;
              },
            },
          );
          if (!result.ok) {
            throw new SessionTranscriptWriterClaimReboundError(result.error);
          }
          if (!result.value.result) {
            throw new Error("Session message did not produce its prepared receipt");
          }
          const { message, ...receipt } = result.value.result;
          const common = {
            ...operationOwner,
            receipt,
            before: result.value.before,
            after: result.value.after,
            lifecycleRevision: result.value.lifecycleRevision,
            visibleTail: result.value.visibleTail,
            projectionNeedsReconcile,
          };
          if (pendingFacts && preparedMessage.message.pendingInput) {
            pendingFacts.consumedInputIds = preparedMessage.message.pendingInput.consumedInputIds;
            pendingFacts.relocatedInputId = preparedMessage.message.pendingInput.relocatedInputId;
          }
          let facts: SessionMessageCommitFacts;
          if (manager) {
            if (!preparation.delta) {
              throw new Error("Session message did not produce its pending reservation");
            }
            facts = {
              ...common,
              kind: "manager",
              delta: preparation.delta,
              pendingInput: pendingFacts,
              initial,
            };
          } else {
            facts = { ...common, kind: "target-note" };
          }
          const value = {
            facts,
            message,
            ...(preparation.context ? { context: preparation.context } : {}),
            ...(preparation.reload ? { reload: preparation.reload } : {}),
          };
          // Serialization failure must happen before COMMIT. The ordinary broker
          // frames this result; only the small authority facts cross admission.
          serialize(value);
          commitFacts = facts;
          // A child savepoint still validates its own final write authority; only
          // its receipt/publication waits for the enclosing physical COMMIT.
          if (nestedTransaction) {
            admitCommit();
          }
          return value;
        },
        options,
        nestedTransaction
          ? {}
          : {
              withCommit(commit) {
                admitCommit();
                commit();
              },
            },
      );
    },
    assertSettled() {
      assertOpen();
      if (context.assertTransactionBoundary) {
        return context.assertTransactionBoundary();
      }
      if (context.database.isTransaction) {
        throw new Error("Session message worker left a native transaction open");
      }
    },
    close() {
      closed = true;
      prepared = undefined;
    },
  };
}

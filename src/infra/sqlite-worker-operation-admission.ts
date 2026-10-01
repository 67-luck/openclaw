import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import {
  MessageChannel,
  MessagePort,
  receiveMessageOnPort,
  type Transferable,
} from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { runWithStoreWriterNativeWait } from "../shared/store-writer-queue.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { throwSqliteLifecycleErrors } from "./sqlite-lifecycle-errors.js";
import { stageSqliteTransactionState } from "./sqlite-post-commit.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES, SqliteWorkerError } from "./sqlite-worker-contract.js";
import type {
  RetainedWorkerTransactionAdmission,
  SqliteWorkerNativeSettlement,
  SqliteWorkerNativeSettlementOwner,
  SqliteWorkerOperationCompletion,
} from "./sqlite-worker-operation-settlement.js";
import type { SqliteWorkerHostScope } from "./sqlite-worker-scoped-operation.js";

const REQUESTED = 0;
const GRANTED = 1;
const REFUSED = 2;

/** Only the factory's admission before agent open may certify this refusal. */
export const SqliteWorkerOpenRefusedError = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerOpenRefusedError"),
  () =>
    class OpenRefusedError extends Error {
      constructor(readonly originalError: unknown) {
        super("SQLite worker admission was refused before agent open", { cause: originalError });
        this.name = "SqliteWorkerOpenRefusedError";
      }
    },
);

export type SqliteWorkerAdmissionRequest = {
  stage: "open" | "prepare" | "transaction" | "commit";
  facts: unknown;
};

type AdmissionFailureSource = "authority" | "domain" | "protocol";

export type SqliteWorkerOperationAdmission = SqliteWorkerNativeSettlementOwner & {
  readonly scope?: SqliteWorkerHostScope;
  readonly port: MessagePort;
  readonly failure: unknown;
  readonly failureSource: AdmissionFailureSource | undefined;
  readonly cleanupFailures: readonly unknown[];
  service(check?: () => void): void;
  revoke(): void;
  finish(this: void): void;
  bindDatabaseAuthority(authority: {
    databasePath: string;
    assertRequest?(): void;
    assertAccess(): void;
    acquireSchema(): { assertCurrent(): void; release(): void };
  }): void;
};

export type SqliteWorkerAdmissionCreator = (operation: RetainedWorkerTransactionAdmission) => {
  admission: SqliteWorkerOperationAdmission;
  nativeLocations: readonly string[];
  /** Private custody/adoption finishes before the next original job can dispatch. */
  settle?(this: void, completion: SqliteWorkerOperationCompletion): void;
  /** Savepoint-local visibility is reversible and never a committed receipt. */
  stage?(result: unknown): void;
};

export type SqliteWorkerAdmissionFactory = SqliteWorkerAdmissionCreator & {
  readonly requiresHostContinuation: boolean;
};

/** Readiness needs the producer's fact before lifecycle admission can create its scope. */
export function createSqliteWorkerAdmissionFactory(
  requiresHostContinuation: boolean,
  create: SqliteWorkerAdmissionCreator,
): SqliteWorkerAdmissionFactory {
  return Object.assign(create, { requiresHostContinuation });
}

/** The caller retains real source custody before invoking the synchronous grant. */
export function createSqliteWorkerOperationAdmission(
  admit: (request: SqliteWorkerAdmissionRequest, grant: () => boolean) => void,
  attachment?: unknown,
  scope?: SqliteWorkerHostScope,
): SqliteWorkerOperationAdmission {
  const { port1, port2 } = new MessageChannel();
  if (attachment !== undefined || scope) {
    try {
      // This message moves with port2; command payloads retain their v8 encoding.
      port1.postMessage(
        {
          kind: "sqlite-operation-attachment",
          value: attachment,
          ...(scope ? { scope: scope.port } : {}),
        },
        scope ? [scope.port] : [],
      );
    } catch (error) {
      port1.close();
      port2.close();
      scope?.close();
      throw error;
    }
  }
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const decisions = new Set<Int32Array>();
  const cleanupFailures: unknown[] = [];
  let closed = false;
  let failure: { error: unknown; source: AdmissionFailureSource } | undefined;
  let committed: SqliteWorkerNativeSettlementOwner["committed"];
  let settlement: SqliteWorkerNativeSettlement | undefined;
  let tentative = false;
  let databaseAuthority:
    | {
        databasePath: string;
        assertRequest?(): void;
        assertAccess(): void;
        acquireSchema(): { assertCurrent(): void; release(): void };
        lease?: { assertCurrent(): void; release(): void };
      }
    | undefined;
  const waiting = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const recordFailure = (error: unknown, source: AdmissionFailureSource) => {
    // A handled domain refusal cannot hide a later loss of physical custody or protocol failure.
    if (!failure || (failure.source === "domain" && source !== "domain")) {
      failure = { error, source };
    }
  };
  const refuse = (decision: Int32Array, error: unknown, source: AdmissionFailureSource) => {
    if (Atomics.compareExchange(decision, 0, REQUESTED, REFUSED) === REQUESTED) {
      recordFailure(error, source);
      Atomics.notify(decision, 0);
    } else if (Atomics.load(decision, 0) === GRANTED) {
      cleanupFailures.push(error);
    }
  };
  const receive = (message: unknown) => {
    if (isRecord(message) && message.kind === "native-tentative" && !settlement && !tentative) {
      tentative = true;
      return;
    }
    if (isRecord(message) && message.kind === "native-commit") {
      if (!isRecord(message.committed) || settlement) {
        recordFailure(
          new SqliteWorkerError("SQLite worker commit receipt is invalid", "outcome-unknown"),
          "protocol",
        );
        return;
      }
      committed = { facts: message.committed.facts };
      return;
    }
    if (isRecord(message) && message.kind === "native-settlement") {
      const value = message.settlement;
      if (
        !isRecord(value) ||
        (value.kind !== "completed" && value.kind !== "unknown") ||
        (value.committed !== undefined && !isRecord(value.committed)) ||
        settlement
      ) {
        recordFailure(
          new SqliteWorkerError("SQLite worker native settlement is invalid", "outcome-unknown"),
          "protocol",
        );
        return;
      }
      if (isRecord(value.committed)) {
        committed = { facts: value.committed.facts };
      }
      settlement = {
        kind: value.kind,
        ...(committed ? { committed } : {}),
      };
      return;
    }
    if (
      !isRecord(message) ||
      !(message.decision instanceof SharedArrayBuffer) ||
      message.decision.byteLength !== Int32Array.BYTES_PER_ELEMENT ||
      (message.stage !== "open" &&
        message.stage !== "prepare" &&
        message.stage !== "transaction" &&
        message.stage !== "commit")
    ) {
      recordFailure(
        new SqliteWorkerError("SQLite worker admission request is invalid", "unavailable"),
        "protocol",
      );
      return;
    }
    const decision = new Int32Array(message.decision);
    decisions.add(decision);
    if (closed) {
      refuse(
        decision,
        new SqliteWorkerError("SQLite worker admission is closed", "closed"),
        "authority",
      );
      return;
    }
    const request: SqliteWorkerAdmissionRequest = { stage: message.stage, facts: message.facts };
    const grant = () => {
      if (closed || Atomics.load(decision, 0) !== REQUESTED) {
        return false;
      }
      // Domain admission can reenter owner lifecycle before handing the native writer its grant.
      try {
        inOwnerContext(() => databaseAuthority?.assertAccess());
      } catch (error) {
        refuse(decision, error, "authority");
        return false;
      }
      const granted = Atomics.compareExchange(decision, 0, REQUESTED, GRANTED) === REQUESTED;
      if (granted) {
        Atomics.notify(decision, 0);
      }
      return granted;
    };
    let source: AdmissionFailureSource = "authority";
    try {
      runWithStoreWriterNativeWait(() =>
        inOwnerContext(() => {
          databaseAuthority?.assertRequest?.();
          databaseAuthority?.assertAccess();
          if (
            request.stage === "prepare" &&
            isRecord(request.facts) &&
            request.facts.kind === "schema-maintenance"
          ) {
            const authority = databaseAuthority;
            if (
              !authority ||
              typeof request.facts.databasePath !== "string" ||
              resolveIdentityPathViaExistingAncestorSync(request.facts.databasePath) !==
                authority.databasePath
            ) {
              throw new SqliteWorkerError(
                "SQLite schema maintenance target differs from its admitted database",
                "closed",
              );
            }
            authority.lease ??= authority.acquireSchema();
            authority.lease.assertCurrent();
            grant();
          } else {
            source = "domain";
            admit(request, grant);
          }
        }),
      );
    } catch (error) {
      refuse(decision, error, source);
      return;
    } finally {
      // Repeated preparation requests must not retain every settled decision.
      decisions.delete(decision);
    }
    if (Atomics.load(decision, 0) === REQUESTED) {
      refuse(
        decision,
        new SqliteWorkerError("SQLite worker admission was not granted", "closed"),
        "domain",
      );
    }
  };
  port1.on("message", receive);
  port1.unref();
  const service = (check?: () => void) => {
    while (true) {
      check?.();
      const queued = receiveMessageOnPort(port1);
      if (!queued) {
        return;
      }
      receive(queued.message);
    }
  };
  return {
    scope,
    get tentative() {
      service();
      return tentative;
    },
    port: port2,
    bindDatabaseAuthority(authority) {
      if (closed || databaseAuthority) {
        throw new SqliteWorkerError(
          "SQLite database authority is already bound or closed",
          "closed",
        );
      }
      databaseAuthority = {
        ...authority,
        databasePath: resolveIdentityPathViaExistingAncestorSync(authority.databasePath),
      };
    },
    get failure() {
      return failure?.error;
    },
    get failureSource() {
      return failure?.source;
    },
    get cleanupFailures() {
      return cleanupFailures;
    },
    get committed() {
      // Event callbacks can precede delivery of already queued commit facts.
      service();
      return committed;
    },
    get settlement() {
      return settlement;
    },
    waitForSettlement(deadlineMs) {
      while (true) {
        service();
        if (failure !== undefined) {
          throw toErrorObject(failure.error, "SQLite worker admission failed");
        }
        if (settlement?.kind === "completed") {
          return settlement;
        }
        const remaining = deadlineMs - performance.now();
        if (settlement?.kind === "unknown" || closed || remaining <= 0) {
          throw new SqliteWorkerError(
            "SQLite worker native settlement is unknown",
            "outcome-unknown",
          );
        }
        Atomics.wait(waiting, 0, 0, Math.min(5, remaining));
      }
    },
    service,
    revoke() {
      // Keep the receipt endpoint until native settlement; revoke only future grants.
      closed = true;
    },
    finish() {
      closed = true;
      const failures: unknown[] = [];
      try {
        // Receipts remain observable; late requests can no longer obtain authority.
        service();
      } catch (error) {
        failures.push(error);
      }
      for (const decision of decisions) {
        if (Atomics.load(decision, 0) === REQUESTED) {
          refuse(
            decision,
            new SqliteWorkerError("SQLite worker admission is closed", "closed"),
            "authority",
          );
        }
      }
      // Every cleanup owner must settle even when a sibling close fails.
      for (const close of [() => port1.close(), () => port2.close(), () => scope?.close()]) {
        try {
          close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (databaseAuthority?.lease) {
        try {
          databaseAuthority.lease.release();
          databaseAuthority.lease = undefined;
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      throwSqliteLifecycleErrors(failures, "SQLite operation admission cleanup failed");
    },
  };
}

export type SqliteWorkerOperationContext = {
  port: MessagePort;
  refusal?: SqliteWorkerError;
  committed?: { facts: unknown };
  settled?: true;
  attachment?: { value: unknown; taken: boolean; scope?: MessagePort };
};

type WorkerAdmissionScope = {
  // Published SDK request helpers share these port/active carrier fields.
  port: MessagePort;
  owner: SqliteWorkerOperationContext;
  active: boolean;
};
// Source brokers and built plugin backends can load separate module copies in
// one Worker. Share the carrier, while each operation still owns its private port.
const currentAdmission = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerOperationAdmission"),
  () => new AsyncLocalStorage<WorkerAdmissionScope>(),
);
const currentPreparation = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerOperationPreparation"),
  () => new AsyncLocalStorage<{ owner: SqliteWorkerOperationContext; active: boolean }>(),
);

/** Preparation can consume original captured bytes, but cannot issue a native grant. */
export async function withSqliteWorkerOperationPreparation(
  owner: SqliteWorkerOperationContext,
  prepare: () => void | Promise<void>,
): Promise<void> {
  const scope = { owner, active: true };
  try {
    await currentPreparation.run(scope, prepare);
  } finally {
    scope.active = false;
  }
}

/** Install only the private port belonging to the broker's currently executing operation. */
export function withSqliteWorkerOperationAdmission<T>(
  owner: SqliteWorkerOperationContext,
  operation: () => T,
): T {
  const scope = { owner, port: owner.port, active: true };
  try {
    return currentAdmission.run(scope, operation);
  } finally {
    scope.active = false;
  }
}

/** Record facts only after the real transaction commits, before native settlement is announced. */
export function deferSqliteWorkerCommitReceipt(database: DatabaseSync, facts: unknown): void {
  const scope = currentAdmission.getStore();
  if (!scope?.active) {
    throw new SqliteWorkerError("SQLite receipt requires its retained admission", "unavailable");
  }
  if (serialize(facts).byteLength > SQLITE_WORKER_MAX_MESSAGE_BYTES) {
    throw new SqliteWorkerError(
      "SQLite worker commit receipt exceeds the transport limit",
      "overloaded",
    );
  }
  const captured = structuredClone(facts);
  if (
    !stageSqliteTransactionState(database, {
      stage() {},
      commit() {
        scope.owner.committed = { facts: captured };
      },
      prepareObservers() {
        scope.owner.port.postMessage(
          { kind: "native-commit", committed: scope.owner.committed },
          [],
        );
      },
      rollback() {},
    })
  ) {
    throw new Error("SQLite worker receipt requires a transaction publication owner");
  }
}

/** A nested result stays tentative until the actual outer transaction resolves. */
export function retainSqliteWorkerNestedSettlement(
  owner: SqliteWorkerOperationContext,
  database: DatabaseSync,
): void {
  if (!database.isTransaction) {
    settleSqliteWorkerOperationContext(owner, "completed");
    return;
  }
  if (
    !stageSqliteTransactionState(database, {
      stage() {},
      commit() {},
      prepareObservers() {
        settleSqliteWorkerOperationContext(owner, "completed");
      },
      rollback() {
        settleSqliteWorkerOperationContext(owner, "completed");
      },
    })
  ) {
    throw new Error("Nested session result lost its transaction settlement owner");
  }
  owner.port.postMessage({ kind: "native-tentative" }, []);
}

/** The executing worker calls this only after its backend's native settlement check. */
export function settleSqliteWorkerOperationContext(
  owner: SqliteWorkerOperationContext,
  kind: "completed" | "unknown",
): void {
  if (owner.settled) {
    return;
  }
  owner.settled = true;
  owner.port.postMessage(
    {
      kind: "native-settlement",
      settlement: { kind, ...(owner.committed ? { committed: owner.committed } : {}) },
    },
    [],
  );
}

/** Called on the SQLite worker, after transaction entry and before its row mutation. */
export function requestSqliteWorkerOperationAdmission(
  request: SqliteWorkerAdmissionRequest,
  transferList: Transferable[] = [],
): void {
  const scope = currentAdmission.getStore();
  if (!scope?.active) {
    throw new SqliteWorkerError("SQLite operation requires its retained admission", "unavailable");
  }
  const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  scope.port.postMessage({ ...request, decision: decision.buffer }, transferList);
  // Host scheduling delay does not revoke the retained owner's authority. The
  // broker keeps this port through settlement and joins worker exit on failure;
  // only the live host owner can grant or refuse the pending request.
  while (Atomics.load(decision, 0) === REQUESTED) {
    Atomics.wait(decision, 0, REQUESTED);
  }
  if (Atomics.load(decision, 0) !== GRANTED) {
    const refusal = new SqliteWorkerError("SQLite transaction admission was refused", "closed");
    scope.owner.refusal = refusal;
    throw refusal;
  }
}

/** Schema work borrows live host authority through the same retained job port. */
export function requestSqliteWorkerSchemaMaintenance(databasePath: string): boolean {
  if (!currentAdmission.getStore()) {
    return false;
  }
  requestSqliteWorkerOperationAdmission({
    stage: "prepare",
    facts: { kind: "schema-maintenance", databasePath },
  });
  return true;
}

/** Consume owner-prepared data from this executing operation's private port. */
export function takeSqliteWorkerOperationAdmissionAttachment(): unknown {
  const admitted = currentAdmission.getStore();
  const scope = admitted?.active ? admitted : currentPreparation.getStore();
  if (!scope?.active) {
    throw new SqliteWorkerError("SQLite operation requires its retained admission", "unavailable");
  }
  const attachment = readSqliteWorkerOperationAttachment(scope.owner);
  if (!attachment || attachment.taken) {
    throw new SqliteWorkerError("SQLite operation attachment is unavailable", "unavailable");
  }
  attachment.taken = true;
  return attachment.value;
}

function readSqliteWorkerOperationAttachment(owner: SqliteWorkerOperationContext) {
  if (owner.attachment) {
    return owner.attachment;
  }
  const message: unknown = receiveMessageOnPort(owner.port)?.message;
  if (message === undefined) {
    return undefined;
  }
  if (
    !isRecord(message) ||
    message.kind !== "sqlite-operation-attachment" ||
    (message.scope !== undefined && !(message.scope instanceof MessagePort))
  ) {
    throw new SqliteWorkerError("SQLite operation attachment is invalid", "unavailable");
  }
  return (owner.attachment = {
    value: message.value,
    taken: false,
    ...(message.scope ? { scope: message.scope } : {}),
  });
}

/** The carrier calls this only within the exact executing operation's grant context. */
export function takeSqliteWorkerOperationScope(): MessagePort | undefined {
  const scope = currentAdmission.getStore();
  if (!scope?.active) {
    throw new SqliteWorkerError("SQLite scope lost its native admission", "unavailable");
  }
  const attachment = readSqliteWorkerOperationAttachment(scope.owner);
  const port = attachment?.scope;
  if (attachment) {
    attachment.scope = undefined;
  }
  return port;
}

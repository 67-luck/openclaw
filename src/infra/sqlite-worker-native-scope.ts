import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { deserialize } from "node:v8";
import type { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { encodeOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import { assertSyncTransactionResult, assertTransactionUsable } from "./sqlite-transaction.js";
import {
  SQLITE_WORKER_EXECUTE_SCOPED,
  SqliteWorkerError,
  SqliteWorkerHostStepAbortedError,
  sqliteWorkerHostFailure,
  type SqliteWorkerCommand,
  type SqliteWorkerOperations,
  type SqliteWorkerPreparedBackend,
  type SqliteWorkerScopeAction,
  type SqliteWorkerScopeStep,
  type SqliteWorkerScopeWireResult,
} from "./sqlite-worker-contract.js";
import {
  retainSqliteWorkerNestedSettlement,
  settleSqliteWorkerOperationContext,
  takeSqliteWorkerOperationScope,
  withSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationContext,
} from "./sqlite-worker-operation-admission.js";
import type { SqliteWorkerStateContext } from "./sqlite-worker-state-context.js";
import { createSqliteWorkerScopedTransfer } from "./sqlite-worker-transfer.js";

type NativeScope = ReturnType<typeof createNativeScope>;
const nativeScopes = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerNativeScopes"),
  (): NativeScope[] => [],
);
const currentScope = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerCurrentScope"),
  () => new AsyncLocalStorage<NativeScope>(),
);

function createNativeScope(
  port: MessagePort,
  execute: (targetActor: number, payload: Uint8Array, admission: MessagePort) => unknown,
) {
  let nextId = 0;
  const frames = new Map<
    number,
    {
      inOwner: ReturnType<typeof AsyncLocalStorage.snapshot>;
      call(this: void, action: SqliteWorkerScopeAction): unknown;
      result?: { abort: boolean; value?: boolean };
    }
  >();
  const transfer = createSqliteWorkerScopedTransfer(port, (message, ports) => {
    if (!isRecord(message) || typeof message.id !== "number" || !Number.isSafeInteger(message.id)) {
      throw new Error("SQLite native scope received an invalid request");
    }
    const frame = frames.get(message.id);
    if (!frame || frame.result) {
      throw new Error("SQLite native scope lost its retained cursor");
    }
    if (
      message.kind === "finish" &&
      !ports.length &&
      typeof message.abort === "boolean" &&
      (message.value === undefined || typeof message.value === "boolean")
    ) {
      if ([...frames.keys()].at(-1) !== message.id) {
        throw new Error("SQLite snapshot scopes must finish in order");
      }
      frame.result = { abort: message.abort, value: message.value };
      return;
    }
    if (
      message.kind !== "call" ||
      !Number.isSafeInteger(message.sequence) ||
      !isRecord(message.action) ||
      (message.action.kind !== "next" &&
        message.action.kind !== "return" &&
        message.action.kind !== "execute")
    ) {
      throw new Error("SQLite native scope received an invalid cursor request");
    }
    let result: SqliteWorkerScopeWireResult;
    try {
      if (message.action.kind === "execute") {
        if (
          ports.length !== 1 ||
          typeof message.action.targetActor !== "number" ||
          !Number.isSafeInteger(message.action.targetActor) ||
          !(message.action.value instanceof Uint8Array) ||
          [...frames.keys()].at(-1) !== message.id
        ) {
          throw new Error("Nested SQLite command lost its current scope");
        }
        result = {
          ok: true,
          value: frame.inOwner(
            execute,
            message.action.targetActor,
            message.action.value,
            ports[0]!,
          ),
        };
      } else {
        if (ports.length) {
          throw new Error("SQLite cursor request cannot transfer authority");
        }
        result = {
          ok: true,
          value: frame.inOwner(frame.call, {
            kind: message.action.kind,
            value: message.action.value,
          }),
        };
      }
    } catch (error) {
      result = {
        ok: false,
        error: encodeOpenClawStateWorkerError(error, { includeOrdinary: true }),
        hostFailure: sqliteWorkerHostFailure(error),
      };
    }
    transfer.post({ kind: "result", sequence: message.sequence, result });
  });
  port.once("close", () => transfer.close());
  const waiting = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  return {
    service: transfer.service,
    enter(step: SqliteWorkerScopeStep, call: (action: SqliteWorkerScopeAction) => unknown) {
      const id = ++nextId;
      const frame: NonNullable<ReturnType<typeof frames.get>> = {
        inOwner: AsyncLocalStorage.snapshot(),
        call,
      };
      frames.set(id, frame);
      try {
        transfer.post({ kind: "enter", id, step });
        while (!frame.result) {
          // A child savepoint can still read its ancestor's live cursor. These services
          // execute only scoped native commands, never host callbacks or Promise jobs.
          for (const scope of nativeScopes) {
            scope.service();
          }
          if (!frame.result) {
            Atomics.wait(waiting, 0, 0, 5);
          }
        }
        if (frame.result.abort) {
          throw new SqliteWorkerHostStepAbortedError();
        }
        return frame.result.value;
      } finally {
        frames.delete(id);
      }
    },
  };
}

/** The original admission port transfers this endpoint; identifiers alone cannot enroll it. */
export function withSqliteWorkerNativeScope<T>(
  port: MessagePort,
  run: () => T,
  execute: (targetActor: number, payload: Uint8Array, admission: MessagePort) => unknown,
): T {
  const scope = createNativeScope(port, execute);
  nativeScopes.push(scope);
  let outcome: { value: T } | { error: unknown };
  let outOfOrder: boolean;
  try {
    outcome = { value: currentScope.run(scope, run) };
  } catch (error) {
    outcome = { error };
  } finally {
    outOfOrder = nativeScopes.pop() !== scope;
    // Native exit or the original host admission's completed settlement closes
    // the endpoint. Returning from a scoped callback is not that evidence.
  }
  if (outOfOrder) {
    const error = new Error("SQLite native scopes finished out of order");
    if ("error" in outcome) {
      throw new AggregateError([outcome.error, error], "SQLite native scope and ordering failed", {
        cause: outcome.error,
      });
    }
    throw error;
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

export function requestSqliteWorkerHostStep(
  step: SqliteWorkerScopeStep,
  call: (action: SqliteWorkerScopeAction) => unknown = () => {
    throw new Error("SQLite predicate scope has no cursor");
  },
): boolean | undefined {
  const scope = currentScope.getStore();
  if (!scope || !nativeScopes.includes(scope)) {
    throw new SqliteWorkerError(
      "SQLite caller continuation has no retained native scope",
      "unavailable",
    );
  }
  return scope.enter(step, call);
}

/** Descendants retain the executing request's maps, contexts and retirement owner. */
export function createSqliteWorkerNativeExecutor({
  actors,
  stateContexts,
  runInActorContext,
  runWithActorFacts,
  retire,
}: {
  actors: ReadonlyMap<
    number,
    { backend: SqliteWorkerPreparedBackend<SqliteWorkerOperations>; volatile: boolean }
  >;
  stateContexts: ReadonlyMap<number, SqliteWorkerStateContext>;
  runInActorContext: <T>(actor: number, operation: () => T) => T;
  runWithActorFacts: <T>(actor: number, operation: () => T) => T;
  retire: () => void;
}) {
  const executeScoped =
    (sourceActor: number) =>
    (targetActor: number, payload: Uint8Array, port: MessagePort): unknown => {
      const child: SqliteWorkerOperationContext = { port };
      let connection: { database: DatabaseSync; transaction: boolean } | undefined;
      try {
        const source = actors.get(sourceActor);
        const target = actors.get(targetActor);
        const independent = sourceActor !== targetActor;
        const sourceContext = stateContexts.get(sourceActor);
        const targetContext = stateContexts.get(targetActor);
        if (
          !source ||
          !target ||
          (independent &&
            (source.volatile ||
              !target.volatile ||
              !sourceContext ||
              !targetContext ||
              sourceContext.environment.OPENCLAW_STATE_DIR !==
                targetContext.environment.OPENCLAW_STATE_DIR ||
              sourceContext.existingSchemaPath !== targetContext.existingSchemaPath))
        ) {
          throw new Error("Nested SQLite target differs from its retained carrier owner");
        }
        const backend = target.backend;
        const command: unknown = deserialize(payload);
        if (
          !isRecord(command) ||
          typeof command.type !== "string" ||
          !backend[SQLITE_WORKER_EXECUTE_SCOPED]
        ) {
          throw new Error("SQLite backend has no prepared scoped command owner");
        }
        // A cross-actor descendant owns B's schema/context and admission while
        // the suspended A frame retains its original transaction and settlement.
        const run = independent ? runInActorContext : runWithActorFacts;
        const result = run(targetActor, () =>
          withSqliteWorkerOperationAdmission(child, () => {
            const scope = takeSqliteWorkerOperationScope();
            const execute = () =>
              backend[SQLITE_WORKER_EXECUTE_SCOPED]!(
                // SAFETY: The paired retained client serialized this domain's original command.
                command as SqliteWorkerCommand<SqliteWorkerOperations>,
                (database) => {
                  if (independent && database.isTransaction) {
                    throw new Error(
                      "Independent volatile execution cannot borrow a native transaction",
                    );
                  }
                  connection = { database, transaction: database.isTransaction };
                },
              );
            return scope
              ? withSqliteWorkerNativeScope(scope, execute, executeScoped(targetActor))
              : execute();
          }),
        );
        assertSyncTransactionResult(result);
        if (connection) {
          assertTransactionUsable(connection.database);
          if (connection.database.isTransaction !== connection.transaction) {
            throw new Error("Nested SQLite command changed its outer transaction boundary");
          }
          retainSqliteWorkerNestedSettlement(child, connection.database);
        } else {
          settleSqliteWorkerOperationContext(child, "completed");
        }
        return result;
      } catch (error) {
        let failures: unknown[] | undefined;
        try {
          if (connection) {
            assertTransactionUsable(connection.database);
            if (connection.database.isTransaction !== connection.transaction) {
              throw error;
            }
          }
          settleSqliteWorkerOperationContext(child, "completed");
        } catch (cleanupError) {
          retire();
          failures = cleanupError === error ? [error] : [error, cleanupError];
          try {
            settleSqliteWorkerOperationContext(child, "unknown");
          } catch (settlementError) {
            failures.push(settlementError);
          }
        }
        if (failures && failures.length > 1) {
          throw new AggregateError(failures, "Nested SQLite failure and settlement failed", {
            cause: error,
          });
        }
        throw error;
      }
    };
  return executeScoped;
}

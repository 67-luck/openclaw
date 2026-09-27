import { AsyncLocalStorage } from "node:async_hooks";
import { isPromise } from "node:util/types";
import { serialize } from "node:v8";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createDeferredCore } from "../shared/deferred.js";
import { runWithStoreWriterNativeWait } from "../shared/store-writer-queue.js";
import type {
  Actor,
  OperationScope,
  ReadySqliteWorkerOperation,
  StoreClient,
} from "./sqlite-worker-broker.types.js";
import {
  SqliteWorkerError,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
  type SqliteWorkerStateLifecycle,
} from "./sqlite-worker-contract.js";
import { executeSqliteWorkerScopedCommand } from "./sqlite-worker-host-context.js";
import {
  createSqliteWorkerAdmissionFactory,
  type SqliteWorkerAdmissionFactory,
} from "./sqlite-worker-operation-admission.js";
import {
  captureSqliteWorkerStateContext,
  type SqliteWorkerStateContext,
} from "./sqlite-worker-state-context.js";
import { SQLITE_WORKER_PROTOCOL_WAIT_NS } from "./sqlite-worker-transport-contract.js";

export function runSqliteWorkerClientOperation<Operations extends SqliteWorkerOperations, T>(
  client: StoreClient | undefined,
  operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
  stateContext: SqliteWorkerStateContext | undefined,
  track: (pending: Promise<void>) => () => void,
  assertCurrent?: (commandType: PropertyKey) => void,
  createAdmission?: SqliteWorkerAdmissionFactory,
  requireStateLifecycle: SqliteWorkerStateLifecycle = false,
): Promise<T> {
  let retained: ReturnType<typeof retainSqliteWorkerClientOperation<Operations>>;
  try {
    retained = retainSqliteWorkerClientOperation(
      client,
      stateContext,
      track,
      assertCurrent,
      createAdmission,
      requireStateLifecycle,
    );
  } catch (error) {
    // Retention and caller callbacks may reject with any original value.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors
    return Promise.reject(error);
  }
  return (async () => {
    try {
      const result = operation(retained);
      return isPromise(result) ? await result : result;
    } finally {
      await retained.close();
    }
  })();
}

/** The same retained scope owns async delivery and private ready servicing. */
export function retainSqliteWorkerClientOperation<Operations extends SqliteWorkerOperations>(
  client: StoreClient | undefined,
  stateContext: SqliteWorkerStateContext | undefined,
  track: (pending: Promise<void>) => () => void,
  assertCurrent?: (commandType: PropertyKey) => void,
  createAdmission?: SqliteWorkerAdmissionFactory,
  requireStateLifecycle: SqliteWorkerStateLifecycle = false,
) {
  if (!client || client.sealed) {
    throw new SqliteWorkerError("SQLite worker store is closed", "closed");
  }
  const scope: OperationScope = {
    requireStateLifecycle,
    createAdmission,
    assertCurrent,
    active: true,
    pending: new Set(),
    ...(stateContext ? { stateContext: captureSqliteWorkerStateContext(stateContext) } : {}),
  };
  const released = createDeferredCore();
  client.scopes.add(released.promise);
  const untrack = track(released.promise);
  let closing: Promise<void> | undefined;
  return {
    execute: ((command, options = {}) =>
      // SAFETY: the original typed store keeps actor, command, pending job and reply correlated.
      client.execute(command, options, scope)) as SqliteWorkerStore<Operations>["execute"],
    executeReady<K extends keyof Operations>(
      this: void,
      command: {
        type: K;
        input: Operations[K]["input"];
      },
    ): Operations[K]["output"] {
      // SAFETY: This is the exact store's native ready path, never a blocked Promise adapter.
      return client.executeReady(command, scope) as Operations[K]["output"];
    },
    close() {
      scope.active = false;
      return (closing ??= (async () => {
        // A ready timeout detaches only its waiter; original native work remains retained here.
        await Promise.allSettled(scope.pending);
        client.scopes.delete(released.promise);
        untrack();
        released.resolve();
      })());
    },
  };
}

export function createSqliteWorkerClient<Operations extends SqliteWorkerOperations>(owner: {
  actor: Actor;
  isDraining: () => boolean;
  isAvailable: () => boolean;
  dispatch: (
    payload: Buffer,
    signal: AbortSignal | undefined,
    scope: OperationScope | undefined,
    assertCurrent: (() => void) | undefined,
    createAdmission: SqliteWorkerAdmissionFactory | undefined,
    ready?: ReadySqliteWorkerOperation,
  ) => Promise<unknown>;
  retireFailed: () => Promise<void>;
  release: () => Promise<void>;
}) {
  let closed: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const dispatch = (
    command: { type: PropertyKey; input: unknown },
    options: { signal?: AbortSignal },
    scope?: OperationScope,
    ready?: ReadySqliteWorkerOperation,
  ): Promise<unknown> => {
    const refused = (error: Error) => {
      if (ready) {
        ready.result = { ok: false, error };
      }
      return Promise.reject(error);
    };
    if (
      owner.actor.protocolFailure ||
      (scope ? !scope.active : closed || client.sealed || owner.isDraining())
    ) {
      return refused(
        owner.actor.protocolFailure ??
          new SqliteWorkerError("SQLite worker store is closed", "closed"),
      );
    }
    if (options.signal?.aborted) {
      return refused(toErrorObject(options.signal.reason, "SQLite worker operation canceled"));
    }
    let payload: Buffer;
    let assertCurrent: (() => void) | undefined;
    const admission = scope?.assertCurrent;
    const createAdmission = scope?.createAdmission;
    // Queued grants must retain the command's original async authority context.
    const inCaller = admission || createAdmission ? AsyncLocalStorage.snapshot() : undefined;
    try {
      const commandType = command.type;
      assertCurrent = admission && inCaller ? () => inCaller(admission, commandType) : undefined;
      assertCurrent?.();
      // The queued guard and wire payload consume the same captured command type.
      payload = serialize({ type: commandType, input: command.input });
    } catch (error) {
      return refused(toErrorObject(error, "SQLite worker command could not be serialized"));
    }
    const operation = owner.dispatch(
      payload,
      options.signal,
      scope,
      assertCurrent,
      createAdmission && inCaller
        ? createSqliteWorkerAdmissionFactory(
            createAdmission.requiresHostContinuation,
            (admissionOperation) => inCaller(createAdmission, admissionOperation),
          )
        : undefined,
      ready,
    );
    pending.add(operation);
    scope?.pending.add(operation);
    const settled = () => {
      pending.delete(operation);
      scope?.pending.delete(operation);
    };
    void operation.then(settled, settled);
    return operation;
  };
  const client: StoreClient = {
    actor: owner.actor,
    close: () => store.close(),
    sealed: owner.isDraining(),
    isAvailable: owner.isAvailable,
    scopes: new Set(),
    execute: dispatch,
    executeReady(command, scope) {
      const actor = owner.actor;
      const transport = actor.slot.transport;
      if (!actor.volatile || !actor.initialized || !transport) {
        throw new SqliteWorkerError(
          "SQLite synchronous execution requires a ready volatile owner",
          "unavailable",
        );
      }
      if (scope) {
        if (actor.protocolFailure) {
          throw actor.protocolFailure;
        }
        scope.assertCurrent?.(command.type);
        const nested = executeSqliteWorkerScopedCommand(
          actor,
          serialize({ type: command.type, input: command.input }),
          scope,
        );
        if (nested) {
          return nested.value;
        }
      }
      const received: ReadySqliteWorkerOperation = {};
      // This completion is recorded by the native reply owner, not a Promise reaction.
      void dispatch(command, {}, scope, received).catch(() => undefined);
      const job = received.job;
      const waiting = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      const check = (watch: ReturnType<typeof transport.watch> | undefined) => {
        if (job?.terminal) {
          return;
        }
        if (actor.slot.failed) {
          throw new SqliteWorkerError(
            "SQLite native worker stopped before this call settled",
            job?.nativeDispatched ? "outcome-unknown" : "unavailable",
          );
        }
        // Queue time and lifecycle acquisition are not the ready job's protocol interval.
        const start = job?.request.workerStateLifecycle
          ? job.preparedAtNs
          : job?.transportPostedAtNs;
        const scoped = job?.operationAdmission?.admission.scope;
        const deadline =
          scoped?.requestDeadlineNs ??
          (start === undefined
            ? undefined
            : start + SQLITE_WORKER_PROTOCOL_WAIT_NS + (scoped?.pausedNs ?? 0n));
        if (deadline !== undefined && process.hrtime.bigint() >= deadline) {
          throw new SqliteWorkerError(
            "SQLite worker protocol settlement is unknown",
            "outcome-unknown",
          );
        }
        watch?.check();
      };
      const wait = (complete: () => boolean) =>
        runWithStoreWriterNativeWait(() => {
          // A direct host callback is outside a native wait. Its next scoped request
          // gets a fresh liveness probe, never a renewed SQL/operation deadline.
          const watch = job && transport.watch(job.request.id);
          const checkWait = () => check(watch);
          try {
            // The native pump settles this exact Job; its identity does not change.
            // oxlint-disable-next-line eslint/no-unmodified-loop-condition
            while (!job?.terminal && !complete()) {
              checkWait();
              const current = actor.slot.current;
              current?.dispatchPrepared?.();
              if (job?.terminal) {
                break;
              }
              if (current?.terminal) {
                continue;
              }
              current?.lifecyclePreparation?.service(checkWait);
              if (job?.terminal) {
                break;
              }
              if (current?.terminal) {
                continue;
              }
              current?.operationAdmission?.admission.service(checkWait);
              if (job?.terminal) {
                break;
              }
              if (current?.terminal) {
                continue;
              }
              job?.operationAdmission?.admission.scope?.service(checkWait);
              if (job?.terminal) {
                break;
              }
              checkWait();
              if (complete()) {
                break;
              }
              const pumped = transport.pump();
              if (job?.terminal) {
                break;
              }
              if (!pumped) {
                Atomics.wait(waiting, 0, 0, 5);
              }
            }
            return job?.terminal;
          } finally {
            watch?.finish();
          }
        });
      let result = job?.terminal?.result ?? received.result;
      try {
        while (!result) {
          wait(() => job?.operationAdmission?.admission.scope?.pending === true);
          if (!job?.terminal) {
            // This is the direct caller continuation after the private wait returned.
            // No predecessor's public callback is run by the ready service.
            job?.operationAdmission?.admission.scope?.drive(wait);
          }
          result = job?.terminal?.result ?? received.result;
        }
      } catch (error) {
        client.sealed = true;
        actor.protocolFailure ??= toErrorObject(
          error,
          "SQLite worker protocol settlement is unknown",
        );
        // The original job and all claims stay owned until a real native result or joined stop.
        throw actor.protocolFailure;
      }
      // Native settlement has finished. Only now may the direct caller observe child publications.
      job?.operationAdmission?.admission.scope?.publish();
      if (!result.ok) {
        throw result.error;
      }
      return result.value;
    },
  };
  const store: SqliteWorkerStore<Operations> = {
    execute: (command, options = {}) =>
      // SAFETY: The typed backend owns this result.
      client.execute(command, options) as Promise<Operations[typeof command.type]["output"]>,
    close: () => {
      if (!closed) {
        client.sealed = true;
        closed = (async () => {
          // Explicit cleanup can retire a protocol-failed slot while its accepted
          // jobs still own UNKNOWN outcomes. Those jobs settle only after native join.
          await owner.retireFailed();
          await Promise.allSettled(client.scopes);
          await Promise.allSettled(pending);
          await owner.release();
        })().catch((error: unknown) => {
          closed = undefined;
          throw error;
        });
      }
      return closed;
    },
  };
  return { store, client };
}

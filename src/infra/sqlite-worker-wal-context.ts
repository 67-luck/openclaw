import { AsyncLocalStorage } from "node:async_hooks";
import type { MessagePort } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { throwSqliteLifecycleErrors } from "./sqlite-lifecycle-errors.js";
import type { SqliteWalCheckpointSnapshot } from "./sqlite-wal-checkpoint.js";
import type { SqliteWalPeriodicResult } from "./sqlite-wal-write-admission.js";
import type {
  SqliteWorkerWalCommand,
  SqliteWorkerWalFacts,
  SqliteWorkerWalReply,
  SqliteWalMaintenanceReceipt,
} from "./sqlite-worker-wal.types.js";
import { SqliteWorkerWalAdmissionRefusedError } from "./sqlite-worker-wal.types.js";

export type SqliteWorkerWalLease = {
  ready: Promise<void>;
  assertCurrent(): void;
  /** Rebind deferred maintenance when a native handle is borrowed by another actor. */
  bind(): void;
  checkpoint(): Promise<SqliteWalCheckpointSnapshot | undefined>;
  startPass(
    operation: (assertCurrent: () => void) => Promise<SqliteWalPeriodicResult>,
    claim: boolean,
  ): { receipt: SqliteWalMaintenanceReceipt; result: Promise<SqliteWalPeriodicResult> };
  schedule<T>(operation: () => T): Promise<T | undefined>;
  stop(): Promise<void>;
};
export type SqliteWorkerWalContext = {
  actor: number;
  run<T>(operation: () => T): T;
  register(
    facts: SqliteWorkerWalFacts,
    observe: (checkpoint: SqliteWalCheckpointSnapshot) => void,
  ): SqliteWorkerWalLease;
};
type Lease = {
  authority: Int32Array<SharedArrayBuffer>;
  actor?: number;
  observe: (checkpoint: SqliteWalCheckpointSnapshot) => void;
  active: Set<Promise<unknown>>;
  stop(this: void): Promise<void>;
};
type Scheduled = {
  id: number;
  actor: number;
  lease: Lease;
  started: boolean;
  run(): unknown;
  ack(error?: Error): void;
  cancel(): void;
};
const current = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerWalContext"),
  () => new AsyncLocalStorage<SqliteWorkerWalContext>(),
);
const log = createSubsystemLogger("infra/sqlite-wal");
export function captureSqliteWorkerWalContext(): SqliteWorkerWalContext | undefined {
  return current.getStore();
}

/** Slot custody outlives the first actor borrowing a shared native connection. */
export function createSqliteWorkerWalContext(port: MessagePort) {
  const actors = new Map<number, SqliteWorkerWalContext>();
  const leases = new Map<number, Lease>();
  const pending = new Map<number, Deferred<SqliteWalCheckpointSnapshot | undefined>>();
  const scheduled = new Map<number, Scheduled>();
  const transitions = new Set<{
    promise: Promise<void>;
    stopped?: () => Promise<void> | undefined;
  }>();
  let sequence = 0;
  let leaseSequence = 0;
  let passSequence = 0;
  let unitSequence = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  const cancel = (lease: Lease) => {
    Atomics.store(lease.authority, 0, 0);
    for (const entry of scheduled.values()) {
      if (entry.lease === lease && !entry.started) {
        scheduled.delete(entry.id);
        entry.cancel();
      }
    }
  };
  port.on("message", (message: SqliteWorkerWalReply) => {
    if (message.type === "observation") {
      const lease = leases.get(message.lease);
      if (lease && Atomics.load(lease.authority, 0) === 1) {
        try {
          lease.observe(message.checkpoint);
        } catch (error) {
          log.warn("SQLite WAL observation failed", { error: String(error) });
        }
      }
    } else if (message.type === "unitAck") {
      const entry = scheduled.get(message.unit);
      if (entry) {
        scheduled.delete(message.unit);
        entry.ack(message.ok ? undefined : new Error(message.error));
      }
    } else {
      const request = pending.get(message.id);
      if (!request) {
        return;
      }
      pending.delete(message.id);
      if (message.ok) {
        request.resolve(message.checkpoint);
      } else {
        request.reject(
          message.admissionRefused
            ? new SqliteWorkerWalAdmissionRefusedError(message.error)
            : new Error(message.error),
        );
      }
    }
    if (!pending.size) {
      port.unref();
    }
  });
  port.on("close", () => {
    closed = true;
    for (const lease of leases.values()) {
      cancel(lease);
    }
    for (const request of pending.values()) {
      request.reject(new Error("SQLite WAL slot channel closed"));
    }
    for (const entry of scheduled.values()) {
      entry.ack(new Error("SQLite WAL slot channel closed"));
    }
    scheduled.clear();
    pending.clear();
  });
  port.on("messageerror", () => port.close());
  port.unref();
  const send = (request: SqliteWorkerWalCommand) => {
    if (closed) {
      return Promise.reject(new Error("SQLite WAL slot channel closed"));
    }
    const id = ++sequence;
    const deferred = createDeferredCore<SqliteWalCheckpointSnapshot | undefined>();
    pending.set(id, deferred);
    port.ref();
    try {
      port.postMessage({ ...request, id }, []);
    } catch (error) {
      pending.delete(id);
      deferred.reject(toErrorObject(error, "SQLite WAL request failed"));
    }
    return deferred.promise;
  };
  return {
    forActor(actor: number): SqliteWorkerWalContext {
      const existing = actors.get(actor);
      if (existing) {
        return existing;
      }
      const context: SqliteWorkerWalContext = {
        actor,
        run<T>(operation: () => T): T {
          return current.run(context, operation);
        },
        register(facts, observe) {
          if (closed || closing) {
            throw new Error("SQLite WAL slot is closing");
          }
          const id = ++leaseSequence;
          const authority = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
          Atomics.store(authority, 0, 1);
          let stopped: Promise<void> | undefined;
          let activePass:
            | {
                actor: number;
                receipt: SqliteWalMaintenanceReceipt;
                result: Promise<SqliteWalPeriodicResult>;
              }
            | undefined;
          const lease: Lease = {
            authority,
            actor,
            observe,
            active: new Set(),
            stop() {
              cancel(lease);
              if (!stopped) {
                stopped = (async () => {
                  await Promise.allSettled(lease.active);
                  await send({ type: "close", actor: lease.actor ?? actor, lease: id });
                  leases.delete(id);
                })().catch((error: unknown) => {
                  stopped = undefined;
                  throw error;
                });
                transitions.add({ promise: stopped });
                void stopped.catch(() => {});
              }
              return stopped;
            },
          };
          leases.set(id, lease);
          const ready = send({
            type: "open",
            actor,
            lease: id,
            facts: { ...facts },
            authority: authority.buffer,
          }).then(() => {});
          transitions.add({ promise: ready, stopped: () => stopped });
          void ready.catch(() => {});
          const bind = () => {
            assertCurrent();
            const active = current.getStore();
            if (active && actors.get(active.actor) === active && lease.actor !== active.actor) {
              for (const entry of scheduled.values()) {
                if (entry.lease === lease && !entry.started) {
                  scheduled.delete(entry.id);
                  entry.cancel();
                }
              }
              lease.actor = active.actor;
            }
          };
          const assertCurrent = () => {
            if (closed || Atomics.load(authority, 0) !== 1) {
              throw new Error("SQLite WAL native-handle lease is closed");
            }
          };
          return {
            ready,
            bind,
            assertCurrent,
            startPass(operation, claim) {
              assertCurrent();
              const owner = lease.actor === undefined ? undefined : actors.get(lease.actor);
              if (!owner) {
                throw new Error("SQLite maintenance actor is no longer current");
              }
              if (activePass) {
                if (activePass.actor !== owner.actor) {
                  throw new Error("SQLite maintenance pass is retiring its previous actor");
                }
                if (claim) {
                  void send({
                    type: "claimPass",
                    actor: owner.actor,
                    lease: id,
                    pass: activePass.receipt.pass,
                  }).catch(() => {});
                }
                return activePass;
              }
              const receipt = { lease: id, pass: ++passSequence };
              const finishCoalescing = () => {
                if (activePass?.receipt.pass === receipt.pass) {
                  activePass = undefined;
                }
              };
              const assertPassCurrent = () => {
                assertCurrent();
                if (lease.actor !== owner.actor || actors.get(owner.actor) !== owner) {
                  throw new Error("SQLite maintenance pass lost its actor");
                }
              };
              const started = send({
                type: "beginPass",
                actor: owner.actor,
                lease: id,
                pass: receipt.pass,
                claim,
              });
              const result = runInDetachedAsyncContext(async () => {
                try {
                  await started;
                  await ready;
                  assertPassCurrent();
                  const value = await owner.run(() => operation(assertPassCurrent));
                  assertPassCurrent();
                  finishCoalescing();
                  await send({
                    type: "finishPass",
                    actor: owner.actor,
                    ...receipt,
                    ok: true,
                    result: value,
                  });
                  return value;
                } catch (error) {
                  const failure = toErrorObject(error, "SQLite maintenance pass failed");
                  finishCoalescing();
                  await send({
                    type: "finishPass",
                    actor: owner.actor,
                    ...receipt,
                    ok: false,
                    error: String(failure),
                  }).catch(() => {});
                  throw failure;
                }
              });
              const pass = { actor: owner.actor, receipt, result };
              activePass = pass;
              lease.active.add(result);
              const settled = () => {
                lease.active.delete(result);
                if (activePass === pass) {
                  activePass = undefined;
                }
              };
              void result.then(settled, settled);
              return pass;
            },
            async checkpoint() {
              assertCurrent();
              await ready;
              if (Atomics.load(authority, 0) !== 1 || lease.actor === undefined) {
                return undefined;
              }
              const result = await send({ type: "checkpoint", actor: lease.actor, lease: id });
              return Atomics.load(authority, 0) === 1 ? result : undefined;
            },
            schedule<T>(operation: () => T): Promise<T | undefined> {
              if (Atomics.load(authority, 0) !== 1 || lease.actor === undefined) {
                return Promise.resolve(undefined);
              }
              const pass = activePass;
              if (!pass || pass.actor !== lease.actor) {
                return Promise.reject(new Error("SQLite maintenance unit has no current pass"));
              }
              const unit = ++unitSequence;
              const deferred = createDeferredCore<T | undefined>();
              let settle: (() => void) | undefined;
              scheduled.set(unit, {
                id: unit,
                actor: pass.actor,
                lease,
                started: false,
                cancel: () => deferred.resolve(undefined),
                run() {
                  try {
                    const value = operation();
                    settle = () => deferred.resolve(value);
                    return value;
                  } catch (error) {
                    const failure = toErrorObject(error, "SQLite maintenance unit failed");
                    settle = () => deferred.reject(failure);
                    throw failure;
                  }
                },
                ack(error) {
                  if (error) {
                    deferred.reject(error);
                  } else if (settle) {
                    settle();
                  } else {
                    deferred.reject(new Error("SQLite maintenance unit was not executed"));
                  }
                },
              });
              lease.active.add(deferred.promise);
              const settled = () => lease.active.delete(deferred.promise);
              void deferred.promise.then(settled, settled);
              void send({
                type: "schedule",
                actor: pass.actor,
                lease: id,
                pass: pass.receipt.pass,
                unit,
              }).catch((error: unknown) => {
                scheduled.delete(unit);
                deferred.reject(toErrorObject(error, "SQLite maintenance unit admission failed"));
              });
              return deferred.promise;
            },
            stop: lease.stop,
          };
        },
      };
      actors.set(actor, context);
      return context;
    },
    runUnit(actor: number, unit: number, prepare?: (operation: () => unknown) => unknown): unknown {
      const entry = scheduled.get(unit);
      if (!entry) {
        return undefined;
      }
      if (entry.actor !== actor || entry.started) {
        throw new Error("SQLite maintenance unit changed its actor or already ran");
      }
      if (Atomics.load(entry.lease.authority, 0) !== 1 || entry.lease.actor !== actor) {
        scheduled.delete(unit);
        entry.cancel();
        return undefined;
      }
      entry.started = true;
      return prepare ? prepare(() => entry.run()) : entry.run();
    },
    retireActor(actor: number): void {
      actors.delete(actor);
      for (const lease of leases.values()) {
        if (lease.actor === actor) {
          lease.actor = undefined;
        }
      }
      for (const entry of scheduled.values()) {
        if (entry.actor === actor && !entry.started) {
          scheduled.delete(entry.id);
          entry.cancel();
        }
      }
    },
    joinTransitions(): Promise<void> | undefined {
      if (!transitions.size) {
        return undefined;
      }
      const selected = [...transitions];
      transitions.clear();
      return Promise.allSettled(
        selected.map(async (transition) => {
          try {
            await transition.promise;
          } catch (error) {
            const stopped =
              error instanceof SqliteWorkerWalAdmissionRefusedError
                ? transition.stopped?.()
                : undefined;
            if (!stopped) {
              throw error;
            }
            // Readiness still rejects; only a completed, intentionally requested close supersedes it.
            await stopped;
          }
        }),
      ).then((results) => {
        throwSqliteLifecycleErrors(
          results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
          "SQLite WAL native-handle transition failed",
        );
      });
    },
    close(): Promise<void> {
      for (const lease of leases.values()) {
        cancel(lease);
      }
      return (closing ??= (async () => {
        const results = await Promise.allSettled([...leases.values()].map((lease) => lease.stop()));
        throwSqliteLifecycleErrors(
          results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
          "SQLite WAL slot cleanup failed",
        );
        transitions.clear();
        port.close();
      })().catch((error: unknown) => {
        closing = undefined;
        throw error;
      }));
    },
  };
}

import { AsyncLocalStorage } from "node:async_hooks";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureSqliteLibrarySelected } from "./bun-sqlite-library.js";
import { resolveNodeCompileCacheEnv } from "./node-compile-cache-env.js";
import type { RuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-coordinator.js";
import { releaseSqliteWorkerActorCoordinators } from "./sqlite-worker-broker-admission.js";
import {
  receiveSqliteWorkerReply,
  type SqliteWorkerReplyOwner,
} from "./sqlite-worker-broker-reply.js";
import type {
  Actor,
  EnqueueOptions,
  Slot,
  StoreClient,
  PreparedSqliteWorkerOpen,
} from "./sqlite-worker-broker.types.js";
import { SqliteWorkerError, type SqliteWorkerReply } from "./sqlite-worker-contract.js";
import { SQLITE_WORKER_HEAP_LIMIT_MB } from "./sqlite-worker-transport-contract.js";
import { createSqliteWorkerTransport } from "./sqlite-worker-transport.js";
import { createCpuTrackedWorker } from "./worker-cpu.js";

const runOutsideCaller = AsyncLocalStorage.snapshot();

/** The broker retains these maps; this owner drains clients before native close custody. */
export function createSqliteWorkerLifecycle({
  actors,
  slots,
  stores,
  getMaxWorkers,
  maxStores,
  enqueueClose,
  fail,
}: {
  actors: Map<string, Actor>;
  slots: Set<Slot>;
  stores: Map<object, StoreClient>;
  getMaxWorkers: () => number;
  maxStores: number;
  enqueueClose: (
    actor: Actor,
    maintenanceScope?: EnqueueOptions["maintenanceScope"],
  ) => Promise<unknown>;
  fail: (slot: Slot, error: unknown) => void;
}) {
  let physicalWorkers = 0;
  async function acquireSlot(
    options: PreparedSqliteWorkerOpen,
    createReplyOwner: (slot: Slot) => SqliteWorkerReplyOwner,
  ): Promise<Slot> {
    options.assertCurrent?.();
    const available = [...slots].filter(
      (slot) =>
        !slot.failed &&
        !slot.retiring &&
        slot.runtimeGeneration === options.runtimeGeneration &&
        Boolean(slot.transport) === Boolean(options.transportUrl),
    );
    // A retained updater cannot borrow another generation's carrier or evict its actors.
    // One extra slot belongs to the broker, not to each generation requesting one.
    const workers = physicalWorkers;
    const cost = options.transportUrl ? 2 : 1;
    const borrowedGenerationSlot =
      !process.versions.bun &&
      !options.transportUrl &&
      options.runtimeGeneration !== undefined &&
      available.length === 0 &&
      workers >= getMaxWorkers() &&
      ![...slots].some((slot) => slot.borrowedGenerationSlot);
    // Return Bun to shared workers after https://github.com/oven-sh/bun/pull/40005 ships.
    if (
      !borrowedGenerationSlot &&
      workers + cost > (process.versions.bun ? maxStores : getMaxWorkers())
    ) {
      if (!available.length || process.versions.bun) {
        const retiring = [...slots].filter((slot) => Boolean(slot.failed || slot.retiring));
        if (retiring.length > 0) {
          await Promise.race(retiring.map(({ exit }) => exit));
          return acquireSlot(options, createReplyOwner);
        }
        if (process.versions.bun) {
          throw new SqliteWorkerError("SQLite worker store capacity reached", "overloaded");
        }
        if (!available.length) {
          throw new SqliteWorkerError("SQLite worker runtime capacity reached", "overloaded");
        }
      }
      const selected = available.reduce((left, right) =>
        left.actors.size <= right.actors.size ? left : right,
      );
      selected.pendingOpens += 1;
      return selected;
    }
    return createSlot(options, borrowedGenerationSlot, createReplyOwner);
  }

  function createSlot(
    options: PreparedSqliteWorkerOpen,
    borrowedGenerationSlot: boolean,
    createReplyOwner: (slot: Slot) => SqliteWorkerReplyOwner,
  ): Slot {
    if (process.versions.bun && process.platform === "darwin") {
      ensureSqliteLibrarySelected();
    }
    options.assertCurrent?.();
    const cost = options.transportUrl ? 2 : 1;
    const serviceUrl = options.transportUrl;
    if (options.volatile && !serviceUrl) {
      throw new Error("Volatile SQLite opening requires its captured transport entry");
    }
    // Reserve the whole pair before construction; partial/unknown startup retains both units.
    physicalWorkers += cost;
    let transport: Slot["transport"];
    let worker: Slot["worker"];
    try {
      transport = serviceUrl
        ? runOutsideCaller(() =>
            createSqliteWorkerTransport({
              serviceUrl,
              carrierUrl: options.carrierUrl,
              reply: (reply, pumping) => slot.receiveReply(reply, pumping),
              posted(id, actor, attemptedAtNs) {
                const job = slot.current;
                if (job?.request.id === id && job.request.actor === actor) {
                  job.transportPostedAtNs ??= attemptedAtNs;
                }
              },
              failure: (error) => fail(slot, error),
              childExit(code, error) {
                slot.childStopped = true;
                slot.current?.lifecyclePreparation?.service();
                slot.current?.operationAdmission?.admission.service();
                for (const actor of slot.actors) {
                  actor.backendClosed = true;
                  actor.markNativeStopped();
                }
                fail(
                  slot,
                  slot.retirementReason ??
                    new Error(error ?? `SQLite data worker exited with code ${code}`),
                );
              },
            }),
          )
        : undefined;
      worker =
        transport?.worker ??
        runOutsideCaller(() =>
          createCpuTrackedWorker(options.carrierUrl, {
            resourceLimits: { maxOldGenerationSizeMb: SQLITE_WORKER_HEAP_LIMIT_MB },
            env: resolveNodeCompileCacheEnv(),
            execArgv: options.carrierUrl.pathname.endsWith(".ts")
              ? ["--import", import.meta.resolve("tsx/esm")]
              : [],
          }),
        );
    } catch (error) {
      // Native Worker construction failed before returning any worker handle.
      physicalWorkers -= cost;
      throw error;
    }
    const exited = createDeferredCore();
    const slot: Slot = {
      ...(transport ? { transport } : {}),
      runtimeGeneration: options.runtimeGeneration,
      ...(borrowedGenerationSlot ? { borrowedGenerationSlot: true as const } : {}),
      worker,
      receiveReply: (reply, pumping) => receiveSqliteWorkerReply(slot, reply, replyOwner, pumping),
      actors: new Set(),
      queue: [],
      exit: exited.promise,
      exited: false,
      pendingOpens: 1,
    };
    const replyOwner = createReplyOwner(slot);
    slots.add(slot);
    if (!transport) {
      worker.on("message", (reply: SqliteWorkerReply) => slot.receiveReply(reply));
    }
    let serviceFailure: { error: unknown } | undefined;
    worker.on("error", (error) => {
      // The service exit drains its private replies before classifying a lost native result.
      if (transport) {
        serviceFailure ??= { error };
      } else {
        fail(slot, error);
      }
    });
    worker.on("messageerror", (error) => fail(slot, error));
    const onExited = (code: number) => {
      slot.childStopped = true;
      try {
        transport?.nativeExit();
        slot.current?.lifecyclePreparation?.service();
        slot.current?.operationAdmission?.admission.service();
      } catch (error) {
        fail(slot, error);
      } finally {
        slot.exited = true;
        for (const actor of slot.actors) {
          actor.backendClosed = true;
          actor.markNativeStopped();
        }
        fail(
          slot,
          slot.retirementReason ??
            (serviceFailure
              ? serviceFailure.error
              : new Error(`SQLite worker exited with code ${code}`)),
        );
        slots.delete(slot);
        physicalWorkers -= cost;
        exited.resolve();
      }
    };
    worker.once("exit", (code) => {
      slot.childStopped = true;
      // Bun's native exit task joins the service itself after invoking its JS listeners.
      if (process.versions.bun) {
        void Promise.resolve().then(() => onExited(code));
      } else {
        onExited(code);
      }
    });
    worker.unref();
    return slot;
  }

  async function closeGeneration(generation: RuntimeWorkerGeneration): Promise<void> {
    const results = await Promise.allSettled(
      [...actors.values()]
        .filter((actor) => actor.runtimeGeneration === generation)
        .map((actor) => retireActor(actor)),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) {
      throw new AggregateError(errors, "Retained SQLite worker cleanup failed");
    }
    await Promise.all(
      [...slots]
        .filter((slot) => slot.runtimeGeneration === generation)
        .map((slot) => retireEmpty(slot)),
    );
  }

  function releaseActorReference(actor: Actor): void {
    actor.references -= 1;
    if (!actor.references) {
      actor.onReferencesDrained?.();
    }
  }

  async function rejectSlotAdmission(slot: Slot, error: unknown): Promise<never> {
    slot.pendingOpens -= 1;
    try {
      await retireEmpty(slot);
    } catch (cleanupError) {
      throw createSqliteLifecycleAggregateError(
        [error, cleanupError],
        "SQLite slot admission and cleanup failed",
        error,
      );
    }
    throw error;
  }

  function retireActor(identity: object): Promise<void> {
    const actor = [...actors.values()].find((entry) => entry === identity);
    if (!actor) {
      return Promise.resolve();
    }
    if (actor.retirement) {
      return actor.retirement;
    }
    actor.retirementRequested = true;
    const drained = createDeferredCore();
    actor.onReferencesDrained = drained.resolve;
    if (!actor.references) {
      drained.resolve();
    }
    const clients = [...stores.values()].filter((client) => client.actor === actor);
    // Seal every client synchronously, then drain accepted scopes before native close custody.
    actor.retirement = (async () => {
      const results = await Promise.allSettled(clients.map((client) => client.close()));
      await drained.promise;
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (!errors.length) {
        try {
          await closeActor(actor);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        throw new AggregateError(errors, "SQLite actor retirement failed", { cause: errors[0] });
      }
    })().finally(() => {
      actor.retirement = undefined;
      actor.onReferencesDrained = undefined;
    });
    return actor.retirement;
  }

  function closeActor(
    actor: Actor,
    maintenanceScope?: EnqueueOptions["maintenanceScope"],
  ): Promise<void> {
    if (actor.cleanupState === "complete") {
      return Promise.resolve();
    }
    if (actor.closing) {
      return actor.closing;
    }
    actor.cleanupState = "pending";
    actor.closing = (async () => {
      const errors: unknown[] = [];
      if (!actor.backendClosed) {
        try {
          await enqueueClose(actor, maintenanceScope);
          actor.backendClosed = true;
          if (!process.versions.bun) {
            actor.markNativeStopped();
          }
        } catch (error) {
          errors.push(error);
          fail(actor.slot, error instanceof Error ? error : new Error(String(error)));
          await actor.slot.exit;
        }
      }
      try {
        if (
          process.versions.bun ||
          actor.slot.failed ||
          (!actor.slot.pendingOpens && [...actor.slot.actors].every((entry) => entry.backendClosed))
        ) {
          // Bun retains native statements after close; keep pathname ownership until VM exit.
          await retire(actor.slot);
        } else {
          releaseSqliteWorkerActorCoordinators(actor);
        }
      } catch (error) {
        errors.push(error);
      } finally {
        forget(actor);
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "SQLite worker actor cleanup failed", {
          cause: errors[0],
        });
      }
    })().finally(() => {
      actor.closing = undefined;
    });
    return actor.closing;
  }

  function forget(actor: Actor): void {
    if (actor.gatewaySchemaFence || actor.pendingStateLifecycles.size) {
      actor.cleanupState = "pending";
      return;
    }
    if (actors.get(actor.key) === actor) {
      actors.delete(actor.key);
    }
    actor.slot.actors.delete(actor);
    actor.cleanupState = "complete";
  }

  async function retireEmpty(slot: Slot): Promise<void> {
    if (!slot.actors.size && !slot.pendingOpens) {
      await retire(slot);
    }
  }

  function retire(slot: Slot, reason?: Error): Promise<void> {
    // Seal future dispatch without detaching the original job. Native exit drains
    // every terminal posted through join before fail classifies unresolved work.
    slot.retirementReason ??= reason;
    if (reason) {
      slot.current?.operationAdmission?.admission.revoke();
    }
    slot.retiring ??= (async () => {
      const errors: unknown[] = [];
      if (!slot.exited) {
        try {
          await slot.worker.terminate();
        } catch (error) {
          errors.push(error);
        }
      }
      await slot.exit;
      for (const actor of slot.actors) {
        try {
          releaseSqliteWorkerActorCoordinators(actor);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "SQLite worker retirement cleanup failed", {
          cause: errors[0],
        });
      }
    })().finally(() => {
      slot.retiring = undefined;
    });
    return slot.retiring;
  }

  return {
    acquireSlot,
    closeGeneration,
    releaseActorReference,
    rejectSlotAdmission,
    retireActor,
    closeActor,
    forget,
    retireEmpty,
    retire,
  };
}

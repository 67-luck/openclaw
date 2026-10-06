import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import {
  captureSqliteWorkerClosePolicy,
  ensureSqliteLibrarySelected,
} from "./bun-sqlite-library.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import type { RuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import { throwSqliteLifecycleErrors } from "./sqlite-lifecycle-errors.js";
import type {
  SqliteWalCheckpointWorkerCommand,
  SqliteWalCheckpointWorkerObservation,
  SqliteWalCheckpointWorkerOpen,
  SqliteWalCheckpointWorkerOwner,
} from "./sqlite-wal-checkpoint-worker.types.js";
import { SQLITE_WAL_PRESSURE_TICK_MS } from "./sqlite-wal-policy.js";
import { SqliteWorkerWalAdmissionRefusedError } from "./sqlite-worker-wal.types.js";
import { captureRetainedNativeWorkerSource } from "./worker-native-lifecycle.js";
import { createOwnedWorkerTaskPool, WorkerTaskError } from "./worker-task-pool.js";

export type {
  SqliteWalCheckpointWorkerObservation,
  SqliteWalCheckpointWorkerOpen,
  SqliteWalCheckpointWorkerOwner,
} from "./sqlite-wal-checkpoint-worker.types.js";

type Connection = {
  facts: SqliteWalCheckpointWorkerOpen;
  authority: Int32Array;
  closing?: Promise<void>;
};
const log = createSubsystemLogger("infra/sqlite-wal");

/** Unqualified SQLite disposal requires one carrier per database and native exit on close. */
export function createSqliteWalCheckpointWorker(options: {
  runtimeGeneration: RuntimeWorkerGeneration | undefined;
  onObservation: (observation: SqliteWalCheckpointWorkerObservation) => void;
  /** Terminal carrier loss; the registry must re-admit live physical leases before reuse. */
  onFailure: (error: unknown) => void;
}) {
  const requested = resolveRuntimeProcessEntrypointUrl("sqliteWalCheckpoint");
  const nativeSource = captureRetainedNativeWorkerSource({
    runtimeGeneration: options.runtimeGeneration,
  });
  const explicitClose = captureSqliteWorkerClosePolicy();
  const connections = new Map<string, Connection>();
  const pending = new Set<Promise<SqliteWalCheckpointWorkerObservation[]>>();
  let sealed = false;
  let stopping: Promise<void> | undefined;
  let sweep: Promise<void> | undefined;
  let failure: Error | undefined;
  const fail = (error: unknown) => {
    if (failure) {
      return;
    }
    failure = toErrorObject(error, "SQLite checkpoint worker failed");
    for (const connection of connections.values()) {
      Atomics.store(connection.authority, 0, 0);
    }
    clearInterval(timer);
    log.warn("SQLite checkpoint worker failed", { error: String(error) });
    try {
      options.onFailure(error);
    } catch (observerError) {
      log.warn("SQLite checkpoint failure observer failed", { error: String(observerError) });
    }
  };
  const pool = createOwnedWorkerTaskPool<
    SqliteWalCheckpointWorkerCommand,
    SqliteWalCheckpointWorkerObservation[]
  >(
    {
      workerUrl: options.runtimeGeneration?.resolve(requested) ?? requested,
      workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 512 } },
      maxWorkers: 1,
      idleTimeoutMs: 0,
      restartOnError: false,
      prepareWorker() {
        ensureSqliteLibrarySelected();
        return { options: {} };
      },
    },
    { retainedTransport: true, nativeSource },
  );
  const run = (command: SqliteWalCheckpointWorkerCommand) => {
    if (sealed || failure) {
      return Promise.reject(failure ?? new Error("SQLite checkpoint worker is closing"));
    }
    const operation = pool.run(command, {});
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation.then(
      (observations) => {
        const current: SqliteWalCheckpointWorkerObservation[] = [];
        for (const observation of observations) {
          const connection = connections.get(observation.identity);
          if (
            connection?.facts.revision !== observation.revision ||
            Atomics.load(connection.authority, 0) !== 1 ||
            !connection.facts.leases.some((buffer) => Atomics.load(new Int32Array(buffer), 0) === 1)
          ) {
            continue;
          }
          current.push(observation);
          if (observation.checkpoint.health.state === "error") {
            log.warn("SQLite checkpoint failed", { error: observation.checkpoint.health.error });
          }
          try {
            options.onObservation(observation);
          } catch (error) {
            log.warn("SQLite checkpoint observation failed", { error: String(error) });
          }
        }
        return current;
      },
      (error: unknown) => {
        if (
          !(command.type === "open" && error instanceof WorkerTaskError && error.code === "failed")
        ) {
          fail(error);
        }
        throw error;
      },
    );
  };
  const timer = runInDetachedAsyncContext(() =>
    setInterval(() => {
      if (!sealed && !failure && !sweep && connections.size > 0) {
        sweep = run({ type: "sweep" })
          .then(
            () => {},
            () => {},
          )
          .finally(() => {
            sweep = undefined;
          });
      }
    }, SQLITE_WAL_PRESSURE_TICK_MS),
  );
  timer.unref();
  const selected = (owner: SqliteWalCheckpointWorkerOwner) => {
    const connection = connections.get(owner.identity);
    if (connection && connection.facts.revision !== owner.revision) {
      throw new Error("SQLite checkpoint owner revision changed");
    }
    return connection;
  };
  const stop = (): Promise<void> => {
    sealed = true;
    clearInterval(timer);
    for (const connection of connections.values()) {
      Atomics.store(connection.authority, 0, 0);
    }
    return (stopping ??= (async () => {
      await Promise.allSettled(pending);
      const errors: unknown[] = [];
      await pool.closeResources().catch((error: unknown) => errors.push(error));
      await pool.close().catch((error: unknown) => errors.push(error));
      throwSqliteLifecycleErrors(errors, "SQLite checkpoint worker cleanup failed");
      connections.clear();
    })().catch((error: unknown) => {
      stopping = undefined;
      throw error;
    }));
  };
  const close = (owner: SqliteWalCheckpointWorkerOwner): Promise<void> => {
    if (sealed) {
      return stop();
    }
    const connection = selected(owner);
    if (!connection) {
      return Promise.resolve();
    }
    Atomics.store(connection.authority, 0, 0);
    return (connection.closing ??= (async () => {
      await Promise.allSettled(pending);
      await pool.closeResources(
        JSON.stringify([connection.facts.identity, connection.facts.revision]),
      );
      if (!explicitClose) {
        await pool.rotate();
      }
      connections.delete(connection.facts.identity);
    })().catch((error: unknown) => {
      fail(error);
      connection.closing = undefined;
      throw error;
    }));
  };
  const carrier = {
    async open(this: void, facts: SqliteWalCheckpointWorkerOpen): Promise<void> {
      if (sealed || failure) {
        throw failure ?? new Error("SQLite checkpoint worker is closing");
      }
      if (selected(facts)) {
        throw new Error("SQLite checkpoint connection already has an owner");
      }
      if (!explicitClose && connections.size > 0) {
        throw new Error("This SQLite runtime requires one checkpoint carrier per database");
      }
      const connection: Connection = {
        facts: { ...facts },
        authority: new Int32Array(facts.authority),
      };
      connections.set(facts.identity, connection);
      try {
        await run({ type: "open", input: connection.facts });
        if (Atomics.load(connection.authority, 0) !== 1) {
          throw new SqliteWorkerWalAdmissionRefusedError(
            "SQLite checkpoint authority was revoked during admission",
          );
        }
      } catch (error) {
        try {
          await close(connection.facts);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "SQLite checkpoint admission and cleanup failed",
            { cause: cleanupError },
          );
        }
        throw error;
      }
    },
    async checkpoint(owner: SqliteWalCheckpointWorkerOwner) {
      const connection = selected(owner);
      if (!connection || connection.closing) {
        return undefined;
      }
      const observations = await run({ type: "checkpoint", owner: connection.facts });
      return Atomics.load(connection.authority, 0) === 1 ? observations[0]?.checkpoint : undefined;
    },
    async setLeases(owner: SqliteWalCheckpointWorkerOwner, leases: SharedArrayBuffer[]) {
      const connection = selected(owner);
      if (!connection || connection.closing) {
        return;
      }
      connection.facts.leases = [...leases];
      await run({ type: "leases", owner: connection.facts, leases: connection.facts.leases });
    },
    close,
    stop,
  };
  return carrier;
}

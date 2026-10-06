import fs from "node:fs";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import { setSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import { throwSqliteLifecycleErrors } from "./sqlite-lifecycle-errors.js";
import type {
  SqliteWalCheckpointWorkerCommand,
  SqliteWalCheckpointWorkerObservation,
  SqliteWalCheckpointWorkerOpen,
  SqliteWalCheckpointWorkerOwner,
} from "./sqlite-wal-checkpoint-worker.types.js";
import { createSqliteWalCheckpoint } from "./sqlite-wal-checkpoint.js";
import {
  SQLITE_WAL_RECYCLING_BYTES,
  SQLITE_WAL_RESTART_BYTES,
  SQLITE_WAL_IDLE_CHECKPOINT_MS,
} from "./sqlite-wal-policy.js";
import { assertExistingDatabaseIdentity } from "./sqlite-worker-identity.js";
import { serveOwnedWorkerTasks } from "./worker-task-server.js";
type Connection = {
  facts: SqliteWalCheckpointWorkerOpen;
  authority: Int32Array;
  leases: Int32Array[];
  database: DatabaseSync;
  admitted: boolean;
  checkpoint: ReturnType<typeof createSqliteWalCheckpoint>;
  lastCheckpointAt: number;
  lastObservedWalBytes: number;
};
const connections = new Map<string, Connection>();

function isLive(connection: Connection): boolean {
  return (
    Atomics.load(connection.authority, 0) === 1 &&
    connection.leases.some((lease) => Atomics.load(lease, 0) === 1)
  );
}

function current(owner: SqliteWalCheckpointWorkerOwner): Connection | undefined {
  const connection = connections.get(owner.identity);
  if (connection && connection.facts.revision !== owner.revision) {
    throw new Error("SQLite checkpoint owner revision changed");
  }
  return connection;
}

function checkpoint(
  connection: Connection,
  force: boolean,
): SqliteWalCheckpointWorkerObservation | undefined {
  if (!connection.admitted || !isLive(connection)) {
    return undefined;
  }
  try {
    const walBytes =
      fs.statSync(`${connection.facts.databasePath}-wal`, { throwIfNoEntry: false })?.size ?? 0;
    // Allocated WAL bytes can stay high after backfill; unchanged blocked readers still retry.
    const pressure =
      walBytes > SQLITE_WAL_RECYCLING_BYTES &&
      (walBytes > connection.lastObservedWalBytes ||
        connection.checkpoint.health?.state !== "complete");
    connection.lastObservedWalBytes = walBytes;
    if (
      !force &&
      performance.now() - connection.lastCheckpointAt < SQLITE_WAL_IDLE_CHECKPOINT_MS &&
      !pressure
    ) {
      return undefined;
    }
    connection.lastCheckpointAt = performance.now();
    if (!isLive(connection)) {
      return undefined;
    }
    const complete = connection.checkpoint.checkpoint("PASSIVE", { quiet: true });
    if (
      complete &&
      (connection.checkpoint.health?.walBytes ?? 0) > SQLITE_WAL_RESTART_BYTES &&
      isLive(connection)
    ) {
      // PASSIVE proves backfill, not exclusive reader access; a racing reader refuses RESTART.
      connection.checkpoint.checkpoint("RESTART", { quiet: true });
    }
  } catch (error) {
    connection.checkpoint.recordError(error);
  }
  const snapshot = connection.checkpoint.snapshot;
  return snapshot
    ? {
        identity: connection.facts.identity,
        revision: connection.facts.revision,
        checkpoint: snapshot,
      }
    : undefined;
}

function open(facts: SqliteWalCheckpointWorkerOpen): void {
  const authority = new Int32Array(facts.authority);
  const leases = facts.leases.map((buffer) => new Int32Array(buffer));
  if (connections.has(facts.identity)) {
    throw new Error("SQLite checkpoint connection is already admitted");
  }
  assertExistingDatabaseIdentity(facts.databasePath, facts.identity, facts.birthtime);
  if (Atomics.load(authority, 0) !== 1 || !leases.some((lease) => Atomics.load(lease, 0) === 1)) {
    throw new Error("SQLite checkpoint authority was revoked before opening");
  }
  const database = openNodeSqliteDatabase(resolveExistingSqliteFileUri(facts.databasePath));
  // Failed admission retains native custody until the pool's resource cleanup or exit.
  const connection: Connection = {
    facts,
    authority,
    leases,
    database,
    admitted: false,
    checkpoint: createSqliteWalCheckpoint(database, facts, SQLITE_WAL_RECYCLING_BYTES),
    lastCheckpointAt: performance.now(),
    lastObservedWalBytes: 0,
  };
  connections.set(facts.identity, connection);
  assertExistingDatabaseIdentity(facts.databasePath, facts.identity, facts.birthtime);
  if (!isLive(connection)) {
    throw new Error("SQLite checkpoint authority was revoked during admission");
  }
  // First WAL readers can race native recovery while the writer finishes admission.
  setSqliteBusyTimeout(database, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
  // sqlite-allow-raw -- Admit the existing journal once without changing its mode or schema.
  if (database.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") {
    throw new Error("SQLite checkpoint requires an admitted WAL database");
  }
  if (!isLive(connection)) {
    throw new Error("SQLite checkpoint authority was revoked during configuration");
  }
  // sqlite-allow-raw -- Connection-local checkpoint policy, including Darwin's durability setting.
  database.exec(
    "PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=NORMAL; PRAGMA trusted_schema=OFF;" +
      (process.platform === "darwin" ? " PRAGMA checkpoint_fullfsync=1;" : ""),
  );
  setSqliteBusyTimeout(database, 0);
  connection.admitted = true;
}

serveOwnedWorkerTasks<SqliteWalCheckpointWorkerObservation[]>(
  (input) => {
    // SAFETY: The paired internal pool supplies this command through its typed transport.
    const command = input as SqliteWalCheckpointWorkerCommand;
    if (command.type === "open") {
      open(command.input);
      return [];
    }
    if (command.type === "leases") {
      const connection = current(command.owner);
      if (connection) {
        connection.leases = command.leases.map((buffer) => new Int32Array(buffer));
      }
      return [];
    }
    const selected =
      command.type === "checkpoint" ? [current(command.owner)] : connections.values();
    const observations: SqliteWalCheckpointWorkerObservation[] = [];
    for (const connection of selected) {
      const result = connection && checkpoint(connection, command.type === "checkpoint");
      if (result) {
        observations.push(result);
      }
    }
    return observations;
  },
  {
    closeResource(key) {
      const errors: unknown[] = [];
      for (const connection of connections.values()) {
        if (
          key !== undefined &&
          key !== JSON.stringify([connection.facts.identity, connection.facts.revision])
        ) {
          continue;
        }
        Atomics.store(connection.authority, 0, 0);
        try {
          connection.database.close();
          connections.delete(connection.facts.identity);
        } catch (error) {
          errors.push(error);
        }
      }
      throwSqliteLifecycleErrors(errors, "SQLite checkpoint connections failed to close");
    },
  },
);

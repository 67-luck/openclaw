import type { DatabaseSync } from "node:sqlite";
import { runSqliteReadOnlyWorkerSync } from "./sqlite-readonly-worker.js";
import type {
  UpdateDatabaseMigrationCommit,
  UpdateMigrationObserver,
} from "./update-database-migration.js";

/** Source descriptors close in a child while the real writer retains its native connection. */
export function beginUpdateDatabaseMigrationObservation(
  database: DatabaseSync,
  migrationId: string,
  runId: string,
  record: (commit: UpdateDatabaseMigrationCommit) => void,
): () => void {
  const pathname = database.location();
  if (!pathname || !database.isTransaction) {
    throw new Error("Update migration attribution requires a file-backed write transaction");
  }
  const readDataVersion = () => {
    const value = database.prepare("PRAGMA data_version").get()?.data_version;
    if (typeof value !== "number") {
      throw new Error("SQLite did not return a numeric PRAGMA data_version");
    }
    return value;
  };
  const dataVersion = readDataVersion();
  const before = runSqliteReadOnlyWorkerSync(pathname, undefined, "database-observation");
  return () => {
    const after = runSqliteReadOnlyWorkerSync(pathname, undefined, "database-observation");
    record({
      runId,
      path: pathname,
      migrationId,
      fromContentVersion: before.contentVersion,
      toContentVersion: after.contentVersion,
      foreignWrite: readDataVersion() !== dataVersion,
    });
  };
}

/** Missing optional telemetry leaves a gap; it never grants restoration or changes the write. */
export function createUpdateDatabaseMigrationObserver(
  runId: string,
  record: (commit: UpdateDatabaseMigrationCommit) => void,
): UpdateMigrationObserver {
  return {
    runId,
    record,
    begin(database, migrationId) {
      let committed: () => void;
      try {
        committed = beginUpdateDatabaseMigrationObservation(database, migrationId, runId, record);
      } catch {
        return undefined;
      }
      return () => {
        try {
          committed();
        } catch {
          // Final chain validation refuses any unobserved committed change.
        }
      };
    },
  };
}

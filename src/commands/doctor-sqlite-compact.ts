/** Shared doctor-only SQLite compaction mechanics. */
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { readFiniteSqliteNumber } from "../infra/sqlite-number.js";
import { SqliteWalCheckpointBusyError, truncateSqliteWal } from "../infra/sqlite-wal-checkpoint.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db.js";

export type DoctorSqliteCompactSnapshot = {
  autoVacuum: number;
  dbSizeBytes: number;
  freelistPages: number;
  pageSizeBytes: number;
  walSizeBytes: number;
};

type DoctorSqliteCompactResult = {
  after: DoctorSqliteCompactSnapshot;
  before: DoctorSqliteCompactSnapshot;
  integrityCheck: "ok";
  reclaimedBytes: number;
};

type DoctorSqliteCompactOptions = {
  afterSuccess?: () => void;
  busyTimeoutMs?: number;
  operation?: "import-finalize";
  requireExisting?: boolean;
  sqlitePath: string;
  validateBeforeMutation?: (database: DatabaseSync) => void;
};

/** A known pre-mutation condition deferred compaction and the connection has closed. */
export class DoctorSqliteCompactionDeferredError extends Error {}

function assertTranscriptMigrationAllowsVacuum(database: DatabaseSync, pathname: string): void {
  let phase: unknown;
  try {
    const kysely = getNodeSqliteKysely<{
      sqlite_schema: { name: string; type: string };
      transcript_storage_migration: { id: number; phase: unknown };
    }>(database);
    // The caller already admitted canonical schema; this reads only the durable conversion state.
    const storage = executeSqliteQuerySync(
      database,
      kysely
        .selectFrom("sqlite_schema")
        .select("name")
        .where("type", "=", "table")
        .where("name", "in", [
          "transcript_storage_sessions",
          "transcript_storage_migration",
          "transcript_event_identity_rows",
          "session_transcript_active_rows",
        ])
        .limit(1),
    ).rows;
    if (storage.length === 0) {
      return;
    }
    const rows = executeSqliteQuerySync(
      database,
      kysely.selectFrom("transcript_storage_migration").select(["id", "phase"]).limit(2),
    ).rows;
    phase = rows[0]?.phase;
    if (
      rows.length !== 1 ||
      rows[0]?.id !== 1 ||
      typeof phase !== "string" ||
      !["identities", "active", "publish", "cleanup", "complete"].includes(phase)
    ) {
      throw new Error("Missing or invalid transcript metadata migration progress");
    }
  } catch (cause) {
    throw new DoctorMaintenanceRefusalError(
      `Cannot verify transcript metadata migration state for ${pathname}. Preserve this database and run openclaw doctor --fix before retrying compaction.`,
      { kind: "data-at-risk", reason: "incomplete-migration" },
      { cause },
    );
  }
  if (phase !== "complete") {
    throw new DoctorSqliteCompactionDeferredError(
      `Transcript metadata migration is pending (${phase}) for ${pathname}. Keep writers stopped, run openclaw doctor --fix with this build to finish migration, then retry compaction; full VACUUM would invalidate its rowid cursor.`,
    );
  }
}

/**
 * Compact one SQLite file during an explicit offline doctor operation.
 *
 * Validation runs before the first checkpoint because checkpointing mutates
 * the database files. A busy checkpoint is a hard failure, never partial
 * success, so VACUUM cannot race an active reader or writer.
 */
export function compactDoctorSqliteFile(
  options: DoctorSqliteCompactOptions,
): DoctorSqliteCompactResult {
  const database = openNodeSqliteDatabase(
    options.requireExisting ? resolveExistingSqliteFileUri(options.sqlitePath) : options.sqlitePath,
  );
  let operationError: unknown;
  let initialCheckpointBusy = false;
  let result: DoctorSqliteCompactResult | undefined;
  try {
    database.exec(
      `PRAGMA busy_timeout = ${options.busyTimeoutMs ?? OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`,
    );
    database.exec("PRAGMA trusted_schema = OFF;");
    options.validateBeforeMutation?.(database);
    const before = readCompactSnapshot(database, options.sqlitePath);
    const fullRewrite = options.operation !== "import-finalize" || before.autoVacuum === 0;
    if (fullRewrite) {
      assertTranscriptMigrationAllowsVacuum(database, options.sqlitePath);
    }
    let { integrityCheck } = assertSqliteIntegrity(database, options.sqlitePath);
    const alreadyCompact =
      options.operation === "import-finalize" &&
      before.autoVacuum === 2 &&
      before.freelistPages === 0 &&
      before.walSizeBytes === 0;
    // A verified no-op needs neither a file mutation nor a second full-file scan.
    // Explicit compaction still repacks partially filled pages.
    if (!alreadyCompact) {
      try {
        truncateSqliteWal(database, options.sqlitePath);
      } catch (error) {
        initialCheckpointBusy = error instanceof SqliteWalCheckpointBusyError;
        throw error;
      }
      database.exec("PRAGMA auto_vacuum = INCREMENTAL;");
      // NONE databases need a full rewrite to add pointer maps. Existing auto-vacuum
      // stores can release free pages without repacking; explicit compact still repacks.
      database.exec(fullRewrite ? "VACUUM;" : "PRAGMA incremental_vacuum;");
      truncateSqliteWal(database, options.sqlitePath);
      ({ integrityCheck } = assertSqliteIntegrity(database, options.sqlitePath));
    }
    const after = readCompactSnapshot(database, options.sqlitePath);
    const beforeBytes = before.dbSizeBytes + before.walSizeBytes;
    const afterBytes = after.dbSizeBytes + after.walSizeBytes;
    result = {
      after,
      before,
      integrityCheck,
      reclaimedBytes: Math.max(0, beforeBytes - afterBytes),
    };
  } catch (error) {
    operationError = error;
  }
  try {
    database.close();
  } catch (error) {
    initialCheckpointBusy = false;
    operationError =
      operationError !== undefined
        ? new AggregateError([operationError, error], "SQLite compaction and close failed.")
        : error;
  }
  if (operationError === undefined && result) {
    try {
      options.afterSuccess?.();
    } catch (error) {
      operationError ??= error;
    }
  }
  if (operationError !== undefined) {
    if (initialCheckpointBusy && operationError instanceof Error) {
      throw new DoctorSqliteCompactionDeferredError(operationError.message, {
        cause: operationError,
      });
    }
    throw operationError instanceof Error
      ? operationError
      : new Error("SQLite compaction failed with a non-Error value.");
  }
  if (!result) {
    throw new Error(`SQLite compaction produced no result for ${options.sqlitePath}.`);
  }
  return result;
}

function readCompactSnapshot(
  database: DatabaseSync,
  sqlitePath: string,
): DoctorSqliteCompactSnapshot {
  return {
    autoVacuum: readPragmaNumber(database, "auto_vacuum"),
    dbSizeBytes: fileSize(sqlitePath),
    freelistPages: readPragmaNumber(database, "freelist_count"),
    pageSizeBytes: readPragmaNumber(database, "page_size"),
    walSizeBytes: fileSize(`${sqlitePath}-wal`),
  };
}

function readPragmaNumber(
  database: DatabaseSync,
  pragmaName: "auto_vacuum" | "freelist_count" | "page_size",
): number {
  const row = database.prepare(`PRAGMA ${pragmaName};`).get();
  const value = readFiniteSqliteNumber(
    row?.[pragmaName] ?? (row ? Object.values(row)[0] : undefined),
  );
  if (value === undefined) {
    throw new Error(`SQLite PRAGMA ${pragmaName} returned an invalid result.`);
  }
  return value;
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

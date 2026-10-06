import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import * as sqliteIntegrity from "../infra/sqlite-integrity.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import * as walCheckpoint from "../infra/sqlite-wal-checkpoint.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import {
  initializeTranscriptStorageMigration,
  withoutTranscriptStorageSchema,
} from "../state/openclaw-agent-transcript-storage-schema.js";
import {
  compactDoctorSqliteFile,
  DoctorSqliteCompactionDeferredError,
} from "./doctor-sqlite-compact.js";
import { migrateDoctorTranscriptStorage } from "./doctor-transcript-storage.js";
import { runDoctorTranscriptStorageBatch } from "./doctor-transcript-storage.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function createCompactDatabase(): string {
  const sqlitePath = path.join(tempDirs.make("doctor-compact-noop-"), "store.sqlite");
  const database = openNodeSqliteDatabase(sqlitePath);
  try {
    database.exec(`
      PRAGMA auto_vacuum = INCREMENTAL;
      PRAGMA journal_mode = WAL;
      CREATE TABLE payload (id INTEGER PRIMARY KEY, body TEXT);
      INSERT INTO payload VALUES (1, 'preserved');
    `);
  } finally {
    database.close();
  }
  return sqlitePath;
}

async function createPendingTranscriptMigration(autoVacuum: 0 | 2): Promise<string> {
  const sqlitePath = path.join(tempDirs.make("doctor-compact-migration-"), "agent.sqlite");
  using database = openNodeSqliteDatabase(sqlitePath);
  database.exec(`PRAGMA auto_vacuum = ${autoVacuum}`);
  database.exec(withoutTranscriptStorageSchema(OPENCLAW_AGENT_SCHEMA_SQL));
  database.exec(`INSERT INTO schema_meta(meta_key, role, schema_version, agent_id, created_at, updated_at)
      VALUES ('primary', 'agent', 25, 'main', 1, 1);
    INSERT INTO session_nodes(session_key, current_session_id, entry_json, updated_at)
      VALUES ('agent:main:fixture', 'fixture', '{"sessionId":"fixture","updatedAt":1}', 1);
    INSERT INTO session_windows(session_id, session_key, created_at, updated_at)
      VALUES ('fixture', 'agent:main:fixture', 1, 1);
    WITH RECURSIVE positions(seq) AS (SELECT 1 UNION ALL SELECT seq + 1 FROM positions WHERE seq < 257)
    INSERT INTO transcript_events(session_id, seq, event_json, created_at)
      SELECT 'fixture', seq, '{"type":"custom","id":"event-' || seq || '"}', 1 FROM positions;
    INSERT INTO transcript_event_identities(rowid, session_id, event_id, seq, created_at)
      SELECT seq * 2, session_id, 'event-' || seq, seq, 1 FROM transcript_events;
    INSERT INTO session_transcript_active_events(rowid, session_id, active_position, event_seq)
      SELECT seq * 2, session_id, seq - 1, seq FROM transcript_events;
    PRAGMA user_version = 25;`);
  runSqliteImmediateTransactionSync(database, () =>
    initializeTranscriptStorageMigration(database, OPENCLAW_AGENT_SCHEMA_SQL),
  );
  expect(await runDoctorTranscriptStorageBatch(database)).toMatchObject({
    phase: "identities",
    copiedRows: 256,
  });
  return sqlitePath;
}

function migrationRows(sqlitePath: string) {
  using database = openNodeSqliteDatabase(sqlitePath, { readOnly: true });
  return {
    progress: database.prepare("SELECT * FROM transcript_storage_migration").get(),
    identities: database
      .prepare("SELECT rowid, event_id, seq FROM transcript_event_identities ORDER BY rowid")
      .all(),
    active: database
      .prepare("SELECT rowid, event_seq FROM session_transcript_active_events ORDER BY rowid")
      .all(),
  };
}

describe("transcript migration compaction admission", () => {
  it.each([
    { autoVacuum: 2, operation: undefined },
    { autoVacuum: 0, operation: "import-finalize" },
  ] as const)(
    "defers full rewrite until conversion completes (auto-vacuum=$autoVacuum)",
    async ({ autoVacuum, operation }) => {
      const sqlitePath = await createPendingTranscriptMigration(autoVacuum);
      const before = migrationRows(sqlitePath);
      const beforeBytes = fs.readFileSync(sqlitePath);
      const integrity = vi.spyOn(sqliteIntegrity, "assertSqliteIntegrity");
      let failure: unknown;
      try {
        compactDoctorSqliteFile({ sqlitePath, operation });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DoctorSqliteCompactionDeferredError);
      expect(failure).toMatchObject({
        message: expect.stringContaining(
          "run openclaw doctor --fix with this build to finish migration",
        ),
      });
      expect(integrity).not.toHaveBeenCalled();
      expect(migrationRows(sqlitePath)).toEqual(before);
      expect(fs.readFileSync(sqlitePath)).toEqual(beforeBytes);
      {
        using database = openNodeSqliteDatabase(sqlitePath);
        await migrateDoctorTranscriptStorage(database, {
          signal: new AbortController().signal,
          assertCurrent() {},
        });
        expect(
          database.prepare("SELECT phase FROM transcript_storage_migration").get()?.phase,
        ).toBe("complete");
      }
      expect(compactDoctorSqliteFile({ sqlitePath, operation })).toMatchObject({
        integrityCheck: "ok",
        after: { autoVacuum: 2 },
      });
      using database = openNodeSqliteDatabase(sqlitePath, { readOnly: true });
      expect(
        database.prepare("SELECT count(*) AS rows FROM transcript_event_identity_rows").get(),
      ).toEqual({ rows: 257 });
      expect(
        database.prepare("SELECT count(*) AS rows FROM session_transcript_active_rows").get(),
      ).toEqual({ rows: 257 });
    },
  );

  it.each([false, true])(
    "allows pending conversion during import finalization (free pages=%s)",
    async (freePages) => {
      const sqlitePath = await createPendingTranscriptMigration(2);
      if (freePages) {
        using database = openNodeSqliteDatabase(sqlitePath);
        database.exec(
          "CREATE TABLE discarded(data BLOB); INSERT INTO discarded VALUES(zeroblob(65536)); DELETE FROM discarded",
        );
      }
      const before = migrationRows(sqlitePath);
      const result = compactDoctorSqliteFile({ sqlitePath, operation: "import-finalize" });
      expect(result.before.freelistPages > 0).toBe(freePages);
      expect(result).toMatchObject({
        integrityCheck: "ok",
        after: { autoVacuum: 2, freelistPages: 0 },
      });
      expect(migrationRows(sqlitePath)).toEqual(before);
    },
  );

  it.each(["missing table", "missing row", "invalid phase"])(
    "refuses an unverifiable migration ledger: %s",
    async (defect) => {
      const sqlitePath = await createPendingTranscriptMigration(2);
      {
        using database = openNodeSqliteDatabase(sqlitePath);
        database.exec(
          defect === "missing table"
            ? "DROP TABLE transcript_storage_migration"
            : defect === "missing row"
              ? "DELETE FROM transcript_storage_migration"
              : "PRAGMA ignore_check_constraints = ON; UPDATE transcript_storage_migration SET phase = 'invalid'; PRAGMA ignore_check_constraints = OFF",
        );
      }
      const before = fs.readFileSync(sqlitePath);
      expect(() => compactDoctorSqliteFile({ sqlitePath })).toThrow(DoctorMaintenanceRefusalError);
      expect(fs.readFileSync(sqlitePath)).toEqual(before);
    },
  );
});

describe("import-finalize compaction", () => {
  it.each(["missing", "compact", "foreign-key-corrupt"] as const)(
    "validates %s input before completing compaction",
    (state) => {
      if (state === "missing") {
        const sqlitePath = path.join(tempDirs.make("doctor-compact-missing-"), "missing.sqlite");
        expect(() => compactDoctorSqliteFile({ sqlitePath, requireExisting: true })).toThrow();
        expect(fs.existsSync(sqlitePath)).toBe(false);
        return;
      }
      const sqlitePath = createCompactDatabase();
      const afterSuccess = vi.fn();
      if (state === "foreign-key-corrupt") {
        const database = openNodeSqliteDatabase(sqlitePath);
        try {
          database.exec(`PRAGMA foreign_keys = OFF;
            CREATE TABLE child (parent_id INTEGER REFERENCES payload(id));
            INSERT INTO child VALUES (99);`);
        } finally {
          database.close();
        }
        expect(() =>
          compactDoctorSqliteFile({ sqlitePath, operation: "import-finalize", afterSuccess }),
        ).toThrow(/foreign_key_check failed/);
        expect(afterSuccess).not.toHaveBeenCalled();
        return;
      }
      const before = fs.readFileSync(sqlitePath);
      const integrity = vi.spyOn(sqliteIntegrity, "assertSqliteIntegrity");
      const result = compactDoctorSqliteFile({
        sqlitePath,
        operation: "import-finalize",
        afterSuccess,
      });
      expect(result.before).toMatchObject({ autoVacuum: 2, freelistPages: 0, walSizeBytes: 0 });
      expect(result.after).toEqual(result.before);
      expect(result.integrityCheck).toBe("ok");
      expect(result.reclaimedBytes).toBe(0);
      // Each call scans the entire file: a no-op must not double that I/O budget.
      expect(integrity).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(sqlitePath)).toEqual(before);
      expect(afterSuccess).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])("rejects an initial busy checkpoint (close fails=%s)", (closeFails) => {
    const sqlitePath = createCompactDatabase();
    const reader = openNodeSqliteDatabase(sqlitePath);
    const writer = openNodeSqliteDatabase(sqlitePath);
    const closeFailure = new Error("native close failure");
    if (closeFails) {
      const openDatabase = nodeSqlite.openNodeSqliteDatabase;
      vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
        const database = openDatabase(...args);
        const close = database.close.bind(database);
        database.close = () => {
          close();
          throw closeFailure;
        };
        return database;
      });
    }
    try {
      reader.exec("BEGIN; SELECT * FROM payload;");
      writer.exec("INSERT INTO payload VALUES (2, 'pending checkpoint');");
      expect(writer.prepare("PRAGMA freelist_count").get()?.freelist_count).toBe(0);
      expect(fs.statSync(`${sqlitePath}-wal`).size).toBeGreaterThan(0);
      if (!closeFails) {
        expect(() =>
          compactDoctorSqliteFile({ sqlitePath, operation: "import-finalize", busyTimeoutMs: 0 }),
        ).toThrow(/checkpoint remained busy/);
        return;
      }
      let failure: unknown;
      try {
        compactDoctorSqliteFile({ sqlitePath, busyTimeoutMs: 0 });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).not.toBeInstanceOf(DoctorSqliteCompactionDeferredError);
      expect(failure instanceof AggregateError && failure.errors).toEqual([
        expect.any(walCheckpoint.SqliteWalCheckpointBusyError),
        closeFailure,
      ]);
    } finally {
      reader.exec("ROLLBACK;");
      reader.close();
      writer.close();
    }
  });

  it("does not defer a real busy checkpoint after compaction", () => {
    const sqlitePath = createCompactDatabase();
    const truncate = walCheckpoint.truncateSqliteWal;
    let checkpointCalls = 0;
    let reader: ReturnType<typeof openNodeSqliteDatabase> | undefined;
    vi.spyOn(walCheckpoint, "truncateSqliteWal").mockImplementation((database, pathname) => {
      if (++checkpointCalls === 2) {
        reader = openNodeSqliteDatabase(pathname, { readOnly: true });
        reader.exec("BEGIN; SELECT * FROM payload;");
      }
      return truncate(database, pathname);
    });
    try {
      expect(() => compactDoctorSqliteFile({ sqlitePath, busyTimeoutMs: 0 })).toThrow(
        walCheckpoint.SqliteWalCheckpointBusyError,
      );
      expect(checkpointCalls).toBe(2);
    } finally {
      reader?.exec("ROLLBACK;");
      reader?.close();
    }
  });
});

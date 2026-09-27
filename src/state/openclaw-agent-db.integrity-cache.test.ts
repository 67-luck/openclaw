import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import * as sqlite from "../infra/node-sqlite.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import * as integrity from "../infra/sqlite-integrity.js";
import { closeCachedOpenClawAgentDatabase } from "./openclaw-agent-db-lifecycle.js";
import * as validationCache from "./openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAdmission,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";
import * as verifier from "./openclaw-database-verify.js";
import {
  clearOpenClawAgentIntegrityVerification,
  readOpenClawAgentIntegrityVerification,
} from "./openclaw-quarantine-store.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";
import { createUnsafeIndexDrift } from "./sqlite-index-drift.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it("retains admission after the last writer closes with a reader-pinned WAL", async () => {
  const options = {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-pinned-") },
  };
  const pathname = resolveOpenClawAgentSqlitePath(options);
  let checks = 0;
  const open = sqlite.openNodeSqliteDatabase;
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    if (args[0] === pathname) {
      const prepare = database.prepare.bind(database);
      vi.spyOn(database, "prepare").mockImplementation((sql) => {
        if (/^PRAGMA integrity_check;?$/.test(sql)) {
          checks += 1;
        }
        return prepare(sql);
      });
    }
    return database;
  });
  const worker = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
  const quickCheck = vi.spyOn(verifier, "requestOpenClawAgentDatabaseQuickCheck");
  const write = (updatedAt: number) =>
    runOpenClawAgentWriteTransaction(
      (database) =>
        writeSessionEntry(database, "agent:main:integrity", { sessionId: "retained", updatedAt }),
      options,
    );
  write(1);
  const reader = open(pathname, { readOnly: true });
  try {
    reader.exec("BEGIN");
    reader.prepare("SELECT updated_at FROM session_nodes").all();
    for (let iteration = 2; iteration <= 9; iteration += 1) {
      write(iteration);
      const database = openOpenClawAgentDatabase(options);
      closeCachedOpenClawAgentDatabase(database, { eviction: true });
      expect(database.walMaintenance.health?.state).toBe("blocked");
      expect(database.db.isOpen).toBe(false);
      await withOpenClawAgentDatabaseAsync(options, (reopened) => {
        expect(reopened.db.prepare("SELECT updated_at FROM session_nodes").get()).toEqual({
          updated_at: iteration,
        });
      });
    }
    expect(checks + worker.mock.calls.length).toBe(1);
    expect(quickCheck).not.toHaveBeenCalled();
  } finally {
    reader.close();
  }
});

it.each(["sync", "async", "admitted"] as const)(
  "checks once across writes and physical %s reopens, including after lifecycle reset",
  async (mode) => {
    const options = {
      agentId: "integrity-cache",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-cache-") },
    };
    const pathname = resolveOpenClawAgentSqlitePath(options);
    const checks: string[] = [];
    const open = sqlite.openNodeSqliteDatabase;
    vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
      const database = open(...args);
      if (database.location() === pathname) {
        const prepare = database.prepare.bind(database);
        vi.spyOn(database, "prepare").mockImplementation((sql) => {
          if (/^PRAGMA (integrity_check|foreign_key_check);$/.test(sql)) {
            checks.push(sql);
          }
          return prepare(sql);
        });
      }
      return database;
    });
    const worker = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
    const quickCheck = vi.spyOn(verifier, "requestOpenClawAgentDatabaseQuickCheck");
    const first = openOpenClawAgentDatabase(options);
    expect(checks).toEqual(["PRAGMA integrity_check;", "PRAGMA foreign_key_check;"]);
    first.db.exec("INSERT INTO auth_profile_state VALUES ('preserved', '{\"value\":42}', 1)");
    for (let iteration = 0; iteration < 2; iteration += 1) {
      closeOpenClawAgentDatabaseByPath(pathname);
      const read = (database: typeof first) =>
        database.db
          .prepare("SELECT state_json FROM auth_profile_state WHERE state_key = ?")
          .get("preserved");
      const row =
        mode === "sync"
          ? read(openOpenClawAgentDatabase(options))
          : mode === "async"
            ? await withOpenClawAgentDatabaseAsync(options, read)
            : await withOpenClawAgentDatabaseAdmission(
                options,
                (run) => Promise.resolve(run(() => {})),
                read,
              );
      expect(row).toEqual({ state_json: '{"value":42}' });
    }
    expect(checks).toEqual(["PRAGMA integrity_check;", "PRAGMA foreign_key_check;"]);
    expect(worker).not.toHaveBeenCalled();
    expect(quickCheck).not.toHaveBeenCalled();

    closeOpenClawAgentDatabasesForTest();
    openOpenClawAgentDatabase(options);
    expect(checks).toEqual(["PRAGMA integrity_check;", "PRAGMA foreign_key_check;"]);
  },
);

it("retains integrity verification until durable evidence is invalidated", () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-invalidation-") };
  const databasePath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
  expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);
  closeOpenClawStateDatabaseForTest();
  createUnsafeIndexDrift(databasePath);

  expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  closeOpenClawAgentDatabasesForTest();
  clearOpenClawAgentIntegrityVerification(databasePath, env);
  expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
    /integrity_check failed.*missing from index unsafe_index_records_value/iu,
  );
});

it("does not hide a fresh preparation failure behind a clean restart receipt", async () => {
  const options = {
    agentId: "integrity-preparation-failure",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-preparation-failure-") },
  };
  const first = openOpenClawAgentDatabase(options);
  const pathname = first.path;
  expect(closeOpenClawAgentDatabaseByPath(pathname)).toBe(true);
  expect(readOpenClawAgentIntegrityVerification(pathname, options.env)?.clean_close).toBe(1);
  // A new Worker has no process-local verification but can observe the clean restart receipt.
  vi.spyOn(validationCache, "getOpenClawAgentDatabaseValidation").mockReturnValue(undefined);
  const readers = new WeakSet<object>();
  const open = sqlite.openNodeSqliteDatabase;
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    if (database.location() === pathname && args[1]?.readOnly) {
      readers.add(database);
    }
    return database;
  });
  const failure = new Error("fresh read-only integrity check failed");
  const check = integrity.runSqliteIntegrityCheckSync;
  let preparationChecks = 0;
  vi.spyOn(integrity, "runSqliteIntegrityCheckSync").mockImplementation((input) => {
    check(input);
    if (readers.has(input.database)) {
      preparationChecks += 1;
      throw failure;
    }
  });
  const operation = vi.fn();
  let admissions = 0;
  const outcome = await withOpenClawAgentDatabaseAdmission(
    options,
    async (run) => {
      admissions += 1;
      return run(() => {});
    },
    operation,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(preparationChecks).toBe(1);
  expect(admissions).toBe(1);
  expect(outcome).toBe(failure);
  expect(operation).not.toHaveBeenCalled();
});

it("runs a canonical convergence check even when local proof skipped preparation scanning", async () => {
  const options = {
    agentId: "integrity-convergence",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-convergence-") },
  };
  const first = openOpenClawAgentDatabase(options);
  const pathname = first.path;
  const validation = validationCache.getOpenClawAgentDatabaseValidationForTransfer(first);
  expect(validation).toBeDefined();
  expect(closeOpenClawAgentDatabaseByPath(pathname)).toBe(true);
  const raw = sqlite.openNodeSqliteDatabase(pathname);
  try {
    raw.exec("ALTER TABLE session_nodes DROP COLUMN project_id");
  } finally {
    raw.close();
  }
  expect(validationCache.getOpenClawAgentDatabaseValidationForTransfer(first)).toBe(validation);

  let admitted = false;
  let readonlyOpened = 0;
  const checks: Array<{ sql: string; admitted: boolean; readOnly: boolean }> = [];
  const open = sqlite.openNodeSqliteDatabase;
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    if (database.location() !== pathname) {
      return database;
    }
    if (args[1]?.readOnly) {
      readonlyOpened += 1;
    }
    const prepare = database.prepare.bind(database);
    vi.spyOn(database, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (/^PRAGMA (integrity_check|foreign_key_check);$/.test(sql)) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...parameters) => {
          const rows = all(...parameters);
          checks.push({ sql, admitted, readOnly: args[1]?.readOnly === true });
          return rows;
        });
        const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, "iterate").mockImplementation(function* (...parameters) {
          yield* iterate(...parameters);
          checks.push({ sql, admitted, readOnly: args[1]?.readOnly === true });
          return undefined;
        });
      }
      return statement;
    });
    return database;
  });
  const columns = await withOpenClawAgentDatabaseAdmission(
    options,
    async (run) => {
      expect(readonlyOpened).toBe(1);
      expect(checks).toEqual([]);
      admitted = true;
      try {
        return await run(() => {});
      } finally {
        admitted = false;
      }
    },
    (database) => database.db.prepare("PRAGMA table_info(session_nodes)").all(),
  );
  expect(columns).toContainEqual(expect.objectContaining({ name: "project_id" }));
  expect(checks).toEqual([
    { sql: "PRAGMA integrity_check;", admitted: true, readOnly: false },
    { sql: "PRAGMA foreign_key_check;", admitted: true, readOnly: false },
  ]);
});

it("does not lend remembered integrity to another file at the same path", () => {
  const options = {
    agentId: "integrity-cache",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-replacement-") },
  };
  const database = openOpenClawAgentDatabase(options);
  closeOpenClawAgentDatabaseByPath(database.path);
  const replacement = `${database.path}.replacement`;
  fs.copyFileSync(database.path, replacement);
  createUnsafeIndexDrift(replacement);
  fs.renameSync(replacement, database.path);
  expect(() => openOpenClawAgentDatabase(options)).toThrow(
    /integrity_check failed.*missing from index unsafe_index_records_value/iu,
  );
});

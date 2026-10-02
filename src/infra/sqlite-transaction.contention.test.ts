import { spawn, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";
import { isMainThread, threadId } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

const openDatabases: Array<import("node:sqlite").DatabaseSync> = [];
type WriterLockChild = ChildProcessByStdio<null, Readable, Readable>;
const openChildren: WriterLockChild[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function startWriterLockChild(databasePath: string, holdMs: number): WriterLockChild {
  const child = spawn(
    process.execPath,
    [
      "--no-warnings",
      "--input-type=module",
      "-e",
      `
        import { DatabaseSync } from "node:sqlite";
        const db = new DatabaseSync(process.argv[1]);
        db.exec("PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE;");
        process.stdout.write("ready\\n");
        setTimeout(() => {
          db.exec("COMMIT");
          db.close();
        }, Number(process.argv[2]));
      `,
      databasePath,
      String(holdMs),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  openChildren.push(child);
  return child;
}

async function waitForChildReady(child: WriterLockChild): Promise<void> {
  let output = "";
  for await (const chunk of child.stdout) {
    output += chunk.toString();
    if (output.includes("ready")) {
      return;
    }
  }
  throw new Error(`writer-lock child exited before ready: ${output}`);
}

async function waitForChildExit(child: WriterLockChild): Promise<void> {
  if (child.exitCode !== null) {
    expect(child.exitCode).toBe(0);
    return;
  }
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("exit", (code) => resolve({ code, stderr }));
  });
  expect(result).toEqual({ code: 0, stderr: "" });
}

afterEach(() => {
  for (const child of openChildren.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const db of openDatabases.splice(0)) {
    if (db.isOpen) {
      db.close();
    }
  }
  vi.restoreAllMocks();
});

describe("runSqliteImmediateTransactionSync contention", () => {
  it("waits for a separate writer and exposes the synchronous event-loop cost", async () => {
    const holdMs = 200;
    const tempDir = tempDirs.make("openclaw-sqlite-contention-");
    const databasePath = path.join(tempDir, "contention.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    openDatabases.push(db);
    db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 1000; CREATE TABLE entries (id TEXT PRIMARY KEY);",
    );
    const child = startWriterLockChild(databasePath, holdMs);
    await waitForChildReady(child);

    let timerFiredAt: number | undefined;
    const timerStartedAt = Date.now();
    setTimeout(() => {
      timerFiredAt = Date.now();
    }, 0);
    const transactionStartedAt = Date.now();
    runSqliteImmediateTransactionSync(
      db,
      () => db.prepare("INSERT INTO entries(id) VALUES (?)").run("parent"),
      { busyTimeoutMs: 1_000 },
    );
    const elapsedMs = Date.now() - transactionStartedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(Math.floor(holdMs / 2));
    expect(timerFiredAt).toBeUndefined();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect((timerFiredAt ?? 0) - timerStartedAt).toBeGreaterThanOrEqual(Math.floor(holdMs / 2));
    await waitForChildExit(child);
    expect(db.prepare("SELECT id FROM entries").all()).toEqual([{ id: "parent" }]);
  });

  it("fails a real separate-writer wait after the single SQLite busy timeout", async () => {
    const tempDir = tempDirs.make("openclaw-sqlite-timeout-");
    const databasePath = path.join(tempDir, "contention.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    openDatabases.push(db);
    db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 20; CREATE TABLE entries (id TEXT PRIMARY KEY);",
    );
    const child = startWriterLockChild(databasePath, 250);
    await waitForChildReady(child);

    const logger = { warn: vi.fn() };
    const startedAt = Date.now();
    let thrown: unknown;
    try {
      runSqliteImmediateTransactionSync(db, () => undefined, {
        busyTimeoutMs: 20,
        databaseLabel: databasePath,
        logger,
        operationLabel: "contention-proof",
      });
    } catch (error) {
      thrown = error;
    }
    const elapsedMs = Date.now() - startedAt;
    expect(thrown).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 5 });
    expect(elapsedMs).toBeGreaterThanOrEqual(15);
    expect(elapsedMs).toBeLessThan(200);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "SQLite transaction lock wait failed",
      expect.objectContaining({
        busyTimeoutMs: 20,
        code: "ERR_SQLITE_ERROR",
        failureKind: "lock-contention",
        isMainThread,
        operation: "contention-proof",
        pid: process.pid,
        sqliteErrcode: 5,
        sqlitePrimaryCode: 5,
        step: "begin",
        threadId,
      }),
    );

    await waitForChildExit(child);
    expect(() =>
      runSqliteImmediateTransactionSync(db, () => {
        db.prepare("INSERT INTO entries(id) VALUES (?)").run("after-timeout");
      }),
    ).not.toThrow();
  });
});

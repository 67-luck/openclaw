import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { encodeRun } from "./update-run-codec.js";
import { readUpdateRunRecord } from "./update-run-read.kernel.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { mutateRunInTransaction, updateRunLedgerSchema, upsertStep } from "./update-run-write.js";

let root: string;
let database: DatabaseSync | undefined;
let env: NodeJS.ProcessEnv;

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    try {
      database?.close();
    } finally {
      database = undefined;
      cleanup();
    }
  }),
);

function ownedDatabase(): DatabaseSync {
  if (!database || fsSync.realpathSync(root) !== root || !fsSync.lstatSync(root).isDirectory()) {
    throw new Error("Receipt fixture requires its physically private database root");
  }
  return database;
}

function record(): UpdateRunRecord {
  return {
    runId: "00000000-0000-4000-8000-000000000001",
    createdAtMs: 1,
    updatedAtMs: 2,
    trigger: "cli",
    phase: "finished",
    status: "failed",
    reason: "candidate failed",
    origin: { driver: { host: "fixture", pid: 41, startIdentity: "1" } },
    target: { kind: "package" },
    before: {},
    after: {},
    steps: [],
    verification: {},
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: 2,
    downtimeMs: null,
  };
}

beforeEach(async () => {
  root = await fs.realpath(tempDirs.make("update-receipts-"));
  const stateDir = path.join(root, "state");
  const handoffDir = path.join(root, "handoff");
  await fs.mkdir(stateDir, { mode: 0o700 });
  await fs.mkdir(handoffDir, { mode: 0o700 });
  expect(await fs.realpath(stateDir)).toBe(stateDir);
  expect(await fs.realpath(handoffDir)).toBe(handoffDir);
  env = {
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  };
  database = new (requireNodeSqlite().DatabaseSync)(path.join(stateDir, "receipts.sqlite"));
  ownedDatabase().exec(updateRunLedgerSchema);
  const row = encodeRun(record(), { env });
  const columns = Object.keys(row);
  ownedDatabase()
    .prepare(
      `INSERT INTO update_runs (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    )
    .run(...Object.values(row));
});

describe("durable update database receipts", () => {
  it("keeps database recovery locations when later diagnostics exhaust the history budget", () => {
    const summaries = [
      {
        step: "diagnostic:database snapshot",
        status: "completed" as const,
        detail: "Databases snapshotted at /backup.databases",
      },
      {
        step: "diagnostic:database migration writes",
        status: "completed" as const,
        detail: `Post-migration write inventory: 100 databases; SHA-256 ${"e".repeat(64)}. Snapshots: /backup.databases.`,
      },
      {
        step: "diagnostic:database rollback",
        status: "completed" as const,
        detail: "Restored databases; migrated originals retained at /source.sqlite.migrated-run-1",
      },
    ];
    mutateRunInTransaction(
      ownedDatabase(),
      record().runId,
      (run) => {
        for (const summary of summaries) {
          upsertStep(run, summary);
        }
        for (let index = 0; index < 150; index++) {
          upsertStep(run, {
            step: `diagnostic:${index}`,
            status: "completed",
            detail: "validation detail ".repeat(50),
          });
        }
      },
      { env },
    );
    ownedDatabase().close();
    database = new (requireNodeSqlite().DatabaseSync)(path.join(root, "state", "receipts.sqlite"));
    const recovered = readUpdateRunRecord(ownedDatabase(), record().runId)!;
    expect(recovered.steps).toEqual(expect.arrayContaining(summaries));
    expect(recovered.steps.length).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(JSON.stringify(recovered.steps))).toBeLessThanOrEqual(16 * 1024);
  });
});

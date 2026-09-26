import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readUpdateDatabaseGenerations } from "../infra/update-database-generations.js";
import { recordBackupRunOutcome } from "../state/backup-run-records.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { migrateOpenClawAgentDatabaseForMaintenance } from "../state/openclaw-agent-db-maintenance.js";
import { seedOpenClawAgentSchemaV21 } from "../state/openclaw-agent-schema-v21.test-support.js";
import { runOutsideOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

let writer: ChildProcess;
beforeAll(async () => {
  // One independent native writer serves the suite; IPC establishes ordering.
  writer = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import { DatabaseSync } from 'node:sqlite'; process.on('message', ({path,sql}) => { const db=new DatabaseSync(path,{defensive:false}); let reply; try { db.exec(sql); reply={ok:true}; } catch(e) { reply={error:String(e)}; } finally {db.close();} process.send(reply); }); process.send({ready:true});",
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  expect((await once(writer, "message"))[0]).toEqual({ ready: true });
});
afterAll(async () => {
  await stopChildProcess(writer, 5_000);
});
async function foreign(pathname: string, sql = "INSERT INTO evidence VALUES (99)") {
  const reply = once(writer, "message");
  writer.send({ path: pathname, sql });
  expect((await reply)[0]).toEqual({ ok: true });
}

it.each([
  "owned",
  "before",
  "during",
  "after-commit",
  "linked",
  "independent-context",
  "dormant-write",
  "missing-foreign",
  "missing-empty-foreign",
])("accounts only native Doctor transactions (%s)", async (scenario) => {
  await withOpenClawTestState(
    { scenario: "external-service", label: "doctor-write-receipt" },
    async (state) => {
      openOpenClawStateDatabase();
      await closeOpenClawStateDatabaseAsync();
      const pathname = state.path("agent.sqlite");
      const missing = state.path("missing.sqlite");
      const dormant = state.path("dormant.sqlite");
      for (const file of [pathname, dormant]) {
        const db = new DatabaseSync(file);
        db.exec("CREATE TABLE evidence(value INTEGER); INSERT INTO evidence VALUES (1)");
        db.close();
      }
      const paths = [pathname, missing, dormant];
      const databaseGenerations = readUpdateDatabaseGenerations(paths);
      let spelling = pathname;
      if (scenario === "linked") {
        const linked = state.path("linked");
        await fs.symlink(path.dirname(pathname), linked, "junction");
        spelling = path.join(linked, "agent.sqlite");
      }
      if (scenario === "before") {
        await foreign(pathname);
      }
      const maintenance = await beginDoctorMaintenance({
        root: null,
        options: { repair: true, nonInteractive: true },
        runtime: { log() {}, error() {}, exit() {} },
        databaseGenerations,
      });
      try {
        expect(maintenance?.databaseWrites).toBeUndefined();
        await maintenance!.run(async () => {
          if (scenario === "during") {
            await foreign(pathname);
          }
          if (scenario === "dormant-write") {
            await foreign(dormant);
          }
          if (scenario === "missing-empty-foreign") {
            await foreign(missing, "");
          }
          if (scenario === "missing-foreign") {
            await foreign(
              missing,
              "CREATE TABLE foreign_rows(value); INSERT INTO foreign_rows VALUES (99)",
            );
          }
          if (scenario === "independent-context") {
            runOutsideOpenClawDatabaseMaintenanceScope(() => {
              const independent = new DatabaseSync(pathname);
              try {
                runSqliteImmediateTransactionSync(independent, () =>
                  independent.exec("INSERT INTO evidence VALUES (99)"),
                );
              } finally {
                independent.close();
              }
            });
          }
          const owned = new DatabaseSync(spelling);
          try {
            // WAL activation/close are layout changes, not foreign data writes.
            owned.exec("PRAGMA journal_mode=WAL");
            runSqliteImmediateTransactionSync(owned, () => {
              owned.exec(
                "ALTER TABLE evidence ADD COLUMN migrated TEXT; UPDATE evidence SET migrated='doctor'; INSERT INTO evidence(value) VALUES (2)",
              );
            });
            if (scenario === "after-commit") {
              await foreign(pathname, "INSERT INTO evidence(value) VALUES (99)");
            }
          } finally {
            owned.close();
          }
          const created = openNodeSqliteDatabase(missing);
          try {
            runSqliteImmediateTransactionSync(created, () =>
              created.exec("CREATE TABLE created_by_doctor(id INTEGER); PRAGMA user_version=23"),
            );
          } finally {
            created.close();
          }
        });
        await maintenance!.releaseState();
        const receipt = maintenance!.databaseWrites;
        expect(receipt).toEqual({
          unchanged: scenario === "owned" || scenario === "linked",
          generations: readUpdateDatabaseGenerations(paths),
        });
        expect(receipt?.generations[pathname]).not.toBe(databaseGenerations[pathname]);
        await foreign(pathname, "INSERT INTO evidence(value) VALUES (100)");
        await maintenance!.release();
        expect(maintenance!.databaseWrites).toEqual(receipt);
        expect(readUpdateDatabaseGenerations([pathname])[pathname]).not.toBe(
          receipt?.generations[pathname],
        );
      } finally {
        await maintenance?.release();
      }
    },
  );
});

it.each(["foreign-metadata", "owned-creation", "creation-foreign-metadata"])(
  "accounts for empty database metadata (%s)",
  async (scenario) => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "doctor-empty-metadata" },
      async (state) => {
        openOpenClawStateDatabase();
        await closeOpenClawStateDatabaseAsync();
        const pathname = state.path("empty.sqlite");
        if (scenario === "foreign-metadata") {
          const db = new DatabaseSync(pathname, { defensive: false });
          db.exec("PRAGMA schema_version=1");
          db.close();
        }
        const databaseGenerations = readUpdateDatabaseGenerations([pathname]);
        const maintenance = await beginDoctorMaintenance({
          root: null,
          options: { repair: true, nonInteractive: true },
          runtime: { log() {}, error() {}, exit() {} },
          databaseGenerations,
        });
        try {
          await maintenance!.run(async () => {
            if (scenario === "foreign-metadata") {
              await foreign(pathname, "PRAGMA schema_version=9");
            } else {
              const db = openNodeSqliteDatabase(pathname);
              try {
                if (scenario === "creation-foreign-metadata") {
                  await foreign(pathname, "PRAGMA schema_version=9");
                }
                runSqliteImmediateTransactionSync(db, () => db.exec("PRAGMA user_version=9"));
              } finally {
                db.close();
              }
            }
          });
          if (scenario !== "owned-creation") {
            const check = new DatabaseSync(pathname, { readOnly: true });
            try {
              expect(check.prepare("PRAGMA schema_version").get()?.schema_version).toBe(9);
            } finally {
              check.close();
            }
          }
          await maintenance!.releaseState();
          expect(maintenance!.databaseWrites).toEqual({
            unchanged: scenario === "owned-creation",
            generations: readUpdateDatabaseGenerations([pathname]),
          });
          const db = new DatabaseSync(pathname, { readOnly: true });
          try {
            expect(db.prepare("PRAGMA schema_version").get()?.schema_version).toBe(
              scenario === "owned-creation" ? 0 : 9,
            );
            expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(
              scenario === "foreign-metadata" ? 0 : 9,
            );
            expect(db.prepare("SELECT name FROM sqlite_schema").all()).toEqual([]);
          } finally {
            db.close();
          }
        } finally {
          await maintenance?.release();
        }
      },
    );
  },
);

it.each(["foreign", "owned", "creation-foreign"])(
  "accounts for persistent default_cache_size through Doctor (%s)",
  async (scenario) => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "doctor-cache-metadata" },
      async (state) => {
        openOpenClawStateDatabase();
        await closeOpenClawStateDatabaseAsync();
        const pathname = state.path("cache.sqlite");
        if (scenario !== "creation-foreign") {
          await foreign(pathname, "PRAGMA default_cache_size=123");
        }
        const databaseGenerations = readUpdateDatabaseGenerations([pathname]);
        const maintenance = await beginDoctorMaintenance({
          root: null,
          options: { repair: true, nonInteractive: true },
          runtime: { log() {}, error() {}, exit() {} },
          databaseGenerations,
        });
        try {
          await maintenance!.run(async () => {
            if (scenario === "foreign") {
              await foreign(pathname, "PRAGMA default_cache_size=321");
              return;
            }
            const db = openNodeSqliteDatabase(pathname);
            try {
              if (scenario === "creation-foreign") {
                await foreign(pathname, "PRAGMA default_cache_size=321");
              }
              runSqliteImmediateTransactionSync(db, () =>
                db.exec(
                  scenario === "owned" ? "PRAGMA default_cache_size=321" : "PRAGMA user_version=9",
                ),
              );
            } finally {
              db.close();
            }
          });
          await maintenance!.releaseState();
          // Independent readback after all native writers close: SQLite names
          // this result cache_size, not default_cache_size. The header is durable.
          const check = new DatabaseSync(pathname, { readOnly: true });
          try {
            expect(check.prepare("PRAGMA main.default_cache_size").get()).toEqual({
              cache_size: 321,
            });
            expect(check.prepare("SELECT name FROM sqlite_schema").all()).toEqual([]);
          } finally {
            check.close();
          }
          expect((await fs.readFile(pathname)).readInt32BE(48)).toBe(321);
          const generations = readUpdateDatabaseGenerations([pathname]);
          expect(generations[pathname]).not.toBe(databaseGenerations[pathname]);
          expect(maintenance!.databaseWrites).toEqual({
            unchanged: scenario === "owned",
            generations,
          });
        } finally {
          await maintenance?.release();
        }
      },
    );
  },
);

it("accounts for admitted worker writes and their cleanup before publishing proof", async () => {
  await withOpenClawTestState(
    { scenario: "external-service", label: "doctor-worker-receipt" },
    async (state) => {
      const database = openOpenClawStateDatabase();
      const pathname = database.path;
      await closeOpenClawStateDatabaseAsync();
      const databaseGenerations = readUpdateDatabaseGenerations([pathname]);
      const maintenance = await beginDoctorMaintenance({
        root: null,
        options: { repair: true, nonInteractive: true },
        runtime: { log() {}, error() {}, exit() {} },
        databaseGenerations,
      });
      try {
        await maintenance!.run(async () => {
          await recordBackupRunOutcome({
            env: state.env,
            archivePath: state.path("doctor-backup"),
            kind: "sqlite-snapshot",
            status: "ok",
          });
        });
        await maintenance!.releaseState();
        expect(maintenance!.databaseWrites).toEqual({
          unchanged: true,
          generations: readUpdateDatabaseGenerations([pathname]),
        });
        expect(maintenance!.databaseWrites?.generations[pathname]).not.toBe(
          databaseGenerations[pathname],
        );
      } finally {
        await maintenance?.release();
      }
    },
  );
});

it("keeps unavailable fingerprint verification advisory", async () => {
  await withOpenClawTestState(
    { scenario: "external-service", label: "doctor-unavailable-receipt" },
    async (state) => {
      const pathname = state.path("not-a-database");
      await fs.mkdir(pathname);
      const log = vi.fn();
      const maintenance = await beginDoctorMaintenance({
        root: null,
        options: { repair: true, nonInteractive: true },
        runtime: { log, error() {}, exit() {} },
        databaseGenerations: { [pathname]: null },
      });
      try {
        await maintenance!.finish({});
        expect(maintenance!.databaseWrites).toBeUndefined();
        expect(maintenance!.warnings).toContainEqual(
          expect.stringContaining("Database write verification is unavailable"),
        );
      } finally {
        await maintenance?.release();
      }
    },
  );
});

it("joins cleanup without publishing write proof after authority revocation", async () => {
  await withOpenClawTestState(
    { scenario: "external-service", label: "doctor-revoked-receipt" },
    async (state) => {
      openOpenClawStateDatabase();
      await closeOpenClawStateDatabaseAsync();
      const pathname = state.path("agent.sqlite");
      const db = new DatabaseSync(pathname);
      db.exec("CREATE TABLE evidence(value); INSERT INTO evidence VALUES (1)");
      db.close();
      let current = true;
      const revoked = new Error("update owner revoked");
      const maintenance = await beginDoctorMaintenance({
        root: null,
        options: { repair: true, nonInteractive: true },
        runtime: { log() {}, error() {}, exit() {} },
        assertCurrent: () => {
          if (!current) {
            throw revoked;
          }
        },
        databaseGenerations: readUpdateDatabaseGenerations([pathname]),
      });
      await maintenance!.run(async () => {
        const owner = new DatabaseSync(pathname);
        try {
          runSqliteImmediateTransactionSync(owner, () =>
            owner.exec("INSERT INTO evidence VALUES (2)"),
          );
        } finally {
          owner.close();
        }
      });
      current = false;
      try {
        await expect(maintenance!.releaseState()).rejects.toBe(revoked);
        expect(maintenance!.databaseWrites).toBeUndefined();
      } finally {
        await maintenance!.release();
      }
    },
  );
});

it("accounts for the real leased schema-21 migration and shared lease settlement", async () => {
  await withOpenClawTestState(
    { scenario: "external-service", label: "doctor-native-migration-receipt" },
    async (state) => {
      const shared = openOpenClawStateDatabase();
      const sharedPath = shared.path;
      await closeOpenClawStateDatabaseAsync();
      await fs.mkdir(state.agentDir(), { recursive: true });
      const pathname = path.join(state.agentDir(), "openclaw-agent.sqlite");
      const seed = new DatabaseSync(pathname);
      seedOpenClawAgentSchemaV21(seed);
      seed.exec(
        "INSERT INTO cache_entries(scope,key,value_json,expires_at,updated_at) VALUES ('proof','retained','{\"keep\":true}',NULL,7)",
      );
      seed.close();
      const databaseGenerations = readUpdateDatabaseGenerations([sharedPath, pathname]);
      const maintenance = await beginDoctorMaintenance({
        root: null,
        options: { repair: true, nonInteractive: true },
        runtime: { log() {}, error() {}, exit() {} },
        databaseGenerations,
      });
      try {
        await maintenance!.run(() =>
          withAgentDatabaseMaintenanceLease({ env: state.env }, async (lease) => {
            await migrateOpenClawAgentDatabaseForMaintenance({ agentId: "main", pathname }, lease);
          }),
        );
        await maintenance!.releaseState();
        expect(maintenance!.databaseWrites).toEqual({
          unchanged: true,
          generations: readUpdateDatabaseGenerations([sharedPath, pathname]),
        });
        const restored = new DatabaseSync(pathname, { readOnly: true });
        try {
          expect(restored.prepare("PRAGMA user_version").get()?.user_version).toBe(23);
          expect(
            restored.prepare("SELECT value_json FROM cache_entries WHERE scope='proof'").get()
              ?.value_json,
          ).toBe('{"keep":true}');
        } finally {
          restored.close();
        }
      } finally {
        await maintenance?.release();
      }
    },
  );
});

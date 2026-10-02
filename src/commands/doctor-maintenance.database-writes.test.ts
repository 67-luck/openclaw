import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { restoreFailedUpdateDatabases } from "../cli/update-cli/update-command-database-backup.js";
import { recordUpdateDatabaseWrites } from "../cli/update-cli/update-command-database-receipts.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import {
  createEvent,
  createLegacyDatabaseFixture,
  readDatabaseSnapshot,
} from "../infra/state-migrations.media-persistence.test-support.js";
import { readLegacyMigrationRunFromDatabase } from "../infra/state-migrations.receipts.js";
import {
  createUpdateDatabaseBackup,
  type UpdateDatabaseBackup,
} from "../infra/update-database-backup.js";
import { readUpdateDatabaseGenerations } from "../infra/update-database-generations.js";
import { createUpdateRun, getUpdateRun, recordUpdateRunStep } from "../infra/update-run-ledger.js";
import { toPublicUpdateRun } from "../infra/update-run-record.js";
import { updateRunStepsFromResultStep } from "../infra/update-run-step.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import type { UpdateStepResult } from "../infra/update-step-result.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { runStateSchemaMigrationTransaction } from "../state/openclaw-state-db-maintenance.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

it("restores the real agent migration and its shared-state lease from the captured inventory", async () => {
  await withOpenClawTestState(
    { scenario: "external-service", label: "doctor-migration-receipt" },
    async (state) => {
      const pathname = createLegacyDatabaseFixture({
        env: state.env,
        schemaVersion: 21,
        eventsBySession: {
          retained: [
            createEvent({
              id: "retained-message",
              parentId: null,
              timestamp: 1,
              message: { role: "user", content: "Retain this conversation through rollback." },
            }),
          ],
        },
      });
      const before = readDatabaseSnapshot(pathname);
      const runId = createUpdateRun({ trigger: "cli" }).runId;
      await closeOpenClawStateDatabaseAsync();
      const backup = await createUpdateDatabaseBackup({
        backupRoot: state.path("retained-package"),
        stateDir: state.stateDir,
        config: {},
        env: state.env,
      });
      const maintenance = await beginDoctorMaintenance({
        root: null,
        options: { repair: true, nonInteractive: true },
        runtime: { log() {}, error() {}, exit() {} },
        databaseGenerations: backup.sourceGenerations,
        runId,
      });
      try {
        expect(maintenance).toBeDefined();
        const migrated = await maintenance!.run(() =>
          migrateLegacyMediaPersistence({ env: state.env }),
        );
        expect(migrated.warnings).toEqual([]);
        expect(readDatabaseSnapshot(pathname).version.user_version).toBe(
          OPENCLAW_AGENT_SCHEMA_VERSION,
        );
        await maintenance!.releaseState();
        const step: UpdateStepResult = {
          name: "doctor",
          command: "doctor --fix",
          cwd: state.stateDir,
          durationMs: 0,
          exitCode: 1,
        };
        recordUpdateDatabaseWrites(backup, maintenance!.databaseWrites, step, runId);
        expect(backup.restoreRefusal).toBeUndefined();
        const result: UpdateRunResult = { status: "error", mode: "npm", steps: [], durationMs: 0 };
        expect(
          await restoreFailedUpdateDatabases({
            backup,
            result,
            runId,
            env: state.env,
            assertCurrent() {},
          }),
        ).toBe(true);
        expect(readDatabaseSnapshot(pathname)).toEqual(before);
      } finally {
        await maintenance?.release();
      }
    },
  );
});

it.each([
  "during",
  "missing-foreign",
  "migration",
  "migration-then-foreign",
  "commit-race",
  "post-commit-refusal",
  "wrong-run",
  "large-receipt",
])("restores only transactions attributed to the admitted Doctor run (%s)", async (scenario) => {
  await withOpenClawTestState(
    { scenario: "external-service", label: "doctor-foreign-write" },
    async (state) => {
      openOpenClawStateDatabase();
      const runId = createUpdateRun({ trigger: "cli" }).runId;
      await closeOpenClawStateDatabaseAsync();
      const pathname = state.path("agent.sqlite");
      if (scenario !== "missing-foreign") {
        const seed = new DatabaseSync(pathname);
        seed.exec("CREATE TABLE evidence(value INTEGER); INSERT INTO evidence VALUES (1)");
        seed.close();
      }
      const paths = [pathname];
      if (scenario === "large-receipt") {
        for (let index = 0; index < 32; index++) {
          const extra = state.path(`database-${index}.sqlite`);
          await fs.copyFile(pathname, extra);
          paths.push(extra);
        }
      }
      const databaseGenerations = readUpdateDatabaseGenerations(paths);
      const maintenance = await beginDoctorMaintenance({
        root: null,
        options: { repair: true, nonInteractive: true },
        runtime: { log() {}, error() {}, exit() {} },
        databaseGenerations,
        runId,
      });
      try {
        expect(maintenance).toBeDefined();
        expect(maintenance!.databaseWrites).toBeUndefined();
        const ownedMigration =
          scenario.startsWith("migration") ||
          scenario === "wrong-run" ||
          scenario === "commit-race" ||
          scenario === "post-commit-refusal" ||
          scenario === "large-receipt";
        if (ownedMigration) {
          const migrate = () =>
            maintenance!.run(() => {
              const database = new DatabaseSync(pathname);
              try {
                runStateSchemaMigrationTransaction(
                  database,
                  pathname,
                  () => {
                    database.exec("INSERT INTO evidence VALUES (2)");
                  },
                  {
                    operationLabel: "state.schema.migration",
                    withCommit: (commit) => {
                      commit();
                      if (scenario === "post-commit-refusal") {
                        throw new Error("Candidate activation refused after commit");
                      }
                      if (scenario === "commit-race") {
                        const foreign = new DatabaseSync(pathname);
                        try {
                          foreign.exec("INSERT INTO evidence VALUES (99)");
                        } finally {
                          foreign.close();
                        }
                      }
                    },
                  },
                );
              } finally {
                database.close();
              }
            });
          if (scenario === "post-commit-refusal") {
            expect(migrate).toThrow("Candidate activation refused after commit");
          } else {
            migrate();
          }
        }
        if (
          scenario !== "migration" &&
          scenario !== "wrong-run" &&
          scenario !== "commit-race" &&
          scenario !== "post-commit-refusal" &&
          scenario !== "large-receipt"
        ) {
          // Independent connections never inherit the migration's receipt.
          const foreign = new DatabaseSync(pathname);
          try {
            if (scenario === "missing-foreign") {
              foreign.exec("CREATE TABLE evidence(value INTEGER)");
            }
            foreign.exec("INSERT INTO evidence VALUES (99)");
          } finally {
            foreign.close();
          }
        }
        await maintenance!.releaseState();
        const receipt = maintenance!.databaseWrites;
        expect(receipt?.generations[pathname]).not.toBe(databaseGenerations[pathname]);
        expect(receipt?.unchanged).toBe(false);

        const backup: UpdateDatabaseBackup = {
          directory: state.path("retained-snapshots"),
          databases: [],
          missingPaths: scenario === "missing-foreign" ? [pathname] : [],
          sourcePaths: paths,
          sourceGenerations: databaseGenerations,
          warnings: [],
        };
        const step: UpdateStepResult = {
          name: "doctor",
          command: "doctor --fix",
          cwd: state.stateDir,
          durationMs: 0,
          exitCode: 1,
        };
        const evidence = recordUpdateDatabaseWrites(
          backup,
          receipt,
          step,
          scenario === "wrong-run" ? "different-run" : runId,
        );
        if (
          scenario === "migration" ||
          scenario === "post-commit-refusal" ||
          scenario === "large-receipt"
        ) {
          expect(backup.restoreRefusal).toBeUndefined();
          expect(backup.migration?.to).toEqual(receipt!.generations);
          expect(receipt?.attribution).toMatchObject({
            runId,
            unattributedPaths: [],
            writes: [
              expect.objectContaining({ path: pathname, migrationId: "state.schema.migration" }),
            ],
          });
          expect(evidence).toBeDefined();
          for (const row of updateRunStepsFromResultStep(step)) {
            recordUpdateRunStep(runId, row);
          }
          const recorded = getUpdateRun(runId)!;
          const receiptId = recorded.steps.find(
            (row) => row.databaseWriteReceiptId,
          )?.databaseWriteReceiptId;
          expect(receiptId).toBeDefined();
          const stored = readLegacyMigrationRunFromDatabase(
            openOpenClawStateDatabase().db,
            receiptId!,
          );
          expect(JSON.parse(stored!.reportJson)).toMatchObject({ runId, receipt });
          if (scenario === "large-receipt") {
            expect(Buffer.byteLength(stored!.reportJson)).toBeGreaterThan(16 * 1024);
          }
          expect(
            toPublicUpdateRun(recorded).steps.some(
              (row) => "databaseWrites" in row || "databaseWriteReceiptId" in row,
            ),
          ).toBe(false);
          return;
        }
        expect(backup.restoreRefusal).toContain("the writer is unknown");
        const result: UpdateRunResult = {
          status: "error",
          mode: "npm",
          steps: [],
          durationMs: 0,
        };
        expect(
          await restoreFailedUpdateDatabases({
            backup,
            result,
            runId: "foreign-write",
            env: state.env,
            assertCurrent() {},
          }),
        ).toBe(false);
        expect(result.reason).toBe("state-migrated-no-rollback");
        expect(result.steps[0]?.stderrTail).toContain("run openclaw doctor from the candidate");
        const preserved = new DatabaseSync(pathname, { readOnly: true });
        try {
          const preservedValue = scenario === "wrong-run" ? 2 : 99;
          expect(
            preserved.prepare("SELECT value FROM evidence WHERE value = ?").get(preservedValue),
          ).toEqual({
            value: preservedValue,
          });
        } finally {
          preserved.close();
        }
      } finally {
        await maintenance?.release();
      }
    },
  );
});

import "./update-command-execution.test-support.js";
import { expect, it, vi } from "vitest";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import * as legacy from "../../infra/gateway-lock-legacy.js";
import * as coordinators from "../../infra/state-database-coordinator.js";
import * as backups from "../../infra/update-database-backup.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureUpdateDatabases } from "./update-command-database-backup.js";
import * as contexts from "./update-command-managed-context.js";

const { executionParams } = await import("./update-command-execution.test-support.js");

it.each(["live", "unverified"] as const)(
  "keeps capture manual-only when a legacy Gateway owner is %s",
  async (state) => {
    const execution = executionParams("package");
    execution.opts.run = {
      runId: "legacy-capture",
      env: { OPENCLAW_STATE_DIR: "/synthetic/state" },
    };
    vi.spyOn(contexts, "readUpdateCandidateSource").mockResolvedValue({
      config: {},
      hash: hashConfigRaw(null),
    });
    const gateway = vi.spyOn(coordinators, "acquireGatewayMaintenanceCoordinator");
    const capture = vi.spyOn(backups, "createUpdateDatabaseBackup").mockResolvedValue({
      directory: "/synthetic/package.databases",
      databases: [],
      missingPaths: [],
      sourcePaths: [],
      sourceGenerations: {},
      warnings: [],
    });
    const error = new Error("Legacy Gateway lock has a " + state + " owner");
    vi.spyOn(legacy, "assertLegacyGatewayStoppedForMaintenance").mockRejectedValueOnce(error);
    const result = await captureUpdateDatabases({
      backupRoot: "/synthetic/package",
      execution,
      context: undefined,
      assertCurrent: vi.fn(),
    });
    expect(capture).toHaveBeenCalledOnce();
    expect(gateway).not.toHaveBeenCalled();
    expect(result.backup).toBeUndefined();
    expect(result.step.warnings).toEqual([expect.stringContaining(error.message)]);
    expect(result.step.diagnostics?.[0]).toContain("/synthetic/package.databases");
  },
);

it.each([false, true])(
  "holds qualified capture exclusion and keeps online capture manual (online=%s)",
  async (online) => {
    await withOpenClawTestState(
      { layout: "state-only", scenario: "minimal", prefix: "capture-exclusion-" },
      async (state) => {
        const execution = executionParams("package");
        execution.opts.run = { runId: "capture-exclusion", env: state.env };
        const coordinator = {
          databasePath: resolveOpenClawStateSqlitePath(state.env),
          busyTimeoutMs: 0,
        };
        const running = online
          ? coordinators.acquireGatewayLifecycleCoordinator(coordinator)
          : undefined;
        vi.spyOn(contexts, "readUpdateCandidateSource").mockResolvedValue({
          config: {},
          hash: hashConfigRaw(null),
        });
        vi.spyOn(legacy, "assertLegacyGatewayStoppedForMaintenance").mockResolvedValue(undefined);
        let admitted = false;
        const capture = vi
          .spyOn(backups, "createUpdateDatabaseBackup")
          .mockImplementation(async () => {
            if (!online) {
              let gateway:
                | ReturnType<typeof coordinators.acquireGatewayLifecycleCoordinator>
                | undefined;
              try {
                gateway = coordinators.acquireGatewayLifecycleCoordinator(coordinator);
                admitted = true;
              } catch {
                admitted = false;
              } finally {
                gateway?.release();
              }
            }
            return {
              directory: state.path("retained"),
              databases: [],
              missingPaths: [],
              sourcePaths: [],
              sourceGenerations: {},
              warnings: [],
            };
          });
        try {
          const result = await captureUpdateDatabases({
            backupRoot: state.path("package"),
            execution,
            context: undefined,
            assertCurrent() {},
          });
          expect(capture).toHaveBeenCalledOnce();
          expect(result.step.exitCode).toBe(0);
          if (online) {
            expect(result.backup).toBeUndefined();
            expect(result.step.warnings?.join("\n")).toContain(
              "Automatic database restoration is disabled",
            );
          } else {
            expect(result.backup).toBeDefined();
            expect(admitted).toBe(false);
            coordinators.acquireGatewayLifecycleCoordinator(coordinator).release();
          }
        } finally {
          running?.release();
        }
      },
    );
  },
);

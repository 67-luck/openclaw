// The parent handback protocol is independent of the packaged candidate runtime fixture.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/io.js";
import { createRetainedPackageSwap } from "../../infra/package-update-swap.test-support.js";
import { createUpdateRun, finishUpdateRun } from "../../infra/update-run-ledger.js";
import * as childCommands from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { MigratedUpdateFinalizationInput } from "./update-command-migrated-types.js";
import { continueMigratedUpdateInFreshProcess } from "./update-command-migrated.js";
import { taskRecovery } from "./update-command-post-update.test-support.js";

vi.mock("../../state/openclaw-state-db-contract.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-state-db-contract.js")>();
  return { ...actual, OPENCLAW_STATE_SCHEMA_VERSION: actual.OPENCLAW_STATE_SCHEMA_VERSION - 1 };
});
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

it.each<{
  pending: boolean;
  status: "error" | "skipped";
  candidateStartAttempted?: boolean;
  backup?: boolean;
  windows?: boolean;
  handback?: boolean;
}>([
  { pending: true, status: "skipped", windows: true },
  { pending: false, status: "error", windows: true },
  { pending: true, status: "error", windows: true },
  { pending: false, status: "error", candidateStartAttempted: false, backup: true, handback: true },
  { pending: false, status: "error", candidateStartAttempted: true, backup: true },
  { pending: false, status: "error", backup: true },
  { pending: false, status: "error", candidateStartAttempted: false },
  { pending: false, status: "error", candidateStartAttempted: false, backup: true, windows: true },
])(
  "retains the backup across migrated finalization (pending=$pending, status=$status, start=$candidateStartAttempted, backup=$backup, windows=$windows)",
  async ({
    pending,
    status,
    candidateStartAttempted,
    backup,
    windows = false,
    handback = false,
  }) => {
    const exitCode = status === "skipped" ? 0 : 1;
    const reason = status === "skipped" ? "gateway-readiness-unverified" : "doctor-failed";
    const base = dirs.make("migrated-readiness-pending-");
    const { transaction, packageRoot } = await createRetainedPackageSwap(base);
    const env = { OPENCLAW_STATE_DIR: path.join(base, "state") };
    const run = {
      runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
      env,
      activationTimeoutMs: 90_000,
    };
    const configSnapshot = await createConfigIO({ env, observe: false }).readConfigFileSnapshot();
    const windowsRecovery = taskRecovery();
    const complete = vi.spyOn(transaction, "complete");
    const rollback = vi.spyOn(transaction, "rollback");
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    // Keep the real parent and package owner; model only the completed candidate's JSON reply.
    vi.spyOn(childCommands, "runUtf8CommandWithTimeout").mockImplementation(
      async (_argv, options) => {
        if (typeof options === "number" || typeof options.input !== "string") {
          throw new Error("Expected serialized finalization input");
        }
        const input: MigratedUpdateFinalizationInput = JSON.parse(options.input);
        expect(input.params).not.toHaveProperty("databaseBackup");
        const result = {
          ...input.params.result,
          status,
          reason,
          runId: run.runId,
          steps: pending
            ? [
                {
                  name: "gateway verification",
                  command: "gateway verification",
                  cwd: packageRoot,
                  durationMs: 90_000,
                  exitCode: 0,
                  termination: "timeout",
                  advisory: {
                    kind: "recoverable-maintenance",
                    message:
                      "Gateway is still starting after 90000ms; left running with readiness unverified.",
                  },
                },
              ]
            : [],
        };
        finishUpdateRun(
          run.runId,
          { status: status === "skipped" ? "skipped" : "failed", reason },
          { env },
        );
        await fs.writeFile(
          input.resultPath,
          JSON.stringify({ result, exitCode, terminalRunId: run.runId, candidateStartAttempted }),
        );
        return {
          stdout: "candidate finalization result\n",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
          cleanup: "normal",
        };
      },
    );

    const outcome = await continueMigratedUpdateInFreshProcess(
      {
        mutationStarted: true,
        result: { status: "ok", mode: "npm", root: packageRoot, steps: [], durationMs: 1 },
        root: packageRoot,
        installKindChanged: false,
        configSnapshot,
        requestedChannel: null,
        storedChannel: "stable",
        channel: "stable",
        downgradeRisk: false,
        shouldRestart: true,
        opts: { json: true, run },
        preManagedServiceStop: {
          stopped: true,
          inspected: true,
          runtimeInspected: true,
          running: true,
          serviceEnv: env,
          ...(windows ? { windowsTaskAutoStartRecovery: windowsRecovery } : {}),
        },
        packageTransaction: transaction,
        ...(backup
          ? {
              databaseBackup: {
                directory: path.join(transaction.backupRoot, "databases"),
                databases: [],
                missingPaths: [],
                sourcePaths: [],
                sourceGenerations: {},
                warnings: [],
              },
            }
          : {}),
        controlPlaneUpdateSentinelMeta: null,
        preUpdatePluginInstallRecords: {},
        startedAt: Date.now(),
        packageUpdateNodeRunner: process.execPath,
        updateStepTimeoutMs: 90_000,
      },
      [],
    );

    expect(outcome).toMatchObject({
      exitCode,
      result: { status },
    });
    expect(outcome.result.reason).toBe(reason);
    expect(outcome.candidateStartAttempted).toBe(candidateStartAttempted);
    expect(outcome.databaseRollbackAvailable).toBe(handback ? true : undefined);
    if (handback) {
      expect(stdout).not.toHaveBeenCalled();
    } else {
      expect(stdout).toHaveBeenCalledWith("candidate finalization result\n");
    }
    if (pending || handback) {
      expect(complete).not.toHaveBeenCalled();
    } else {
      expect(complete).toHaveBeenCalledExactlyOnceWith(
        { activationVerified: false },
        expect.any(Function),
      );
    }
    expect(rollback).not.toHaveBeenCalled();
    if (windows) {
      expect(windowsRecovery.complete).toHaveBeenCalledWith(pending);
      expect(windowsRecovery.complete).not.toHaveBeenCalledWith(!pending);
    } else {
      expect(windowsRecovery.complete).not.toHaveBeenCalled();
    }
    await expect(
      fs.readFile(path.join(transaction.backupRoot, "package.json"), "utf8"),
    ).resolves.toContain('"version":"1.0.0"');
    await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
      '"version":"2.0.0"',
    );
    if (handback) {
      await expect(transaction.rollback(() => {})).resolves.toMatchObject({ exitCode: 0 });
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
    }
  },
);

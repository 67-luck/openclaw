import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import * as updateRunReader from "../infra/update-run-reader.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as installedCommand from "./schtasks.installed-command.test-support.js";
import {
  inspectInstalledUpdateFailure,
  type InstalledTask,
} from "./schtasks.installed-diagnostics.test-support.js";
import {
  createInstalledFileIoDescriptorFixture,
  createInstalledRetirementBaselineFixture,
  installedCandidateCheckNames as candidateCheckNames,
} from "./schtasks.installed-fileio-fixtures.test-support.js";
import * as installedFileIo from "./schtasks.installed-fileio.test-support.js";
import * as installedPackage from "./schtasks.installed-package.test-support.js";
import type { InstalledRetirementBaseline } from "./schtasks.installed-retirement-baseline.test-support.js";
import { runInstalledPublishedUpdate } from "./schtasks.installed-update.test-support.js";
import * as nativeObservation from "./schtasks.integration-observation.test-support.js";

const nativeSpawn = vi.hoisted(() =>
  vi.fn<
    (
      file: string,
      args: string[],
      options: SpawnSyncOptionsWithStringEncoding,
    ) => SpawnSyncReturns<string>
  >(),
);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  nativeSpawn.mockImplementation(actual.spawnSync);
  return { ...actual, spawnSync: nativeSpawn };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("published installed update progress", () => {
  const invokedAt = 1_800_000_000_000;
  const success = {
    status: "ok",
    mode: "npm",
    steps: candidateCheckNames.map((name) => ({ name, exitCode: 0, durationMs: 12 })),
  };
  const input: Awaited<ReturnType<typeof installedPackage.readInput>> = {
    sourceSha: "a".repeat(40),
    toolingSha: "b".repeat(40),
    tarball: "C:\\synthetic-candidate.tgz",
    candidate: {
      name: "openclaw",
      packageSourceSha: "a".repeat(40),
      version: "2026.9.26",
      sha256: "c".repeat(64),
    },
    installRoot: "C:\\synthetic-update\\prefix",
    stateRoot: "C:\\synthetic-update\\state",
    runtime: { version: "v24.0.0", sha256: "d".repeat(64) },
    artifact: {
      id: 1,
      runId: 2,
      runAttempt: 1,
      workflowSha: "b".repeat(40),
      digest: `sha256:${"e".repeat(64)}`,
    },
    published: ["2026.9.3", "2026.9.4"].map((version) => ({
      source: "npm-registry",
      version,
      commit: "f".repeat(40),
      tarball: `C:\\synthetic-${version}.tgz`,
      metadata: `C:\\synthetic-${version}.json`,
      sha256: "a".repeat(64),
      integrity: "sha512-synthetic",
    })),
  };
  const completedStep: UpdateRunRecord["steps"][number] = {
    step: "global update",
    status: "completed",
    startedAtMs: invokedAt + 1,
    endedAtMs: invokedAt + 2,
  };

  function recordedRun(
    steps: UpdateRunRecord["steps"],
    createdAtMs = invokedAt + 1,
  ): UpdateRunRecord {
    return {
      runId: "00000000-0000-0000-0000-000000000000",
      createdAtMs,
      updatedAtMs: invokedAt + 2,
      trigger: "cli",
      phase: "validating",
      status: "running",
      reason: null,
      origin: {},
      target: {},
      before: {},
      after: {},
      steps,
      verification: {},
      repair: [],
      confirmedAtMs: null,
      finishedAtMs: null,
      downtimeMs: null,
    };
  }

  function installedTask(): InstalledTask {
    return {
      profile: "synthetic-update",
      taskName: "OpenClaw Gateway (synthetic-update)",
      stateDir: "C:\\synthetic-update\\state",
      configPath: "C:\\synthetic-update\\state\\openclaw.json",
      scriptPath: "C:\\synthetic-update\\gateway.cmd",
      gatewayPort: 19417,
      rootDir: "C:\\synthetic-update",
      installRoot: "C:\\synthetic-update\\prefix",
      entry: "C:\\synthetic-update\\prefix\\openclaw.mjs",
      env: { OPENCLAW_STATE_DIR: "C:\\synthetic-update\\state" },
    };
  }

  const retirementBaseline = createInstalledRetirementBaselineFixture(invokedAt);

  function startUpdate(
    recordProgress = vi
      .fn<(phase: string, error?: Error) => Promise<void>>()
      .mockResolvedValue(undefined),
    observationCellDeadlineAt?: number,
    baseline?: InstalledRetirementBaseline,
    fileIo?: Parameters<typeof runInstalledPublishedUpdate>[0]["fileIo"],
  ) {
    const task = installedTask();
    const command = createDeferredCore<string>();
    vi.spyOn(installedCommand, "run").mockImplementation((...args) => {
      args[6]?.onStarted?.({
        launcherPid: 1199,
        commandPid: 1200,
        commandStartedAtMs: invokedAt,
        commandSpawnedAtMs: invokedAt + 1,
      });
      return command.promise;
    });
    const observations: Record<string, unknown> = {};
    const pending = runInstalledPublishedUpdate({
      task,
      input,
      inputPath: "C:\\synthetic-input.json",
      key: "2026.9.3",
      commands: [],
      signal: new AbortController().signal,
      observations,
      recordProgress,
      observationCellDeadlineAt,
      retirementBaseline: baseline,
      fileIo,
    });
    return { command, observations, pending, recordProgress };
  }

  const capacityObservation: Awaited<ReturnType<typeof installedPackage.recordCapacityBoundary>> = {
    boundary: "synthetic-update",
    cell: "2026.9.3",
    availableBytes: 100_000_000_000,
    freeBytes: 100_000_000_000,
    totalBytes: 200_000_000_000,
    profileHomeAvailableBytes: 100_000_000_000,
    expectedProfileState: [],
    installAndStaging: [],
    stateAndPreparation: null,
    scope: "synthetic capacity fixture",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(invokedAt);
    vi.spyOn(installedPackage, "recordCapacityBoundary").mockResolvedValue(capacityObservation);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["ready", "aborted", "unjoined", "failed-status"] as const)(
    "keeps post-failure status on the selected context and admitted lifetime (%s)",
    async (kind) => {
      vi.spyOn(updateRunReader, "listUpdateRunsAsync").mockResolvedValue([recordedRun([])]);
      const failure = new Error("Synthetic status inspection failure");
      const command = vi.spyOn(installedCommand, "run");
      if (kind === "failed-status") {
        command.mockRejectedValue(failure);
      } else {
        command.mockResolvedValue("{}");
      }
      const task = installedTask();
      const controller = new AbortController();
      if (kind === "aborted") {
        controller.abort();
      }
      const commands: installedCommand.CommandRecord[] =
        kind === "unjoined"
          ? [
              {
                args: ["update"],
                launcherPid: 1234,
                beforeCleanup: "indeterminate",
                code: 1,
                signal: null,
                joined: false,
                elapsedMs: 360_000,
              },
            ]
          : [];
      const observations: Record<string, unknown> = {};
      const pending = inspectInstalledUpdateFailure({
        task,
        commands,
        observations,
        signal: controller.signal,
      });
      if (kind === "failed-status") {
        await expect(pending).rejects.toBe(failure);
      } else {
        await pending;
      }
      expect(observations.updateFailure).toMatchObject({ phase: "validating", status: "running" });
      if (kind === "aborted" || kind === "unjoined") {
        expect(command).not.toHaveBeenCalled();
      } else {
        expect(command).toHaveBeenCalledWith(
          [
            task.entry,
            "--profile",
            task.profile,
            "gateway",
            "status",
            "--json",
            "--timeout",
            "5000",
          ],
          task.env,
          task.rootDir,
          commands,
          0,
          controller.signal,
          { observeService: "status" },
        );
      }
    },
  );

  it("reports only new completed steps, never elapsed time, prior runs, or repeated observations", async () => {
    const reader = vi
      .spyOn(updateRunReader, "listUpdateRunsAsync")
      .mockResolvedValue([recordedRun([completedStep], invokedAt - 1)]);
    const fixture = startUpdate();
    expect(fixture.recordProgress).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.recordProgress).not.toHaveBeenCalled();

    reader.mockResolvedValue([
      recordedRun([
        { step: "global update", status: "in_progress", startedAtMs: invokedAt + 1 },
        { step: "candidate check", status: "completed" },
      ]),
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.recordProgress).not.toHaveBeenCalled();

    reader.mockResolvedValue([recordedRun([completedStep])]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fixture.recordProgress.mock.calls.map(([phase]) => phase)).toEqual([
      "published-update:completed-step",
    ]);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(fixture.recordProgress).toHaveBeenCalledTimes(1);

    // The same named step can legitimately complete again at a later timestamp.
    reader.mockResolvedValue([recordedRun([{ ...completedStep, endedAtMs: invokedAt + 90_000 }])]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fixture.recordProgress).toHaveBeenCalledTimes(2);
    fixture.command.resolve(JSON.stringify(success));
    await expect(fixture.pending).resolves.toEqual(success);
    expect(fixture.recordProgress.mock.calls.map(([phase]) => phase)).toEqual([
      "published-update:completed-step",
      "published-update:completed-step",
      "command:update",
    ]);
  });

  it("does not invent progress when the ledger is absent or its read fails", async () => {
    const reader = vi.spyOn(updateRunReader, "listUpdateRunsAsync").mockResolvedValue([]);
    const fixture = startUpdate();
    await vi.advanceTimersByTimeAsync(30_000);
    reader.mockRejectedValue(new Error("synthetic unavailable ledger"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.recordProgress).not.toHaveBeenCalled();
    fixture.command.resolve(JSON.stringify(success));
    await expect(fixture.pending).resolves.toEqual(success);
    expect(fixture.recordProgress.mock.calls.map(([phase]) => phase)).toEqual(["command:update"]);
  });

  it("bounds terminal process snapshots to the current run without reporting new progress", async () => {
    const terminal = {
      ...recordedRun([completedStep]),
      phase: "finished" as const,
      status: "succeeded" as const,
      finishedAtMs: invokedAt + 3,
    };
    const reader = vi
      .spyOn(updateRunReader, "listUpdateRunsAsync")
      .mockResolvedValue([{ ...terminal, createdAtMs: invokedAt - 1 }]);
    const census = vi.spyOn(nativeObservation, "readRelatedProcessDiagnostics").mockReturnValue({
      ok: true,
      error: null,
      truncated: false,
      processes: [
        {
          ProcessId: 1234,
          ParentProcessId: 1200,
          CreationDate: "2026-09-26T19:40:00.0000000Z",
          CommandLine:
            'node openclaw.mjs update --token "synthetic-hidden-credential" ' + "x".repeat(3000),
        },
      ],
    });
    const fixture = startUpdate(undefined, undefined, retirementBaseline);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(census).not.toHaveBeenCalled();
    expect(fixture.recordProgress).not.toHaveBeenCalled();
    reader.mockResolvedValue([recordedRun([completedStep])]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fixture.recordProgress).toHaveBeenCalledTimes(1);
    reader.mockResolvedValue([terminal]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(census).toHaveBeenCalledTimes(1);
    expect(fixture.recordProgress).toHaveBeenCalledTimes(1);
    reader.mockResolvedValue([
      {
        ...terminal,
        runId: "different-run",
        steps: [{ ...completedStep, endedAtMs: invokedAt + 60_000 }],
      },
    ]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(census).toHaveBeenCalledTimes(1);
    reader.mockResolvedValue([terminal]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(census).toHaveBeenCalledTimes(2);
    expect(census).toHaveBeenCalledWith(
      ["synthetic-update", installedPackage.packageRoot(installedTask().installRoot)],
      expect.objectContaining({
        launcherPid: 1199,
        commandPid: 1200,
        commandStartedAtMs: invokedAt,
        commandSpawnedAtMs: invokedAt + 1,
        runId: terminal.runId,
        runCreatedAtMs: terminal.createdAtMs,
        globalRoot: retirementBaseline.globalRoot,
        expectedAddon: retirementBaseline.expectedAddon,
        expectedArgv: [
          installedTask().entry,
          "--profile",
          "synthetic-update",
          "update",
          "--yes",
          "--tag",
          input.tarball,
          "--json",
        ],
      }),
    );
    expect(fixture.recordProgress).toHaveBeenCalledTimes(1);
    expect(fixture.observations.updateSettlementProcesses).toEqual([
      expect.objectContaining({
        runId: terminal.runId,
        capturedAtMs: invokedAt + 45_000,
        phase: "finished",
        status: "succeeded",
        reason: "terminal",
        processes: [
          expect.objectContaining({
            pid: 1234,
            parentPid: 1200,
            createdAt: "2026-09-26T19:40:00.0000000Z",
          }),
        ],
      }),
      expect.objectContaining({
        runId: terminal.runId,
        capturedAtMs: invokedAt + 75_000,
        phase: "finished",
        status: "succeeded",
        reason: "follow-up",
      }),
    ]);
    const retained = JSON.stringify(fixture.observations.updateSettlementProcesses);
    expect(retained).not.toContain("synthetic-hidden-credential");
    expect(retained.length).toBeLessThan(5000);
    fixture.command.resolve(JSON.stringify(success));
    await expect(fixture.pending).resolves.toEqual(success);
    expect(fixture.recordProgress.mock.calls.map(([phase]) => phase)).toEqual([
      "published-update:completed-step",
      "command:update",
    ]);
  });

  it.each([true, false])(
    "routes actual installed censuses without early trace permission (prepared=%s)",
    async (prepared) => {
      const terminal = {
        ...recordedRun([]),
        phase: "finished" as const,
        status: "succeeded" as const,
      };
      vi.spyOn(updateRunReader, "listUpdateRunsAsync").mockResolvedValue([terminal]);
      nativeSpawn.mockClear();
      const runtime = createInstalledFileIoDescriptorFixture(retirementBaseline.globalRoot);
      const verify = vi
        .spyOn(installedFileIo, "verifyInstalledFileIoExecutable")
        .mockResolvedValue(undefined);
      const census = vi.spyOn(nativeObservation, "readRelatedProcessDiagnostics");
      const task = installedTask();
      const originalProcess = { pid: 1234, startTicks: "134000000000000000" };
      const args = [
        task.entry,
        "--profile",
        task.profile,
        "update",
        "--yes",
        "--tag",
        input.tarball,
        "--json",
      ];
      nativeSpawn.mockReturnValue({
        pid: 4321,
        status: 0,
        signal: null,
        output: [],
        stderr: "",
        stdout: JSON.stringify({
          processes: [],
          retirement: {
            startedAtMs: invokedAt + 15_000,
            finishedAtMs: invokedAt + 15_001,
            candidates: [
              {
                ...originalProcess,
                parentPid: 1200,
                createdAt: new Date(invokedAt).toISOString(),
                commandLine: [process.execPath, ...args].map((arg) => `"${arg}"`).join(" "),
                afterStartTicks: originalProcess.startTicks,
                hasExited: false,
                nodeReportedPath: process.execPath,
                moduleReportedPaths: [],
                modulesComplete: true,
                backupsComplete: true,
                backups: [],
                unavailable: [],
              },
            ],
          },
        }),
      });
      const fixture = startUpdate(
        undefined,
        undefined,
        retirementBaseline,
        prepared ? runtime : undefined,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      expect(nativeSpawn).toHaveBeenCalledTimes(1);
      expect(nativeSpawn.mock.calls[0]?.[0]).toBe(
        prepared ? runtime.powerShellExe : getWindowsPowerShellExePath(),
      );
      expect(nativeSpawn.mock.calls[0]?.[2]).toMatchObject({
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      });
      expect(census.mock.calls[0]?.[1]).not.toHaveProperty("fileIo");
      expect(fixture.observations.updateSettlementProcesses).toEqual([
        expect.objectContaining({ retirement: expect.objectContaining({ originalProcess }) }),
      ]);
      if (prepared) {
        const callback = vi.mocked(installedCommand.run).mock.calls[0]?.[6]
          ?.onCompletedTerminalJson;
        const capture = installedCommand.createInstalledTerminalJsonCapture(
          (value) => value,
          callback,
        );
        capture.observe(
          JSON.stringify({ status: "ok", mode: "npm", steps: [], durationMs: 0 }, null, 2) + "\n",
          false,
          Date.now(),
        );
      }
      await vi.advanceTimersByTimeAsync(15_000);
      expect(nativeSpawn).toHaveBeenCalledTimes(2);
      expect(nativeSpawn.mock.calls[1]?.[0]).toBe(
        prepared ? runtime.powerShellExe : getWindowsPowerShellExePath(),
      );
      if (prepared) {
        expect(census.mock.calls[1]?.[1]).toMatchObject({
          pinnedProcess: originalProcess,
          fileIo: { expectedGuid: runtime.expectedGuid },
        });
      } else {
        expect(census.mock.calls[1]?.[1]).not.toHaveProperty("fileIo");
      }
      expect(verify).toHaveBeenCalledTimes(prepared ? 4 : 0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(nativeSpawn).toHaveBeenCalledTimes(2);
      fixture.command.resolve(JSON.stringify(success));
      await expect(fixture.pending).resolves.toEqual(success);
    },
  );

  it.each(["pre-refused", "post-changed", "stopped", "cutoff"] as const)(
    "withholds actual update capture across runtime verification (%s)",
    async (scenario) => {
      const terminal = {
        ...recordedRun([]),
        phase: "finished" as const,
        status: "succeeded" as const,
      };
      vi.spyOn(updateRunReader, "listUpdateRunsAsync").mockResolvedValue([terminal]);
      const runtime = createInstalledFileIoDescriptorFixture(retirementBaseline.globalRoot);
      const refusal = new Error("Synthetic prepared runtime changed");
      const held = createDeferredCore();
      const verify = vi.spyOn(installedFileIo, "verifyInstalledFileIoExecutable");
      if (scenario === "pre-refused") {
        verify.mockRejectedValue(refusal);
      } else if (scenario === "post-changed") {
        verify.mockResolvedValueOnce(undefined).mockRejectedValueOnce(refusal);
      } else {
        verify.mockReturnValue(held.promise);
      }
      const census = vi.spyOn(nativeObservation, "readRelatedProcessDiagnostics").mockReturnValue({
        ok: true,
        error: null,
        truncated: false,
        processes: [],
        retirement: {
          runId: terminal.runId,
          limitation: "Diagnostic only",
          complete: true,
          originalProcess: { pid: 1234, startTicks: "134000000000000000" },
        },
      });
      const fixture = startUpdate(
        undefined,
        performance.now() + 1_080_000,
        retirementBaseline,
        runtime,
      );
      const outcome = fixture.pending.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      await vi.advanceTimersByTimeAsync(15_000);
      if (scenario === "stopped") {
        let joined = false;
        void outcome.then(() => {
          joined = true;
        });
        fixture.command.resolve(JSON.stringify(success));
        await vi.advanceTimersByTimeAsync(0);
        expect(joined).toBe(false);
        held.resolve();
      } else if (scenario === "cutoff") {
        await vi.advanceTimersByTimeAsync(451_000);
        held.resolve();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(census).toHaveBeenCalledTimes(scenario === "post-changed" ? 1 : 0);
      expect(fixture.observations.updateSettlementProcesses).toBeUndefined();
      if (scenario === "cutoff") {
        expect(fixture.observations.updateSettlementProcessCaptureUnavailable).toMatchObject({
          reason: "Less than 15000ms remains before the physical cutoff",
        });
      }
      const original = Object.assign(new Error("Synthetic original command cleanup uncertainty"), {
        processTreeState: "indeterminate",
      });
      if (scenario === "pre-refused") {
        fixture.command.reject(original);
      } else {
        fixture.command.resolve(JSON.stringify(success));
      }
      const settled = await outcome;
      if (scenario === "pre-refused") {
        expect(settled.error).toBeInstanceOf(AggregateError);
        if (!(settled.error instanceof AggregateError)) {
          throw new Error("Both failures must be retained");
        }
        expect(settled.error.errors).toEqual([original, refusal]);
        expect(hasUnjoinedWork(settled.error)).toBe(true);
      } else if (scenario === "post-changed") {
        expect(settled.error).toBe(refusal);
      } else {
        expect(settled).toEqual({ value: success, error: undefined });
      }
    },
  );

  it.each([false, true])(
    "keeps admission and completed history distinct (postCapture=%s)",
    async (postCapture) => {
      const terminal = {
        ...recordedRun([]),
        phase: "finished" as const,
        status: "succeeded" as const,
      };
      vi.spyOn(updateRunReader, "listUpdateRunsAsync").mockResolvedValue([terminal]);
      const runtime = createInstalledFileIoDescriptorFixture(retirementBaseline.globalRoot);
      const held = createDeferredCore();
      const verify = vi
        .spyOn(installedFileIo, "verifyInstalledFileIoExecutable")
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);
      if (postCapture) {
        verify.mockResolvedValueOnce(undefined);
      }
      verify.mockReturnValueOnce(held.promise);
      const census = vi.spyOn(nativeObservation, "readRelatedProcessDiagnostics").mockReturnValue({
        ok: true,
        error: null,
        truncated: false,
        processes: [],
        retirement: {
          runId: terminal.runId,
          limitation: "Diagnostic only",
          complete: true,
          originalProcess: { pid: 1234, startTicks: "134000000000000000" },
        },
      });
      const fixture = startUpdate(undefined, undefined, retirementBaseline, runtime);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(census).toHaveBeenCalledTimes(1);
      const callback = vi.mocked(installedCommand.run).mock.calls[0]?.[6]?.onCompletedTerminalJson;
      const capture = installedCommand.createInstalledTerminalJsonCapture(
        (value) => value,
        callback,
      );
      const terminalOutput =
        JSON.stringify({ status: "ok", mode: "npm", steps: [], durationMs: 0 }, null, 2) + "\n";
      capture.observe(terminalOutput, false, Date.now());
      const fact = capture.current();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(verify).toHaveBeenCalledTimes(postCapture ? 4 : 3);
      capture.observe(terminalOutput + "later output\n", false, Date.now());
      const final = capture.final(terminalOutput + "later output\n", false);
      expect(final.completedTerminalJson).toMatchObject({
        validAtJoin: false,
        stdoutRevisionAtJoin: 2,
      });
      expect(final.completedTerminalJson?.fact).toBe(fact);
      if (postCapture) {
        expect(census.mock.calls[1]?.[1]?.fileIo?.trigger?.terminalJson).toBe(fact);
        fixture.command.resolve(JSON.stringify(success));
      }
      held.resolve();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(census).toHaveBeenCalledTimes(postCapture ? 2 : 1);
      expect(fixture.observations.updateSettlementProcesses).toHaveLength(postCapture ? 2 : 1);
      fixture.command.resolve(JSON.stringify(success));
      await expect(fixture.pending).resolves.toEqual(success);
    },
  );

  it.each(["ready", "missing-pin", "invalidated", "different-run", "running", "late"] as const)(
    "reserves FileIO slot two for prior identity, terminal ledger, and live stdout (%s)",
    async (scenario) => {
      const terminal = {
        ...recordedRun([]),
        phase: "finished" as const,
        status: "succeeded" as const,
      };
      const reader = vi.spyOn(updateRunReader, "listUpdateRunsAsync").mockResolvedValue([terminal]);
      const originalProcess = { pid: 1234, startTicks: "134000000000000000" };
      const census = vi.spyOn(nativeObservation, "readRelatedProcessDiagnostics").mockReturnValue({
        ok: true,
        error: null,
        truncated: false,
        processes: [],
        retirement: {
          runId: terminal.runId,
          limitation: "Diagnostic only",
          complete: true,
          ...(scenario === "missing-pin" ? {} : { originalProcess }),
        },
      });
      const fileIo = createInstalledFileIoDescriptorFixture(retirementBaseline.globalRoot);
      vi.spyOn(installedFileIo, "verifyInstalledFileIoExecutable").mockResolvedValue(undefined);
      const fixture = startUpdate(undefined, undefined, retirementBaseline, fileIo);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(census).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(census).toHaveBeenCalledTimes(1);
      expect(census.mock.calls[0]?.[1]).not.toHaveProperty("fileIo");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(census).toHaveBeenCalledTimes(1);
      if (scenario === "late") {
        await vi.advanceTimersByTimeAsync(330_000);
        expect(census).toHaveBeenCalledTimes(1);
      }
      const callback = vi.mocked(installedCommand.run).mock.calls[0]?.[6]?.onCompletedTerminalJson;
      expect(callback).toBeTypeOf("function");
      const terminalCapture = installedCommand.createInstalledTerminalJsonCapture(
        (value) => value,
        callback,
      );
      terminalCapture.observe(
        JSON.stringify({ status: "ok", mode: "npm", steps: [], durationMs: 0 }, null, 2) + "\n",
        false,
        Date.now(),
      );
      const fact = terminalCapture.current();
      expect(fact).toBeDefined();
      if (scenario === "invalidated") {
        terminalCapture.invalidate();
      } else if (scenario === "different-run") {
        reader.mockResolvedValue([{ ...terminal, runId: "different-run" }]);
      } else if (scenario === "running") {
        reader.mockResolvedValue([{ ...terminal, phase: "verifying", status: "running" }]);
      }
      await vi.advanceTimersByTimeAsync(14_999);
      expect(census).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(census).toHaveBeenCalledTimes(scenario === "ready" ? 2 : 1);
      if (scenario === "ready") {
        expect(census.mock.calls[1]?.[1]).toMatchObject({
          pinnedProcess: originalProcess,
          fileIo: {
            ...fileIo,
            trigger: { terminalJson: fact, ledgerObservedAtMs: invokedAt + 45_000 },
          },
        });
      }
      await vi.advanceTimersByTimeAsync(45_000);
      expect(census).toHaveBeenCalledTimes(scenario === "ready" ? 2 : 1);
      fixture.command.resolve(JSON.stringify(success));
      await expect(fixture.pending).resolves.toEqual(success);
    },
  );

  it.each([
    { terminal: true, physicalMs: 480_000, secondAtMs: 450_000 },
    { terminal: false, physicalMs: 480_000, secondAtMs: 465_000 },
    { terminal: false, physicalMs: 361_000, secondAtMs: 345_000 },
  ])(
    "reserves the second snapshot for terminal=$terminal or cutoff=$physicalMs",
    async ({ terminal, physicalMs, secondAtMs }) => {
      const active = { ...recordedRun([completedStep]), phase: "verifying" as const };
      const reader = vi.spyOn(updateRunReader, "listUpdateRunsAsync").mockResolvedValue([active]);
      const census = vi.spyOn(nativeObservation, "readRelatedProcessDiagnostics").mockReturnValue({
        ok: true,
        error: null,
        truncated: false,
        processes: [],
      });
      const fixture = startUpdate(undefined, performance.now() + physicalMs + 180_000 + 180_000);
      await vi.advanceTimersByTimeAsync(299_999);
      expect(census).not.toHaveBeenCalled();
      expect(fixture.recordProgress.mock.calls.map(([phase]) => phase)).toEqual([
        "published-update:completed-step",
      ]);
      await vi.advanceTimersByTimeAsync(1);
      expect(census).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(census).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(secondAtMs - 315_000 - 15_000);
      expect(census).toHaveBeenCalledTimes(1);
      if (terminal) {
        reader.mockResolvedValue([{ ...active, phase: "finished", status: "succeeded" }]);
      }
      await vi.advanceTimersByTimeAsync(14_999);
      expect(census).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(census).toHaveBeenCalledTimes(2);
      expect(fixture.observations.updateSettlementProcesses).toEqual([
        expect.objectContaining({
          runId: active.runId,
          capturedAtMs: invokedAt + 300_000,
          phase: "verifying",
          status: "running",
          reason: "elapsed-300s",
        }),
        expect.objectContaining({
          capturedAtMs: invokedAt + secondAtMs,
          phase: terminal ? "finished" : "verifying",
          status: terminal ? "succeeded" : "running",
          reason: terminal ? "terminal" : "before-physical-cutoff",
        }),
      ]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(census).toHaveBeenCalledTimes(2);
      expect(fixture.recordProgress).toHaveBeenCalledTimes(1);
      const failure = new Error("Original acceptance limit exceeded; observation only");
      fixture.command.reject(failure);
      await expect(fixture.pending).rejects.toBe(failure);
      expect(fixture.recordProgress.mock.calls.map(([phase]) => phase)).toEqual([
        "published-update:completed-step",
        "command:update",
      ]);
    },
  );

  it("records diagnostic absence instead of starting a late terminal census or retrying it", async () => {
    const reader = vi.spyOn(updateRunReader, "listUpdateRunsAsync").mockResolvedValue([]);
    const census = vi.spyOn(nativeObservation, "readRelatedProcessDiagnostics");
    const fixture = startUpdate(undefined, performance.now() + 1_080_000);
    await vi.advanceTimersByTimeAsync(450_000);
    const delayed = createDeferredCore<UpdateRunRecord[]>();
    reader.mockReturnValueOnce(delayed.promise);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(5_000);
    const terminal = {
      ...recordedRun([]),
      phase: "finished" as const,
      status: "succeeded" as const,
    };
    reader.mockResolvedValue([terminal]);
    delayed.resolve([terminal]);
    await vi.advanceTimersByTimeAsync(0);
    expect(census).not.toHaveBeenCalled();
    expect(fixture.observations.updateSettlementProcessCaptureUnavailable).toMatchObject({
      runId: terminal.runId,
      phase: "finished",
      status: "succeeded",
      capturedAtMs: invokedAt + 470_000,
      reason: "Less than 15000ms remains before the physical cutoff",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(census).not.toHaveBeenCalled();
    expect(fixture.recordProgress).not.toHaveBeenCalled();
    const failure = new Error("Original acceptance limit exceeded; observation only");
    fixture.command.reject(failure);
    await expect(fixture.pending).rejects.toBe(failure);
  });

  it.each([
    { deadline: 1_080_000, limit: 480_000, refused: false },
    { deadline: 780_000, limit: 400_000, refused: false },
    { deadline: 740_000, limit: 360_000, refused: true },
    { deadline: 730_000, limit: 350_000, refused: true },
  ])(
    "reserves cleanup after capacity preparation (deadline=$deadline)",
    async ({ deadline, limit, refused }) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      vi.mocked(installedPackage.recordCapacityBoundary).mockImplementationOnce(async () => {
        now = 20_000;
        return capacityObservation;
      });
      const fixture = startUpdate(undefined, deadline);
      const outcome = fixture.pending.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.observations.naturalSettlementObservation).toMatchObject({
        acceptanceLimitMs: 360_000,
        physicalLimitMs: limit,
        cleanupReserveMs: 180_000,
        failureInspectionReserveMs: 180_000,
      });
      if (refused) {
        expect(installedCommand.run).not.toHaveBeenCalled();
        expect(String((await outcome).error)).toContain("Insufficient cell lifetime");
      } else {
        expect(vi.mocked(installedCommand.run).mock.calls[0]?.[6]).toEqual({
          commandBudget: "published-update",
          physicalObservationLimitMs: limit,
        });
        expect(now + limit + 180_000 + 180_000).toBeLessThanOrEqual(deadline);
        fixture.command.resolve(JSON.stringify(success));
        expect((await outcome).value).toEqual(success);
      }
    },
  );

  it.each(["returned", "thrown"] as const)(
    "keeps a %s process observation failure diagnostic without failing the updater",
    async (failure) => {
      vi.spyOn(updateRunReader, "listUpdateRunsAsync").mockResolvedValue([
        { ...recordedRun([]), phase: "finished", status: "succeeded", finishedAtMs: invokedAt + 3 },
      ]);
      vi.spyOn(nativeObservation, "readRelatedProcessDiagnostics").mockImplementation(() => {
        const error = "observation failed token=synthetic-hidden-credential";
        if (failure === "thrown") {
          throw new Error(error);
        }
        return { ok: false, error, processes: [], truncated: false };
      });
      const fixture = startUpdate();
      await vi.advanceTimersByTimeAsync(45_000);
      expect(fixture.observations.updateSettlementProcesses).toEqual([
        expect.objectContaining({ unavailable: expect.any(String) }),
        expect.objectContaining({ unavailable: expect.any(String) }),
      ]);
      expect(JSON.stringify(fixture.observations)).not.toContain("synthetic-hidden-credential");
      expect(fixture.recordProgress).not.toHaveBeenCalled();
      fixture.command.resolve(JSON.stringify(success));
      await expect(fixture.pending).resolves.toEqual(success);
      expect(fixture.recordProgress.mock.calls.map(([phase]) => phase)).toEqual(["command:update"]);
    },
  );

  it("joins an outstanding ledger read before command completion and stops future observation", async () => {
    const read = createDeferredCore<UpdateRunRecord[]>();
    const reader = vi.spyOn(updateRunReader, "listUpdateRunsAsync").mockReturnValue(read.promise);
    const fixture = startUpdate();
    let settled = false;
    const pending = fixture.pending.then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reader).toHaveBeenCalled();
    fixture.command.resolve(JSON.stringify(success));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(fixture.recordProgress).not.toHaveBeenCalled();
    read.resolve([]);
    await expect(pending).resolves.toEqual(success);
    const readsAtReturn = reader.mock.calls.length;
    const writesAtReturn = fixture.recordProgress.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reader).toHaveBeenCalledTimes(readsAtReturn);
    expect(fixture.recordProgress).toHaveBeenCalledTimes(writesAtReturn);
    expect(fixture.recordProgress.mock.calls.map(([phase]) => phase)).toEqual(["command:update"]);
  });

  it("joins an outstanding evidence write before recording command completion", async () => {
    vi.spyOn(updateRunReader, "listUpdateRunsAsync").mockResolvedValue([
      recordedRun([completedStep]),
    ]);
    const write = createDeferredCore();
    const events: string[] = [];
    const recordProgress = vi.fn(async (phase: string) => {
      if (phase === "published-update:completed-step") {
        events.push("step write started");
        await write.promise;
        events.push("step write completed");
      } else {
        events.push(phase);
      }
    });
    const fixture = startUpdate(recordProgress);
    let settled = false;
    const pending = fixture.pending.then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events).toEqual(["step write started"]);
    fixture.command.resolve(JSON.stringify(success));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(events).toEqual(["step write started"]);
    write.resolve();
    await expect(pending).resolves.toEqual(success);
    expect(events).toEqual(["step write started", "step write completed", "command:update"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toEqual(["step write started", "step write completed", "command:update"]);
  });

  it.each(["command", "observation", "both"] as const)(
    "preserves %s failure instead of reporting successful proof",
    async (failureKind) => {
      vi.spyOn(updateRunReader, "listUpdateRunsAsync").mockResolvedValue([
        recordedRun([completedStep]),
      ]);
      const commandFailure = new Error("synthetic command failed");
      const writeFailure = new Error("synthetic evidence write failed");
      const recordProgress = vi.fn(async (phase: string) => {
        if (phase === "published-update:completed-step" && failureKind !== "command") {
          throw writeFailure;
        }
      });
      const fixture = startUpdate(recordProgress);
      // Attach both handlers before rejection; a rejection must not become an unhandled test error.
      const outcome = fixture.pending.then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(15_000);
      if (failureKind === "observation") {
        fixture.command.resolve(JSON.stringify(success));
      } else {
        fixture.command.reject(commandFailure);
      }
      const { error } = await outcome;
      if (failureKind === "command") {
        expect(error).toBe(commandFailure);
      } else if (failureKind === "observation") {
        expect(error).toBe(writeFailure);
      } else {
        expect(error).toBeInstanceOf(AggregateError);
        if (!(error instanceof AggregateError)) {
          throw new Error("Both failures must remain available to the proof reporter");
        }
        expect(error.errors).toEqual(expect.arrayContaining([commandFailure, writeFailure]));
      }
    },
  );
});

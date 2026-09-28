import assert from "node:assert/strict";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { sleep } from "../utils/sleep.js";
import {
  captureInstalledUpdateProcesses,
  MAX_SETTLEMENT_OBSERVATION_MS,
  PUBLISHED_UPDATE_ACCEPTANCE_MS,
  run,
  type CommandRecord,
  type CompletedTerminalJsonObservation,
  type InstalledPublishedCommandStart,
} from "./schtasks.installed-command.test-support.js";
import {
  readInstalledUpdateProgress,
  parseInstalledUpdateResult,
  type InstalledTask,
} from "./schtasks.installed-diagnostics.test-support.js";
import {
  packageRoot,
  type readInput,
  recordCapacityBoundary,
  requiredCellSpace,
} from "./schtasks.installed-package.test-support.js";
import type { InstalledRetirementBaseline } from "./schtasks.installed-retirement-baseline.test-support.js";
import type { InstalledUpdateRetirementBinding } from "./schtasks.installed-retirement-observation.test-support.js";

export async function runInstalledPublishedUpdate(params: {
  task: InstalledTask;
  input: Awaited<ReturnType<typeof readInput>>;
  inputPath: string;
  key: "2026.9.3" | "2026.9.4";
  commands: CommandRecord[];
  signal: AbortSignal;
  observations: Record<string, unknown>;
  recordProgress: (phase: string, error?: Error) => Promise<void>;
  observationCellDeadlineAt?: number;
  retirementBaseline?: InstalledRetirementBaseline;
  fileIo?: InstalledUpdateRetirementBinding["fileIo"];
}) {
  const { task, input, inputPath, key, commands, signal, observations, recordProgress } = params;
  const before = await recordCapacityBoundary(inputPath, input, key, "before-published-update");
  const { forecast } = requiredCellSpace(key);
  const needed =
    forecast.upgradeStaging +
    forecast.runtimeNpmCache +
    forecast.retainedStateAndProof +
    forecast.freeFloor;
  assert.ok(
    before.availableBytes >= needed,
    `Published updater needs ${needed} additional available bytes under the provisional forecast; observed ${before.availableBytes}; update not started`,
  );
  const startedAt = Date.now();
  const stopObservation = new AbortController();
  const completed = new Set<string>();
  let observedRunId: string | undefined;
  let commandStart: InstalledPublishedCommandStart | undefined;
  let terminalJson: CompletedTerminalJsonObservation | undefined;
  let pinnedProcess: { pid: number; startTicks: string } | undefined;
  const expectedArgv = Object.freeze([
    task.entry,
    "--profile",
    task.profile,
    "update",
    "--yes",
    "--tag",
    input.tarball,
    "--json",
  ]);
  if (params.retirementBaseline) {
    observations.publishedNativeModuleBefore = params.retirementBaseline;
  }
  let physicalCutoffAt = Infinity;
  let processObservationWindowClosed = false;
  const settlementProcesses: ReturnType<typeof captureInstalledUpdateProcesses>[] = [];
  let observationFailure: Error | undefined;
  const observation = (async () => {
    while (!stopObservation.signal.aborted) {
      try {
        await sleep(15_000, stopObservation.signal);
      } catch (error) {
        if (stopObservation.signal.aborted) {
          return;
        }
        throw error;
      }
      const progress = await readInstalledUpdateProgress(task);
      if (stopObservation.signal.aborted) {
        return;
      }
      if ("unavailable" in progress || progress.createdAtMs < startedAt) {
        continue;
      }
      observedRunId ??= progress.runId;
      if (progress.runId !== observedRunId) {
        continue;
      }
      const remainingMs = physicalCutoffAt - performance.now();
      const snapshotReason =
        settlementProcesses[0]?.reason === "terminal"
          ? "follow-up"
          : progress.phase === "finished" && progress.status !== "running"
            ? "terminal"
            : settlementProcesses.length === 0 && Date.now() - startedAt >= 300_000
              ? "elapsed-300s"
              : settlementProcesses.length === 1 && remainingMs >= 15_000 && remainingMs < 30_000
                ? "before-physical-cutoff"
                : undefined;
      if (
        !processObservationWindowClosed &&
        settlementProcesses.length < 2 &&
        remainingMs < 15_000
      ) {
        processObservationWindowClosed = true;
        observations.updateSettlementProcessCaptureUnavailable = {
          runId: progress.runId,
          phase: progress.phase,
          status: progress.status,
          capturedAtMs: Date.now(),
          reason: "Less than 15000ms remains before the physical cutoff",
        };
      }
      const fileIoTrigger =
        params.fileIo &&
        settlementProcesses.length === 1 &&
        pinnedProcess &&
        terminalJson &&
        progress.phase === "finished" &&
        progress.status !== "running"
          ? { terminalJson, ledgerObservedAtMs: Date.now() }
          : undefined;
      if (
        !processObservationWindowClosed &&
        snapshotReason &&
        settlementProcesses.length < 2 &&
        (!params.fileIo || settlementProcesses.length === 0 || fileIoTrigger)
      ) {
        const capture = captureInstalledUpdateProcesses(
          task,
          [task.profile, packageRoot(task.installRoot)],
          progress,
          snapshotReason,
          params.retirementBaseline && commandStart
            ? {
                ...commandStart,
                entry: task.entry,
                profile: task.profile,
                expectedArgv,
                expectedNodeExe: process.execPath,
                runId: progress.runId,
                runCreatedAtMs: progress.createdAtMs,
                globalRoot: params.retirementBaseline.globalRoot,
                namespaceWasEmpty: params.retirementBaseline.namespaceWasEmpty,
                expectedAddon: params.retirementBaseline.expectedAddon,
                pinnedProcess,
                ...(fileIoTrigger ? { fileIo: { ...params.fileIo!, trigger: fileIoTrigger } } : {}),
              }
            : undefined,
        );
        if (
          settlementProcesses.length === 0 &&
          "retirement" in capture &&
          capture.retirement?.originalProcess
        ) {
          pinnedProcess ??= capture.retirement.originalProcess;
        }
        if (params.retirementBaseline && !commandStart) {
          observations.updateRetirementUnavailable =
            "Managed command spawn identity was not observed";
        }
        settlementProcesses.push(capture);
        // Diagnostics wait for an ordinary proof write; they are not durable update progress.
        observations.updateSettlementProcesses = settlementProcesses;
      }
      const newSteps = progress.steps.filter((step) => {
        if (step.status !== "completed" || step.endedAtMs === undefined) {
          return false;
        }
        const identity = JSON.stringify([progress.createdAtMs, step.step, step.endedAtMs]);
        if (completed.has(identity)) {
          return false;
        }
        completed.add(identity);
        return true;
      });
      if (newSteps.length > 0) {
        observations.updateProgress = progress;
        await recordProgress("published-update:completed-step");
      }
    }
  })().catch((error: unknown) => {
    observationFailure = toErrorObject(error, "Installed update progress recording failed");
  });
  let output = "";
  let failure: Error | undefined;
  try {
    const commandStartedAt = performance.now();
    const physicalObservationLimitMs =
      params.observationCellDeadlineAt === undefined
        ? undefined
        : Math.floor(
            Math.min(
              MAX_SETTLEMENT_OBSERVATION_MS,
              params.observationCellDeadlineAt - commandStartedAt - 180_000 - 180_000,
            ),
          );
    if (physicalObservationLimitMs !== undefined) {
      observations.naturalSettlementObservation = {
        acceptanceLimitMs: PUBLISHED_UPDATE_ACCEPTANCE_MS,
        physicalLimitMs: physicalObservationLimitMs,
        cleanupReserveMs: 180_000,
        failureInspectionReserveMs: 180_000,
        qualification: "Observation only; completion after acceptance remains a failure",
      };
      assert.ok(
        physicalObservationLimitMs > PUBLISHED_UPDATE_ACCEPTANCE_MS,
        "Insufficient cell lifetime for natural-settlement observation, 180000ms failure inspection, and 180000ms cleanup reserve",
      );
    }
    physicalCutoffAt =
      commandStartedAt + (physicalObservationLimitMs ?? PUBLISHED_UPDATE_ACCEPTANCE_MS);
    // Execute the unchanged published CLI; the observer neither injects markers nor changes state.
    output = await run([...expectedArgv], task.env, task.rootDir, commands, 0, signal, {
      commandBudget: "published-update",
      physicalObservationLimitMs,
      ...(params.fileIo
        ? {
            onCompletedTerminalJson: (fact: CompletedTerminalJsonObservation | undefined) => {
              terminalJson = fact;
            },
          }
        : {}),
      ...(params.retirementBaseline
        ? {
            onStarted: (facts: InstalledPublishedCommandStart) => {
              commandStart = facts;
            },
          }
        : {}),
    });
  } catch (error) {
    failure = toErrorObject(error, "Installed published update failed");
  } finally {
    stopObservation.abort();
    // Join an in-flight read or evidence write before final command recording and native cleanup.
    await observation;
  }
  if (observationFailure) {
    failure = failure
      ? new AggregateError(
          [failure, observationFailure],
          "Installed update and progress recording failed",
        )
      : observationFailure;
  }
  try {
    await recordProgress("command:update", failure);
  } catch (error) {
    throw new AggregateError(
      failure ? [failure, error] : [error],
      "Installed update proof recording failed",
      { cause: error },
    );
  }
  if (failure) {
    throw failure;
  }
  await recordCapacityBoundary(inputPath, input, key, "after-published-update");
  return parseInstalledUpdateResult(JSON.parse(output));
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { hashFile, hashInstall } from "../../scripts/lib/gateway-bench-installed-package.ts";
import { resolveTaskLauncherScriptPath } from "./schtasks-layout.js";
import {
  PUBLISHED_94_CONTAINMENT_REASON,
  type CommandRecord,
} from "./schtasks.installed-command.test-support.js";
import {
  captureContainmentState,
  compareContainmentState,
  summarizeContainmentState,
} from "./schtasks.installed-containment-state.test-support.js";
import type { InstalledTask } from "./schtasks.installed-diagnostics.test-support.js";
import {
  readRelatedProcessDiagnostics,
  readTaskPrincipal,
  readTaskXml,
} from "./schtasks.integration-observation.test-support.js";

const reason = PUBLISHED_94_CONTAINMENT_REASON;
const canaryName = "containment-user-canary";
const canaryFiles = ["notes.txt", "attachment.bin"];
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export async function seedContainmentCanaries(stateDir: string) {
  const root = path.join(stateDir, canaryName);
  await fs.mkdir(root);
  await fs.writeFile(
    path.join(root, canaryFiles[0]!),
    "Synthetic user note: preserve exact bytes.\r\n",
  );
  await fs.writeFile(path.join(root, canaryFiles[1]!), Buffer.from([0, 1, 2, 127, 128, 255]));
}

/** This is a producer-message witness, not a typed error code or a grant of authority. */
export function assertContainmentRefusal(
  record: Pick<
    CommandRecord,
    "code" | "managedResult" | "signal" | "joined" | "beforeCleanup" | "failureOutput"
  > & { publishedUpdate?: unknown },
): string {
  assert.equal(record.code, 1);
  assert.equal(record.managedResult, 1, "Managed command did not return normally");
  assert.equal(record.signal, null);
  assert.equal(record.joined, true);
  assert.equal(record.beforeCleanup, "dead");
  assert.equal(record.failureOutput?.captureTruncated, false);
  const result = asOptionalRecord(record.publishedUpdate);
  assert.equal(result?.status, "error");
  assert.equal(result?.stepsOmitted, 0);
  const runId = result?.runId;
  assert.ok(
    typeof runId === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(runId),
  );
  assert.equal(asOptionalRecord(result?.before)?.version, "2026.9.4");
  assert.ok(Array.isArray(result?.steps) && result.steps.length > 0);
  const steps = result.steps.map(asOptionalRecord);
  const failed = steps.find((step) => step?.exitCode !== 0);
  assert.equal(failed?.name, "candidate migration rehearsal");
  assert.equal(failed?.exitCode, 1);
  assert.equal(
    failed?.containmentRefusalReasonWitness,
    true,
    "Published canary did not retain the complete producer-specific refusal reason line",
  );
  assert.equal(
    steps.some((step) =>
      /^(?:global package swap|openclaw doctor|post-update verification)$/u.test(
        String(step?.name),
      ),
    ),
    false,
  );
  return runId;
}

async function captureTask(task: InstalledTask, pid: number) {
  const xml = await readTaskXml(task.taskName);
  assert.ok(xml, "Task definition is unavailable");
  const principal = readTaskPrincipal(task.taskName);
  assert.equal(principal.enabled, true);
  assert.equal(principal.taskState, 4);
  const capture = readRelatedProcessDiagnostics([task.profile]);
  assert.equal(capture.ok, true, "Native process inspection failed");
  assert.equal(capture.truncated, false);
  const process = capture.processes.find((entry) => entry.ProcessId === pid);
  assert.ok(process && typeof process.CreationDate === "string" && process.CreationDate.length > 0);
  return {
    pid,
    creationDate: process.CreationDate,
    principal,
    xmlSha256: sha256(xml),
    commandSha256: await hashFile(task.scriptPath),
    launcherSha256: await hashFile(resolveTaskLauncherScriptPath(task.env, task.scriptPath)),
    configSha256: await hashFile(task.configPath),
    install: await hashInstall(task.installRoot),
    canaries: await Promise.all(
      canaryFiles.map((name) => hashFile(path.join(task.stateDir, canaryName, name))),
    ),
  };
}

/** Always rethrow the actual updater failure; containment never relabels the three-cell campaign. */
export async function observeInstalledContainment(params: {
  selected: InstalledTask;
  peer: InstalledTask;
  selectedPid: number;
  peerPid: number;
  commands: CommandRecord[];
  observations: Record<string, unknown>;
  signal: AbortSignal;
  runUpdate: () => Promise<unknown>;
  verifyServing: () => Promise<{ selectedPid: number; peerPid: number }>;
  recordProgress: (phase: string, error?: Error) => Promise<void>;
}): Promise<never> {
  const { selected, peer, commands, observations, signal, recordProgress } = params;
  const before: Partial<Record<"selected" | "peer", Awaited<ReturnType<typeof captureTask>>>> = {};
  const after: typeof before = {};
  const stateBefore: Partial<
    Record<"selected" | "peer", ReturnType<typeof summarizeContainmentState>>
  > = {};
  const stateAfter: typeof stateBefore = {};
  const state: Partial<Record<"selected" | "peer", ReturnType<typeof compareContainmentState>>> =
    {};
  // Keep one evidence object so later failures cannot discard completed observations.
  const evidence = {
    qualified: false,
    phase: "capturing-before",
    before,
    after,
    stateBefore,
    stateAfter,
    state,
  };
  observations.containment = evidence;
  before.selected = await captureTask(selected, params.selectedPid);
  before.peer = await captureTask(peer, params.peerPid);
  const selectedState = await captureContainmentState(selected, signal);
  stateBefore.selected = summarizeContainmentState(selectedState);
  const peerState = await captureContainmentState(peer, signal);
  stateBefore.peer = summarizeContainmentState(peerState);
  const states = { selected: selectedState, peer: peerState };
  const selectedShared = states.selected.find(
    (db) => db.identity === sha256("state/openclaw.sqlite"),
  );
  assert.equal(selectedShared?.userVersion, 17);
  assert.equal(selectedShared?.contentVersion, 17);
  evidence.phase = "before-command";
  await recordProgress("containment:before-command");
  const commandIndex = commands.length;
  let failure: unknown;
  try {
    await params.runUpdate();
  } catch (error) {
    failure = error;
  }
  try {
    assert.ok(
      failure instanceof Error && !(failure instanceof AggregateError),
      "Expected the original joined command refusal",
    );
    assert.equal(commands.length, commandIndex + 1, "Unexpected command during published update");
    const runId = assertContainmentRefusal(commands[commandIndex]!);
    Object.assign(evidence, { runId, commandIndex, phase: "capturing-after-state" });
    // Capture before extra RPC/status probes can contribute their own operational writes.
    const selectedAfter = await captureContainmentState(selected, signal);
    stateAfter.selected = summarizeContainmentState(selectedAfter);
    const peerAfter = await captureContainmentState(peer, signal);
    stateAfter.peer = summarizeContainmentState(peerAfter);
    evidence.phase = "comparing-state";
    state.selected = compareContainmentState(states.selected, selectedAfter, runId);
    state.peer = compareContainmentState(states.peer, peerAfter);
    const serving = await params.verifyServing();
    Object.assign(evidence, { serving, phase: "capturing-after-native" });
    after.selected = await captureTask(selected, serving.selectedPid);
    after.peer = await captureTask(peer, serving.peerPid);
    assert.equal(serving.selectedPid, params.selectedPid);
    assert.equal(serving.peerPid, params.peerPid);
    assert.deepEqual(
      after,
      before,
      "Selected or peer native definition/process/package/user files changed",
    );
    Object.assign(evidence, {
      qualified: true,
      phase: "refused-before-activation",
      reasonWitness: reason,
      typedErrorCodeObserved: false,
      automaticUpdateQualified: false,
      recoveryCompletionQualified: false,
    });
    await recordProgress("containment:qualified-refusal");
  } catch (observationFailure) {
    evidence.qualified = false;
    evidence.phase = "verification-failed";
    throw new AggregateError(
      failure ? [failure, observationFailure] : [observationFailure],
      "Published update containment was not qualified",
      { cause: observationFailure },
    );
  }
  throw failure;
}

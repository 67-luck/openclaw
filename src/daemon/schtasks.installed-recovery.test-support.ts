import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { z } from "zod";
import {
  hashInstall,
  hashFile,
  prepareInstalledPackage,
} from "../../scripts/lib/gateway-bench-installed-package.ts";
import { run, type CommandRecord } from "./schtasks.installed-command.test-support.js";
import {
  readInstalledUpdateProgress,
  runInstalledPublishedUpdate,
  type InstalledTask,
} from "./schtasks.installed-diagnostics.test-support.js";
import {
  describeFailure,
  type installedStatusSchema,
  packageRoot,
  readInstalledBuildIdentity,
  type readInput,
  samePath,
} from "./schtasks.installed-package.test-support.js";
import {
  normalizeScheduledTaskXmlEnabledForFixture,
  readTaskPrincipal,
  readTaskXml,
} from "./schtasks.integration-observation.test-support.js";

async function verifyInstalledRecoveryContinuity(
  params: {
    selected: InstalledTask;
    peer: InstalledTask;
    configBefore: Buffer;
    peerXml: Awaited<ReturnType<typeof readTaskXml>>;
    peerConfig: Buffer;
    peerInstallBefore: Awaited<ReturnType<typeof hashInstall>>;
    peerIdentity: Awaited<ReturnType<typeof readInstalledBuildIdentity>>;
    peerPid: number;
    awaitReadiness: (task: InstalledTask, phase: string) => Promise<void>;
    readStatus: (
      task: InstalledTask,
      identity: Awaited<ReturnType<typeof readInstalledBuildIdentity>>,
    ) => Promise<z.infer<typeof installedStatusSchema>>;
  },
  identity: Awaited<ReturnType<typeof readInstalledBuildIdentity>>,
) {
  const { selected, peer } = params;
  await params.awaitReadiness(selected, "explicit-recovery-startup");
  const selectedAfter = await params.readStatus(selected, identity);
  assert.deepEqual(
    JSON.parse(await fs.readFile(selected.configPath, "utf8")).gateway,
    JSON.parse(params.configBefore.toString()).gateway,
  );
  assert.equal(await readTaskXml(peer.taskName), params.peerXml);
  assert.deepEqual(await fs.readFile(peer.configPath), params.peerConfig);
  const peerAfter = await params.readStatus(peer, params.peerIdentity);
  assert.equal(peerAfter.service.runtime.pid, params.peerPid);
  assert.deepEqual(await hashInstall(peer.installRoot), params.peerInstallBefore);
  return { selected: selectedAfter, peer: peerAfter, peerPreserved: true };
}

/** Explicit operator recovery is separate evidence; it cannot make the failed updater pass. */
async function observeInstalledOperatorRecovery(params: {
  task: InstalledTask;
  input: Awaited<ReturnType<typeof readInput>>;
  commands: CommandRecord[];
  signal: AbortSignal;
  observations: Record<string, unknown>;
  originalFailure: unknown;
  recordProgress: (phase: string, error?: Error) => Promise<void>;
  verifyStarted: (
    identity: Awaited<ReturnType<typeof readInstalledBuildIdentity>>,
  ) => Promise<unknown>;
}) {
  const { task, input, commands, signal, observations, recordProgress } = params;
  signal.throwIfAborted();
  assert.ok(
    commands.every((command) => command.joined),
    "Recovery requires joined commands",
  );
  const published = commands.at(-1);
  assert.ok(published);
  assert.deepEqual(published.args.slice(0, 5), [
    task.entry,
    "--profile",
    task.profile,
    "update",
    "--yes",
  ]);
  assert.equal(published.code, 1, "Recovery observation requires a failed published command");
  assert.equal(published.managedResult, 1, "Recovery requires a normal managed command return");
  assert.equal(published.signal, null);
  assert.ok(published.elapsedMs < 360_000, "Recovery observation requires an uncapped failure");
  const original = await readInstalledUpdateProgress(task);
  assert.ok(
    "runId" in original && typeof original.runId === "string" && original.runId.length > 0,
    "Recovery requires the original recorded update run",
  );
  const proof: Record<string, unknown> = {
    qualified: false,
    scope:
      "Explicit installed update repair and service start; original published failure retained",
    originalFailure: describeFailure(params.originalFailure),
    originalRun: original,
    phase: "candidate-validation",
  };
  observations.explicitRecovery = proof;
  await recordProgress("explicit-recovery:before");
  const before = await prepareInstalledPackage({ ...input, installRoot: task.installRoot });
  const identity = await readInstalledBuildIdentity(task.installRoot, input.candidate.version);
  const { resolveTaskLauncherScriptPath } = await import("./schtasks-layout.js");
  const selectedPaths = [
    ...new Set([
      task.configPath,
      task.scriptPath,
      resolveTaskLauncherScriptPath(task.env, task.scriptPath),
    ]),
  ];
  const readSelectedDefinition = async () => {
    const xml = await readTaskXml(task.taskName);
    assert.ok(xml);
    return {
      principal: readTaskPrincipal(task.taskName),
      definitionSha256: createHash("sha256")
        .update(normalizeScheduledTaskXmlEnabledForFixture(xml))
        .digest("hex"),
      files: await Promise.all(
        selectedPaths.map(async (pathname) => ({ pathname, sha256: await hashFile(pathname) })),
      ),
    };
  };
  proof.beforeRepair = await readSelectedDefinition();
  signal.throwIfAborted();
  const invoke = (args: string[], observeCommand?: "repair" | "status" | "start") =>
    run(
      [task.entry, "--profile", task.profile, ...args],
      task.env,
      task.rootDir,
      commands,
      0,
      signal,
      { observeCommand },
    );
  const invokeObserved = async (
    args: string[],
    kind: "repair" | "start",
    snapshot: "afterRepairDefinition" | "afterStart",
  ) => {
    let output = "";
    let commandFailure: Error | undefined;
    let definition: Awaited<ReturnType<typeof readSelectedDefinition>>;
    try {
      output = await invoke(args, kind);
    } catch (error) {
      commandFailure = toErrorObject(error, "Recovery command failed");
    }
    try {
      signal.throwIfAborted();
      assert.ok(
        commands.every((command) => command.joined),
        "Snapshot requires joined commands",
      );
      definition = await readSelectedDefinition();
      proof[snapshot] = definition;
    } catch (snapshotFailure) {
      throw commandFailure
        ? new AggregateError([commandFailure, snapshotFailure], "Command and snapshot failed")
        : toErrorObject(snapshotFailure, "Recovery snapshot failed");
    }
    if (commandFailure) {
      throw commandFailure;
    }
    return { output, definition };
  };
  // Doctor may repair the selected definition; retain that change separately from start.
  const repairOutput = await invokeObserved(
    ["update", "repair", "--yes", "--json"],
    "repair",
    "afterRepairDefinition",
  );
  proof.repair = commands.at(-1)?.repairOutput;
  await recordProgress("explicit-recovery:repair-returned");
  const repaired = z
    .object({
      status: z.enum(["ok", "warning"]),
      mode: z.literal("finalize"),
      root: z.string(),
      restart: z.literal(false),
      reconciledRuns: z.array(z.string()),
      postUpdate: z.object({
        doctor: z.object({ warnings: z.array(z.string()).optional() }),
        plugins: z.object({ status: z.enum(["ok", "warning"]) }),
      }),
    })
    .parse(JSON.parse(repairOutput.output));
  samePath(repaired.root, packageRoot(task.installRoot));
  assert.ok(repaired.reconciledRuns.includes(original.runId));
  const after = await prepareInstalledPackage({ ...input, installRoot: task.installRoot });
  proof.candidateInstall = { before: before.before, after: after.before };
  assert.deepEqual(after.before, before.before, "Repair changed the selected fixture installation");
  assert.deepEqual(
    await readInstalledBuildIdentity(task.installRoot, input.candidate.version),
    identity,
    "Repair changed the validated candidate identity",
  );
  signal.throwIfAborted();
  proof.phase = "repair-finished";
  await recordProgress("explicit-recovery:repair-finished");
  const afterRepair = z
    .object({
      service: z.object({
        loaded: z.literal(true),
        runtime: z.object({ status: z.literal("stopped"), state: z.string().optional() }),
      }),
      rpc: z.object({ ok: z.literal(false) }),
    })
    .parse(
      JSON.parse(await invoke(["gateway", "status", "--json", "--timeout", "5000"], "status")),
    );
  proof.afterRepair = afterRepair;
  await recordProgress("explicit-recovery:stopped-state-preserved");
  const beforeStart = await readSelectedDefinition();
  proof.beforeStart = beforeStart;
  assert.equal(
    beforeStart.principal.enabled,
    false,
    "Repair must retain the failed fixture's disabled policy",
  );
  const startAttempt = await invokeObserved(["gateway", "start", "--json"], "start", "afterStart");
  const started = z
    .object({ ok: z.literal(true), result: z.enum(["started", "already-running"]) })
    .parse(JSON.parse(startAttempt.output));
  proof.start = started;
  proof.phase = "start-returned";
  await recordProgress("explicit-recovery:start-returned");
  const afterStart = startAttempt.definition;
  assert.equal(afterStart.principal.enabled, true);
  assert.equal(afterStart.definitionSha256, beforeStart.definitionSha256);
  assert.deepEqual(afterStart.files, beforeStart.files);
  proof.verified = await params.verifyStarted(identity);
  proof.qualified = true;
  proof.phase = "verified";
  await recordProgress("explicit-recovery:verified");
}

export async function runInstalledPublishedUpdateWithRecovery(
  params: Parameters<typeof runInstalledPublishedUpdate>[0] & {
    recovery: Parameters<typeof verifyInstalledRecoveryContinuity>[0];
  },
) {
  try {
    const result = await runInstalledPublishedUpdate(params);
    params.observations.explicitRecovery = {
      qualified: false,
      phase: "not-required",
      reason: "published-update-succeeded",
    };
    return result;
  } catch (updateError) {
    if (params.key === "2026.9.4") {
      try {
        await observeInstalledOperatorRecovery({
          ...params,
          originalFailure: updateError,
          verifyStarted: (identity) => verifyInstalledRecoveryContinuity(params.recovery, identity),
        });
      } catch (recoveryError) {
        throw new AggregateError(
          [updateError, recoveryError],
          "Published update failed and explicit recovery observation failed",
          { cause: recoveryError },
        );
      }
    }
    throw updateError;
  }
}

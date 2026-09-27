import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { z } from "zod";
import { resolveDistArtifactLockPath } from "../../scripts/lib/dist-artifact-ownership.mts";
import { hashFile, hashInstall } from "../../scripts/lib/gateway-bench-installed-package.js";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { runLegacySourceUpdateBuild } from "../../scripts/lib/source-update-build.mts";
import { listTsdownOutputRoots } from "../../scripts/tsdown-build.mts";
import { retainCliProcessJobUntilExit, withCliProcessScope } from "../cli/runtime-cleanup-scope.js";
import { hasErrnoCode } from "../infra/errno.js";
import { isMainModule } from "../infra/is-main.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { finalizeActiveDebugProxyCaptures } from "../proxy-capture/runtime-cleanup.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { execSchtasks } from "./schtasks-exec.js";
import {
  buildTaskScript,
  encodeWindowsLauncherScript,
  resolveTaskLauncherScriptPath,
  resolveTaskScriptPath,
} from "./schtasks-layout.js";
import { readScheduledTaskRuntime } from "./schtasks-runtime.js";
import { run, type CommandRecord } from "./schtasks.installed-command.test-support.js";
import type { InstalledTask } from "./schtasks.installed-diagnostics.test-support.js";
import { describeFailure, entry, packageRoot } from "./schtasks.installed-package.test-support.js";
import {
  disableScheduledTaskXmlForFixture,
  normalizeScheduledTaskXmlEnabledForFixture,
  readRelatedProcessDiagnostics,
  readTaskPrincipal,
  readTaskXml,
} from "./schtasks.integration-observation.test-support.js";

async function snapshotSourceBuildTask(
  taskName: string,
  env: NodeJS.ProcessEnv,
  extraFiles: string[] = [],
) {
  const configPath = env.OPENCLAW_CONFIG_PATH;
  assert.ok(configPath);
  const scriptPath = resolveTaskScriptPath(env);
  const files = [
    configPath,
    scriptPath,
    resolveTaskLauncherScriptPath(env, scriptPath),
    ...extraFiles,
  ];
  return {
    xml: await readTaskXml(taskName),
    principal: readTaskPrincipal(taskName),
    runtime: await readScheduledTaskRuntime(env, { requireLoaded: true }),
    files: await Promise.all(files.map(async (file) => [file, await hashFile(file)])),
  };
}

export async function inspectInstalledSourceBuildRecovery(params: {
  selected: InstalledTask;
  foreignInstallRoot: string;
  commands: CommandRecord[];
  signal: AbortSignal;
  observations: Record<string, unknown>;
  canBindLoopbackPort: (port: number) => Promise<boolean>;
  recordProgress: (phase: string) => Promise<void>;
  onRecovered: () => Promise<unknown>;
  recordSourceChildJoin: (joined: boolean) => Promise<void>;
}) {
  const {
    selected,
    foreignInstallRoot,
    commands,
    signal,
    observations,
    canBindLoopbackPort,
    recordProgress,
    onRecovered,
    recordSourceChildJoin,
  } = params;
  const sourceSha256 = await hashFile(path.resolve("scripts/lib/source-update-build.mts"));
  assert.equal(sourceSha256, "fcf4808c2227e58b6789b801ebc7e196175c85a4d256dc77ed00656c3d9a1a43");
  observations.sourceOwner = {
    commit: "784850df14770a9bca285f45ad983f06a619ea86",
    sha256: sourceSha256,
  };
  for (const mode of ["owned", "reassigned"] as const) {
    const evidenceDir = path.join(selected.rootDir, `source-build-${mode}`);
    const originalXml = await readTaskXml(selected.taskName);
    assert.ok(originalXml);
    const restorePath = path.join(selected.rootDir, `source-build-${mode}-restore.xml`);
    await fs.writeFile(restorePath, `\uFEFF${originalXml}`, "utf16le");
    let sourceFailure: Error | undefined;
    const commandIndex = commands.length;
    await recordSourceChildJoin(false);
    try {
      await run(
        [
          "--import",
          pathToFileURL(path.resolve("scripts/tsx.mjs")).href,
          path.resolve("src/daemon/schtasks.source-build-recovery.test-support.ts"),
          mode,
          foreignInstallRoot,
          evidenceDir,
        ],
        selected.env,
        packageRoot(selected.installRoot),
        commands,
        0,
        signal,
      );
      const proof: unknown = JSON.parse(
        await fs.readFile(path.join(evidenceDir, "proof.json"), "utf8"),
      );
      observations[mode] = proof;
      if (mode === "owned") {
        observations.recoveredStatus = await onRecovered();
      } else {
        const receipt = z
          .object({ observations: z.object({ foreignAfter: z.unknown() }) })
          .parse(proof);
        const joinedSnapshot = await snapshotSourceBuildTask(selected.taskName, selected.env, [
          path.join(evidenceDir, "foreign.cmd"),
        ]);
        assert.deepEqual(joinedSnapshot, receipt.observations.foreignAfter);
        observations.foreignAfterJoin = joinedSnapshot;
        assert.equal(await canBindLoopbackPort(selected.gatewayPort), true);
        const foreignProcesses = readRelatedProcessDiagnostics([foreignInstallRoot]);
        assert.equal(foreignProcesses.ok, true);
        assert.equal(foreignProcesses.truncated, false);
        assert.deepEqual(foreignProcesses.processes, []);
        observations.foreignProcessesAfterJoin = foreignProcesses;
      }
      await recordProgress(`authority:source-build-${mode}-verified`);
    } catch (error) {
      sourceFailure = toErrorObject(error, "Native source-build fixture failed");
    } finally {
      const joined =
        commands.length > commandIndex &&
        commands.slice(commandIndex).every((command) => command.joined) &&
        !hasUnjoinedWork(sourceFailure) &&
        !hasCommandProcessCleanupError(sourceFailure);
      if (mode === "reassigned" && joined) {
        try {
          assert.equal(
            (await execSchtasks(["/Create", "/F", "/TN", selected.taskName, "/XML", restorePath]))
              .code,
            0,
          );
          assert.equal(await readTaskXml(selected.taskName), originalXml);
        } catch (restoreError) {
          sourceFailure = new AggregateError(
            sourceFailure ? [sourceFailure, restoreError] : [restoreError],
            "Source-build fixture definition restoration failed",
          );
        }
      }
      if (
        joined &&
        !hasUnjoinedWork(sourceFailure) &&
        !hasCommandProcessCleanupError(sourceFailure)
      ) {
        try {
          await recordSourceChildJoin(true);
        } catch (recordError) {
          sourceFailure = new AggregateError(
            sourceFailure ? [sourceFailure, recordError] : [recordError],
            "Source-child join recording failed",
          );
        }
      }
    }
    if (sourceFailure) {
      throw sourceFailure;
    }
  }
}

// Disposable native fixture: the real source owner controls stop, rollback and recovery.
async function inspectSourceBuildRecovery() {
  const [mode, foreignInstallRoot, evidenceDir] = process.argv.slice(2);
  assert.ok(mode === "owned" || mode === "reassigned");
  assert.ok(foreignInstallRoot && evidenceDir);
  assert.equal(process.platform, "win32");
  const root = await fs.realpath(process.cwd());
  const taskName = process.env.OPENCLAW_WINDOWS_TASK_NAME;
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  const port = process.env.OPENCLAW_GATEWAY_PORT;
  assert.ok(taskName && configPath && port);
  const scriptPath = resolveTaskScriptPath(process.env);
  const marker = path.join(root, "dist", "native-failed-build-marker.txt");
  const customRestartMarker = path.join(evidenceDir, "custom-restart-ran.txt");
  const proofPath = path.join(evidenceDir, "proof.json");
  await fs.mkdir(evidenceDir);
  const originalXml = await readTaskXml(taskName);
  assert.ok(originalXml);
  const originalRuntime = await readScheduledTaskRuntime(process.env, { requireLoaded: true });
  assert.equal(originalRuntime.status, "running");
  const originalPid = originalRuntime.pid;
  assert.ok(originalPid);
  const paths = [configPath, scriptPath, resolveTaskLauncherScriptPath(process.env, scriptPath)];
  const files = () => Promise.all(paths.map(async (file) => [file, await hashFile(file)]));
  const filesBefore = await files();
  const outputs = async () =>
    Promise.all(
      listTsdownOutputRoots().map(async (relative) => {
        const directory = path.join(root, relative);
        const exists = await fs.stat(directory).then(
          () => true,
          (error: unknown) => {
            if (hasErrnoCode(error, "ENOENT")) {
              return false;
            }
            throw toErrorObject(error, "Source-build output inspection failed");
          },
        );
        return { relative, installed: exists ? await hashInstall(directory) : null };
      }),
    );
  const beforeOutputs = await outputs();
  const snapshot = () => snapshotSourceBuildTask(taskName, process.env);
  const observations: Record<string, unknown> = { originalXml, originalRuntime, beforeOutputs };
  const record = async (phase: string) => {
    await fs.writeFile(proofPath, JSON.stringify({ mode, phase, observations }, null, 2));
  };
  let callbackCount = 0;
  let failure: Error | undefined;
  try {
    const customRestart = path.join(evidenceDir, "custom-restart.cjs");
    await fs.writeFile(
      customRestart,
      `require('node:fs').writeFileSync(${JSON.stringify(customRestartMarker)}, 'unexpected');\n`,
    );
    process.env.OPENCLAW_UPDATE_RESTART_CMD = `"${process.execPath}" "${customRestart}"`;
    process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
    let result: number | undefined;
    let recoveryError: unknown;
    let foreignBefore: Awaited<ReturnType<typeof snapshot>> | undefined;
    try {
      result = await runLegacySourceUpdateBuild("full", async () => {
        callbackCount += 1;
        const stopped = await snapshot();
        assert.equal(stopped.runtime.status, "stopped");
        assert.equal(stopped.runtime.pid, undefined);
        assert.equal(isPidAlive(originalPid), false);
        assert.equal(stopped.principal.enabled, false);
        assert.deepEqual(stopped.files, filesBefore);
        observations.stopped = stopped;
        await fs.writeFile(marker, "incomplete compiler output\n", { flag: "wx" });
        if (mode === "reassigned") {
          const foreignScript = path.join(evidenceDir, "foreign.cmd");
          await fs.writeFile(
            foreignScript,
            encodeWindowsLauncherScript({
              format: "cmd",
              content: buildTaskScript({
                programArguments: [
                  process.execPath,
                  entry(foreignInstallRoot),
                  "gateway",
                  "--port",
                  port,
                ],
                workingDirectory: evidenceDir,
                environment: { ...process.env, OPENCLAW_TASK_SCRIPT: foreignScript },
              }),
            }),
          );
          const command = /<Command>([^<]+)<\/Command>/u.exec(originalXml);
          assert.ok(command);
          assert.equal(originalXml.match(/<Command>/gu)?.length, 1);
          const escaped = foreignScript
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;");
          const xml = disableScheduledTaskXmlForFixture(originalXml)
            .replace(/<Arguments>[\s\S]*?<\/Arguments>/u, "")
            .replace(/<WorkingDirectory>[\s\S]*?<\/WorkingDirectory>/u, "")
            .replace(command[0], `<Command>${escaped}</Command>`)
            .replace(/<Triggers>[\s\S]*?<\/Triggers>/u, "<Triggers />");
          const definition = path.join(evidenceDir, "foreign.xml");
          await fs.writeFile(definition, `\uFEFF${xml}`, "utf16le");
          assert.equal(
            (await execSchtasks(["/Create", "/F", "/TN", taskName, "/XML", definition])).code,
            0,
          );
          foreignBefore = await snapshotSourceBuildTask(taskName, process.env, [foreignScript]);
          assert.equal(foreignBefore.principal.enabled, false);
          assert.equal(foreignBefore.runtime.status, "stopped");
          assert.equal(foreignBefore.runtime.pid, undefined);
          observations.foreignBefore = foreignBefore;
        }
        await record("build-callback-settled");
        return { exitCode: 17 };
      });
    } catch (error) {
      recoveryError = error;
    }
    assert.equal(callbackCount, 1);
    observations.result = result;
    observations.recoveryError = recoveryError && describeFailure(recoveryError);
    const afterOutputs = await outputs();
    observations.afterOutputs = afterOutputs;
    assert.deepEqual(afterOutputs, beforeOutputs);
    assert.deepEqual(await files(), filesBefore);
    assert.equal(
      await fs.access(customRestartMarker).then(
        () => true,
        () => false,
      ),
      false,
    );
    if (mode === "owned") {
      assert.equal(recoveryError, undefined);
      assert.equal(result, 17);
      const recoveredXml = await readTaskXml(taskName);
      assert.ok(recoveredXml);
      assert.equal(
        normalizeScheduledTaskXmlEnabledForFixture(recoveredXml),
        normalizeScheduledTaskXmlEnabledForFixture(originalXml),
      );
      assert.equal(readTaskPrincipal(taskName).enabled, true);
      observations.recovered = await snapshot();
      assert.equal(
        (await readScheduledTaskRuntime(process.env, { requireLoaded: true })).status,
        "running",
      );
    } else {
      assert.ok(recoveryError instanceof AggregateError);
      assert.match(
        JSON.stringify(describeFailure(recoveryError)),
        /original selected Gateway no longer owns this source checkout/,
      );
      assert.ok(foreignBefore);
      const after = await snapshotSourceBuildTask(taskName, process.env, [
        path.join(evidenceDir, "foreign.cmd"),
      ]);
      assert.deepEqual(after, foreignBefore);
      observations.foreignAfter = after;
    }
    const artifactLockEntries = await fs.readdir(resolveDistArtifactLockPath(root));
    assert.deepEqual(artifactLockEntries, []);
    observations.artifactLockEntries = artifactLockEntries;
    const backups = await Promise.all(
      (await fs.readdir(root))
        .filter((name) => name.startsWith(".update-build-backup."))
        .map(async (name) => ({ name, installed: await hashInstall(path.join(root, name)) })),
    );
    for (const backup of backups) {
      assert.equal(backup.installed.files, 0);
    }
    observations.retainedEmptyBackups = backups;
    await record("recovery-verified");
  } catch (error) {
    failure = toErrorObject(error, "Native source-build recovery failed");
    observations.failure = describeFailure(error);
    await record("failed");
  }
  if (failure) {
    throw failure;
  }
}

if (isMainModule({ currentFile: fileURLToPath(import.meta.url), env: {} })) {
  const errors: unknown[] = [];
  try {
    await withCliProcessScope(retainCliProcessJobUntilExit);
    await inspectSourceBuildRecovery();
  } catch (error) {
    errors.push(error);
  }
  for (const cleanup of [finalizeActiveDebugProxyCaptures, closeOpenClawStateDatabaseAsync]) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    console.error(JSON.stringify(errors.map(describeFailure)));
    process.exitCode = 1;
  }
}

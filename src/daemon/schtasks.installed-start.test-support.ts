import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { z } from "zod";
import { hashFile } from "../../scripts/lib/gateway-bench-installed-package.ts";
import {
  createWindowsTaskAutoStartGuard,
  maybeStopManagedServiceBeforeMutableUpdate,
} from "../cli/update-cli/update-command-service-maintenance.js";
import { suspendScheduledTaskAutoStartForUpdate } from "./schtasks-control.js";
import { resolveTaskLauncherScriptPath } from "./schtasks-layout.js";
import type { InstalledTask } from "./schtasks.installed-diagnostics.test-support.js";
import { packageRoot } from "./schtasks.installed-package.test-support.js";
import {
  normalizeScheduledTaskXmlEnabledForFixture,
  readTaskPrincipal,
  readTaskXml,
} from "./schtasks.integration-observation.test-support.js";
import { withGatewayServiceOperationLock } from "./service-operation-lock.js";

/** Setup may suspend the admitted Task; only the installed public CLI may enable and start it. */
export async function inspectInstalledDisabledTaskStart(params: {
  task: InstalledTask;
  cli: (args: string[]) => Promise<string>;
  awaitReadiness: () => Promise<void>;
  status: () => Promise<unknown>;
  waitForPortRelease: () => Promise<void>;
  canBindPort: () => Promise<boolean>;
  recordProgress: (phase: string) => Promise<void>;
}) {
  const { task } = params;
  const files = [
    ...new Set([
      task.configPath,
      task.scriptPath,
      resolveTaskLauncherScriptPath(task.env, task.scriptPath),
    ]),
  ];
  const fileHashes = () => Promise.all(files.map(async (file) => [file, await hashFile(file)]));
  const beforeFiles = await fileHashes();
  const beforeXml = await readTaskXml(task.taskName);
  assert.ok(beforeXml);
  const before = readTaskPrincipal(task.taskName);
  assert.equal(before.enabled, true);

  await params.cli(["gateway", "stop", "--force", "--json"]);
  await params.waitForPortRelease();
  await withGatewayServiceOperationLock(task.env, async (assertCurrent) => {
    const admitted = await maybeStopManagedServiceBeforeMutableUpdate({
      root: packageRoot(task.installRoot),
      expectedService: { serviceEnv: task.env },
      phase: "inspect",
      allowInstallRootChange: false,
      updateInstallKind: "package",
      shouldRestart: true,
      jsonMode: true,
      assertCurrent,
    });
    assert.equal(admitted.serviceUpdateVerdict?.kind, "owned");
    assert.equal(
      await suspendScheduledTaskAutoStartForUpdate(task.env, {
        assertCurrent,
        beforeMutation: createWindowsTaskAutoStartGuard({
          root: packageRoot(task.installRoot),
          before: admitted,
        }),
      }),
      true,
    );
  });
  const disabled = readTaskPrincipal(task.taskName);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.taskState, 1);
  assert.equal(await params.canBindPort(), true);
  const disabledXml = await readTaskXml(task.taskName);
  assert.ok(disabledXml);
  const normalizedXml = normalizeScheduledTaskXmlEnabledForFixture(beforeXml);
  assert.equal(normalizeScheduledTaskXmlEnabledForFixture(disabledXml), normalizedXml);
  assert.deepEqual(await fileHashes(), beforeFiles);
  await params.recordProgress("explicit-start:disabled");

  const start = z
    .object({ action: z.literal("start"), ok: z.literal(true), result: z.literal("started") })
    .parse(JSON.parse(await params.cli(["gateway", "start", "--json"])));
  await params.awaitReadiness();
  const status = await params.status();
  const started = readTaskPrincipal(task.taskName);
  assert.equal(started.enabled, true);
  assert.equal(started.taskState, 4);
  const startedXml = await readTaskXml(task.taskName);
  assert.ok(startedXml);
  assert.equal(normalizeScheduledTaskXmlEnabledForFixture(startedXml), normalizedXml);
  assert.deepEqual(await fileHashes(), beforeFiles);
  await params.recordProgress("explicit-start:verified");
  return {
    scope: "Packaged public gateway start from a disabled owned Task; no published update proof",
    before,
    disabled,
    start,
    started,
    status,
    files: beforeFiles,
    normalizedDefinitionSha256: createHash("sha256").update(normalizedXml).digest("hex"),
    onlyEnabledChanged: true,
  };
}

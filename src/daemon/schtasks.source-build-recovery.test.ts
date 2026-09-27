import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { readScheduledTaskCommand } from "./schtasks-layout.js";
import type { CommandRecord } from "./schtasks.installed-command.test-support.js";
import { entry } from "./schtasks.installed-package.test-support.js";
import {
  buildSourceRecoveryForeignTaskScript,
  inspectInstalledSourceBuildRecovery,
} from "./schtasks.source-build-recovery.test-support.js";

const mocks = vi.hoisted(() => ({ run: vi.fn(), task: vi.fn(), runtime: vi.fn() }));
vi.mock("./schtasks.installed-command.test-support.js", () => ({ run: mocks.run }));
vi.mock("./schtasks-exec.js", () => ({ execSchtasks: mocks.task }));
vi.mock("./schtasks-runtime.js", () => ({ readScheduledTaskRuntime: mocks.runtime }));
vi.mock("./schtasks.integration-observation.test-support.js", async (original) => ({
  ...(await original<typeof import("./schtasks.integration-observation.test-support.js")>()),
  readTaskXml: async () => "<Task>original selected definition</Task>",
  readTaskPrincipal: () => ({
    enabled: false,
    taskState: 1,
    lastRunTime: "unchanged",
    lastTaskResult: 0,
    logonType: 3,
    runLevel: 0,
  }),
}));

const lifetime = createFixtureLifetime();
afterEach(() => lifetime.cleanup());
beforeEach(() => {
  mocks.run.mockReset();
  mocks.task.mockReset();
  mocks.runtime.mockReset();
});

it("keeps the reassigned launcher inspectable with a quoted diagnostic restart command", () =>
  lifetime.run(async () => {
    const evidenceDir = lifetime.createTempDir("source-build-launcher-");
    const scriptPath = path.join(evidenceDir, "foreign.cmd");
    const foreignInstallRoot = path.join(evidenceDir, "foreign-prefix");
    const env = {
      OPENCLAW_PROFILE: "source-recovery",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (source-recovery)",
      OPENCLAW_STATE_DIR: path.join(evidenceDir, "state"),
      OPENCLAW_CONFIG_PATH: path.join(evidenceDir, "state", "openclaw.json"),
      OPENCLAW_TASK_SCRIPT: scriptPath,
      OPENCLAW_GATEWAY_PORT: "18789",
      OPENCLAW_UPDATE_RESTART_CMD: '"C:\\Synthetic\\node.exe" "C:\\Synthetic\\custom-restart.cjs"',
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
    };
    await fs.writeFile(
      scriptPath,
      buildSourceRecoveryForeignTaskScript({ env, foreignInstallRoot, evidenceDir, port: "18789" }),
    );
    const command = await readScheduledTaskCommand(env, { requireEffective: true });
    expect(command?.programArguments).toEqual([
      process.execPath,
      entry(foreignInstallRoot),
      "gateway",
      "--port",
      "18789",
    ]);
    expect(command?.environment).toMatchObject({
      OPENCLAW_PROFILE: env.OPENCLAW_PROFILE,
      OPENCLAW_WINDOWS_TASK_NAME: env.OPENCLAW_WINDOWS_TASK_NAME,
      OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR,
      OPENCLAW_CONFIG_PATH: env.OPENCLAW_CONFIG_PATH,
      OPENCLAW_GATEWAY_PORT: env.OPENCLAW_GATEWAY_PORT,
      OPENCLAW_TASK_SCRIPT: scriptPath,
    });
  }));

it.each(["source-child", "native-observation", "native-restoration"] as const)(
  "retains unresolved %s custody for the installed cleanup owner",
  (kind) =>
    lifetime.run(async () => {
      const rootDir = lifetime.createTempDir("source-build-custody-");
      const commands: CommandRecord[] = [];
      const recordSourceChildJoin = vi.fn(async (_joined: boolean) => {});
      const unjoined =
        kind === "source-child"
          ? Object.assign(new Error("source child cleanup is unverified"), {
              processTreeState: "indeterminate",
            })
          : new CommandProcessCleanupError();
      mocks.runtime.mockRejectedValue(unjoined);
      if (kind === "native-restoration") {
        mocks.task.mockRejectedValue(unjoined);
      } else {
        mocks.task.mockResolvedValue({ code: 0 });
      }
      mocks.run.mockImplementation(async (args: string[]) => {
        expect(recordSourceChildJoin).toHaveBeenLastCalledWith(false);
        const joined = kind !== "source-child";
        commands.push({
          args,
          launcherPid: null,
          beforeCleanup: joined ? "dead" : "indeterminate",
          code: joined ? 0 : null,
          signal: null,
          joined,
          elapsedMs: 1,
        });
        if (!joined) {
          throw unjoined;
        }
        const evidenceDir = args[4];
        assert.ok(evidenceDir);
        await fs.mkdir(evidenceDir);
        await fs.writeFile(
          path.join(evidenceDir, "proof.json"),
          kind === "native-restoration"
            ? "invalid JSON"
            : JSON.stringify({ observations: { foreignAfter: {} } }),
        );
      });
      const params = {
        selected: {
          rootDir,
          profile: "selected",
          taskName: "OpenClaw Gateway (selected)",
          stateDir: path.join(rootDir, "state"),
          configPath: path.join(rootDir, "state", "openclaw.json"),
          installRoot: path.join(rootDir, "selected"),
          entry: path.join(rootDir, "selected", "openclaw.mjs"),
          scriptPath: path.join(rootDir, "selected.cmd"),
          gatewayPort: 12345,
          env: {
            OPENCLAW_CONFIG_PATH: path.join(rootDir, "state", "openclaw.json"),
            OPENCLAW_TASK_SCRIPT: path.join(rootDir, "selected.cmd"),
          },
        },
        foreignInstallRoot: path.join(rootDir, "foreign"),
        commands,
        signal: new AbortController().signal,
        observations: {},
        canBindLoopbackPort: async () => true,
        recordProgress: async () => {},
        recordSourceChildJoin,
      };
      const operation = inspectInstalledSourceBuildRecovery(params);
      if (kind === "native-restoration") {
        await expect(operation).rejects.toMatchObject({
          errors: [expect.any(SyntaxError), unjoined],
        });
      } else {
        await expect(operation).rejects.toBe(unjoined);
      }
      expect(recordSourceChildJoin.mock.calls.map(([joined]) => joined)).toEqual([false]);
      expect(mocks.task).toHaveBeenCalledTimes(kind === "native-restoration" ? 1 : 0);
    }),
);

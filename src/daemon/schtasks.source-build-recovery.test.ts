import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import type { CommandRecord } from "./schtasks.installed-command.test-support.js";
import { inspectInstalledSourceBuildRecovery } from "./schtasks.source-build-recovery.test-support.js";

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
        const joined = args[3] === "owned" || kind !== "source-child";
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
        const evidenceDir = args[5];
        assert.ok(evidenceDir);
        await fs.mkdir(evidenceDir);
        await fs.writeFile(
          path.join(evidenceDir, "proof.json"),
          args[3] === "owned"
            ? "{}"
            : kind === "native-restoration"
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
        onRecovered: async () => ({}),
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
      expect(recordSourceChildJoin.mock.calls.map(([joined]) => joined)).toEqual([
        false,
        true,
        false,
      ]);
      expect(mocks.task).toHaveBeenCalledTimes(kind === "native-restoration" ? 1 : 0);
    }),
);

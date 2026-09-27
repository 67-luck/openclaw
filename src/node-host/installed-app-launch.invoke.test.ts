import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveExecApprovals } from "../infra/exec-approvals.js";
import { prepareLinuxInstalledApp } from "../infra/installed-apps-linux.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.node-host.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { NodeHostClient } from "./client.js";
import { handleInvoke } from "./invoke.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
});

describe.runIf(process.platform === "linux")("registered installed-app node command", () => {
  it.each([
    "launch",
    "cwd-replaced",
    "ask-always",
    "eligibility-changed",
    "changed-before-preparation",
  ] as const)("uses the ordinary execution owner at the final boundary: %s", async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setActivePluginRegistry(createEmptyPluginRegistry());
      const data = state.path("app-data");
      fs.mkdirSync(path.join(data, "applications"), { recursive: true });
      const cwd = state.path("approved-cwd");
      fs.mkdirSync(cwd);
      const executable = state.path("fixture-native");
      fs.copyFileSync("/usr/bin/true", executable);
      fs.chmodSync(executable, 0o755);
      const entry = path.join(data, "applications", "fixture.desktop");
      const desktop = [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Fixture",
        "Exec=" + executable,
        "",
      ].join("\n");
      fs.writeFileSync(entry, desktop);
      vi.stubEnv("XDG_DATA_HOME", data);
      vi.stubEnv("XDG_DATA_DIRS", data);
      const app = prepareLinuxInstalledApp("linux-desktop:fixture.desktop")!.app;
      saveExecApprovals({
        version: 1,
        agents: {
          main: {
            security: "allowlist",
            ask: mode === "ask-always" ? "always" : "off",
            allowlist: [{ pattern: executable }],
          },
        },
      });
      const requests = vi.fn<(method: string, params?: unknown) => void>();
      const request: NodeHostClient["request"] = async (method, params) => {
        requests(method, params);
        return {} as never;
      };
      let reply: ((raw: string) => void) | undefined;
      const ready = vi.fn(async () => {
        if (mode === "cwd-replaced") {
          fs.renameSync(cwd, cwd + ".old");
          fs.mkdirSync(cwd);
        }
        if (mode === "eligibility-changed") {
          fs.writeFileSync(entry, desktop + "Hidden = true\n");
        }
        reply!(JSON.stringify({ type: "installed-app-launch.allow", validForMs: 5000 }));
      });
      const io: OpenClawPluginNodeHostCommandIo = {
        signal: new AbortController().signal,
        emitChunk: ready,
        onInput: (callback) => {
          reply = callback;
        },
      };
      if (mode === "changed-before-preparation") {
        fs.appendFileSync(entry, "Comment=changed\n");
      }
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
      try {
        await handleInvoke(
          {
            id: "app-invoke",
            nodeId: "node",
            command: "device.apps.launch",
            paramsJSON: JSON.stringify({
              appId: app.appId,
              appRevision: app.appRevision,
              agentId: "main",
            }),
          },
          { request },
          { current: async () => [] },
          undefined,
          {
            installedAppsSharingEnabled: true,
            installedAppsPlatform: "linux",
            pluginCommandIo: io,
          },
        );
      } finally {
        cwdSpy.mockRestore();
      }
      const result = requests.mock.calls.findLast(
        ([method]) => method === "node.invoke.result",
      )?.[1];
      expect(result).toMatchObject({ ok: mode === "launch" });
      if (mode === "eligibility-changed" || mode === "changed-before-preparation") {
        expect(result).toMatchObject({
          error: { message: expect.stringContaining("INSTALLED_APP_CHANGED") },
        });
      }
      if (mode === "ask-always" || mode === "changed-before-preparation") {
        expect(ready).not.toHaveBeenCalled();
      } else {
        expect(ready).toHaveBeenCalledOnce();
      }
    });
  });
});

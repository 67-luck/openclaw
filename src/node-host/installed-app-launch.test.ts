import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareLinuxInstalledApp } from "../infra/installed-apps-linux.js";
import { prepareInstalledAppLaunch } from "./installed-app-launch.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

describe.runIf(process.platform === "linux")("installed app final native boundary", () => {
  it.each(["args", "revision", "executable", "cancel-at-spawn", "deny", "expired"] as const)(
    "rejects %s without spawning",
    async (mode) => {
      const root = tempDirs.make("installed-app-boundary-");
      fs.mkdirSync(path.join(root, "applications"));
      const executable = path.join(root, "native");
      fs.copyFileSync("/usr/bin/true", executable);
      fs.chmodSync(executable, 0o755);
      const entry = path.join(root, "applications", "fixture.desktop");
      fs.writeFileSync(
        entry,
        "[Desktop Entry]\nType=Application\nName=Fixture\nExec=" + executable + "\n",
      );
      vi.stubEnv("XDG_DATA_HOME", root);
      vi.stubEnv("XDG_DATA_DIRS", root);
      const app = prepareLinuxInstalledApp("linux-desktop:fixture.desktop")!.app;
      const controller = new AbortController();
      let input: ((raw: string) => void) | undefined;
      const prepared = prepareInstalledAppLaunch({
        platform: "linux",
        sharingEnabled: true,
        paramsJSON: JSON.stringify({
          appId: app.appId,
          appRevision: app.appRevision,
          agentId: "main",
        }),
        io: {
          signal: controller.signal,
          onInput: (cb) => {
            input = cb;
          },
          emitChunk: async () => {},
        },
      });
      const spawn = vi.spyOn(childProcess, "spawn");
      syncBuiltinESMExports();
      const clock = vi.spyOn(performance, "now").mockReturnValue(100);
      const assertCurrent = vi.fn(() => {
        if (mode === "cancel-at-spawn") {
          controller.abort();
        }
      });
      const running = prepared.run(
        mode === "args" ? [executable, "extra"] : [executable],
        undefined,
        {},
        undefined,
        controller.signal,
        assertCurrent,
      );
      if (mode === "revision") {
        fs.appendFileSync(entry, "Comment=changed\n");
      }
      if (mode === "executable") {
        fs.renameSync(executable, executable + ".old");
        fs.copyFileSync(executable + ".old", executable);
      }
      if (mode === "expired") {
        clock.mockReturnValue(6000);
      }
      input!(
        JSON.stringify(
          mode === "deny"
            ? { type: "installed-app-launch.deny" }
            : { type: "installed-app-launch.allow", validForMs: 5000 },
        ),
      );
      await expect(running).rejects.toThrow();
      if (mode === "cancel-at-spawn") {
        expect(assertCurrent).toHaveBeenCalledOnce();
      }
      expect(spawn).not.toHaveBeenCalled();
      expect(prepared.started).toBeUndefined();
    },
  );
});

import { spawn } from "node:child_process";
import {
  InstalledAppLaunchDispatchSchema,
  InstalledAppLaunchPermitSchema,
} from "../infra/installed-app-launch.js";
import { prepareLinuxInstalledApp } from "../infra/installed-apps-linux.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.node-host.js";
import type { runCommand } from "./invoke-run-command.js";

/** Prepare only the installed native app identified by the node's own inventory. */
export function prepareInstalledAppLaunch(params: {
  paramsJSON?: string | null;
  sharingEnabled: boolean;
  platform: NodeJS.Platform;
  io?: OpenClawPluginNodeHostCommandIo;
}) {
  if (!params.sharingEnabled || params.platform !== "linux") {
    throw new Error("INSTALLED_APP_LAUNCH_DISABLED: enable Installed Apps on a Linux node");
  }
  const request = InstalledAppLaunchDispatchSchema.parse(JSON.parse(params.paramsJSON || "{}"));
  const prepared = prepareLinuxInstalledApp(request.appId);
  if (!prepared || prepared.app.appRevision !== request.appRevision) {
    throw new Error(
      "INSTALLED_APP_CHANGED: refresh device.apps and explicitly authorize the current app",
    );
  }
  let started:
    | { status: "process-started"; appId: string; appRevision: string; pid: number }
    | undefined;
  const run: typeof runCommand = async (argv, cwd, env, _timeout, signal, assertCurrent) => {
    signal?.throwIfAborted();
    const io = params.io;
    if (!io) {
      throw new Error("Installed-app launch requires invocation-owned authorization transport");
    }
    const readyAt = performance.now();
    const validForMs = await new Promise<number>((resolve, reject) => {
      let settled = false;
      const finish = (value?: number, error?: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        io.signal.removeEventListener("abort", onAbort);
        if (value !== undefined) {
          resolve(value);
        } else {
          reject(
            error instanceof Error
              ? error
              : new Error("Installed-app authorization failed", { cause: error }),
          );
        }
      };
      const onAbort = () => finish(undefined, new Error("Installed-app invocation closed"));
      const timer = setTimeout(
        () => finish(undefined, new Error("Installed-app authorization timed out")),
        10_000,
      );
      io.signal.addEventListener("abort", onAbort, { once: true });
      io.onInput((raw) => {
        try {
          const permit = InstalledAppLaunchPermitSchema.parse(JSON.parse(raw));
          if (permit.type === "installed-app-launch.allow") {
            finish(permit.validForMs);
          } else {
            finish(undefined, new Error("Installed-app authorization is no longer current"));
          }
        } catch (error) {
          finish(undefined, error);
        }
      });
      if (io.signal.aborted) {
        onAbort();
        return;
      }
      void io
        .emitChunk(
          JSON.stringify({
            type: "installed-app-launch.ready",
            appId: request.appId,
            appRevision: request.appRevision,
          }),
        )
        .catch((error: unknown) => finish(undefined, error));
    });
    const current = prepareLinuxInstalledApp(request.appId);
    if (
      !current ||
      current.app.appRevision !== request.appRevision ||
      current.executable !== prepared.executable ||
      argv.length !== 1 ||
      argv[0] !== prepared.executable
    ) {
      throw new Error("INSTALLED_APP_CHANGED: launch descriptor changed before execution");
    }
    // The ordinary node exec owner supplied this guard after its own policy/approval work.
    // No asynchronous work may separate these checks from the actual spawn.
    assertCurrent?.();
    signal?.throwIfAborted();
    io.signal.throwIfAborted();
    if (performance.now() - readyAt >= validForMs) {
      throw new Error("Installed-app authorization expired before spawn");
    }
    const child = spawn(prepared.executable, [], {
      shell: false,
      detached: true,
      stdio: "ignore",
      cwd,
      env,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => {
        started = {
          status: "process-started",
          appId: request.appId,
          appRevision: request.appRevision,
          pid: child.pid!,
        };
        child.unref();
        resolve();
      });
    });
    return {
      success: true,
      exitCode: undefined,
      timedOut: false,
      stdout: "",
      stderr: "",
      error: null,
      truncated: false,
    };
  };
  return {
    executable: prepared.executable,
    agentId: request.agentId,
    run,
    get started() {
      return started;
    },
  };
}

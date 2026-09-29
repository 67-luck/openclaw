import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// Manual proof branch only; the child uses the real Node module and native-addon graph.
it.runIf(process.platform === "win32")(
  "observes Config edits and replacements through the required native addon and joins stop",
  () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(path.resolve("scripts/tsx.mjs")).href,
        path.resolve("test/scripts/fs-safe-native-config.test-support.mjs"),
      ],
      { encoding: "utf8", timeout: 45_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.signal).toBeNull();
    expect(JSON.parse(result.stdout)).toMatchObject({
      sourceBase: "6f6d3e3915074cd0ad37ed809a970630d02e1e7c",
      applicationTreeSha256: "98d4d6851b578813c2cca014d0bccd72181dabaa2a7b6ec433c7f42fcad18cf1",
      platform: "win32",
      arch: "x64",
      fsSafe: "0.21.2",
      native: { version: "0.21.2", required: true, loaded: true },
      manualReconcile: false,
      fakeTimers: false,
      postCloseCallbacks: 0,
      sourceVerified: true,
      dependenciesVerified: true,
      joinedStop: true,
      ownedTempRemoved: true,
    });
    console.info(result.stdout);
  },
  60_000,
);

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { executeSystemAgentOperation } from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

describe("approved config-write authority", () => {
  it("rechecks live authority after preparation and before real file publication", async () => {
    const stateDir = tempDirs.make("openclaw-config-approval-");
    const configPath = path.join(stateDir, "openclaw.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await fs.writeFile(configPath, "{}\n");
    const { runtime, lines } = createSystemAgentTestRuntime();
    let authorityChecks = 0;

    await expect(
      executeSystemAgentOperation(
        { kind: "config-set", path: "tools.exec.notifyOnExit", value: "false" },
        runtime,
        {
          approved: true,
          beforePersistentApply: async () => {},
          assertPersistentApply: () => {
            authorityChecks += 1;
            if (authorityChecks >= 3) {
              throw new Error("approving run closed during config preparation");
            }
          },
        },
      ),
    ).rejects.toThrow("operation exited");

    expect(authorityChecks).toBe(3);
    expect(lines.join("\n")).toContain("approving run closed during config preparation");
    expect(await fs.readFile(configPath, "utf8")).toBe("{}\n");
  });
});

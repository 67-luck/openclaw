// Literal resolver calls keep the generated cross-file regression in CI's dependency graph.
export function sqliteOwnerColdWriteFixtureFiles(): Record<string, string> {
  return {
    "a-owner-only.test.ts": `
import { existsSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { captureOpenClawStateWorkerContext } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-state-worker-context.ts"))};
import { getOpenClawStateWorkerOwner } from ${JSON.stringify(import.meta.resolve("../src/state/openclaw-state-worker-owner.ts"))};

it("inspects absent state through its owner without creating a database", async () => {
  const stateDir = path.join(import.meta.dirname, "absent-state");
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  const context = captureOpenClawStateWorkerContext({
    path: databasePath,
    env: { OPENCLAW_STATE_DIR: stateDir },
  });
  expect(await getOpenClawStateWorkerOwner().open(context, { existingOnly: true })).toBeUndefined();
  expect(existsSync(databasePath)).toBe(false);
});
`,
    "b-cold-policy-write.test.ts": `
import { existsSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";

const home = path.join(import.meta.dirname, "policy-home");
const stateDir = path.join(home, ".openclaw");
vi.stubEnv("HOME", home);
vi.stubEnv("USERPROFILE", home);
vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
const { publishCanonicalUserChannelPolicy } = await import(${JSON.stringify(import.meta.resolve("../src/state/user-channel-identity-operations.ts"))});
const { closeOpenClawStateDatabaseAsync } = await import(${JSON.stringify(import.meta.resolve("../src/state/openclaw-state-db-cache.ts"))});
const { readConfigMachineState } = await import(${JSON.stringify(import.meta.resolve("../src/state/config-machine-state.ts"))});

it("publishes durable policy into a cold database after the previous file's owner retires", async () => {
  expect(existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
  try {
    await publishCanonicalUserChannelPolicy(undefined);
    await closeOpenClawStateDatabaseAsync();
    expect(readConfigMachineState("operator.channelPolicy")).toEqual({
      roles: null,
      identityScopes: null,
    });
  } finally {
    await closeOpenClawStateDatabaseAsync();
  }
});
`,
  };
}

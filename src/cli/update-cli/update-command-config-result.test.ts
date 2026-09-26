import { expect, it } from "vitest";
import { createUpdateCliBaseSnapshot } from "./update-cli-config.test-support.js";
import { buildInvalidConfigPostCoreUpdateResult } from "./update-command-plugins-internals.js";
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";

const snapshot = { ...createUpdateCliBaseSnapshot({}), valid: false };
const guidance = [
  "Run `openclaw doctor --fix` to repair retired or unrecognized configuration fields, then correct any remaining errors before retrying.",
  "Once the config loads successfully, rerun `openclaw update repair`.",
];
const message = [
  "Plugin post-update convergence skipped; refusing to restart the gateway with an unverified plugin set.",
  `Update refused: configuration is invalid at ${snapshot.path}.`,
  guidance[0],
].join("\n");

it("reports invalid post-core config as an unchanged error with repair guidance", async () => {
  const result = await updatePluginsAfterCoreUpdate({
    root: "/tmp/openclaw-test",
    channel: "stable",
    configWriteOptions: {},
    configSnapshot: snapshot,
    json: true,
    timeoutMs: 1000,
  });
  expect(result.status).toBe("error");
  expect(result.reason).toBe("invalid-config");
  expect(result.changed).toBe(false);
  expect(result.warnings).toStrictEqual([{ reason: "invalid-config", message, guidance }]);
});

it("builds an error result for invalid post-core config", () => {
  const built = buildInvalidConfigPostCoreUpdateResult(snapshot);
  expect(built.result.status).toBe("error");
  expect(built.result.reason).toBe("invalid-config");
  expect(built.result.changed).toBe(false);
});

it("keeps actionable guidance in structural warnings and the message", () => {
  const built = buildInvalidConfigPostCoreUpdateResult(snapshot);
  expect(built.guidance).toStrictEqual(guidance);
  expect(built.result.warnings).toStrictEqual([
    {
      reason: "invalid-config",
      message: built.message,
      guidance: built.guidance,
    },
  ]);
  expect(built.message).toBe(message);
});

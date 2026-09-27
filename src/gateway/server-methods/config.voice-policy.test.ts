import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { getRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { configHandlers, clearConfigSchemaResponseCacheForTests } from "./config.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";

const configWriteMocks = vi.hoisted(() => ({
  replaceConfigFile: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
}));
vi.mock("../../config/mutate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/mutate.js")>()),
  replaceConfigFile: configWriteMocks.replaceConfigFile,
}));
vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  readConfigFileSnapshotForWrite: configWriteMocks.readConfigFileSnapshotForWrite,
}));
// Persistence and provider preparation are synthetic; real config handlers and
// commit authorization must reject model authority before the writer is reached.
vi.mock("../../config/validation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/validation.js")>()),
  validateConfigObjectRawWithPlugins: (config: OpenClawConfig) => ({
    ok: true,
    config,
    warnings: [],
  }),
  validateConfigObjectWithPlugins: (config: OpenClawConfig) => ({ ok: true, config, warnings: [] }),
}));
vi.mock("../../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: async ({ config }: { config: OpenClawConfig }) => ({ config }),
}));
vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: () => ({
    schema: { type: "object" },
    uiHints: undefined,
    version: "test-schema",
  }),
}));
vi.mock("./config-write-flow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config-write-flow.js")>()),
  resolveGatewayConfigRestartWriteResult: async () => ({
    payload: { kind: "config-patch", mode: "config.patch", configPath: "/tmp/openclaw.json" },
    sentinelPersisted: false,
    restart: undefined,
  }),
}));
let storedConfig: OpenClawConfig;
const storedHash = "base-hash";
beforeEach(() => {
  storedConfig = {};
  configWriteMocks.readConfigFileSnapshotForWrite.mockImplementation(async () =>
    createConfigWriteSnapshot(storedConfig),
  );
  clearConfigSchemaResponseCacheForTests();
});
afterEach(() => {
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

it.each(
  (["config.set", "config.patch", "config.apply"] as const).flatMap((method) =>
    (["operator", "model-full-access"] as const).map((source) => ({ method, source })),
  ),
)(
  "$method permits policy changes only from operator intent ($source)",
  async ({ method, source }) => {
    configWriteMocks.replaceConfigFile.mockClear();
    configWriteMocks.replaceConfigFile.mockImplementationOnce(async (params) => {
      params.writeOptions.assertConfigPathForWrite();
      const receipt = getRuntimeConfigWriteApplication(params.writeOptions);
      receipt?.claim()?.settle("applied");
      storedConfig = params.sourceConfig;
      return { nextConfig: storedConfig, persistedHash: "policy-applied" };
    });
    const next: OpenClawConfig = {
      talk: {
        realtime: {
          appLaunchPolicies: [
            {
              id: "fixture",
              agentId: "main",
              originatingDeviceId: "widget",
              nodeId: "node",
              appId: "linux-desktop:fixture.desktop",
              appRevision: "a".repeat(64),
              expiresAtMs: 2_000_000_000_000,
            },
          ],
        },
      },
    };
    const harness = createConfigHandlerHarness({
      method,
      params: { raw: JSON.stringify(next), baseHash: storedHash },
      overrides: {
        client: sharingPolicyClient({ deviceId: "operator", scopes: ["operator.admin"] }),
        hasCurrentClientAuthority: () => true,
      },
    });
    const call = () => expectDefined(configHandlers[method], "config handler")(harness.options);
    if (source === "operator") {
      await call();
    } else {
      await expect(
        withGatewayToolCallerIdentity(
          { agentId: "main", sessionKey: "agent:main:voice", fullPermission: true },
          call,
        ),
      ).rejects.toThrow("explicit authenticated operator");
    }
    if (source === "operator") {
      expect(harness.respond.mock.calls[0]?.[0]).toBe(true);
      expect(configWriteMocks.replaceConfigFile).toHaveBeenCalledOnce();
      expect(storedConfig.talk?.realtime?.appLaunchPolicies).toEqual(
        next.talk!.realtime!.appLaunchPolicies,
      );
    } else {
      expect(configWriteMocks.replaceConfigFile).not.toHaveBeenCalled();
      expect(storedConfig).toEqual({});
      // The registered dispatcher serializes ordinary thrown authorization errors.
      expect(harness.respond).not.toHaveBeenCalled();
    }
  },
);

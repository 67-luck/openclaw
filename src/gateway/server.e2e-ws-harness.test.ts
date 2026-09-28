import { afterEach, expect, test, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { captureEnv } from "../test-utils/env.js";
import type { TestPortClaim } from "../test-utils/port-claims.js";
import { gatewayFixtureLifetime } from "./gateway-fixture-lifetime.test-support.js";
import { startGatewayServerHarness } from "./server.e2e-ws-harness.js";

const fixtureState = vi.hoisted(() => {
  const state: { gatewayAuth?: Record<string, unknown> } = {};
  return state;
});

const startup = vi.hoisted(() => ({
  port: vi.fn<() => Promise<TestPortClaim>>(),
  server: vi.fn<(claim: TestPortClaim) => Promise<never>>(),
}));
vi.mock("../test-utils/port-claims.js", () => ({ acquireTestPortBlock: startup.port }));
vi.mock("./test-helpers.js", () => ({
  startTestGatewayServer: startup.server,
  connectOk: vi.fn(),
  trackConnectChallengeNonce: vi.fn(),
  testState: fixtureState,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  fixtureState.gatewayAuth = undefined;
  clearRuntimeConfigSnapshot();
});

test.each(["port", "admission", "server"] as const)(
  "restores its token and auth policy when %s acquisition fails before publishing a close handle",
  async (stage) => {
    const env = captureEnv(["OPENCLAW_GATEWAY_TOKEN"]);
    const failure = new Error(`injected ${stage} acquisition failure`);
    process.env.OPENCLAW_GATEWAY_TOKEN = "fixture-token";
    const authSnapshot = { mode: "token", token: "fixture-token" };
    fixtureState.gatewayAuth = authSnapshot;
    const configSnapshot = {
      gateway: { auth: { mode: "token" as const, token: "fixture-token" } },
    };
    setRuntimeConfigSnapshot(configSnapshot);
    const release = vi.fn(async () => {});
    startup.port.mockResolvedValue({ port: 12345, release });
    startup.server.mockImplementation(async (claim) => {
      expect(fixtureState.gatewayAuth).toEqual({ mode: "none" });
      setRuntimeConfigSnapshot({ gateway: { auth: { mode: "none" } } });
      await claim.release();
      throw failure;
    });
    if (stage === "port") {
      startup.port.mockRejectedValue(failure);
    }
    if (stage === "admission") {
      vi.spyOn(gatewayFixtureLifetime, "assertAdmission")
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
          throw failure;
        });
    }
    try {
      await expect(startGatewayServerHarness()).rejects.toBe(failure);
      expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("fixture-token");
      expect(fixtureState.gatewayAuth).toBe(authSnapshot);
      expect(getRuntimeConfigSnapshot()).toBe(stage === "server" ? null : configSnapshot);
      expect(release).toHaveBeenCalledTimes(stage === "port" ? 0 : 1);
      expect(startup.server).toHaveBeenCalledTimes(stage === "server" ? 1 : 0);
    } finally {
      env.restore();
    }
  },
);

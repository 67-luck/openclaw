import { afterEach, expect, it, vi } from "vitest";
import { GatewayProtocolClient } from "../../packages/gateway-client/src/protocol-client.js";
import { createIOSReleaseSetupDiagnostics } from "../../scripts/lib/ios-release-setup-diagnostics.js";
import { GatewayClient } from "../../src/gateway/client.js";

vi.mock("../../src/gateway/client.js", () => {
  class GatewayClientBoundary {
    start() {
      throw new Error("observer test must install controlled client behavior");
    }
    request() {
      throw new Error("observer test must install controlled client behavior");
    }
    stopAndWait() {
      throw new Error("observer test must install controlled client behavior");
    }
  }
  return { GatewayClient: GatewayClientBoundary };
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("exports only bounded numeric resource samples and setup response facts from Gateway logs", () => {
  const diagnostics = createIOSReleaseSetupDiagnostics();
  const sample = {
    epochMs: 1_000,
    uptimeMs: 500,
    intervalMs: 100,
    cpuUserMs: 25,
    cpuSystemMs: 5,
    rssBytes: 1_024,
    heapUsedBytes: 512,
    eventLoopUtilization: 0.25,
    eventLoopDelayMaxMs: 5,
    eventLoopDelayP99Ms: 3,
  };
  const resourceLine = (value: unknown) => `IOS_SETUP_PROBE_RESOURCE ${JSON.stringify(value)}`;
  diagnostics.captureGatewayLogs(
    [
      "private non-JSON diagnostic",
      JSON.stringify({
        subsystem: "gateway/ws",
        message: "\u001b[32m⇄ res ✓ device.pair.setupCode 97ms\u001b[0m private credential",
        token: "synthetic-secret",
      }),
      JSON.stringify({
        subsystem: "gateway/ws",
        message: "→ res ✗ device.pair.setupStatus 12ms private failure message",
      }),
      JSON.stringify({ subsystem: "gateway/ws", message: "→ res ✓ private.method 1ms" }),
      JSON.stringify({ subsystem: "private", message: "→ res ✓ device.pair.setupCode 1ms" }),
      resourceLine({ ...sample, token: "synthetic-secret" }),
      resourceLine({ ...sample, rssBytes: "private path" }),
      resourceLine({ ...sample, eventLoopUtilization: 2 }),
      resourceLine({ ...sample, cpuUserMs: -1 }),
      resourceLine({ ...sample, cpuSystemMs: Number.POSITIVE_INFINITY }),
      resourceLine(sample),
    ].join("\n"),
  );
  expect(diagnostics.evidence).toEqual({
    rpcs: [],
    serverRpcs: [
      { method: "device.pair.setupCode", ok: true, durationMs: 97 },
      { method: "device.pair.setupStatus", ok: false, durationMs: 12 },
    ],
    resources: [sample],
  });
  expect(JSON.stringify(diagnostics.evidence)).not.toMatch(/private|synthetic/);

  diagnostics.captureGatewayLogs(
    Array.from({ length: 125 }, (_, index) => resourceLine({ ...sample, epochMs: index })).join(
      "\n",
    ),
  );
  expect(diagnostics.evidence.resources).toHaveLength(120);
  expect(diagnostics.evidence.resources.at(-1)?.epochMs).toBe(124);
});

it("preserves RPC promises and results, limits observations to its client, and restores prototypes after failure", async () => {
  const response = { setupCode: "synthetic-secret" };
  const requestPromise = Promise.resolve(response);
  const connectPromise = Promise.resolve({ type: "hello-ok" });
  const stopPromise = Promise.resolve();
  vi.spyOn(GatewayClient.prototype, "start").mockImplementation(() => {});
  const request = vi.spyOn(GatewayClient.prototype, "request").mockReturnValue(requestPromise);
  vi.spyOn(GatewayClient.prototype, "stopAndWait").mockReturnValue(stopPromise);
  vi.spyOn(GatewayProtocolClient.prototype, "request").mockReturnValue(connectPromise);
  const timing = vi
    .spyOn(GatewayProtocolClient.prototype, "recordTiming")
    .mockImplementation(() => {});
  const clientDescriptors = Object.getOwnPropertyDescriptors(GatewayClient.prototype);
  const protocolDescriptors = Object.getOwnPropertyDescriptors(GatewayProtocolClient.prototype);
  const makeProtocol = () =>
    new GatewayProtocolClient({
      createSocket: () => {
        throw new Error("observer test must not open a socket");
      },
      createRequestId: () => "synthetic-request",
      buildConnectPlan: () => ({}),
      buildConnectParams: () => ({}),
      resolveClose: () => ({ retry: false, notify: false }),
      handshake: { mode: "require-challenge", timeoutMs: 10_000 },
      reconnect: { initialMs: 1, multiplier: 1, maxMs: 1 },
    });
  const protocol = makeProtocol();
  const otherProtocol = makeProtocol();
  const diagnostics = createIOSReleaseSetupDiagnostics();
  const client = new GatewayClient({ deviceIdentity: null, sharedStateMode: "read-only" });
  const otherClient = new GatewayClient({ deviceIdentity: null, sharedStateMode: "read-only" });
  const params = { setupId: "synthetic-private-id" };
  const options = { timeoutMs: 30_000 };
  const plan = { token: "synthetic-private-token" };
  const detail = { url: "ws://private.invalid", message: "private timing details" };

  await expect(
    diagnostics.observeRpc("setup-status", async () => {
      client.start();
      protocol.recordTiming("socket-open", 7, plan, detail);
      expect(timing).toHaveBeenLastCalledWith("socket-open", 7, plan, detail);
      expect(timing.mock.contexts.at(-1)).toBe(protocol);
      otherProtocol.recordTiming("challenge", 8, plan, detail);
      await otherProtocol.request("connect", { token: "synthetic-private-other" });
      protocol.recordTiming("challenge", 7);
      const connecting = protocol.request("connect", { token: "synthetic-secret" });
      expect(connecting).toBe(connectPromise);
      await connecting;
      protocol.recordTiming("hello", 7, plan, detail);
      otherClient.start();
      await otherClient.request("device.pair.setupStatus", params, options);
      const pending = client.request("device.pair.setupStatus", params, options);
      expect(pending).toBe(requestPromise);
      const result = await pending;
      const stopping = client.stopAndWait({ timeoutMs: 1_000 });
      expect(stopping).toBe(stopPromise);
      await stopping;
      return result;
    }),
  ).resolves.toBe(response);
  expect(request).toHaveBeenLastCalledWith("device.pair.setupStatus", params, options);
  expect(diagnostics.evidence.rpcs[0]?.events.map(({ label }) => label)).toEqual([
    "client-start",
    "protocol-socket-open",
    "protocol-challenge",
    "connect-request-start",
    "connect-request-resolved",
    "protocol-hello",
    "request-start",
    "request-resolved",
    "client-stop-start",
    "client-stop-resolved",
    "call-resolved",
  ]);
  expect(Object.getOwnPropertyDescriptors(GatewayProtocolClient.prototype)).toEqual(
    protocolDescriptors,
  );

  const failure = new Error("private credential-bearing rejection");
  request.mockRejectedValueOnce(failure);
  await expect(
    diagnostics.observeRpc("setup-code", async () => {
      client.start();
      try {
        return await client.request("device.pair.setupCode", params, options);
      } catch (error) {
        protocol.recordTiming("failed", 9, plan, detail);
        throw error;
      } finally {
        await client.stopAndWait({ timeoutMs: 1_000 });
      }
    }),
  ).rejects.toBe(failure);
  expect(diagnostics.evidence.rpcs.map(({ status }) => status)).toEqual(["passed", "failed"]);
  expect(diagnostics.evidence.rpcs[1]?.events.map(({ label }) => label)).toEqual([
    "client-start",
    "request-start",
    "request-rejected",
    "protocol-failed",
    "client-stop-start",
    "client-stop-resolved",
    "call-rejected",
  ]);
  expect(Object.getOwnPropertyDescriptors(GatewayClient.prototype)).toEqual(clientDescriptors);
  expect(Object.getOwnPropertyDescriptors(GatewayProtocolClient.prototype)).toEqual(
    protocolDescriptors,
  );
  expect(JSON.stringify(diagnostics.evidence)).not.toMatch(/private|synthetic/);
});

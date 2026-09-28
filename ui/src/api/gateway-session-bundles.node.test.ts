/** @vitest-environment node */
import {
  GATEWAY_CLIENT_CAPS,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type ConnectParams,
} from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as nodes from "../lib/nodes/index.ts";
import { reconcileSessionChanged } from "../lib/sessions/reconcile.ts";
import {
  getLatestWebSocket,
  MockWebSocket,
  stubWindowGlobals,
  useNodeFakeTimers,
  wsInstances,
} from "./gateway-socket.test-support.ts";
import { GatewayBrowserClient, type GatewayEventFrame } from "./gateway.ts";
import type { SessionsListResult } from "./types.ts";

const sessionKey = "agent:main:chat";
const start = { sessionKey, reason: "start", updatedAt: 2, activeRunIds: ["run-1"] };
const release = { sessionKey, reason: "end", updatedAt: 3, activeRunIds: null };

function bundle(payloads: unknown[], seq = 1) {
  return {
    type: "event",
    event: "sessions.changed.bundle",
    seq,
    recipientProfileId: "profile-1",
    payload: { sessionKey, agentId: "main", receipts: payloads.map((payload) => ({ payload })) },
  };
}

describe("GatewayBrowserClient session receipt bundles", () => {
  beforeEach(() => {
    useNodeFakeTimers();
    wsInstances.length = 0;
    stubWindowGlobals();
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("negotiates receipt bundles with full Control UI scopes and explicit shared auth", async () => {
    vi.spyOn(nodes, "loadOrCreateDeviceIdentity").mockResolvedValue({
      deviceId: "device-1",
      privateKey: "private-key", // pragma: allowlist secret
      publicKey: "public-key", // pragma: allowlist secret
    });
    vi.spyOn(nodes, "signDevicePayload").mockResolvedValue("signature");
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
      clientBuildId: "build-a",
    });
    try {
      client.start();
      const ws = getLatestWebSocket();
      ws.emitOpen();
      ws.emitMessage({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-1", ts: 1_800_000_000_000 },
      });
      await vi.advanceTimersByTimeAsync(0);
      const connectFrame: { method: string; params: ConnectParams } = JSON.parse(
        ws.sent.at(-1) ?? "{}",
      );

      expect(connectFrame.method).toBe("connect");
      expect(connectFrame.params.minProtocol).toBe(MIN_CLIENT_PROTOCOL_VERSION);
      expect(connectFrame.params.maxProtocol).toBe(PROTOCOL_VERSION);
      expect(connectFrame.params.client.buildId).toBe("build-a");
      expect(connectFrame.params.caps).toEqual([
        GATEWAY_CLIENT_CAPS.AGENT_KIND,
        GATEWAY_CLIENT_CAPS.APPROVALS,
        GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS,
        GATEWAY_CLIENT_CAPS.TERMINAL_OFFSET_SEQ,
        GATEWAY_CLIENT_CAPS.TERMINAL_SESSION_METADATA,
        GATEWAY_CLIENT_CAPS.TERMINAL_UPLOAD_PATH_STYLE,
        GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
        GATEWAY_CLIENT_CAPS.CHAT_ONLY_ASSISTANT_TEXT,
        GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS,
        GATEWAY_CLIENT_CAPS.SESSION_CHANGED_BUNDLES,
        GATEWAY_CLIENT_CAPS.INLINE_WIDGETS,
        GATEWAY_CLIENT_CAPS.MODEL_SELECTION_POLICY,
        GATEWAY_CLIENT_CAPS.UI_COMMANDS,
        GATEWAY_CLIENT_CAPS.USAGE_REFRESHING,
      ]);
      expect(connectFrame.params.scopes).toEqual([
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.questions",
        "operator.pairing",
      ]);
    } finally {
      client.stop();
    }
  });

  it("applies every receipt to existing listeners and the roster before the next receipt", () => {
    const calls: Array<[string, unknown]> = [];
    let roster: SessionsListResult | null = {
      ts: 1,
      path: "store",
      count: 1,
      defaults: { model: null, modelProvider: null, contextTokens: null },
      sessions: [{ key: sessionKey, kind: "direct", updatedAt: 1 }],
    };
    const onEvent = vi.fn((event: GatewayEventFrame) => calls.push(["owner", event.payload]));
    const pane = vi.fn((event: GatewayEventFrame) => {
      calls.push(["pane", event.payload]);
      roster = reconcileSessionChanged(roster, event.payload).result;
      calls.push(["activeRunIds", roster?.sessions[0]?.activeRunIds]);
    });
    const onGap = vi.fn();
    const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:18789", onEvent, onGap });
    client.addEventListener(pane);
    try {
      client.start();
      const ws = getLatestWebSocket();
      ws.emitMessage({
        ...bundle([]),
        payload: {
          sessionKey,
          agentId: "main",
          receipts: [
            { payload: start, stateVersion: { presence: 1, health: 2 } },
            { payload: release },
          ],
        },
      });
      expect(calls).toEqual([
        ["owner", start],
        ["pane", start],
        ["activeRunIds", ["run-1"]],
        ["owner", release],
        ["pane", release],
        ["activeRunIds", undefined],
      ]);
      expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
        {
          type: "event",
          event: "sessions.changed",
          seq: 1,
          recipientProfileId: "profile-1",
          payload: start,
          stateVersion: { presence: 1, health: 2 },
        },
        {
          type: "event",
          event: "sessions.changed",
          seq: 1,
          recipientProfileId: "profile-1",
          payload: release,
          stateVersion: undefined,
        },
      ]);
      expect(onEvent.mock.calls[0]?.[0]).toBe(pane.mock.calls[0]?.[0]);
      ws.emitMessage({ type: "event", event: "sessions.changed", seq: 2, payload: start });
      expect(onGap).not.toHaveBeenCalled();
      expect(onEvent).toHaveBeenCalledTimes(3);
      ws.emitMessage(bundle([release], 4));
      expect(onGap).toHaveBeenCalledExactlyOnceWith({ expected: 3, received: 4 });
      expect(onEvent).toHaveBeenCalledTimes(3);
    } finally {
      client.stop();
    }
  });

  it("isolates callback failures without losing later receipts or other listeners", () => {
    const error = new Error("listener failed");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const onEvent = vi.fn(() => {
      throw error;
    });
    const pane = vi.fn();
    const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:18789", onEvent });
    client.addEventListener(pane);
    try {
      client.start();
      getLatestWebSocket().emitMessage(bundle([start, release]));
      expect(onEvent).toHaveBeenCalledTimes(2);
      expect(pane.mock.calls.map(([event]) => event.payload)).toEqual([start, release]);
      expect(logged).toHaveBeenCalledTimes(2);
    } finally {
      client.stop();
    }
  });

  it.each(["owner", "listener"])(
    "retires remaining receipts when the %s stops the client",
    (owner) => {
      const onEvent = vi.fn(() => {
        if (owner === "owner") {
          client.stop();
        }
      });
      const pane = vi.fn(() => client.stop());
      const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:18789", onEvent });
      client.addEventListener(pane);
      try {
        client.start();
        getLatestWebSocket().emitMessage(bundle([start, release]));
        expect(onEvent).toHaveBeenCalledTimes(1);
        expect(pane).toHaveBeenCalledTimes(owner === "owner" ? 0 : 1);
      } finally {
        client.stop();
      }
    },
  );

  it("rejects an incomplete bundle before applying any receipt", () => {
    const onEvent = vi.fn();
    const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:18789", onEvent });
    try {
      client.start();
      const ws = getLatestWebSocket();
      ws.emitMessage({
        ...bundle([]),
        payload: { sessionKey, receipts: [{ payload: start }, {}] },
      });
      expect(onEvent).not.toHaveBeenCalled();
      expect(ws.lastClose).toEqual({ code: 4000, reason: "invalid session change bundle" });
    } finally {
      client.stop();
    }
  });
});

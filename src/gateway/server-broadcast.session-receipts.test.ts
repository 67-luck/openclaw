import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import type { EventFrame } from "../../packages/gateway-protocol/src/schema/frames.js";
import { queuePluginSessionsChanged } from "../plugins/gateway-events.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayConnectionTransport } from "./server/connection-transport.js";
import type { GatewayWsClient } from "./server/ws-types.js";

vi.mock("../plugins/gateway-events.js", () => ({ queuePluginSessionsChanged: vi.fn() }));

class ReceiptSocket extends EventEmitter implements GatewayConnectionTransport {
  readyState = 1;
  bufferedAmount = 0;
  frames: EventFrame[] = [];
  close = vi.fn();
  terminate = vi.fn();
  send(frame: string, callback?: (error?: Error) => void): void;
  send(frame: Buffer, options: { binary: false }, callback?: (error?: Error) => void): void;
  send(
    frame: string | Buffer,
    options?: { binary: false } | ((error?: Error) => void),
    callback?: (error?: Error) => void,
  ): void {
    this.frames.push(JSON.parse(frame.toString()));
    (typeof options === "function" ? options : callback)?.();
  }
}

function peer(connId: string, bundles = true) {
  const socket = new ReceiptSocket();
  const client: GatewayWsClient = {
    connId,
    socket,
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: 4,
      maxProtocol: 4,
      client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read"],
      caps: bundles ? [GATEWAY_CLIENT_CAPS.SESSION_CHANGED_BUNDLES] : [],
    },
  };
  return { client, socket };
}

const sessionKey = "agent:main:receipts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(queuePluginSessionsChanged).mockClear();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("negotiated session receipt delivery", () => {
  it("retains every projected receipt in order and leaves legacy and plugin delivery individual", () => {
    const capable = peer("capable");
    const legacy = peer("legacy", false);
    const delivered = vi.fn();
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([capable.client, legacy.client]),
      prepareSessionEventProjection: (_event, payload) => (client) => ({
        payload: { original: payload, viewer: client.connId },
        delivered,
      }),
    });
    const receipts = [
      { sessionKey, phase: "start", endedAt: null },
      { sessionKey, reason: "agent.run.started" },
      { sessionKey, reason: "run-capacity", status: "queued" },
      { sessionKey, reason: "run-capacity", status: "running" },
      { sessionKey, phase: "model", activeModel: null },
      { sessionKey, reason: "agent.input.settled", hasActiveRun: false, activeRunIds: [] },
    ];
    for (const receipt of receipts) {
      broadcast("sessions.changed", receipt, { stateVersion: { presence: 1, health: 2 } });
    }
    expect(capable.socket.frames).toEqual([]);
    expect(legacy.socket.frames.map((frame) => frame.payload)).toEqual(
      receipts.map((original) => ({ original, viewer: "legacy" })),
    );
    expect(queuePluginSessionsChanged).toHaveBeenCalledTimes(receipts.length);
    vi.advanceTimersByTime(25);
    expect(capable.socket.frames).toEqual([
      {
        type: "event",
        event: "sessions.changed.bundle",
        seq: 1,
        payload: {
          sessionKey,
          receipts: receipts.map((original) => ({
            payload: { original, viewer: "capable" },
            stateVersion: { presence: 1, health: 2 },
          })),
        },
      },
    ]);
    expect(delivered).toHaveBeenCalledTimes(receipts.length * 2);
    expect(queuePluginSessionsChanged).toHaveBeenCalledTimes(receipts.length);
  });

  it("flushes before transcript, unrelated-session, and shutdown barriers without sequence gaps", () => {
    const { client, socket } = peer("ordered");
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([client]),
    });
    broadcast("sessions.changed", { sessionKey, reason: "send" });
    broadcast("sessions.changed", { sessionKey, reason: "participants" });
    broadcast("session.message", { sessionKey, messageId: "accepted-input" });
    broadcast("sessions.changed", { sessionKey, phase: "end" });
    broadcast("sessions.changed", { sessionKey: "agent:main:other", reason: "send" });
    broadcast("shutdown", { reason: "restart" });
    expect(socket.frames.map(({ event, seq }) => [event, seq])).toEqual([
      ["sessions.changed.bundle", 1],
      ["session.message", 2],
      ["sessions.changed.bundle", 3],
      ["sessions.changed.bundle", 4],
      ["shutdown", 5],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("captures immutable row bytes before the publication burst changes its source", () => {
    const { client, socket } = peer("snapshots");
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([client]),
    });
    const payload = { sessionKey, phase: "model", activeModel: "selected" };
    broadcast("sessions.changed", payload);
    payload.activeModel = "replacement";
    broadcast("sessions.changed", payload);
    vi.advanceTimersByTime(25);
    expect(socket.frames[0]?.payload).toEqual({
      sessionKey,
      receipts: [{ payload: { sessionKey, phase: "model", activeModel: "selected" } }, { payload }],
    });
  });

  it.each(["scope", "sharing", "subscription", "profile", "socket", "disconnect"] as const)(
    "does not deliver retained rows after %s authority retires",
    (kind) => {
      const { client, socket } = peer("revoked");
      const replacement = new ReceiptSocket();
      const targets = new Set([client.connId]);
      let allowed = true;
      const { broadcastToConnIds, getBufferedAmount } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry([client]),
        canReceiveSessionEvent: () => allowed,
      });
      broadcastToConnIds("sessions.changed", { sessionKey, reason: "send" }, targets);
      expect(getBufferedAmount(client.connId)).toBeGreaterThan(0);
      if (kind === "scope") {
        client.connect.scopes = [];
      }
      if (kind === "sharing") {
        allowed = false;
      }
      if (kind === "subscription") {
        targets.clear();
      }
      if (kind === "profile") {
        client.preparedRecipientProfileId = "new-profile";
      }
      if (kind === "socket") {
        client.socket = replacement;
      }
      if (kind === "disconnect") {
        socket.emit("close", 1000, Buffer.alloc(0));
      }
      vi.advanceTimersByTime(25);
      expect(socket.frames).toEqual([]);
      expect(replacement.frames).toEqual([]);
      expect(getBufferedAmount(client.connId)).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds receipt count while retaining all capacity transitions", () => {
    const { client, socket } = peer("bounded");
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([client]),
    });
    for (let index = 0; index < 33; index++) {
      broadcast("sessions.changed", { sessionKey, reason: "run-capacity", index });
    }
    expect(socket.frames).toHaveLength(1);
    vi.advanceTimersByTime(25);
    expect(socket.frames.map((frame) => frame.payload)).toEqual(
      [32, 1].map((count, batch) => ({
        sessionKey,
        receipts: Array.from({ length: count }, (_, index) => ({
          payload: { sessionKey, reason: "run-capacity", index: batch * 32 + index },
        })),
      })),
    );
    expect(socket.frames.map((frame) => frame.seq)).toEqual([1, 2]);
  });

  it("does not charge retired receipts to a replacement socket's byte budget", () => {
    const { client, socket } = peer("replaced");
    const { broadcast, getBufferedAmount } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([client]),
    });
    broadcast("sessions.changed", { sessionKey, reason: "send" });
    const replacement = new ReceiptSocket();
    replacement.bufferedAmount = MAX_BUFFERED_BYTES - 1;
    client.socket = replacement;
    expect(getBufferedAmount(client.connId)).toBe(replacement.bufferedAmount);
    broadcast(
      "sessions.changed",
      { sessionKey, reason: "agent.run.started" },
      { dropIfSlow: true },
    );
    replacement.bufferedAmount = 0;
    vi.advanceTimersByTime(25);
    expect(socket.frames).toEqual([]);
    expect(replacement.frames).toEqual([
      {
        type: "event",
        event: "sessions.changed.bundle",
        seq: 1,
        payload: {
          sessionKey,
          receipts: [{ payload: { sessionKey, reason: "agent.run.started" } }],
        },
      },
    ]);
  });

  it("keeps slow-consumer drops observable through the outer sequence", () => {
    const { client, socket } = peer("slow");
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([client]),
    });
    broadcast("tick", { ts: 0 });
    broadcast("sessions.changed", { sessionKey, reason: "send" }, { dropIfSlow: true });
    socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    vi.advanceTimersByTime(25);
    socket.bufferedAmount = 0;
    broadcast("tick", { ts: 25 });
    expect(socket.frames.map((frame) => frame.seq)).toEqual([1, 3]);
  });
});

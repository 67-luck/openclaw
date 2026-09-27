import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { GatewayClient } from "./server-methods/types.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";

it.each([0, 7])(
  "bounds ready list bursts and refreshes visibility after yielding (%i ms per response)",
  async (responseCost) => {
    vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] });
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    setRuntimeConfigSnapshot(cfg);
    const visibleKey = "agent:main:visible";
    const revokedKey = "agent:main:revoked";
    const entry = {
      sessionId: "visible",
      updatedAt: 1,
      label: "Original",
      visibility: "shared" as const,
      createdActor: { type: "human" as const, source: "profile" as const, id: "owner" },
    };
    const projection = createSessionRowProjectionFixture({
      cfg,
      store: {
        [visibleKey]: entry,
        [revokedKey]: { ...entry, sessionId: "revoked" },
      },
    });
    const client: GatewayClient = {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
        role: "operator",
        scopes: ["operator.read"],
      },
      authenticatedUserProfile: {
        profileId: "viewer",
        displayName: "Viewer",
        hasAvatar: false,
        updatedAt: 1,
      },
      preparedSessionProfile: { profileId: "viewer", aliases: new Set(["viewer"]), role: null },
    };
    const replies: Array<{
      request: number;
      turn: number;
      result: Awaited<ReturnType<typeof listProjectedSessions>>;
    }> = [];
    const batchSizes: number[] = [];
    let turn = 0;
    let observed = 0;
    let observing = true;
    const count = 12;
    setImmediate(function observeTurn() {
      batchSizes.push(replies.length - observed);
      observed = replies.length;
      if (turn++ === 0) {
        projection.setEntry(visibleKey, { ...entry, updatedAt: 2, label: "Current" });
        projection.setEntry(revokedKey, {
          ...entry,
          sessionId: "revoked",
          updatedAt: 2,
          visibility: "draft",
        });
      }
      if (observing && replies.length < count) {
        setImmediate(observeTurn);
      }
    });
    const requests = Array.from({ length: count }, (_, request) =>
      listProjectedSessions({
        projection,
        client,
        opts: {},
        onResult: (result) => {
          replies.push({ request, turn, result });
          now += responseCost;
        },
      }),
    );
    const settled = Promise.all(requests);
    try {
      await vi.runAllTimersAsync();
      await settled;
      expect(batchSizes[0]).toBeGreaterThan(0);
      expect(batchSizes.length).toBeGreaterThan(1);
      expect(Math.max(...batchSizes)).toBeLessThanOrEqual(responseCost === 0 ? 8 : 1);
      expect(replies.map((reply) => reply.request)).toEqual(
        Array.from({ length: count }, (_, index) => index),
      );
      for (const { turn, result } of replies) {
        expect(result.sessions.find((row) => row.key === visibleKey)?.label).toBe(
          turn === 0 ? "Original" : "Current",
        );
        expect(result.sessions.some((row) => row.key === revokedKey)).toBe(turn === 0);
      }
    } finally {
      observing = false;
      await vi.runAllTimersAsync();
      await Promise.allSettled(requests);
      projection.dispose();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  },
);

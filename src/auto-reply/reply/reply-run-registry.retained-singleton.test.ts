import { afterEach, describe, expect, it, vi } from "vitest";

const REPLY_RUN_STATE_KEY = Symbol.for("openclaw.sessionControllers");

afterEach(() => {
  const store = globalThis as Record<PropertyKey, unknown>;
  delete store[REPLY_RUN_STATE_KEY];
  vi.resetModules();
});

describe("reply run registry retained singleton", () => {
  it("retains a live source binding across module reload and clears it with its owner", async () => {
    const { createReplyOperation, replyRunRegistry } =
      await import("../../sessions/session-controller.js");
    const key = "agent:main:reload";
    const operation = createReplyOperation({
      sessionKey: key,
      sessionId: "reload-session",
      resetTriggered: false,
    });
    operation.setPhase("running");
    replyRunRegistry.bindSourceTurnId(operation, "reload-source");
    let reloaded: typeof import("../../sessions/session-controller.js");
    try {
      vi.resetModules();
      reloaded = await import("../../sessions/session-controller.js");
      expect(reloaded.replyRunRegistry.get(key)).toBe(operation);
      expect(reloaded.replyRunRegistry.getSourceTurnId(key)).toBe("reload-source");
    } finally {
      operation.complete();
    }
    expect(reloaded.replyRunRegistry.isActive(key)).toBe(false);
    expect(reloaded.replyRunRegistry.getSourceTurnId(key)).toBeUndefined();
  });

  it("keeps frozen outcome and retention with the owner across module reload", async () => {
    const initial = await import("../../sessions/session-controller.js");
    const operation = initial.createReplyOperation({
      sessionKey: "agent:main:frozen-reload",
      sessionId: "frozen-session",
      resetTriggered: false,
    });
    operation.setPhase("running");
    operation.freezeAbort();
    try {
      vi.resetModules();
      const reloaded = await import("../../sessions/session-controller.js");
      expect(reloaded.hasCommittedReplyOperationOutcome(operation)).toBe(true);
      expect(operation.abortByUser()).toBe(false);
      operation.complete();
      const retained = reloaded.createReplyOperation({
        sessionKey: "agent:main:frozen-reload",
        sessionId: "retained-session",
        resetTriggered: false,
      });
      try {
        vi.resetModules();
        const latest = await import("../../sessions/session-controller.js");
        expect(retained.abortByUser()).toBe(true);
        expect(latest.replyRunRegistry.get(retained.key)).toBe(retained);
      } finally {
        retained.complete();
      }
    } finally {
      operation.complete();
    }
  });
});

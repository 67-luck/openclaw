// Tests prepared reply queue state resolution before get-reply starts a run.
import { describe, expect, it, vi } from "vitest";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import {
  interruptReplyRunTarget,
  replyRunRegistry,
} from "../../sessions/session-controller.registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolvePreparedReplyQueueState } from "./get-reply-run-queue.js";

describe("resolvePreparedReplyQueueState", () => {
  it("continues immediately when queue policy does not require waiting", async () => {
    const resolveBusyState = vi.fn(() => ({
      activeSessionId: undefined,
      isActive: false,
      isStreaming: false,
    }));

    const result = await resolvePreparedReplyQueueState({
      activeRunQueueAction: "enqueue-followup",
      activeSessionId: undefined,
      queueMode: "followup",
      interruptActiveRun: vi.fn(),
      waitForActiveRunEnd: vi.fn(),
      refreshPreparedState: vi.fn(),
      resolveBusyState,
    });

    expect(result).toEqual({
      kind: "continue",
      busyState: { activeSessionId: undefined, isActive: false, isStreaming: false },
    });
    expect(resolveBusyState).toHaveBeenCalledOnce();
  });

  it("aborts and waits for interrupt mode before continuing", async () => {
    const interruptActiveRun = vi.fn(async () => true);
    const waitForActiveRunEnd = vi.fn(async () => {
      throw new Error("interrupt mode must use session-work admission settling");
    });
    const refreshPreparedState = vi.fn(async () => undefined);
    const resolveBusyState = vi.fn(() => ({
      activeSessionId: undefined,
      isActive: false,
      isStreaming: false,
    }));

    const result = await resolvePreparedReplyQueueState({
      activeRunQueueAction: "run-now",
      activeSessionId: "session-active",
      queueMode: "interrupt",
      interruptActiveRun,
      waitForActiveRunEnd,
      refreshPreparedState,
      resolveBusyState,
    });

    expect(interruptActiveRun).toHaveBeenCalledOnce();
    expect(waitForActiveRunEnd).not.toHaveBeenCalled();
    expect(refreshPreparedState).toHaveBeenCalledOnce();
    expect(result).toEqual({
      kind: "continue",
      busyState: { activeSessionId: undefined, isActive: false, isStreaming: false },
    });
  });

  it("rechecks after wait and returns shutdown reply when still busy", async () => {
    const result = await resolvePreparedReplyQueueState({
      activeRunQueueAction: "run-now",
      activeSessionId: "session-active",
      queueMode: "interrupt",
      interruptActiveRun: vi.fn(async () => true),
      waitForActiveRunEnd: vi.fn(async () => undefined),
      refreshPreparedState: vi.fn(async () => undefined),
      resolveBusyState: () => ({
        activeSessionId: "session-after-wait",
        isActive: true,
        isStreaming: false,
      }),
    });

    expect(result).toEqual({
      kind: "reply",
      reply: {
        text: "⚠️ Previous run is still shutting down. Please try again in a moment.",
      },
    });
  });
  it("does not admit after interrupt timeout merely because the old slot cleared", async () => {
    vi.useFakeTimers();
    const operation = createReplyOperation({
      sessionKey: "agent:main:interrupt-settlement",
      sessionId: "old-writer",
      resetTriggered: false,
    });
    const delivery = createDeferredCore();
    const refreshPreparedState = vi.fn(async () => {});
    try {
      operation.setPhase("running");
      const target = replyRunRegistry.resolveCurrentInterruptTarget(operation.key);
      if (!target) {
        throw new Error("Missing interrupt owner");
      }
      const waiting = resolvePreparedReplyQueueState({
        activeRunQueueAction: "run-now",
        activeSessionId: operation.sessionId,
        queueMode: "interrupt",
        interruptActiveRun: async () => (await interruptReplyRunTarget(target, 100)).settled,
        waitForActiveRunEnd: async () => {
          throw new Error("wrong wait owner");
        },
        refreshPreparedState,
        resolveBusyState: () => ({
          activeSessionId: replyRunRegistry.resolveSessionId(operation.key),
          isActive: replyRunRegistry.isActive(operation.key),
        }),
      });
      expect(operation.abortSignal.aborted).toBe(true);
      operation.completeWithAfterClearBarrier(delivery.promise);
      expect(replyRunRegistry.isActive(operation.key)).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      await expect(waiting).resolves.toMatchObject({ kind: "reply" });
      expect(refreshPreparedState).not.toHaveBeenCalled();
    } finally {
      delivery.resolve();
      operation.complete();
      await operation.ownerSettlement;
      vi.useRealTimers();
    }
  });
});

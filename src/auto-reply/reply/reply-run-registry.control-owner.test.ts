import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  beginReplyMessageInjectionTarget,
  ReplyRunFollowupAdmissionBlockedError,
  ReplyRunSuccessorAdmissionBlockedError,
  waitForReplyRunSuccessorAdmission,
  createReplyOperation,
  getSessionControllerOperation,
  captureCurrentReplyMessageInjectionTarget,
} from "../../sessions/session-controller.js";
import { resolveActiveReplyRunOwnerForSignal } from "../../sessions/session-controller.state.js";
import { SESSION_WATCHDOG_CLEANUP_MS } from "../../sessions/session-controller.watchdog-state.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";

const sessionKey = "agent:main:voice-control";

afterEach(() => getSessionControllerOperation(sessionKey)?.complete());

describe("reply run control ownership", () => {
  it.each([false, true])(
    "settles producer handoff before delivery can admit a successor (cleanup expired=%s)",
    async (cleanupExpired) => {
      const controller = new AbortController();
      const operation = createTestReplyOperation({
        sessionKey,
        upstreamAbortSignal: controller.signal,
      });
      operation.setPhase("running");
      const owner = resolveActiveReplyRunOwnerForSignal(controller.signal);
      const persistence = createDeferred();
      const delivery = createDeferred();
      const started = vi.fn();
      let handoff: Promise<void> | undefined;
      try {
        expect(
          owner?.handoff((producerCompleted) => {
            handoff = producerCompleted.then(async () => {
              started();
              await persistence.promise;
            });
            return handoff;
          }),
        ).toBe(true);

        controller.abort();
        if (cleanupExpired) {
          await expect(
            operation.watchdog.tick(Date.now() + SESSION_WATCHDOG_CLEANUP_MS),
          ).resolves.toMatchObject({ action: "blocked" });
          expect(getSessionControllerOperation(sessionKey)).toBe(operation);
        }
        await Promise.resolve();
        expect(started).not.toHaveBeenCalled();
        expect(() => createTestReplyOperation({ sessionKey })).toThrow();

        operation.completeWithAfterClearBarrier(delivery.promise);
        await Promise.resolve();
        expect(started).toHaveBeenCalledOnce();
        expect(() => createTestReplyOperation({ sessionKey })).toThrow(
          ReplyRunFollowupAdmissionBlockedError,
        );
        const nextAdmission = waitForReplyRunSuccessorAdmission(operation.key, null);
        if (cleanupExpired) {
          // Raw delivery settlement cannot settle the separately owned handoff fence.
          delivery.resolve();
          await operation.ownerSettlement;
          expect(() => createTestReplyOperation({ sessionKey })).toThrow(
            ReplyRunSuccessorAdmissionBlockedError,
          );
        }
        persistence.resolve();
        await handoff;
        await expect(nextAdmission).resolves.toMatchObject({ settled: true });

        // Handoff settlement alone cannot release raw delivery custody.
        if (!cleanupExpired) {
          expect(() => createTestReplyOperation({ sessionKey, sessionId: "successor" })).toThrow();
        }
        delivery.resolve();
        await operation.ownerSettlement;
        const successor = createTestReplyOperation({ sessionKey, sessionId: "successor" });
        successor.complete();
        expect(owner?.handoff(async () => {})).toBe(false);
      } finally {
        persistence.resolve();
        delivery.resolve();
        operation.complete();
        await operation.ownerSettlement;
      }
    },
  );

  it.each(["required", "optional"] as const)(
    "keeps a mismatched input out of a %s reply owner",
    async (terminalReplyExpectation) => {
      const queueMessage = vi.fn(async () => {});
      const operation = createReplyOperation({
        sessionKey,
        sessionId: "session-reply-expectation",
        resetTriggered: false,
      });
      operation.attachBackend({
        kind: "embedded",
        terminalReplyExpectation,
        cancel: vi.fn(),
        queueMessage,
      });
      operation.setPhase("running");
      const target = captureCurrentReplyMessageInjectionTarget(operation.key);
      if (!target) {
        throw new Error("Expected a live message injection target");
      }
      await expect(
        beginReplyMessageInjectionTarget(target, "different input", {
          terminalReplyExpectation:
            terminalReplyExpectation === "required" ? "optional" : "required",
        }).outcome,
      ).resolves.toEqual({ status: "rejected", reason: "reply_expectation_mismatch" });
      expect(queueMessage).not.toHaveBeenCalled();
      await expect(
        beginReplyMessageInjectionTarget(target, "matching input", {
          terminalReplyExpectation,
        }).outcome,
      ).resolves.toEqual({ status: "accepted" });
      expect(queueMessage).toHaveBeenCalledOnce();
    },
  );

  it.each(["key", "sessionId"] as const)(
    "fences retained controls after its %s changes",
    (field) => {
      const controller = new AbortController();
      const operation = createReplyOperation({
        sessionKey,
        sessionId: "original-session",
        resetTriggered: false,
        upstreamAbortSignal: controller.signal,
      });
      try {
        const owner = resolveActiveReplyRunOwnerForSignal(controller.signal);
        if (field === "key") {
          operation.updateSessionKey("agent:main:voice-control-rekeyed");
        } else {
          operation.updateSessionId("replacement-session");
        }
        expect(owner?.abort()).toBe(false);
        expect(operation.abortSignal.aborted).toBe(false);
      } finally {
        operation.complete();
      }
    },
  );

  it("controls a queued reply only through its admitted upstream signal", () => {
    const controller = new AbortController();
    const operation = createReplyOperation({
      sessionKey,
      sessionId: "queued-session",
      resetTriggered: false,
      upstreamAbortSignal: controller.signal,
    });
    expect(resolveActiveReplyRunOwnerForSignal(new AbortController().signal)).toBeUndefined();
    const owner = resolveActiveReplyRunOwnerForSignal(controller.signal);
    expect(owner?.sessionId).toBe("queued-session");
    expect(owner?.abort()).toBe(true);
    expect(operation.abortSignal.aborted).toBe(true);
    expect(resolveActiveReplyRunOwnerForSignal(controller.signal)).toBeUndefined();
  });

  it("fences retained controls after same-session replacement", () => {
    const controller = new AbortController();
    const operation = createReplyOperation({
      sessionKey,
      sessionId: "same-session",
      resetTriggered: false,
      upstreamAbortSignal: controller.signal,
    });
    const owner = resolveActiveReplyRunOwnerForSignal(controller.signal);
    operation.complete();
    const successor = createReplyOperation({
      sessionKey,
      sessionId: "same-session",
      resetTriggered: false,
      upstreamAbortSignal: new AbortController().signal,
    });
    expect(resolveActiveReplyRunOwnerForSignal(controller.signal)).toBeUndefined();
    expect(owner?.abort()).toBe(false);
    expect(successor.abortSignal.aborted).toBe(false);
  });
});

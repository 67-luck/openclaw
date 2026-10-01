import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getActiveNativeAttempt,
  type EmbeddedAgentQueueHandle,
} from "../agents/embedded-agent-runner/run-state.js";
import {
  setActiveEmbeddedRun,
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunAbortableForRunId,
  abortEmbeddedAgentRun,
  waitForEmbeddedAgentRunEnd,
} from "../agents/embedded-agent-runner/runs.js";
import { testing as nativeTesting } from "../agents/embedded-agent-runner/runs.test-support.js";
import { testing as controllerTesting } from "../auto-reply/reply/reply-run-registry.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withSessionTurn } from "./session-controller.admission.js";
import type { ReplyBackendHandle, ReplyOperation } from "./session-controller.contracts.js";
import { reserveSessionControllerSource } from "./session-controller.mailbox.js";
import { createReplyOperation } from "./session-controller.operation.js";
import {
  getActiveSessionRunCount,
  isSessionRunActive,
  resolveSessionRunProgressState,
} from "./session-controller.queries.js";
import { abortActiveReplyRuns } from "./session-controller.registry.js";
import { getSessionControllerOperation } from "./session-controller.state.js";

function handle(runId: string): EmbeddedAgentQueueHandle & ReplyBackendHandle {
  return {
    kind: "embedded",
    runId,
    queueMessage: vi.fn(async () => {}),
    isStreaming: () => true,
    isCompacting: () => false,
    abort: vi.fn(),
    cancel: vi.fn(),
  };
}

const sessionKey = "agent:main:controller-native";
const sessionId = "controller-native-session";
afterEach(() => {
  nativeTesting.resetActiveEmbeddedRuns();
  controllerTesting.resetReplyRunRegistry();
});

describe("controller/native admission boundary", () => {
  it("borrows an input only in its admitted async context, not from a concurrent invocation", async () => {
    const input = reserveSessionControllerSource(sessionKey, { policy: { mode: "followup" } });
    const started = createDeferredCore();
    const finish = createDeferredCore();
    const admission = { sessionKey, sessionId, controllerInput: input };
    const duplicate = vi.fn(async () => {});
    const first = withSessionTurn(admission, async (operation) => {
      await withSessionTurn(admission, async (nested) => expect(nested).toBe(operation));
      started.resolve();
      await finish.promise;
    });
    try {
      await started.promise;
      await expect(withSessionTurn(admission, duplicate)).rejects.toThrow(/already.*admission/);
      expect(duplicate).not.toHaveBeenCalled();
      expect(getActiveSessionRunCount()).toBe(1);
    } finally {
      finish.resolve();
      await first;
      await input.settlement.promise;
    }
  });

  it("reserves direct work before backend registration and serializes another producer on that same turn", async () => {
    const release = createDeferredCore();
    const started = createDeferredCore();
    const secondStarted = vi.fn();
    const native = handle("first-native");
    let firstOperation: ReplyOperation | undefined;
    const first = withSessionTurn({ sessionKey, sessionId }, async (operation) => {
      firstOperation = operation;
      expect(getSessionControllerOperation(sessionKey)).toBe(operation);
      expect(isSessionRunActive(sessionId)).toBe(true);
      expect(resolveSessionRunProgressState(sessionId)).toBe("queued");
      expect(getActiveNativeAttempt(sessionId)).toBeUndefined();
      setActiveEmbeddedRun(sessionId, native, sessionKey, undefined, "main", operation);
      expect(resolveSessionRunProgressState(sessionId)).toBe("running");
      started.resolve();
      await release.promise;
      clearActiveEmbeddedRun(sessionId, native);
    });
    await started.promise;
    const second = withSessionTurn({ sessionKey, sessionId }, async (operation) => {
      secondStarted();
      expect(operation).not.toBe(firstOperation);
      expect(getSessionControllerOperation(sessionKey)).toBe(operation);
    });
    await Promise.resolve();
    expect(secondStarted).not.toHaveBeenCalled();
    expect(getActiveSessionRunCount()).toBe(1);
    release.resolve();
    await Promise.all([first, second]);
    expect(secondStarted).toHaveBeenCalledOnce();
    expect(isSessionRunActive(sessionId)).toBe(false);
  });

  it("refuses unadmitted or stale registration even when native run IDs match", () => {
    const first = handle("reused-native-id");
    expect(() => setActiveEmbeddedRun(sessionId, first, sessionKey)).toThrow(/admission/);
    const old = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    setActiveEmbeddedRun(sessionId, first, sessionKey, undefined, "main", old);
    clearActiveEmbeddedRun(sessionId, first);
    old.complete();
    const current = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    const replacement = handle("reused-native-id");
    setActiveEmbeddedRun(sessionId, replacement, sessionKey, undefined, "main", current);
    expect(() =>
      setActiveEmbeddedRun(sessionId, first, sessionKey, undefined, "main", old),
    ).toThrow(/admission/);
    clearActiveEmbeddedRun(sessionId, first);
    expect(getActiveNativeAttempt(sessionId)).toBe(replacement);
    expect(getSessionControllerOperation(sessionKey)).toBe(current);
    expect(replacement.cancel).not.toHaveBeenCalled();
    current.complete();
  });

  it("borrows one operation for retries and cannot let an old native detach retire its replacement", async () => {
    await withSessionTurn({ sessionKey, sessionId }, async (operation) => {
      const first = handle("attempt-1");
      const second = handle("attempt-2");
      setActiveEmbeddedRun(sessionId, first, sessionKey, undefined, "main", operation);
      await withSessionTurn(
        { sessionKey, sessionId, replyOperation: operation },
        async (borrowed) => {
          expect(borrowed).toBe(operation);
          setActiveEmbeddedRun(sessionId, second, sessionKey, undefined, "main", borrowed);
        },
      );
      clearActiveEmbeddedRun(sessionId, first);
      expect(getActiveNativeAttempt(sessionId)).toBe(second);
      expect(getSessionControllerOperation(sessionKey)).toBe(operation);
      expect(getActiveSessionRunCount()).toBe(1);
      clearActiveEmbeddedRun(sessionId, second);
    });
    expect(getActiveSessionRunCount()).toBe(0);
  });

  it("does not include a synchronously admitted replacement in an already captured restart sweep", () => {
    const first = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    let successor: ReplyOperation | undefined;
    const replacement = handle("replacement-native");
    first.attachBackend({
      kind: "embedded",
      cancel: () => {
        first.complete();
        successor = createReplyOperation({
          sessionKey,
          sessionId: "replacement-session",
          resetTriggered: false,
        });
        setActiveEmbeddedRun(
          "replacement-session",
          replacement,
          sessionKey,
          undefined,
          "main",
          successor,
        );
      },
    });
    first.setPhase("running");
    expect(abortActiveReplyRuns({ mode: "all" })).toBe(true);
    expect(getSessionControllerOperation(sessionKey)).toBe(successor);
    expect(successor?.result).toBeNull();
    expect(replacement.cancel).not.toHaveBeenCalled();
    successor?.complete();
  });

  it("cancels detached work by exact native identity and waits for its actual return", async () => {
    const native = handle("detached-abort");
    await withSessionTurn({ sessionId, detached: true }, async () => {
      setActiveEmbeddedRun(sessionId, native);
      let settled = false;
      const ended = waitForEmbeddedAgentRunEnd(sessionId, null).then((value) => {
        settled = true;
        return value;
      });
      expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
      expect(native.abort).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(settled).toBe(false);
      clearActiveEmbeddedRun(sessionId, native);
      expect(await ended).toBe(true);
      expect(isSessionRunActive(sessionId)).toBe(false);
    });
  });

  it("retains native authority for detached work without projecting a session", async () => {
    const native = { ...handle("detached-run"), isAbortable: () => false };
    await withSessionTurn({ sessionId, detached: true }, async (operation) => {
      expect(operation).toBeUndefined();
      setActiveEmbeddedRun(sessionId, native);
      expect(isEmbeddedAgentRunAbortableForRunId("detached-run")).toBe(false);
      expect(abortEmbeddedAgentRun(sessionId)).toBe(false);
      expect(native.abort).not.toHaveBeenCalled();
      expect(getActiveNativeAttempt(sessionId)).toBe(native);
      expect(isSessionRunActive(sessionId)).toBe(false);
      expect(getActiveSessionRunCount()).toBe(0);
      clearActiveEmbeddedRun(sessionId, native);
    });
  });
});

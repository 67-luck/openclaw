import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import type { ReplyBackendHandle } from "../../sessions/session-controller.contracts.js";
import {
  abortActiveReplyRuns,
  clearReplyRunForResetBySessionId,
  isSessionRunActive,
  isSessionRunActiveForKey,
} from "../../sessions/session-controller.js";
import { isSessionRunCompactionBlocked as isReplyRunAbortableForCompaction } from "../../sessions/session-controller.queries.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { testing } from "./reply-run-registry.test-support.js";
import { requestCurrentSessionStop } from "./reply-run-stop.test-support.js";

function createRunningOperation(
  upstreamAbortSignal?: AbortSignal,
  overrides: Pick<ReplyBackendHandle, "isStreaming" | "isAbortable"> = {},
) {
  const operation = createTestReplyOperation({ upstreamAbortSignal });
  const cancel = vi.fn();
  const backend = { kind: "embedded" as const, cancel, isStreaming: () => true, ...overrides };
  operation.attachBackend(backend);
  operation.setPhase("running");
  return { operation, cancel, backend };
}

describe("reply run registry cancellation", () => {
  afterEach(() => {
    testing.resetReplyRunRegistry();
    resetCommandQueueStateForTest();
    resetDiagnosticRunActivityForTest();
    vi.restoreAllMocks();
  });

  it("treats queued reply operations as non-abortable for compaction", () => {
    const operation = createTestReplyOperation({
      sessionId: "session-compact",
    });

    expect(isSessionRunActive("session-compact")).toBe(true);
    expect(isReplyRunAbortableForCompaction("session-compact")).toBe(false);

    operation.markWaitingForDeferredMaintenance();

    expect(isReplyRunAbortableForCompaction("session-compact")).toBe(false);

    operation.markDeferredMaintenanceWaitEnded();
    operation.setPhase("running");

    expect(isReplyRunAbortableForCompaction("session-compact")).toBe(true);
  });

  it("retains deferred-maintenance custody until its aborted producer completes", () => {
    const operation = createTestReplyOperation({
      sessionId: "session-waiting-abort",
    });

    operation.markWaitingForDeferredMaintenance();
    operation.abortByUser();

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(isSessionRunActiveForKey("agent:main:main")).toBe(true);
    expect(isSessionRunActive("session-waiting-abort")).toBe(true);
    expect(() => createTestReplyOperation()).toThrow();
    operation.complete();
    expect(isSessionRunActiveForKey("agent:main:main")).toBe(false);
    expect(isSessionRunActive("session-waiting-abort")).toBe(false);
  });

  it("does not reset deferred-maintenance operations as backend-owned work", () => {
    const operation = createTestReplyOperation({
      sessionId: "session-waiting-reset",
    });

    operation.markWaitingForDeferredMaintenance();
    clearReplyRunForResetBySessionId("session-waiting-reset");

    expect(operation.result).toBeNull();
    expect(isSessionRunActiveForKey("agent:main:main")).toBe(true);
  });

  it("keeps retained terminal failures immutable across late aborts", () => {
    const upstreamAbort = new AbortController();
    const { operation, cancel } = createRunningOperation(upstreamAbort.signal, {
      isStreaming: () => false,
      isAbortable: () => true,
    });

    operation.fail("run_failed", new Error("provider failed"));
    upstreamAbort.abort(new Error("late upstream abort"));

    expect(operation.abortSignal.aborted).toBe(false);
    expect(operation.abortByUser()).toBe(false);
    expect(operation.abortForRestart()).toBe(false);
    expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    expect(operation.phase).toBe("failed");
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each([
    { reason: new Error("caller cancelled"), code: "aborted_by_user", cancelReason: "user_abort" },
    {
      reason: createAgentRunRestartAbortError(),
      code: "aborted_for_restart",
      cancelReason: "restart",
    },
    {
      reason: createAgentRunRestartAbortError(),
      code: "aborted_by_user",
      cancelReason: "user_abort",
      userFirst: true,
    },
  ])(
    "records cancellation once as $code (userFirst=$userFirst)",
    ({ reason, code, cancelReason, userFirst }) => {
      const upstreamAbort = new AbortController();
      const { operation, cancel } = createRunningOperation(upstreamAbort.signal);
      if (userFirst) {
        expect(operation.abortByUser()).toBe(true);
      }
      upstreamAbort.abort(reason);

      expect(operation.result).toEqual({ kind: "aborted", code });
      expect(operation.phase).toBe("aborted");
      expect(operation.abortSignal.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledWith(cancelReason);
      operation.complete();
    },
  );

  it("retains already-aborted queued ownership until its producer completes", () => {
    const upstreamAbort = new AbortController();
    upstreamAbort.abort(new Error("caller already cancelled"));

    const operation = createTestReplyOperation({
      sessionKey: "agent:main:already-cancelled",
      sessionId: "session-already-cancelled",
      upstreamAbortSignal: upstreamAbort.signal,
    });

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(operation.phase).toBe("aborted");
    expect(operation.abortSignal.aborted).toBe(true);
    expect(isSessionRunActiveForKey("agent:main:already-cancelled")).toBe(true);
    expect(() => createTestReplyOperation({ sessionKey: operation.key })).toThrow();
    operation.complete();
    expect(isSessionRunActiveForKey("agent:main:already-cancelled")).toBe(false);
  });

  it("rejects aborts while the attached backend is finalizing", async () => {
    let abortable = false;
    const { operation, cancel } = createRunningOperation(undefined, {
      isStreaming: () => false,
      isAbortable: () => abortable,
    });

    expect(await requestCurrentSessionStop(operation.key)).toBe(false);
    expect(abortActiveReplyRuns({ mode: "all" })).toBe(false);
    expect(operation.result).toBeNull();
    expect(cancel).not.toHaveBeenCalled();

    abortable = true;
    expect(await requestCurrentSessionStop(operation.key)).toBe(true);
    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(cancel).toHaveBeenCalledWith("user_abort");
  });

  it("keeps abort frozen after the backend detaches for reply delivery", async () => {
    const upstreamAbort = new AbortController();
    const { operation, cancel, backend } = createRunningOperation(upstreamAbort.signal, {
      isStreaming: () => false,
      isAbortable: () => false,
    });
    operation.freezeAbort();
    operation.detachBackend(backend);

    expect(operation.phase).toBe("running");
    expect(await requestCurrentSessionStop(operation.key)).toBe(false);
    expect(operation.result).toBeNull();
    expect(cancel).not.toHaveBeenCalled();

    upstreamAbort.abort();
    expect(operation.abortSignal.aborted).toBe(false);

    operation.complete();
    expect(isSessionRunActiveForKey(operation.key)).toBe(false);
  });

  it("aborts compacting runs through the registry compatibility helper", () => {
    const faultyOperation = createTestReplyOperation({
      sessionKey: "agent:main:faulty",
      sessionId: "session-faulty",
    });
    faultyOperation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isCompacting: () => {
        throw new Error("compaction probe unavailable");
      },
    });
    faultyOperation.setPhase("running");
    const compactingOperation = createTestReplyOperation({
      sessionId: "session-compacting",
    });
    compactingOperation.setPhase("preflight_compacting");

    const runningOperation = createTestReplyOperation({
      sessionKey: "agent:main:other",
      sessionId: "session-running",
    });
    runningOperation.setPhase("running");

    expect(abortActiveReplyRuns({ mode: "compacting" })).toBe(true);
    expect(compactingOperation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(runningOperation.result).toBeNull();
    expect(faultyOperation.result).toBeNull();
  });
});

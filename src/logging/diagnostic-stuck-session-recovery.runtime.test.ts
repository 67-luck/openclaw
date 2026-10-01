import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing } from "../auto-reply/reply/reply-run-registry.test-support.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { getSessionControllerOperation } from "../sessions/session-controller.state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requestStuckSessionRecovery } from "./diagnostic-session-recovery-coordinator.js";
import type { StuckSessionRecoveryRequest } from "./diagnostic-session-recovery.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "./diagnostic-session-state.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";

const sessionKey = "agent:main:recovery-boundary";
const sessionId = "recovery-incarnation";
const classification = {
  eventType: "session.stalled",
  reason: "active_work_without_progress",
  classification: "stalled_agent_run",
  activeWorkKind: "embedded_run",
  recoveryEligible: false,
} as const;
function begin() {
  const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  operation.setPhase("running");
  return operation;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  testing.resetReplyRunRegistry();
  resetDiagnosticSessionStateForTest();
  vi.useRealTimers();
});

describe("diagnostic recovery delegates only to a captured controller", () => {
  it("cannot infer stop or idle authority from missing diagnostic/native records", async () => {
    const operation = begin();
    const cancel = vi.fn();
    operation.attachBackend({ kind: "embedded", cancel });
    vi.setSystemTime(60 * 60_000);
    const outcome = await recoverStuckDiagnosticSession({
      sessionKey,
      sessionId,
      ageMs: Date.now(),
      allowActiveAbort: true,
    });
    expect(outcome).toMatchObject({ status: "skipped", reason: "missing_session_ref" });
    expect(cancel).not.toHaveBeenCalled();
    expect(getSessionControllerOperation(sessionKey)).toBe(operation);
  });

  it.each([true, false])(
    "captures A before asynchronous runtime loading and never stops replacement B (keyed=%s)",
    async (keyed) => {
      const first = begin();
      const loaded = createDeferredCore();
      const completed = createDeferredCore();
      let captured: StuckSessionRecoveryRequest | undefined;
      requestStuckSessionRecovery({
        classification,
        request: { ...(keyed ? { sessionKey } : {}), sessionId, ageMs: 1_000_000 },
        recover: async (request) => {
          captured = request;
          await loaded.promise;
          const result = await recoverStuckDiagnosticSession(request);
          completed.resolve();
          return result;
        },
      });
      const capturedOperation = captured?.operation;
      first.complete();
      const replacement = begin();
      const cancel = vi.fn();
      replacement.attachBackend({ kind: "embedded", cancel });
      vi.setSystemTime(1_000_000);
      loaded.resolve();
      await completed.promise;
      expect(capturedOperation).toBe(first);
      expect(cancel).not.toHaveBeenCalled();
      expect(getSessionControllerOperation(sessionKey)).toBe(replacement);
    },
  );

  it("deduplicates stop on the operation, not a keyed recovery set", async () => {
    const operation = begin();
    const cancel = vi.fn();
    operation.attachBackend({ kind: "embedded", cancel });
    const request = { operation, sessionKey, sessionId, ageMs: 6 * 60_000 };
    vi.setSystemTime(request.ageMs);
    const first = recoverStuckDiagnosticSession(request);
    const second = recoverStuckDiagnosticSession(request);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cancel).toHaveBeenCalledOnce();
    expect(operation.watchdog.snapshot().recovery?.status).toBe("blocked");
    expect(getSessionControllerOperation(sessionKey)).toBe(operation);
    operation.complete();
    await Promise.all([first, second]);
  });

  it("reports outcomes without manufacturing idle, queue counts or activity cleanup", async () => {
    const operation = begin();
    const state = getDiagnosticSessionState({ sessionKey, sessionId });
    state.state = "processing";
    state.queueDepth = 3;
    const done = createDeferredCore();
    requestStuckSessionRecovery({
      classification,
      request: { operation, sessionKey, sessionId, ageMs: 1_000_000 },
      recover: () => {
        done.resolve();
        return {
          status: "aborted",
          action: "abort_embedded_run",
          aborted: true,
          drained: false,
          forceCleared: false,
          released: 0,
        };
      },
    });
    await done.promise;
    await Promise.resolve();
    expect(state.state).toBe("processing");
    expect(state.queueDepth).toBe(3);
    expect(getSessionControllerOperation(sessionKey)).toBe(operation);
  });
});

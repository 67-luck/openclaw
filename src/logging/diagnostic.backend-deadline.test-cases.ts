import { expect, it, vi } from "vitest";
import {
  beginDiagnosticBackendActivity,
  createDiagnosticEmbeddedRunOwner,
  closeDiagnosticEmbeddedRunOwner,
  markDiagnosticEmbeddedRunStarted,
} from "./diagnostic-run-activity.js";
import { logSessionStateChange } from "./diagnostic.js";
import { startEnabledDiagnosticHeartbeatForTest as startEnabledDiagnosticHeartbeat } from "./diagnostic.test-support.js";
import type { DiagnosticCaseFixture } from "./diagnostic.test.js";
export function registerDiagnosticBackendDeadlineCase({
  expectRecoveryCall,
}: Pick<DiagnosticCaseFixture, "expectRecoveryCall">) {
  it("defers a quiet backend until its owned silence deadline expires", () => {
    const recoverStuckSession = vi.fn();
    const ref = { sessionId: "backend-deadline", sessionKey: "agent:main:backend-deadline" };
    const runId = "backend-deadline-run";
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({ ...ref, state: "processing" });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });
    const backend = beginDiagnosticBackendActivity({
      owner,
      noOutputTimeoutMs: 180_000,
      assertCurrent: () => {},
    });
    try {
      // No output has arrived: initial silence still belongs to the backend's deadline.
      vi.advanceTimersByTime(120_000);
      expect(recoverStuckSession).not.toHaveBeenCalled();

      vi.advanceTimersByTime(60_000);
      expectRecoveryCall(recoverStuckSession, { ...ref, queueDepth: 0, allowActiveAbort: true }, [
        "ageMs",
        "stateGeneration",
      ]);
    } finally {
      backend.close();
      closeDiagnosticEmbeddedRunOwner(owner);
    }
  });
}

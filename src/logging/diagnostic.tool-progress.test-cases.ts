import { expect, it, vi } from "vitest";
import { onDiagnosticEvent, type DiagnosticEventPayload } from "../infra/diagnostic-events.js";
import {
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
} from "./diagnostic-run-activity.js";
import { markDiagnosticToolStartedForTest } from "./diagnostic-run-activity.test-support.js";
import { logSessionStateChange } from "./diagnostic.js";
import { startEnabledDiagnosticHeartbeatForTest as startEnabledDiagnosticHeartbeat } from "./diagnostic.test-support.js";

export function registerDiagnosticToolProgressCase() {
  it("does not classify active tool calls stalled while real progress frames arrive", () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticToolStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        toolName: "bash",
        toolCallId: "cmd-1",
      });

      for (let i = 0; i < 20; i += 1) {
        vi.advanceTimersByTime(29_000);
        markDiagnosticRunProgress({
          sessionId: "s1",
          sessionKey: "main",
          runId: "run-1",
          reason: "cli_live:stream_progress",
        });
        vi.advanceTimersByTime(1_000);
      }
    } finally {
      unsubscribe();
    }

    expect(events.some((event) => event.type === "session.stalled")).toBe(false);
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });
}

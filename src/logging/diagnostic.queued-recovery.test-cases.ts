import { expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  onDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import {
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
} from "./diagnostic-run-activity.js";
import {
  markDiagnosticModelStartedForTest,
  markDiagnosticToolStartedForTest,
} from "./diagnostic-run-activity.test-support.js";
import { getDiagnosticSessionState } from "./diagnostic-session-state.js";
import {
  diagnosticLogger,
  logMessageQueued,
  logSessionStateChange,
  markDiagnosticSessionProgress,
} from "./diagnostic.js";
import { startEnabledDiagnosticHeartbeatForTest as startEnabledDiagnosticHeartbeat } from "./diagnostic.test-support.js";
import type { DiagnosticCaseFixture } from "./diagnostic.test.js";

export function registerDiagnosticQueuedRecoveryCases({
  countMatching,
  requireRecord,
  expectRecordFields,
  requireMatchingRecord,
  requireFirstMockCallArg,
  expectNoLoggerMessageContaining,
  expectRecoveryCall,
}: Pick<
  DiagnosticCaseFixture,
  | "countMatching"
  | "requireRecord"
  | "expectRecordFields"
  | "requireMatchingRecord"
  | "requireFirstMockCallArg"
  | "expectNoLoggerMessageContaining"
  | "expectRecoveryCall"
>) {
  it("recovers idle queued embedded-run stalls after stale progress", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn().mockResolvedValue({
      status: "aborted",
      action: "abort_embedded_run",
      sessionId: "s1",
      sessionKey: "main",
      activeSessionId: "s1",
      activeWorkKind: "embedded_run",
      aborted: true,
      drained: true,
      forceCleared: false,
      released: 0,
    });
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "idle" });

      vi.advanceTimersByTime(59_000);
      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test-followup" });
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    } finally {
      unsubscribe();
    }

    expectRecoveryCall(
      recoverStuckSession,
      {
        sessionId: "s1",
        sessionKey: "main",
        queueDepth: 1,
        allowActiveAbort: true,
        expectedState: "idle",
      },
      ["ageMs", "stateGeneration"],
    );
    requireMatchingRecord(
      events,
      {
        type: "session.recovery.completed",
        state: "idle",
        status: "aborted",
        action: "abort_embedded_run",
      },
      "idle abort recovery event",
    );
    // Recovery is observational; only the source/queue owner publishes queue changes.
    expect(getDiagnosticSessionState({ sessionId: "s1", sessionKey: "main" }).queueDepth).toBe(1);
  });

  it("recovers idle queued work when embedded ownership is surfaced as a model call", async () => {
    const recoverStuckSession = vi.fn().mockResolvedValue({
      status: "aborted",
      action: "abort_embedded_run",
      sessionId: "s1",
      sessionKey: "main",
      activeSessionId: "s1",
      activeWorkKind: "embedded_run",
      aborted: true,
      drained: true,
      forceCleared: false,
      released: 0,
    });
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
    markDiagnosticModelStartedForTest({
      sessionId: "s1",
      sessionKey: "main",
      runId: "run-1",
      provider: "openai",
      model: "gpt-5",
    });
    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "idle" });

    vi.advanceTimersByTime(59_000);
    logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test-followup" });
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();

    expectRecoveryCall(
      recoverStuckSession,
      {
        sessionId: "s1",
        sessionKey: "main",
        queueDepth: 1,
        allowActiveAbort: true,
        expectedState: "idle",
      },
      ["ageMs", "stateGeneration"],
    );
  });

  it("recovers idle queued work blocked by stale model activity without active ownership", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn().mockResolvedValue({
      status: "released",
      action: "release_lane",
      sessionId: "s1",
      sessionKey: "main",
      released: 0,
    });
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticModelStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        provider: "openai",
        model: "gpt-5",
      });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "idle" });

      vi.advanceTimersByTime(59_000);
      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test-followup" });
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    } finally {
      unsubscribe();
    }

    expectRecordFields(
      requireRecord(
        events.findLast((event) => event.type === "session.stuck"),
        "idle stale model activity event",
      ),
      {
        type: "session.stuck",
        state: "idle",
        classification: "stale_session_state",
        reason: "queued_work_without_active_run",
        queueDepth: 1,
        lastProgressReason: "model_call:started",
      },
    );
    expectRecoveryCall(
      recoverStuckSession,
      {
        sessionId: "s1",
        sessionKey: "main",
        queueDepth: 1,
        expectedState: "idle",
      },
      ["ageMs", "stateGeneration"],
    );
    const recoveryParams = requireFirstMockCallArg(recoverStuckSession, "recoverStuckSession");
    expect(recoveryParams.allowActiveAbort).toBeUndefined();
  });

  it("recovers idle queued work blocked by stale orphaned tool_call activity", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn().mockResolvedValue({
      status: "released",
      action: "release_lane",
      sessionId: "s1",
      sessionKey: "main",
      released: 0,
    });
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticToolStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        toolName: "shell",
        toolCallId: "tc-1",
      });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "idle" });

      vi.advanceTimersByTime(59_000);
      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test-followup" });
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    } finally {
      unsubscribe();
    }

    expectRecordFields(
      requireRecord(
        events.findLast((event) => event.type === "session.stuck"),
        "idle stale tool activity event",
      ),
      {
        type: "session.stuck",
        state: "idle",
        classification: "stale_session_state",
        reason: "queued_work_without_active_run",
        queueDepth: 1,
      },
    );
    const recoveryParams = requireFirstMockCallArg(recoverStuckSession, "recoverStuckSession");
    expect(recoveryParams.expectedState).toBe("idle");
    expect(recoveryParams.allowActiveAbort).toBeUndefined();
  });

  it("recovers multiple stalled sessions independently without cross-session interference", async () => {
    const recoverStuckSession = vi.fn().mockImplementation((params: { sessionId: string }) =>
      Promise.resolve({
        status: "released",
        action: "release_lane",
        sessionId: params.sessionId,
        sessionKey: params.sessionId === "s1" ? "agent-a" : "agent-b",
        released: 0,
      }),
    );
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });

    // Set up two independent sessions that both stall with orphaned model activity.
    logSessionStateChange({ sessionId: "s1", sessionKey: "agent-a", state: "processing" });
    markDiagnosticModelStartedForTest({
      sessionId: "s1",
      sessionKey: "agent-a",
      runId: "run-a",
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    logSessionStateChange({ sessionId: "s1", sessionKey: "agent-a", state: "idle" });

    logSessionStateChange({ sessionId: "s2", sessionKey: "agent-b", state: "processing" });
    markDiagnosticModelStartedForTest({
      sessionId: "s2",
      sessionKey: "agent-b",
      runId: "run-b",
      provider: "openai",
      model: "gpt-5.5",
    });
    logSessionStateChange({ sessionId: "s2", sessionKey: "agent-b", state: "idle" });

    // Queue work on both sessions.
    vi.advanceTimersByTime(59_000);
    logMessageQueued({ sessionId: "s1", sessionKey: "agent-a", source: "user-a" });
    logMessageQueued({ sessionId: "s2", sessionKey: "agent-b", source: "user-b" });
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();

    // Both sessions should get independent recovery calls.
    expect(recoverStuckSession).toHaveBeenCalledTimes(2);
    const calls = recoverStuckSession.mock.calls.map((call) => call[0]);
    const s1Call = calls.find((c) => c.sessionId === "s1");
    const s2Call = calls.find((c) => c.sessionId === "s2");
    expect(s1Call).toBeDefined();
    expect(s2Call).toBeDefined();
    expect(s1Call!.sessionKey).toBe("agent-a");
    expect(s2Call!.sessionKey).toBe("agent-b");
    expect(s1Call!.expectedState).toBe("idle");
    expect(s2Call!.expectedState).toBe("idle");
    expect(s1Call!.allowActiveAbort).toBeUndefined();
    expect(s2Call!.allowActiveAbort).toBeUndefined();
  });

  it.each([
    {
      status: "aborted",
      action: "abort_embedded_run",
      aborted: true,
      drained: false,
      forceCleared: true,
    },
    { status: "released", action: "release_lane", reason: "stale_lane_task" },
  ] as const)(
    "preserves queued idle work when $status recovery releases active lane work",
    async (outcome) => {
      const events: DiagnosticEventPayload[] = [];
      const recoverStuckSession = vi.fn().mockResolvedValue({
        sessionId: "s1",
        sessionKey: "main",
        activeSessionId: "s1",
        activeWorkKind: "embedded_run",
        released: 1,
        queuedCount: 1,
        ...outcome,
      });
      const unsubscribe = onDiagnosticEvent((event) => events.push(event));
      try {
        startEnabledDiagnosticHeartbeat({ recoverStuckSession });
        logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
        markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
        logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "idle" });

        vi.advanceTimersByTime(59_000);
        logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test-followup" });
        vi.advanceTimersByTime(1_000);
        await Promise.resolve();
      } finally {
        unsubscribe();
      }

      expect(
        events.some(
          (event) =>
            event.type === "session.state" && event.reason === `stuck_recovery:${outcome.status}`,
        ),
      ).toBe(false);
      expect(getDiagnosticSessionState({ sessionId: "s1", sessionKey: "main" }).queueDepth).toBe(1);
    },
  );

  it("does not mark a newer processing generation idle after a late recovery outcome", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn().mockImplementation(async () => {
      markDiagnosticSessionProgress({ sessionId: "s1", sessionKey: "main" });
      return {
        status: "released",
        action: "release_lane",
        released: 1,
        sessionId: "s1",
        sessionKey: "main",
      };
    });
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });

      vi.advanceTimersByTime(61_000);
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      unsubscribe();
    }

    expect(getDiagnosticSessionState({ sessionId: "s1", sessionKey: "main" }).state).toBe(
      "processing",
    );
    requireMatchingRecord(
      events,
      { type: "session.recovery.completed", status: "released", stale: true },
      "stale recovery event",
    );
  });

  it("reports long-running sessions separately when active work is making progress", () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      vi.advanceTimersByTime(45_000);
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      vi.advanceTimersByTime(16_000);
    } finally {
      unsubscribe();
    }

    expect(events.some((event) => event.type === "session.stuck")).toBe(false);
    expect(events.some((event) => event.type === "session.stalled")).toBe(false);
    const longRunningEvents = events.filter((event) => event.type === "session.long_running");
    expect(longRunningEvents).toHaveLength(1);
    expectRecordFields(requireRecord(longRunningEvents[0], "long-running event"), {
      classification: "long_running",
      reason: "active_work",
      activeWorkKind: "embedded_run",
    });
    expectNoLoggerMessageContaining(warnSpy, "long-running session:");
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("throttles repeated long-running active-work warnings", () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      vi.advanceTimersByTime(45_000);
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      vi.advanceTimersByTime(16_000);

      expect(countMatching(events, (event) => event.type === "session.long_running")).toBe(1);

      vi.advanceTimersByTime(28_000);
      emitDiagnosticEvent({
        type: "run.progress",
        sessionId: "s1",
        sessionKey: "main",
        reason: "stream",
      });
      vi.advanceTimersByTime(2_000);

      expect(countMatching(events, (event) => event.type === "session.long_running")).toBe(1);
    } finally {
      unsubscribe();
    }

    const longRunningEvents = events.filter((event) => event.type === "session.long_running");
    expect(longRunningEvents).toHaveLength(1);
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("keeps queued sessions non-recoverable while active work is making progress", () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test" });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      vi.advanceTimersByTime(45_000);
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      vi.advanceTimersByTime(16_000);
    } finally {
      unsubscribe();
    }

    expect(events.some((event) => event.type === "session.stuck")).toBe(false);
    expect(events.some((event) => event.type === "session.stalled")).toBe(false);
    const longRunningEvents = events.filter((event) => event.type === "session.long_running");
    expect(longRunningEvents).toHaveLength(1);
    expectRecordFields(requireRecord(longRunningEvents[0], "long-running event"), {
      classification: "long_running",
      reason: "active_work",
      activeWorkKind: "embedded_run",
      queueDepth: 0,
    });
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("recovers queued sessions behind terminal embedded progress after the abort threshold", () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const stuckSessionWarnMs = 30_000;
    const stuckSessionAbortMs = 60_000;
    const terminalReason = "codex_app_server:notification:rawResponseItem/completed";
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test" });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticRunProgress({
        sessionId: "s1",
        sessionKey: "main",
        reason: terminalReason,
      });
      vi.advanceTimersByTime(stuckSessionAbortMs - stuckSessionWarnMs - 1);
      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test" });
      vi.advanceTimersByTime(stuckSessionWarnMs + 1);
    } finally {
      unsubscribe();
    }

    const attentionEvents = events.filter(
      (event) =>
        event.type === "session.long_running" ||
        event.type === "session.stalled" ||
        event.type === "session.stuck",
    );
    expectRecordFields(requireRecord(attentionEvents.at(-1), "final attention event"), {
      type: "session.stalled",
      classification: "stalled_agent_run",
      reason: "queued_behind_terminal_active_work",
      activeWorkKind: "embedded_run",
      queueDepth: 1,
      terminalProgressStale: true,
      lastProgressReason: terminalReason,
    });
    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 1, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });
}

import { expect, it, vi } from "vitest";
import { onDiagnosticEvent, type DiagnosticEventPayload } from "../infra/diagnostic-events.js";
import { emitCoreModelRequestStartedDiagnosticEvent } from "../infra/diagnostic-model-request.js";
import { emitCoreSemanticRunProgressDiagnosticEvent } from "../infra/diagnostic-semantic-run-progress.js";
import { DEFAULT_UNDICI_STREAM_TIMEOUT_MS } from "../infra/net/undici-global-dispatcher.js";
import {
  getDiagnosticSessionActivitySnapshot,
  createDiagnosticEmbeddedRunOwner,
  markDiagnosticEmbeddedRunEnded,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
} from "./diagnostic-run-activity.js";
import {
  markDiagnosticModelStartedForTest,
  markDiagnosticToolStartedForTest,
} from "./diagnostic-run-activity.test-support.js";
import { getDiagnosticSessionState } from "./diagnostic-session-state.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";
import { registerDiagnosticBackendDeadlineCase } from "./diagnostic.backend-deadline.test-cases.js";
import { logSessionStateChange } from "./diagnostic.js";
import {
  startDiagnosticHeartbeatForTest as startDiagnosticHeartbeat,
  startEnabledDiagnosticHeartbeatForTest as startEnabledDiagnosticHeartbeat,
} from "./diagnostic.test-support.js";
import type { DiagnosticCaseFixture } from "./diagnostic.test.js";
import { registerDiagnosticToolProgressCase } from "./diagnostic.tool-progress.test-cases.js";

export function registerDiagnosticModelRecoveryCases({
  advanceLaneWithInbound,
  requireRecord,
  expectRecordFields,
  requireFirstMockCallArg,
  expectRecoveryCall,
}: Pick<
  DiagnosticCaseFixture,
  | "advanceLaneWithInbound"
  | "requireRecord"
  | "expectRecordFields"
  | "requireFirstMockCallArg"
  | "expectRecoveryCall"
>) {
  it("recovers stale native tool calls through the active-run abort path", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const stuckSessionAbortMs = 60_000;
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

      vi.advanceTimersByTime(stuckSessionAbortMs);
      expect(recoverStuckSession).not.toHaveBeenCalled();

      vi.advanceTimersByTime(15 * 60_000 - stuckSessionAbortMs);
    } finally {
      unsubscribe();
    }

    expectRecordFields(
      requireRecord(
        events.findLast((event) => event.type === "session.stalled"),
        "stalled event",
      ),
      {
        classification: "blocked_tool_call",
        reason: "blocked_tool_call",
        activeWorkKind: "tool_call",
        activeToolName: "bash",
        activeToolCallId: "cmd-1",
      },
    );
    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 0, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });

  registerDiagnosticToolProgressCase();

  it("reports blocked tool calls on a lane whose inbound keeps refreshing the session clock", () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const unsubscribe = onDiagnosticEvent((event) => {
      events.push(event);
    });
    try {
      startDiagnosticHeartbeat({ diagnostics: { enabled: true } }, { recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticToolStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        toolName: "bash",
        toolCallId: "cmd-1",
      });

      advanceLaneWithInbound({
        sessionId: "s1",
        sessionKey: "main",
        totalMs: 20 * 60_000,
        inboundEveryMs: 25_000,
      });
    } finally {
      unsubscribe();
    }

    const stalled = requireRecord(
      events.findLast((event) => event.type === "session.stalled"),
      "stalled event",
    );
    expectRecordFields(stalled, {
      classification: "blocked_tool_call",
      reason: "blocked_tool_call",
      activeWorkKind: "tool_call",
      activeToolName: "bash",
    });
    // Both the report and the recovery request carry the progress clock, not the
    // 25s-old session touch: the ownerless-lane release window measures staleness.
    expect(stalled.ageMs).toBeGreaterThanOrEqual(15 * 60_000);
    const recovery = requireFirstMockCallArg(recoverStuckSession, "recoverStuckSession");
    expect(recovery.ageMs).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it("keeps a lane with fresh owned progress quiet while inbound keeps arriving", () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const unsubscribe = onDiagnosticEvent((event) => {
      events.push(event);
    });
    try {
      startDiagnosticHeartbeat({ diagnostics: { enabled: true } }, { recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticToolStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        toolName: "bash",
        toolCallId: "cmd-1",
      });

      advanceLaneWithInbound({
        sessionId: "s1",
        sessionKey: "main",
        totalMs: 20 * 60_000,
        inboundEveryMs: 25_000,
        onInbound: () => {
          markDiagnosticRunProgress({
            sessionId: "s1",
            sessionKey: "main",
            runId: "run-1",
            reason: "cli_live:stream_progress",
          });
        },
      });
    } finally {
      unsubscribe();
    }

    expect(events.some((event) => event.type === "session.stalled")).toBe(false);
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("leaves a busy lane with no owned work on the session clock", () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const unsubscribe = onDiagnosticEvent((event) => {
      events.push(event);
    });
    try {
      startDiagnosticHeartbeat({ diagnostics: { enabled: true } }, { recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticToolStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        toolName: "bash",
        toolCallId: "cmd-1",
      });
      // Terminal-but-unreleased state: the owner is gone, the activity row is not.
      // Recording that fact belongs to the run lifecycle, not to this gate.
      markDiagnosticEmbeddedRunEnded({ sessionId: "s1", sessionKey: "main" });
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionId: "s1", sessionKey: "main" })
          .activeWorkKind,
      ).toBeUndefined();

      advanceLaneWithInbound({
        sessionId: "s1",
        sessionKey: "main",
        totalMs: 20 * 60_000,
        inboundEveryMs: 25_000,
      });
    } finally {
      unsubscribe();
    }

    expect(events.some((event) => event.type === "session.stalled")).toBe(false);
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("recovers stale model calls through the active embedded-run abort path", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const stuckSessionAbortMs = 60_000;
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
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

      vi.advanceTimersByTime(stuckSessionAbortMs - 30_000);
      expect(recoverStuckSession).not.toHaveBeenCalled();

      vi.advanceTimersByTime(30_000);
    } finally {
      unsubscribe();
    }

    expectRecordFields(
      requireRecord(
        events.findLast((event) => event.type === "session.stalled"),
        "stalled event",
      ),
      {
        classification: "stalled_agent_run",
        reason: "active_work_without_progress",
        activeWorkKind: "model_call",
        lastProgressReason: "model_call:started",
      },
    );
    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 0, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });

  it.each(["model_call", "tool_call"] as const)(
    "reports repeated requests during %s without granting recovery authority",
    async (activeWorkKind) => {
      const events: DiagnosticEventPayload[] = [];
      const recoverStuckSession = vi.fn(recoverStuckDiagnosticSession);
      const stuckSessionWarnMs = 30_000;
      const stuckSessionAbortMs = activeWorkKind === "tool_call" ? 900_000 : 90_000;
      const unsubscribe = onDiagnosticEvent((event) => events.push(event));
      try {
        startEnabledDiagnosticHeartbeat({
          recoverStuckSession,
          testTimings: { stuckSessionWarnMs, stuckSessionAbortMs },
        });
        logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
        markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main", runId: "run-1" });
        markDiagnosticModelStartedForTest({
          sessionId: "s1",
          sessionKey: "main",
          runId: "run-1",
          provider: "mock",
          model: "retrying-model",
          observationUnit: "request",
        });
        if (activeWorkKind === "tool_call") {
          // An open tool must not hide mature repeated-request evidence.
          markDiagnosticToolStartedForTest({
            sessionId: "s1",
            sessionKey: "main",
            runId: "run-1",
            toolName: "read",
            toolCallId: "read-during-retries",
          });
        }

        for (let attempt = 2; attempt <= 6; attempt += 1) {
          vi.advanceTimersByTime(stuckSessionAbortMs / 3);
          logSessionStateChange({
            sessionId: "s1",
            sessionKey: "main",
            state: "processing",
            reason: "run_started",
          });
          markDiagnosticModelStartedForTest({
            sessionId: "s1",
            sessionKey: "main",
            runId: "run-1",
            provider: "mock",
            model: "retrying-model",
            observationUnit: "request",
          });
        }
      } finally {
        unsubscribe();
      }

      const stalled = events.find(
        (event) =>
          event.type === "session.stalled" &&
          event.reason === "repeated_model_requests_without_progress",
      );
      expectRecordFields(requireRecord(stalled, "stalled event"), {
        classification: "stalled_agent_run",
        reason: "repeated_model_requests_without_progress",
        repeatedRequestNoProgressAgeMs: stuckSessionAbortMs,
        activeWorkKind,
        activeToolAgeMs: activeWorkKind === "tool_call" ? stuckSessionAbortMs : undefined,
      });
      expect(recoverStuckSession).toHaveBeenCalled();
      for (const { value } of recoverStuckSession.mock.results) {
        await expect(value).resolves.toMatchObject({
          status: "skipped",
          action: "observe_only",
          reason: "missing_session_ref",
        });
      }
      expectRecoveryCall(
        recoverStuckSession,
        { sessionId: "s1", sessionKey: "main", queueDepth: 0, allowActiveAbort: true },
        ["ageMs", "stateGeneration"],
      );
    },
  );

  it("does not recover repeated requests after semantic output resets the clock", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const stuckSessionAbortMs = 90_000;
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({
        recoverStuckSession,
        testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs },
      });
      const ref = { sessionId: "s1", sessionKey: "main", runId: "run-1" };
      logSessionStateChange({ ...ref, state: "processing" });
      markDiagnosticEmbeddedRunStarted(ref);
      markDiagnosticModelStartedForTest({
        ...ref,
        provider: "mock",
        model: "retrying-model",
        observationUnit: "request",
      });
      vi.advanceTimersByTime(30_000);
      markDiagnosticModelStartedForTest({
        ...ref,
        provider: "mock",
        model: "retrying-model",
        observationUnit: "request",
      });
      emitCoreSemanticRunProgressDiagnosticEvent({
        ...ref,
        reason: "assistant:progress",
      });
      await vi.advanceTimersByTimeAsync(0);

      for (let elapsedMs = 0; elapsedMs < stuckSessionAbortMs; elapsedMs += 30_000) {
        vi.advanceTimersByTime(30_000);
        markDiagnosticRunProgress({
          ...ref,
          reason: "model_call:stream_progress",
        });
      }
    } finally {
      unsubscribe();
    }

    expect(
      events.some(
        (event) =>
          event.type === "session.stalled" &&
          event.reason === "repeated_model_requests_without_progress",
      ),
    ).toBe(false);
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("reports silent model calls as long-running before the abort threshold", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const stuckSessionWarnMs = 30_000;
    const stuckSessionAbortMs = 90_000;
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({
        recoverStuckSession,
        testTimings: { stuckSessionWarnMs, stuckSessionAbortMs },
      });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticModelStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        provider: "openai",
        model: "gpt-5",
      });

      vi.advanceTimersByTime(60_000);
    } finally {
      unsubscribe();
    }

    expect(events.some((event) => event.type === "session.stalled")).toBe(false);
    expectRecordFields(
      requireRecord(
        events.findLast((event) => event.type === "session.long_running"),
        "long-running event",
      ),
      {
        classification: "long_running",
        reason: "active_model_call_without_progress",
        activeWorkKind: "model_call",
        lastProgressReason: "model_call:started",
      },
    );
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("does not actively abort model calls with recent stream progress", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const stuckSessionAbortMs = 60_000;
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticModelStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        provider: "lmstudio",
        model: "gemma-4-e4b-it",
      });

      vi.advanceTimersByTime(stuckSessionAbortMs - 15_000);
      markDiagnosticRunProgress({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        reason: "model_call:stream_progress",
      });
      vi.advanceTimersByTime(30_000);
    } finally {
      unsubscribe();
    }

    expect(events.findLast((event) => event.type === "session.recovery.requested")).toBeUndefined();
    expectRecordFields(
      getDiagnosticSessionActivitySnapshot({ sessionId: "s1", sessionKey: "main" }),
      {
        activeWorkKind: "model_call",
        hasActiveEmbeddedRun: true,
        lastProgressAgeMs: 30_000,
        lastProgressReason: "model_call:stream_progress",
      },
    );
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("actively aborts silent local model calls after the stuck timeout", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const stuckSessionAbortMs = 60_000;
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticModelStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        provider: "vllm",
        model: "qwen/qwen3.5-9b",
      });

      vi.advanceTimersByTime(stuckSessionAbortMs);
    } finally {
      unsubscribe();
    }

    expectRecordFields(
      requireRecord(
        events.findLast((event) => event.type === "session.stalled"),
        "stalled event",
      ),
      {
        classification: "stalled_agent_run",
        reason: "active_work_without_progress",
        activeWorkKind: "model_call",
        lastProgressReason: "model_call:started",
      },
    );
    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 0, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });

  it("preserves a fresh model request allowance after semantic progress", async () => {
    const recoverStuckSession = vi.fn(() => new Promise<never>(() => {}));
    const ref = { sessionId: "allowance-session", sessionKey: "agent:main:allowance" };
    const runId = "allowance-run";
    const requestTimeoutMs = 150_000;
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    startEnabledDiagnosticHeartbeat({
      recoverStuckSession,
      testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 60_000 },
    });
    logSessionStateChange({ ...ref, state: "processing" });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "call-1",
        provider: "mock",
        model: "slow-model",
      },
      owner.generation,
      requestTimeoutMs,
    );
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(120_000);
    emitCoreSemanticRunProgressDiagnosticEvent({ ...ref, runId, reason: "assistant:progress" });
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "call-2",
        provider: "mock",
        model: "slow-model",
      },
      owner.generation,
      requestTimeoutMs,
    );
    await vi.advanceTimersByTimeAsync(0);

    // Semantic progress gives the next request its full provider allowance.
    vi.advanceTimersByTime(30_000);
    expect(recoverStuckSession).not.toHaveBeenCalled();
    vi.advanceTimersByTime(120_000);

    expectRecoveryCall(recoverStuckSession, { ...ref, queueDepth: 0, allowActiveAbort: true }, [
      "ageMs",
      "stateGeneration",
    ]);
  });

  it("does not abort a silent local model call whose no-gap stream policy was propagated to diagnostic recovery (#125147)", async () => {
    // Regression for the subagent-spawn parity bug: a genuinely local model
    // (e.g. Ollama over loopback) resolves `resolveLlmIdleTimeoutMs` to `0`
    // (no stream-gap watchdog) because it can legitimately stay silent for
    // many minutes during prompt evaluation. `attempt-stream.ts` now carries
    // that resolved policy into the diagnostic model-call-started event as a
    // generous but finite request-timeout ceiling
    // (`LOCAL_MODEL_NO_GAP_DIAGNOSTIC_CEILING_MS`, see
    // attempt.model-diagnostic-events.ts). Diagnostic recovery must honor
    // that ceiling instead of falling back to the generic stuck-session
    // threshold and aborting a still-progressing local model call.
    const recoverStuckSession = vi.fn();
    const ref = { sessionId: "local-no-gap-session", sessionKey: "agent:jin:subagent:local" };
    const runId = "local-no-gap-run";
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    startDiagnosticHeartbeat(
      { diagnostics: { enabled: true } },
      {
        recoverStuckSession,
        testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 60_000 },
      },
    );
    logSessionStateChange({ ...ref, state: "processing" });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "call-1",
        provider: "ollama",
        model: "qwen3.5:9b-q8_0",
      },
      owner.generation,
      DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
    );
    await vi.advanceTimersByTimeAsync(0);

    // Well past the generic stuck-session abort threshold (60s) and past the
    // previously observed real-world stall (~6.5 minutes, #125147), but
    // comfortably short of the finite no-gap ceiling — the local no-gap
    // policy must keep this recovery-ineligible.
    vi.advanceTimersByTime(15 * 60_000);

    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("still recovers a local model call that stays silent past the finite no-gap diagnostic ceiling (regression for #125388 review)", async () => {
    // ClawSweeper's review of the original #125147 fix caught that mapping
    // the local no-gap policy straight to MAX_TIMER_TIMEOUT_MS (~24.8 days)
    // made a genuinely wedged local call unrecoverable by the normal
    // stuck-session path. This proves the other half of the invariant: once a
    // silent local call's age exceeds the finite ceiling, normal recovery
    // still fires.
    const recoverStuckSession = vi.fn();
    const ref = {
      sessionId: "local-no-gap-wedged-session",
      sessionKey: "agent:jin:subagent:local",
    };
    const runId = "local-no-gap-wedged-run";
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    startDiagnosticHeartbeat(
      { diagnostics: { enabled: true } },
      {
        recoverStuckSession,
        testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 60_000 },
      },
    );
    logSessionStateChange({ ...ref, state: "processing" });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "call-1",
        provider: "ollama",
        model: "qwen3.5:9b-q8_0",
      },
      owner.generation,
      DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
    );
    await vi.advanceTimersByTimeAsync(0);

    // Past both the generic stuck-session abort threshold and the finite
    // no-gap ceiling — a genuinely wedged local call must be recoverable.
    vi.advanceTimersByTime(DEFAULT_UNDICI_STREAM_TIMEOUT_MS + 60_000);

    expect(recoverStuckSession).toHaveBeenCalled();
  });

  it("recovers stale model calls without active embedded-run ownership", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const stuckSessionAbortMs = 60_000;
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

      vi.advanceTimersByTime(stuckSessionAbortMs);
    } finally {
      unsubscribe();
    }

    expectRecordFields(
      requireRecord(
        events.findLast((event) => event.type === "session.stalled"),
        "stalled event",
      ),
      {
        classification: "stalled_agent_run",
        reason: "active_work_without_progress",
        activeWorkKind: "model_call",
        lastProgressReason: "model_call:started",
      },
    );
    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 0, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });

  registerDiagnosticBackendDeadlineCase({ expectRecoveryCall });

  it("does not recover a recent native tool call just because the session is old", async () => {
    const recoverStuckSession = vi.fn();
    const stuckSessionAbortMs = 90_000;

    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    getDiagnosticSessionState({ sessionId: "s1", sessionKey: "main" }).lastActivity =
      Date.now() - 120_000;
    markDiagnosticToolStartedForTest({
      sessionId: "s1",
      sessionKey: "main",
      runId: "run-1",
      toolName: "bash",
      toolCallId: "cmd-1",
    });

    vi.advanceTimersByTime(60_000);
    expect(recoverStuckSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);
    expect(recoverStuckSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(15 * 60_000 - stuckSessionAbortMs);
    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 0, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });

  it("uses the built-in abort threshold for stalled active-work recovery", () => {
    const recoverStuckSession = vi.fn();

    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({
      sessionId: "s1",
      sessionKey: "main",
      sessionFile: "/tmp/openclaw-active-abort-session.jsonl",
      state: "processing",
    });
    markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });

    vi.advanceTimersByTime(61_000);

    expectRecoveryCall(
      recoverStuckSession,
      {
        sessionId: "s1",
        sessionKey: "main",
        sessionFile: "/tmp/openclaw-active-abort-session.jsonl",
        queueDepth: 0,
        allowActiveAbort: true,
      },
      ["ageMs", "stateGeneration"],
    );
  });
}

import { expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  onDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { withDiagnosticPhase } from "./diagnostic-phase.js";
import { markDiagnosticEmbeddedRunStarted } from "./diagnostic-run-activity.js";
import { diagnosticSessionStates } from "./diagnostic-session-state.js";
import { getDiagnosticStabilitySnapshot } from "./diagnostic-stability.js";
import { diagnosticLogger, logMessageQueued, logSessionStateChange } from "./diagnostic.js";
import {
  resetDiagnosticStateForTest,
  startEnabledDiagnosticHeartbeatForTest as startEnabledDiagnosticHeartbeat,
} from "./diagnostic.test-support.js";
import type { DiagnosticCaseFixture } from "./diagnostic.test.js";

export function registerDiagnosticLivenessCases({
  createEmitMemorySampleMock,
  countMatching,
  requireRecord,
  requireMatchingRecord,
  expectLoggerMessageContaining,
  expectNoLoggerMessageContaining,
  expectRecoveryCall,
}: Pick<
  DiagnosticCaseFixture,
  | "createEmitMemorySampleMock"
  | "countMatching"
  | "requireRecord"
  | "requireMatchingRecord"
  | "expectLoggerMessageContaining"
  | "expectNoLoggerMessageContaining"
  | "expectRecoveryCall"
>) {
  it("starts and stops the stability recorder with the heartbeat lifecycle", () => {
    startEnabledDiagnosticHeartbeat();
    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });

    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 10 }).events,
      { type: "session.state", outcome: "processing" },
      "session state stability event",
    );
    const [event] = getDiagnosticStabilitySnapshot({ limit: 10 }).events;
    expect(event).not.toHaveProperty("sessionId");
    expect(event).not.toHaveProperty("sessionKey");

    resetDiagnosticStateForTest();
    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });

    expect(getDiagnosticStabilitySnapshot({ limit: 10 }).events).toStrictEqual([]);
  });

  it("does not track session state when diagnostics are disabled", () => {
    const events: string[] = [];
    const unsubscribe = onDiagnosticEvent((event) => events.push(event.type));
    try {
      setDiagnosticsEnabledForProcess(false);
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    } finally {
      unsubscribe();
    }

    expect(events).toStrictEqual([]);
    expect(diagnosticSessionStates.size).toBe(0);
  });

  it("checks memory pressure every tick without recording idle samples", () => {
    const emitMemorySample = createEmitMemorySampleMock();

    startEnabledDiagnosticHeartbeat({ emitMemorySample, sampleLiveness: () => null });

    vi.advanceTimersByTime(30_000);
    expect(emitMemorySample).toHaveBeenLastCalledWith({ emitSample: false });

    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    vi.advanceTimersByTime(30_000);

    expect(emitMemorySample).toHaveBeenLastCalledWith({ emitSample: true });
  });

  it("records idle liveness samples without warning in the gateway log", () => {
    const emitMemorySample = createEmitMemorySampleMock();
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    const events: string[] = [];
    const unsubscribe = onDiagnosticEvent((event) => events.push(event.type));

    try {
      startEnabledDiagnosticHeartbeat({
        emitMemorySample,
        sampleLiveness: () => ({
          reasons: ["cpu"],
          intervalMs: 30_000,
          eventLoopDelayP99Ms: 12,
          eventLoopDelayMaxMs: 22,
          eventLoopUtilization: 0.99,
          cpuUserMs: 29_000,
          cpuSystemMs: 1_000,
          cpuTotalMs: 30_000,
          cpuCoreRatio: 1,
        }),
      });

      vi.advanceTimersByTime(30_000);
    } finally {
      unsubscribe();
    }

    expect(events).toContain("diagnostic.liveness.warning");
    expectNoLoggerMessageContaining(warnSpy, "liveness warning:");
    expect(emitMemorySample).toHaveBeenLastCalledWith({ emitSample: true });
    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 10 }).events,
      {
        type: "diagnostic.liveness.warning",
        level: "info",
        reason: "cpu",
        durationMs: 30_000,
        count: 1,
        eventLoopDelayP99Ms: 12,
        eventLoopDelayMaxMs: 22,
        eventLoopUtilization: 0.99,
        cpuCoreRatio: 1,
        active: 0,
        waiting: 0,
        queued: 0,
      },
      "idle liveness stability event",
    );
  });

  it("warns and records the full duration for persistent idle event-loop degradation", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    const events: DiagnosticEventPayload[] = [];
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));

    try {
      startEnabledDiagnosticHeartbeat({
        emitMemorySample: createEmitMemorySampleMock(),
        sampleLiveness: () => ({
          reasons: ["event_loop_delay"],
          intervalMs: 30_000,
          degradedSinceMs: 60_000,
          eventLoopDelayP99Ms: 1_200,
          eventLoopDelayMaxMs: 1_500,
        }),
      });

      vi.advanceTimersByTime(30_000);
    } finally {
      unsubscribe();
    }

    expectLoggerMessageContaining(warnSpy, "degradedFor=60s");
    expect(events.findLast((event) => event.type === "diagnostic.liveness.warning")).toMatchObject({
      degradedSinceMs: 60_000,
    });
    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 10 }).events,
      {
        type: "diagnostic.liveness.warning",
        level: "warning",
        durationMs: 60_000,
      },
      "persistent liveness stability event",
    );
  });

  it("suppresses liveness warnings during startupGraceMs while still sampling", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    const events: string[] = [];
    const recoverStuckSession = vi.fn();
    const sampleLiveness = vi.fn(() => ({
      reasons: ["event_loop_delay" as const],
      intervalMs: 30_000,
      eventLoopDelayP99Ms: 1_500,
      eventLoopDelayMaxMs: 2_000,
    }));
    const unsubscribe = onDiagnosticEvent((event) => events.push(event.type));

    try {
      vi.setSystemTime(0);
      startEnabledDiagnosticHeartbeat({
        emitMemorySample: createEmitMemorySampleMock(),
        recoverStuckSession,
        sampleLiveness,
        startupGraceMs: 60_000,
        testTimings: { stuckSessionWarnMs: 1_000, stuckSessionAbortMs: 1_000 },
      });

      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test" });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      vi.setSystemTime(1_001);
      vi.advanceTimersByTime(30_000);

      expect(sampleLiveness).toHaveBeenCalledTimes(1);
      expectNoLoggerMessageContaining(warnSpy, "liveness heartbeat delayed");
      expectNoLoggerMessageContaining(warnSpy, "liveness warning:");
      expect(events).not.toContain("diagnostic.liveness.warning");
      expect(recoverStuckSession).not.toHaveBeenCalled();

      vi.advanceTimersByTime(30_000);

      expect(sampleLiveness).toHaveBeenCalledTimes(2);
      expectLoggerMessageContaining(warnSpy, "liveness warning:");
      expect(events).toContain("diagnostic.liveness.warning");
      expectRecoveryCall(
        recoverStuckSession,
        { sessionId: "s1", sessionKey: "main", queueDepth: 0, allowActiveAbort: true },
        ["ageMs", "stateGeneration"],
      );
    } finally {
      unsubscribe();
    }
  });

  it("warns for liveness samples when diagnostic work is open", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    startEnabledDiagnosticHeartbeat({
      emitMemorySample: createEmitMemorySampleMock(),
      sampleLiveness: () => ({
        reasons: ["event_loop_delay"],
        intervalMs: 30_000,
        eventLoopDelayP99Ms: 1_500,
        eventLoopDelayMaxMs: 2_000,
      }),
    });

    logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test" });
    vi.advanceTimersByTime(30_000);

    expectLoggerMessageContaining(warnSpy, "liveness warning:");
    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 10 }).events,
      {
        type: "diagnostic.liveness.warning",
        level: "warning",
        active: 0,
        waiting: 0,
        queued: 1,
      },
      "queued liveness stability event",
    );
  });

  it("adds phase and work labels to liveness warnings", async () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    const events: DiagnosticEventPayload[] = [];
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    let finishPhase: (() => void) | undefined;
    const phase = withDiagnosticPhase(
      "startup.plugins.load",
      () =>
        new Promise<void>((resolve) => {
          finishPhase = resolve;
        }),
    );
    if (!finishPhase) {
      throw new Error("Expected diagnostic phase finish callback to be initialized");
    }
    const completePhase = finishPhase;

    try {
      startEnabledDiagnosticHeartbeat({
        emitMemorySample: createEmitMemorySampleMock(),
        sampleLiveness: () => ({
          reasons: ["event_loop_delay"],
          intervalMs: 30_000,
          eventLoopDelayP99Ms: 1_500,
          eventLoopDelayMaxMs: 2_000,
        }),
      });

      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "telegram" });
      vi.advanceTimersByTime(30_000);
    } finally {
      completePhase();
      await phase;
      unsubscribe();
    }

    expectLoggerMessageContaining(warnSpy, "phase=startup.plugins.load");
    expectLoggerMessageContaining(warnSpy, "work=[queued=main(");
    const warning = requireRecord(
      events.findLast((event) => event.type === "diagnostic.liveness.warning"),
      "liveness warning event",
    );
    expect(warning.phase).toBe("startup.plugins.load");
    const queuedWorkLabels = warning.queuedWorkLabels;
    expect(Array.isArray(queuedWorkLabels)).toBe(true);
    if (!Array.isArray(queuedWorkLabels)) {
      throw new Error("liveness warning queuedWorkLabels was not an array");
    }
    expect(
      queuedWorkLabels.some((label) => typeof label === "string" && label.includes("main(")),
    ).toBe(true);
  });

  it("attributes only phases completed during the measured liveness interval", async () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    const events: DiagnosticEventPayload[] = [];
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));

    await withDiagnosticPhase("stale.phase", () => undefined);
    vi.advanceTimersByTime(60_000);
    await withDiagnosticPhase("recent.phase", () => undefined);

    try {
      startEnabledDiagnosticHeartbeat({
        emitMemorySample: createEmitMemorySampleMock(),
        sampleLiveness: () => ({
          reasons: ["event_loop_delay"],
          intervalMs: 30_000,
          eventLoopDelayP99Ms: 1_500,
          eventLoopDelayMaxMs: 2_000,
        }),
      });

      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test" });
      vi.advanceTimersByTime(30_000);
    } finally {
      unsubscribe();
    }

    expectLoggerMessageContaining(warnSpy, "recentPhases=recent.phase:");
    expectNoLoggerMessageContaining(warnSpy, "stale.phase");
    const warning = requireRecord(
      events.findLast((event) => event.type === "diagnostic.liveness.warning"),
      "liveness warning event",
    );
    expect(warning.recentPhases).toEqual([
      expect.objectContaining({
        name: "recent.phase",
      }),
    ]);
  });

  it("keeps transient event-loop max spikes debug-only when only background work is active", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    startEnabledDiagnosticHeartbeat({
      emitMemorySample: createEmitMemorySampleMock(),
      sampleLiveness: () => ({
        reasons: ["event_loop_delay"],
        intervalMs: 30_000,
        eventLoopDelayP99Ms: 21,
        eventLoopDelayMaxMs: 1_500,
      }),
    });

    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    vi.advanceTimersByTime(30_000);

    expectNoLoggerMessageContaining(warnSpy, "liveness warning:");
    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 10 }).events,
      {
        type: "diagnostic.liveness.warning",
        level: "info",
        active: 1,
        waiting: 0,
        queued: 0,
      },
      "active liveness stability event",
    );
  });

  it("does not count the active processing message as queued liveness backlog", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    startEnabledDiagnosticHeartbeat({
      emitMemorySample: createEmitMemorySampleMock(),
      sampleLiveness: () => ({
        reasons: ["event_loop_delay"],
        intervalMs: 30_000,
        eventLoopDelayP99Ms: 53.6,
        eventLoopDelayMaxMs: 2_761.9,
        eventLoopUtilization: 0.785,
        cpuCoreRatio: 0.378,
      }),
    });

    logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "discord" });
    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    vi.advanceTimersByTime(30_000);

    expectNoLoggerMessageContaining(warnSpy, "liveness warning:");
    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 10 }).events,
      {
        type: "diagnostic.liveness.warning",
        level: "info",
        active: 1,
        waiting: 0,
        queued: 0,
      },
      "active processing liveness stability event",
    );
  });

  it("counts messages queued behind already active work as liveness backlog", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    startEnabledDiagnosticHeartbeat({
      emitMemorySample: createEmitMemorySampleMock(),
      sampleLiveness: () => ({
        reasons: ["event_loop_delay"],
        intervalMs: 30_000,
        eventLoopDelayP99Ms: 53.6,
        eventLoopDelayMaxMs: 2_761.9,
        eventLoopUtilization: 0.785,
        cpuCoreRatio: 0.378,
      }),
    });

    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "discord" });
    vi.advanceTimersByTime(30_000);

    expectLoggerMessageContaining(warnSpy, "liveness warning:");
    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 10 }).events,
      {
        type: "diagnostic.liveness.warning",
        level: "warning",
        active: 1,
        waiting: 0,
        queued: 1,
      },
      "queued backlog liveness stability event",
    );
  });

  it("does not let idle liveness samples suppress later active-work warnings", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    startEnabledDiagnosticHeartbeat({
      emitMemorySample: createEmitMemorySampleMock(),
      sampleLiveness: () => ({
        reasons: ["event_loop_delay"],
        intervalMs: 30_000,
        eventLoopDelayP99Ms: 1_500,
        eventLoopDelayMaxMs: 2_000,
      }),
    });

    vi.advanceTimersByTime(30_000);
    expect(warnSpy).not.toHaveBeenCalled();

    logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test" });
    vi.advanceTimersByTime(30_000);

    expectLoggerMessageContaining(warnSpy, "liveness warning:");
  });

  it("throttles repeated liveness warnings", () => {
    const events: string[] = [];
    const unsubscribe = onDiagnosticEvent((event) => events.push(event.type));

    try {
      startEnabledDiagnosticHeartbeat({
        emitMemorySample: createEmitMemorySampleMock(),
        sampleLiveness: () => ({
          reasons: ["event_loop_delay"],
          intervalMs: 30_000,
          degradedSinceMs: 60_000,
          eventLoopDelayP99Ms: 1_500,
          eventLoopDelayMaxMs: 2_000,
        }),
      });

      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(90_000);
      expect(countMatching(events, (event) => event === "diagnostic.liveness.warning")).toBe(1);

      vi.advanceTimersByTime(30_000);
    } finally {
      unsubscribe();
    }

    expect(countMatching(events, (event) => event === "diagnostic.liveness.warning")).toBe(2);
  });
}

import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunEnded,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
} from "./diagnostic-run-activity.js";
import {
  diagnosticSessionStates,
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "./diagnostic-session-state.js";
import {
  getDiagnosticStabilitySnapshot,
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "./diagnostic-stability.js";
import {
  diagnosticLogger,
  logMessageQueued,
  logSessionStateChange,
  markDiagnosticSessionProgress,
} from "./diagnostic.js";
import { registerDiagnosticLivenessCases } from "./diagnostic.liveness.test-cases.js";
import { registerDiagnosticModelRecoveryCases } from "./diagnostic.model-recovery.test-cases.js";
import { registerDiagnosticQueuedRecoveryCases } from "./diagnostic.queued-recovery.test-cases.js";
import {
  resetDiagnosticStateForTest,
  resolveStuckSessionAbortMs,
  resolveStuckSessionWarnMs,
  startDiagnosticHeartbeatForTest as startDiagnosticHeartbeat,
  startEnabledDiagnosticHeartbeatForTest as startEnabledDiagnosticHeartbeat,
} from "./diagnostic.test-support.js";

function createEmitMemorySampleMock() {
  return vi.fn(() => ({
    rssBytes: 100,
    heapTotalBytes: 80,
    heapUsedBytes: 40,
    externalBytes: 10,
    arrayBuffersBytes: 5,
  }));
}

function flushDiagnosticEvents() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean) {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

/** Drives a lane that keeps receiving inbound, the traffic that refreshes lastActivity. */
function advanceLaneWithInbound(params: {
  sessionId: string;
  sessionKey: string;
  totalMs: number;
  inboundEveryMs: number;
  onInbound?: () => void;
}) {
  const ticks = Math.floor(params.totalMs / params.inboundEveryMs);
  for (let i = 0; i < ticks; i += 1) {
    vi.advanceTimersByTime(params.inboundEveryMs);
    logMessageQueued({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      source: "dispatch",
    });
    params.onInbound?.();
  }
}

const requireRecord = createRequireRecord("object", "label-not-object");

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectNumberField(record: Record<string, unknown>, key: string) {
  expect(typeof record[key]).toBe("number");
}

function requireMatchingRecord(
  items: readonly unknown[],
  fields: Record<string, unknown>,
  label: string,
) {
  const found = items.find((item) => {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    const record = item as Record<string, unknown>;
    return Object.entries(fields).every(([key, value]) => Object.is(record[key], value));
  });
  if (!found) {
    throw new Error(`missing ${label}`);
  }
  return requireRecord(found, label);
}

function requireFirstMockCallArg(mock: unknown, label: string) {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls;
  const call = calls?.[0];
  if (!call) {
    throw new Error(`missing ${label} call`);
  }
  return requireRecord(call[0], `${label} argument`);
}

function loggerMessages(spy: unknown): string[] {
  const calls = (spy as { mock?: { calls?: unknown[][] } }).mock?.calls ?? [];
  return calls
    .map((call) => call[0])
    .filter((message): message is string => typeof message === "string");
}

function expectLoggerMessageContaining(spy: unknown, text: string): void {
  expect(loggerMessages(spy).join("\n")).toContain(text);
}

function expectNoLoggerMessageContaining(spy: unknown, text: string): void {
  expect(loggerMessages(spy).join("\n")).not.toContain(text);
}

function expectRecoveryCall(
  recoverStuckSession: unknown,
  fields: Record<string, unknown>,
  numberFields: readonly string[] = ["ageMs", "stateGeneration"],
) {
  const params = requireFirstMockCallArg(recoverStuckSession, "recoverStuckSession");
  expectRecordFields(params, fields);
  for (const field of numberFields) {
    expectNumberField(params, field);
  }
}

export type DiagnosticCaseFixture = {
  createEmitMemorySampleMock: typeof createEmitMemorySampleMock;
  flushDiagnosticEvents: typeof flushDiagnosticEvents;
  countMatching: typeof countMatching;
  advanceLaneWithInbound: typeof advanceLaneWithInbound;
  requireRecord: typeof requireRecord;
  expectRecordFields: typeof expectRecordFields;
  expectNumberField: typeof expectNumberField;
  requireMatchingRecord: typeof requireMatchingRecord;
  requireFirstMockCallArg: typeof requireFirstMockCallArg;
  loggerMessages: typeof loggerMessages;
  expectLoggerMessageContaining: typeof expectLoggerMessageContaining;
  expectNoLoggerMessageContaining: typeof expectNoLoggerMessageContaining;
  expectRecoveryCall: typeof expectRecoveryCall;
};

describe("diagnostic session state pruning", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDiagnosticSessionStateForTest();
  });

  afterEach(() => {
    resetDiagnosticSessionStateForTest();
    vi.useRealTimers();
  });

  it("evicts stale idle session states", () => {
    getDiagnosticSessionState({ sessionId: "stale-1" });
    expect(diagnosticSessionStates.size).toBe(1);

    vi.advanceTimersByTime(31 * 60 * 1000);
    getDiagnosticSessionState({ sessionId: "fresh-1" });

    expect(diagnosticSessionStates.size).toBe(1);
  });

  it("caps tracked session states even when the oldest key is empty", () => {
    const oldestKey = "";
    const now = Date.now();
    for (let i = 0; i < 2001; i += 1) {
      vi.setSystemTime(now + i);
      getDiagnosticSessionState({
        sessionKey: i === 0 ? oldestKey : `session-${i}`,
      }).queueDepth = 1;
    }

    expect(diagnosticSessionStates.size).toBe(2000);
    expect(diagnosticSessionStates.has(oldestKey)).toBe(false);
  });

  it("canonicalizes sessionId-only state when the sessionKey becomes known", () => {
    const sessionKey = "agent:main:demo-channel:channel:c1";
    const pending = getDiagnosticSessionState({ sessionId: "s1" });
    pending.queueDepth = 1;

    const keyed = getDiagnosticSessionState({ sessionId: "s1", sessionKey });

    expect(keyed).toBe(pending);
    expect(keyed.queueDepth).toBe(1);
    expect(diagnosticSessionStates.has("s1")).toBe(false);
    expect(diagnosticSessionStates.get(sessionKey)).toBe(keyed);
    expect(getDiagnosticSessionState({ sessionKey })).toBe(keyed);
    expect(getDiagnosticSessionState({ sessionId: "s1" })).toBe(keyed);
    expect(diagnosticSessionStates.size).toBe(1);
  });

  it("merges split sessionId and sessionKey state without leaving stale queued work", () => {
    const sessionKey = "agent:main:demo-channel:channel:c1";
    const keyed = getDiagnosticSessionState({ sessionKey });
    keyed.queueDepth = 1;
    keyed.lastActivity = 1;
    const bySessionId = getDiagnosticSessionState({ sessionId: "s1" });
    bySessionId.queueDepth = 1;
    bySessionId.state = "processing";
    bySessionId.lastActivity = 2;

    const merged = getDiagnosticSessionState({ sessionId: "s1", sessionKey });

    expect(merged).toBe(keyed);
    expect(merged.queueDepth).toBe(2);
    expect(merged.state).toBe("processing");
    expect(diagnosticSessionStates.has("s1")).toBe(false);
    expect(diagnosticSessionStates.size).toBe(1);

    logSessionStateChange({ sessionId: "s1", sessionKey, state: "idle", reason: "run_completed" });
    logSessionStateChange({ sessionKey, state: "idle", reason: "message_completed" });

    expect(getDiagnosticSessionState({ sessionKey }).queueDepth).toBe(0);
    expect(diagnosticSessionStates.size).toBe(1);
  });
});
describe("diagnostic session activity aliases", () => {
  beforeEach(() => {
    resetDiagnosticStateForTest();
  });

  afterEach(() => {
    resetDiagnosticStateForTest();
  });

  it("keeps embedded diagnostic work active until every owner ends", () => {
    markDiagnosticEmbeddedRunStarted({ sessionId: "s1" });
    markDiagnosticEmbeddedRunStarted({
      sessionId: "s1",
      sessionKey: "main",
      workKey: "reply:main",
    });

    expect(getDiagnosticSessionActivitySnapshot({ sessionKey: "main" }).activeWorkKind).toBe(
      "embedded_run",
    );
    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "s1" }).activeWorkKind).toBe(
      "embedded_run",
    );

    markDiagnosticEmbeddedRunEnded({
      sessionId: "s1",
      sessionKey: "main",
      workKey: "reply:main",
      clearRunActivity: false,
    });

    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "s1", sessionKey: "main" })).toEqual(
      expect.objectContaining({ activeWorkKind: "embedded_run" }),
    );

    markDiagnosticEmbeddedRunEnded({ sessionId: "s1", sessionKey: "main" });

    expect(
      getDiagnosticSessionActivitySnapshot({ sessionId: "s1", sessionKey: "main" }).activeWorkKind,
    ).toBeUndefined();
  });
});

describe("stuck session diagnostics threshold", () => {
  const session = { sessionId: "s1", sessionKey: "main" };
  let events: DiagnosticEventPayload[];

  beforeEach(() => {
    vi.useFakeTimers();
    resetDiagnosticStateForTest();
    resetDiagnosticEventsForTest();
    events = [];
    onDiagnosticEvent((event) => events.push(event));
    vi.spyOn(diagnosticLogger, "isEnabled").mockReturnValue(true);
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticStateForTest();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not count a single in-flight turn as queued work without an active run", () => {
    const recoverStuckSession = vi.fn();
    const sessionFile = "/tmp/openclaw-heartbeat-session.jsonl";
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logMessageQueued({ ...session, source: "test" });
    logSessionStateChange({ ...session, sessionFile, state: "processing" });
    vi.advanceTimersByTime(61_000);

    expect(events.some((event) => event.type === "session.long_running")).toBe(false);
    const stuckEvents = events.filter((event) => event.type === "session.stuck");
    expect(stuckEvents).toHaveLength(1);
    expectRecordFields(requireRecord(stuckEvents[0], "stuck event"), {
      classification: "stale_session_state",
      reason: "stale_session_state",
      queueDepth: 0,
    });
    expectRecoveryCall(recoverStuckSession, { ...session, sessionFile, queueDepth: 0 });
  });

  it("defers a material heartbeat stall even when elapsed time is below the abort threshold", () => {
    const recoverStuckSession = vi.fn();
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    vi.setSystemTime(0);
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({ ...session, state: "processing" });
    markDiagnosticEmbeddedRunStarted(session);

    vi.advanceTimersByTime(20_000);
    markDiagnosticSessionProgress(session);
    markDiagnosticRunProgress({
      ...session,
      reason: "embedded_run:progress",
    });
    vi.advanceTimersByTime(10_000);

    vi.setSystemTime(35_000);
    vi.advanceTimersByTime(30_000);

    expectLoggerMessageContaining(warnSpy, "liveness heartbeat delayed");
    expect(recoverStuckSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);

    expectRecoveryCall(recoverStuckSession, { ...session, queueDepth: 0, allowActiveAbort: true });
  });

  it("does not let ordinary heartbeat jitter consume the remaining abort budget", () => {
    const recoverStuckSession = vi.fn();
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    vi.setSystemTime(0);
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({ ...session, state: "processing" });
    markDiagnosticEmbeddedRunStarted(session);

    vi.advanceTimersByTime(15_500);
    markDiagnosticSessionProgress(session);
    markDiagnosticRunProgress({
      ...session,
      reason: "embedded_run:progress",
    });
    vi.advanceTimersByTime(14_500);

    vi.setSystemTime(30_999);
    vi.advanceTimersByTime(30_000);

    expectNoLoggerMessageContaining(warnSpy, "liveness heartbeat delayed");
    expect(recoverStuckSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);

    expectRecoveryCall(recoverStuckSession, { ...session, queueDepth: 0, allowActiveAbort: true });
  });

  it("backs off repeated stuck warnings while a session remains unchanged", () => {
    const stuckEvents = () => events.filter((event) => event.type === "session.stuck");
    const recoverStuckSession = vi.fn();
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({ ...session, state: "processing" });
    vi.advanceTimersByTime(91_000);
    expect(stuckEvents()).toHaveLength(1);
    expect(recoverStuckSession).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(31_000);

    expect(stuckEvents().map((event) => event.ageMs)).toEqual([60_000, 120_000]);
    expect(recoverStuckSession).toHaveBeenCalledTimes(3);
    expect(
      events
        .filter((event) => event.type === "session.recovery.requested")
        .map((event) => event.ageMs),
    ).toEqual([60_000, 90_000, 120_000]);
  });

  it("aborts and drains embedded runs after an extended no-progress stall", () => {
    const recoverStuckSession = vi.fn();
    const stuckSessionWarnMs = resolveStuckSessionWarnMs() / 4;
    const stuckSessionAbortMs = resolveStuckSessionAbortMs(stuckSessionWarnMs);
    expect(stuckSessionWarnMs).toBe(30_000);
    expect(stuckSessionAbortMs).toBe(300_000);
    startEnabledDiagnosticHeartbeat({
      recoverStuckSession,
      testTimings: { stuckSessionWarnMs, stuckSessionAbortMs },
    });
    logSessionStateChange({ ...session, state: "processing" });
    markDiagnosticEmbeddedRunStarted(session);

    vi.advanceTimersByTime(stuckSessionAbortMs - 30_000);
    expect(recoverStuckSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);

    const stalledEvents = events.filter((event) => event.type === "session.stalled");
    expect(stalledEvents.length).toBeGreaterThan(0);
    expectRecordFields(requireRecord(stalledEvents.at(-1), "stalled event"), {
      classification: "stalled_agent_run",
      reason: "active_work_without_progress",
      activeWorkKind: "embedded_run",
    });
    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 0, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });

  it("aborts stale embedded runs when queued work refreshes session activity", () => {
    const recoverStuckSession = vi.fn();

    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
    vi.advanceTimersByTime(507_000);
    logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test" });
    vi.advanceTimersByTime(122_000);

    startEnabledDiagnosticHeartbeat({ recoverStuckSession });

    vi.advanceTimersByTime(30_000);

    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 1, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });

  it("does not abort embedded runs with recent progress just because session activity is old", () => {
    const recoverStuckSession = vi.fn();

    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
    vi.advanceTimersByTime(120_000);
    markDiagnosticRunProgress({
      sessionId: "s1",
      sessionKey: "main",
      reason: "embedded_run:progress",
    });

    startEnabledDiagnosticHeartbeat({ recoverStuckSession });

    vi.advanceTimersByTime(30_000);

    expect(recoverStuckSession).not.toHaveBeenCalled();
    expectRecordFields(
      getDiagnosticSessionActivitySnapshot({ sessionId: "s1", sessionKey: "main" }),
      {
        activeWorkKind: "embedded_run",
        hasActiveEmbeddedRun: true,
        lastProgressAgeMs: 30_000,
        lastProgressReason: "embedded_run:progress",
      },
    );
  });

  registerDiagnosticModelRecoveryCases({
    advanceLaneWithInbound,
    requireRecord,
    expectRecordFields,
    requireFirstMockCallArg,
    expectRecoveryCall,
  });

  registerDiagnosticQueuedRecoveryCases({
    countMatching,
    requireRecord,
    expectRecordFields,
    requireMatchingRecord,
    requireFirstMockCallArg,
    expectNoLoggerMessageContaining,
    expectRecoveryCall,
  });

  registerDiagnosticLivenessCases({
    createEmitMemorySampleMock,
    countMatching,
    requireRecord,
    requireMatchingRecord,
    expectLoggerMessageContaining,
    expectNoLoggerMessageContaining,
    expectRecoveryCall,
  });

  it("does not start the heartbeat when diagnostics are disabled by config", () => {
    const emitMemorySample = createEmitMemorySampleMock();

    startDiagnosticHeartbeat(
      {
        diagnostics: {
          enabled: false,
        },
      },
      { emitMemorySample },
    );
    vi.advanceTimersByTime(30_000);

    expect(emitMemorySample).not.toHaveBeenCalled();
  });
});

describe("diagnostic stability snapshots", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticStabilityRecorderForTest();
  });

  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
  });

  it("records bounded outbound delivery diagnostics without session identifiers", async () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "message.delivery.error",
      channel: "matrix",
      deliveryKind: "text",
      durationMs: 12,
      errorCategory: "TypeError",
      sessionKey: "session-secret",
    });
    await flushDiagnosticEvents();

    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 10 }).events,
      {
        type: "message.delivery.error",
        channel: "matrix",
        deliveryKind: "text",
        durationMs: 12,
        outcome: "error",
        reason: "TypeError",
      },
      "bounded outbound delivery stability event",
    );
    const [event] = getDiagnosticStabilitySnapshot({ limit: 10 }).events;
    expect(event).not.toHaveProperty("sessionKey");
    expect(event).not.toHaveProperty("sessionId");
  });
});

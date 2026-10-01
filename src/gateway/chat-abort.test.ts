import { randomUUID } from "node:crypto";
// Chat abort tests protect in-flight run tracking, stop-command parsing, provider
// abort fanout, history snapshots, and cleanup of buffered streaming state.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import { testing as controllerTesting } from "../auto-reply/reply/reply-run-registry.test-support.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
} from "../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import {
  getRpcSourceProjectSessionActive,
  getRpcSourceSignal,
  getRpcSourceStartedAt,
  isRpcSourceActive,
  requestRpcSourceCancellation,
  setRpcSourceProjectSessionActive,
  type RpcSourceAdapter,
} from "../sessions/session-controller.rpc-sources.js";
import { markReplyOperationExecutionStarted } from "../sessions/session-controller.state.js";
import {
  abortChatRunById,
  abortChatRunsForProvider,
  registerChatAbortController,
  resolveAgentRunExpiresAtMs,
  resolveChatRunExpiresAtMs,
  type ChatAbortOps,
  type ChatAbortControllerEntry,
  resolveInFlightRunSnapshot,
  updateChatRunProvider,
} from "./chat-abort.js";
import type { ChatCanvasBlock } from "./chat-display-projection.canvas.js";
import { createChatRunState, type ChatRunPlanSnapshot } from "./server-chat-state.js";
import { boundInFlightRunSnapshotForChatHistory } from "./server-methods/chat-history-budget.js";

type CreatedChatAbortOps = ChatAbortOps & {
  broadcast: ReturnType<typeof vi.fn>;
  nodeSendToSession: ReturnType<typeof vi.fn>;
  removeChatRun: ReturnType<typeof vi.fn>;
};

const createdSources = new Set<ChatAbortControllerEntry>();
afterEach(async () => {
  for (const source of createdSources) {
    source.input.claim?.operation?.complete();
    if (source.input.claim) {
      releaseSessionControllerClaim(source.input.claim);
    }
  }
  await Promise.all(
    [...createdSources].map((source) => source.input.settlement.promise.catch(() => {})),
  );
  createdSources.clear();
  controllerTesting.resetReplyRunRegistry();
  vi.useRealTimers();
});

async function createActiveEntry(
  sessionKey: string,
  metadata: Partial<RpcSourceAdapter> = {},
): Promise<ChatAbortControllerEntry> {
  const adapter: RpcSourceAdapter = { sessionId: "sess-1", sessionKey, ...metadata };
  const target = captureSessionTarget({
    storeScope: "/synthetic/chat-abort/" + randomUUID(),
    sessionKey,
    incarnation: adapter.sessionId,
    agentId: adapter.agentId,
  });
  const input = reserveSessionControllerSource(sessionKey, {
    target,
    adapter,
    policy: { mode: "followup" },
  });
  await claimSessionControllerTask(input, (claim) => {
    const operation = createReplyOperation({
      sessionKey,
      sessionId: adapter.sessionId,
      agentId: adapter.agentId,
      resetTriggered: false,
      target,
      mailboxClaim: claim,
    });
    markReplyOperationExecutionStarted(operation);
    operation.setPhase("running");
  });
  const ref = { input, adapter };
  createdSources.add(ref);
  return ref;
}

function createOps(params: {
  runId: string;
  entry: ChatAbortControllerEntry;
  buffer?: string;
}): CreatedChatAbortOps {
  const { runId, entry, buffer } = params;
  const broadcast = vi.fn();
  const nodeSendToSession = vi.fn();
  const removeChatRun = vi.fn();
  const chatRunState = createChatRunState();
  chatRunState.updateBuffer(runId, { delta: buffer ?? "" });
  chatRunState.takeBufferDelta(runId, buffer ?? "");
  Object.assign(chatRunState.getOrCreate(runId), {
    deltaSentAt: Date.now(),
    assistantScope: { itemId: "assistant-1", prefix: "", boundaryNewlines: 0, separatorLength: 0 },
    agentText: {
      assistant: {
        lastSentAt: Date.now(),
        bufferedEvent: {
          payload: {
            runId,
            seq: 1,
            stream: "assistant",
            ts: Date.now(),
            data: { text: "buffer", delta: "buffer" },
          },
        },
      },
    },
  });

  return {
    rpcSources: new Map([[runId, entry]]),
    chatRunState,
    removeChatRun,
    agentRunSeq: new Map(),
    broadcast,
    nodeSendToSession,
  };
}

async function createAbortRunFixture(params: {
  runId?: string;
  sessionKey?: string;
  entry?: ChatAbortControllerEntry;
  buffer?: string;
  now?: Date;
}): Promise<{
  runId: string;
  sessionKey: string;
  entry: ChatAbortControllerEntry;
  ops: CreatedChatAbortOps;
}> {
  const runId = params.runId ?? "run-1";
  const sessionKey = params.sessionKey ?? "main";
  if (params.now) {
    vi.useFakeTimers();
    vi.setSystemTime(params.now);
  }
  const entry = params.entry ?? (await createActiveEntry(sessionKey));
  const ops = createOps({ runId, entry, buffer: params.buffer });
  return { runId, sessionKey, entry, ops };
}

function firstBroadcastPayload(ops: { broadcast: ReturnType<typeof vi.fn> }): unknown {
  const call = ops.broadcast.mock.calls[0];
  if (!call) {
    throw new Error("expected broadcast call");
  }
  return call[1];
}

function expectRunAborted(params: {
  result: ReturnType<typeof abortChatRunById>;
  entry: ChatAbortControllerEntry;
  ops: ChatAbortOps;
  runId: string;
}): void {
  expect(params.result).toEqual({ aborted: true });
  expect(params.entry.input.abortSignal.aborted).toBe(true);
  // Cancellation is not producer settlement; the exact claim still protects retries.
  expect(params.ops.rpcSources.get(params.runId)).toBe(params.entry);
  expect(isRpcSourceActive(params.entry)).toBe(false);
}

describe("registerChatAbortController", () => {
  it("bounds default and agent run expiry calculations to valid Date timestamps", async () => {
    expect(resolveChatRunExpiresAtMs({ now: Number.NaN, timeoutMs: 60_000 })).toBe(0);
    expect(resolveChatRunExpiresAtMs({ now: 8_640_000_000_000_000, timeoutMs: 60_000 })).toBe(0);
    expect(resolveAgentRunExpiresAtMs({ now: Number.NaN, timeoutMs: 60_000 })).toBe(0);
  });

  it("records hidden/internal visibility for agent registrations", async () => {
    const rpcSources = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      rpcSources,
      target: captureSessionTarget({
        storeScope: "/synthetic/chat-registration",
        sessionKey: "main",
        incarnation: "sess-1",
      }),
      runId: "run-internal-agent",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 60_000,
      controlUiVisible: false,
      kind: "agent",
    });

    expect(registration.entry?.adapter).toMatchObject({
      controlUiVisible: false,
      kind: "agent",
    });
    expect(rpcSources.get("run-internal-agent")?.adapter.controlUiVisible).toBe(false);
  });

  it("keeps preparing sources cancellable without starting an execution timeout", async () => {
    vi.useFakeTimers();
    const rpcSources = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      rpcSources,
      target: captureSessionTarget({
        storeScope: "/synthetic/preparing",
        sessionKey: "main",
        incarnation: "sess-1",
      }),
      runId: "preparing",
      sessionKey: "main",
      sessionId: "sess-1",
      timeoutMs: 1,
    });
    if (!registration.entry) {
      throw new Error("Expected reserved source");
    }
    expect(isRpcSourceActive(registration.entry)).toBe(false);
    expect(getRpcSourceStartedAt(registration.entry)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getRpcSourceSignal(registration.entry).aborted).toBe(false);
    expect(registration.markExecutionStarted()).toBe(false);
    registration.controller.abort();
    expect(getRpcSourceSignal(registration.entry).aborted).toBe(true);
    registration.cleanup();
  });

  it("retains completed registrations until terminal persistence succeeds", async () => {
    const rpcSources = new Map<string, ChatAbortControllerEntry>();
    const onRemoved = vi.fn();
    const registration = registerChatAbortController({
      rpcSources,
      target: captureSessionTarget({
        storeScope: "/synthetic/chat-registration",
        sessionKey: "main",
        incarnation: "sess-1",
      }),
      runId: "run-persisting",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 60_000,
      onRemoved,
    });
    let resolvePersistence: () => void = () => undefined;
    const persistence = new Promise<void>((resolve) => {
      resolvePersistence = resolve;
    });
    if (!registration.entry) {
      throw new Error("expected registered entry");
    }
    setRpcSourceProjectSessionActive(registration.entry, false);
    registration.entry.adapter.projectSessionTerminalPersistence = persistence;

    registration.cleanup();

    expect(rpcSources.has("run-persisting")).toBe(true);
    expect(onRemoved).not.toHaveBeenCalled();
    resolvePersistence();
    await persistence;
    await Promise.resolve();
    expect(rpcSources.has("run-persisting")).toBe(false);
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });

  it("retains registrations when terminal lifecycle was observed before caller cleanup", async () => {
    const rpcSources = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      rpcSources,
      target: captureSessionTarget({
        storeScope: "/synthetic/chat-registration",
        sessionKey: "main",
        incarnation: "sess-1",
      }),
      runId: "run-awaiting-terminal",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 60_000,
    });

    if (!registration.entry) {
      throw new Error("expected registered entry");
    }
    registration.entry.adapter.projectSessionTerminalPending = true;
    registration.cleanup();

    expect(rpcSources.has("run-awaiting-terminal")).toBe(true);
    expect(registration.entry?.adapter.registrationCleanupRequested).toBe(true);
  });

  it("cleans registrations when dispatch fails before lifecycle starts", async () => {
    const rpcSources = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      rpcSources,
      target: captureSessionTarget({
        storeScope: "/synthetic/chat-registration",
        sessionKey: "main",
        incarnation: "sess-1",
      }),
      runId: "run-before-dispatch",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 60_000,
    });

    registration.cleanup();

    expect(rpcSources.has("run-before-dispatch")).toBe(false);
  });
});

describe("abortChatRunById", () => {
  it("notifies the run-bound approval owner only after an active run abort wins", async () => {
    const { runId, sessionKey, ops } = await createAbortRunFixture({});
    const onRunAborted = vi.fn();
    ops.onRunAborted = onRunAborted;

    expect(abortChatRunById(ops, { runId: "other-run", sessionKey })).toEqual({
      aborted: false,
    });
    expect(onRunAborted).not.toHaveBeenCalled();

    expect(abortChatRunById(ops, { runId, sessionKey, stopReason: "user" })).toEqual({
      aborted: true,
    });
    expect(onRunAborted).toHaveBeenCalledOnce();
    expect(onRunAborted).toHaveBeenCalledWith(runId);
  });

  it("retains terminal persistence ownership observed during abort", async () => {
    const { runId, sessionKey, entry, ops } = await createAbortRunFixture({});
    let terminalEvents = 0;
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "lifecycle" && event.data.phase === "end") {
        terminalEvents += 1;
        entry.adapter.projectSessionTerminalPending = true;
        entry.adapter.projectSessionTerminalObservedAt = event.ts;
      }
    });

    try {
      const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "user" });

      expect(result).toEqual({ aborted: true });
      expect(entry.input.abortSignal.aborted).toBe(true);
      expect(getRpcSourceProjectSessionActive(entry)).toBe(false);
      expect(entry.adapter.registrationCleanupRequested).toBe(true);
      expect(entry.adapter.projectSessionTerminalPending).toBe(true);
      expect(entry.adapter.projectSessionTerminalObservedAt).toEqual(expect.any(Number));
      expect(ops.rpcSources.get(runId)).toBe(entry);
      entry.input.claim?.operation?.complete();
      expect(getRpcSourceProjectSessionActive(entry)).toBe(false);

      expect(abortChatRunById(ops, { runId, sessionKey, stopReason: "user" })).toEqual({
        aborted: false,
      });
      expect(terminalEvents).toBe(1);
      expect(ops.broadcast).toHaveBeenCalledOnce();
      expect(ops.removeChatRun).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it("preserves the owning session identity when synchronous abort cleanup clears run context", async () => {
    const { runId, sessionKey, entry, ops } = await createAbortRunFixture({
      runId: "run-pre-reset-abort",
    });
    registerAgentRunContext(runId, { sessionKey, sessionId: entry.adapter.sessionId });
    entry.input.abortSignal.addEventListener("abort", () => clearAgentRunContext(runId));
    const events: Array<{ sessionId?: string }> = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "lifecycle") {
        events.push({ sessionId: event.sessionId });
      }
    });

    try {
      expect(abortChatRunById(ops, { runId, sessionKey, stopReason: "rpc" })).toEqual({
        aborted: true,
      });
      expect(events).toEqual([{ sessionId: entry.adapter.sessionId }]);
    } finally {
      unsubscribe();
      clearAgentRunContext(runId);
    }
  });

  it("broadcasts aborted payload with partial message when buffered text exists", async () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const { runId, sessionKey, entry, ops } = await createAbortRunFixture({
      buffer: "  Partial reply  ",
      now,
    });
    ops.agentRunSeq.set(runId, 2);
    ops.agentRunSeq.set("client-run-1", 4);
    ops.removeChatRun.mockReturnValue({ sessionKey, clientRunId: "client-run-1" });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "user" });

    expectRunAborted({ result, entry, ops, runId });
    expect(ops.chatRunState.runs.get(runId)?.buffer).toBeUndefined();
    expect(ops.chatRunState.runs.get(runId)?.deltaSentAt).toBeUndefined();
    expect(ops.chatRunState.runs.get(runId)?.assistantScope).toBeUndefined();
    expect(ops.chatRunState.runs.get(runId)?.display).toBeUndefined();
    expect(ops.chatRunState.runs.get(runId)?.agentText).toBeUndefined();
    expect(ops.removeChatRun).toHaveBeenCalledWith(runId, runId, sessionKey);
    expect(ops.agentRunSeq.has(runId)).toBe(false);
    expect(ops.agentRunSeq.has("client-run-1")).toBe(false);

    expect(ops.broadcast).toHaveBeenCalledTimes(1);
    const payload = firstBroadcastPayload(ops) as ChatEvent;
    expect(payload).toEqual({
      runId,
      sessionKey,
      seq: 3,
      state: "aborted",
      stopReason: "user",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "  Partial reply  " }],
        timestamp: now.getTime(),
      },
    });
    expect(ops.nodeSendToSession).toHaveBeenCalledWith(sessionKey, "chat", payload);
  });

  it("omits aborted message when buffered text is empty", async () => {
    const { runId, sessionKey, ops } = await createAbortRunFixture({ buffer: "   " });

    const result = abortChatRunById(ops, { runId, sessionKey });

    expect(result).toEqual({ aborted: true });
    const payload = firstBroadcastPayload(ops) as Record<string, unknown>;
    expect(payload.message).toBeUndefined();
  });

  it("includes the active run's safe validation diagnostic", async () => {
    const runId = "run-validation-abort";
    const sessionKey = "main";
    const entry = await createActiveEntry(sessionKey, {
      toolErrorSummary: "edit tool validation failed: edits: must be an array",
    });
    const ops = createOps({ runId, entry });

    abortChatRunById(ops, { runId, sessionKey, stopReason: "user" });

    expect(firstBroadcastPayload(ops)).toMatchObject({
      runId,
      state: "aborted",
      errorMessage: "edit tool validation failed: edits: must be an array",
    });
  });

  it("preserves finalizing runs when the owning reply operation rejects aborts", async () => {
    const { runId, sessionKey, entry, ops } = await createAbortRunFixture({
      buffer: "completed reply",
      entry: await createActiveEntry("main", { isAbortable: () => false }),
    });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "user" });

    expect(result).toEqual({ aborted: false });
    expect(entry.input.abortSignal.aborted).toBe(false);
    expect(ops.rpcSources.get(runId)).toBe(entry);
    expect(ops.chatRunState.runs.get(runId)?.buffer).toBe("completed reply");
    expect(ops.chatRunState.runs.get(runId)?.abortMarker).toBeUndefined();
    expect(ops.removeChatRun).not.toHaveBeenCalled();
    expect(ops.broadcast).not.toHaveBeenCalled();
    expect(ops.nodeSendToSession).not.toHaveBeenCalled();
  });

  it("aborts hidden internal runs without broadcasting chat events", async () => {
    const sessionKey = "main";
    const { runId, entry, ops } = await createAbortRunFixture({
      runId: "run-hidden",
      sessionKey,
      entry: await createActiveEntry(sessionKey, { controlUiVisible: false }),
      buffer: "hidden partial",
    });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "timeout" });

    expectRunAborted({ result, entry, ops, runId });
    expect(ops.broadcast).not.toHaveBeenCalled();
    expect(ops.nodeSendToSession).not.toHaveBeenCalled();
  });

  for (const testCase of [
    {
      name: "fans out default-agent global aborts to scoped and legacy global subscribers",
      runId: "run-main-global",
      createEntry: () => createActiveEntry("global", { agentId: "main" }),
      abort: abortChatRunById,
    },
    {
      name: "resolves unscoped global aborts to the default agent subscribers",
      runId: "run-unscoped-global",
      createEntry: () => createActiveEntry("global"),
      abort: abortChatRunById,
    },
  ]) {
    it(testCase.name, async () => {
      const ops = createOps({ runId: testCase.runId, entry: await testCase.createEntry() });
      ops.getRuntimeConfig = () => ({ agents: { list: [{ id: "main", default: true }] } });

      const result = testCase.abort(ops, { runId: testCase.runId, sessionKey: "global" });

      expect(result).toEqual({ aborted: true });
      const payload = firstBroadcastPayload(ops) as ChatEvent;
      expect(payload.agentId).toBe("main");
      const delivery = { sessionKeys: ["agent:main:global", "global"] };
      expect(ops.broadcast).toHaveBeenCalledWith("chat", payload, delivery);
      expect(ops.nodeSendToSession).toHaveBeenCalledWith("agent:main:global", "chat", payload);
      expect(ops.nodeSendToSession).toHaveBeenCalledWith("global", "chat", payload);
    });
  }

  it("tags maintenance timeouts as timeout abort reasons", async () => {
    const { runId, sessionKey, entry, ops } = await createAbortRunFixture({ runId: "run-timeout" });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "timeout" });

    expect(result).toEqual({ aborted: true });
    expect(entry.adapter.abortStopReason).toBe("timeout");
    expect(entry.input.abortSignal.aborted).toBe(true);
    expect(entry.input.abortSignal.reason).toBeInstanceOf(Error);
    expect((entry.input.abortSignal.reason as Error).name).toBe("TimeoutError");
  });

  it("tags restart abort signals with a restart-specific reason", async () => {
    const { runId, sessionKey, entry, ops } = await createAbortRunFixture({ runId: "run-restart" });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "restart" });

    expect(result).toEqual({ aborted: true });
    expect(isAgentRunRestartAbortReason(entry.input.abortSignal.reason)).toBe(true);
  });

  it.each([
    ["streamed text", true, true],
    ["", true, true],
    ["NO_REPLY", true, false],
    ["stale text", false, false],
  ] as const)(
    "snapshots completed widgets before synchronous abort cleanup (%j, current=%j)",
    async (buffer, current, visible) => {
      let ownsBuffer = current;
      const now = new Date("2026-01-02T03:04:05.000Z");
      const { runId, sessionKey, entry, ops } = await createAbortRunFixture({
        buffer,
        now,
      });
      const widget: ChatCanvasBlock = {
        type: "canvas",
        preview: {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          url: "/__openclaw__/canvas/documents/finished/index.html",
          viewId: "finished",
          sandbox: "scripts",
        },
        rawText: null,
      };
      Object.assign(ops.chatRunState.getOrCreate(runId), {
        canvasBlocks: [widget],
        bufferIsCurrent: () => ownsBuffer,
      });

      entry.input.abortSignal.addEventListener("abort", () => {
        ownsBuffer = false;
        ops.chatRunState.clearRun(runId);
      });

      const result = abortChatRunById(ops, { runId, sessionKey });

      expect(result).toEqual({ aborted: true });
      const payload = firstBroadcastPayload(ops) as ChatEvent;
      expect(payload).toEqual({
        runId,
        sessionKey,
        seq: 1,
        state: "aborted",
        stopReason: undefined,
        message: visible
          ? {
              role: "assistant",
              content: [...(buffer ? [{ type: "text", text: buffer }] : []), widget],
              timestamp: now.getTime(),
            }
          : undefined,
      });
      expect(ops.nodeSendToSession).toHaveBeenCalledWith(sessionKey, "chat", payload);
      expect(ops.chatRunState.runs.get(runId)?.canvasBlocks).toBeUndefined();
    },
  );
});

describe("abortChatRunsForProvider", () => {
  it("uses updated provider metadata after model fallback", async () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = await createActiveEntry(sessionKey);
    entry.adapter.providerId = "openai";
    entry.adapter.authProviderId = "openai";
    const ops = createOps({ runId, entry });

    const updated = updateChatRunProvider(ops.rpcSources, {
      runId,
      providerId: "openrouter",
      authProviderId: "openrouter",
    });
    const result = abortChatRunsForProvider(ops, {
      cfg: { agents: { list: [{ id: "main" }, { id: "writer" }] } },
      providerId: "openrouter",
      stopReason: "auth-revoked",
    });

    expect(updated).toBe(true);
    expect(result.runIds).toEqual([runId]);
    expect(entry.input.abortSignal.aborted).toBe(true);
    expect(ops.broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId,
        state: "aborted",
        stopReason: "auth-revoked",
      }),
      { sessionKeys: [sessionKey] },
    );
  });

  it("derives missing entry agent ids from canonical session keys", async () => {
    const writerEntry = await createActiveEntry("agent:writer:main");
    writerEntry.adapter.providerId = "openrouter";
    const mainEntry = await createActiveEntry("agent:main:main");
    mainEntry.adapter.providerId = "openrouter";
    const ops = createOps({ runId: "run-writer", entry: writerEntry });
    ops.rpcSources.set("run-main", mainEntry);

    const result = abortChatRunsForProvider(ops, {
      cfg: { agents: { list: [{ id: "main" }, { id: "writer" }] } },
      providerId: "openrouter",
      agentId: "writer",
      stopReason: "auth-revoked",
    });

    expect(result.runIds).toEqual(["run-writer"]);
    expect(writerEntry.input.abortSignal.aborted).toBe(true);
    expect(mainEntry.input.abortSignal.aborted).toBe(false);
  });
});

describe("resolveInFlightRunSnapshot", () => {
  const inFlightEntry = async (
    sessionKey: string,
    opts?: {
      agentId?: string;
      aborted?: boolean;
      controlUiVisible?: boolean;
      projectSessionActive?: boolean;
      startedAtMs?: number;
      kind?: RpcSourceAdapter["kind"];
    },
  ): Promise<ChatAbortControllerEntry> => {
    if (opts?.startedAtMs !== undefined) {
      vi.useFakeTimers();
      vi.setSystemTime(opts.startedAtMs);
    }
    const entry = await createActiveEntry(sessionKey, {
      agentId: opts?.agentId,
      controlUiVisible: opts?.controlUiVisible,
      kind: opts?.kind,
    });
    if (opts?.projectSessionActive !== undefined) {
      setRpcSourceProjectSessionActive(entry, opts.projectSessionActive);
    }
    if (opts?.aborted) {
      requestRpcSourceCancellation(entry);
    }
    return entry;
  };

  // Most cases request with requestedKey === canonicalKey; default canonical to
  // the requested key unless a case exercises the requested/canonical split.
  const resolveSnap = (p: {
    rpcSources: Map<string, ChatAbortControllerEntry>;
    chatRunBuffers: Map<string, string>;
    chatRunPlanSnapshots?: Map<string, ChatRunPlanSnapshot>;
    sessionKey: string;
    canonicalSessionKey?: string;
    agentId?: string;
    defaultAgentId?: string;
  }) => {
    const chatRunState = createChatRunState();
    for (const [runId, buffer] of p.chatRunBuffers ?? []) {
      chatRunState.getOrCreate(runId).buffer = buffer;
    }
    for (const [runId, plan] of p.chatRunPlanSnapshots ?? []) {
      chatRunState.getOrCreate(runId).planSnapshot = plan;
    }
    return resolveInFlightRunSnapshot({
      rpcSources: p.rpcSources,
      chatRunState,
      requestedSessionKey: p.sessionKey,
      canonicalSessionKey: p.canonicalSessionKey ?? p.sessionKey,
      agentId: p.agentId,
      defaultAgentId: p.defaultAgentId,
    });
  };
  const snap = (p: Parameters<typeof resolveSnap>[0]) => {
    const result = resolveSnap(p);
    if (result) {
      Reflect.deleteProperty(result, "startedAt");
    }
    return result;
  };

  it("returns live assistant text with the authoritative run start timestamp", async () => {
    const result = resolveSnap({
      rpcSources: new Map([["run-1", await inFlightEntry("s", { startedAtMs: 1_234 })]]),
      chatRunBuffers: new Map([["run-1", "partial answer so far"]]),
      sessionKey: "s",
    });
    expect(result).toEqual({ runId: "run-1", text: "partial answer so far", startedAt: 1_234 });
  });

  it("returns the active run plan snapshot with buffered text", async () => {
    const plan = {
      explanation: "Current work",
      steps: [{ step: "Implement replay", status: "in_progress" as const }],
    };
    expect(
      snap({
        rpcSources: new Map([["run-1", await inFlightEntry("agent:main:s")]]),
        chatRunBuffers: new Map([["run-1", "partial"]]),
        chatRunPlanSnapshots: new Map([["run-1", plan]]),
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run-1", text: "partial", plan });
  });

  it("returns an explicit empty plan snapshot for dismissal", async () => {
    expect(
      snap({
        rpcSources: new Map([["run-1", await inFlightEntry("agent:main:s")]]),
        chatRunBuffers: new Map(),
        chatRunPlanSnapshots: new Map([["run-1", { steps: [] }]]),
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run-1", text: "", plan: { steps: [] } });
  });

  it("is a no-op when rpcSources is not a Map (unpopulated context)", async () => {
    expect(
      snap({
        rpcSources: undefined as never,
        chatRunBuffers: undefined as never,
        sessionKey: "agent:main:s",
      }),
    ).toBeUndefined();
  });

  it("matches a run stored under the canonical key when requested with a different key", async () => {
    // Abort entry holds the canonical store key; the client requests history with
    // a different (requested) key for the same logical session.
    const result = snap({
      rpcSources: new Map([["run-1", await inFlightEntry("agent:main:main")]]),
      chatRunBuffers: new Map([["run-1", "partial"]]),
      sessionKey: "main",
      canonicalSessionKey: "agent:main:main",
    });
    expect(result).toEqual({ runId: "run-1", text: "partial" });
  });

  it("ignores aborted, completed (not projected active), and other-session runs", async () => {
    const variants: ChatAbortControllerEntry[] = [
      await inFlightEntry("agent:main:s", { aborted: true }),
      await inFlightEntry("agent:main:s", { projectSessionActive: false }),
      await inFlightEntry("agent:main:s", { controlUiVisible: false }),
      await inFlightEntry("agent:main:other"),
    ];
    for (const entry of variants) {
      expect(
        snap({
          rpcSources: new Map([["run", entry]]),
          chatRunBuffers: new Map([["run", "text"]]),
          sessionKey: "agent:main:s",
        }),
      ).toBeUndefined();
    }
  });

  it("ignores hidden agent runs that are not visible chat sends", async () => {
    expect(
      snap({
        rpcSources: new Map([
          ["run-agent", await inFlightEntry("agent:main:s", { kind: "agent" })],
        ]),
        chatRunBuffers: new Map([["run-agent", "hidden partial"]]),
        sessionKey: "agent:main:s",
      }),
    ).toBeUndefined();
  });

  it("treats an entry with undefined projectSessionActive as active (sessions.list contract)", async () => {
    const entry = await inFlightEntry("agent:main:s");
    setRpcSourceProjectSessionActive(entry, undefined);
    expect(
      snap({
        rpcSources: new Map([["run", entry]]),
        chatRunBuffers: new Map([["run", "live partial"]]),
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run", text: "live partial" });
  });

  it("returns an active run with empty text (Codex streams no incremental text mid-run)", async () => {
    expect(
      snap({
        rpcSources: new Map([["run", await inFlightEntry("agent:main:s")]]),
        chatRunBuffers: new Map(),
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run", text: "" });
  });

  it("does not surface suppressed control-token lead fragments from the live buffer", async () => {
    expect(
      snap({
        rpcSources: new Map([["run", await inFlightEntry("agent:main:s")]]),
        chatRunBuffers: new Map([["run", "NO_"]]),
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run", text: "" });
  });

  it("scopes the shared global session by agent so one agent's run is not restored into another", async () => {
    const controllers = new Map<string, ChatAbortControllerEntry>([
      ["run-a", await inFlightEntry("global", { agentId: "main" })],
      ["run-b", await inFlightEntry("global", { agentId: "work" })],
    ]);
    const buffers = new Map([
      ["run-a", "main agent global text"],
      ["run-b", "work agent global text"],
    ]);
    expect(
      snap({
        rpcSources: controllers,
        chatRunBuffers: buffers,
        sessionKey: "global",
        agentId: "work",
      }),
    ).toEqual({ runId: "run-b", text: "work agent global text" });
    expect(
      snap({
        rpcSources: controllers,
        chatRunBuffers: buffers,
        sessionKey: "global",
        agentId: "main",
      }),
    ).toEqual({ runId: "run-a", text: "main agent global text" });
  });

  it("resolves bare global history snapshots to the default agent", async () => {
    const controllers = new Map<string, ChatAbortControllerEntry>([
      ["run-main", await inFlightEntry("global", { agentId: "main", startedAtMs: 1_000 })],
      ["run-work", await inFlightEntry("global", { agentId: "work", startedAtMs: 2_000 })],
    ]);
    const buffers = new Map([
      ["run-main", "main default text"],
      ["run-work", "work global text"],
    ]);

    expect(
      snap({
        rpcSources: controllers,
        chatRunBuffers: buffers,
        sessionKey: "global",
        defaultAgentId: "main",
      }),
    ).toEqual({ runId: "run-main", text: "main default text" });
  });

  it("prefers the newest startedAtMs when several runs match the same session+agent", async () => {
    // A fast restart/retry/stale-controller race can leave two active entries for
    // the same key; selection must not depend on Map insertion order. Insert the
    // older run first so a first-match selector would return the wrong one.
    const controllers = new Map<string, ChatAbortControllerEntry>([
      ["run-old", await inFlightEntry("agent:main:s", { startedAtMs: 1_000 })],
      ["run-new", await inFlightEntry("agent:main:s", { startedAtMs: 2_000 })],
    ]);
    const buffers = new Map([
      ["run-old", "stale partial"],
      ["run-new", "current partial"],
    ]);
    expect(
      snap({
        rpcSources: controllers,
        chatRunBuffers: buffers,
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run-new", text: "current partial" });
  });

  it("breaks startedAtMs ties deterministically by runId regardless of insertion order", async () => {
    const buffers = new Map([
      ["run-a", "a"],
      ["run-b", "b"],
    ]);
    const ascending = new Map<string, ChatAbortControllerEntry>([
      ["run-a", await inFlightEntry("agent:main:s", { startedAtMs: 5_000 })],
      ["run-b", await inFlightEntry("agent:main:s", { startedAtMs: 5_000 })],
    ]);
    const descending = new Map<string, ChatAbortControllerEntry>([
      ["run-b", await inFlightEntry("agent:main:s", { startedAtMs: 5_000 })],
      ["run-a", await inFlightEntry("agent:main:s", { startedAtMs: 5_000 })],
    ]);
    // Same winner ("run-b" > "run-a") no matter which order the map was built in.
    expect(
      snap({
        rpcSources: ascending,
        chatRunBuffers: buffers,
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run-b", text: "b" });
    expect(
      snap({
        rpcSources: descending,
        chatRunBuffers: buffers,
        sessionKey: "agent:main:s",
      }),
    ).toEqual({ runId: "run-b", text: "b" });
  });

  it("keeps in-flight text and plan when they fit the chat history budget", async () => {
    const plan = {
      steps: [{ step: "Keep this", status: "pending" as const }],
    };
    expect(
      boundInFlightRunSnapshotForChatHistory({
        snapshot: { runId: "run-1", text: "partial", startedAt: 1_000, plan },
        messages: [],
        maxBytes: 1_000,
      }),
    ).toEqual({ runId: "run-1", text: "partial", startedAt: 1_000, plan });
  });

  it("drops oversized in-flight text but keeps the run id for adoption", async () => {
    const plan = {
      steps: [{ step: "Keep this", status: "pending" as const }],
    };
    expect(
      boundInFlightRunSnapshotForChatHistory({
        snapshot: { runId: "run-1", text: "x".repeat(1_000), startedAt: 1_000, plan },
        messages: [],
        maxBytes: 200,
      }),
    ).toEqual({ runId: "run-1", text: "", startedAt: 1_000, plan });
  });

  it("drops startedAt when the former minimal fallback exactly fills the budget", async () => {
    const messages = [{ role: "user", content: "near budget" }];
    const minimal = { runId: "run-1", text: "" };
    const maxBytes = jsonUtf8Bytes(messages) + jsonUtf8Bytes(minimal);
    const result = boundInFlightRunSnapshotForChatHistory({
      snapshot: { runId: "run-1", text: "x", startedAt: 1_000 },
      messages,
      maxBytes,
    });
    expect(result).toEqual(minimal);
    expect(jsonUtf8Bytes(messages) + jsonUtf8Bytes(result)).toBeLessThanOrEqual(maxBytes);
  });

  it("drops an oversized plan after dropping text", async () => {
    expect(
      boundInFlightRunSnapshotForChatHistory({
        snapshot: {
          runId: "run-1",
          text: "",
          plan: {
            steps: [{ step: "x".repeat(500), status: "pending" }],
          },
        },
        messages: [{ role: "user", content: "near budget" }],
        maxBytes: 160,
      }),
    ).toEqual({ runId: "run-1", text: "", plan: { steps: [] } });
  });

  it("keeps small buffered text and clears an oversized plan explicitly", async () => {
    // Absence means legacy-gateway unknown to clients; a budget drop must send
    // an explicit empty plan so retained stale checklists cannot survive.
    expect(
      boundInFlightRunSnapshotForChatHistory({
        snapshot: {
          runId: "run-1",
          text: "short answer",
          plan: {
            steps: [{ step: "x".repeat(500), status: "pending" }],
          },
        },
        messages: [],
        maxBytes: 200,
      }),
    ).toEqual({ runId: "run-1", text: "short answer", plan: { steps: [] } });
  });

  it("prioritizes active progress and explicitly clears budget-dropped projections", async () => {
    const event = {
      runId: "run-1",
      seq: 2,
      stream: "tool" as const,
      ts: 1_000,
      data: { phase: "start", name: "read", toolCallId: "tool-1", args: {} },
    };
    const expected = {
      runId: "run-1",
      text: "",
      events: [event],
      plan: { steps: [] },
    };
    expect(
      boundInFlightRunSnapshotForChatHistory({
        snapshot: {
          runId: "run-1",
          text: "x".repeat(1_000),
          events: [event],
          plan: { steps: [{ step: "y".repeat(1_000), status: "in_progress" }] },
        },
        messages: [],
        maxBytes: jsonUtf8Bytes([]) + jsonUtf8Bytes(expected),
      }),
    ).toEqual(expected);

    expect(
      boundInFlightRunSnapshotForChatHistory({
        snapshot: { runId: "run-1", text: "", events: [event] },
        messages: [],
        maxBytes: jsonUtf8Bytes([]) + jsonUtf8Bytes({ runId: "run-1", text: "", events: [] }),
      }),
    ).toEqual({ runId: "run-1", text: "", events: [] });
  });
});

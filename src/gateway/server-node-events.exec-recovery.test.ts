import "./server-node-events.test-support.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { HealthSummary } from "./health/types.js";
import type { NodeEvent, NodeEventContext } from "./server-node-events-types.js";
import { handleNodeEvent } from "./server-node-events.js";

const { buildSessionLookup, runtimeMocks } = await import("./server-node-events.test-support.js");
const enqueueSystemEventMock = runtimeMocks.enqueueSystemEvent;
const requestHeartbeatMock = runtimeMocks.requestHeartbeat;
const loadSessionEntryMock = runtimeMocks.loadSessionEntry;

function nodeEvent(event: string, payload: unknown): NodeEvent {
  return { event, payloadJSON: JSON.stringify(payload) };
}

function buildCtx(
  authorizeNodeSystemRunEvent: NodeEventContext["authorizeNodeSystemRunEvent"],
): NodeEventContext {
  return {
    deps: {} as CliDeps,
    broadcast: () => {},
    nodeSendToSession: () => {},
    nodeSubscribe: () => {},
    nodeUnsubscribe: () => {},
    broadcastVoiceWakeChanged: () => {},
    addChatRun: () => {},
    removeChatRun: () => undefined,
    chatAbortControllers: new Map(),
    dedupe: new Map(),
    agentRunSeq: new Map(),
    getHealthCache: () => null,
    refreshHealthSnapshot: async () => ({}) as HealthSummary,
    loadGatewayModelCatalog: async () => [],
    authorizeNodeSystemRunEvent,
    logGateway: { warn: () => {} },
  };
}

const execEventHeartbeatOptions = (sessionKey: string) => ({
  source: "exec-event",
  intent: "event",
  reason: "exec-event",
  coalesceMs: 0,
  sessionKey,
});

describe("result-first node exec completion", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockReset().mockReturnValue(true);
    requestHeartbeatMock.mockClear();
    loadSessionEntryMock
      .mockReset()
      .mockImplementation((sessionKey: string) => buildSessionLookup(sessionKey));
  });

  it("recovers in the originating topic when the invoke reply is missing", async () => {
    const sessionKey = "agent:main:telegram:group:-100155462274:topic:42";
    const runId = "run-result-first-recovery";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo: "-100155462274",
        lastThreadId: 42,
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId,
        exitCode: 0,
        output: "recovered output",
        suppressNotifyOnExit: true,
        invokeResultSentFirst: true,
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).toHaveBeenCalledExactlyOnceWith(
      `Exec finished (node=node-1 id=${runId}, code 0)\nrecovered output`,
      {
        sessionKey,
        contextKey: `exec:${runId}`,
        deliveryContext: { channel: "telegram", to: "-100155462274", threadId: 42 },
      },
    );
    expect(requestHeartbeatMock).toHaveBeenCalledExactlyOnceWith(
      execEventHeartbeatOptions(sessionKey),
    );
  });

  it("preserves the per-agent notification opt-out when the invoke reply is missing", async () => {
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey: "agent:main:telegram:group:-100155462274:topic:42",
        runId: "run-result-first-opt-out",
        exitCode: 0,
        output: "do not notify",
        notifyOnExit: false,
        invokeResultSentFirst: true,
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("suppresses recovery when the originating delivery context is unavailable", async () => {
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey: "agent:main:telegram:group:-100155462274:topic:42",
        runId: "run-result-first-no-route",
        exitCode: 0,
        output: "do not reroute",
        suppressNotifyOnExit: true,
        invokeResultSentFirst: true,
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("preserves an ordinary route-less Telegram completion", async () => {
    const sessionKey = "agent:main:telegram:direct:123456789";
    const runId = "run-ordinary-route-less";
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId,
        exitCode: 0,
        output: "ordinary output",
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).toHaveBeenCalledExactlyOnceWith(
      `Exec finished (node=node-1 id=${runId}, code 0)\nordinary output`,
      {
        sessionKey,
        contextKey: `exec:${runId}`,
      },
    );
    expect(requestHeartbeatMock).toHaveBeenCalledExactlyOnceWith(
      execEventHeartbeatOptions(sessionKey),
    );
  });

  it.each([
    ["result-first recovery", true],
    ["ordinary completion", undefined],
  ])("suppresses %s when the saved route points outside the topic", async (_label, suppress) => {
    const sessionKey = "agent:main:telegram:group:-100155462274:topic:42";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo: "123456789",
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId: "run-result-first-wrong-route",
        exitCode: 0,
        output: "do not reroute",
        ...(suppress === undefined ? {} : { suppressNotifyOnExit: suppress }),
        invokeResultSentFirst: true,
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("suppresses a threaded direct completion when the saved chat differs", async () => {
    const sessionKey = "agent:main:telegram:direct:123456789:thread:42";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo: "987654321",
        lastThreadId: 42,
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId: "run-threaded-direct-wrong-chat",
        exitCode: 0,
        output: "do not reroute",
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("accepts a matching direct route whose thread is encoded in the target", async () => {
    const sessionKey = "agent:main:telegram:direct:123456789:thread:42";
    const runId = "run-threaded-direct-matching-target";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo: "123456789:thread:42",
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId,
        exitCode: 0,
        output: "matching direct thread",
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).toHaveBeenCalledExactlyOnceWith(
      `Exec finished (node=node-1 id=${runId}, code 0)\nmatching direct thread`,
      {
        sessionKey,
        contextKey: `exec:${runId}`,
        deliveryContext: { channel: "telegram", to: "123456789:thread:42" },
      },
    );
    expect(requestHeartbeatMock).toHaveBeenCalledExactlyOnceWith(
      execEventHeartbeatOptions(sessionKey),
    );
  });

  it.each([
    ["matching", "-100155462274:direct-topic:42", undefined, true],
    ["case-insensitive matching", "-100155462274:DIRECT-TOPIC:42", undefined, true],
    ["cross-chat", "-100999999999:direct-topic:42", undefined, false],
    ["forum-topic scope", "-100155462274:topic:42", undefined, false],
    ["ambiguous explicit thread", "-100155462274", 42, false],
  ])(
    "handles a %s Telegram Direct Messages topic route",
    async (_label, lastTo, lastThreadId, allowed) => {
      const sessionKey = "agent:main:telegram:group:-100155462274:direct-topic:42";
      const runId = `run-direct-topic-${_label}`;
      loadSessionEntryMock.mockReturnValue(
        buildSessionLookup(sessionKey, {
          lastChannel: "telegram",
          lastTo,
          lastThreadId,
        }),
      );
      await handleNodeEvent(
        buildCtx(() => ({ invokeResultReceived: false })),
        "node-1",
        nodeEvent("exec.finished", {
          sessionKey,
          runId,
          exitCode: 0,
          output: "direct topic output",
          suppressNotifyOnExit: true,
          invokeResultSentFirst: true,
        }),
        { connId: "conn-1" },
      );

      if (allowed) {
        expect(enqueueSystemEventMock).toHaveBeenCalledOnce();
        expect(requestHeartbeatMock).toHaveBeenCalledOnce();
      } else {
        expect(enqueueSystemEventMock).not.toHaveBeenCalled();
        expect(requestHeartbeatMock).not.toHaveBeenCalled();
      }
    },
  );

  it("accepts a forum topic route encoded with a thread suffix", async () => {
    const sessionKey = "agent:main:telegram:group:-100155462274:topic:42";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo: "-100155462274:thread:42",
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId: "run-forum-thread-suffix",
        exitCode: 0,
        output: "forum topic output",
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).toHaveBeenCalledOnce();
    expect(requestHeartbeatMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["matching", "123456789", true],
    ["cross-chat", "987654321", false],
    ["unexpected thread", "123456789:topic:42", false],
  ])("handles a %s unthreaded Telegram DM route", async (_label, lastTo, allowed) => {
    const sessionKey = "agent:main:telegram:direct:123456789";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo,
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId: `run-unthreaded-dm-${_label}`,
        exitCode: 0,
        output: "dm output",
      }),
      { connId: "conn-1" },
    );

    if (allowed) {
      expect(enqueueSystemEventMock).toHaveBeenCalledOnce();
      expect(requestHeartbeatMock).toHaveBeenCalledOnce();
    } else {
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
      expect(requestHeartbeatMock).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["ordinary completion", false, true],
    ["result-first recovery", true, false],
  ])("preserves %s behavior for a non-Telegram route", async (_label, recovery, allowed) => {
    const sessionKey = "agent:main:slack:channel:C123:thread:42";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "slack",
        lastTo: "C123",
        lastThreadId: "42",
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId: `run-slack-${_label}`,
        exitCode: 0,
        output: "slack output",
        ...(recovery ? { suppressNotifyOnExit: true, invokeResultSentFirst: true } : {}),
      }),
      { connId: "conn-1" },
    );

    if (allowed) {
      expect(enqueueSystemEventMock).toHaveBeenCalledOnce();
      expect(requestHeartbeatMock).toHaveBeenCalledOnce();
    } else {
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
      expect(requestHeartbeatMock).not.toHaveBeenCalled();
    }
  });

  it("suppresses a topic completion when saved route topic fields conflict", async () => {
    const sessionKey = "agent:main:telegram:group:-100155462274:topic:42";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo: "-100155462274:topic:99",
        lastThreadId: 42,
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId: "run-conflicting-topic-fields",
        exitCode: 0,
        output: "do not reroute",
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("suppresses a completion after the invoke reply arrives", async () => {
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: true })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey: "agent:main:telegram:group:-100155462274:topic:42",
        runId: "run-result-first-delivered",
        exitCode: 0,
        output: "already delivered",
        suppressNotifyOnExit: true,
        invokeResultSentFirst: true,
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });
});

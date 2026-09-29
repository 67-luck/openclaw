import "./server-node-events.test-support.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { HealthSummary } from "./health/types.js";
import type { NodeEvent, NodeEventContext } from "./server-node-events-types.js";
import { handleNodeEvent } from "./server-node-events.js";

const { runtimeMocks } = await import("./server-node-events.test-support.js");
const enqueueSystemEventMock = runtimeMocks.enqueueSystemEvent;
const requestHeartbeatMock = runtimeMocks.requestHeartbeat;

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
  });

  it("recovers in the originating topic when the invoke reply is missing", async () => {
    const sessionKey = "agent:main:telegram:group:-100155462274:topic:42";
    const runId = "run-result-first-recovery";
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
      { sessionKey, contextKey: `exec:${runId}` },
    );
    expect(requestHeartbeatMock).toHaveBeenCalledExactlyOnceWith(
      execEventHeartbeatOptions(sessionKey),
    );
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

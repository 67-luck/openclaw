import { vi } from "vitest";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createChatRunState } from "../server-chat-state.js";
import { createTestRpcSource } from "./rpc-source.test-support.js";
import type { AgentTurnContext } from "./types.js";

function createContext(): AgentTurnContext {
  return {
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    rpcSources: new Map(),
    chatRunState: createChatRunState(),
    dedupe: new Map(),
    deps: {},
    getRuntimeConfig: () => ({}),
    trackExecution: async (work) => await work(),
    getSessionEventSubscriberConnIds: () => new Set(),
    loadGatewayModelCatalog: vi.fn(async () => []),
    loadGatewayModelCatalogSnapshot: vi.fn<AgentTurnContext["loadGatewayModelCatalogSnapshot"]>(),
    nodeSendToSession: vi.fn(),
    logGateway: {
      subsystem: "gateway-dispatch-test",
      isEnabled: () => false,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      raw: vi.fn(),
      child: vi.fn<AgentTurnContext["logGateway"]["child"]>(),
    },
  };
}

export function createTrackedDispatch() {
  const runId = "dispatch-run";
  const sessionKey = "agent:main:dispatch-owner";
  const context = createContext();
  const entry = createTestRpcSource(
    {
      sessionId: "dispatch-session",
      sessionKey,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      operationalRunInstance: { runId, instanceId: "original-instance" },
    },
    runId,
  );
  context.rpcSources.set(runId, entry);
  return { runId, sessionKey, context, entry };
}

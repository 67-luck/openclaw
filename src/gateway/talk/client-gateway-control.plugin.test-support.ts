import { vi } from "vitest";
import { createTalkClientGatewayControlOwner } from "./client-gateway-control.js";
import type { GatewayControlOwner } from "./client-gateway-control.types.js";

export type TalkGatewayControlOwnerTestFixture = {
  closeLogicalSession: () => Promise<void>;
  events: Array<{ type: string; payload: unknown }>;
  owner: GatewayControlOwner;
};

export function createTalkGatewayControlOwnerTestFixture(
  voiceSessionId: string,
): TalkGatewayControlOwnerTestFixture {
  const events: Array<{ type: string; payload: unknown }> = [];
  const closeLogicalSession = vi.fn(async () => undefined);
  const owner = createTalkClientGatewayControlOwner({
    voiceSessionId,
    sessionTarget: {
      agentId: "main",
      sessionKey: "agent:main:main",
      canonicalKey: "agent:main:main",
      storePath: "/tmp/sessions",
    },
    connId: `conn-${voiceSessionId}`,
    context: {
      logGateway: { warn: vi.fn() },
      chatAbortControllers: new Map(),
      broadcastToConnIds: vi.fn((_name: string, payload: { talkEvent?: unknown }) => {
        if (payload.talkEvent) {
          events.push(payload.talkEvent as { type: string; payload: unknown });
        }
      }),
    } as never,
    runToolAgentConsult: vi.fn(async () => ({ text: "done" })),
    runAgentConsult: vi.fn(async () => ({ text: "done" })),
    appendTranscript: vi.fn(async () => undefined),
    flushTranscript: vi.fn(async () => undefined),
    closeLogicalSession,
  });
  owner.activate();
  return { closeLogicalSession, events, owner };
}

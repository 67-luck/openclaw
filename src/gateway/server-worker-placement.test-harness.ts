import { vi } from "vitest";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";

export function createWorkerReclaimFixture(
  name: string,
  state: "active" | "failed" | "local" | "reclaimed" = "active",
) {
  const request = {
    sessionId: `session-${name}`,
    sessionKey: `agent:main:${name}`,
    agentId: "main",
  };
  const entry = { sessionId: request.sessionId, lifecycleRevision: "original", updatedAt: 1 };
  const target = {
    storePath: `/fixture/reclaim-preparation-${name}.sqlite`,
    canonicalKey: request.sessionKey,
    storeKeys: [request.sessionKey],
    agentId: request.agentId,
    store: { [request.sessionKey]: entry },
  };
  const placement = {
    ...request,
    state,
    generation: 4,
    environmentId: "worker",
    activeOwnerEpoch: 7,
  };
  const cancel = vi.fn(async (input: { assertCurrent: () => void }) => input.assertCurrent());
  const barriers = createGatewayWorkerPlacementReclaimBarriers({
    placements: { get: () => ({ ...placement }) as never, waitForTurnClaimRelease: async () => {} },
    loadSessionRuntime: async () => ({
      managedWorktrees: { findLiveByOwner: () => undefined },
      resolveGatewaySessionStoreTargetWithStore: () => target,
      resolveCanonicalSessionEntryFromStoreKeys: () => entry,
    }),
    cancelSessionWork: cancel,
    revokeSessionAuthority: vi.fn(),
  });
  const run = vi.fn(async () => ({ ...placement, state: "reclaimed" as const }) as never);
  const admit = (onInterrupt?: () => void) =>
    beginSessionWorkAdmission({
      scope: target.storePath,
      identities: [request.sessionKey, request.sessionId],
      assertAllowed: () => {},
      onInterrupt,
    });
  return {
    ...request,
    entry,
    placement,
    cancel,
    run,
    admit,
    prepare: (options: Partial<Parameters<typeof barriers.runReclaimPreparation>[0]> = {}) =>
      barriers.runReclaimPreparation({ ...request, run, ...options }),
  };
}
import type { SessionEntry } from "../config/sessions/types.js";
import { admitChatSend } from "./server-methods/chat-send-admission.js";
import { createChatAbortContext } from "./server-methods/chat.abort.test-helpers.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { pendingChatSendDedupeKey } from "./server-shared.js";

export function createWorkerStopChatContext() {
  return createChatAbortContext() as unknown as GatewayRequestContext;
}

export function admitWorkerStopChat(params: {
  context: GatewayRequestContext;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  agentId: string;
  entry: SessionEntry;
  runId: string;
}) {
  const { context, storePath, sessionKey, sessionId, agentId, entry, runId } = params;
  const respond = vi.fn();
  const now = Date.now();
  const promise = admitChatSend({
    request: {
      p: { sessionKey, message: "continue", idempotencyKey: runId },
      chatSendReceivedAtMs: now,
      supportsTaskSuggestions: false,
      inboundMessage: "continue",
      rawMessage: "continue",
      requestIdentity: "worker-stop-continue-without-mentions",
      suppressCommandInterpretation: false,
      stopCommand: false,
      turnKind: "main",
      normalizedAttachments: [],
      reconnectResumeRequested: false,
    },
    session: {
      rawSessionKey: sessionKey,
      sessionLoadKey: sessionKey,
      clientRunId: runId,
      pendingChatSendKey: pendingChatSendDedupeKey(runId),
      sessionLoadOptions: { agentId },
      sessionLoadMs: 0,
      cfg: {},
      storePath,
      entry,
      sessionKey,
      // Storage is mocked here; direct chat tests exercise physical source qualification.
      sessionTarget: {
        keyFormat: "agent-qualified",
        agentId,
        canonicalKey: sessionKey,
        requestedKey: sessionKey,
        storeKey: sessionKey,
        storeKeys: [sessionKey],
        storePath,
        entry,
      },
      assertSessionTargetCurrent: () => {},
      releaseSessionTarget: () => {},
      closeSessionTarget: async () => {},
      legacyKey: undefined,
      expectedLeafEntryId: undefined,
      sessionRoutingChanged: () => false,
      agentIdOverride: agentId,
      requestedAgentId: agentId,
      selectedAgent: { ok: true, agentId },
      requestedSessionId: undefined,
      backingSessionId: sessionId,
      agentId,
      resolvedSessionModel: { provider: "openai", model: "gpt-5.6-luna" },
      resolvedSessionAuthProvider: "openai",
      activeRunScopeKey: sessionKey,
      timeoutMs: 600000,
      now,
      restartSafeRequest: undefined,
    },
    context,
    client: null,
    respond,
  });
  return { promise, respond };
}

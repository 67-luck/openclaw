import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { resolveAgentIdFromSessionKey } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isSubagentCoordinationInputProvenance } from "../../sessions/input-provenance.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { AGENT_SESSION_RESET_COMMAND_RE } from "../agent-command-policy.js";
import { registerChatAbortController } from "../chat-abort.js";
import { authorizeGatewaySessionCreation } from "../operator-role-policy.js";
import { authorizeResolvedSessionMutation } from "../session-sharing.js";
import { loadSessionEntry } from "../session-utils.js";
import type { AgentRequestPreflight } from "./agent-request-preflight.js";
import type { AgentTurnIo, AgentTurnPrincipal } from "./types.js";

export function authorizeAgentTurnSession({
  cfg,
  principal,
  agentId,
  sessionKey,
}: {
  cfg: OpenClawConfig;
  principal: AgentTurnPrincipal | null;
  agentId: string;
  sessionKey: string;
}) {
  return (
    authorizeGatewaySessionCreation({ cfg, client: principal, agentId }) ??
    authorizeResolvedSessionMutation({ cfg, client: principal, sessionKey, agentId })
  );
}

/** Bind preparation custody to the authorized physical target before attachment work yields. */
export function registerAgentTurnSourceAdmission({
  sessionKey,
  agentId: targetAgentId,
  preflight,
  principal,
  io,
  sourceWork,
  lifecycleGeneration,
  ownerConnId,
  ownerDeviceId,
  assertRequestCurrent,
  assertAdmissionCurrent,
  isSourcePreparationComplete,
  onRegistered,
}: {
  sessionKey?: string;
  agentId?: string;
  preflight: AgentRequestPreflight;
  principal: AgentTurnPrincipal | null;
  io: AgentTurnIo;
  sourceWork: Promise<void>;
  lifecycleGeneration: string;
  ownerConnId?: string;
  ownerDeviceId?: string;
  assertRequestCurrent: () => void;
  assertAdmissionCurrent?: () => void;
  isSourcePreparationComplete: () => boolean;
  onRegistered: (registration: ReturnType<typeof registerChatAbortController>) => void;
}) {
  const { request, cfg, runId, suppressVisibleSessionEffects, inputProvenance } = preflight;
  // Reset mutation selects the successor incarnation before its turn is reserved.
  if (!sessionKey || AGENT_SESSION_RESET_COMMAND_RE.test(request.message ?? "")) {
    return undefined;
  }
  const loaded = loadSessionEntry(sessionKey, {
    agentId: targetAgentId,
    clone: false,
    projection: "list",
  });
  const sourceAgentId = resolveAgentIdFromSessionKey(loaded.canonicalKey, targetAgentId);
  const authorizationError = authorizeAgentTurnSession({
    cfg: loaded.cfg,
    principal,
    sessionKey: loaded.canonicalKey,
    agentId: sourceAgentId,
  });
  if (authorizationError) {
    io.emitAcceptance([false, undefined, authorizationError]);
    return false;
  }
  assertRequestCurrent();
  const earlyRunAbort = registerChatAbortController({
    sourceWork,
    runId,
    sessionKey: loaded.canonicalKey,
    sessionId: loaded.entry?.sessionId ?? "",
    target: captureSessionTarget({
      storeScope: loaded.storePath,
      sessionKey: loaded.canonicalKey,
      aliases: [sessionKey],
      agentId: sourceAgentId,
      incarnation: loaded.entry?.sessionId,
    }),
    authority: {
      assertCurrent: () => {
        if (!isSourcePreparationComplete()) {
          assertAdmissionCurrent?.();
        }
      },
    },
    agentId: sourceAgentId,
    timeoutMs: resolveAgentTimeoutMs({ cfg, overrideSeconds: request.timeout }),
    ownerConnId,
    ownerDeviceId,
    kind: "agent",
    lifecycleGeneration,
    controlUiVisible:
      !suppressVisibleSessionEffects && !isSubagentCoordinationInputProvenance(inputProvenance),
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  onRegistered(earlyRunAbort);
  if (earlyRunAbort.entry) {
    io.emitStartOwner?.(runId, earlyRunAbort.entry);
  }
  return undefined;
}

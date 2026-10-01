import {
  getActiveNativeAttempt,
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS,
} from "../../agents/embedded-agent-runner/run-state.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import {
  getAttachedBackend,
  isCurrentSessionControllerOperation,
} from "../../sessions/session-controller.state.js";
import type { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import { resolveClientVoiceRunBinding } from "../../talk/client-voice-session.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

export function resolveOwnedActiveTalkRunTarget(params: {
  context: Pick<GatewayRequestContext, "rpcSources">;
  clientConnId?: string;
  sessionTarget: PreparedTalkSessionTarget;
  /** The shipped talk.client.steer RPC is session-wide; attached transports select their call. */
  scope: { kind: "session" } | { kind: "voice-session"; voiceSessionId: string };
  assertCurrent?: () => void;
}):
  | (NonNullable<Parameters<typeof controlRealtimeVoiceAgentRun>[0]["runTarget"]> & {
      toolAuthoritySource?: "reply" | "attempt";
    })
  | null {
  const connId = params.clientConnId;
  if (!connId) {
    return null;
  }
  const { agentId, sessionKey, canonicalKey } = params.sessionTarget;
  for (const [runId, entry] of params.context.rpcSources) {
    const generation = entry.adapter.lifecycleGeneration;
    if (!generation) {
      continue;
    }
    const signal = entry.input.abortSignal;
    const claim = entry.input.claim;
    const operation = claim?.operation;
    if (!claim || claim.released || !operation || !isCurrentSessionControllerOperation(operation)) {
      continue;
    }
    const handle = getActiveNativeAttempt(entry.adapter.sessionId);
    const registration = handle ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) : undefined;
    const voiceBinding =
      params.scope.kind === "voice-session" ? resolveClientVoiceRunBinding(runId) : undefined;
    // Session RPCs can own a queued reply before its backend exists. Attached
    // voice controls instead preserve captured backend absence across their FIFO.
    const reply = params.scope.kind === "session" && !handle ? operation : undefined;
    const isCurrent = (resolvedSessionId?: string) => {
      params.assertCurrent?.();
      const replyOwner =
        reply &&
        entry.input.claim === claim &&
        claim.operation === reply &&
        isCurrentSessionControllerOperation(reply)
          ? reply
          : undefined;
      const replyHandle = replyOwner ? getActiveNativeAttempt(replyOwner.sessionId) : undefined;
      if (params.scope.kind === "voice-session") {
        // Retain the claim instance: A-to-B-to-A is reassignment, not revival.
        // Identical registrations preserve this snapshot at the producer.
        if (
          !voiceBinding ||
          resolveClientVoiceRunBinding(runId) !== voiceBinding ||
          voiceBinding.voiceSessionId !== params.scope.voiceSessionId ||
          voiceBinding.agentId !== agentId ||
          voiceBinding.sessionKey !== sessionKey
        ) {
          return false;
        }
      }
      return (
        params.context.rpcSources.get(runId) === entry &&
        entry.input.claim === claim &&
        claim.operation === operation &&
        !claim.released &&
        isCurrentSessionControllerOperation(operation) &&
        !operation.abortSignal.aborted &&
        !operation.result &&
        entry.adapter.agentId === agentId &&
        (entry.adapter.sessionKey === sessionKey || entry.adapter.sessionKey === canonicalKey) &&
        entry.adapter.ownerConnId === connId &&
        entry.adapter.kind !== "agent" &&
        (!reply ||
          (replyOwner?.key === canonicalKey &&
            (!replyHandle || getAttachedBackend(reply) === replyHandle))) &&
        (resolvedSessionId === undefined ||
          (entry.adapter.sessionId === resolvedSessionId &&
            (replyOwner
              ? replyOwner.sessionId === resolvedSessionId
              : handle !== undefined &&
                getActiveNativeAttempt(resolvedSessionId) === handle &&
                ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) === registration))) &&
        entry.input.abortSignal === signal &&
        !signal.aborted &&
        entry.adapter.lifecycleGeneration === generation &&
        isAgentEventLifecycleGenerationCurrent(generation)
      );
    };
    if (isCurrent()) {
      const toolAuthoritySource = reply ? "reply" : registration?.toolAuthority?.source;
      return { runId, signal, isCurrent, toolAuthoritySource };
    }
  }
  return null;
}

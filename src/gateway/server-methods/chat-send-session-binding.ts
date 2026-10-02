import type { ReplySessionBinding } from "../../auto-reply/reply/get-reply.types.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  captureSessionTarget,
  type SessionEffectRef,
} from "../../sessions/session-controller.lifecycle.js";
import {
  getRpcSource,
  updateRpcSourceSessionId,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { bindSessionControllerEntryTarget } from "../../sessions/session-controller.state.js";

// Native initialization may create the SID after admission. Only the original
// registration can adopt it; retained callbacks cannot bind a successor.
export function bindChatSendPreparedSession(params: {
  clientRunId: string;
  sessionKey: string;
  sourceRef: RpcSourceRef;
  lifecycleGeneration: string;
  admission: Pick<SessionEffectRef, "isActive">;
  progressRefresh: boolean;
}): (binding: ReplySessionBinding) => void {
  const { sourceRef } = params;
  const sessionBinding = sourceRef.adapter;
  return (binding) => {
    const input = sourceRef.input;
    const operation = input.claim?.operation;
    if (binding.sessionKey !== params.sessionKey) {
      return;
    }
    if (
      getRpcSource(params.clientRunId) !== sourceRef ||
      params.lifecycleGeneration !== getAgentEventLifecycleGeneration() ||
      !params.admission.isActive() ||
      input.abortSignal.aborted ||
      input.phase === "consumed" ||
      input.retirementRequested ||
      input.custody.cancellationRetired ||
      input.withdrawalHolds > 0 ||
      operation?.abortFrozen ||
      operation?.result ||
      sessionBinding.projectSessionTerminalPending ||
      sessionBinding.projectSessionTerminalPersisted
    ) {
      throw createAbortError("chat session preparation no longer owns its admission");
    }
    const owner = sourceRef.input.mailbox.owner;
    const target = owner.target;
    if (!target) {
      throw new Error("Prepared RPC source lost its physical target");
    }
    bindSessionControllerEntryTarget(
      owner,
      captureSessionTarget({
        storeScope: target.storeScope,
        sessionKey: target.sessionKey,
        aliases: target.aliases,
        agentId: target.agentId,
        incarnation: binding.sessionId,
      }),
    );
    updateRpcSourceSessionId(sourceRef, binding.sessionId);
  };
}

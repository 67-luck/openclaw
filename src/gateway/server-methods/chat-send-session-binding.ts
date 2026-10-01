import type { ReplySessionBinding } from "../../auto-reply/reply/get-reply.types.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  captureSessionTarget,
  type SessionEffectRef,
} from "../../sessions/session-controller.lifecycle.js";
import { bindSessionControllerEntryTarget } from "../../sessions/session-controller.state.js";
import { isChatAbortControllerEntryAbortable } from "../chat-abort.js";
import type { ChatAbortControllerEntry } from "../chat-abort.types.js";

// Native initialization may create the SID after admission. Only the original
// registration can adopt it; retained callbacks cannot bind a successor.
export function bindChatSendPreparedSession(params: {
  rpcSources: Map<string, ChatAbortControllerEntry>;
  clientRunId: string;
  sessionKey: string;
  sourceRef: ChatAbortControllerEntry;
  lifecycleGeneration: string;
  admission: Pick<SessionEffectRef, "isActive">;
  progressRefresh: boolean;
}): (binding: ReplySessionBinding) => void {
  const { sourceRef } = params;
  const sessionBinding = sourceRef.adapter;
  return (binding) => {
    if (binding.sessionKey !== params.sessionKey) {
      return;
    }
    if (
      params.rpcSources.get(params.clientRunId) !== sourceRef ||
      params.lifecycleGeneration !== getAgentEventLifecycleGeneration() ||
      !params.admission.isActive() ||
      !isChatAbortControllerEntryAbortable(sourceRef) ||
      sourceRef.input.phase === "consumed" ||
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
    sessionBinding.sessionId = binding.sessionId;
  };
}

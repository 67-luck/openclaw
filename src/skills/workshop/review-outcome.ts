import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { extractDeliveryInfo } from "../../config/sessions/delivery-info.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import type { WorkshopChange } from "./library.js";

const log = createSubsystemLogger("skills/workshop");

/**
 * A background Workshop run fails only when the model or runtime failed. Tool errors — a refused
 * write, a gated tool, a patch that did not match — are the model's to handle, not run failures.
 */
export function assertSkillReviewRunSucceeded(
  result: Pick<EmbeddedAgentRunResult, "meta" | "payloads">,
): void {
  const runtimeErrorPayload = result.payloads?.find(
    (payload) => payload.isError && !getReplyPayloadMetadata(payload)?.toolErrorWarning,
  );
  const message =
    result.meta.error?.message.trim() ||
    (result.meta.aborted ? "Skill review model run aborted." : undefined) ||
    runtimeErrorPayload?.text?.trim();
  if (message || runtimeErrorPayload) {
    throw new Error(message || "Skill review model run failed.");
  }
}

const ACTION_VERB: Record<WorkshopChange["action"], string> = {
  create: "created",
  patch: "updated",
  write_file: "updated",
  remove_file: "updated",
  archive: "archived",
  restore: "restored",
};

/** One short line naming what a background review changed and how to revert it. */
export function formatWorkshopChangeNotice(changes: readonly WorkshopChange[]): string {
  // Several edits to one skill read as one learned change: a skill created in this run reads
  // as "created" with its creation summary; otherwise the latest change wins.
  const bySkill = new Map<string, WorkshopChange>();
  for (const change of changes.toSorted((a, b) => a.createdAtMs - b.createdAtMs)) {
    if (bySkill.get(change.skillName)?.action !== "create") {
      bySkill.set(change.skillName, change);
    }
  }
  const parts = [...bySkill.values()].map((change) => {
    const summary = change.summary.trim();
    return `${ACTION_VERB[change.action]} \`${change.skillName}\`${summary ? ` (${summary})` : ""}`;
  });
  return `💾 Learned: ${parts.join("; ")}. Say "undo" to revert this skill change.`;
}

/**
 * Model-facing context for the next turn: exactly how to revert each change. A skill that
 * existed before the review restores the version saved before the review first changed it;
 * a skill with no such version (created by the review) is archived.
 */
function formatWorkshopUndoContext(changes: readonly WorkshopChange[]): string {
  const firstBySkill = new Map<string, WorkshopChange>();
  for (const change of changes.toSorted((a, b) => a.createdAtMs - b.createdAtMs)) {
    if (!firstBySkill.has(change.skillName)) {
      firstBySkill.set(change.skillName, change);
    }
  }
  const reverts = [...firstBySkill.values()].map(({ skillName, versionId }) =>
    versionId
      ? `skill_workshop action=restore name=${skillName} version=${versionId}`
      : `skill_workshop action=archive name=${skillName} reason="undo"`,
  );
  return `A background skill review just changed your learned skills and told the user: ${formatWorkshopChangeNotice(changes)} If the user asks to undo or revert it, call ${reverts.join("; then ")}.`;
}

/**
 * Posts the notice into the originating conversation: external channels get a durable send
 * mirrored into the session transcript; channel-less sessions (Control UI) get a transcript
 * entry. The next foreground turn also gets a system event naming the exact revert call,
 * because an assistant line the model did not write is weak evidence that "undo" means it.
 */
export async function postWorkshopChangeNotice(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  runId: string;
  changes: readonly WorkshopChange[];
}): Promise<void> {
  if (params.changes.length === 0) {
    return;
  }
  enqueueSystemEvent(formatWorkshopUndoContext(params.changes), {
    sessionKey: resolveSystemEventQueueKey(params.sessionKey, params.agentId),
  });
  const text = formatWorkshopChangeNotice(params.changes);
  const idempotencyKey = `skill-workshop-notice:${params.runId}`;
  try {
    const { deliveryContext: target } = extractDeliveryInfo(params.sessionKey, {
      cfg: params.config,
    });
    const channel = target?.channel ? normalizeMessageChannel(target.channel) : undefined;
    if (channel && isDeliverableMessageChannel(channel) && target?.to) {
      // Delivery and transcript runtimes stay lazy: most reviews change nothing.
      const { sendDurableMessageBatchCore } = await import("../../channels/message/runtime.js");
      const send = await sendDurableMessageBatchCore({
        cfg: params.config,
        channel,
        to: target.to,
        accountId: target.accountId,
        threadId: target.threadId,
        payloads: [{ text }],
        session: buildOutboundSessionContext({
          cfg: params.config,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
        }),
        mirror: { sessionKey: params.sessionKey, agentId: params.agentId, idempotencyKey },
        bestEffort: true,
      });
      if (send.status === "failed" || send.status === "partial_failed") {
        throw send.error;
      }
      return;
    }
    const { appendAssistantMessageToSessionTranscript } =
      await import("../../config/sessions/transcript.runtime.js");
    const appended = await appendAssistantMessageToSessionTranscript({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      text,
      idempotencyKey,
      config: params.config,
    });
    if (!appended.ok) {
      throw new Error(appended.reason);
    }
  } catch (error) {
    // The system event above still carries the change to the next turn.
    log.warn(`skill workshop notice delivery failed: ${String(error)}`);
  }
}

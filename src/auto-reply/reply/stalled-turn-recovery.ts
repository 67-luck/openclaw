import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import type { FollowupRun } from "./queue/types.js";
import type { ReplyOperation } from "./reply-run-registry.js";

/** Last-resort feedback once no continuation can answer a stalled turn. */
export const STALLED_TURN_NOTICE_TEXT =
  "⚠️ This turn was interrupted because it stopped making progress. Please try again.";
export const STALLED_TURN_GUIDANCE =
  "Your previous turn stopped making progress and was stopped before you replied, so the " +
  "user's request from that turn is still unanswered. Answer it now, together with any newer " +
  "message, from what the transcript already contains. " +
  "Keep further tool use to a minimum, do not repeat actions that already ran, and briefly " +
  "say what you could not verify.";

/** A stale watchdog expired this operation before it produced output: the user saw nothing. */
export function isReplyOperationStalledBeforeOutput(
  operation: ReplyOperation | undefined,
): boolean {
  return (
    operation?.result?.kind === "failed" &&
    operation.result.code === "run_stalled" &&
    (operation.staleExpiryReason === "no_activity" ||
      operation.staleExpiryReason === "stuck_recovery")
  );
}

/** Builds the one recovery run that answers a stalled turn over its persisted transcript. */
export function buildStalledTurnRecoveryRun(base: FollowupRun): FollowupRun {
  const source = base.queuedFollowupReplyDisposition;
  return {
    ...base,
    prompt: formatSystemTurnPrompt(STALLED_TURN_GUIDANCE),
    summaryLine: "stalled-turn-recovery",
    stalledTurnRecovery: true,
    disableCollectBatching: true,
    enqueuedAt: Date.now(),
    // The inbound request, its media, and its runtime context are already in the
    // transcript; this internal system turn persists no user message of its own.
    transcriptPrompt: undefined,
    userTurnTranscriptRecorder: undefined,
    currentInboundContext: undefined,
    images: undefined,
    imageOrder: undefined,
    media: undefined,
    // The stalled turn's signal, adoption lifecycle, and receipts belong to the
    // aborted dispatch; sharing them would cancel or settle this run with it.
    abortSignal: undefined,
    turnAdoptionLifecycle: undefined,
    replyOperationRunStates: undefined,
    onQueueDisposition: undefined,
    // Delivers through the source's queued reply owner, like any follow-up it queued.
    queuedFollowupReplyDisposition:
      source?.kind === "deliver"
        ? { kind: "deliver", deliver: source.deliver.createSourceRetry?.() ?? source.deliver }
        : source,
    // Personal skill authoring is bound to the stalled run's admission and
    // refuses a replacement run. Without the grant the Workshop tool would fall
    // back to the wider shared namespace, so that recovery answers without tools.
    ...(base.run.skillLibraryAuthoring ? { disableTools: true } : {}),
    run: {
      ...base.run,
      suppressNextUserMessagePersistence: true,
      skillLibraryAuthoring: undefined,
    },
  };
}

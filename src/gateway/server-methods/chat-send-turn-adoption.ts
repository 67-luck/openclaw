import { resolveAgentRunAbortLifecycleFields } from "../../agents/run-termination.js";
import type { TurnAdoptionLifecycle } from "../../auto-reply/get-reply-options.types.js";
import type { QueuedFollowupReplyDelivery } from "../../auto-reply/reply/queue/types.js";
import { bindReplySourceInput } from "../../auto-reply/reply/reply-source-binding.js";
import { retireSessionControllerSourceCancellation } from "../../sessions/session-controller.mailbox.js";
import type {
  RpcSourceAdapter,
  RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { captureAgentJobSession, setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { buildAbortedChatSendPayload } from "./chat-abort-authorization.js";
import type { WebchatReplyMediaRequesterContext } from "./chat-reply-media.js";
import { createChatSendLateFollowupDisposition } from "./chat-send-late-followup.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { createChatSendLateReplyFinalizer } from "./chat-send-source-finalization.js";
import type { GatewayRequestContext } from "./types.js";

export function createChatSendTurnAdoptionLifecycle(params: {
  requesterContext?: WebchatReplyMediaRequesterContext;
  accountId: string | undefined;
  sourceRef: RpcSourceRef;
  context: GatewayRequestContext;
  runId: string;
  controller: AbortController;
  sessionBinding: Readonly<
    Pick<RpcSourceAdapter, "sessionKey" | "sessionId" | "agentId" | "lifecycleGeneration">
  > &
    Pick<RpcSourceAdapter, "abortDiagnosticReason">;
  sessionKey: string;
  agentId?: string;
  ownerConnId?: string;
  ownerDeviceId?: string;
  ownerKey?: string;
  originatingLeafEntryId?: string | null;
  originatingChannel: string;
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "backingSessionId" | "cfg" | "clientRunId" | "sessionKey" | "sessionLoadOptions"
  >;
  hasCronCreatorAuthority: boolean;
  suppressReplies?: boolean;
  retainWorkAdmission: () => () => void;
  armOperatorRunCancellation?: () => void;
  retireOperatorRunCancellation?: () => void;
}): {
  lifecycle: TurnAdoptionLifecycle;
  isEnqueued: () => boolean;
  isCompleted: () => boolean;
  onQueueDisposition: (reason: string) => void;
  onQueuedFollowupReplyBatch: QueuedFollowupReplyDelivery;
} {
  let terminalKnown = false;
  let completed = false;
  let settlementRecorded = false;
  let releaseWorkAdmission: (() => void) | undefined;
  const recordQueuedTerminal = (status: "completed" | "aborted") => {
    // An active source dispatch still owns terminal recording after its work settles.
    if (
      !params.suppressReplies &&
      (status !== "aborted" ||
        (params.sourceRef.input.claim?.operation !== undefined &&
          !params.sourceRef.input.claim.released))
    ) {
      return;
    }
    const now = Date.now();
    setGatewayDedupeEntry({
      dedupe: params.context.dedupe,
      key: `chat:${params.runId}`,
      session: captureAgentJobSession(params.sessionBinding),
      entry: {
        ts: now,
        ok: true,
        payload:
          status === "aborted"
            ? buildAbortedChatSendPayload({
                runId: params.runId,
                endedAt: now,
                stopReason: resolveAgentRunAbortLifecycleFields(params.controller.signal)
                  .stopReason,
              })
            : { runId: params.runId, status },
      },
    });
  };
  const lateFollowup = createChatSendLateFollowupDisposition({
    runId: params.runId,
    originatingChannel: params.originatingChannel,
    logGateway: params.context.logGateway,
    deliver: params.suppressReplies
      ? async ({ completion }) => {
          terminalKnown ||= completion.kind !== "progress";
          return { kind: "dropped" as const, reason: "no-visible-content" as const };
        }
      : createChatSendLateReplyFinalizer({
          requesterContext: params.requesterContext,
          abortSignal: params.controller.signal,
          accountId: params.accountId,
          context: params.context,
          session: params.session,
        }),
  });
  const priorCancel = params.sourceRef.adapter.cancel?.bind(params.sourceRef.adapter);
  params.sourceRef.adapter.cancel = (reason) => {
    priorCancel?.(reason);
    recordQueuedTerminal("aborted");
  };
  const lifecycle: TurnAdoptionLifecycle = {
    // Gateway cancel identity only — share collect key via ownerKey.
    admission: "cancel-only",
    abortSignal: params.sourceRef.input.abortSignal,
    ...(params.originatingLeafEntryId !== undefined
      ? { originatingLeafEntryId: params.originatingLeafEntryId }
      : {}),
    ownerKey: params.ownerKey,
    onAdopted: () => {
      params.sourceRef.input.abortSignal.throwIfAborted();
    },
    onDeferred: () => {
      if (params.hasCronCreatorAuthority) {
        lifecycle.cronCreatorAuthorityUnavailable = "queued-local-operator";
      }
      const input = params.sourceRef.input;
      if (input.abortSignal.aborted || input.phase === "consumed") {
        return false;
      }
      // Only physical source-publication custody survives ACK; selection lives on input.
      releaseWorkAdmission ??= params.retainWorkAdmission();
      lateFollowup.recordQueued();
      params.armOperatorRunCancellation?.();
      return true;
    },
    onCancellationRetired: () => {
      retireSessionControllerSourceCancellation(params.sourceRef.input);
      params.retireOperatorRunCancellation?.();
    },
    onAbandoned: () => {
      terminalKnown = true;
    },
    onSettled: () => {
      if (settlementRecorded) {
        return;
      }
      settlementRecorded = true;
      const ownsCompletion = params.context.rpcSources.get(params.runId) === params.sourceRef;
      // Consumed steering also settles custody, but has no terminal batch. Only
      // the exact queued owner can retire an executed or abandoned refresh.
      completed = ownsCompletion && terminalKnown;
      try {
        if (ownsCompletion) {
          params.retireOperatorRunCancellation?.();
        }
        if (completed) {
          recordQueuedTerminal(params.controller.signal.aborted ? "aborted" : "completed");
        }
      } finally {
        releaseWorkAdmission?.();
        releaseWorkAdmission = undefined;
      }
    },
  };
  bindReplySourceInput(lifecycle, params.sourceRef.input);
  const priorSettled = params.sourceRef.adapter.onSettled?.bind(params.sourceRef.adapter);
  params.sourceRef.adapter.onSettled = async () => {
    try {
      await lifecycle.onSettled?.();
    } finally {
      await priorSettled?.();
    }
  };
  return {
    lifecycle,
    isEnqueued: () => params.sourceRef.input.custody.enqueued === true,
    isCompleted: () => completed,
    onQueueDisposition: (reason) => {
      params.context.logGateway.info("chat queue turn intentionally skipped", {
        runId: params.runId,
        sessionKey: params.sessionKey,
        outcome: "skipped",
        reason,
      });
    },
    onQueuedFollowupReplyBatch: lateFollowup.deliver,
  };
}

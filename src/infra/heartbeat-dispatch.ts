import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import {
  resolveHeartbeatReplyPayload,
  resolveHeartbeatTerminalToolFailure,
} from "../auto-reply/heartbeat-reply-payload.js";
import {
  selectHeartbeatToolResponse,
  type HeartbeatToolResponse,
} from "../auto-reply/heartbeat-tool-response.js";
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS } from "../auto-reply/heartbeat.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../auto-reply/reply-payload.js";
import { suppressPendingFinalDelivery } from "../auto-reply/reply/dispatch-from-config.pending-final.js";
import { resolveReplyOperationAbortReason } from "../auto-reply/reply/reply-operation-abort.js";
import {
  resolveReplyOperationAgentTurn,
  type ReplyOperationRunState,
} from "../auto-reply/reply/reply-operation-run-state.js";
import { resolveMessagingToolPayloadDedupe } from "../auto-reply/reply/reply-payloads-dedupe.js";
import { resolveResponsePrefixTemplate } from "../auto-reply/reply/response-prefix-template.js";
import { consumePreparedSystemEventEntries } from "../auto-reply/reply/session-system-events.js";
import { resolveSourceReplyDeliveryMode } from "../auto-reply/reply/source-reply-delivery-mode.js";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import { sendDurableMessageBatchCore } from "../channels/message/runtime.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { mergeSessionEntry } from "../config/sessions/types.js";
import { writeCronJobScratch } from "../cron/scratch-store.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { formatErrorMessage } from "./errors.js";
import { classifyHeartbeatAgentOutcome } from "./heartbeat-delivery-normalization.js";
import {
  isExecCompletionSystemEvent,
  selectHeartbeatRouteProgressEvents,
} from "./heartbeat-events-filter.js";
import { emitHeartbeatEvent, resolveIndicatorType } from "./heartbeat-events.js";
import { heartbeatLog as log } from "./heartbeat-log.js";
import { persistHeartbeatOutcome } from "./heartbeat-outcome-store.js";
import { captureHeartbeatRouteContinuation } from "./heartbeat-route-continuation.js";
import { resolveHeartbeatChannelPlugin } from "./heartbeat-runner-config.js";
import type {
  HeartbeatRunOptions,
  PreparedHeartbeatRun,
  ReadyHeartbeatWake,
} from "./heartbeat-runner-execution.js";
import { truncateHeartbeatPreview } from "./heartbeat-runner-prompt.js";
import { restoreHeartbeatUpdatedAt } from "./heartbeat-runner-session.js";
import {
  prepareHeartbeatTargetAwareness,
  publishHeartbeatSessionReply,
} from "./heartbeat-session-publication.js";
import {
  HEARTBEAT_IDLE_RETRY_GRACE_MS,
  HEARTBEAT_SKIP_CHANNEL_NOT_READY,
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  requestHeartbeat,
  type HeartbeatRunResult,
} from "./heartbeat-wake.js";
import { resolveAgentOutboundIdentity } from "./outbound/identity.js";
import { buildOutboundSessionContext } from "./outbound/session-context.js";
import { resolveSystemEventQueueKey } from "./system-event-ownership.js";
import {
  holdSystemEventDelivery,
  hasUnsettledSystemEventSelection,
  peekDeliverableSystemEventEntries,
  selectQueuedSystemEventEntries,
} from "./system-events.js";

type HeartbeatDispatch = {
  opts: HeartbeatRunOptions;
  wake: ReadyHeartbeatWake;
  prepared: PreparedHeartbeatRun;
  result?: HeartbeatRunResult;
  deliveryError?: string;
  deliveryReason?: string;
  deliverySilent?: boolean;
  projectTarget?: boolean;
  publicationSourceText?: string;
  prepareReply: NonNullable<ReplyOperationRunState["heartbeat"]>["prepareReply"];
};

export function createHeartbeatDispatch(
  opts: HeartbeatRunOptions,
  wake: ReadyHeartbeatWake,
  prepared: PreparedHeartbeatRun,
): HeartbeatDispatch {
  const policy: HeartbeatDispatch = {
    opts,
    wake,
    prepared,
    prepareReply: (result, state) => prepareHeartbeatDispatchReply(policy, result, state),
  };
  return policy;
}

const FIRST_HEARTBEAT_ALERT_PREAMBLE =
  'First heartbeat alert: your bot runs periodic background checks and messages you only when something needs attention. Run `openclaw config set agents.defaults.heartbeat.target "none"` to keep these internal.';
/** Monitoring decides which final is public before ordinary dispatch can send it. */
async function prepareHeartbeatDispatchReply(
  policy: HeartbeatDispatch,
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
  runState: ReplyOperationRunState,
): ReturnType<HeartbeatDispatch["prepareReply"]> {
  const { opts, wake, prepared } = policy;
  const { cfg, agentId, startedAt, preflight, scheduledTasks, wakeSource } = wake;
  const { delivery, visibility, sessionKey, storePath, runSessionKey, previousUpdatedAt } =
    prepared;
  const replies = replyResult ? (Array.isArray(replyResult) ? replyResult : [replyResult]) : [];
  const selected = resolveHeartbeatReplyPayload(replyResult);
  const execution = resolveReplyOperationAgentTurn(runState);
  const heartbeatResponse = selectHeartbeatToolResponse(replyResult);
  const response = heartbeatResponse?.response;
  // Admission can lose to foreground work after preflight. An empty rejected
  // turn must leave its events queued, unlike a completed quiet turn.
  const admissionBusy =
    runState.admission?.status === "skipped" &&
    runState.admission.reason === "active-run" &&
    !response &&
    (!selected || !hasOutboundReplyContent(selected));
  if (execution === "cancelled" || execution === "superseded" || admissionBusy) {
    const reason =
      execution === "superseded"
        ? "preempted"
        : execution === "cancelled"
          ? "agent-runner-cancelled"
          : HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT;
    policy.result = { status: "skipped", reason };
    emitHeartbeatEvent({ status: "skipped", reason, durationMs: Date.now() - startedAt });
    return {};
  }
  const channel = delivery.channel !== "none" ? delivery.channel : undefined;
  const committed = resolveMessagingToolPayloadDedupe({
    config: cfg,
    messageProvider: channel,
    originatingTo: delivery.to,
    originatingThreadId: delivery.threadId,
    accountId: delivery.accountId,
    messagingToolSentTargets: runState.messagingToolSentTargets,
  });
  const failure = resolveHeartbeatTerminalToolFailure(replyResult);
  const responsePrefix = resolveResponsePrefixTemplate(
    prepared.replyPrefix.responsePrefix,
    prepared.replyPrefix.responsePrefixContextProvider(),
  );
  const outcome = classifyHeartbeatAgentOutcome({
    agentRun: {
      agentRunFailed: execution === "failed",
      heartbeatToolResponse: response,
      heartbeatTerminalToolFailure: failure,
      replyPayload: selected,
    },
    hasRelayableExecCompletion: prepared.hasRelayableExecCompletion,
    suppressUnmarkedSourceReplies:
      resolveSourceReplyDeliveryMode({
        cfg,
        ctx: { ChatType: delivery.chatType, Provider: delivery.channel },
      }) === "message_tool_only",
    responsePrefix,
    ackMaxChars: DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  });
  const scratch =
    outcome.kind === "failure" || !heartbeatResponse
      ? undefined
      : getReplyPayloadMetadata(heartbeatResponse.payload)?.heartbeatScratchProposal;
  if (scratch !== undefined && response) {
    if (!preflight.scratchJobId) {
      log.warn("heartbeat: scratch update ignored because no monitor job exists");
    } else {
      try {
        const owner = runState.agentTurnOwner;
        const written = await writeCronJobScratch(
          {
            storePath: resolveCronJobsStorePathFromConfig(cfg),
            jobId: preflight.scratchJobId,
            content: scratch,
            expectedRevision: preflight.scratchRevision ?? 0,
          },
          {
            assertCurrent() {
              if (runState.agentTurnOwner !== owner || resolveReplyOperationAbortReason(owner)) {
                throw new Error("Heartbeat scratch writer is no longer current");
              }
            },
          },
        );
        if (!written.ok) {
          log.warn("heartbeat: scratch update lost a concurrent revision race");
        }
      } catch (error) {
        log.warn(`heartbeat: scratch update failed: ${formatErrorMessage(error)}`);
      }
    }
  }
  // Quiet and unselected payloads never acquire delivery custody. Their exact prepared
  // intents may retire; queued or unknown recovery ownership is untouched.
  for (const reply of replies) {
    if (
      (execution !== "failed" && response?.notify === false) ||
      (reply !== selected && outcome.kind !== "failure")
    ) {
      await suppressPendingFinalDelivery(reply, { preserveActivity: true });
    }
  }
  const finish = (
    event: Parameters<typeof emitHeartbeatEvent>[0],
    consume = true,
    holdDelivery = false,
    dedicatedCompleted = false,
  ) => {
    emitHeartbeatEvent({
      ...event,
      ...(committed.matchingRoute && event.silent === true ? { silent: false } : {}),
      durationMs: Date.now() - startedAt,
      accountId: delivery.accountId,
    });
    if (preflight.shouldInspectPendingEvents) {
      const queueKey = resolveSystemEventQueueKey(sessionKey, agentId);
      if (consume || dedicatedCompleted) {
        consumePreparedSystemEventEntries({
          agentId,
          sessionKey,
          events: consume
            ? prepared.inspectedSystemEventsToConsume
            : prepared.inspectedSystemEventsToConsume.filter(
                (entry) =>
                  !isExecCompletionSystemEvent(entry) && !prepared.genericEvents.includes(entry),
              ),
        });
      }
      if (!consume && holdDelivery) {
        // Unconfirmed cron retains retry custody; completed dedicated work may retire.
        // Only exec and routed generic occurrences transfer to held delivery custody.
        holdSystemEventDelivery(queueKey, [
          ...prepared.inspectedSystemEventsToConsume.filter((entry) =>
            isExecCompletionSystemEvent(entry),
          ),
          ...(prepared.retainGenericEventsUntilDelivery ? prepared.genericEvents : []),
        ]);
      }
      const remainingEntries = peekDeliverableSystemEventEntries(queueKey);
      // Only admitted/dedicated selections can make progress. Excluded base notices
      // neither justify another turn nor block a settled exec from advancing. Cron
      // occurrences that remain deliverable retain their own retry ownership.
      const { progressEvents, deferredEvents } = selectHeartbeatRouteProgressEvents({
        selectedEvents: preflight.selectedEventEntries,
        genericEvents: prepared.genericEvents,
        deferredEvents: prepared.deferredSystemEvents,
        inspectsRunQueue: preflight.session.inspectsRunQueue,
        isCronWake: preflight.isCronWake,
      });
      const selectedStillDeliverable = hasUnsettledSystemEventSelection(queueKey, progressEvents);
      const mayAdvanceRoute =
        (consume || holdDelivery) &&
        (progressEvents.length > 0 || scheduledTasks.length > 0) &&
        !selectedStillDeliverable;
      const hasPendingExec =
        mayAdvanceRoute && remainingEntries.some((entry) => isExecCompletionSystemEvent(entry));
      const hasDeferredRoute = selectQueuedSystemEventEntries(queueKey, deferredEvents).some(
        (entry) => !entry.deliveryHeld,
      );
      // Retained route groups keep this wake's effective destination. Preserve
      // cleared fields too: cron target:last must not regain configured to/account.
      const routeContinuation = captureHeartbeatRouteContinuation(
        wake.heartbeatOverride,
        preflight.isCronWake,
      );
      if (hasPendingExec) {
        requestHeartbeat({
          source: "exec-event",
          intent: "event",
          reason: "exec-event",
          agentId,
          sessionKey,
          routeContinuation,
          coalesceMs: 0,
        });
      } else if (mayAdvanceRoute && hasDeferredRoute) {
        requestHeartbeat({
          source: "hook",
          intent: "immediate",
          reason: "hook:pending-route",
          agentId,
          sessionKey,
          routeContinuation,
          coalesceMs: 0,
        });
      }
      if ((consume || holdDelivery) && prepared.hasExecCompletion && prepared.hasCronEvents) {
        // Coalesced waiters share this turn, but exec and cron retain separate prompt/delivery policy.
        requestHeartbeat({
          source: "cron",
          intent: "immediate",
          reason: "cron:pending",
          agentId,
          sessionKey,
          routeContinuation,
        });
      }
    }
    policy.result =
      outcome.kind === "failure"
        ? { status: "failed", reason: outcome.reason }
        : { status: "ran", durationMs: Date.now() - startedAt };
  };
  const stateKey = prepared.outboundPolicySessionKey ?? sessionKey;
  const record = (value: HeartbeatToolResponse) =>
    persistHeartbeatOutcome({
      agentId,
      sessionKey: stateKey,
      storePath,
      runSessionKey,
      response: value,
      taskNames: scheduledTasks.map((task) => task.name),
      wakeSource,
      wakeReason: opts.reason,
      occurredAt: startedAt,
    });
  const unconfirmed = async (reason: string) => {
    if (outcome.kind !== "delivery" || !outcome.response) {
      return;
    }
    const value = outcome.response;
    await record({
      ...value,
      outcome: "blocked",
      notify: false,
      summary: `Alert delivery was not confirmed for this attempt.\n${value.notificationText ?? value.summary}${value.notificationText ? `\nModel summary: ${value.summary}` : ""}`,
      reason: `notify:true; delivery=${reason}; model outcome=${value.outcome}; ${value.reason ?? value.summary}`,
    });
  };
  const restoreActivity = () =>
    restoreHeartbeatUpdatedAt({ agentId, storePath, sessionKey, updatedAt: previousUpdatedAt });
  const suppressSelected = () => suppressPendingFinalDelivery(selected, { preserveActivity: true });
  if (outcome.kind === "ack") {
    if ("response" in outcome && outcome.response) {
      await record(outcome.response);
    }
    await restoreActivity();
    await suppressSelected();
    const aborted = resolveReplyOperationAbortReason(runState.agentTurnOwner);
    if (aborted) {
      const reason = aborted === "superseded" ? "preempted" : "agent-runner-cancelled";
      policy.result = { status: "skipped", reason };
      emitHeartbeatEvent({ status: "skipped", reason, durationMs: Date.now() - startedAt });
      return {};
    }
    if (committed.matchingRoute) {
      finish({
        status: "sent",
        to: delivery.to,
        preview: truncateHeartbeatPreview(committed.routeSentTexts.join("\n")),
        hasMedia: committed.routeSentMediaUrls.length > 0,
        channel,
        indicatorType: visibility.useIndicator ? resolveIndicatorType("sent") : undefined,
        silent: false,
      });
      return {};
    }
    if (runState.backgroundWorkStarted) {
      finish(
        {
          status: "skipped",
          reason: "background-work",
          message: "Heartbeat started background work; completion is tracked separately.",
          channel,
          silent: true,
        },
        false,
        true,
        true,
      );
      return {};
    }
    const event = {
      status: outcome.eventStatus,
      reason: opts.reason,
      ...("preview" in outcome ? { preview: outcome.preview } : {}),
      channel,
      indicatorType: visibility.useIndicator
        ? resolveIndicatorType(outcome.eventStatus)
        : undefined,
    };
    if (!("silent" in outcome && outcome.silent) && visibility.showOk && channel && delivery.to) {
      const readiness = await resolveHeartbeatChannelPlugin(channel)
        ?.heartbeat?.checkReady?.({
          cfg,
          accountId: delivery.accountId,
          deps: opts.deps,
        })
        .catch((error: unknown) => {
          log.warn(`heartbeat: HEARTBEAT_OK delivery failed: ${formatErrorMessage(error)}`);
          return { ok: false };
        });
      if (!readiness || readiness.ok) {
        return {
          reply: setReplyPayloadMetadata(
            { text: responsePrefix ? `${responsePrefix} ${HEARTBEAT_TOKEN}` : HEARTBEAT_TOKEN },
            {
              heartbeatReply: true,
              deliverDespiteSourceReplySuppression: true,
            },
          ),
          settle: async (result) => {
            if (policy.deliveryError) {
              log.warn(`heartbeat: HEARTBEAT_OK delivery failed: ${policy.deliveryError}`);
            }
            finish(
              { ...event, silent: result !== "delivered" },
              !prepared.retainGenericEventsUntilDelivery || result === "delivered",
              result !== "delivered",
              true,
            );
          },
        };
      }
    }
    finish(
      { ...event, silent: true },
      !prepared.retainGenericEventsUntilDelivery,
      prepared.retainGenericEventsUntilDelivery,
      true,
    );
    return {};
  }
  const stateEntry = prepared.policySessionEntry;
  const failed = outcome.kind === "failure";
  const normalized = outcome.normalized;
  const text = normalized.text;
  const preview = truncateHeartbeatPreview(failed ? text || outcome.previewText : text);
  const event = {
    status: failed ? ("failed" as const) : ("sent" as const),
    ...(failed ? { reason: outcome.reason } : {}),
    preview,
    channel,
    indicatorType: failed && visibility.useIndicator ? resolveIndicatorType("failed") : undefined,
  };
  if (failed) {
    await restoreActivity();
  } else {
    const previousAt = stateEntry?.lastHeartbeatSentAt;
    if (
      !prepared.internalProjection &&
      !prepared.hasExecCompletion &&
      !prepared.retainGenericEventsUntilDelivery &&
      !outcome.mediaUrls.length &&
      !outcome.hasStructuredReplyContent &&
      stateEntry?.lastHeartbeatText?.trim() &&
      text.trim() === stateEntry.lastHeartbeatText.trim() &&
      typeof previousAt === "number" &&
      previousAt <= startedAt &&
      startedAt - previousAt < 24 * 60 * 60 * 1000
    ) {
      await restoreActivity();
      await suppressSelected();
      finish(
        { status: "skipped", reason: "duplicate", preview, hasMedia: false, channel },
        !prepared.retainGenericEventsUntilDelivery,
      );
      return {};
    }
  }
  const noChannelTarget = !prepared.internalProjection && (!channel || !delivery.to);
  if (noChannelTarget || !visibility.showAlerts || (failed && outcome.shouldSkipMain)) {
    if (!failed) {
      await unconfirmed(noChannelTarget ? (delivery.reason ?? "no-target") : "alerts-disabled");
      if (!visibility.showAlerts) {
        await restoreActivity();
      }
      await suppressSelected();
    }
    finish(
      failed
        ? { ...event, silent: true }
        : {
            ...event,
            status: "skipped",
            reason: noChannelTarget ? (delivery.reason ?? "no-target") : "alerts-disabled",
            hasMedia: outcome.mediaUrls.length > 0,
            indicatorType:
              !noChannelTarget && visibility.useIndicator
                ? resolveIndicatorType("sent")
                : undefined,
          },
      !failed && !prepared.retainGenericEventsUntilDelivery,
      !failed && prepared.retainGenericEventsUntilDelivery,
    );
    return {};
  }
  const readiness = channel
    ? await resolveHeartbeatChannelPlugin(channel)
        ?.heartbeat?.checkReady?.({ cfg, accountId: delivery.accountId, deps: opts.deps })
        .catch((error: unknown) => ({ ok: false, reason: formatErrorMessage(error) }))
    : undefined;
  if (readiness && !readiness.ok) {
    await unconfirmed(readiness.reason ?? HEARTBEAT_SKIP_CHANNEL_NOT_READY);
    await restoreActivity();
    finish(
      {
        ...event,
        status: failed ? "failed" : "skipped",
        reason: failed ? outcome.reason : readiness.reason,
        ...(failed ? { silent: true } : {}),
      },
      false,
    );
    if (!failed) {
      policy.result = {
        status: "skipped",
        reason: HEARTBEAT_SKIP_CHANNEL_NOT_READY,
        retryAtMs: Date.now() + HEARTBEAT_IDLE_RETRY_GRACE_MS,
      };
    }
    return {};
  }
  policy.deliverySilent = normalized.silent;
  policy.projectTarget = !failed;
  // Receipt identity uses the producer answer, not transport prefix decoration.
  policy.publicationSourceText = outcome.replyPayload?.text;
  const deliveryText =
    !failed && delivery.implicitDefaultRoute && stateEntry?.lastHeartbeatSentAt === undefined
      ? `${FIRST_HEARTBEAT_ALERT_PREAMBLE}\n${text}`
      : text;
  const payload = copyReplyPayloadMetadata(selected ?? {}, {
    ...outcome.replyPayload,
    text: deliveryText || undefined,
    ...(!failed ? { mediaUrls: outcome.mediaUrls } : {}),
  });
  return {
    reply: setReplyPayloadMetadata(markReplyPayloadForSourceSuppressionDelivery(payload), {
      heartbeatReply: true,
    }),
    settle: async (result) => {
      const sent = result === "delivered";
      if (!sent) {
        await unconfirmed(policy.deliveryError ?? policy.deliveryReason ?? result);
      }
      if (sent && !failed && deliveryText.trim()) {
        await patchSessionEntryCore(
          { agentId, storePath, sessionKey: stateKey },
          (current, context) =>
            (
              context.existingEntry
                ? current.sessionId === stateEntry?.sessionId &&
                  current.lifecycleRevision === stateEntry?.lifecycleRevision
                : stateEntry === undefined
            )
              ? { lastHeartbeatText: text, lastHeartbeatSentAt: startedAt }
              : null,
          {
            fallbackEntry: mergeSessionEntry(undefined, { updatedAt: startedAt }),
            preserveActivity: true,
          },
        );
      }
      finish(
        failed
          ? { ...event, silent: !sent || normalized.silent === true }
          : {
              ...event,
              status: sent ? "sent" : policy.deliveryError ? "failed" : "skipped",
              indicatorType: visibility.useIndicator
                ? resolveIndicatorType(sent ? "sent" : policy.deliveryError ? "failed" : "skipped")
                : undefined,
              ...(!sent ? { reason: policy.deliveryError ?? policy.deliveryReason ?? result } : {}),
              to: delivery.to,
              preview: truncateHeartbeatPreview(deliveryText),
              hasMedia: outcome.mediaUrls.length > 0,
              ...(normalized.silent === true ? { silent: true } : {}),
            },
        sent && !failed,
        // Failed internal projection performs no completion I/O and remains retryable.
        // External unconfirmed delivery must retain custody even when the model failed.
        (!sent || failed) && (!failed || delivery.channel !== "none"),
      );
      if (policy.deliveryError && !failed) {
        policy.result = { status: "failed", reason: policy.deliveryError };
      }
    },
  };
}

/** The core dispatcher owns custody; monitoring supplies its existing transport policy. */
export async function deliverHeartbeatDispatch(
  policy: HeartbeatDispatch,
  payload: ReplyPayload,
  signal?: AbortSignal,
) {
  const { cfg, agentId, startedAt } = policy.wake;
  const { delivery, runSessionKey, storePath, outboundPolicySessionKey, internalProjection } =
    policy.prepared;
  const onDeliveredPayload = policy.projectTarget
    ? prepareHeartbeatTargetAwareness({
        agentId,
        storePath,
        runSessionKey,
        targetSessionKey: delivery.targetSessionKey,
        startedAt,
      })
    : undefined;
  try {
    if (delivery.channel === "none" || !delivery.to) {
      // A failed attempt does not own the successful completion's receipt identity.
      if (!internalProjection || policy.projectTarget === false) {
        return { visibleReplySent: false };
      }
      const occurrenceIds = policy.prepared.inspectedSystemEventsToConsume.map((event) => event.id);
      if (!occurrenceIds.every((id): id is string => typeof id === "string" && id.length > 0)) {
        policy.deliveryReason = "exec completion occurrence identity unavailable";
        return { visibleReplySent: false };
      }
      const committed = await publishHeartbeatSessionReply({
        cfg,
        agentId,
        storePath,
        sessionKey: internalProjection.sessionKey,
        expectedGeneration: internalProjection,
        occurrenceIds,
        payload,
        sourceText: policy.publicationSourceText,
        signal,
      });
      if (!committed.ok) {
        policy.deliveryReason = committed.reason;
      }
      // Settlement consumes only captured occurrences, and only after the
      // canonical transcript owner accepts this generation's write or replay.
      return { visibleReplySent: committed.ok };
    }
    const send = await sendDurableMessageBatchCore({
      cfg,
      channel: delivery.channel,
      to: delivery.to,
      accountId: delivery.accountId,
      threadId: delivery.threadId,
      payloads: [payload],
      session: buildOutboundSessionContext({
        cfg,
        agentId,
        sessionKey: runSessionKey,
        policySessionKey: outboundPolicySessionKey,
      }),
      identity: resolveAgentOutboundIdentity(cfg, agentId),
      deps: policy.opts.deps,
      signal,
      silent: policy.deliverySilent,
      onDeliveredPayload,
    });
    if (send.status === "failed" || send.status === "partial_failed") {
      throw send.error;
    }
    if (send.status === "suppressed") {
      policy.deliveryReason = send.reason;
    }
    return {
      visibleReplySent: send.status === "sent",
      ...(send.status === "suppressed" && send.reason === "adapter_returned_no_identity"
        ? { ambiguous: true }
        : {}),
    };
  } catch (error) {
    policy.deliveryError = formatErrorMessage(error);
    throw error;
  }
}

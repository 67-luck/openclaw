import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveDefaultAgentId } from "../../agents/agent-scope-config.js";
import { resolveReplyCompletion } from "../../agents/reply-completion.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import { settleProgressVisibilityCallbackResult } from "../../channels/progress-visibility.js";
import { resolveRestartRecoverySteeringBlockReason } from "../../config/sessions/restart-recovery-receipt.js";
import { hasRestartRecoverySourceClaim } from "../../config/sessions/restart-recovery-state.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { logVerbose } from "../../globals.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { hasOutboundReplyContent } from "../../plugin-sdk/reply-payload.js";
import {
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import {
  submitSessionControllerInput,
  claimSessionControllerInput,
  tryClaimSessionControllerTask,
  bindSessionControllerInputOperation,
  attachSessionControllerInputOperation,
  releaseSessionControllerClaim,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import {
  BLOCK_REPLY_SEND_TIMEOUT_MS,
  cleanupReplyAgentRun,
  handleReplyAgentRunError,
  resolveAdmittedRunSessionFile,
  type RunReplyAgentParams,
  scheduleFollowupDrainAfterReplyOperationClear,
} from "./agent-runner-core.js";
import {
  createReplyAgentRestartRecoveryController,
  executePreparedReplyAgentRun,
} from "./agent-runner-execute.js";
import { resolveReplySteeringAuthority } from "./agent-runner-fallback-authority.js";
import { createShouldEmitToolOutput, createShouldEmitToolResult } from "./agent-runner-helpers.js";
import { runReplyQuestionInput } from "./agent-runner-question-input.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import { prepareReplyStreamingDelivery } from "./agent-runner-streaming-delivery.js";
import { resolveQueuedReplyExecutionConfig } from "./agent-runner-utils.js";
import { createFollowupRunner } from "./followup-runner.js";
import { REPLY_RUN_STILL_SHUTTING_DOWN_TEXT } from "./get-reply-run-queue.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { resolveActiveRunQueueAction } from "./queue-policy.js";
import {
  enqueueFollowupRun,
  scheduleFollowupDrain,
  completeFollowupRunLifecycle,
} from "./queue.js";
import { resolveFollowupAbortSignal } from "./queue/types.js";
import { REPLY_ADMISSION_TICKET } from "./reply-admission-ticket.js";
import { createReplyMediaContext } from "./reply-media-paths.js";
import * as replyRunState from "./reply-operation-run-state.js";
import { bindReplyOperationTyping } from "./reply-run-typing.js";
import { bindReplySourceToFollowup, retireUnadoptedReplySource } from "./reply-source-binding.js";
import { createReplyToModeFilterForChannel, resolveReplyToMode } from "./reply-threading.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { admitReplyTurn, resolveReplyTurnKind } from "./reply-turn-admission.js";
import { createReplyTurnRotationEvidence } from "./reply-turn-rotation.js";
import {
  isDuplicateRestartRecoverySource,
  retireTerminalRestartRecoverySourceClaim,
} from "./restart-recovery-claim.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";
import { resolveSourceReplyExpectation } from "./source-reply-delivery-mode.js";
import { readChannelSourceTurnId } from "./source-turn-id.js";
import { createTypingSignaler } from "./typing-mode.js";
export async function runReplyAgent(
  input: RunReplyAgentParams,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const params = { ...input };
  const {
    followupRun,
    queueKey,
    resolvedQueue,
    shouldSteer,
    shouldFollowup,
    hasQueuedFollowups = false,
    isActive,
    isRunActive,
    opts,
    typing,
    sessionEntry,
    sessionStore,
    sessionKey,
    runtimePolicySessionKey,
    storePath,
    defaultModel,
    resolvedVerboseLevel,
    toolProgressDetail,
    isNewSession,
    blockStreamingEnabled,
    blockReplyChunking,
    sessionCtx,
    typingMode,
    resetTriggered,
    replyOperation: providedReplyOperation,
  } = params;
  // Physical admission needs the same default identity execution has always
  // resolved; capture it before submitting the source, not after preparation.
  followupRun.run.agentId ??= resolveDefaultAgentId(followupRun.run.config);
  followupRun.turnAdoptionLifecycle ??= opts?.turnAdoptionLifecycle;
  bindReplySourceToFollowup(opts, followupRun);
  const controllerInput = submitSessionControllerInput(
    queueKey,
    followupRun,
    resolvedQueue,
    opts?.runId,
  );
  try {
    followupRun.abortSignal = followupRun.abortSignal
      ? AbortSignal.any([controllerInput.abortSignal, followupRun.abortSignal])
      : controllerInput.abortSignal;
    followupRun.operatorAuthority?.assertCurrent();
    const resolveGatewayContext = providedReplyOperation
      ? getGatewayContextResolver(providedReplyOperation)
      : (readChannelContextGatewayContextResolver(sessionCtx) ??
        getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext);
    // One lifecycle for all adoption sites in this run.
    const turnAdoptionLifecycle = opts?.turnAdoptionLifecycle;
    const releaseAdmissionTicket = () => opts?.[REPLY_ADMISSION_TICKET]?.release();
    let activeSessionEntry = sessionEntry;
    const activeSessionStore = sessionStore;
    const effectiveResetTriggered = resetTriggered === true;

    const isHeartbeat = opts?.isHeartbeat === true;
    const replyExpectation = (followupRun.run.terminalReplyExpectation ??=
      resolveSourceReplyExpectation({
        ctx: {
          ...sessionCtx,
          InboundEventKind: followupRun.currentInboundEventKind ?? sessionCtx.InboundEventKind,
          InputProvenance: followupRun.run.inputProvenance ?? sessionCtx.InputProvenance,
        },
        cfg: followupRun.run.config,
        isHeartbeat,
      }));
    let didDeliverVisiblePartialReply = false;
    const onPartialReply = opts?.onPartialReply;
    const runOpts = onPartialReply
      ? {
          ...opts,
          onPartialReply: async (
            payload: Parameters<NonNullable<typeof opts.onPartialReply>>[0],
          ) => {
            const operation = controllerInput.claim?.operation;
            const observed = await settleProgressVisibilityCallbackResult(onPartialReply(payload));
            if (observed.visible && hasOutboundReplyContent(payload, { trimText: true })) {
              didDeliverVisiblePartialReply = true;
              operation?.watchdog.progress("finalization", "reply:partial_delivered");
            }
            return observed.result;
          },
        }
      : opts;
    const replyOperationRunState = replyRunState.resolveReplyOperationRunState(opts);
    if (replyOperationRunState) {
      replyOperationRunState.replyCompletion = resolveReplyCompletion(
        followupRun.run.terminalReplyExpectation,
        "empty",
      );
    }
    followupRun.replyOperationRunStates = replyOperationRunState
      ? [replyOperationRunState]
      : undefined;
    const traceAttributes = {
      provider: followupRun.run.provider,
      hasSessionKey: Boolean(sessionKey ?? followupRun.run.sessionKey),
      isHeartbeat,
      queueMode: resolvedQueue.mode,
      isActive,
      blockStreamingEnabled,
    };
    const traceAgentPhase = <T>(name: string, run: () => Promise<T> | T): Promise<T> =>
      measureDiagnosticsTimelineSpan(name, run, {
        phase: "agent-turn",
        config: followupRun.run.config,
        attributes: traceAttributes,
      });
    const readGeneration = getAgentEventLifecycleGeneration();
    const assertReadCurrent = () => {
      assertAgentRunLifecycleGenerationCurrent(readGeneration);
      followupRun.operatorAuthority?.assertCurrent();
    };
    const restartRecoverySourceTurnId = readChannelSourceTurnId(sessionCtx);
    let restartRecoveryEntry: typeof activeSessionEntry;
    try {
      restartRecoveryEntry =
        sessionKey && storePath
          ? ((await readSessionEntryInWorker(
              { agentId: followupRun.run.agentId, storePath, sessionKey },
              assertReadCurrent,
            )) ?? activeSessionEntry)
          : activeSessionEntry;
      assertReadCurrent();
    } catch (error) {
      releaseAdmissionTicket();
      typing.cleanup();
      retireSessionControllerInput(controllerInput);
      throw error;
    }
    if (
      restartRecoverySourceTurnId &&
      isDuplicateRestartRecoverySource(restartRecoveryEntry, restartRecoverySourceTurnId)
    ) {
      // Durable source ownership identifies provider redelivery even if the run
      // became terminal before its claim cleanup committed.
      if (
        restartRecoveryEntry?.status !== "running" &&
        sessionKey &&
        storePath &&
        hasRestartRecoverySourceClaim(restartRecoveryEntry, restartRecoverySourceTurnId)
      ) {
        const retired = await retireTerminalRestartRecoverySourceClaim({
          agentId: followupRun.run.agentId,
          sessionId: restartRecoveryEntry.sessionId,
          sessionKey,
          sourceTurnId: restartRecoverySourceTurnId,
          storePath,
        });
        if (retired) {
          activeSessionEntry = retired;
          if (activeSessionStore) {
            activeSessionStore[sessionKey] = retired;
          }
        }
      }
      releaseAdmissionTicket();
      typing.cleanup();
      retireSessionControllerInput(controllerInput);
      return undefined;
    }

    const effectiveShouldSteer = !isHeartbeat && !effectiveResetTriggered && shouldSteer;
    const effectiveShouldFollowup = !effectiveResetTriggered && shouldFollowup;
    const messageInjectionDisposition = opts?.messageInjectionDisposition ?? "none";
    const activeReplyOperation = controllerInput.mailbox.owner.active ?? providedReplyOperation;
    const steeringAuthority = resolveReplySteeringAuthority(followupRun, activeReplyOperation);
    const shouldQueueAuthorityMismatch =
      effectiveShouldSteer && isActive && steeringAuthority.shouldQueueAuthorityMismatch;
    if (shouldQueueAuthorityMismatch) {
      logVerbose(
        `queue: active session ${activeReplyOperation?.sessionId ?? followupRun.run.sessionId} has different or unknown tool authority; queuing instead of steering`,
      );
    }
    const typingSignals = createTypingSignaler({
      typing,
      mode: typingMode,
      isHeartbeat,
    });
    // New steering must not reuse a terminal source claim. Compare the active
    // source identity so unrelated retained tombstones still permit steering.
    // The parked admission owner rechecks after any predecessor wait.
    const activeSourceTurnId =
      controllerInput.mailbox.owner.sourceTurnId ??
      normalizeOptionalString(restartRecoveryEntry?.restartRecoveryDeliverySourceRunId) ??
      "";
    const terminalDeliveryBlockReason = resolveRestartRecoverySteeringBlockReason(
      restartRecoveryEntry,
      activeReplyOperation?.sessionId ?? followupRun.run.sessionId,
      activeSourceTurnId,
    );
    const shouldQueueTerminalReceiptSteer =
      effectiveShouldSteer &&
      isActive &&
      !shouldQueueAuthorityMismatch &&
      messageInjectionDisposition === "none" &&
      terminalDeliveryBlockReason !== undefined;
    if (shouldQueueTerminalReceiptSteer) {
      logVerbose(
        `queue: active session ${activeReplyOperation?.sessionId ?? followupRun.run.sessionId} cannot accept steering (${terminalDeliveryBlockReason}); queuing instead`,
      );
    }

    const questionInput = await runReplyQuestionInput(input);
    if (questionInput.handled) {
      releaseAdmissionTicket();
      typing.cleanup();
      retireSessionControllerInput(controllerInput);
      return questionInput.payload;
    }

    const baseShouldEmitToolResult = createShouldEmitToolResult({
      sessionKey,
      storePath,
      resolvedVerboseLevel,
      verboseLevelOverride: followupRun.run.verboseLevelOverride,
    });
    const channelProgressCanConsumeToolResults =
      Boolean(opts?.forceToolResultProgress) && Boolean(opts?.onToolResult);
    const shouldEmitToolResult = () =>
      channelProgressCanConsumeToolResults || baseShouldEmitToolResult();
    const shouldEmitToolOutput = createShouldEmitToolOutput({
      sessionKey,
      storePath,
      resolvedVerboseLevel,
      verboseLevelOverride: followupRun.run.verboseLevelOverride,
    });

    const pendingToolTasks = new Set<Promise<void>>();
    const blockReplyTimeoutMs = opts?.blockReplyTimeoutMs ?? BLOCK_REPLY_SEND_TIMEOUT_MS;
    const touchActiveSessionEntry = async () => {
      if (!activeSessionEntry || !activeSessionStore || !sessionKey) {
        return;
      }
      // Keep the in-memory snapshot aligned with the pending-reset write boundary.
      const updatedAt = activeSessionEntry.updatedAt === 0 ? 0 : Date.now();
      activeSessionEntry.updatedAt = updatedAt;
      activeSessionStore[sessionKey] = activeSessionEntry;
      if (storePath) {
        await updateSessionEntry(
          { agentId: followupRun.run.agentId, storePath, sessionKey },
          () => ({ updatedAt }),
          { skipMaintenance: true, takeCacheOwnership: true },
        );
      }
    };

    const queuedRunFollowupTurn = createFollowupRunner({
      resolveGatewayContext,
      opts,
      typing,
      typingMode,
      sessionEntry: activeSessionEntry,
      sessionStore: activeSessionStore,
      sessionKey,
      storePath,
      defaultModel,
      toolProgressDetail,
    });

    if (messageInjectionDisposition === "accepted") {
      if (replyOperationRunState) {
        replyOperationRunState.admission = { status: "accepted", mode: "steer" };
      }
      releaseAdmissionTicket();
      typing.cleanup();
      retireSessionControllerInput(controllerInput);
      return undefined;
    }

    const bindQueueDisposition = () => {
      const observe = followupRun.onQueueDisposition;
      followupRun.onQueueDisposition = (disposition) => {
        observe?.(disposition);
        if (
          replyOperationRunState &&
          (disposition !== "queue-cap-old" ||
            replyOperationRunState.admission?.status !== "accepted")
        ) {
          replyOperationRunState.admission = { status: "skipped", reason: "queue-cap" };
        }
      };
    };

    if (
      effectiveShouldSteer &&
      isActive &&
      !shouldQueueAuthorityMismatch &&
      !shouldQueueTerminalReceiptSteer &&
      messageInjectionDisposition === "none"
    ) {
      bindQueueDisposition();
      const result = await runActiveReplySteer({
        followupRun,
        opts,
        providedReplyOperation: activeReplyOperation,
        queueKey,
        releaseAdmissionTicket,
        replyOperationRunState,
        resolvedQueue,
        restartRecoverySourceTurnId,
        runFollowup: queuedRunFollowupTurn,
        sessionCtx,
        sessionKey,
        sessionEntry: activeSessionEntry,
        storePath,
        touchActiveSessionEntry,
        typing,
        typingSignals,
        toolAuthorityFingerprint: steeringAuthority.toolAuthorityFingerprint,
        automaticFallbackRoute: steeringAuthority.automaticFallbackRoute,
        pendingInputAuthorityFingerprint: steeringAuthority.pendingInputAuthorityFingerprint,
      });
      return result === "handled" ? undefined : result;
    }

    const activeRunQueueAction = resolveActiveRunQueueAction({
      hasQueuedFollowups,
      interrupt: resolvedQueue.mode === "interrupt",
      isActive,
      isHeartbeat,
      shouldFollowup: effectiveShouldFollowup || shouldQueueAuthorityMismatch,
      resetTriggered: effectiveResetTriggered,
    });
    if (activeRunQueueAction === "drop") {
      retireSessionControllerInput(controllerInput);
      if (replyOperationRunState) {
        replyOperationRunState.admission = { status: "skipped", reason: "active-run" };
      }
      releaseAdmissionTicket();
      typing.cleanup();
      return undefined;
    }

    if (activeRunQueueAction === "enqueue-followup") {
      bindQueueDisposition();
      const enqueued = enqueueFollowupRun(
        queueKey,
        followupRun,
        resolvedQueue,
        "message-id",
        queuedRunFollowupTurn,
        false,
      );
      if (!enqueued) {
        releaseAdmissionTicket();
        typing.cleanup();
        retireSessionControllerInput(controllerInput);
        return undefined;
      }
      if (replyOperationRunState) {
        replyOperationRunState.admission = { status: "accepted", mode: "followup" };
      }
      // The queue must stay dormant while the active owner can still collect
      // messages. Registering after enqueue closes the owner-clear race.
      const queuedOperationOwner = controllerInput.mailbox.owner.active ?? activeReplyOperation;
      if (queuedOperationOwner) {
        scheduleFollowupDrainAfterReplyOperationClear({
          operation: queuedOperationOwner,
          queueKey,
          runFollowup: queuedRunFollowupTurn,
        });
      } else {
        scheduleFollowupDrain(queueKey, queuedRunFollowupTurn);
      }
      releaseAdmissionTicket();
      const queuedBehindActiveRun = isRunActive?.() === true;
      await touchActiveSessionEntry();
      if (queuedBehindActiveRun) {
        await typingSignals.signalToolStart();
      } else {
        typing.cleanup();
      }
      return undefined;
    }

    followupRun.run.config = await resolveQueuedReplyExecutionConfig(followupRun.run.config, {
      originatingChannel: sessionCtx.OriginatingChannel,
      messageProvider: followupRun.run.messageProvider,
      originatingAccountId: followupRun.originatingAccountId,
      agentAccountId: followupRun.run.agentAccountId,
    });

    const replyToChannel = resolveOriginMessageProvider({
      originatingChannel: sessionCtx.OriginatingChannel,
      provider: sessionCtx.Surface ?? sessionCtx.Provider,
    }) as OriginatingChannelType | undefined;
    const replyToMode =
      followupRun.originatingReplyToMode ??
      resolveReplyToMode(
        followupRun.run.config,
        replyToChannel,
        sessionCtx.AccountId,
        sessionCtx.ChatType,
      );
    const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
    const cfg = followupRun.run.config;
    const replyMediaContext = createReplyMediaContext({
      cfg,
      agentId: followupRun.run.agentId,
      sessionKey,
      workspaceDir: followupRun.run.workspaceDir,
      mediaNormalizationOwner: followupRun.run.mediaNormalizationOwner,
      messageProvider: followupRun.run.messageProvider,
      accountId: followupRun.originatingAccountId ?? followupRun.run.agentAccountId,
      groupId: followupRun.run.groupId,
      groupChannel: followupRun.run.groupChannel,
      groupSpace: followupRun.run.groupSpace,
      requesterSenderId: followupRun.run.senderId,
      requesterSenderName: followupRun.run.senderName,
      requesterSenderUsername: followupRun.run.senderUsername,
      requesterSenderE164: followupRun.run.senderE164,
    });
    const { sendDirectCompactionNotice, blockReplyPipeline } = prepareReplyStreamingDelivery({
      opts,
      sessionCtx,
      cfg,
      applyReplyToMode,
      blockStreamingEnabled,
      blockReplyChunking,
      blockReplyTimeoutMs,
    });
    const resolveVisibleReplyDelivery = async () => {
      // Settle accepted or in-flight blocks before deciding whether a terminal failure may stay silent.
      try {
        await blockReplyPipeline?.flush({ force: true });
      } catch (flushError) {
        logVerbose(
          `failed to flush streamed reply blocks before surfacing run failure: ${String(flushError)}`,
        );
      }
      return didDeliverVisiblePartialReply || blockReplyPipeline?.didStream() === true;
    };
    const replySessionKey = sessionKey ?? followupRun.run.sessionKey;
    const replyRouteThreadId = resolveRoutedDeliveryThreadId({
      ctx: sessionCtx,
      sessionKey: replySessionKey,
    });
    let replyOperation: ReplyOperation;
    if (providedReplyOperation) {
      replyOperation = providedReplyOperation;
      attachSessionControllerInputOperation(followupRun, replyOperation);
      if (replyOperationRunState) {
        replyOperationRunState.admission = { status: "owned" };
      }
      releaseAdmissionTicket();
    } else {
      const replyTurnKind = resolveReplyTurnKind(opts);
      // The selector can wait past a predecessor's compaction and raw cleanup.
      // Preserve its physical lineage before waiting, not just its final ID.
      const rotationEvidence = createReplyTurnRotationEvidence({
        sessionKey: replySessionKey ?? "",
        controller: controllerInput.mailbox.owner,
      });
      const observation = rotationEvidence.observeAdmission();
      let mailboxClaim;
      try {
        // Heartbeats never wait behind a claim, unbound source, or effect fence.
        const selected = isHeartbeat
          ? tryClaimSessionControllerTask(controllerInput)
          : claimSessionControllerInput(followupRun);
        releaseAdmissionTicket();
        mailboxClaim = await selected;
      } catch (error) {
        if (!resolveFollowupAbortSignal(followupRun)?.aborted) {
          throw error;
        }
      } finally {
        observation.dispose();
      }
      if (!mailboxClaim) {
        if (replyOperationRunState) {
          replyOperationRunState.admission = {
            status: "skipped",
            reason: resolveFollowupAbortSignal(followupRun)?.aborted ? "aborted" : "active-run",
          };
        }
        typing.cleanup();
        return undefined;
      }
      const admission = await admitReplyTurn({
        mailboxClaim,
        rotationEvidence,
        runId: controllerInput.protocolRunId,
        providerReviewAcknowledgment: opts?.providerReviewAcknowledgment,
        agentId: followupRun.run.agentId,
        resolveGatewayContext,
        sessionId: followupRun.run.sessionId,
        sessionKey: replySessionKey ?? "",
        expectedSessionId: activeSessionEntry?.sessionId,
        storePath,
        kind: replyTurnKind,
        resetTriggered: effectiveResetTriggered,
        routeThreadId: replyRouteThreadId,
        originatingLeafEntryId: turnAdoptionLifecycle?.originatingLeafEntryId,
        upstreamAbortSignal: resolveFollowupAbortSignal({
          abortSignal: controllerInput.abortSignal,
          operatorAuthority: followupRun.operatorAuthority,
        }),
      }).catch((error: unknown) => {
        releaseSessionControllerClaim(mailboxClaim);
        throw error;
      });
      if (replyOperationRunState) {
        replyOperationRunState.admission =
          admission.status === "owned"
            ? { status: "owned" }
            : { status: "skipped", reason: admission.reason };
      }
      if (admission.status === "skipped") {
        releaseSessionControllerClaim(mailboxClaim);
        typing.cleanup();
        if (admission.reason !== "active-run" || replyTurnKind !== "visible") {
          return undefined;
        }
        return markReplyPayloadForSourceSuppressionDelivery({
          text: REPLY_RUN_STILL_SHUTTING_DOWN_TEXT,
        });
      }
      replyOperation = admission.operation;
      bindSessionControllerInputOperation(followupRun, replyOperation);
      const previousRunSessionId = followupRun.run.sessionId;
      followupRun.run.sessionId = replyOperation.sessionId;
      if (replyOperation.sessionId !== previousRunSessionId) {
        const admittedSessionEntry =
          admission.sessionEntry ??
          (replySessionKey
            ? (activeSessionStore?.[replySessionKey] ?? activeSessionEntry)
            : activeSessionEntry);
        if (admittedSessionEntry?.sessionId === replyOperation.sessionId) {
          activeSessionEntry = admittedSessionEntry;
          if (admission.sessionEntry && activeSessionStore && replySessionKey) {
            activeSessionStore[replySessionKey] = admission.sessionEntry;
          }
          const admittedSessionFile = resolveAdmittedRunSessionFile({
            sessionFile: undefined,
            sessionKey: replySessionKey,
          });
          if (admittedSessionFile) {
            followupRun.run.sessionFile = admittedSessionFile;
          }
        }
      }
    }
    replyOperation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(followupRun));
    bindReplyOperationTyping(replyOperation, typing);
    let runFollowupTurn = queuedRunFollowupTurn;
    let shouldDrainQueuedFollowupsAfterClear = false;
    const returnWithQueuedFollowupDrain = <T>(value: T): T => {
      shouldDrainQueuedFollowupsAfterClear = true;
      return value;
    };
    const {
      admitUserTurn,
      beginBeforeAgentReply,
      checkpointBeforeAgentReply,
      clear: clearRestartRecoveryDeliveryClaim,
      isArmed: isRestartRecoveryArmed,
    } = createReplyAgentRestartRecoveryController({
      activeSessionStore,
      cfg,
      followupRun,
      getActiveSessionEntry: () => activeSessionEntry,
      opts,
      replyOperation,
      restartRecoverySourceTurnId,
      runtimePolicySessionKey,
      sessionCtx,
      sessionKey,
      setActiveSessionEntry: (entry) => {
        activeSessionEntry = entry;
      },
      storePath,
    });
    try {
      return await executePreparedReplyAgentRun({
        ...params,
        activeSessionStore,
        admitUserTurn,
        applyReplyToMode,
        beginBeforeAgentReply,
        blockReplyPipeline,
        cfg,
        checkpointBeforeAgentReply,
        resolveVisibleReplyDelivery,
        activeIsNewSession: isNewSession,
        getActiveSessionEntry: () => activeSessionEntry,
        isHeartbeat,
        isRestartRecoveryArmed,
        opts: runOpts,
        pendingToolTasks,
        replyMediaContext,
        replyOperation,
        replyRouteThreadId,
        replyToChannel,
        replyToMode,
        returnWithQueuedFollowupDrain,
        runFollowupTurn,
        sendDirectCompactionNotice,
        setActiveSessionEntry: (entry) => {
          activeSessionEntry = entry;
        },
        setRunFollowupTurn: (runner) => {
          runFollowupTurn = runner;
        },
        shouldEmitToolOutput,
        shouldEmitToolResult,
        traceAgentPhase,
        turnAdoptionLifecycle,
        typingSignals,
      });
    } catch (error) {
      replyRunState.recordReplyOperationAgentTurn(
        followupRun.replyOperationRunStates,
        replyOperation,
      );
      return await handleReplyAgentRunError(error, {
        resolveVisibleReplyDelivery,
        isHeartbeat,
        replyExpectation,
        isRestartRecoveryArmed,
        replyOperation,
        resolvedVerboseLevel,
        returnWithQueuedFollowupDrain,
        sessionCtx,
      });
    } finally {
      await cleanupReplyAgentRun({
        blockReplyPipeline,
        clearRestartRecoveryDeliveryClaim,
        providedReplyOperation,
        queueKey,
        replyOperation,
        runFollowupTurn,
        sessionKey,
        shouldDrainQueuedFollowupsAfterClear,
        typing,
      });
      completeFollowupRunLifecycle(followupRun);
      if (controllerInput.claim) {
        releaseSessionControllerClaim(controllerInput.claim);
      }
    }
  } finally {
    retireUnadoptedReplySource(controllerInput);
  }
}

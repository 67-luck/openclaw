import { performance } from "node:perf_hooks";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { createMessageInjectionAuthority } from "../../auto-reply/reply/message-injection-authority.js";
import {
  lookupSessionGoalOperation,
  type SessionGoalOperation,
  type SessionGoalOperationResult,
} from "../../config/sessions/goals-operations.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { emitDiagnosticsTimelineEvent } from "../../infra/diagnostics-timeline.js";
// chat.send owns admission, ACK timing, and detached dispatch handoff.
import { isProgressCardRefreshInputProvenance } from "../../sessions/input-provenance.js";
import {
  retireProviderReviewAcknowledgment,
  type ProviderReviewAcknowledgment,
} from "../../sessions/provider-review.js";
import { recordSessionCreated } from "../../sessions/session-created.js";
import {
  bindUserTurnPendingInputWorkerAuthority,
  finishUserTurnPendingInput,
} from "../../sessions/user-turn-transcript.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import type { SkillWorkshopProposalRevisionConstraint } from "../../skills/workshop/types.js";
import { resolveChatAbortDiagnosticReason } from "../chat-abort-diagnostics.js";
import {
  resolveSessionMutationAuthorization,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import {
  prepareGatewaySkillAuthoring,
  invalidateSkillAuthoringForOtherRequester,
} from "../skill-library-authoring.js";
import {
  terminalizeRestartSafeChatAdmission,
  type RestartSafeChatTerminalState,
} from "./chat-restart-recovery.js";
import { startChatDispatch } from "./chat-send-agent-dispatch.js";
import {
  bindChatSendPreparedMediaCustody,
  prepareChatSendAttachments,
} from "./chat-send-attachments.js";
import { handleChatSendSetupError } from "./chat-send-dispatch-errors.js";
import type { ChatSendExternalAuthorityAdmission } from "./chat-send-external-authority-contract.js";
import {
  createChatSendMessageInjectionStarter,
  renderChatSendInjectionDocumentContext,
  settleChatSendPreAckMessageInjection,
} from "./chat-send-message-injection.js";
import { applyChatSendReplyContextFields } from "./chat-send-reply-context.js";
import { prepareAndAdmitChatSend } from "./chat-send-setup.js";
import { prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import {
  createChatSendPendingInputCleanup,
  createChatSendGoalCommitGuard,
} from "./chat-send-work-admission.js";
import {
  chatSendAckServerTimingAttributes,
  createChatSendAckTiming,
} from "./chat-server-timing.js";
import { createGatewayChatUserTurnController } from "./chat-user-turn-recorder.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { publishCommittedSessionGoalChange } from "./session-goal-change.js";
import {
  captureGatewayFreshInputWorkerAuthority,
  prepareGatewayPendingInputWorkerAuthority,
} from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions, SessionMutationAuthorization } from "./types.js";

type ChatSendInternalOptions = {
  providerReviewAcknowledgment?: ProviderReviewAcknowledgment;
  goalResume?: SessionGoalOperation & { action: "resume" };
  trustedSystemInput?: boolean;
  transcript?: Parameters<typeof createGatewayChatUserTurnController>[0]["transcript"];
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  toolsAllow?: string[];
  skillWorkshopProposalRevision?: SkillWorkshopProposalRevisionConstraint;
};

async function handleChatSendWithOptions(
  handlerOptions: GatewayRequestHandlerOptions,
  onAdmissionOwned?: () => Promise<boolean>,
  externalAuthorityAdmission?: ChatSendExternalAuthorityAdmission,
  options?: ChatSendInternalOptions,
): Promise<void> {
  const {
    req,
    params,
    respond,
    context,
    client,
    hasCurrentClientAuthority,
    sessionMutationAuthorization,
    sessionMutationCommitGuard,
  } = handlerOptions;
  const setup = await prepareAndAdmitChatSend(
    { params, respond, context, client, hasCurrentClientAuthority, sessionMutationAuthorization },
    onAdmissionOwned,
    options,
  );
  if (!setup) {
    return;
  }
  const { normalizedRequest, preparedSession, admitted } = setup;
  const { chatSendReceivedAtMs, clientInfo, p, systemInputProvenance, reconnectResumeRequested } =
    normalizedRequest.value;
  const {
    clientRunId,
    sessionLoadMs,
    cfg,
    storePath,
    entry,
    sessionKey,
    sessionRoutingChanged,
    selectedAgent,
  } = preparedSession.value;
  const {
    activeRunAbort,
    admittedSessionId,
    chatSendTraceAttributes,
    finishAbortedChatSend,
    interruptedActiveRun,
    lifecycleGeneration,
    messageInjectionTarget,
    restartSafeAdmission,
  } = admitted.value;
  const preparedAttachments = await prepareChatSendAttachments({
    client,
    request: normalizedRequest.value,
    session: preparedSession.value,
    admission: admitted.value,
    respond,
    context,
  });
  if (!preparedAttachments.ok) {
    return;
  }
  const bindPreparedMediaRecorder = bindChatSendPreparedMediaCustody({
    admission: admitted.value,
    attachments: preparedAttachments.value,
  });
  if (activeRunAbort.controller.signal.aborted) {
    await finishAbortedChatSend();
    return;
  }
  // Attachment preparation can suspend. Recheck immediately before the
  // synchronous ACK path so aborts and hot routing reloads cannot cross it.
  if (sessionRoutingChanged(context.getRuntimeConfig())) {
    await admitted.value.rejectSessionRoutingChanged();
    return;
  }
  const { imageOrder, prepareAttachmentsMs } = preparedAttachments.value;
  const externalAdmissionParams = {
    runId: clientRunId,
    sessionKey,
    spawnedBy: entry?.spawnedBy,
    client,
    isCurrent: hasCurrentClientAuthority,
    inputProvenance: systemInputProvenance,
    hasExplicitOrigin: normalizedRequest.value.explicitOrigin !== undefined,
    hasRestoredCronContinuation: entry?.cronRunContinuation !== undefined,
    isIncognitoEntry: entry?.incognito === true,
    isReconnectResume: reconnectResumeRequested,
    isSystemGenerated:
      normalizedRequest.value.suppressCommandInterpretation ||
      normalizedRequest.value.systemProvenanceReceipt !== undefined,
    turnKind: normalizedRequest.value.turnKind,
  };
  const cronCreatorAuthority = externalAuthorityAdmission?.resolve(externalAdmissionParams);
  let dashboardSessionAuthorization: SessionMutationAuthorization | undefined;
  const assertDashboardReadCurrent = externalAuthorityAdmission?.allowsDashboardReads(
    externalAdmissionParams,
  )
    ? () => {
        admitted.value.assertWorkAdmissionCurrent();
        sessionMutationCommitGuard?.();
        // Admitted runs survive transport loss; their caller authority must stay current.
        if (
          client?.invalidated ||
          hasCurrentClientAuthority?.() === false ||
          !externalAuthorityAdmission.allowsDashboardReads(externalAdmissionParams)
        ) {
          throw new Error("Dashboard message read admission is no longer active.");
        }
        if (!dashboardSessionAuthorization) {
          // The original preparation may create its SID. Capture it once, never a successor.
          const resolved = resolveSessionMutationAuthorization({
            client,
            context,
            method: "chat.send",
            requestParams: { agentId: preparedSession.value.agentId, sessionKey },
            expectedTarget: {
              agentId: preparedSession.value.agentId,
              sessionKey,
              storePath,
              sessionId: admitted.value.sessionBinding.sessionId,
            },
          });
          if (resolved.error) {
            throw new SessionMutationAuthorizationChangedError(resolved.error);
          }
          if (!resolved.authorization) {
            throw new Error("Dashboard session authorization is unavailable.");
          }
          dashboardSessionAuthorization = resolved.authorization;
        }
        dashboardSessionAuthorization.assertCurrent();
      }
    : undefined;

  const admissionStartedAt = Date.now();
  const terminalizeRestartSafeAdmission = async (
    terminalState: RestartSafeChatTerminalState,
  ): Promise<boolean> =>
    await terminalizeRestartSafeChatAdmission({
      admittedSessionId,
      clientRunId,
      sessionKey,
      startedAt: admissionStartedAt,
      storePath,
      ...terminalState,
    });
  let pendingStageAttempted = false;
  try {
    const assertInputAdmissionCurrent = () => {
      admitted.value.assertClientUploadAllowed?.();
      admitted.value.assertWorkAdmissionCurrent();
      admitted.value.assertSessionTargetCurrent();
      sessionMutationCommitGuard?.();
    };
    assertInputAdmissionCurrent();
    const inputLifetime = admitted.value.capturePendingInputLifetime();
    const userTurn = createGatewayChatUserTurnController({
      admission: admitted.value,
      client,
      request: normalizedRequest.value,
      session: preparedSession.value,
      transcript: options?.transcript,
      startedAt: admissionStartedAt,
      warn: (message) => context.logGateway.warn(message),
      mentionInbox: context.mentionInbox,
      assertOriginalInputCommit: assertInputAdmissionCurrent,
      freshInputWorkerAuthority:
        req.expectedProfileId === undefined
          ? undefined
          : captureGatewayFreshInputWorkerAuthority(handlerOptions, inputLifetime),
      assertGoalCurrent: createChatSendGoalCommitGuard({
        admission: admitted.value,
        session: preparedSession.value,
        client,
        context,
        sessionMutationAuthorization,
        sessionMutationCommitGuard,
      }),
    });
    const {
      persist: persistGatewayUserTurnTranscript,
      recorder: userTurnRecorder,
      replyContextFieldsPromise,
    } = userTurn;
    bindPreparedMediaRecorder(userTurnRecorder);
    const preparedUserTurn = prepareChatSendUserTurn({
      request: normalizedRequest.value,
      session: preparedSession.value,
      admission: admitted.value,
      attachments: preparedAttachments.value,
      client,
      logGateway: context.logGateway,
      getConfig: context.getRuntimeConfig,
      userTurn,
    });
    const { ctx, isInternalTextSlashCommandTurn } = preparedUserTurn;
    admitted.value.setPendingInputCleanup(
      createChatSendPendingInputCleanup({
        activeRunAbort,
        finishPendingInput: (disposition) => {
          const pending =
            userTurnRecorder.getPendingInputMessage?.() &&
            !userTurnRecorder.isPendingInputConsumed?.();
          const joined = finishUserTurnPendingInput(userTurnRecorder, disposition);
          const publish = () => {
            if (pending && activeRunAbort.controller.signal.aborted) {
              const reason = resolveChatAbortDiagnosticReason(
                activeRunAbort.controller.signal,
                activeRunAbort.entry,
              );
              context.logGateway.info(`chat pending input aborted: ${reason} (${disposition})`, {
                runId: clientRunId,
                sessionKey,
                sessionId: admittedSessionId,
                agentId: selectedAgent.agentId,
                disposition,
                reason,
              });
            }
          };
          if (joined) {
            return joined.then(publish);
          }
          publish();
          return undefined;
        },
        discard: () =>
          preparedUserTurn
            .discardUnreferencedMedia(userTurnRecorder.getPendingInputMessage?.())
            .catch((error: unknown) =>
              context.logGateway.warn(`Failed to discard unused chat media: ${String(error)}`),
            ),
      }),
    );
    if (
      entry?.sessionId &&
      userTurn.baseInput.display !== false &&
      (!systemInputProvenance || systemInputProvenance.kind === "external_user") &&
      !isInternalTextSlashCommandTurn &&
      !normalizedRequest.value.goalOperation
    ) {
      // ACK transfers input custody. Persist approved source bytes before
      // either a direct runtime or the in-memory collector can accept them.
      pendingStageAttempted = true;
      const assertCustodyCurrent = () => {
        admitted.value.assertWorkAdmissionCurrent();
        admitted.value.assertSessionTargetCurrent();
        if (sessionMutationAuthorization?.assertAdmittedInputCurrent) {
          sessionMutationAuthorization.assertAdmittedInputCurrent();
        } else {
          sessionMutationCommitGuard?.();
          sessionMutationAuthorization?.assertCurrent();
        }
        if (sessionRoutingChanged(context.getRuntimeConfig())) {
          throw new Error("Session routing changed before input admission; refresh and retry.");
        }
      };
      let workerAuthority = await prepareGatewayPendingInputWorkerAuthority(
        handlerOptions,
        inputLifetime,
      );
      let staged: boolean | undefined;
      try {
        staged = await userTurnRecorder.stageApproved?.({
          runId: clientRunId,
          assertCurrent: () => {
            admitted.value.assertClientUploadAllowed?.();
            sessionMutationCommitGuard?.();
            assertCustodyCurrent();
          },
          assertAdmittedCurrent:
            req.expectedProfileId === undefined
              ? assertCustodyCurrent
              : createMessageInjectionAuthority(() => {
                  assertCustodyCurrent();
                  return true;
                }),
        });
        if (workerAuthority) {
          bindUserTurnPendingInputWorkerAuthority(userTurnRecorder, workerAuthority);
          workerAuthority = undefined;
        }
      } finally {
        workerAuthority?.release();
      }
      if (userTurnRecorder.isPendingInputConsumed?.()) {
        await admitted.value.cleanupAdmittedRun();
        admitted.value.clearRunContext();
        respond(true, { runId: clientRunId, status: "ok" }, undefined, {
          cached: true,
          runId: clientRunId,
        });
        return;
      }
      if (!staged) {
        throw new Error("Chat input was not durably admitted; refresh and retry.");
      }
      const approved = userTurnRecorder.getPendingInputMessage?.();
      const text =
        extractTextFromChatContent(approved?.content, {
          joinWith: "\n",
          normalizeText: (value) => value,
        }) ?? "";
      preparedUserTurn.applyApprovedText(text);
      emitSessionsChanged(
        context,
        { sessionKey, agentId: selectedAgent.agentId, reason: "send" },
        { accessChanged: false },
      );
    }
    let goalResult: SessionGoalOperationResult | undefined;
    if (restartSafeAdmission) {
      const persistedUserTurn = await persistGatewayUserTurnTranscript();
      const goalOperation = normalizedRequest.value.goalOperation;
      if (goalOperation) {
        const mutation = persistedUserTurn?.sessionTurnMutationResult;
        goalResult =
          mutation?.result ??
          lookupSessionGoalOperation({
            sessionKey,
            storePath,
            agentId: preparedSession.value.agentId,
            expectedSessionId: admittedSessionId,
            operation: goalOperation,
          });
        if (goalResult && (!persistedUserTurn || mutation?.replayed)) {
          await admitted.value.cleanupAdmittedRun();
          admitted.value.clearRunContext();
          respond(true, { ...goalResult, replayed: true }, undefined, {
            cached: true,
            runId: clientRunId,
          });
          return;
        }
        if (!goalResult || !persistedUserTurn?.sessionEntry) {
          throw new Error("Goal and its input were not durably admitted.");
        }
        if (admitted.value.initialSessionEntry) {
          recordSessionCreated(preparedSession.value.cfg, {
            sessionKey,
            agentId: preparedSession.value.agentId,
            entry: persistedUserTurn.sessionEntry,
          });
        }
        await publishCommittedSessionGoalChange(context, {
          sessionKey,
          agentId: preparedSession.value.agentId,
          entry: persistedUserTurn.sessionEntry,
          actor: gatewayClientSessionCreator(client),
          summary: `goal ${goalOperation.action}`,
        });
      }
      // A matching idempotency row and lifecycle claim commit atomically, so
      // retries adopt the durable turn without submitting it twice.
      if (
        !persistedUserTurn ||
        persistedUserTurn.sessionEntry?.status !== "running" ||
        persistedUserTurn.sessionEntry.restartRecoveryDeliveryRunId !== clientRunId
      ) {
        throw new Error("chat turn was not durably admitted");
      }
      if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
        if (activeRunAbort.entry) {
          activeRunAbort.entry.abortStopReason = "restart";
        }
        activeRunAbort.controller.abort(createAgentRunRestartAbortError());
      }
      if (activeRunAbort.controller.signal.aborted) {
        if (
          !(await terminalizeRestartSafeAdmission({
            retryable: activeRunAbort.entry?.abortStopReason === "restart",
            status: "killed",
          }))
        ) {
          throw new Error("chat admission ownership changed before terminalization");
        }
        await finishAbortedChatSend();
        return;
      }
      if (sessionRoutingChanged(context.getRuntimeConfig())) {
        if (!(await terminalizeRestartSafeAdmission({ retryable: true, status: "failed" }))) {
          throw new Error("chat admission ownership changed before terminalization");
        }
        await admitted.value.rejectSessionRoutingChanged();
        return;
      }
    }

    if (messageInjectionTarget) {
      invalidateSkillAuthoringForOtherRequester(
        sessionKey,
        client?.internal?.syntheticClient ? undefined : client?.authenticatedUserProfile?.profileId,
      );
    }
    // Rendering can fail independently of admission; preserve the raw steer on failure.
    const steerDocumentContext =
      messageInjectionTarget && !isInternalTextSlashCommandTurn && ctx.media?.length
        ? await renderChatSendInjectionDocumentContext(ctx, preparedSession.value.cfg)
        : undefined;
    if (activeRunAbort.controller.signal.aborted) {
      return finishAbortedChatSend();
    }
    if (sessionRoutingChanged(context.getRuntimeConfig())) {
      return admitted.value.rejectSessionRoutingChanged();
    }
    const beginCapturedMessageInjection = createChatSendMessageInjectionStarter({
      operatorAuthority: admitted.value.operatorAuthority,
      target: messageInjectionTarget,
      abortSignal: activeRunAbort.controller.signal,
      request: normalizedRequest.value,
      session: preparedSession.value,
      admittedSessionSettings: admitted.value.admittedSessionSettings,
      turn: preparedUserTurn,
      imageOrder,
      documentContext: steerDocumentContext,
      userTurnTranscriptRecorder: userTurnRecorder,
      logGateway: context.logGateway,
      assertCurrent:
        req.expectedProfileId === undefined &&
        !admitted.value.assertClientUploadAllowed &&
        !isProgressCardRefreshInputProvenance(systemInputProvenance)
          ? undefined
          : assertInputAdmissionCurrent,
    });
    const preAckReplyContextPromise =
      messageInjectionTarget && !isInternalTextSlashCommandTurn
        ? replyContextFieldsPromise
        : undefined;
    if (preAckReplyContextPromise) {
      applyChatSendReplyContextFields(ctx, await preAckReplyContextPromise);
      if (activeRunAbort.controller.signal.aborted) {
        return finishAbortedChatSend();
      }
      if (sessionRoutingChanged(context.getRuntimeConfig())) {
        return admitted.value.rejectSessionRoutingChanged();
      }
    }
    assertInputAdmissionCurrent();
    let messageInjectionAttempt =
      !p.replyToId || preAckReplyContextPromise ? beginCapturedMessageInjection() : undefined;
    const preAckInjection = await settleChatSendPreAckMessageInjection({
      attempt: messageInjectionAttempt,
      isAborted: () => activeRunAbort.controller.signal.aborted,
      sessionRoutingChanged: () => sessionRoutingChanged(context.getRuntimeConfig()),
      onAborted: finishAbortedChatSend,
      onSessionRoutingChanged: admitted.value.rejectSessionRoutingChanged,
    });
    if (preAckInjection.status === "handled") {
      return;
    }
    messageInjectionAttempt = preAckInjection.attempt;
    // The admitted turn owns authoring after creating a session; the request's
    // absent-target authorization expires when that session is materialized.
    const skillLibraryAuthoring = prepareGatewaySkillAuthoring(
      {
        client,
        context,
        sessionMutationCommitGuard: () => {
          sessionMutationCommitGuard?.();
          admitted.value.assertWorkAdmissionCurrent();
        },
      },
      sessionKey,
      !options &&
        !systemInputProvenance &&
        !reconnectResumeRequested &&
        normalizedRequest.value.turnKind === "main",
    );
    const { serverTiming, chatSendTiming } = createChatSendAckTiming({
      clientInfo,
      client,
      chatSendReceivedAtMs,
      sessionLoadMs,
      prepareAttachmentsMs,
    });
    context.addChatRun(clientRunId, {
      sessionKey,
      agentId: selectedAgent.agentId,
      clientRunId,
      ...(chatSendTiming ? { chatSendTiming } : {}),
    });
    // Only the recorder can attest transcript placement; custody and a started ACK cannot.
    const receipt = userTurnRecorder.getAdmissionReceipt?.();
    const ackPayload = {
      ...goalResult,
      runId: clientRunId,
      status: "started" as const,
      ...(receipt ? { messageSeq: receipt.activeMessagePosition + 1 } : {}),
      ...(interruptedActiveRun ? { interruptedActiveRun: true } : {}),
      ...(serverTiming ? { serverTiming } : {}),
    };
    emitDiagnosticsTimelineEvent(
      {
        type: "mark",
        name: "gateway.chat_send.ack_ready",
        phase: "agent-turn",
        attributes: {
          ...chatSendTraceAttributes,
          ackStatus: ackPayload.status,
          ...chatSendAckServerTimingAttributes(serverTiming),
        },
      },
      { config: cfg },
    );
    // After the ACK, dispatch owns the turn: its error lifecycle persists the
    // user transcript (which references the media) on every path, so a
    // post-ACK cleanupAdmittedRun must not race that persist with a discard.
    assertInputAdmissionCurrent();
    admitted.value.setDiscardAbandonedPreparedMedia(undefined);
    respond(true, ackPayload, undefined, { runId: clientRunId });
    context.recordClientActivity?.(client);
    const chatSendAckedAtMs = chatSendTiming?.ackedAtMs ?? performance.now();
    startChatDispatch({
      admissionStartedAt,
      admission: admitted.value,
      attachments: preparedAttachments.value,
      client,
      context,
      toolsAllow: options?.toolsAllow,
      prepareAssistantTranscriptMessage: options?.prepareAssistantTranscriptMessage,
      skillWorkshopProposalRevision: options?.skillWorkshopProposalRevision,
      skillLibraryAuthoring,
      cronCreatorAuthority,
      assertDashboardReadCurrent,
      externalAuthorityAdmission,
      injection: {
        beginCapturedMessageInjection,
        messageInjectionAttempt,
        preAckReplyContextPromise,
        replyContextFieldsPromise,
      },
      request: normalizedRequest.value,
      session: preparedSession.value,
      terminalizeRestartSafeAdmission,
      timing: {
        chatSendAckedAtMs,
        chatSendTiming,
      },
      turn: preparedUserTurn,
      userTurn,
    });
  } catch (err) {
    await handleChatSendSetupError({
      // Uncommitted Goal admissions may retry with their original identity. Committed
      // outcomes replay from the durable receipt instead of this transient error cache.
      cacheResult: normalizedRequest.value.goalOperation === undefined && !pendingStageAttempted,
      admission: admitted.value,
      context,
      error: err,
      respond,
      session: preparedSession.value,
      terminalizeRestartSafeAdmission,
    });
  }
}

export async function handleChatSend(
  options: GatewayRequestHandlerOptions,
  onAdmissionOwned?: () => Promise<boolean>,
  externalAuthorityAdmission?: ChatSendExternalAuthorityAdmission,
): Promise<void> {
  await handleChatSendWithOptions(options, onAdmissionOwned, externalAuthorityAdmission);
}

/** The ordinary chat owner retains the exact human-reviewed continuation through settlement. */
export async function handleProviderReviewContinuationChat(
  options: GatewayRequestHandlerOptions,
  acknowledgment: ProviderReviewAcknowledgment,
): Promise<void> {
  let admissionOwned = false;
  try {
    await handleChatSendWithOptions(
      options,
      async () => {
        admissionOwned = true;
        return true;
      },
      undefined,
      { providerReviewAcknowledgment: acknowledgment },
    );
  } finally {
    if (!admissionOwned) {
      retireProviderReviewAcknowledgment(acknowledgment);
    }
  }
}

/** Operator Resume admits one hidden internal continuation with the Goal transition. */
export async function handleSessionGoalResumeChat(
  options: GatewayRequestHandlerOptions,
  operation: SessionGoalOperation & { action: "resume" },
): Promise<void> {
  await handleChatSendWithOptions(options, undefined, undefined, { goalResume: operation });
}

/** Dispatches an operator-requested proposal revision with its reviewed revision bound to the run. */
export async function handleChatSendWithSkillWorkshopProposalRevision(
  options: GatewayRequestHandlerOptions,
  proposalRevision: SkillWorkshopProposalRevisionConstraint,
): Promise<void> {
  await handleChatSendWithOptions(options, undefined, undefined, {
    toolsAllow: ["skill_workshop"],
    skillWorkshopProposalRevision: { ...proposalRevision },
  });
}

/** Dispatches Gateway-authored system input without widening the public chat-send contract. */
export async function handleTrustedInternalChatSend(
  options: GatewayRequestHandlerOptions,
  onAdmissionOwned?: () => Promise<boolean>,
  inputOptions?: Pick<
    ChatSendInternalOptions,
    "transcript" | "toolsAllow" | "prepareAssistantTranscriptMessage"
  >,
): Promise<void> {
  await handleChatSendWithOptions(options, onAdmissionOwned, undefined, {
    ...inputOptions,
    trustedSystemInput: true,
  });
}

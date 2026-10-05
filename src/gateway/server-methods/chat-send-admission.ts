import { randomUUID } from "node:crypto";
import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { readAcpSessionMetaForEntries } from "../../acp/runtime/session-meta-readonly.js";
import {
  createAgentRunRestartAbortError,
  isAgentRunDirectAbortReason,
} from "../../agents/run-termination.js";
import { resolveQueueSettings } from "../../auto-reply/reply/queue/settings-runtime.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import { hasRestartRecoveryTerminalRun } from "../../config/sessions/restart-recovery-state.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { claimAgentRunContext, clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../process/gateway-work-admission.js";
import {
  isProgressCardRefreshInputProvenance,
  progressCardRefreshRunProjection,
} from "../../sessions/input-provenance.js";
import {
  type ReplyMessageInjectionTarget,
  type ReplyOperation,
  captureCurrentSessionRunInterruptTarget,
} from "../../sessions/session-controller.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import { captureCurrentReplyMessageInjectionTarget } from "../../sessions/session-controller.message-injection.js";
import {
  getRpcSource,
  getRpcSourceIdentity,
} from "../../sessions/session-controller.rpc-sources.js";
import { resolveActiveReplyRunOwnerForSignal } from "../../sessions/session-controller.state.js";
import { captureAgentJobSession, setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { registerChatAbortController, resolveChatRunExpiresAtMs } from "../chat-abort.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX, type DedupeEntry } from "../server-shared.js";
import {
  buildAbortedChatSendPayload,
  readPreRegisteredRun,
  writePreRegisteredChatAbort,
} from "./chat-abort-authorization.js";
import { resolveChatSendOriginatingRoute } from "./chat-origin-routing.js";
import {
  isRetryableUnadoptedChatClaim,
  resolveRestartSafeChatAdmission,
  withRestartSafeChatPlacement,
  type PreparedRestartSafeChatPlacement,
} from "./chat-restart-recovery.js";
import { assertExpectedLeafActive } from "./chat-send-active-leaf.js";
import { prepareGoalChatSendRetry } from "./chat-send-goal-retry.js";
import {
  consumeChatSendCurrent,
  resolveChatSendRequestConflict,
  respondChatSendAdmissionError,
  respondChatSessionRoutingChanged,
} from "./chat-send-pre-admission.js";
import type { ChatSendPreAdmissionParams } from "./chat-send-pre-admission.types.js";
import { inspectGoalChatSendRetry, readChatSendDedupeResponse } from "./chat-send-reservation.js";
import { bindChatSendPreparedSession } from "./chat-send-session-binding.js";
import { captureAdmittedChatSendSessionSettings } from "./chat-send-session-settings.js";
import { withCurrentChatSendSession, prepareChatSendSessionEntry } from "./chat-send-session.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import {
  admitChatSendUploads,
  assertChatSendExclusiveAdmission,
  consumeChatSendAdmissionRetry,
  createChatSendWorkAdmission,
  observeChatSendWork,
  prepareChatSendAdmissionRetry,
  prepareChatSendInterruptAdmission,
  releaseChatSendCallerAuthority,
  respondChatSendWorkAdmissionFailure,
  withCurrentChatSendRetry,
} from "./chat-send-work-admission.js";
import type { GatewayRequestHandlerOptions, SessionMutationAuthorization } from "./types.js";

/** Reserve the session lifecycle and register the abortable run before attachment work. */
export async function admitChatSend(
  params: ChatSendPreAdmissionParams & {
    session: PreparedChatSendSession;
    withPreparedCurrent?: SessionMutationAuthorization["withPreparedCurrent"];
    hasCurrentClientAuthority?: GatewayRequestHandlerOptions["hasCurrentClientAuthority"];
    onAdmissionOwned?: () => Promise<boolean>;
  },
) {
  params.assertCurrent?.();
  const { request, session, respond, context, client } = params;
  const { p, explicitOrigin, normalizedAttachments, turnKind } = request;
  const requestIdentity = request.goalOperation?.requestFingerprint ?? request.requestIdentity;
  const progressRefresh = isProgressCardRefreshInputProvenance(request.systemInputProvenance);
  const {
    rawSessionKey,
    clientRunId,
    pendingChatSendKey,
    cfg,
    storePath,
    entry,
    sessionKey,
    selectedAgent,
    requestedSessionId,
    backingSessionId,
    agentId,
    resolvedSessionModel,
    resolvedSessionAuthProvider,
    activeRunScopeKey,
    timeoutMs,
    now,
    restartSafeRequest,
    expectedLeafEntryId,
  } = session;
  const assertSessionTargetCurrent = session.assertSessionTargetCurrent;
  const chatSendTraceAttributes = {
    runId: clientRunId,
    sessionKey,
    agentId: selectedAgent.agentId ?? agentId,
    provider: resolvedSessionModel.provider,
    model: resolvedSessionModel.model,
    hasAttachments: normalizedAttachments.length > 0,
    hasExplicitOrigin: explicitOrigin !== undefined,
    hasConnectedClient: client?.connect !== undefined,
  };
  const originatingRoute = resolveChatSendOriginatingRoute({
    client: request.clientInfo,
    deliver: p.deliver,
    entry,
    explicitOrigin,
    hasConnectedClient: client?.connect !== undefined,
    mainKey: cfg.session?.mainKey,
    sessionKey,
  });
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const pendingAttemptId = randomUUID();
  const readPendingReservation = () =>
    readPreRegisteredRun({
      key: pendingChatSendKey,
      entry: context.dedupe.get(pendingChatSendKey),
      keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
    });
  const clearPendingChatSendReservation = () => {
    const pending = readPendingReservation();
    if (
      pending?.runId === clientRunId &&
      normalizeOptionalString(pending.payload.attemptId) === pendingAttemptId
    ) {
      context.dedupe.delete(pendingChatSendKey);
    }
  };
  const abortPendingChatSend = (stopReason: string) =>
    writePreRegisteredChatAbort({
      context,
      runId: clientRunId,
      stopReason,
      attemptId: pendingAttemptId,
      requestIdentity,
    });
  const preparedGoalRetry = request.goalOperation
    ? await prepareGoalChatSendRetry(params)
    : undefined;
  const pendingRetry = prepareChatSendAdmissionRetry(params);
  const preparedRetry = pendingRetry instanceof Promise ? await pendingRetry : pendingRetry;
  const reserved = await consumeChatSendCurrent(params, () => {
    params.assertCurrent?.();
    assertSessionTargetCurrent();
    const goalRetry = inspectGoalChatSendRetry({ ...params, prepared: preparedGoalRetry });
    if (goalRetry.kind !== "new") {
      if (goalRetry.kind === "replay") {
        respond(true, { ...goalRetry.receipt, replayed: true }, undefined, {
          cached: true,
          runId: clientRunId,
        });
      }
      return undefined;
    }
    const retryComparison = consumeChatSendAdmissionRetry(params, preparedRetry);
    if (retryComparison === false) {
      return undefined;
    }
    const uploadAdmission = admitChatSendUploads({ params: p, client, context, respond });
    if (!uploadAdmission.ok) {
      return undefined;
    }
    // Keep the run abortable while lifecycle mutation owns the session. Admission
    // must reject an expired/missing reservation instead of reviving evicted work.
    context.dedupe.set(pendingChatSendKey, {
      ts: now,
      ok: true,
      requestIdentity,
      payload: {
        runId: clientRunId,
        attemptId: pendingAttemptId,
        status: "accepted" as const,
        sessionKey,
        ...(backingSessionId ? { sessionId: backingSessionId } : {}),
        ...(rawSessionKey === sessionKey ? {} : { sessionKeyAliases: [rawSessionKey] }),
        ...(selectedAgent.agentId ? { agentId: selectedAgent.agentId } : {}),
        ownerConnId: normalizeOptionalString(client?.connId),
        ownerDeviceId: normalizeOptionalString(client?.connect?.device?.id),
        expiresAtMs: resolveChatRunExpiresAtMs({ now, timeoutMs }),
        turnKind,
        ...(request.goalOperation
          ? { goalFingerprint: request.goalOperation.requestFingerprint }
          : {}),
      },
    });
    return { retryComparison, uploadAdmission };
  }).catch((error: unknown) => {
    clearPendingChatSendReservation();
    throw error;
  });
  if (!reserved) {
    return { ok: false as const };
  }
  let retryComparison = reserved.retryComparison;
  const uploadAdmission = reserved.uploadAdmission;
  let admittedSessionId = backingSessionId ?? clientRunId;
  let expectedActiveReplyOperation: ReplyOperation | undefined;
  let gatewayWorkAdmission: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
  let restartSafeAdmission: ReturnType<typeof resolveRestartSafeChatAdmission>;
  let initialSessionEntry: SessionEntry | undefined;
  let admittedSessionEntry: SessionEntry | undefined;
  let admittedSessionSettings: ReturnType<typeof captureAdmittedChatSendSessionSettings>;
  let assertInitialSkillSelection: (() => void) | undefined;
  let messageInjectionTarget: ReplyMessageInjectionTarget | undefined;
  let reservationSuperseded = false;
  let supersedingResult: DedupeEntry | undefined;
  let assertSourceAuthority: (() => void) | undefined = params.assertCurrent;
  let preparedGoalEntry: Awaited<ReturnType<typeof prepareChatSendSessionEntry>> | undefined;
  const admittedRunAbort = registerChatAbortController({
    target: captureSessionTarget({
      storeScope: storePath,
      sessionKey,
      aliases: [rawSessionKey, session.sessionTarget.storeKey],
      agentId,
      incarnation: backingSessionId,
    }),
    policy: resolveQueueSettings({
      cfg,
      channel: originatingRoute.originatingChannel,
      sessionEntry: entry,
      inlineMode: p.queueMode,
    }),
    authority: { assertCurrent: () => assertSourceAuthority?.() },
    runId: clientRunId,
    sessionId: admittedSessionId,
    sessionKey,
    agentId: selectedAgent.agentId,
    timeoutMs,
    now,
    ownerConnId: normalizeOptionalString(client?.connId),
    ownerDeviceId: normalizeOptionalString(client?.connect?.device?.id),
    providerId: resolvedSessionModel.provider,
    authProviderId: resolvedSessionAuthProvider,
    resolveTerminalProducer: (active) =>
      resolveActiveReplyRunOwnerForSignal(active.input.abortSignal),
    kind: "chat-send",
    turnKind,
    ...(progressRefresh ? { controlUiVisible: false, projectSessionActive: false } : {}),
    lifecycleGeneration,
  });
  const runInterruptTarget =
    admittedRunAbort.entry?.input.policy.mode === "interrupt"
      ? captureCurrentSessionRunInterruptTarget(admittedRunAbort.entry.input.mailbox.owner.id)
      : undefined;
  const placementService = context.workerSessionPlacementService;
  const commitChatWorkAdmission = async (
    acpMeta: SessionEntry["acp"] | null,
    preparedPlacement?: PreparedRestartSafeChatPlacement,
  ): Promise<void> => {
    if (context.workerSessionPlacementService !== placementService) {
      throw new Error("Worker placement owner changed during chat admission; retry.");
    }
    if (placementService && preparedPlacement?.sessionId !== admittedSessionId) {
      return withRestartSafeChatPlacement(placementService, admittedSessionId, (prepared) =>
        commitChatWorkAdmission(acpMeta, prepared),
      );
    }
    if (
      request.goalOperation?.action === "start" &&
      !entry &&
      !requestedSessionId &&
      !preparedGoalEntry
    ) {
      preparedGoalEntry = await prepareChatSendSessionEntry({
        cfg: session.cfg,
        client,
        agentId,
        getRuntimeConfig: context.getRuntimeConfig,
      });
    }
    let refreshPlacement = false;
    await withCurrentChatSendRetry(params, pendingAttemptId, (latestSession, comparison) => {
      retryComparison = comparison;
      params.assertCurrent?.();
      const retainedRequestConflict = resolveChatSendRequestConflict(
        { ...params, session: { ...session, entry: latestSession.entry } },
        retryComparison,
        pendingAttemptId,
      );
      if (retainedRequestConflict) {
        throw new Error(retainedRequestConflict.message);
      }
      if (context.chatRunState.hasAbortMarker(clientRunId)) {
        return;
      }
      const pendingReservation = readPendingReservation();
      if (
        pendingReservation &&
        normalizeOptionalString(pendingReservation.payload.attemptId) !== pendingAttemptId
      ) {
        reservationSuperseded = true;
        return;
      }
      if (!pendingReservation) {
        const terminalResult = readChatSendDedupeResponse(context.dedupe, clientRunId);
        const registeredSource = getRpcSource(clientRunId);
        if (terminalResult || (registeredSource && registeredSource !== admittedRunAbort.entry)) {
          reservationSuperseded = true;
          supersedingResult = terminalResult;
          return;
        }
      }
      if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
        if (admittedRunAbort.entry) {
          admittedRunAbort.entry.adapter.abortStopReason = "restart";
        }
        admittedRunAbort.controller.abort(createAgentRunRestartAbortError());
        abortPendingChatSend("restart");
        return;
      }
      if (
        !pendingReservation ||
        !isFutureDateTimestampMs(pendingReservation.payload.expiresAtMs, { nowMs: Date.now() })
      ) {
        if (admittedRunAbort.entry) {
          admittedRunAbort.entry.adapter.abortStopReason = "timeout";
        }
        admittedRunAbort.controller.abort();
        abortPendingChatSend("timeout");
        return;
      }
      const latestEntry = latestSession.entry;
      admittedSessionEntry = latestEntry;
      const requestConflict = resolveChatSendRequestConflict(
        { ...params, session: { ...session, entry: latestEntry } },
        retryComparison,
        pendingAttemptId,
      );
      if (requestConflict) {
        throw new Error(requestConflict.message);
      }
      admittedSessionSettings = captureAdmittedChatSendSessionSettings({
        commit: true,
        entry: latestEntry,
        expectedPermissionMode: p.expectedPermissionMode,
        expectedToolOverrides: p.expectedToolOverrides,
      });
      assertChatSendExclusiveAdmission(request, session);
      if (entry && !latestEntry) {
        throw new Error(`Session "${sessionKey}" was deleted while starting work. Retry.`);
      }
      messageInjectionTarget =
        p.queueMode === "steer"
          ? captureCurrentReplyMessageInjectionTarget(
              admittedRunAbort.entry?.input.mailbox.owner.id ?? activeRunScopeKey,
            )
          : undefined;
      if (p.queueMode !== "steer" && expectedLeafEntryId !== undefined) {
        assertExpectedLeafActive(latestSession, agentId, expectedLeafEntryId, requestedSessionId, {
          allowEmptyAncestor: true,
        });
      }
      if (
        backingSessionId &&
        latestEntry?.sessionId &&
        latestEntry.sessionId !== backingSessionId
      ) {
        throw new Error(`Session "${sessionKey}" changed while starting work. Retry.`);
      }
      const retryableClaim = isRetryableUnadoptedChatClaim(latestEntry, clientRunId);
      if (
        (latestEntry?.restartRecoveryDeliveryRunId &&
          latestEntry.restartRecoveryDeliverySourceRunId === clientRunId &&
          !retryableClaim) ||
        hasRestartRecoveryTerminalRun(latestEntry, clientRunId)
      ) {
        reservationSuperseded = true;
        supersedingResult = {
          ts: Date.now(),
          ok: true,
          payload: { runId: clientRunId, status: "ok" as const },
        };
        return;
      }
      const archivedError = resolveSessionWorkStartError(sessionKey, latestEntry, {
        allowPendingWorkspace: true,
        providerReviewAcknowledgment: request.providerReviewAcknowledgment,
        runId: clientRunId,
      });
      if (archivedError) {
        throw new Error(archivedError);
      }
      admittedSessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
      expectedActiveReplyOperation = admittedRunAbort.entry?.input.mailbox.owner.active;
      if (request.goalOperation?.action === "start" && !latestEntry && !requestedSessionId) {
        const prepared = preparedGoalEntry!;
        initialSessionEntry = prepared.entry;
        assertInitialSkillSelection = prepared.assertSkillSelection;
        admittedSessionId = initialSessionEntry.sessionId;
      }
      if (context.workerSessionPlacementService !== placementService) {
        throw new Error("Worker placement owner changed during chat admission; retry.");
      }
      if (placementService && preparedPlacement?.sessionId !== admittedSessionId) {
        refreshPlacement = true;
        return;
      }
      preparedPlacement?.facts.assertCurrent();
      restartSafeAdmission = resolveRestartSafeChatAdmission({
        activeRunScopeKey,
        agentId,
        cfg: latestSession.cfg,
        clientRunId,
        context,
        entry: latestEntry,
        initialSessionEntry,
        acpMeta,
        now: Date.now(),
        placement: preparedPlacement?.facts.placement,
        request: restartSafeRequest,
        requestedSessionId,
        sessionId: admittedSessionId,
        sessionKey: latestSession.canonicalKey,
        storePath: latestSession.storePath,
      });
      if (request.goalOperation && !restartSafeAdmission) {
        throw new Error(
          "Goal start or resume requires the built-in OpenClaw runtime and an idle local session with recoverable history. This action is unavailable for native Codex and other external runtimes.",
        );
      }
      if (retryableClaim && !restartSafeAdmission) {
        throw new Error("chat retry does not match its durable admission");
      }
    });
    if (refreshPlacement) {
      return commitChatWorkAdmission(acpMeta);
    }
  };

  let capturedOperator: Awaited<ReturnType<typeof prepareChatSendInterruptAdmission>>["operator"];
  let releaseCapturedOperator = () => {};
  let interruptedActiveRun: boolean;
  let retainedRequestConflict: ReturnType<typeof resolveChatSendRequestConflict>;
  try {
    const preparedInterrupt = await prepareChatSendInterruptAdmission({
      operator: { ...params, runId: clientRunId },
      interruptTarget: runInterruptTarget,
      entry: admittedRunAbort.entry,
      assertCurrent: params.assertCurrent,
      assertSessionTargetCurrent,
      abortSignal: admittedRunAbort.controller.signal,
    });
    capturedOperator = preparedInterrupt.operator;
    releaseCapturedOperator = capturedOperator.release;
    interruptedActiveRun = preparedInterrupt.interruptedActiveRun;
    gatewayWorkAdmission = await beginSessionEffect({
      sourceInput: admittedRunAbort.entry?.input,
      target: captureSessionTarget({
        storeScope: storePath,
        sessionKey,
        aliases: [rawSessionKey, session.sessionTarget.storeKey],
        agentId,
        incarnation: backingSessionId,
      }),
      storeWriterIdentities: [sessionKey, session.sessionTarget.storeKey],
      assertAllowed: () => {
        params.assertCurrent?.();
        assertSessionTargetCurrent();
        assertChatSendExclusiveAdmission(request, session);
      },
      revalidateAllowed: async () => {
        if (!restartSafeRequest) {
          return commitChatWorkAdmission(null);
        }
        const latest = await withCurrentChatSendSession({
          session,
          getRuntimeConfig: context.getRuntimeConfig,
          includeMembership: false,
          consume: (current) => current,
        });
        const [acpMeta] = await readAcpSessionMetaForEntries({
          cfg: latest.cfg,
          entries: [{ agentId, sessionKey: latest.canonicalKey, entry: latest.entry }],
        });
        return commitChatWorkAdmission(acpMeta ?? null);
      },
      onInterrupt: (reason) => {
        const stopReason = isAgentRunDirectAbortReason(reason) ? "rpc" : "restart";
        if (!admittedRunAbort) {
          if (!context.chatRunState.hasAbortMarker(clientRunId)) {
            abortPendingChatSend(stopReason);
          }
        } else if (!admittedRunAbort.controller.signal.aborted) {
          // A later lifecycle drain must not overwrite the first abort reason.
          if (admittedRunAbort.entry) {
            admittedRunAbort.entry.adapter.abortStopReason = stopReason;
          }
          admittedRunAbort.controller.abort(
            stopReason === "rpc" ? reason : createAgentRunRestartAbortError(),
          );
        }
      },
    });
    if (
      admittedRunAbort.controller.signal.aborted &&
      !readChatSendDedupeResponse(context.dedupe, clientRunId)
    ) {
      abortPendingChatSend(admittedRunAbort.entry?.adapter.abortStopReason ?? "rpc");
    }
    admittedRunAbort.controller.signal.throwIfAborted();
    params.assertCurrent?.();
    retainedRequestConflict = await consumeChatSendCurrent(params, () =>
      resolveChatSendRequestConflict(params, retryComparison, pendingAttemptId),
    );
  } catch (err) {
    const pendingReservationAtFailure = readPendingReservation();
    clearPendingChatSendReservation();
    admittedRunAbort?.cleanup();
    gatewayWorkAdmission?.release();
    releaseCapturedOperator();
    respondChatSendWorkAdmissionFailure(
      params,
      err,
      {
        attemptId: pendingAttemptId,
        lifecycleGeneration,
        pendingReservation: pendingReservationAtFailure,
        requestIdentity,
        runAbort: admittedRunAbort,
      },
      retryComparison,
    );
    return { ok: false as const };
  }
  if (retainedRequestConflict) {
    clearPendingChatSendReservation();
    admittedRunAbort?.cleanup();
    gatewayWorkAdmission.release();
    capturedOperator.release();
    respond(false, undefined, retainedRequestConflict);
    return { ok: false as const };
  }
  if (
    admittedRunAbort?.registered &&
    !reservationSuperseded &&
    !readChatSendDedupeResponse(context.dedupe, clientRunId)
  ) {
    // Transfer immutable input identity before retiring the pending reservation.
    // It survives transient pre-ACK failures without inventing a successful response.
    context.dedupe.set(`chat:${clientRunId}`, {
      ts: Date.now(),
      ok: true,
      requestIdentity,
    });
  }
  clearPendingChatSendReservation();
  const releaseAdmissionOwners = () => {
    gatewayWorkAdmission.release();
    capturedOperator.release();
  };
  if (reservationSuperseded) {
    admittedRunAbort.cleanup();
    releaseAdmissionOwners();
    const supersedingCached =
      supersedingResult ?? readChatSendDedupeResponse(context.dedupe, clientRunId);
    if (supersedingCached) {
      respond(supersedingCached.ok, supersedingCached.payload, supersedingCached.error, {
        cached: true,
        runId: clientRunId,
      });
      return { ok: false as const };
    }
    respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
      cached: true,
      runId: clientRunId,
    });
    return { ok: false as const };
  }
  if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
    if (admittedRunAbort) {
      if (admittedRunAbort.entry) {
        admittedRunAbort.entry.adapter.abortStopReason = "restart";
      }
      admittedRunAbort.controller.abort();
      admittedRunAbort.cleanup();
    }
    releaseAdmissionOwners();
    if (!readChatSendDedupeResponse(context.dedupe, clientRunId)) {
      abortPendingChatSend(admittedRunAbort?.entry?.adapter.abortStopReason ?? "restart");
    }
    const aborted = readChatSendDedupeResponse(context.dedupe, clientRunId);
    respond(aborted?.ok ?? true, aborted?.payload, aborted?.error, {
      cached: true,
      runId: clientRunId,
    });
    return { ok: false as const };
  }
  if (!admittedRunAbort) {
    releaseAdmissionOwners();
    const aborted = readChatSendDedupeResponse(context.dedupe, clientRunId);
    if (aborted) {
      respond(aborted.ok, aborted.payload, aborted.error, {
        cached: true,
        runId: clientRunId,
      });
      return { ok: false as const };
    }
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "chat run admission failed"));
    return { ok: false as const };
  }
  if (!admittedRunAbort.registered) {
    releaseAdmissionOwners();
    respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
      cached: true,
      runId: clientRunId,
    });
    return { ok: false as const };
  }
  let releaseGatewayRootContinuation = () => {};
  let releaseCallerAuthority: (() => void) | undefined;
  // Until dispatch takes custody, interruption and callback failures release every admission hold.
  const cleanupPreDispatchAdmission = () => {
    try {
      admittedRunAbort.cleanup();
      gatewayWorkAdmission.release();
      releaseGatewayRootContinuation();
    } finally {
      releaseCallerAuthority?.();
      releaseCallerAuthority = undefined;
    }
  };
  let startedWork: (() => Promise<unknown>) | undefined;
  const startOwnedWork = <T>(work: Promise<T>) => {
    const observed = observeChatSendWork(work);
    startedWork = observed;
    return observed;
  };
  try {
    releaseCallerAuthority = () =>
      releaseChatSendCallerAuthority({ operator: capturedOperator, request, session });
    assertSourceAuthority = () => {
      capturedOperator.authority?.assertCurrent();
      assertSessionTargetCurrent();
      if (!gatewayWorkAdmission?.isActive()) {
        throw new Error("Chat source preparation custody ended");
      }
    };
    try {
      assertSessionTargetCurrent();
    } catch (error) {
      cleanupPreDispatchAdmission();
      respondChatSendAdmissionError(error, respond);
      return { ok: false as const };
    }
    const pending = await consumeChatSendCurrent(params, () => {
      admittedRunAbort.controller.signal.throwIfAborted();
      // Reserve while the request root is live: detached dispatch retains it until terminal persistence.
      releaseGatewayRootContinuation = retainGatewayRootWorkAdmissionContinuation() ?? (() => {});
      return {
        admission: params.onAdmissionOwned
          ? startOwnedWork(gatewayWorkAdmission.run(params.onAdmissionOwned))
          : undefined,
      };
    });
    if (pending.admission) {
      if (!(await pending.admission())) {
        cleanupPreDispatchAdmission();
        return { ok: false as const };
      }
      await consumeChatSendCurrent(params, () => true);
    }
    try {
      assertSessionTargetCurrent();
    } catch (error) {
      cleanupPreDispatchAdmission();
      respondChatSendAdmissionError(error, respond);
      return { ok: false as const };
    }
  } catch (error) {
    if (startedWork) {
      await Promise.allSettled([startedWork()]);
    }
    cleanupPreDispatchAdmission();
    throw error;
  }

  const acquiredGatewayWorkAdmission = gatewayWorkAdmission;
  const sourceRef = admittedRunAbort.entry;
  let sessionPreparationActive = true;
  const onSessionPrepared = bindChatSendPreparedSession({
    clientRunId,
    sessionKey,
    sourceRef,
    lifecycleGeneration,
    admission: {
      isActive: () => sessionPreparationActive && acquiredGatewayWorkAdmission.isActive(),
    },
    progressRefresh,
  });
  const retainedWork = createChatSendWorkAdmission({
    admission: acquiredGatewayWorkAdmission,
    releaseCallerAuthority,
    releaseGatewayRootContinuation,
    logGateway: context.logGateway,
  });
  // Prepared inbound media has no transcript reference until the user turn
  // persists; every abandonment exit funnels through cleanupAdmittedRun, so
  // the armed discard here is the single custody owner for that window. The
  // handler disarms it once the media becomes referenced (durable admission
  // or ACK handing ownership to dispatch, which persists on all paths).
  let discardAbandonedPreparedMedia: (() => void) | undefined;
  const cleanupAdmittedRun: typeof admittedRunAbort.cleanup = () => {
    sessionPreparationActive = false;
    admittedRunAbort.cleanup();
    retainedWork.release();
    discardAbandonedPreparedMedia?.();
    discardAbandonedPreparedMedia = undefined;
  };
  const rejectSessionRoutingChanged = () => {
    cleanupAdmittedRun();
    clearAgentRunContext(clientRunId, lifecycleGeneration);
    respondChatSessionRoutingChanged(respond);
  };
  const finishAbortedChatSend = () => {
    const stopReason = admittedRunAbort.entry?.adapter.abortStopReason ?? "rpc";
    const endedAt = Date.now();
    const payload = buildAbortedChatSendPayload({ runId: clientRunId, stopReason, endedAt });
    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: `chat:${clientRunId}`,
      session: captureAgentJobSession({ ...getRpcSourceIdentity(sourceRef), lifecycleGeneration }),
      entry: { ts: endedAt, ok: true, payload },
    });
    cleanupAdmittedRun();
    clearAgentRunContext(clientRunId, lifecycleGeneration);
    respond(true, payload, undefined, { runId: clientRunId });
  };
  claimAgentRunContext(clientRunId, {
    agentId: selectedAgent.agentId ?? agentId,
    sessionKey,
    sessionId: admittedSessionId,
    lifecycleGeneration,
    ...progressCardRefreshRunProjection(request.systemInputProvenance),
  });

  return {
    ok: true as const,
    value: {
      activeRunAbort: admittedRunAbort,
      operatorAuthority: capturedOperator.authority,
      armOperatorRunCancellation: capturedOperator.armCancellation,
      retireOperatorRunCancellation: capturedOperator.retireCancellation,
      admittedSessionSettings,
      admittedSessionId,
      ...(expectedActiveReplyOperation ? { expectedActiveReplyOperation } : {}),
      sourceRef,
      onSessionPrepared,
      initialSessionEntry,
      admittedSessionEntry,
      chatSendTraceAttributes,
      assertInitialSkillSelection,
      assertSessionTargetCurrent,
      cleanupAdmittedRun,
      finishAbortedChatSend,
      gatewayWorkAdmission,
      lifecycleGeneration,
      interruptedActiveRun,
      messageInjectionTarget,
      originatingRoute,
      rejectSessionRoutingChanged,
      releaseSourceWorkAdmission: retainedWork.release,
      retainGatewayWorkAdmission: retainedWork.retain,
      setPendingInputCleanup: retainedWork.setPendingInputCleanup,
      assertClientUploadAllowed: uploadAdmission.assertClientUploadAllowed,
      assertWorkAdmissionCurrent: () => {
        const queued = getRpcSource(clientRunId);
        // Collect retires source cancellation while retaining the original
        // admission until the aggregate commits or settles.
        if (
          !retainedWork.isActive() ||
          !acquiredGatewayWorkAdmission.isActive() ||
          lifecycleGeneration !== getAgentEventLifecycleGeneration() ||
          (admittedRunAbort.controller.signal.aborted &&
            !(queued === sourceRef && queued.input.custody.cancellationRetired))
        ) {
          throw new Error("Chat admission ended or was cancelled; submit a new turn.");
        }
      },
      restartSafeAdmission,
      setDiscardAbandonedPreparedMedia: (discard: (() => void) | undefined) => {
        discardAbandonedPreparedMedia = discard;
      },
    },
  };
}

type ChatSendAdmissionResult = Awaited<ReturnType<typeof admitChatSend>>;
export type AdmittedChatSend = Extract<ChatSendAdmissionResult, { ok: true }>["value"];

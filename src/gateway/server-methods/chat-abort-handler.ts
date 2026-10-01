import type { Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateChatAbortParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { discardSessionPendingInput } from "../../config/sessions/session-pending-input-withdrawal.js";
import { isIncognitoSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import { holdSessionControllerSourceWithdrawal } from "../../sessions/session-controller.mailbox.js";
import {
  isRpcSourceQueued,
  isRpcSourceQueuedForSession,
  type RpcSourceAdapter,
} from "../../sessions/session-controller.rpc-sources.js";
import {
  captureSessionControllerStop,
  stopSessionController,
} from "../../sessions/session-controller.stop.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { resolveStateContentionPresentation } from "../../sessions/session-run-error-presentation.js";
import {
  waitForChatAbortAcknowledgment,
  waitForChatAbortTerminalPersistence,
} from "../chat-abort-lifecycle-internal.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { abortChatRunById, captureChatRunAbortPresentation } from "../chat-abort.js";
import { chatRunBelongsToAgent } from "../chat-run-owner.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import {
  resolveRequestedSessionAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import { loadSessionEntry, resolveSessionStoreKey } from "../session-utils.js";
import { resolveWorkerInferenceTarget } from "../worker-environments/inference-control-internal.js";
import {
  canRequesterAbortChatRun,
  canRequesterAbortPreRegisteredRun,
  readPreRegisteredAgentDedupePayloadForSession,
  resolveChatAbortRequester,
  writePreRegisteredAgentAbort,
  writePreRegisteredChatAbort,
} from "./chat-abort-authorization.js";
import {
  abortChatRunsForSessionKeyWithPartials,
  captureWorkerInferenceForSession,
  abortControlledSubagents,
  descendantAbortError,
} from "./chat-abort-runtime.js";
import {
  abortedPartialPersistenceError,
  captureAbortedPartial,
  deferAbortedPartialPersistence,
  withAbortedPartialPersistenceWarning,
} from "./chat-aborted-partial.js";
import { persistAbortedPartials } from "./chat-transcript-persistence.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";
import { assertValidParams } from "./validation.js";

type ChatAbortLifecycle = {
  onAuthorizedAfterQueuedAbort?: () => boolean;
  onDescendantsCancelled?: () => void;
  cascadeDescendants?: true;
};

type ChatAbortTarget = Pick<
  RpcSourceAdapter,
  "sessionKey" | "sessionId" | "agentId" | "ownerConnId" | "ownerDeviceId"
>;

export async function handleChatAbortRequestWithLifecycle(
  options: GatewayRequestHandlerOptions,
  lifecycle: ChatAbortLifecycle = {},
): Promise<void> {
  const { params, respond, context, client, sessionMutationAuthorization } = options;
  const authority = readGatewayRequestMutationAuthority(options);
  const requester = resolveChatAbortRequester(client, sessionMutationAuthorization);
  const assertCurrent = () => {
    authority.assertCurrent();
    sessionMutationAuthorization?.assertCurrent();
    requester.sessionAuthority?.assertCurrent();
  };
  if (!assertValidParams(params, validateChatAbortParams, "chat.abort", respond)) {
    return;
  }
  const { sessionKey: rawSessionKey, runId, preserveSideRuns, discardPendingInput } = params;
  if (discardPendingInput && !runId) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "discardPendingInput requires an exact runId"),
    );
    return;
  }
  const agentIdOverride = normalizeOptionalString(params.agentId);
  const abortCfg = context.getRuntimeConfig();
  const parsedAbortSessionKey = parseAgentSessionKey(rawSessionKey);
  const compatibilityDefaultAgentId = tryResolveSessionCompatibilityOwnerAgentId(
    abortCfg,
    rawSessionKey,
  );
  const inferredSessionAgentId =
    !agentIdOverride && parsedAbortSessionKey
      ? normalizeAgentId(parsedAbortSessionKey.agentId)
      : undefined;
  const bareSessionAgentResolution = !parsedAbortSessionKey
    ? resolveRequestedSessionAgentId(abortCfg, rawSessionKey, agentIdOverride)
    : undefined;
  if (bareSessionAgentResolution && !bareSessionAgentResolution.ok) {
    respond(false, undefined, bareSessionAgentResolution.error);
    return;
  }
  const abortAgentId = parsedAbortSessionKey
    ? (agentIdOverride ?? inferredSessionAgentId)
    : bareSessionAgentResolution?.agentId;
  if (!abortAgentId) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        rawSessionKey.trim().toLowerCase() === "global"
          ? "agentId is required for global chat.abort when no compatibility owner exists"
          : "agentId is required for unscoped chat.abort when no compatibility owner exists",
      ),
    );
    return;
  }
  if (
    agentIdOverride &&
    parsedAbortSessionKey &&
    normalizeAgentId(parsedAbortSessionKey.agentId) !== normalizeAgentId(agentIdOverride)
  ) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `agentId "${agentIdOverride}" does not match session key "${rawSessionKey}"`,
      ),
    );
    return;
  }
  const canonicalAbortSessionKey = resolveSessionStoreKey({
    cfg: abortCfg,
    sessionKey: rawSessionKey,
    storeAgentId: abortAgentId,
  });
  if (discardPendingInput && isIncognitoSessionKey(canonicalAbortSessionKey)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Removing accepted queued input is unavailable in incognito sessions. Use Stop to cancel it.",
      ),
    );
    return;
  }
  const narrow =
    authority.sessionScope === "operator.sessions.write" ||
    requester.sessionAuthority !== undefined;
  const admittedTarget = sessionMutationAuthorization?.admittedTarget;
  if (
    narrow &&
    (!admittedTarget?.sessionId.trim() ||
      admittedTarget.sessionKey !== canonicalAbortSessionKey ||
      admittedTarget.agentId !== normalizeAgentId(abortAgentId))
  ) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "session target is unavailable"),
    );
    return;
  }
  const requiredSessionId = narrow ? admittedTarget?.sessionId : undefined;
  const ops = createChatAbortOps(context);

  const abortSession: Result<ReturnType<typeof loadSessionEntry>, unknown> = (() => {
    try {
      return {
        ok: true,
        value: loadSessionEntry(canonicalAbortSessionKey, { agentId: abortAgentId }),
      };
    } catch (error) {
      return { ok: false, error };
    }
  })();
  const abortSessionEntry = abortSession.ok ? abortSession.value.entry : undefined;
  if (!runId) {
    const res = await abortChatRunsForSessionKeyWithPartials({
      context,
      ops,
      sessionKey: canonicalAbortSessionKey,
      sessionKeyAliases: canonicalAbortSessionKey === rawSessionKey ? undefined : [rawSessionKey],
      agentId: abortAgentId,
      sessionId: abortSessionEntry?.sessionId,
      requiredSessionId,
      session: abortSession,
      defaultAgentId: compatibilityDefaultAgentId,
      abortOrigin: "rpc",
      stopReason: "rpc",
      requester,
      assertCurrent,
      preserveSideRuns,
      onAuthorizedAfterQueuedAbort: lifecycle.onAuthorizedAfterQueuedAbort,
      cascadeDescendants: lifecycle.cascadeDescendants,
    });
    if (res.unauthorized) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return;
    }
    if (res.descendants?.killed) {
      lifecycle.onDescendantsCancelled?.();
    }
    const error = res.error ?? descendantAbortError(res.descendants, "Session");
    if (error) {
      respond(false, undefined, withAbortedPartialPersistenceWarning(error, res.warning));
      return;
    }
    respond(true, {
      ok: true,
      aborted: res.aborted,
      runIds: res.runIds,
      ...(res.warning ? { warning: res.warning } : {}),
    });
    return;
  }
  const normalizedAgentIdOverride = normalizeAgentId(abortAgentId);
  const authorizeRunTarget = (target: ChatAbortTarget): boolean => {
    if (
      discardPendingInput &&
      target.sessionKey !== rawSessionKey &&
      target.sessionKey !== canonicalAbortSessionKey
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "discarded input runId does not match sessionKey"),
      );
      return false;
    }
    if (narrow && target.sessionId !== requiredSessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match session incarnation"),
      );
      return false;
    }
    if (
      target.sessionKey !== rawSessionKey &&
      target.sessionKey !== canonicalAbortSessionKey &&
      (narrow || !canRequesterAbortChatRun(target, requester, { requireOwnerMatch: true }))
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
      );
      return false;
    }
    if (
      !chatRunBelongsToAgent(
        {
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          defaultAgentId: compatibilityDefaultAgentId,
        },
        normalizedAgentIdOverride,
      )
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match agentId"),
      );
      return false;
    }
    if (!canRequesterAbortChatRun(target, requester)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return false;
    }
    return true;
  };

  // Capture the exact input once; an await must never select a successor by run ID.
  const active = context.rpcSources.get(runId);
  const workerTarget = resolveWorkerInferenceTarget(context.workerEnvironmentService, runId);
  const workerCancellation = captureWorkerInferenceForSession({
    context,
    sessionId: active?.adapter.sessionId ?? workerTarget?.sessionId ?? abortSessionEntry?.sessionId,
    runId,
  });
  let inputWithdrawn = false;
  if (discardPendingInput) {
    if (active && !authorizeRunTarget(active.adapter)) {
      return;
    }
    if (
      !active ||
      !isRpcSourceQueued(active) ||
      active.input.phase === "injecting" ||
      active.input.claim ||
      active.input.retirementRequested
    ) {
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
    const withdrawalScope = {
      sessionKey: active.adapter.sessionKey,
      sessionId: active.adapter.sessionId,
      agentId: active.adapter.agentId,
    };
    const captured = {
      agentId: active.adapter.agentId ?? abortAgentId,
      sessionKey: active.adapter.sessionKey,
      sessionId: active.adapter.sessionId,
    };
    const hold = holdSessionControllerSourceWithdrawal(active.input);
    try {
      if (!abortSession.ok) {
        throw abortSession.error;
      }
      inputWithdrawn = await discardSessionPendingInput(
        { ...captured, storePath: abortSession.value.storePath },
        runId,
        () => {
          assertCurrent();
          if (
            context.rpcSources.get(runId) !== active ||
            !isRpcSourceQueuedForSession(context.rpcSources, runId, withdrawalScope)
          ) {
            throw new Error("Run changed before input removal; refresh and retry.");
          }
        },
      );
      if (inputWithdrawn) {
        // This capability was acquired before SQLite yielded. A committed discard
        // must finish cancellation even if its requester was revoked after commit.
        active.adapter.abortStopReason = "rpc";
        hold.commit("rpc");
        emitSessionsChanged(
          context,
          { ...captured, reason: "agent.input.settled" },
          { accessChanged: false },
        );
      }
    } finally {
      hold();
    }
    respond(true, { ok: true, aborted: inputWithdrawn, runIds: inputWithdrawn ? [runId] : [] });
    return;
  }
  const respondWithWorkerRuns = async (localRunIds: string[], warning?: string): Promise<void> => {
    const runIds = new Set(localRunIds);
    if (requester.isAdmin) {
      assertCurrent();
      await workerCancellation?.cancel({ assertCurrent, onCancelled: (id) => runIds.add(id) });
    }
    if (!abortSession.ok) {
      throw abortSession.error;
    }
    respond(true, {
      ok: true,
      aborted: runIds.size > 0,
      runIds: [...runIds],
      ...(warning ? { warning } : {}),
    });
  };
  if (!active) {
    const readPendingRunForAbort = (
      entry: GatewayRequestContext["dedupe"] extends Map<string, infer T> ? T | undefined : never,
    ) => {
      for (const sessionKey of new Set([canonicalAbortSessionKey, rawSessionKey])) {
        const payload = readPreRegisteredAgentDedupePayloadForSession({
          entry,
          runId,
          sessionKey,
          agentId: abortAgentId,
          defaultAgentId: compatibilityDefaultAgentId,
          includeHidden: true,
          requiredSessionId,
        });
        if (payload) {
          return {
            sessionKey: normalizeOptionalString(payload.sessionKey) ? sessionKey : undefined,
            payload,
          };
        }
      }
      return undefined;
    };
    const pendingChatMatch =
      !discardPendingInput &&
      readPendingRunForAbort(context.dedupe.get(pendingChatSendDedupeKey(runId)));
    if (pendingChatMatch) {
      if (!canRequesterAbortPreRegisteredRun(pendingChatMatch.payload, requester)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      assertCurrent();
      const aborted = writePreRegisteredChatAbort({
        context,
        runId,
        stopReason: "rpc",
        attemptId: normalizeOptionalString(pendingChatMatch.payload.attemptId),
        expectedPayload: pendingChatMatch.payload,
      });
      await respondWithWorkerRuns(aborted ? [runId] : []);
      return;
    }
    const pendingAgentEntry = context.dedupe.get(`agent:${runId}`);
    const pendingAgentMatch = !discardPendingInput && readPendingRunForAbort(pendingAgentEntry);
    if (pendingAgentMatch) {
      const pendingAgentPayload = pendingAgentMatch.payload;
      if (!canRequesterAbortPreRegisteredRun(pendingAgentPayload, requester)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      let aborted = false;
      const descendants = await abortControlledSubagents({
        cfg: abortCfg,
        sessionKey: pendingAgentMatch.sessionKey ?? canonicalAbortSessionKey,
        agentId: abortAgentId,
        requesterTurnRunId: runId,
        assertCurrent,
        beforeKill: () => {
          assertCurrent();
          return (aborted = writePreRegisteredAgentAbort({
            context,
            runId,
            sessionKey: pendingAgentMatch.sessionKey,
            payload: pendingAgentPayload,
            expectedPayload: pendingAgentPayload,
            stopReason: "rpc",
          }));
        },
      });
      const error = descendantAbortError(descendants, "Parent run");
      if (error) {
        respond(false, undefined, error);
        return;
      }
      await respondWithWorkerRuns(aborted ? [runId] : []);
      return;
    }
    if (!workerCancellation?.runIds.length) {
      if (!abortSession.ok) {
        throw abortSession.error;
      }
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
    if (!requester.isAdmin) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return;
    }
    await respondWithWorkerRuns([]);
    return;
  }
  if (!authorizeRunTarget(active.adapter)) {
    return;
  }
  let aborted = false;
  const stopCapture = captureSessionControllerStop({ inputs: [active.input] });
  const presentation = captureChatRunAbortPresentation(ops, runId);
  const { sessionKey, sessionId, agentId, controlUiVisible } = active.adapter;
  {
    assertCurrent();
    const partialText = context.chatRunState.resolveBuffer(runId, { final: true }).text;
    const snapshot =
      controlUiVisible !== false && partialText?.trim()
        ? captureAbortedPartial({
            runId,
            sessionKey,
            sessionId,
            agentId: agentId ?? abortAgentId,
            text: partialText,
            abortOrigin: "rpc",
            resolveTerminalProducer: active.adapter.resolveTerminalProducer,
            ...(sessionKey === rawSessionKey || sessionKey === canonicalAbortSessionKey
              ? { session: abortSession }
              : {}),
          })
        : undefined;
    let descendants: Awaited<ReturnType<typeof abortControlledSubagents>>;
    let failure: { error: unknown } | undefined;
    let warning: string | undefined;
    try {
      descendants = await abortControlledSubagents({
        cfg: abortCfg,
        sessionKey,
        agentId,
        requesterTurnRunId: runId,
        assertCurrent,
        beforeKill: () => {
          // The descendant owner can await a reservation even when no child survives.
          assertCurrent();
          if (
            context.rpcSources.get(runId) !== active ||
            active.adapter.sessionKey !== sessionKey ||
            active.adapter.sessionId !== sessionId ||
            active.adapter.agentId !== agentId
          ) {
            throw new Error("Run changed before cancellation; retry Stop.");
          }
          const stopped = stopSessionController(stopCapture, {
            source: "gateway",
            assertCurrent,
            reason: "rpc",
            onCancelled: (target) => {
              if (target === active.input) {
                aborted = true;
              }
            },
            cancelInput: (_input, cancel) =>
              abortChatRunById(ops, {
                runId,
                sessionKey,
                expectedEntry: active,
                presentation,
                cancel,
                assertCurrent,
                stopReason: "rpc",
                onAbortPrepared: () => deferAbortedPartialPersistence(snapshot, context),
                onAbortCommitted: () => {
                  aborted = true;
                },
              }).aborted,
          });
          return stopped.abortedInputs.length > 0;
        },
      });
    } catch (error) {
      failure = { error };
    }
    // A later child fence can reject after the parent consumed its buffer. The
    // transcript owner must still settle that already-committed cancellation.
    if (aborted) {
      const settled = await waitForChatAbortAcknowledgment(
        Promise.allSettled([
          snapshot ? persistAbortedPartials({ context, snapshots: [snapshot] }) : undefined,
          waitForChatAbortTerminalPersistence(active),
          // A native hook can await this acknowledgment before its producer returns.
          // An accepted handoff retains that producer and transcript work independently.
          snapshot?.ok && snapshot.settlement.deferred ? undefined : stopCapture.settled,
        ]),
      );
      warning = settled[0].status === "fulfilled" ? settled[0].value : undefined;
      const errors = settled.flatMap((item) => (item.status === "rejected" ? [item.reason] : []));
      if (errors.length) {
        if (failure) {
          errors.unshift(failure.error);
        }
        throw abortedPartialPersistenceError(
          errors.length === 1
            ? errors[0]
            : new AggregateError(errors, "Chat cancellation and persistence failed"),
          warning,
        );
      }
    }
    if (failure) {
      throw abortedPartialPersistenceError(failure.error, warning);
    }
    if (!abortSession.ok) {
      throw abortedPartialPersistenceError(abortSession.error, warning);
    }
    const descendantError = descendantAbortError(descendants, "Parent run");
    if (descendantError) {
      respond(false, undefined, withAbortedPartialPersistenceWarning(descendantError, warning));
      return;
    }
    try {
      await respondWithWorkerRuns(aborted ? [runId] : [], warning);
    } catch (error) {
      throw abortedPartialPersistenceError(error, warning);
    }
  }
}

export async function handleChatAbortRequest(options: GatewayRequestHandlerOptions): Promise<void> {
  try {
    await handleChatAbortRequestWithLifecycle(options);
  } catch (error) {
    const contention = resolveStateContentionPresentation(error);
    if (!contention) {
      throw error;
    }
    // A session read can fail even though cancellation takes effect. Do not
    // replay Stop or claim it had no effect; preserve uncertainty at the RPC boundary.
    options.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "The server is busy. Check this turn's status before trying Stop again.\n\n" +
          "SQLite transaction admission remained busy. Stopping may already have taken effect.",
        { details: { errorKind: contention.errorKind } },
      ),
    );
  }
}

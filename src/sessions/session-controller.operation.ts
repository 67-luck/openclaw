import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError as createSupersededError,
  isAgentRunRestartAbortReason,
  isAgentRunSupersededAbortReason,
} from "../agents/run-termination.js";
import type { ReplyFollowupAdmissionBarrierTimeoutPolicy } from "../auto-reply/reply/reply-dispatcher.types.js";
import type * as replyRunSettle from "../auto-reply/reply/reply-run-finalization-lease.js";
import { createAbortError } from "../infra/abort-signal.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { markDiagnosticRunProgress } from "../logging/diagnostic-run-activity.js";
import { diagnosticLogger as diag } from "../logging/diagnostic-runtime.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  initialReplyOperationState,
  transitionReplyOperation,
  type ReplyOperationEvent,
} from "./reply-operation-state.js";
import type { ReplyBackendCancelReason, ReplyOperation } from "./session-controller.contracts.js";
import {
  releaseSessionControllerOperation,
  retainSessionControllerOperation,
  bindSessionControllerTarget,
  captureSessionTarget,
} from "./session-controller.lifecycle.js";
import {
  prepareReplyOperationAdmission,
  type CreateReplyOperationParams,
} from "./session-controller.operation-admission.js";
import { bindReplyOperationUpstreamAbort } from "./session-controller.operation-upstream.js";
import {
  clearReplyRunState,
  evictReplyOperationByOperation,
  flushReplyOperationAfterClear,
  getAttachedBackend,
  isReplyOperationAbortable,
  notifyReplyRunEnded,
  operationsByUpstreamAbortSignal,
  producerCompletionByOperation,
  prepareReplyRunKeyUpdate,
  registerFollowupAdmissionBarrier,
  getSessionControllerEntry,
  controllerEntryByOperation,
  resolveReplyOperationAgentId,
  runAfterReplyOperationClear,
  startReplyOperationSuccessorBarriers,
  updateFollowupAdmissionSessionId,
  updateSuccessorAdmissionSessionId,
} from "./session-controller.state.js";
import { captureSessionControllerStop, stopSession } from "./session-controller.stop.js";
import { createReplyOperationToolAuthority } from "./session-controller.tool-authority.js";
import {
  createSessionControllerWatchdog,
  type SessionWatchdogEffect,
  type SessionWatchdogWait,
} from "./session-controller.watchdog.js";

type ReplyOperationResult = NonNullable<ReplyOperation["result"]>;
type ReplyOperationAbortCode = Extract<ReplyOperationResult, { kind: "aborted" }>["code"];

export function createReplyOperation(params: CreateReplyOperationParams): ReplyOperation {
  const admitted = prepareReplyOperationAdmission(params);
  const { sessionKey, sessionId } = admitted;
  let owner = admitted.owner;
  const controller = new AbortController();
  // Mutable so updateSessionKey can move the run slot (command-turn continuation
  // adoption); every closure below must read this, never params.sessionKey.
  let currentSessionKey = sessionKey;
  let currentSessionId = sessionId;
  let currentAgentId = resolveReplyOperationAgentId(sessionKey, params.agentId);
  let state = initialReplyOperationState();
  let staleExpiryReason: replyRunSettle.ReplyOperationStaleReason | undefined;
  let terminalRecovery = false;
  let acceptedSteeredInboundAudio = false;
  const toolAuthority = createReplyOperationToolAuthority({
    isOpen: () => state.result === null,
    ownsRunSlot: () => owner.active === operation,
  });
  const ownerSettlement = createDeferredCore();
  const producerCompletion = createDeferredCore();
  let ownerCompletionBarrier: Promise<void> | undefined;
  let ownerSettled = false;
  let installed = false;
  let cleanupPreservesOutcome = false;
  const executionCleanups = new Set<() => Promise<void>>();
  let phaseWait: SessionWatchdogWait | undefined;
  const finishOwner = () => {
    if (ownerSettled) {
      return;
    }
    ownerSettled = true;
    watchdog.close();
    ownerSettlement.resolve(undefined);
    releaseSessionControllerOperation(operation);
  };
  const settleOwner = (): void => {
    const pending = ownerCompletionBarrier;
    if (!pending) {
      finishOwner();
      return;
    }
    void pending.then(() => {
      if (pending !== ownerCompletionBarrier) {
        settleOwner();
        return;
      }
      finishOwner();
    });
  };
  const startedAtMs = Date.now();
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  let lastActivityAtMs = startedAtMs;
  const upstreamAbortSignal = params.upstreamAbortSignal;
  let upstreamAbortHandler: (() => void) | undefined;
  const detachUpstreamAbort = () => {
    if (!upstreamAbortHandler) {
      return;
    }
    upstreamAbortSignal?.removeEventListener("abort", upstreamAbortHandler);
    upstreamAbortHandler = undefined;
  };
  const ownedSessionIds = new Set([sessionId]);
  const recordActivity = () => {
    lastActivityAtMs = Date.now();
    watchdog.progress("transport");
  };

  const markProgress = (reason: string) => {
    // Phase observations must not renew the semantic-stall deadline.
    watchdog.progress("transport", reason);
    markDiagnosticRunProgress({
      sessionId: currentSessionId,
      sessionKey: currentSessionKey,
      reason,
    });
  };

  const apply = (event: ReplyOperationEvent) => {
    const transition = transitionReplyOperation(state, event);
    state = transition.state;
    for (const effect of transition.effects) {
      if (effect === "activity") {
        recordActivity();
      } else {
        const reasons = {
          "maintenance-wait": "deferred_maintenance:waiting",
          "maintenance-ready": "deferred_maintenance:wait_ended",
          "lane-wait": "global_lane:waiting",
          "lane-ready": "global_lane:wait_ended",
        };
        phaseWait?.close();
        phaseWait = undefined;
        if (effect === "maintenance-wait" || effect === "lane-wait") {
          const phase = state.phase;
          phaseWait = watchdog.beginWait({
            kind: effect === "maintenance-wait" ? "deferred_maintenance" : "global_capacity",
            isCurrent: () => owner.active === operation && !state.result && state.phase === phase,
          });
        } else {
          watchdog.progress("semantic", reasons[effect]);
        }
        markProgress(reasons[effect]);
      }
    }
  };
  const setResult = (result: ReplyOperationResult) => {
    apply({ type: "result", result });
    toolAuthority.close();
    phaseWait?.close();
    watchdog.beginTerminal();
  };

  const clearState = (
    afterClearBarrier?: PromiseLike<unknown>,
    followupAdmissionBarrierTimeout?: number | ReplyFollowupAdmissionBarrierTimeoutPolicy,
  ) => {
    if (state.cleared) {
      return;
    }
    apply({ type: "clear" });
    toolAuthority.close();
    phaseWait?.close();
    evictReplyOperationByOperation.delete(operation);
    detachUpstreamAbort();
    const registeredBarrier = afterClearBarrier
      ? registerFollowupAdmissionBarrier(
          operation,
          afterClearBarrier,
          followupAdmissionBarrierTimeout,
        )
      : undefined;
    updateFollowupAdmissionSessionId(operation);
    // Recovery-owner handoff must begin before the old slot wakes a successor;
    // otherwise that successor can snapshot durable state the handoff then mutates.
    startReplyOperationSuccessorBarriers(operation);
    markProgress("reply_operation:ended");
    clearReplyRunState({
      sessionKey: currentSessionKey,
      sessionId: currentSessionId,
      operation,
    });
    if (!registeredBarrier) {
      flushReplyOperationAfterClear(operation, currentSessionId);
      return;
    }
    void registeredBarrier.settled.then(() =>
      flushReplyOperationAfterClear(operation, registeredBarrier.source.sessionId),
    );
  };

  const abortInternally = (reason?: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  const scheduleTerminalSettle = () => watchdog.beginTerminal();

  const expireOwner = async (
    effect: SessionWatchdogEffect,
    cleanup: boolean,
  ): Promise<"settled" | "blocked"> => {
    if (!effect.isCurrent()) {
      return ownerSettled ? "settled" : "blocked";
    }
    const backend = getAttachedBackend(operation);
    const cleanups = [...executionCleanups];
    if (!effect.isCurrent()) {
      return ownerSettled ? "settled" : "blocked";
    }
    const failures: unknown[] = [];
    try {
      if (cleanup) {
        // Committed output cannot be replaced by ordinary Stop. Only this
        // captured retained owner may retire its remaining native resources.
        cleanupPreservesOutcome ||= state.abortFrozen && !state.result;
        detachUpstreamAbort();
        backend?.cancel("superseded");
      } else {
        stopSession({
          capture: captureSessionControllerStop({ operations: [operation] }),
          source: "watchdog",
          assertCurrent: () => {
            if (!effect.isCurrent()) {
              throw new Error("Watchdog owner retired before Stop");
            }
          },
        });
      }
    } catch (error) {
      failures.push(error);
    }
    for (const cleanupOwner of cleanups) {
      // Stopping may close the captured attempt synchronously. That does not
      // revoke custody of the exact placement cleanup already captured above.
      if (ownerSettled) {
        break;
      }
      try {
        await cleanupOwner();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Watchdog cleanup remains blocked");
    }
    return ownerSettled ? "settled" : "blocked";
  };
  const watchdog = createSessionControllerWatchdog({
    startedAtMs,
    // Exact raw custody survives rekey, index eviction and lifecycle rotation.
    // Never rediscover the owner through a slot that may already hold a successor.
    isCurrent: () => installed && !ownerSettled,
    readPhase: () =>
      ownerSettled
        ? "settled"
        : state.result
          ? "terminal"
          : state.abortFrozen
            ? "finishing"
            : "active",
    requestStop: (effect) => expireOwner(effect, false),
    expireCleanup: (effect) => expireOwner(effect, true),
    onWarning: (decision) =>
      diag.warn(
        `reply watchdog: sessionKey=${currentSessionKey} action=${decision.action} reason=${decision.reason}`,
      ),
  });

  const abortOperation = (
    reason: ReplyBackendCancelReason,
    abortReason: unknown,
    abortedCode: ReplyOperationAbortCode,
  ) => {
    const backend = getAttachedBackend(operation);
    if (!state.result) {
      setResult({ kind: "aborted", code: abortedCode });
      detachUpstreamAbort();
    }
    abortInternally(abortReason);
    // Cancellation may throw. Only actual producer completion releases custody.
    try {
      backend?.cancel(reason);
    } finally {
      scheduleTerminalSettle();
    }
  };

  const operation: ReplyOperation = {
    get key() {
      return currentSessionKey;
    },
    get sessionId() {
      return currentSessionId;
    },
    get agentId() {
      return currentAgentId;
    },
    turnKind: params.turnKind ?? "visible",
    lifecycleGeneration,
    get routeThreadId() {
      return params.routeThreadId;
    },
    get originatingLeafEntryId() {
      return params.originatingLeafEntryId;
    },
    abortSignal: controller.signal,
    watchdog,
    get resetTriggered() {
      return params.resetTriggered;
    },
    get terminalRecovery() {
      return terminalRecovery;
    },
    get acceptedSteeredInboundAudio() {
      return acceptedSteeredInboundAudio;
    },
    get toolAuthorityFingerprint() {
      return toolAuthority.toolAuthorityFingerprint;
    },
    get personalToolParticipants() {
      return toolAuthority.personalToolParticipants;
    },
    get toolAuthorityRoute() {
      return toolAuthority.toolAuthorityRoute;
    },
    get requestedToolAuthorityRoute() {
      return toolAuthority.requestedToolAuthorityRoute;
    },
    get automaticFallbackRoute() {
      return toolAuthority.automaticFallbackRoute;
    },
    setAutomaticFallbackRoute: toolAuthority.setAutomaticFallbackRoute,
    get phase() {
      return state.phase;
    },
    get result() {
      return state.result;
    },
    get abortFrozen() {
      return state.abortFrozen;
    },
    registerExecutionCleanup(cleanup) {
      if (ownerSettled) {
        throw new Error("Operation already settled");
      }
      executionCleanups.add(cleanup);
      return () => {
        executionCleanups.delete(cleanup);
      };
    },
    get staleExpiryReason() {
      return staleExpiryReason;
    },
    get startedAtMs() {
      return startedAtMs;
    },
    get lastActivityAtMs() {
      return lastActivityAtMs;
    },
    hasOwnedSessionId(candidateSessionId) {
      const normalizedSessionId = normalizeOptionalString(candidateSessionId);
      return normalizedSessionId ? ownedSessionIds.has(normalizedSessionId) : false;
    },
    captureOwnedSessionIds() {
      return new Set(ownedSessionIds);
    },
    recordActivity() {
      recordActivity();
    },
    setPhase(phase) {
      apply({ type: "phase", phase });
    },
    markWaitingForDeferredMaintenance() {
      apply({ type: "maintenance-wait" });
    },
    markDeferredMaintenanceWaitEnded() {
      apply({ type: "maintenance-ready" });
    },
    markWaitingForGlobalLane() {
      apply({ type: "lane-wait" });
    },
    markGlobalLaneWaitEnded() {
      apply({ type: "lane-ready" });
    },
    markTerminalRecovery() {
      terminalRecovery = true;
    },
    markAcceptedSteeredInboundAudio() {
      acceptedSteeredInboundAudio = true;
    },
    bindToolAuthoritySnapshot: toolAuthority.bindToolAuthoritySnapshot,
    projectToolAuthorityFingerprint: toolAuthority.projectToolAuthorityFingerprint,
    bindToolAuthorityRoute: toolAuthority.bindToolAuthorityRoute,
    updateSessionId(nextSessionId) {
      if (state.result) {
        return;
      }
      const normalizedNextSessionId = normalizeOptionalString(nextSessionId);
      if (!normalizedNextSessionId || normalizedNextSessionId === currentSessionId) {
        return;
      }
      recordActivity();
      currentSessionId = normalizedNextSessionId;
      ownedSessionIds.add(currentSessionId);
      owner.aliases.add(currentSessionId);
      if (owner.target) {
        bindSessionControllerTarget(
          operation,
          captureSessionTarget({
            ...owner.target,
            aliases: [...owner.logicalAliases],
            incarnation: currentSessionId,
          }),
        );
      }
      updateFollowupAdmissionSessionId(operation);
      updateSuccessorAdmissionSessionId(operation, currentSessionId);
      markProgress("reply_operation:session_updated");
    },
    updateSessionKey(nextSessionKey, agentId, mailboxClaim) {
      const update = prepareReplyRunKeyUpdate(
        operation,
        nextSessionKey,
        agentId,
        state.cleared,
        mailboxClaim,
      );
      if (!update) {
        return;
      }
      recordActivity();
      currentAgentId = update.agentId;
      if (update.sessionKey === currentSessionKey) {
        return;
      }
      const previousOwner = owner;
      const capturedTarget = mailboxClaim?.mailbox.owner.target ?? owner.target;
      const target = capturedTarget
        ? captureSessionTarget({
            ...capturedTarget,
            sessionKey: update.sessionKey,
            aliases: mailboxClaim ? capturedTarget.aliases : [update.sessionKey],
            // Moving a command must select the destination logical identity, not
            // merge the source incarnation into a separately admitted target.
            incarnation: mailboxClaim ? capturedTarget.incarnation : undefined,
          })
        : undefined;
      const nextOwner =
        mailboxClaim?.mailbox.owner ?? getSessionControllerEntry(update.sessionKey, target);
      if (nextOwner !== owner) {
        previousOwner.active = undefined;
      }
      currentSessionKey = update.sessionKey;
      owner = nextOwner;
      owner.active = operation;
      owner.aliases.add(currentSessionId);
      controllerEntryByOperation.set(operation, owner);
      if (mailboxClaim) {
        mailboxClaim.operation = operation;
      }
      if (target) {
        bindSessionControllerTarget(operation, target);
      }
      if (previousOwner !== owner) {
        notifyReplyRunEnded(previousOwner);
      }
      markProgress("reply_operation:session_key_adopted");
    },
    attachBackend(handle) {
      if (state.result || state.cleared || owner.active !== operation) {
        handle.cancel(
          state.result?.kind === "aborted"
            ? state.result.code === "aborted_for_restart"
              ? "restart"
              : state.result.code === "aborted_for_supersession"
                ? "superseded"
                : "user_abort"
            : "superseded",
        );
        return;
      }
      recordActivity();
      toolAuthority.bindBackendFingerprint(handle.toolAuthorityFingerprint);
      owner.attachment = {
        operation,
        backend: handle,
        projectSessionActive:
          owner.attachment?.operation === operation
            ? owner.attachment.projectSessionActive
            : undefined,
      };
      if (controller.signal.aborted) {
        handle.cancel("superseded");
      }
    },
    detachBackend(handle) {
      if (owner.active === operation && owner.attachment?.backend === handle) {
        owner.attachment.backend = undefined;
        if (
          !("handle" in owner.attachment) &&
          owner.attachment.projectSessionActive === undefined
        ) {
          owner.attachment = undefined;
        }
      }
    },
    freezeAbort() {
      apply({ type: "freeze" });
      detachUpstreamAbort();
      watchdog.beginFinalization();
    },
    ownerSettlement: ownerSettlement.promise,
    complete() {
      producerCompletion.resolve();
      if (!state.result) {
        setResult({ kind: "completed" });
      }
      clearState();
      settleOwner();
    },
    completeThen(afterClear) {
      runAfterReplyOperationClear(operation, afterClear);
      operation.complete();
    },
    completeWithAfterClearBarrier(barrier, timeoutMs) {
      // Producer work is done; delivery may still need a successor operation.
      producerCompletion.resolve();
      // Admission may time out to free a slot; the old writer settles only when
      // its actual delivery/persistence barrier finishes, including repeated complete().
      const completed = Promise.resolve(barrier).then(
        () => {},
        () => {},
      );
      ownerCompletionBarrier = ownerCompletionBarrier
        ? Promise.all([ownerCompletionBarrier, completed]).then(() => {})
        : completed;
      if (!state.result) {
        setResult({ kind: "completed" });
      }
      clearState(barrier, timeoutMs);
      // This barrier owns dispatch delivery and terminal persistence. Slot
      // release never substitutes for this owner's actual durable settlement.
      settleOwner();
    },
    fail(code, cause) {
      if (cleanupPreservesOutcome && !state.result) {
        return;
      }
      apply({ type: "freeze" });
      detachUpstreamAbort();
      watchdog.beginTerminal();
      if (!state.result) {
        setResult({ kind: "failed", code, cause });
      }
      scheduleTerminalSettle();
    },
    abort(reason) {
      if (!isReplyOperationAbortable(operation)) {
        return false;
      }
      const restart = isAgentRunRestartAbortReason(reason);
      const superseded = isAgentRunSupersededAbortReason(reason);
      abortOperation(
        restart ? "restart" : superseded ? "superseded" : "user_abort",
        reason ?? createAbortError("Reply operation aborted by user"),
        restart
          ? "aborted_for_restart"
          : superseded
            ? "aborted_for_supersession"
            : "aborted_by_user",
      );
      return true;
    },
    abortByUser() {
      if (!isReplyOperationAbortable(operation)) {
        return false;
      }
      abortOperation(
        "user_abort",
        createAbortError("Reply operation aborted by user"),
        "aborted_by_user",
      );
      return true;
    },
    abortForRestart() {
      if (!isReplyOperationAbortable(operation)) {
        return false;
      }
      abortOperation("restart", createAgentRunRestartAbortError(), "aborted_for_restart");
      return true;
    },
    abortForStall() {
      if (!isReplyOperationAbortable(operation)) {
        return false;
      }
      const backend = getAttachedBackend(operation);
      staleExpiryReason ??= "no_activity";
      apply({ type: "freeze" });
      setResult({ kind: "failed", code: "run_stalled" });
      detachUpstreamAbort();
      abortInternally(createAbortError("Reply operation stalled"));
      try {
        backend?.cancel("superseded");
      } finally {
        scheduleTerminalSettle();
      }
      return true;
    },
    supersede(beforeSupersede) {
      const abortFrozen = state.abortFrozen;
      if (
        state.result ||
        cleanupPreservesOutcome ||
        state.cleared ||
        (!abortFrozen && !isReplyOperationAbortable(operation))
      ) {
        return false;
      }
      beforeSupersede?.();
      if (abortFrozen) {
        setResult({ kind: "aborted", code: "aborted_for_supersession" });
        scheduleTerminalSettle();
        return true;
      }
      abortOperation("superseded", createSupersededError(), "aborted_for_supersession");
      return true;
    },
  };

  producerCompletionByOperation.set(operation, producerCompletion.promise);
  operationsByUpstreamAbortSignal.set(operation.abortSignal, operation);
  evictReplyOperationByOperation.set(operation, () => {
    if (state.cleared) {
      return;
    }
    if (!state.result) {
      setResult({ kind: "aborted", code: "aborted_for_restart" });
    }
    abortInternally(createAgentRunRestartAbortError());
    try {
      getAttachedBackend(operation)?.cancel("restart");
    } catch (error) {
      diag.warn(
        `reply run lifecycle eviction cancel failed: sessionKey=${currentSessionKey} error=${String(error)}`,
      );
      throw error;
    } finally {
      watchdog.beginTerminal();
    }
  });

  bindGatewayContextResolver(
    operation,
    params.mailboxClaim
      ? getGatewayContextResolver(params.mailboxClaim)
      : getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext,
  );
  owner.active = operation;
  owner.aliases.add(sessionId);
  controllerEntryByOperation.set(operation, owner);
  retainSessionControllerOperation(operation);
  if (owner.target) {
    bindSessionControllerTarget(operation, owner.target);
  }
  if (params.mailboxClaim) {
    params.mailboxClaim.operation = operation;
  }
  installed = true;
  watchdog.start();
  markProgress("reply_operation:queued");
  if (upstreamAbortSignal) {
    operationsByUpstreamAbortSignal.set(upstreamAbortSignal, operation);
    upstreamAbortHandler = bindReplyOperationUpstreamAbort(
      operation,
      upstreamAbortSignal,
      abortOperation,
    );
  }

  return operation;
}

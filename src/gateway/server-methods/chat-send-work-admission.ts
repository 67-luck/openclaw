import { isDeepStrictEqual } from "node:util";
import { hasPendingFollowupQueueWork } from "../../auto-reply/reply/queue/state.js";
import type { SessionTranscriptTurnMutation } from "../../config/sessions/goals-operations.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { retireProviderReviewAcknowledgment } from "../../sessions/provider-review.js";
import type { ReplyRunInterruptTarget } from "../../sessions/session-controller.contracts.js";
import {
  interruptReplyRunTarget,
  isSessionRunActiveForKey,
} from "../../sessions/session-controller.js";
import {
  isCompetingSessionControllerWorkActive,
  type SessionEffectRef,
} from "../../sessions/session-controller.lifecycle.js";
import type { RpcSourceRef } from "../../sessions/session-controller.rpc-sources.js";
import type { registerChatAbortController } from "../chat-abort.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import { retainGatewayOperatorRun } from "../operator-run-cancellation.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { captureGatewayClientUploadCommitGuard } from "../upload-policy.js";
import { formatForLog } from "../ws-log.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

/** New input is checked only after the chat owner has reconciled prior receipts. */
export function admitChatSendUploads({
  params,
  client,
  context,
  respond,
}: Pick<GatewayRequestHandlerOptions, "params" | "client" | "context" | "respond">) {
  const assertClientUploadAllowed = captureGatewayClientUploadCommitGuard({
    method: "chat.send",
    requestParams: params,
    client,
    context,
  });
  try {
    assertClientUploadAllowed?.();
  } catch (error) {
    if (!(error instanceof SessionMutationAuthorizationChangedError)) {
      throw error;
    }
    respond(false, undefined, error.error);
    return { ok: false as const };
  }
  return { ok: true as const, assertClientUploadAllowed };
}

/** Caller and physical target custody end together when admitted work settles. */
export function releaseChatSendCallerAuthority(params: {
  operator: { release?: () => void };
  request: Pick<NormalizedChatSendRequest, "providerReviewAcknowledgment">;
  session: Pick<PreparedChatSendSession, "releaseSessionTarget">;
}): void {
  try {
    params.operator.release?.();
  } finally {
    try {
      if (params.request.providerReviewAcknowledgment) {
        retireProviderReviewAcknowledgment(params.request.providerReviewAcknowledgment);
      }
    } finally {
      params.session.releaseSessionTarget();
    }
  }
}

/** Retain the caller before an interrupt can change session state. */
export async function prepareChatSendInterruptAdmission(params: {
  operator: Parameters<typeof retainGatewayOperatorRun>[0];
  interruptTarget?: ReplyRunInterruptTarget;
  entry?: RpcSourceRef;
  assertCurrent?: () => void;
  assertSessionTargetCurrent: () => void;
  abortSignal: AbortSignal;
}) {
  const operator = await retainGatewayOperatorRun({ ...params.operator, entry: params.entry });
  try {
    params.assertCurrent?.();
    params.abortSignal.throwIfAborted();
    operator.authority?.assertCurrent();
    if (!params.interruptTarget) {
      return { operator, interruptedActiveRun: false };
    }
    params.assertSessionTargetCurrent();
    const interruption = await interruptReplyRunTarget(params.interruptTarget, null);
    params.assertCurrent?.();
    operator.authority?.assertCurrent();
    params.assertSessionTargetCurrent();
    params.abortSignal.throwIfAborted();
    return { operator, interruptedActiveRun: interruption.aborted };
  } catch (error) {
    operator.release();
    throw error;
  }
}

/** Queued and collected turns share the original session and caller admission until settlement. */
export function createChatSendWorkAdmission(params: {
  admission: Pick<SessionEffectRef, "release">;
  releaseCallerAuthority?: () => void;
  releaseGatewayRootContinuation?: () => void;
  logGateway: Pick<GatewayRequestContext["logGateway"], "warn">;
}) {
  let references = 1;
  let finishPendingInput: (() => void | Promise<void>) | undefined;
  const releaseAdmission = () => {
    try {
      params.admission.release();
    } finally {
      try {
        params.releaseCallerAuthority?.();
      } finally {
        params.releaseGatewayRootContinuation?.();
      }
    }
  };
  const warnCleanupFailure = (error: unknown) => {
    params.logGateway.warn(`Failed to finish pending chat input: ${formatForLog(error)}`);
  };
  const release = () => {
    if (references === 0) {
      return;
    }
    references -= 1;
    if (references !== 0) {
      return;
    }
    let pending: void | Promise<void> = undefined;
    try {
      pending = finishPendingInput?.();
    } catch (error) {
      // The durable row remains recoverable; a failed disposition write must
      // not strand session/root drain ownership during shutdown.
      warnCleanupFailure(error);
    }
    if (pending) {
      // The existing admission's drain joins this write before releasing the
      // session/root fence; prompt custody has already been revoked.
      void pending.then(releaseAdmission, (error: unknown) => {
        warnCleanupFailure(error);
        releaseAdmission();
      });
    } else {
      releaseAdmission();
    }
  };
  const hold = () => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      release();
    };
  };
  return {
    isActive: () => references > 0,
    release: hold(),
    retain: () => {
      if (references === 0) {
        throw new Error("cannot retain a released chat work admission");
      }
      references += 1;
      return hold();
    },
    setPendingInputCleanup: (finish: () => void | Promise<void>) => {
      finishPendingInput = finish;
    },
  };
}

/** Rechecked inside the session writer barrier before exclusive input is admitted. */
export function assertChatSendExclusiveAdmission(
  request: NormalizedChatSendRequest,
  session: PreparedChatSendSession,
): void {
  if (!request.goalOperation && !request.providerReviewAcknowledgment) {
    return;
  }
  const { storePath, sessionKey, backingSessionId, activeRunScopeKey } = session;
  if (
    isCompetingSessionControllerWorkActive(storePath, [sessionKey, backingSessionId]) ||
    hasPendingFollowupQueueWork([sessionKey, backingSessionId, activeRunScopeKey]) ||
    isSessionRunActiveForKey(activeRunScopeKey)
  ) {
    throw new Error(
      request.providerReviewAcknowledgment
        ? "The session still has active work. Review its status before continuing."
        : "goal-session-busy",
    );
  }
}

/** Goal and initial-session policy are revalidated in the same input writer barrier. */
export function createChatSendGoalCommitGuard(
  params: Pick<
    GatewayRequestHandlerOptions,
    "client" | "context" | "sessionMutationAuthorization" | "sessionMutationCommitGuard"
  > & {
    admission: {
      initialSessionEntry?: SessionEntry;
      assertInitialSkillSelection?: () => void;
      activeRunAbort: Pick<ReturnType<typeof registerChatAbortController>, "controller">;
      lifecycleGeneration: ReturnType<typeof getAgentEventLifecycleGeneration>;
    };
    session: Pick<
      PreparedChatSendSession,
      | "agentId"
      | "sessionLoadKey"
      | "sessionLoadOptions"
      | "sessionKey"
      | "storePath"
      | "sessionRoutingChanged"
    >;
  },
): Pick<SessionTranscriptTurnMutation, "assertCurrent" | "routingPredicate"> & {
  assertCurrent: () => void;
} {
  const {
    admission,
    session,
    client,
    context,
    sessionMutationAuthorization,
    sessionMutationCommitGuard,
  } = params;
  const routingPredicate = admission.initialSessionEntry
    ? {
        config: structuredClone(context.getRuntimeConfig()),
        key: session.sessionLoadKey,
        agentId: session.sessionLoadOptions.agentId,
        storePath: session.storePath,
        canonicalKey: session.sessionKey,
      }
    : undefined;
  const assertCurrent = () => {
    sessionMutationCommitGuard?.();
    sessionMutationAuthorization?.assertCurrent();
    const currentConfig = context.getRuntimeConfig();
    const initialEntry = admission.initialSessionEntry;
    if (initialEntry) {
      admission.assertInitialSkillSelection?.();
      // The executor checks rows; live configuration and creator authority remain host-owned.
      if (!isDeepStrictEqual(currentConfig, routingPredicate?.config)) {
        throw new Error("Session routing changed before Goal admission; refresh and retry.");
      }
      const creationError = authorizeGatewaySessionCreation({
        cfg: currentConfig,
        client,
        agentId: session.agentId,
      });
      if (creationError) {
        throw new SessionMutationAuthorizationChangedError(creationError);
      }
      const creation = resolveOperatorSessionCreation(client);
      if (
        creation.actor?.id !== initialEntry.createdActor?.id ||
        resolveCreatorSandbox(currentConfig, creation) !== initialEntry.sandbox
      ) {
        throw new Error("Session creation policy changed before Goal admission; retry.");
      }
    }
    if (
      admission.activeRunAbort.controller.signal.aborted ||
      admission.lifecycleGeneration !== getAgentEventLifecycleGeneration() ||
      session.sessionRoutingChanged(currentConfig)
    ) {
      throw new Error("Goal admission changed before commit; refresh and retry.");
    }
  };
  return { assertCurrent, routingPredicate };
}

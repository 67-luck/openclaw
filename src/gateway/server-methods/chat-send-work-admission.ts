import { isAgentRunRestartAbortReason } from "../../agents/run-termination.js";
import { hasPendingFollowupQueueWork } from "../../auto-reply/reply/queue/state.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.js";
import { isSessionPendingInputSettlementUnknown } from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { retireProviderReviewAcknowledgment } from "../../sessions/provider-review.js";
import { isCompetingSessionWorkAdmissionActive } from "../../sessions/session-lifecycle-admission.js";
import type { registerChatAbortController } from "../chat-abort.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import type { retainGatewayOperatorRun } from "../operator-run-cancellation.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { loadSessionEntry } from "../session-utils.js";
import { captureGatewayClientUploadCommitGuard } from "../upload-policy.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { createChatSendWorkAdmission } from "./chat-send-work-lifetime.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

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

export function createChatSendCallerAuthorityRelease(
  capturedOperator: Pick<Awaited<ReturnType<typeof retainGatewayOperatorRun>>, "release">,
  request: Pick<NormalizedChatSendRequest, "providerReviewAcknowledgment">,
  session: Pick<PreparedChatSendSession, "closeSessionTarget">,
) {
  return async () => {
    const failures: unknown[] = [];
    for (const release of [
      () => capturedOperator.release?.(),
      () => {
        if (request.providerReviewAcknowledgment) {
          retireProviderReviewAcknowledgment(request.providerReviewAcknowledgment);
        }
      },
    ]) {
      try {
        release();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await session.closeSessionTarget();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Chat caller authority close failed");
    }
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
    isCompetingSessionWorkAdmissionActive(storePath, [sessionKey, backingSessionId]) ||
    hasPendingFollowupQueueWork([sessionKey, backingSessionId, activeRunScopeKey]) ||
    replyRunRegistry.isActive(activeRunScopeKey)
  ) {
    throw new Error(
      request.providerReviewAcknowledgment
        ? "The session still has active work. Review its status before continuing."
        : "goal-session-busy",
    );
  }
}

export function createChatSendPendingInputCleanup(params: {
  activeRunAbort: ReturnType<typeof registerChatAbortController>;
  finishPendingInput(
    this: void,
    disposition: "cancelled" | "interrupted",
  ): Promise<void> | undefined;
  discard(this: void): Promise<void>;
}) {
  const { activeRunAbort, finishPendingInput, discard } = params;
  return () => {
    try {
      const joined = finishPendingInput(
        activeRunAbort.controller.signal.aborted &&
          activeRunAbort.entry?.abortStopReason !== "restart" &&
          !isAgentRunRestartAbortReason(activeRunAbort.controller.signal.reason)
          ? "cancelled"
          : "interrupted",
      );
      if (joined) {
        return joined.then(discard, async (error: unknown) => {
          if (!isSessionPendingInputSettlementUnknown(error)) {
            await discard();
          }
          throw error;
        });
      }
      void discard();
      return undefined;
    } catch (error) {
      if (!isSessionPendingInputSettlementUnknown(error)) {
        void discard();
      }
      throw error;
    }
  };
}

export function createChatSendRunCleanup(params: {
  activeRunAbort: ReturnType<typeof registerChatAbortController>;
  retainedWork: ReturnType<typeof createChatSendWorkAdmission>;
  releaseGatewayRootContinuation(this: void): void;
}) {
  const { activeRunAbort, retainedWork, releaseGatewayRootContinuation } = params;
  // Prepared inbound media has no transcript reference until the user turn
  // persists; every abandonment exit funnels through cleanupAdmittedRun, so
  // the armed discard here is the single custody owner for that window. The
  // handler disarms it once the media becomes referenced (durable admission
  // or ACK handing ownership to dispatch, which persists on all paths).
  let discardAbandonedPreparedMedia: (() => void) | undefined;
  let cleanupSettlement: Promise<void> | undefined;
  let cleanupStarted = false;
  let cleanupFailure: { error: unknown } | undefined;
  const cleanupAdmittedRun = (): void | Promise<void> => {
    if (cleanupFailure) {
      throw cleanupFailure.error;
    }
    if (cleanupStarted) {
      return cleanupSettlement;
    }
    cleanupStarted = true;
    const release = () => {
      activeRunAbort.cleanup();
      releaseGatewayRootContinuation();
      discardAbandonedPreparedMedia?.();
      discardAbandonedPreparedMedia = undefined;
    };
    try {
      const joined = retainedWork.release();
      if (joined) {
        cleanupSettlement = joined.then(release);
        void cleanupSettlement.catch(() => {});
        return cleanupSettlement;
      }
      release();
    } catch (error) {
      cleanupFailure = { error };
      throw error;
    }
  };
  return {
    cleanupAdmittedRun,
    setDiscardAbandonedPreparedMedia: (discard: (() => void) | undefined) => {
      discardAbandonedPreparedMedia = discard;
    },
  };
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
): () => void {
  const {
    admission,
    session,
    client,
    context,
    sessionMutationAuthorization,
    sessionMutationCommitGuard,
  } = params;
  return () => {
    sessionMutationCommitGuard?.();
    sessionMutationAuthorization?.assertCurrent();
    const currentConfig = context.getRuntimeConfig();
    const initialEntry = admission.initialSessionEntry;
    if (initialEntry) {
      admission.assertInitialSkillSelection?.();
      // Missing targets have no sharing owner yet; revalidate their creator before SQL commit.
      const currentTarget = loadSessionEntry(session.sessionLoadKey, session.sessionLoadOptions);
      if (
        currentTarget.storePath !== session.storePath ||
        currentTarget.canonicalKey !== session.sessionKey
      ) {
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
}

import { isAgentRunRestartAbortReason } from "../../agents/run-termination.js";
import { hasPendingFollowupQueueWork } from "../../auto-reply/reply/queue/state.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.js";
import { isSessionPendingInputSettlementUnknown } from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { retireProviderReviewAcknowledgment } from "../../sessions/provider-review.js";
import {
  isCompetingSessionWorkAdmissionActive,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import type { registerChatAbortController } from "../chat-abort.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import type { retainGatewayOperatorRun } from "../operator-run-cancellation.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { loadSessionEntry } from "../session-utils.js";
import { captureGatewayClientUploadCommitGuard } from "../upload-policy.js";
import { formatForLog } from "../ws-log.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
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

const inputLifetimeIssuer = Symbol("chatInputLifetimeIssuer");

class ChatSendInputLifetime {
  readonly #assert: (allowAborted: boolean) => void;

  constructor(issuer: symbol, assert: (allowAborted: boolean) => void) {
    if (issuer !== inputLifetimeIssuer) {
      throw new Error("Chat input lifetime requires its original admission owner");
    }
    this.#assert = assert;
    Object.freeze(this);
  }

  static assertCurrent(value: unknown, allowAborted: boolean): void {
    if (typeof value !== "object" || value === null || !(#assert in value)) {
      throw new Error("Pending chat input has no retained work admission");
    }
    value.#assert(allowAborted);
  }
}

export type RetainedChatSendInputLifetime = ChatSendInputLifetime;

export function assertChatSendInputLifetime(
  value: RetainedChatSendInputLifetime,
  allowAborted = false,
): void {
  ChatSendInputLifetime.assertCurrent(value, allowAborted);
}

/** Queued and collected turns share the original session and caller admission until settlement. */
export function createChatSendWorkAdmission(params: {
  admission: Pick<SessionWorkAdmissionLease, "release"> &
    Partial<Pick<SessionWorkAdmissionLease, "isActive">>;
  releaseCallerAuthority?: () => void | Promise<void>;
  logGateway: Pick<GatewayRequestContext["logGateway"], "warn">;
}) {
  let references = 1;
  let finishPendingInput: (() => void | Promise<void>) | undefined;
  let settlement: Promise<void> | undefined;
  const releaseOwners = () => {
    const failures: unknown[] = [];
    const closing: Promise<void>[] = [];
    for (const release of [() => params.admission.release(), params.releaseCallerAuthority]) {
      try {
        const pending = release?.();
        if (pending) {
          closing.push(pending);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    const finish = () => {
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Chat input owner release failed");
      }
    };
    if (!closing.length) {
      return finish();
    }
    return Promise.allSettled(closing).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          failures.push(result.reason);
        }
      }
      finish();
    });
  };
  const reportFailure = (error: unknown) => {
    params.logGateway.warn(`Failed to finish pending chat input: ${formatForLog(error)}`);
  };
  const release = () => {
    if (references === 0) {
      return settlement;
    }
    references -= 1;
    if (references !== 0) {
      return undefined;
    }
    let pending: void | Promise<void> = undefined;
    try {
      pending = finishPendingInput?.();
    } catch (error) {
      // The durable row remains recoverable; a failed disposition write must
      // not strand session/root drain ownership during shutdown.
      reportFailure(error);
      if (isSessionPendingInputSettlementUnknown(error)) {
        throw error;
      }
    }
    if (pending instanceof Promise) {
      settlement = pending.then(releaseOwners, (error: unknown) => {
        reportFailure(error);
        if (isSessionPendingInputSettlementUnknown(error)) {
          throw error;
        }
        return releaseOwners();
      });
      void settlement.catch(() => {});
      return settlement;
    }
    const joined = releaseOwners();
    if (joined) {
      settlement = joined;
      void settlement.catch(() => {});
    }
    return settlement;
  };
  const hold = () => {
    let released = false;
    let joined: Promise<void> | undefined;
    let failure: { error: unknown } | undefined;
    return () => {
      if (failure) {
        throw failure.error;
      }
      if (released) {
        return joined;
      }
      released = true;
      try {
        joined = release();
      } catch (error) {
        failure = { error };
        throw error;
      }
      return joined;
    };
  };
  return {
    isActive: () => references > 0,
    captureInputLifetime(input: {
      controller: AbortController;
      queuedTurns: GatewayRequestContext["chatQueuedTurns"];
      runId: string;
      lifecycleGeneration: string;
    }): RetainedChatSendInputLifetime {
      if (!params.admission.isActive) {
        throw new Error("Chat input requires its native work admission");
      }
      const { controller, queuedTurns, runId, lifecycleGeneration } = input;
      return new ChatSendInputLifetime(inputLifetimeIssuer, (allowAborted) => {
        const queued = queuedTurns.get(runId);
        if (
          (!allowAborted && references === 0) ||
          !params.admission.isActive!() ||
          lifecycleGeneration !== getAgentEventLifecycleGeneration() ||
          (!allowAborted &&
            controller.signal.aborted &&
            !(queued?.controller === controller && queued.abortable === false))
        ) {
          throw new Error("Chat admission ended or was cancelled; submit a new turn.");
        }
      });
    },
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

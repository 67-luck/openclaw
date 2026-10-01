import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ReplyRunAlreadyActiveError,
  ReplyRunFollowupAdmissionBlockedError,
  ReplyRunSuccessorAdmissionBlockedError,
  type ReplyTurnKind,
} from "./session-controller.contracts.js";
import type { SessionControllerMailboxClaim } from "./session-controller.mailbox.js";
import {
  getSessionControllerEntry,
  bindSessionControllerEntryTarget,
  assertSessionControllerAdmissionClaim,
} from "./session-controller.state.js";
import type { SessionTarget } from "./session-controller.target.js";

export type CreateReplyOperationParams = {
  sessionKey: string;
  sessionId: string;
  agentId?: string;
  turnKind?: ReplyTurnKind;
  resetTriggered: boolean;
  routeThreadId?: string | number;
  originatingLeafEntryId?: string | null;
  upstreamAbortSignal?: AbortSignal;
  respectFollowupAdmissionBarrier?: boolean;
  mailboxClaim?: SessionControllerMailboxClaim;
  target?: SessionTarget;
};

export function prepareReplyOperationAdmission(params: CreateReplyOperationParams) {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionKey) {
    throw new Error("Reply operations require a canonical sessionKey");
  }
  if (!sessionId) {
    throw new Error("Reply operations require a sessionId");
  }
  const owner =
    params.mailboxClaim?.mailbox.owner ?? getSessionControllerEntry(sessionKey, params.target);
  if (params.target) {
    bindSessionControllerEntryTarget(owner, params.target);
  }
  if (params.respectFollowupAdmissionBarrier && owner.followupBarrier) {
    throw new ReplyRunFollowupAdmissionBlockedError(sessionKey);
  }
  if (owner.active) {
    throw new ReplyRunAlreadyActiveError(sessionKey);
  }
  if (owner.successorBarrier) {
    throw new ReplyRunSuccessorAdmissionBlockedError(sessionKey);
  }

  assertSessionControllerAdmissionClaim(sessionKey, params.mailboxClaim, params.target);
  return { sessionKey, sessionId, owner };
}

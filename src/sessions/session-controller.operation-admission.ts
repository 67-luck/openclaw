import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { evaluateTurnAdmission } from "./session-controller.admission-rule.js";
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
  sessionControllers,
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
  const admission = evaluateTurnAdmission(owner, {
    kind: params.turnKind ?? "visible",
    sessionKey,
    registeredEntry: sessionControllers.get(owner.id),
    claim: params.mailboxClaim,
  });
  if (!admission.admitted) {
    if (admission.reason === "followup-barrier") {
      throw new ReplyRunFollowupAdmissionBlockedError(sessionKey);
    }
    if (admission.reason === "successor-barrier") {
      throw new ReplyRunSuccessorAdmissionBlockedError(sessionKey);
    }
    throw new ReplyRunAlreadyActiveError(sessionKey);
  }
  return { sessionKey, sessionId, owner };
}

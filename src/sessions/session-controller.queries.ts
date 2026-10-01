import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import {
  activeSessionOperations,
  getSessionControllerOperation,
  hasReplyOperationExecutionStarted,
  isReplyOperationPreBackendPhase,
  resolveReplyRunForCurrentSessionId,
  getSessionControllerEntryForOperation,
} from "./session-controller.state.js";

export function isSessionRunActive(sessionId: string): boolean {
  return resolveReplyRunForCurrentSessionId(sessionId) !== undefined;
}

/** Native liveness is a fact of the active turn, never a second busy-state vote. */
export function resolveSessionRunProgressState(
  sessionId: string,
  owner?: { agentId?: string; defaultAgentId?: string },
): "queued" | "running" | undefined {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  if (!operation || operation.result) {
    return undefined;
  }
  const native = getSessionControllerEntryForOperation(operation).nativeAttempt;
  if (owner) {
    const requested = owner.agentId ?? owner.defaultAgentId;
    const recorded =
      operation.agentId ?? parseAgentSessionKey(operation.key)?.agentId ?? owner.defaultAgentId;
    if (
      !requested ||
      !recorded ||
      normalizeAgentId(requested) !== normalizeAgentId(recorded) ||
      native?.projectSessionActive === false
    ) {
      return undefined;
    }
  }
  if (
    operation.phase === "waiting_for_global_lane" ||
    !hasReplyOperationExecutionStarted(operation)
  ) {
    return "queued";
  }
  return "running";
}
export function isSessionRunCompactionBlocked(sessionId: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  return Boolean(operation && !isReplyOperationPreBackendPhase(operation.phase));
}
export function getActiveSessionRunCount(): number {
  return [...activeSessionOperations()].length;
}
export function listActiveSessionRunKeys(): string[] {
  return [...activeSessionOperations()].map((operation) => operation.key).toSorted();
}
export function listActiveSessionRunIds(): string[] {
  return [...activeSessionOperations()].map((operation) => operation.sessionId).toSorted();
}
export function resolveActiveSessionRunId(sessionKey: string): string | undefined {
  return getSessionControllerOperation(sessionKey.trim())?.sessionId;
}

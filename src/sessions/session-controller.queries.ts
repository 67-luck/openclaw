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
  return resolveReplyRunForCurrentSessionId(sessionId).kind !== "none";
}

/** Native liveness is a fact of the active turn, never a second busy-state vote. */
export function resolveSessionRunProgressState(
  sessionId: string,
  owner?: { agentId?: string; defaultAgentId?: string },
): "queued" | "running" | undefined {
  const resolution = resolveReplyRunForCurrentSessionId(sessionId);
  const operations =
    resolution.kind === "none"
      ? []
      : resolution.kind === "one"
        ? [resolution.operation]
        : resolution.operations;
  const eligible = operations.filter((operation) => {
    if (operation.result) {
      return false;
    }
    if (!owner) {
      return true;
    }
    const requested = owner.agentId ?? owner.defaultAgentId;
    const recorded =
      operation.agentId ?? parseAgentSessionKey(operation.key)?.agentId ?? owner.defaultAgentId;
    const attachment = getSessionControllerEntryForOperation(operation).attachment;
    return Boolean(
      requested &&
      recorded &&
      normalizeAgentId(requested) === normalizeAgentId(recorded) &&
      attachment?.projectSessionActive !== false,
    );
  });
  if (eligible.length === 0) {
    return undefined;
  }
  if (
    eligible.every(
      (operation) =>
        operation.phase === "waiting_for_global_lane" ||
        !hasReplyOperationExecutionStarted(operation),
    )
  ) {
    return "queued";
  }
  return "running";
}
export function isSessionRunCompactionBlocked(sessionId: string): boolean {
  const resolution = resolveReplyRunForCurrentSessionId(sessionId);
  const operations =
    resolution.kind === "none"
      ? []
      : resolution.kind === "one"
        ? [resolution.operation]
        : resolution.operations;
  return operations.some((operation) => !isReplyOperationPreBackendPhase(operation.phase));
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

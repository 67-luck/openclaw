import type { ReplyOperation } from "./session-controller.contracts.js";
import {
  getSessionControllerEntryForOperation,
  assertSessionControllerOperation,
  resolveReplyRunForCurrentSessionId,
} from "./session-controller.identity.js";
export function resolveControllerNativeAttempt(sessionId: string) {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  const attempt = operation && getSessionControllerEntryForOperation(operation).nativeAttempt;
  return attempt?.operation === operation ? attempt?.handle : undefined;
}

export function attachControllerNativeAttempt(
  operation: ReplyOperation,
  handle: import("../agents/embedded-agent-runner/run-state.js").EmbeddedAgentQueueHandle,
): void {
  assertSessionControllerOperation(operation);
  getSessionControllerEntryForOperation(operation).nativeAttempt = { operation, handle };
}

export function detachControllerNativeAttempt(
  operation: ReplyOperation,
  handle: import("../agents/embedded-agent-runner/run-state.js").EmbeddedAgentQueueHandle,
): void {
  const entry = getSessionControllerEntryForOperation(operation);
  if (entry?.nativeAttempt?.operation === operation && entry.nativeAttempt.handle === handle) {
    entry.nativeAttempt = undefined;
  }
}

import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyOperation } from "./session-controller.contracts.js";
import type { SessionControllerEntry } from "./session-controller.state.types.js";
import * as controllerStorage from "./session-controller.storage.js";
export function getSessionControllerEntryForOperation(
  operation: ReplyOperation,
): SessionControllerEntry {
  const entry = controllerStorage.controllerEntryByOperation.get(operation);
  if (!entry) {
    throw new Error("Operation has no controller owner");
  }
  return entry;
}
export function isCurrentSessionControllerOperation(operation: ReplyOperation): boolean {
  const entry = controllerStorage.controllerEntryByOperation.get(operation);
  return (
    entry !== undefined &&
    controllerStorage.sessionControllers.get(entry.id) === entry &&
    entry.active === operation
  );
}

export function assertSessionControllerOperation(operation: ReplyOperation): void {
  if (
    !isCurrentSessionControllerOperation(operation) ||
    operation.result ||
    operation.abortSignal.aborted
  ) {
    throw new Error("Session turn no longer owns controller admission");
  }
}

export function resolveReplyRunForCurrentSessionId(sessionId: string): ReplyOperation | undefined {
  const id = normalizeOptionalString(sessionId);
  if (!id) {
    return undefined;
  }
  const matches = [...controllerStorage.sessionControllers.values()]
    .flatMap((entry) => (entry.active ? [entry.active] : []))
    .filter((operation) => operation.sessionId === id);
  return matches.length === 1 ? matches[0] : undefined;
}

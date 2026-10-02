import {
  isAgentEventLifecycleGenerationCurrent,
  registerAgentEventLifecycleRotationHandler,
} from "../infra/agent-events.js";
import { markDiagnosticRunProgress } from "../logging/diagnostic-run-activity.js";
import type { ReplyOperation } from "./session-controller.contracts.js";
import { activeSessionOperations } from "./session-controller.state.js";
import * as controllerStorage from "./session-controller.storage.js";

function evictPriorLifecycleReplyRuns(): void {
  const errors: unknown[] = [];
  // Capture owners before cleanup can mutate the controller or publish a successor.
  const capturedOwners = Array.from(activeSessionOperations());
  for (const operation of capturedOwners) {
    if (
      operation.lifecycleGeneration &&
      isAgentEventLifecycleGenerationCurrent(operation.lifecycleGeneration)
    ) {
      continue;
    }
    try {
      controllerStorage.evictReplyOperationByOperation.get(operation)?.();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "Failed to abort stale reply runs");
  }
}

registerAgentEventLifecycleRotationHandler("reply-runs", evictPriorLifecycleReplyRuns);

const replyRunRegistryTestApi = {
  resetReplyRunRegistry(): void {
    for (const operation of activeSessionOperations()) {
      markDiagnosticRunProgress({
        sessionKey: operation.key,
        sessionId: operation.sessionId,
        reason: "reply_operation:registry_reset",
      });
    }
    for (const entry of controllerStorage.sessionControllers.values()) {
      entry.active?.watchdog.close();
      for (const operation of entry.lifecycle?.operations ?? []) {
        operation.watchdog.close();
      }
    }
    for (const entry of controllerStorage.sessionControllers.values()) {
      for (const waiter of entry.waiters) {
        waiter.finish(false);
      }
    }
    controllerStorage.sessionControllers.clear();
    controllerStorage.rpcSourceByRunId.clear();
  },
};

if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
  Object.assign(globalThis, {
    [Symbol.for("openclaw.replyRunRegistryTestApi")]: replyRunRegistryTestApi,
  });
}

export function markReplyOperationGlobalLaneWaitProgress(operation: ReplyOperation): void {
  if (operation.result || operation.phase !== "waiting_for_global_lane") {
    return;
  }
  markDiagnosticRunProgress({
    sessionKey: operation.key,
    sessionId: operation.sessionId,
    reason: "global_lane:waiting",
  });
}

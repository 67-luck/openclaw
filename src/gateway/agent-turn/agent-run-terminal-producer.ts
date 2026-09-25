import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import {
  isAgentRunDirectAbortReason,
  isAgentRunRestartAbortReason,
} from "../../agents/run-termination.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { validateAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import { readErrorName } from "../../infra/errors.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ChatAbortControllerEntry } from "../chat-abort.types.js";

export function resolveResolvedAgentTimeoutStopReason(
  meta: unknown,
  signal: AbortSignal,
): "timeout" | undefined {
  if (!signal.aborted) {
    return undefined;
  }
  const record = isRecord(meta) ? meta : undefined;
  if (record?.aborted !== true && record?.stopReason !== "toolUse") {
    return undefined;
  }
  return resolveGatewayAgentAbortStopReason(signal) === "timeout" ? "timeout" : undefined;
}

function isGatewayAbortSignalReason(reason: unknown): boolean {
  return reason === undefined || isAbortError(reason) || readErrorName(reason) === "TimeoutError";
}

export function isGatewayAgentAbortRejection(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) {
    // The run can cancel its own controller without aborting the Gateway observer.
    return isAgentRunDirectAbortReason(error);
  }
  if (isAgentRunRestartAbortReason(signal.reason)) {
    return true;
  }
  if (readErrorName(signal.reason) === "TimeoutError") {
    return true;
  }
  if (!isGatewayAbortSignalReason(signal.reason)) {
    return false;
  }
  return isAbortError(error) || readErrorName(error) === "TimeoutError";
}

export function resolveGatewayAgentAbortStopReason(
  signal: AbortSignal,
): "restart" | "rpc" | "timeout" {
  if (isAgentRunRestartAbortReason(signal.reason)) {
    return "restart";
  }
  return readErrorName(signal.reason) === "TimeoutError" ? "timeout" : "rpc";
}

// `agent` clients already consume cancellation as timeout; keep that wire
// contract while task/session projections use the canonical cancellation class.
export const RESOLVED_GATEWAY_STATUS_BY_TERMINAL_CLASSIFICATION = {
  success: "ok",
  timeout: "timeout",
  cancellation: "timeout",
  failure: "error",
} as const;

export function projectRejectedGatewayStatus(
  outcome: AgentRunTerminalOutcome,
): "error" | "timeout" {
  // The shipped wire keeps raw provider/AbortError rejections as errors. Only
  // owner-recorded cancellation/timeout metadata promotes a rejection to timeout.
  return outcome.reason === "cancelled" ||
    outcome.reason === "superseded" ||
    outcome.stopReason === "timeout"
    ? "timeout"
    : "error";
}

/** Binds canonical transcript settlement to the exact registered API producer. */
export function bindGatewayAgentTerminalProducer(params: {
  runId: string;
  entry: ChatAbortControllerEntry | undefined;
  controller: AbortController;
  ingressOpts: { abortSignal?: AbortSignal };
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  isOwnerReleased: () => boolean;
}): {
  complete: () => Promise<void>;
  settle: <T>(execution: Promise<T>) => Promise<T>;
} {
  const { entry, controller } = params;
  const registeredRunInstance = entry?.operationalRunInstance;
  const registeredLifecycleGeneration = entry?.lifecycleGeneration;
  const registeredSessionKey = entry?.sessionKey;
  const producerCompletion = createDeferredCore();
  let terminalSettlement: Promise<void> | undefined;
  if (entry && params.ingressOpts.abortSignal === controller.signal) {
    entry.resolveTerminalProducer = () => {
      const { sessionId, sessionKey } = entry;
      const isCurrent = () => {
        const authority = entry.agentRunDelegatedAuthority;
        return (
          !params.isOwnerReleased() &&
          !controller.signal.aborted &&
          params.ingressOpts.abortSignal === controller.signal &&
          params.chatAbortControllers.get(params.runId) === entry &&
          entry.controller === controller &&
          entry.operationalRunInstance === registeredRunInstance &&
          entry.lifecycleGeneration === registeredLifecycleGeneration &&
          entry.sessionId === sessionId &&
          entry.sessionKey === sessionKey &&
          sessionKey === registeredSessionKey &&
          !entry.registrationCleanupRequested &&
          (!registeredLifecycleGeneration ||
            isAgentEventLifecycleGenerationCurrent(registeredLifecycleGeneration)) &&
          (!entry.executionStarted || authority !== undefined) &&
          (!authority ||
            (authority.operationalRunInstance === registeredRunInstance &&
              validateAgentRunDelegatedAuthority(authority)))
        );
      };
      if (!isCurrent()) {
        return undefined;
      }
      return {
        sessionId,
        sessionKey,
        handoff: (settle) => {
          if (!isCurrent()) {
            return false;
          }
          const settlement = settle(producerCompletion.promise);
          terminalSettlement = terminalSettlement
            ? Promise.all([terminalSettlement, settlement]).then(() => undefined)
            : settlement;
          return true;
        },
      };
    };
  }
  const complete = async () => {
    producerCompletion.resolve();
    let joined: Promise<void> | undefined;
    do {
      joined = terminalSettlement;
      await joined;
    } while (joined !== terminalSettlement);
  };
  return {
    complete,
    async settle<T>(execution: Promise<T>): Promise<T> {
      try {
        return await execution;
      } finally {
        await complete();
      }
    },
  };
}

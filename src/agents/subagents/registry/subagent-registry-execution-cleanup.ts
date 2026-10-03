import { clearGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  getRpcSource,
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
  type RpcSourceRef,
} from "../../../sessions/session-controller.rpc-sources.js";
import type { SubagentKillSession } from "./subagent-control-session.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type CapturedSubagentExecution = {
  readonly entry: SubagentRunRecord;
  readonly runId: string;
  readonly execution: RpcSourceRef;
};

/** Captures the exact controller source owned by the selected subagent run. */
export function captureSubagentExecution(params: {
  entry: SubagentRunRecord;
  session: SubagentKillSession;
}): CapturedSubagentExecution | undefined {
  const entry = getCurrentSubagentRunOwner(subagentRuns, params.entry) ?? params.entry;
  const execution = getRpcSource(entry.runId);
  if (!execution || execution.adapter.kind !== "agent") {
    return undefined;
  }
  const identity = getRpcSourceIdentity(execution);
  const lifecycleGeneration = getRpcSourceLifecycleGeneration(execution);
  if (
    identity.sessionKey !== entry.childSessionKey ||
    identity.sessionId !== params.session.entry?.sessionId ||
    (entry.execution.lifecycleGeneration !== undefined &&
      lifecycleGeneration !== entry.execution.lifecycleGeneration)
  ) {
    return undefined;
  }
  return { entry, runId: entry.runId, execution };
}

/** Retires the registry projection; controller source settlement retains physical cleanup. */
export function retireSubagentGatewayBinding(observed: SubagentRunRecord): void {
  const entry = getCurrentSubagentRunOwner(subagentRuns, observed) ?? observed;
  clearGatewayContextResolver(entry);
}

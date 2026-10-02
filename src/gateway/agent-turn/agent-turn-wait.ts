import type { AgentWaitParams } from "../../../packages/gateway-protocol/src/index.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  getRpcSource,
  getRpcSourceIdentity,
  isRpcSourceQueued,
} from "../../sessions/session-controller.rpc-sources.js";
import { resolveAgentWaitSource } from "./agent-dedupe.js";
import { captureAgentJobSession, getAgentJobSession, waitForAgentJob } from "./agent-job.js";
import type { AgentTurnContext } from "./types.js";

export function prepareAgentTurnWait(context: AgentTurnContext, params: AgentWaitParams) {
  const runId = params.runId ?? "";
  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? Math.max(0, Math.floor(params.timeoutMs))
      : 30_000;
  const source = resolveAgentWaitSource(context, runId);
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const queuedResult = () => {
    const queued = getRpcSource(runId);
    return queued && isRpcSourceQueued(queued)
      ? {
          session: captureAgentJobSession({
            ...getRpcSourceIdentity(queued),
            lifecycleGeneration,
          }),
          result: {
            runId,
            status: "pending" as const,
            timeoutPhase: "queue" as const,
            providerStarted: false,
          },
        }
      : undefined;
  };
  const queuedBeforeWait = queuedResult();
  // Compaction updates this registration; a reused run ID must not replace it.
  const runContext = getAgentRunContext(runId);
  const initialSession =
    queuedBeforeWait?.session ??
    getAgentJobSession(runId, source === "chat" ? "chat" : undefined) ??
    captureAgentJobSession(runContext);
  const wait = async () => {
    if (queuedBeforeWait) {
      return queuedBeforeWait;
    }
    const snapshot = await waitForAgentJob({ runId, timeoutMs, source });
    const queuedAfterWait = queuedResult();
    if (queuedAfterWait) {
      return queuedAfterWait;
    }
    if (!snapshot) {
      return {
        result: { runId, status: "timeout" as const },
        session: captureAgentJobSession(runContext) ?? initialSession,
      };
    }
    return {
      session: snapshot.session,
      result: {
        runId,
        status: snapshot.status,
        startedAt: snapshot.startedAt,
        endedAt: snapshot.endedAt,
        error: snapshot.error,
        stopReason: snapshot.stopReason,
        livenessState: snapshot.livenessState,
        yielded: snapshot.yielded,
        pendingError: snapshot.pendingError,
        timeoutPhase: snapshot.timeoutPhase,
        providerStarted: snapshot.providerStarted,
        ...(snapshot.terminalDelivery ? { terminalDelivery: snapshot.terminalDelivery } : {}),
        terminalReceipt: snapshot.terminalReceipt,
        terminalReply: snapshot.terminalReply,
      },
    };
  };
  return { session: initialSession, wait };
}

import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { listControlledSubagentRunsForTurn } from "../../agents/subagents/registry/subagent-control-scope.js";
import {
  killAllControlledSubagentRuns,
  resolveSubagentController,
} from "../../agents/subagents/registry/subagent-control.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export async function abortControlledSubagents(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  requesterTurnRunId?: string;
  assertCurrent?: () => void;
  beforeKill?: Parameters<typeof killAllControlledSubagentRuns>[0]["beforeKill"];
}) {
  const controller = resolveSubagentController({
    cfg: params.cfg,
    agentSessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  const runs = listControlledSubagentRunsForTurn(controller, params.requesterTurnRunId);
  if (runs.length === 0) {
    await params.beforeKill?.();
    return undefined;
  }
  return killAllControlledSubagentRuns({
    cfg: params.cfg,
    controller,
    runs,
    suppressTaskDelivery: true,
    assertCurrent: params.assertCurrent,
    beforeKill: params.beforeKill,
  });
}

export function descendantAbortError(
  result: Awaited<ReturnType<typeof abortControlledSubagents>>,
  subject: "Parent run" | "Session",
) {
  return result && result.status !== "ok"
    ? errorShape(
        ErrorCodes.UNAVAILABLE,
        `${subject} stopped, but descendant cancellation was incomplete: ${result.error}`,
      )
    : undefined;
}

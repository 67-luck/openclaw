import type { RunEmbeddedAgentParams } from "../../../agents/embedded-agent-runner/run/params.js";
import * as embeddedRuns from "../../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../../agents/embedded-agent-runner/runs.test-support.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../../agents/tools/gateway-caller-context.js";
import { getCurrentSessionControllerOwner } from "../../../sessions/session-controller.lifecycle.js";

export async function withRegisteredNativeEmbeddedRun<T>(
  params: Pick<
    RunEmbeddedAgentParams,
    "agentId" | "preparedRunAdmission" | "runId" | "sessionId" | "sessionKey"
  >,
  run: () => Promise<T> | T,
): Promise<T> {
  const { agentId, preparedRunAdmission, sessionKey } = params;
  if (!agentId || !preparedRunAdmission || !sessionKey) {
    throw new Error("Expected real Talk admission");
  }
  const admittedRunContext = await preparedRunAdmission.admit("embedded", "native-test-backend");
  return await withGatewayToolCallerIdentity(
    createAdmittedGatewayToolCallerIdentity({
      admittedRunContext,
      agentId,
      sessionKey,
    }),
    async () => {
      const handle = createEmbeddedRunHandle({ runId: params.runId });
      const operation = getCurrentSessionControllerOwner();
      if (!operation) {
        throw new Error("Talk native fixture has no controller-owned turn");
      }
      embeddedRuns.setActiveEmbeddedRun(
        params.sessionId,
        handle,
        sessionKey,
        undefined,
        agentId,
        operation,
      );
      try {
        return await run();
      } finally {
        embeddedRuns.clearActiveEmbeddedRun(params.sessionId, handle, sessionKey);
      }
    },
  );
}

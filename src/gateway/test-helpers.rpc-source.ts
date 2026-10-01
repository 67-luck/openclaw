import { randomUUID } from "node:crypto";
import { onTestFinished } from "vitest";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../auto-reply/reply/queue/enqueue.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  bindSessionControllerSource,
  retireSessionControllerInput,
  claimSessionControllerTask,
  releaseSessionControllerClaim,
} from "../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import type { RpcSourceAdapter, RpcSourceRef } from "../sessions/session-controller.rpc-sources.js";
import { markReplyOperationExecutionStarted } from "../sessions/session-controller.state.js";

/** Presentation fixtures retain real controller-owned inputs, never a second abort primitive. */
export function createRpcSourceForTest(
  metadata: Partial<RpcSourceAdapter> = {},
  options: {
    runId?: string;
    storeScope?: string;
    phase?: "preparing" | "waiting" | "consumed";
  } = {},
): RpcSourceRef {
  const adapter: RpcSourceAdapter = {
    sessionKey: "agent:main:fixture",
    sessionId: "fixture-session",
    ...metadata,
  };
  const target = captureSessionTarget({
    storeScope: options.storeScope ?? `/synthetic/rpc-source-fixture/${randomUUID()}/sessions`,
    sessionKey: adapter.sessionKey || "agent:main:fixture",
    agentId: adapter.agentId,
    incarnation: adapter.sessionId,
  });
  const input = reserveSessionControllerSource(target.sessionKey, {
    target,
    adapter,
    protocolRunId: options.runId,
    policy: { mode: "followup" },
  });
  if (options.phase === "waiting") {
    const run = createQueueTestRun({ prompt: "queued RPC fixture" });
    run.run = {
      ...run.run,
      sessionKey: adapter.sessionKey,
      sessionId: adapter.sessionId,
      agentId: adapter.agentId ?? run.run.agentId,
      config: { ...run.run.config, session: { store: target.storeScope } },
    };
    run.abortSignal = input.abortSignal;
    bindSessionControllerSource(input, run);
    enqueueFollowupRun(adapter.sessionKey, run, { mode: "followup" }, "none");
  } else if (options.phase === "consumed") {
    retireSessionControllerInput(input);
  }
  onTestFinished(async () => {
    const claim = input.claim;
    claim?.operation?.complete();
    if (claim) {
      releaseSessionControllerClaim(claim);
      await claim.settlement.promise;
    }
    retireSessionControllerInput(input);
    await input.settlement.promise;
  });
  return { input, adapter };
}

/** Claim through the controller selector before exercising an active projection. */
export async function claimRpcSourceForTest(ref: RpcSourceRef): Promise<() => void> {
  const claim = await claimSessionControllerTask(ref.input, (selectedClaim) => {
    const operation = createReplyOperation({
      sessionKey: ref.input.mailbox.key,
      sessionId: ref.adapter.sessionId || "fixture-session",
      agentId: ref.adapter.agentId,
      resetTriggered: false,
      mailboxClaim: selectedClaim,
      target: ref.input.mailbox.owner.target,
    });
    markReplyOperationExecutionStarted(operation);
  });
  const release = () => {
    try {
      claim.operation?.complete();
    } finally {
      releaseSessionControllerClaim(claim);
    }
  };
  onTestFinished(async () => {
    release();
    await claim.settlement.promise;
  });
  return release;
}

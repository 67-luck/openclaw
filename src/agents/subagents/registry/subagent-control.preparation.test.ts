// Preserve fixture setup before the runtime modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import * as replyConfig from "../../../auto-reply/reply/agent-runner-utils.js";
import { createQueueTestRun } from "../../../auto-reply/reply/queue.test-helpers.js";
import { prepareReplyAgentTurn } from "../../../auto-reply/reply/reply-agent-turn-preparation.js";
import { runWithReplyOperationLifecycleAdmission } from "../../../auto-reply/reply/reply-turn-admission.js";
import { createTypingController } from "../../../auto-reply/reply/typing.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { SESSION_CONTROLLER_DRAIN_TIMEOUT_MS } from "../../../sessions/session-controller.lifecycle.js";
import { releaseSessionControllerClaim } from "../../../sessions/session-controller.mailbox.js";
import { registerRpcSource } from "../../../sessions/session-controller.rpc-sources.js";
import { killSubagentRunAdmin } from "./subagent-control.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";

const fixture = useSubagentControlFixture();

it("cancels a selected preparation source and retains its actual return before completing child Stop", async () => {
  const sessionKey = "agent:main:subagent:preparing-stop";
  const sessionId = "preparing-stop-session";
  const runId = "preparing-stop-run";
  const storePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey,
    defaultSessionId: sessionId,
  });
  await registerSubagentRun({
    runId,
    childSessionKey: sessionKey,
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: "preparing source cancellation",
    cleanup: "keep",
    expectsCompletionMessage: false,
  });
  const cfg = getRuntimeConfig();
  const upstream = new AbortController();
  const queued = createQueueTestRun({ prompt: "do not execute after Stop" });
  queued.abortSignal = upstream.signal;
  queued.run = { ...queued.run, config: cfg, agentId: "main", sessionKey, sessionId };
  const entered = createDeferred();
  const finishPreparation = createDeferred();
  vi.spyOn(replyConfig, "resolveQueuedReplyExecutionConfig").mockImplementation(async (config) => {
    entered.resolve();
    await finishPreparation.promise;
    return config;
  });
  const typing = createTypingController({});
  const preparation = prepareReplyAgentTurn({
    queued,
    defaults: { typing, typingMode: "never", defaultModel: "gpt-test", sessionKey, storePath },
  });
  await entered.promise;
  const input = queued.controllerInput;
  const claim = input?.claim;
  if (!input || !claim) {
    throw new Error("Preparation did not retain its selected source");
  }
  const interrupted = createDeferred();
  claim.abortController.signal.addEventListener("abort", () => interrupted.resolve(), {
    once: true,
  });
  let stopped = false;
  const stopping = killSubagentRunAdmin({ cfg, sessionKey, expectedRunId: runId }).finally(() => {
    stopped = true;
  });
  try {
    await interrupted.promise;
    expect(input.abortSignal.aborted).toBe(true);
    expect(claim.operation).toBeUndefined();
    expect(claim.released).toBe(false);
    expect(stopped).toBe(false);
    finishPreparation.resolve();
    expect(await preparation).toMatchObject({ kind: "skipped", reason: "aborted" });
    expect(await stopping).toMatchObject({ found: true, killed: true });
    await input.settlement.promise;
    expect(claim.operation).toBeUndefined();
  } finally {
    upstream.abort();
    finishPreparation.resolve();
    const result = await preparation.catch(() => undefined);
    if (result?.kind === "admitted") {
      result.turn.operation.complete();
    } else if (result?.kind === "skipped") {
      result.operation?.complete();
    }
    releaseSessionControllerClaim(claim);
    await Promise.allSettled([claim.settlement.promise, stopping]);
    typing.cleanup();
  }
});

it("completes a child Stop initiated by its own controller operation", async ({ signal }) => {
  const sessionKey = "agent:main:subagent:self-stop";
  const sessionId = "self-stop-session";
  const runId = "self-stop-run";
  const storePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey,
    defaultSessionId: sessionId,
  });
  await registerSubagentRun({
    runId,
    childSessionKey: sessionKey,
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: "stop this child from its own turn",
    cleanup: "keep",
    expectsCompletionMessage: false,
  });
  const cfg = getRuntimeConfig();
  const queued = createQueueTestRun({ prompt: "stop" });
  queued.run = { ...queued.run, config: cfg, agentId: "main", sessionKey, sessionId };
  const typing = createTypingController({});
  const prepared = await prepareReplyAgentTurn({
    queued,
    defaults: { typing, typingMode: "never", defaultModel: "gpt-test", sessionKey, storePath },
  });
  if (prepared.kind !== "admitted") {
    throw new Error(`Expected an admitted child turn, received ${prepared.reason}`);
  }
  const input = queued.controllerInput;
  const claim = input?.claim;
  if (!input || !claim) {
    throw new Error("Child turn did not retain its controller source");
  }
  registerRpcSource(runId, { input, adapter: { kind: "agent" } });
  vi.useFakeTimers();
  const stopping = runWithReplyOperationLifecycleAdmission(prepared.turn.operation, () =>
    killSubagentRunAdmin({ cfg, sessionKey, expectedRunId: runId }),
  );
  try {
    await vi.waitFor(() => expect(prepared.turn.operation.abortSignal.aborted).toBe(true));
    await vi.advanceTimersByTimeAsync(SESSION_CONTROLLER_DRAIN_TIMEOUT_MS);
    await expect(withinTest(stopping, signal)).resolves.toMatchObject({
      found: true,
      killed: true,
    });
  } finally {
    prepared.turn.operation.complete();
    releaseSessionControllerClaim(claim);
    vi.useRealTimers();
    await Promise.allSettled([input.settlement.promise, claim.settlement.promise, stopping]);
    typing.cleanup();
  }
});

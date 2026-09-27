// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { taskReceipt, useDispatchOwnerFixture } from "./agent-run-dispatch.owner.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { SessionFollowupCompletion } from "../../agents/subagents/completion/session-followup-completion.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { bindFollowupTaskProjection } from "../../tasks/task-followup-projection.js";
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";

describe("Gateway dispatch followup ownership", () => {
  const mocks = useDispatchOwnerFixture();

  async function createFollowupDispatch() {
    const f = createTrackedDispatch();
    const receipt = taskReceipt(
      f.task,
      vi.fn(async () => true),
    );
    const owner = SessionFollowupCompletion.bind({
      runId: f.runId,
      requesterSessionKey: "agent:main:parent",
      requesterSessionId: "requester-session",
      requesterAgentId: "main",
      targetAgentId: "main",
      targetSessionKey: f.sessionKey,
      custody: {
        run: (work) => work(),
        assertCurrent: vi.fn(),
        signal: new AbortController().signal,
        release: vi.fn(),
      },
    });
    await bindFollowupTaskProjection(owner, receipt, () => {});
    const dispatch = (runId = f.runId, entry = f.entry, assertCurrent?: () => void) => {
      owner.markAccepted(runId);
      return dispatchAgentRunFromGateway({
        assertCurrent,
        admittedRunEntry: entry,
        ingressOpts: {
          message: "followup",
          sessionKey: f.sessionKey,
          allowModelOverride: false,
          abortSignal: entry.controller.signal,
        },
        runId,
        dedupeKeys: [],
        abortController: entry.controller,
        cleanupAbortController: vi.fn(),
        io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
        context: f.context,
        taskTrackingMode: { kind: "receipt", ...receipt, completion: owner },
        assertSettlementCurrent: vi.fn(),
      });
    };
    return { f, receipt, owner, dispatch };
  }

  it("keeps one logical owner across yield and delivers only the admitted successor reply", async () => {
    const { f, owner, dispatch } = await createFollowupDispatch();
    const logicalOwner = mocks.getTaskRunOwner(f.task);
    if (!logicalOwner) {
      throw new Error("Expected the original bound task owner");
    }
    const metadataEntered = createDeferred();
    const finishMetadata = createDeferred();
    logicalOwner.resumeExecution = async (assertCurrent) => {
      assertCurrent();
      metadataEntered.resolve();
      await finishMetadata.promise;
      assertCurrent();
    };
    const entries: SubagentRunRecord[] = [
      {
        runId: "descendant",
        childSessionKey: "agent:main:descendant",
        requesterSessionKey: f.sessionKey,
        requesterDisplayKey: f.sessionKey,
        task: "descendant",
        cleanup: "keep",
        createdAt: 1,
        execution: { status: "terminal" },
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          rearmGeneration: 1,
          requesterYieldBatch: true,
        },
      },
    ];
    owner.promoteYield(f.runId, entries, 1);
    try {
      mocks.agentCommand.mockResolvedValueOnce({
        payloads: [],
        meta: { yielded: true, terminalReply: { disposition: "empty" } },
      });
      await dispatch(f.runId, f.entry);
      expect(f.task.status).toBe("running");
      expect(mocks.finalizeActive).not.toHaveBeenCalled();
      expect(mocks.getTaskRunOwner(f.task)).toBe(logicalOwner);
      const successor = owner.successor(entries, "exact-successor", vi.fn());
      await owner.prepareSuccessor(successor);
      owner.adopt(successor);
      const successorEntry = {
        ...f.entry,
        controller: new AbortController(),
        operationalRunInstance: { runId: successor.runId, instanceId: "successor-instance" },
      };
      f.context.chatAbortControllers.set(successor.runId, successorEntry);
      mocks.agentCommand.mockImplementationOnce(async (opts) => {
        expect(opts).toMatchObject({ onPostAdmittedRunContext: undefined });
        await opts.onExecutionStarted?.();
        return {
          payloads: [{ text: "not canonical", mediaUrl: null }],
          meta: { terminalReply: { disposition: "visible", text: "B_YIELD_DONE" } },
        };
      });
      const successorDispatch = dispatch(successor.runId, successorEntry);
      await Promise.race([metadataEntered.promise, successorDispatch]);
      expect(mocks.agentCommand).toHaveBeenCalledOnce();
      finishMetadata.resolve();
      await successorDispatch;
      await expect(owner.take()).resolves.toMatchObject({
        status: "ok",
        replyText: "B_YIELD_DONE",
        terminalReply: { disposition: "visible", text: "B_YIELD_DONE" },
      });
      expect(mocks.bindTaskRunOwner).toHaveBeenCalledOnce();
      expect(mocks.createTaskReceipt).not.toHaveBeenCalled();
      expect(f.task.runId).toBe(f.runId);
      expect(f.task.status).toBe("succeeded");
      expect(mocks.getTaskRunOwner(f.task)).toBe(logicalOwner);
    } finally {
      finishMetadata.resolve();
      owner.close();
    }
  });

  it.each([
    {
      name: "provider failure",
      meta: { error: { kind: "incomplete_turn" as const, message: "provider failed" } },
      status: "error",
      stopReason: undefined,
    },
    {
      name: "RPC cancellation",
      meta: { aborted: true, stopReason: "rpc" },
      status: "error",
      stopReason: "rpc",
    },
    {
      name: "timeout",
      meta: { aborted: true, stopReason: "timeout" },
      status: "timeout",
      stopReason: "timeout",
    },
  ])(
    "passes canonical $name rather than wire status to the completion owner",
    async ({ meta, status, stopReason }) => {
      const { f, owner, dispatch } = await createFollowupDispatch();
      const settle = vi.spyOn(owner, "settle");
      mocks.agentCommand.mockResolvedValueOnce({ payloads: [], meta });
      try {
        await dispatch();
        expect(settle).toHaveBeenCalledWith(
          f.runId,
          expect.objectContaining({ status, ...(stopReason ? { stopReason } : {}) }),
          expect.any(Function),
        );
        expect(f.task.status).toBe(
          stopReason === "rpc" ? "cancelled" : status === "timeout" ? "timed_out" : "failed",
        );
      } finally {
        owner.close();
      }
    },
  );

  it("settles an admitted followup that fails before physical activation", async () => {
    const { f, owner, dispatch } = await createFollowupDispatch();
    try {
      await dispatch(f.runId, f.entry, () => {
        throw new Error("activation denied");
      });
      expect(mocks.agentCommand).not.toHaveBeenCalled();
      expect(f.task.status).toBe("failed");
      await expect(owner.take()).resolves.toMatchObject({
        status: "error",
        error: "activation denied",
      });
    } finally {
      owner.close();
    }
  });

  it.each(["silent", "empty"] as const)(
    "does not invent reply text for a canonical %s reply",
    async (disposition) => {
      const { owner, dispatch } = await createFollowupDispatch();
      mocks.agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "payload is not canonical", mediaUrl: null }],
        meta: { terminalReply: { disposition } },
      });
      try {
        await dispatch();
        const result = await owner.take();
        expect(result?.terminalReply).toEqual({ disposition });
        expect(result?.replyText).toBeUndefined();
      } finally {
        owner.close();
      }
    },
  );
});

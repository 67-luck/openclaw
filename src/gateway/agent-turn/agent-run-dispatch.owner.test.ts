import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import type { AgentCommandDeliveryResult } from "../../agents/command/delivery-result.js";
import type { AgentCommandOpts } from "../../agents/command/types.js";
import { SessionFollowupCompletion } from "../../agents/subagents/completion/session-followup-completion.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import * as userTurnTranscript from "../../sessions/user-turn-transcript.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { abortChatRunById, type ChatAbortControllerEntry } from "../chat-abort.js";
import { setGatewayDedupeEntries } from "./agent-dedupe.js";
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";

const mocks = vi.hoisted(() => ({
  agentCommand: vi.fn(
    async (
      _options: AgentCommandOpts,
    ): Promise<
      Pick<AgentCommandDeliveryResult, "payloads"> & {
        meta: Partial<AgentCommandDeliveryResult["meta"]>;
      }
    > => ({ payloads: [], meta: {} }),
  ),
  clearAgentRunContext: vi.fn(),
}));
vi.mock("../../commands/agent.js", () => ({ agentCommandFromGatewayIngress: mocks.agentCommand }));
vi.mock("../../runtime.js", () => ({ defaultRuntime: {} }));
vi.mock(import("../../infra/agent-run-registry.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  clearAgentRunContext: mocks.clearAgentRunContext,
  validateAgentRunDelegatedAuthority: () => true,
}));
vi.mock("./agent-dedupe.js", () => ({ setGatewayDedupeEntries: vi.fn() }));

describe("Gateway dispatch run ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentCommand.mockImplementation(async () => ({ payloads: [], meta: {} }));
  });

  function createFollowupDispatch() {
    const f = createTrackedDispatch();
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
    const dispatch = (
      runId = f.runId,
      entry = f.entry,
      assertCurrent?: () => void,
      onSettled?: Parameters<typeof dispatchAgentRunFromGateway>[0]["onSettled"],
    ) => {
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
        followupCompletion: owner,
        onSettled,
      });
    };
    return { f, owner, dispatch };
  }

  it("joins a captured terminal save when command startup fails before its delivery hook", async () => {
    const { runId, sessionKey, context, entry } = createTrackedDispatch();
    const finishCommand = createDeferred();
    const saving = createDeferred();
    const finishSave = createDeferred();
    mocks.agentCommand.mockImplementationOnce(async () => {
      await finishCommand.promise;
      throw new Error("Synthetic startup failure");
    });
    const emitFinal = vi.fn();
    const completion = dispatchAgentRunFromGateway({
      admittedRunEntry: entry,
      ingressOpts: {
        message: "Synthetic startup",
        sessionKey,
        allowModelOverride: false,
        abortSignal: entry.controller.signal,
      },
      runId,
      dedupeKeys: [],
      abortController: entry.controller,
      cleanupAbortController: vi.fn(),
      io: { emitAcceptance: vi.fn(), emitFinal },
      context,
    });
    try {
      const producer = entry.resolveTerminalProducer?.();
      expect(
        producer?.handoff(async (producerCompleted) => {
          await producerCompleted;
          saving.resolve();
          await finishSave.promise;
        }),
      ).toBe(true);
      entry.controller.abort();
      finishCommand.resolve();
      await saving.promise;
      expect(emitFinal).not.toHaveBeenCalled();
      finishSave.resolve();
      await completion;
      expect(emitFinal).toHaveBeenCalledOnce();
      expect(entry.resolveTerminalProducer?.()).toBeUndefined();
    } finally {
      finishCommand.resolve();
      finishSave.resolve();
      await completion;
    }
  });

  it.each(["registration", "controller", "session", "instance"] as const)(
    "rejects captured transcript custody after %s replacement",
    async (replacement) => {
      const { runId, sessionKey, context, entry } = createTrackedDispatch();
      const finish = createDeferred();
      mocks.agentCommand.mockImplementationOnce(async () => {
        await finish.promise;
        return { payloads: [], meta: {} };
      });
      const completion = dispatchAgentRunFromGateway({
        admittedRunEntry: entry,
        ingressOpts: {
          message: "Synthetic stale producer",
          sessionKey,
          allowModelOverride: false,
          abortSignal: entry.controller.signal,
        },
        runId,
        dedupeKeys: [],
        abortController: entry.controller,
        cleanupAbortController: vi.fn(),
        io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
        context,
      });
      try {
        const producer = entry.resolveTerminalProducer?.();
        expect(producer).toBeDefined();
        if (replacement === "registration") {
          context.chatAbortControllers.set(runId, { ...entry });
        } else if (replacement === "controller") {
          entry.controller = new AbortController();
        } else if (replacement === "session") {
          entry.sessionId = "successor-session";
        } else {
          entry.operationalRunInstance = { runId, instanceId: "successor-instance" };
        }
        const save = vi.fn(async () => {});
        expect(producer?.handoff(save)).toBe(false);
        expect(save).not.toHaveBeenCalled();
      } finally {
        finish.resolve();
        await completion;
      }
    },
  );

  it("joins input completion and cleanup before releasing followup custody without releasing a successor", async () => {
    const { f, owner } = createFollowupDispatch();
    const { runId, sessionKey, context, entry } = f;
    owner.markAccepted(runId);
    const inputEntered = createDeferred();
    const resumeInput = createDeferred();
    const cleanupEntered = createDeferred();
    const resumeCleanup = createDeferred();
    const order: string[] = [];
    const finish = owner.finishExecution.bind(owner);
    const finishExecution = vi.spyOn(owner, "finishExecution");
    finishExecution.mockImplementation((...args) => {
      order.push("release");
      return finish(...args);
    });
    mocks.agentCommand.mockImplementationOnce(async (options) => {
      order.push("invoke");
      await options.onExecutionStarted?.();
      return { payloads: [], meta: {} };
    });
    const recorder = userTurnTranscript.createUserTurnTranscriptRecorder({
      input: { text: "joined input", timestamp: 1 },
      target: {
        agentId: "main",
        sessionId: entry.sessionId,
        sessionKey,
        sessionEntry: undefined,
      },
    });
    const recorded = buildAgentRunTerminalOutcome({ status: "timeout", stopReason: "rpc" });
    const completeInput = vi
      .spyOn(userTurnTranscript, "completeUserTurnTranscriptProcessing")
      .mockImplementationOnce(async (selected) => {
        expect(selected).toBe(recorder);
        inputEntered.resolve();
        await resumeInput.promise;
        order.push("input");
        return recorded;
      });
    const cleanupAbortController = vi.fn(async () => {
      cleanupEntered.resolve();
      await resumeCleanup.promise;
      if (context.chatAbortControllers.get(runId) === entry) {
        context.chatAbortControllers.delete(runId);
      }
      order.push("cleanup");
    });
    const emitFinal = vi.fn(() => {
      order.push("final");
    });
    const completion = dispatchAgentRunFromGateway({
      admittedRunEntry: entry,
      assertSettlementCurrent() {},
      ingressOpts: {
        message: "joined input",
        sessionKey,
        allowModelOverride: false,
        userTurnTranscriptRecorder: recorder,
        abortSignal: entry.controller.signal,
      },
      runId,
      dedupeKeys: [`agent:${runId}`],
      abortController: entry.controller,
      cleanupAbortController,
      io: { emitAcceptance: vi.fn(), emitFinal },
      context,
      followupCompletion: owner,
    });
    try {
      const producer = entry.resolveTerminalProducer?.();
      expect(producer).toBeDefined();
      await Promise.race([inputEntered.promise, completion]);
      expect(mocks.agentCommand).toHaveBeenCalledOnce();
      expect(completeInput).toHaveBeenCalledOnce();
      expect(setGatewayDedupeEntries).not.toHaveBeenCalled();
      expect(cleanupAbortController).not.toHaveBeenCalled();
      expect(emitFinal).not.toHaveBeenCalled();
      expect(finishExecution).not.toHaveBeenCalled();
      resumeInput.resolve();
      await Promise.race([cleanupEntered.promise, completion]);
      expect(cleanupAbortController).toHaveBeenCalledOnce();
      expect(emitFinal).not.toHaveBeenCalled();
      expect(finishExecution).not.toHaveBeenCalled();
      expect(entry.controller.signal.aborted).toBe(false);
      expect(entry.resolveTerminalProducer?.()).toBeUndefined();
      const lateSave = vi.fn(async () => {});
      expect(producer?.handoff(lateSave)).toBe(false);
      expect(lateSave).not.toHaveBeenCalled();
      const successor = { ...entry, controller: new AbortController() };
      context.chatAbortControllers.set(runId, successor);
      resumeCleanup.resolve();
      const result = await completion;
      expect(result.terminalOutcome).toBe(recorded);
      expect(order).toEqual(["invoke", "input", "cleanup", "final", "release"]);
      expect(completeInput).toHaveBeenCalledOnce();
      expect(cleanupAbortController).toHaveBeenCalledOnce();
      expect(finishExecution).toHaveBeenCalledOnce();
      expect(emitFinal).toHaveBeenCalledExactlyOnceWith(
        [true, expect.objectContaining({ status: "timeout" }), undefined],
        { runId },
      );
      expect(context.chatAbortControllers.get(runId)).toBe(successor);
      expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
    } finally {
      resumeInput.resolve();
      resumeCleanup.resolve();
      await completion;
      completeInput.mockRestore();
      owner.close();
    }
  });

  it.each(["original", "successor", "unadmitted"] as const)(
    "fences joined cleanup against the %s registry owner after the abort map is empty",
    async (owner) => {
      const registry = await vi.importActual<typeof import("../../infra/agent-run-registry.js")>(
        "../../infra/agent-run-registry.js",
      );
      registry.resetAgentRunRegistryForTest();
      mocks.clearAgentRunContext.mockImplementation(registry.clearAgentRunContext);
      const { runId, sessionKey, context, entry } = createTrackedDispatch();
      const cleanupEntered = createDeferred();
      const resumeCleanup = createDeferred();
      const registeredContext = { sessionKey, lifecycleGeneration: entry.lifecycleGeneration };
      registry.claimAgentRunContext(runId, registeredContext, { executionOwner: entry });
      const completion = dispatchAgentRunFromGateway({
        admittedRunEntry: owner === "unadmitted" ? undefined : entry,
        ingressOpts: {
          message: "retain the admitted execution owner",
          sessionKey,
          lifecycleGeneration: entry.lifecycleGeneration,
          allowModelOverride: false,
          abortSignal: entry.controller.signal,
        },
        runId,
        dedupeKeys: [],
        abortController: entry.controller,
        cleanupAbortController: async () => {
          cleanupEntered.resolve();
          await resumeCleanup.promise;
        },
        io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
        context,
      });
      try {
        await Promise.race([cleanupEntered.promise, completion]);
        expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
        const executionOwner = owner === "original" ? entry : { ...entry };
        registry.claimAgentRunContext(runId, registeredContext, { executionOwner });
        context.chatAbortControllers.set(runId, executionOwner);
        context.chatAbortControllers.delete(runId);
        const onClearRequested = vi.fn();
        const claim = registry.claimAgentRunContext(runId, registeredContext, {
          trackOwner: true,
          ownsContext: true,
          onClearRequested,
        });
        const retained = registry.getAgentRunContext(runId);
        resumeCleanup.resolve();
        await completion;
        expect(registry.getAgentRunContext(runId)).toBe(retained);
        if (owner === "original") {
          expect(onClearRequested).toHaveBeenCalledExactlyOnceWith(claim);
        } else {
          expect(onClearRequested).not.toHaveBeenCalled();
        }
        if (owner === "unadmitted") {
          expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
        } else {
          expect(mocks.clearAgentRunContext).toHaveBeenCalledExactlyOnceWith(
            runId,
            entry.lifecycleGeneration,
            undefined,
            entry,
          );
        }
      } finally {
        resumeCleanup.resolve();
        await completion;
        mocks.clearAgentRunContext.mockReset();
        registry.resetAgentRunRegistryForTest();
      }
    },
  );

  it.each(["sync", "async"] as const)(
    "retains the original followup owner when %s run cleanup fails",
    async (delivery) => {
      const { f, owner } = createFollowupDispatch();
      const { runId, sessionKey, context, entry } = f;
      owner.markAccepted(runId);
      const finishExecution = vi.spyOn(owner, "finishExecution");
      const primary = new Error("command failed before cleanup");
      const cleanupFailure = new Error("run owner cleanup failed");
      const entered = createDeferred();
      const finish = createDeferred();
      mocks.agentCommand.mockImplementationOnce(async (options) => {
        await options.onExecutionStarted?.();
        throw primary;
      });
      const cleanupAbortController = vi.fn(() => {
        entered.resolve();
        if (delivery === "sync") {
          throw cleanupFailure;
        }
        return finish.promise;
      });
      const assertSettlementCurrent = vi.fn(() => {
        if (context.chatAbortControllers.get(runId) !== entry) {
          throw new Error("Original Gateway run admission was replaced");
        }
      });
      const emitFinal = vi.fn();
      let completed = false;
      const completion = dispatchAgentRunFromGateway({
        admittedRunEntry: entry,
        assertSettlementCurrent,
        ingressOpts: {
          message: "failed joined cleanup",
          sessionKey,
          allowModelOverride: false,
          abortSignal: entry.controller.signal,
        },
        runId,
        dedupeKeys: [`agent:${runId}`],
        abortController: entry.controller,
        cleanupAbortController,
        io: { emitAcceptance: vi.fn(), emitFinal },
        context,
        followupCompletion: owner,
      }).then(
        () => {
          completed = true;
          return { ok: true as const };
        },
        (error: unknown) => {
          completed = true;
          return { ok: false as const, error };
        },
      );
      try {
        await Promise.race([entered.promise, completion]);
        expect(cleanupAbortController).toHaveBeenCalledOnce();
        expect(assertSettlementCurrent).toHaveBeenCalledOnce();
        expect(assertSettlementCurrent.mock.results).toEqual([
          { type: "return", value: undefined },
        ]);
        expect(finishExecution).not.toHaveBeenCalled();
        expect(emitFinal).not.toHaveBeenCalled();
        expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
        if (delivery === "async") {
          expect(completed).toBe(false);
          finish.reject(cleanupFailure);
        }
        const outcome = await completion;
        expect(outcome).toEqual({ ok: false, error: cleanupFailure });
        if (outcome.ok) {
          throw new Error("failed owner cleanup unexpectedly completed");
        }
        expect(outcome.error).toBe(cleanupFailure);
        expect(cleanupAbortController).toHaveBeenCalledOnce();
        expect(finishExecution).not.toHaveBeenCalled();
        expect(context.chatAbortControllers.get(runId)).toBe(entry);
        expect(emitFinal).not.toHaveBeenCalled();
        expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
      } finally {
        finish.resolve();
        await completion;
        owner.close();
      }
    },
  );

  it("keeps rejected pre-dispatch results with their admitted registration", async () => {
    const { runId, sessionKey, context, entry } = createTrackedDispatch();
    const successor: ChatAbortControllerEntry = {
      ...entry,
      controller: new AbortController(),
      sessionId: "successor-session",
      sessionKey: "agent:main:successor-session",
      operationalRunInstance: { runId, instanceId: "successor-instance" },
    };
    context.chatAbortControllers.set(runId, successor);
    const emitFinal = vi.fn();
    await dispatchAgentRunFromGateway({
      assertCurrent() {
        if (context.chatAbortControllers.get(runId) !== entry) {
          throw new Error("Gateway run owner replaced");
        }
      },
      admittedRunEntry: entry,
      ingressOpts: {
        message: "run only for the admitted owner",
        sessionKey,
        allowModelOverride: false,
      },
      runId,
      dedupeKeys: [`agent:${runId}`],
      abortController: entry.controller,
      cleanupAbortController: vi.fn(),
      io: { emitAcceptance: vi.fn(), emitFinal },
      context,
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.get(runId)).toBe(successor);
    expect(setGatewayDedupeEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        session: {
          sessionKey,
          sessionId: entry.sessionId,
          agentId: entry.agentId,
          lifecycleGeneration: entry.lifecycleGeneration,
        },
        entry: expect.objectContaining({ ok: false }),
      }),
    );
    expect(emitFinal).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure", "cancelled"] as const)(
    "awaits continuation settlement before releasing the run and reporting %s",
    async (outcome) => {
      const { runId, sessionKey, context, entry } = createTrackedDispatch();
      const entered = createDeferred();
      const resume = createDeferred();
      mocks.agentCommand.mockImplementationOnce(async () => {
        if (outcome === "failure") {
          throw new Error("Synthetic active run failure");
        }
        if (outcome === "cancelled") {
          entry.controller.abort();
          throw entry.controller.signal.reason;
        }
        return { payloads: [], meta: {} };
      });
      const emitFinal = vi.fn();
      const cleanupAbortController = vi.fn();
      const onSettled = vi.fn(async () => {
        entered.resolve();
        await resume.promise;
        return true;
      });
      const completion = dispatchAgentRunFromGateway({
        admittedRunEntry: entry,
        ingressOpts: { message: "continue", sessionKey, allowModelOverride: false },
        runId,
        dedupeKeys: [],
        abortController: entry.controller,
        cleanupAbortController,
        io: { emitAcceptance: vi.fn(), emitFinal },
        context,
        onSettled,
      });
      try {
        await entered.promise;
        expect(emitFinal).not.toHaveBeenCalled();
        expect(cleanupAbortController).not.toHaveBeenCalled();
        resume.resolve();
        await completion;
        expect(cleanupAbortController).toHaveBeenCalledOnce();
        expect(emitFinal).toHaveBeenCalledOnce();
        expect(emitFinal).toHaveBeenCalledWith(
          [
            outcome !== "failure",
            expect.objectContaining({
              status: outcome === "success" ? "ok" : outcome === "failure" ? "error" : "timeout",
            }),
            outcome === "failure" ? expect.any(Object) : undefined,
          ],
          expect.objectContaining({ runId }),
        );
        expect(cleanupAbortController.mock.invocationCallOrder[0]).toBeLessThan(
          emitFinal.mock.invocationCallOrder[0] ?? Infinity,
        );
      } finally {
        resume.resolve();
        await completion;
      }
    },
  );

  it.each(["same-session", "different-session", "removed-by-abort", "mutated-entry"] as const)(
    "settles retained followup custody without releasing a %s registration",
    async (replacement) => {
      const { f, owner, dispatch } = createFollowupDispatch();
      const { runId, sessionKey, context, entry } = f;
      const successor = {
        ...entry,
        controller: new AbortController(),
        operationalRunInstance: { runId, instanceId: "successor" },
        sessionKey: replacement === "same-session" ? sessionKey : "agent:main:other",
      };
      const finishCommand = createDeferred();
      const saving = createDeferred();
      const finishSave = createDeferred();
      mocks.agentCommand.mockImplementationOnce(async () => {
        await finishCommand.promise;
        return {
          payloads: [],
          meta: {
            ...(entry.controller.signal.aborted ? { aborted: true, stopReason: "rpc" } : {}),
            terminalReply: { disposition: "visible", text: "Original result" },
          },
        };
      });
      let observed = false;
      const reply = owner.take().then(
        (result) => {
          observed = true;
          return { result };
        },
        (error: unknown) => {
          observed = true;
          return { error };
        },
      );
      const completion = dispatch();
      try {
        const producer = entry.resolveTerminalProducer?.();
        expect(
          producer?.handoff(async (producerCompleted) => {
            await producerCompleted;
            saving.resolve();
            await finishSave.promise;
          }),
        ).toBe(true);
        if (replacement === "removed-by-abort") {
          expect(
            abortChatRunById(createChatAbortOps(context), { runId, sessionKey, stopReason: "rpc" }),
          ).toEqual({ aborted: true });
          expect(context.chatAbortControllers.has(runId)).toBe(false);
        } else if (replacement === "mutated-entry") {
          entry.sessionKey = successor.sessionKey;
        } else {
          context.chatAbortControllers.set(runId, successor);
        }
        finishCommand.resolve();
        await saving.promise;
        expect(observed).toBe(false);
        finishSave.resolve();
        await completion;
        if (replacement === "same-session" || replacement === "mutated-entry") {
          await expect(reply).resolves.toMatchObject({
            error: expect.objectContaining({
              message: expect.stringContaining("lost its Gateway registration"),
            }),
          });
        } else {
          await expect(reply).resolves.toMatchObject({
            result:
              replacement === "removed-by-abort"
                ? { status: "error", stopReason: "rpc" }
                : { status: "ok", replyText: "Original result" },
          });
        }
        if (replacement !== "removed-by-abort") {
          expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
          expect(context.chatAbortControllers.get(runId)).toBe(
            replacement === "mutated-entry" ? entry : successor,
          );
        }
        expect(setGatewayDedupeEntries).toHaveBeenCalledWith(
          expect.objectContaining({
            session: {
              sessionKey: replacement === "mutated-entry" ? entry.sessionKey : sessionKey,
              sessionId: entry.sessionId,
              agentId: entry.agentId,
              lifecycleGeneration: entry.lifecycleGeneration,
            },
          }),
        );
      } finally {
        finishCommand.resolve();
        finishSave.resolve();
        await completion;
        owner.close();
        await reply;
      }
    },
  );

  it.each(["Primitive command failure", 42])(
    "retains the rendered message and original cause for synchronous throw %s",
    async (failure) => {
      const { runId, sessionKey, context, entry } = createTrackedDispatch();
      mocks.agentCommand.mockImplementationOnce(() => {
        // oxlint-disable-next-line typescript/only-throw-error -- Exercise JavaScript primitive throws at the dispatch boundary.
        throw failure;
      });
      const emitFinal = vi.fn();
      await dispatchAgentRunFromGateway({
        admittedRunEntry: entry,
        ingressOpts: { message: "continue", sessionKey, allowModelOverride: false },
        runId,
        dedupeKeys: [],
        abortController: entry.controller,
        cleanupAbortController: vi.fn(),
        io: { emitAcceptance: vi.fn(), emitFinal },
        context,
      });
      expect(emitFinal).toHaveBeenCalledWith(
        [
          false,
          expect.objectContaining({ status: "error", summary: String(failure) }),
          expect.objectContaining({
            message: String(failure),
            cause: expect.objectContaining({ cause: failure }),
          }),
        ],
        expect.objectContaining({ error: String(failure) }),
      );
    },
  );
  it("keeps one logical owner across yield and delivers only the admitted successor reply", async () => {
    const { f, owner, dispatch } = createFollowupDispatch();
    const settlementEntered = createDeferred();
    const finishSettlement = createDeferred();
    const finishExecution = vi.spyOn(owner, "finishExecution");
    let predecessor: ReturnType<typeof dispatch> | undefined;
    let successorDispatch: ReturnType<typeof dispatch> | undefined;
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
      predecessor = dispatch(f.runId, f.entry, undefined, async () => {
        settlementEntered.resolve();
        await finishSettlement.promise;
        return true;
      });
      await Promise.race([settlementEntered.promise, predecessor]);
      expect(finishExecution).not.toHaveBeenCalled();
      finishSettlement.resolve();
      await predecessor;
      expect(finishExecution).toHaveBeenCalledWith(f.runId);
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
        await opts.onExecutionStarted?.();
        return {
          payloads: [{ text: "not canonical", mediaUrl: null }],
          meta: { terminalReply: { disposition: "visible", text: "B_YIELD_DONE" } },
        };
      });
      successorDispatch = dispatch(successor.runId, successorEntry);
      await successorDispatch;
      await expect(owner.take()).resolves.toMatchObject({
        status: "ok",
        replyText: "B_YIELD_DONE",
        terminalReply: { disposition: "visible", text: "B_YIELD_DONE" },
      });
      expect(mocks.agentCommand).toHaveBeenCalledTimes(2);
    } finally {
      finishSettlement.resolve();
      await Promise.allSettled([predecessor, successorDispatch]);
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
      const { owner, dispatch } = createFollowupDispatch();
      mocks.agentCommand.mockResolvedValueOnce({ payloads: [], meta });
      try {
        await dispatch();
        await expect(owner.take()).resolves.toMatchObject({
          status,
          ...(stopReason ? { stopReason } : {}),
        });
      } finally {
        owner.close();
      }
    },
  );

  it("does not invoke a followup after its admitted registration was replaced", async () => {
    const { f, owner, dispatch } = createFollowupDispatch();
    const successor = { ...f.entry, controller: new AbortController() };
    f.context.chatAbortControllers.set(f.runId, successor);
    try {
      await expect(dispatch()).rejects.toThrow("lost its Gateway registration");
      expect(mocks.agentCommand).not.toHaveBeenCalled();
      expect(f.context.chatAbortControllers.get(f.runId)).toBe(successor);
      await expect(owner.take()).rejects.toThrow("lost its Gateway registration");
    } finally {
      owner.close();
    }
  });

  it("settles an admitted followup that fails before physical activation", async () => {
    const { f, owner, dispatch } = createFollowupDispatch();
    try {
      await dispatch(f.runId, f.entry, () => {
        throw new Error("activation denied");
      });
      expect(mocks.agentCommand).not.toHaveBeenCalled();
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
      const { owner, dispatch } = createFollowupDispatch();
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

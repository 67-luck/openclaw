// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { taskReceipt, useDispatchOwnerFixture } from "./agent-run-dispatch.owner.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import * as userTurnTranscript from "../../sessions/user-turn-transcript.js";
import type { CreatedDetachedTaskRun } from "../../tasks/detached-task-runtime-contract.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import type { TaskRunOwner } from "../../tasks/task-run-owner.types.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import { setGatewayDedupeEntries } from "./agent-dedupe.js";
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";

describe("Gateway dispatch task creation ownership", () => {
  const mocks = useDispatchOwnerFixture();

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
      taskTrackingMode: "none",
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
        taskTrackingMode: "none",
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

  it("joins task binding, input completion and cleanup without releasing a successor", async () => {
    const { runId, sessionKey, context, entry, task } = createTrackedDispatch();
    const bindingEntered = createDeferred();
    const resumeBinding = createDeferred();
    const inputEntered = createDeferred();
    const resumeInput = createDeferred();
    const cleanupEntered = createDeferred();
    const resumeCleanup = createDeferred();
    const receipt = taskReceipt(
      task,
      vi.fn(async () => false),
    );
    const bind = receipt.bindRunOwner.bind(receipt);
    const release = vi.fn();
    const order: string[] = [];
    receipt.bindRunOwner = async (...args) => {
      bindingEntered.resolve();
      await resumeBinding.promise;
      const binding = await bind(...args);
      release.mockImplementation(() => {
        order.push("release");
        binding.release();
      });
      order.push("bound");
      return { ...binding, release };
    };
    mocks.createTaskReceipt.mockResolvedValue(receipt);
    mocks.agentCommand.mockImplementationOnce(async (options) => {
      order.push("invoke");
      await options.onExecutionStarted?.();
      return { payloads: [], meta: {} };
    });
    const recorder = userTurnTranscript.createUserTurnTranscriptRecorder({
      input: { text: task.task, timestamp: 1 },
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
        message: task.task,
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
      taskTrackingMode: "cli",
    });
    try {
      const producer = entry.resolveTerminalProducer?.();
      expect(producer).toBeDefined();
      await Promise.race([bindingEntered.promise, completion]);
      expect(mocks.agentCommand).not.toHaveBeenCalled();
      expect(completeInput).not.toHaveBeenCalled();
      expect(emitFinal).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      resumeBinding.resolve();
      await Promise.race([inputEntered.promise, completion]);
      expect(mocks.agentCommand).toHaveBeenCalledOnce();
      expect(completeInput).toHaveBeenCalledOnce();
      expect(mocks.finalizeActive).not.toHaveBeenCalled();
      expect(setGatewayDedupeEntries).not.toHaveBeenCalled();
      expect(cleanupAbortController).not.toHaveBeenCalled();
      expect(emitFinal).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      resumeInput.resolve();
      await Promise.race([cleanupEntered.promise, completion]);
      expect(task.status).toBe("cancelled");
      expect(cleanupAbortController).toHaveBeenCalledOnce();
      expect(emitFinal).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(entry.controller.signal.aborted).toBe(false);
      expect(entry.resolveTerminalProducer?.()).toBeUndefined();
      const lateSave = vi.fn(async () => {});
      expect(producer?.handoff(lateSave)).toBe(false);
      expect(lateSave).not.toHaveBeenCalled();
      const successor = { ...entry, controller: new AbortController() };
      const successorTask = { ...task, status: "running" as const };
      const successorOwner = { task: successorTask, cancel: vi.fn<TaskRunOwner["cancel"]>() };
      context.chatAbortControllers.set(runId, successor);
      mocks.taskRunOwners.set(task.taskId, successorOwner);
      resumeCleanup.resolve();
      const result = await completion;
      expect(result.terminalOutcome).toBe(recorded);
      expect(order).toEqual(["bound", "invoke", "input", "cleanup", "final", "release"]);
      expect(completeInput).toHaveBeenCalledOnce();
      expect(cleanupAbortController).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(emitFinal).toHaveBeenCalledExactlyOnceWith(
        [true, expect.objectContaining({ status: "timeout" }), undefined],
        { runId },
      );
      expect(context.chatAbortControllers.get(runId)).toBe(successor);
      expect(mocks.taskRunOwners.get(task.taskId)).toBe(successorOwner);
      expect(successorTask.status).toBe("running");
      expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
    } finally {
      resumeBinding.resolve();
      resumeInput.resolve();
      resumeCleanup.resolve();
      await completion;
      completeInput.mockRestore();
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
        taskTrackingMode: "none",
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
    "retains the original task owner when %s run cleanup fails",
    async (delivery) => {
      const { runId, sessionKey, context, entry, task } = createTrackedDispatch();
      const primary = new Error("command failed before cleanup");
      const cleanupFailure = new Error("run owner cleanup failed");
      const entered = createDeferred();
      const finish = createDeferred();
      mocks.createTaskReceipt.mockResolvedValue(
        taskReceipt(
          task,
          vi.fn(async () => false),
        ),
      );
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
          message: task.task,
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
        taskTrackingMode: "cli",
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
        const originalOwner = mocks.taskRunOwners.get(task.taskId);
        expect(originalOwner?.task).toBe(task);
        expect(task.status).toBe("failed");
        expect(task.error).toBe(primary.message);
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
        expect(mocks.taskRunOwners.get(task.taskId)).toBe(originalOwner);
        expect(context.chatAbortControllers.get(runId)).toBe(entry);
        expect(emitFinal).not.toHaveBeenCalled();
        expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
      } finally {
        finish.resolve();
        await completion;
      }
    },
  );

  it.each(["success", "failure", "cancelled"] as const)(
    "awaits the captured active terminal owner before Gateway completion (%s)",
    async (outcome) => {
      const { runId, sessionKey, context, entry, task } = createTrackedDispatch();
      const entered = createDeferred();
      const resume = createDeferred();
      const settleUnstarted = vi.fn(async () => false);
      mocks.createTaskReceipt.mockResolvedValue(taskReceipt(task, settleUnstarted));
      mocks.agentCommand.mockImplementationOnce(async (options) => {
        await options.onExecutionStarted?.();
        if (outcome === "failure") {
          throw new Error("Synthetic active run failure");
        }
        if (outcome === "cancelled") {
          entry.controller.abort();
        }
        return {
          payloads: [],
          meta: outcome === "cancelled" ? { aborted: true, stopReason: "rpc" } : {},
        };
      });
      mocks.finalizeActive.mockImplementation(async (selected, terminal, canSettle) => {
        entered.resolve();
        await resume.promise;
        if (!canSettle(selected)) {
          return;
        }
        Object.assign(selected, terminal);
      });
      const emitFinal = vi.fn();
      const onSettled = vi.fn(() => true);
      const completion = dispatchAgentRunFromGateway({
        admittedRunEntry: entry,
        assertSettlementCurrent() {},
        ingressOpts: { message: task.task, sessionKey, allowModelOverride: false },
        runId,
        dedupeKeys: [],
        abortController: entry.controller,
        cleanupAbortController: vi.fn(),
        io: { emitAcceptance: vi.fn(), emitFinal },
        context,
        taskTrackingMode: "cli",
        onSettled,
      });
      try {
        await Promise.race([entered.promise, completion]);
        expect(mocks.finalizeActive).toHaveBeenCalledOnce();
        expect(mocks.finalizeTrackedTask).not.toHaveBeenCalled();
        expect(settleUnstarted).not.toHaveBeenCalled();
        expect(emitFinal).not.toHaveBeenCalled();
        expect(onSettled).not.toHaveBeenCalled();
        resume.resolve();
        await completion;
        expect(task.status).toBe(
          outcome === "success" ? "succeeded" : outcome === "failure" ? "failed" : "cancelled",
        );
        expect(emitFinal).toHaveBeenCalledOnce();
        expect(onSettled).toHaveBeenCalledOnce();
      } finally {
        resume.resolve();
        await completion;
      }
    },
  );

  it.each(["Gateway", "same-session run", "task owner", "different-session run"] as const)(
    "rechecks active terminal authority after waiting for the %s change",
    async (replacement) => {
      const { runId, sessionKey, context, entry, task } = createTrackedDispatch();
      const entered = createDeferred();
      const resume = createDeferred();
      let gatewayCurrent = true;
      mocks.createTaskReceipt.mockResolvedValue(taskReceipt(task, async () => false));
      mocks.finalizeActive.mockImplementation(async (selected, terminal, canSettle) => {
        entered.resolve();
        await resume.promise;
        if (!canSettle(selected)) {
          return;
        }
        Object.assign(selected, terminal);
      });
      const completion = dispatchAgentRunFromGateway({
        admittedRunEntry: entry,
        assertSettlementCurrent() {
          if (!gatewayCurrent) {
            throw new Error("Gateway retired");
          }
        },
        ingressOpts: { message: task.task, sessionKey, allowModelOverride: false },
        runId,
        dedupeKeys: [],
        abortController: entry.controller,
        cleanupAbortController: vi.fn(),
        io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
        context,
        taskTrackingMode: "cli",
      });
      try {
        await Promise.race([entered.promise, completion]);
        expect(mocks.finalizeActive).toHaveBeenCalledOnce();
        if (replacement === "Gateway") {
          gatewayCurrent = false;
        } else if (replacement === "task owner") {
          mocks.taskRunOwners.set(task.taskId, { task, cancel: vi.fn<TaskRunOwner["cancel"]>() });
        } else {
          context.chatAbortControllers.set(runId, {
            ...entry,
            controller: new AbortController(),
            operationalRunInstance: { runId, instanceId: "successor" },
            sessionKey: replacement === "different-session run" ? "agent:main:other" : sessionKey,
          });
        }
        resume.resolve();
        await completion;
        expect(task.status).toBe(replacement === "different-session run" ? "succeeded" : "running");
        expect(mocks.finalizeTrackedTask).not.toHaveBeenCalled();
        expect(setGatewayDedupeEntries).toHaveBeenCalledWith(
          expect.objectContaining({
            session: {
              sessionKey,
              sessionId: entry.sessionId,
              agentId: entry.agentId,
              lifecycleGeneration: entry.lifecycleGeneration,
            },
          }),
        );
      } finally {
        resume.resolve();
        await completion;
      }
    },
  );
  it("keeps rejected pre-dispatch results with their admitted registration", async () => {
    const { runId, sessionKey, context, entry, task } = createTrackedDispatch();
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
      ingressOpts: { message: task.task, sessionKey, allowModelOverride: false },
      runId,
      dedupeKeys: [`agent:${runId}`],
      abortController: entry.controller,
      cleanupAbortController: vi.fn(),
      io: { emitAcceptance: vi.fn(), emitFinal },
      context,
      taskTrackingMode: "none",
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

  it("settles cancellation when source retirement races committed task creation", async () => {
    const { runId, sessionKey, context, entry, task } = createTrackedDispatch();
    const creation = createDeferred<CreatedDetachedTaskRun>();
    let sourceCurrent = true;
    const settleUnstarted = vi.fn<CreatedDetachedTaskRun["settleUnstarted"]>(
      async (terminal, canSettle) => {
        if (!canSettle(task)) {
          return false;
        }
        Object.assign(task, terminal);
        return true;
      },
    );
    mocks.createTaskReceipt.mockReturnValue(creation.promise);
    const emitFinal = vi.fn();
    const completion = dispatchAgentRunFromGateway({
      assertCurrent() {
        if (!sourceCurrent) {
          throw new Error("operator source authority is no longer active");
        }
      },
      assertSettlementCurrent() {},
      ingressOpts: { message: task.task, sessionKey, allowModelOverride: false },
      runId,
      dedupeKeys: [`agent:${runId}`],
      admittedRunEntry: entry,
      abortController: entry.controller,
      cleanupAbortController: vi.fn(),
      io: { emitAcceptance: vi.fn(), emitFinal },
      context,
      taskTrackingMode: "cli",
    });
    sourceCurrent = false;
    entry.controller.abort();
    creation.resolve(taskReceipt(task, settleUnstarted));
    await completion;

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mocks.bindTaskRunOwner).not.toHaveBeenCalled();
    expect(settleUnstarted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: "cancelled" }),
      expect.any(Function),
    );
    expect(task.status).toBe("cancelled");
    expect(emitFinal).toHaveBeenCalledExactlyOnceWith(
      [
        true,
        expect.objectContaining({
          runId,
          status: "timeout",
          summary: "aborted",
          stopReason: "rpc",
        }),
        undefined,
      ],
      { runId },
    );
  });

  it.each(["current", "different-session", "adopted-task"] as const)(
    "waits for task creation before activation and respects owner replacement (%s)",
    async (replacement) => {
      const { runId, sessionKey, context, entry, task } = createTrackedDispatch();
      const creation = createDeferred<CreatedDetachedTaskRun>();
      const settleUnstarted = vi.fn<CreatedDetachedTaskRun["settleUnstarted"]>(
        async (terminal, canSettle) => {
          if (!canSettle(task)) {
            return false;
          }
          Object.assign(task, terminal);
          return true;
        },
      );
      const receipt = taskReceipt(task, settleUnstarted);
      mocks.createRunningTaskRun.mockReturnValue(task);
      mocks.createTaskReceipt.mockImplementation((_params, assertCurrent) => {
        assertCurrent();
        return creation.promise;
      });
      const cleanupAbortController = vi.fn();
      const emitFinal = vi.fn();
      const onSettled = vi.fn(async () => true);
      const completion = dispatchAgentRunFromGateway({
        assertCurrent() {
          if (context.chatAbortControllers.get(runId) !== entry) {
            throw new Error("Gateway run owner replaced");
          }
        },
        ingressOpts: {
          message: task.task,
          sessionKey,
          allowModelOverride: false,
        },
        runId,
        dedupeKeys: [`agent:${runId}`],
        admittedRunEntry: entry,
        abortController: entry.controller,
        cleanupAbortController,
        io: { emitAcceptance: vi.fn(), emitFinal },
        context,
        taskTrackingMode: "cli",
        assertSettlementCurrent() {},
        onSettled,
      });
      try {
        expect(mocks.agentCommand).not.toHaveBeenCalled();
        expect(mocks.bindTaskRunOwner).not.toHaveBeenCalled();
        expect(emitFinal).not.toHaveBeenCalled();
        const successor: ChatAbortControllerEntry = {
          ...entry,
          controller: new AbortController(),
          operationalRunInstance: { runId, instanceId: "replacement-instance" },
          sessionKey:
            replacement === "different-session" ? "agent:main:successor-session" : sessionKey,
        };
        const successorTask: TaskRecord =
          replacement === "adopted-task"
            ? task
            : { ...task, taskId: "successor-task", childSessionKey: successor.sessionKey };
        if (replacement !== "current") {
          context.chatAbortControllers.set(runId, successor);
        }
        // Return the acknowledged task even when its execution owner retired after commit.
        creation.resolve(receipt);
        await completion;

        expect(cleanupAbortController).toHaveBeenCalledOnce();
        expect(onSettled).toHaveBeenCalledOnce();
        expect(emitFinal).toHaveBeenCalledOnce();
        if (replacement !== "current") {
          expect(mocks.agentCommand).not.toHaveBeenCalled();
          expect(mocks.bindTaskRunOwner).not.toHaveBeenCalled();
          expect(mocks.finalizeTrackedTask).not.toHaveBeenCalled();
          expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
          expect(context.chatAbortControllers.get(runId)).toBe(successor);
          expect(settleUnstarted).toHaveBeenCalledOnce();
          expect(successorTask.status).toBe("running");
          expect(task.status).toBe(replacement === "different-session" ? "failed" : "running");
          expect(emitFinal).toHaveBeenCalledWith(
            [false, expect.objectContaining({ status: "error" }), expect.any(Object)],
            expect.objectContaining({ runId, error: "Gateway run owner replaced" }),
          );
        } else {
          expect(settleUnstarted).not.toHaveBeenCalled();
          expect(mocks.agentCommand).toHaveBeenCalledOnce();
          expect(mocks.bindTaskRunOwner).toHaveBeenCalledOnce();
          expect(mocks.finalizeActive).toHaveBeenCalledWith(
            task,
            expect.objectContaining({ status: "succeeded" }),
            expect.any(Function),
          );
          expect(emitFinal).toHaveBeenCalledWith(
            [true, expect.objectContaining({ status: "ok" }), undefined],
            { runId },
          );
        }
      } finally {
        creation.resolve(receipt);
        await completion;
      }
    },
  );

  it.each([
    { phase: "admission", replacement: "none", failed: true },
    { phase: "execution", replacement: "different-session", failed: false },
    { phase: "execution", replacement: "different-session", failed: true },
    { phase: "execution", replacement: "same-session", failed: false },
    { phase: "execution", replacement: "task-owner", failed: false },
  ] as const)(
    "settles $phase after $replacement replacement (failed=$failed)",
    async ({ phase, replacement, failed }) => {
      const { runId, sessionKey, context, entry, task } = createTrackedDispatch();
      const settleUnstarted = vi.fn<CreatedDetachedTaskRun["settleUnstarted"]>(
        async (terminal, canSettle) => {
          if (!canSettle(task)) {
            return false;
          }
          Object.assign(task, terminal);
          return true;
        },
      );
      mocks.createTaskReceipt.mockResolvedValue(taskReceipt(task, settleUnstarted));
      const adoptedOwner: TaskRunOwner = { task, cancel: vi.fn<TaskRunOwner["cancel"]>() };
      const successor: ChatAbortControllerEntry = {
        ...entry,
        controller: new AbortController(),
        operationalRunInstance: { runId, instanceId: "replacement-instance" },
        sessionKey:
          replacement === "different-session" ? "agent:main:successor-session" : sessionKey,
      };
      mocks.agentCommand.mockImplementationOnce(async (options) => {
        if (phase === "execution") {
          await options.onExecutionStarted?.();
        }
        if (replacement === "different-session" || replacement === "same-session") {
          context.chatAbortControllers.set(runId, successor);
        }
        if (replacement === "task-owner") {
          mocks.taskRunOwners.set(task.taskId, adoptedOwner);
        }
        if (failed) {
          throw new Error("Agent startup or execution failed");
        }
        return { payloads: [], meta: {} };
      });
      const cleanupAbortController = vi.fn();
      const emitFinal = vi.fn();
      await dispatchAgentRunFromGateway({
        ingressOpts: { message: task.task, sessionKey, allowModelOverride: false },
        runId,
        dedupeKeys: [`agent:${runId}`],
        admittedRunEntry: entry,
        abortController: entry.controller,
        cleanupAbortController,
        io: { emitAcceptance: vi.fn(), emitFinal },
        context,
        taskTrackingMode: "cli",
        assertSettlementCurrent() {},
      });

      expect(mocks.agentCommand).toHaveBeenCalledOnce();
      expect(cleanupAbortController).toHaveBeenCalledOnce();
      expect(emitFinal).toHaveBeenCalledOnce();
      if (phase === "admission") {
        expect(settleUnstarted).toHaveBeenCalledOnce();
        expect(task.status).toBe("failed");
        expect(mocks.finalizeTrackedTask).not.toHaveBeenCalled();
      } else {
        expect(settleUnstarted).not.toHaveBeenCalled();
        if (replacement === "different-session") {
          expect(mocks.finalizeActive).toHaveBeenCalledWith(
            task,
            expect.objectContaining({ status: failed ? "failed" : "succeeded" }),
            expect.any(Function),
          );
          expect(context.chatAbortControllers.get(runId)).toBe(successor);
          expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
        } else {
          expect(mocks.finalizeTrackedTask).not.toHaveBeenCalled();
          expect(task.status).toBe("running");
          if (replacement === "task-owner") {
            expect(mocks.taskRunOwners.get(task.taskId)).toBe(adoptedOwner);
          }
        }
      }
    },
  );

  it.each([
    { outcome: "success", replacement: "none", cleanupFails: false },
    { outcome: "abort", replacement: "none", cleanupFails: false },
    { outcome: "timeout", replacement: "none", cleanupFails: false },
    { outcome: "timeout", replacement: "same-session", cleanupFails: false },
    { outcome: "abort", replacement: "task-owner", cleanupFails: false },
    { outcome: "success", replacement: "different-session", cleanupFails: false },
    { outcome: "abort", replacement: "none", cleanupFails: true },
  ] as const)(
    "uses exact receipt for resolved $outcome before execution ($replacement, cleanupFails=$cleanupFails)",
    async ({ outcome, replacement, cleanupFails }) => {
      const { runId, sessionKey, context, entry, task } = createTrackedDispatch();
      const sibling = { ...task, taskId: "run-sibling" };
      const successor: ChatAbortControllerEntry = {
        ...entry,
        controller: new AbortController(),
        operationalRunInstance: { runId, instanceId: "replacement-instance" },
        sessionKey: replacement === "different-session" ? "agent:main:replacement" : sessionKey,
      };
      const adoptedOwner: TaskRunOwner = { task, cancel: vi.fn<TaskRunOwner["cancel"]>() };
      const entered = createDeferred();
      const resume = createDeferred();
      const settleUnstarted = vi.fn<CreatedDetachedTaskRun["settleUnstarted"]>(
        async (terminal, canSettle) => {
          entered.resolve();
          await resume.promise;
          if (cleanupFails) {
            throw new Error("Receipt settlement failed");
          }
          if (!canSettle(task)) {
            return false;
          }
          Object.assign(task, terminal);
          return true;
        },
      );
      mocks.createTaskReceipt.mockResolvedValue(taskReceipt(task, settleUnstarted));
      // A run-scoped finalizer would also write this unrelated matching sibling.
      mocks.finalizeTrackedTask.mockImplementation((terminal: { status: TaskRecord["status"] }) => {
        task.status = terminal.status;
        sibling.status = terminal.status;
      });
      mocks.agentCommand.mockImplementationOnce(async () => {
        if (replacement === "same-session" || replacement === "different-session") {
          context.chatAbortControllers.set(runId, successor);
        } else if (replacement === "task-owner") {
          mocks.taskRunOwners.set(task.taskId, adoptedOwner);
        }
        return {
          payloads: [],
          meta:
            outcome === "abort"
              ? { aborted: true, stopReason: "rpc" }
              : outcome === "timeout"
                ? { stopReason: "timeout", timeoutPhase: "preflight", providerStarted: false }
                : {},
        };
      });
      const emitFinal = vi.fn();
      const onSettled = vi.fn(() => true);
      const completion = dispatchAgentRunFromGateway({
        ingressOpts: { message: task.task, sessionKey, allowModelOverride: false },
        runId,
        dedupeKeys: [],
        admittedRunEntry: entry,
        abortController: entry.controller,
        cleanupAbortController: vi.fn(),
        io: { emitAcceptance: vi.fn(), emitFinal },
        context,
        taskTrackingMode: "cli",
        assertSettlementCurrent() {},
        onSettled,
      });
      try {
        await Promise.race([entered.promise, completion]);
        expect(settleUnstarted).toHaveBeenCalledOnce();
        expect(mocks.finalizeTrackedTask).not.toHaveBeenCalled();
        expect(onSettled).not.toHaveBeenCalled();
        expect(emitFinal).not.toHaveBeenCalled();
        resume.resolve();
        await completion;
        const expectedStatus =
          outcome === "success" ? "succeeded" : outcome === "abort" ? "cancelled" : "timed_out";
        expect(task.status).toBe(
          cleanupFails || replacement === "same-session" || replacement === "task-owner"
            ? "running"
            : expectedStatus,
        );
        expect(sibling.status).toBe("running");
        expect(settleUnstarted).toHaveBeenCalledWith(
          expect.objectContaining({ status: expectedStatus }),
          expect.any(Function),
        );
        expect(mocks.finalizeTrackedTask).not.toHaveBeenCalled();
        expect(onSettled).toHaveBeenCalledOnce();
        expect(emitFinal).toHaveBeenCalledOnce();
        expect(emitFinal).toHaveBeenCalledWith(
          [
            true,
            expect.objectContaining({
              status: outcome === "success" ? "ok" : "timeout",
              summary: outcome === "success" ? "completed" : "aborted",
              ...(outcome === "timeout"
                ? { timeoutPhase: "preflight", providerStarted: false }
                : {}),
            }),
            undefined,
          ],
          { runId },
        );
        if (replacement === "same-session" || replacement === "different-session") {
          expect(context.chatAbortControllers.get(runId)).toBe(successor);
          expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
        }
        if (replacement === "task-owner") {
          expect(mocks.taskRunOwners.get(task.taskId)).toBe(adoptedOwner);
        }
        if (cleanupFails) {
          expect(context.logGateway.warn).toHaveBeenCalledWith(
            expect.stringContaining("failed to settle unstarted tracked task"),
          );
        }
      } finally {
        resume.resolve();
        await completion;
      }
    },
  );
});

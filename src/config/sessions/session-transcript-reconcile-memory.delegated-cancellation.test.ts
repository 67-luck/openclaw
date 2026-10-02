import fs from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  captureOpenClawAgentDatabaseExecution,
  retainGatewaySessionBroker,
} from "../../state/openclaw-agent-execution.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as reconcileDelegation from "./session-transcript-reconcile-delegation.js";
import {
  createDelegatedReconcileProbe,
  type DelegatedEndpoint,
} from "./session-transcript-reconcile-memory.delegated.test-support.js";
import { useMemoryReconcileFixture } from "./session-transcript-reconcile-memory.fixture.test-support.js";
import * as reconcilePool from "./session-transcript-reconcile-pool.js";
import { useReconcileWorkerObserver } from "./session-transcript-reconcile.test-support.js";
vi.mock("node:worker_threads", async () =>
  (await import("./session-transcript-reconcile.test-support.js")).createObservedWorkerThreads(),
);

const observer = useReconcileWorkerObserver();
const observeDelegatedReconcile = createDelegatedReconcileProbe(observer);

describe("incognito transcript reconciliation", () => {
  let ambient: OpenClawTestState;
  useMemoryReconcileFixture((ambientState) => {
    ambient = ambientState;
  });

  it.skipIf(Boolean(process.versions.bun)).for(["queued", "active"] as const)(
    "cancels original delegated memory work and ignores its stale cancellation (%s)",
    async (phase, { signal }) => {
      const sessions = ["delegated-a", "delegated-b", "delegated-successor"];
      const probe = observeDelegatedReconcile(sessions, signal);
      const {
        admitted,
        sourceRead,
        observations,
        observe,
        release,
        releaseGates,
        endpointSpy,
        hostOpen,
      } = probe;
      const references: ReturnType<typeof captureOpenClawAgentDatabaseExecution>[] = [];
      let broker: ReturnType<typeof retainGatewaySessionBroker> | undefined;
      let ownerClose: Promise<void> | undefined;
      const failures: unknown[] = [];
      const seed = (logicalAgent: string, id: string) => {
        const target = {
          agentId: logicalAgent,
          sessionId: id,
          sessionKey: `agent:${logicalAgent}:dashboard:incognito-delegated`,
          storePath: resolveIncognitoOpenClawAgentSqlitePath({
            agentId: logicalAgent,
            env: ambient.env,
          }),
          env: ambient.env,
        };
        const manager = SessionManager.open(target, ambient.workspaceDir);
        const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
        manager.appendMessage({ role: "user", content: "abandoned", timestamp: 2 });
        const execution = captureOpenClawAgentDatabaseExecution({
          agentId: logicalAgent,
          path: target.storePath,
          env: ambient.env,
        });
        references.push(execution);
        return {
          target,
          execution,
          dirty() {
            // A real branch and committed metadata append schedule reconciliation in DATA.
            manager.branch(root);
            manager.appendCustomEntry("delegated-reconcile", { branch: root });
          },
        };
      };
      try {
        assert(admitted[0] && admitted[1] && admitted[2]);
        assert(sourceRead[0] && sourceRead[1] && sourceRead[2]);
        await observe(reconcilePool.closeSessionTranscriptReconcileWorkerPool());
        broker = retainGatewaySessionBroker();
        await observe(broker.ready);
        const hostPort = probe.hostPort;
        assert(hostPort);
        expect(endpointSpy).toHaveBeenCalledTimes(1);
        const a = seed("delegated-a", "delegated-a");
        const b = seed("delegated-b", "delegated-b");
        expect([a.execution.backend, b.execution.backend]).toEqual(["volatile", "volatile"]);
        expect(a.target.storePath).not.toBe(b.target.storePath);
        expect(a.execution.binding.incarnation).not.toBe(b.execution.binding.incarnation);
        a.dirty();
        const originalA = await observe(admitted[0].promise);
        await observe(sourceRead[0].promise);
        expect(originalA.owner).toMatchObject({
          agentId: a.target.agentId,
          path: a.target.storePath,
        });
        expect(originalA.dispatches).toBe(1);
        if (phase === "active") {
          release(0);
          await expect(observe(originalA.result)).resolves.toEqual({
            status: "fulfilled",
            value: undefined,
          });
          await observe(originalA.finished.promise);
        }
        b.dirty();
        const originalB = await observe(admitted[1].promise);
        expect(originalB.owner).toMatchObject({
          agentId: b.target.agentId,
          path: b.target.storePath,
        });
        expect(originalB.owner?.id).not.toBe(originalA.owner?.id);
        if (phase === "active") {
          await observe(sourceRead[1].promise);
          expect(originalB.dispatches).toBe(1);
          expect(originalB.worker?.threadId).toBeGreaterThan(0);
        } else {
          expect(originalB.dispatches).toBe(0);
          expect(originalB.worker).toBeUndefined();
          expect(originalB.status).toBe("pending");
          expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
            maxWorkers: 1,
            activeTasks: 1,
            pendingTasks: 2,
          });
        }
        b.execution.assertCurrent();
        ownerClose = closeOpenClawAgentDatabaseByPathAsync(b.target.storePath).then(() => {
          originalB.order.push("owner-closed");
        });
        void ownerClose.catch(() => undefined);
        const rejected = await observe(originalB.result);
        expect(rejected.status).toBe("rejected");
        expect(originalB.signal.aborted).toBe(true);
        await expect(observe(originalB.joined.promise)).resolves.toHaveProperty(
          "error",
          expect.any(String),
        );
        await observe(originalB.finished.promise);
        await observe(ownerClose);
        expect(() => b.execution.binding.assertCurrent()).toThrow();
        expect(originalB.order.at(-1)).toBe("owner-closed");
        expect(originalB.cancel).toMatchObject({
          kind: "cancel",
          operation: originalB.start?.operation,
          task: originalB.start?.task,
        });
        if (phase === "active") {
          expect(originalB.worker?.threadId).toBe(-1);
          expect(originalB.order.indexOf("native-exit")).toBeGreaterThanOrEqual(0);
          expect(originalB.order.indexOf("native-exit")).toBeLessThan(
            originalB.order.indexOf("native-joined"),
          );
        } else {
          await observe(originalB.portClosed.promise);
          expect(originalB.dispatches).toBe(0);
          expect(originalA.signal.aborted).toBe(false);
          expect(originalA.status).toBe("pending");
          expect(originalA.worker?.threadId).toBeGreaterThan(0);
          release(0);
          await expect(observe(originalA.result)).resolves.toEqual({
            status: "fulfilled",
            value: undefined,
          });
          await observe(originalA.finished.promise);
        }
        a.execution.assertCurrent();
        expect(
          SessionManager.readSessionContext(a.target, (messages) => [...messages]),
        ).toMatchObject([{ role: "user", content: "root" }]);
        const successor = seed("delegated-b", "delegated-successor");
        expect(successor.execution.binding.incarnation).not.toBe(b.execution.binding.incarnation);
        successor.dirty();
        const current = await observe(admitted[2].promise);
        await observe(sourceRead[2].promise);
        expect(current.owner?.id).not.toBe(originalB.owner?.id);
        expect(current.owner?.incarnation).not.toBe(originalB.owner?.incarnation);
        expect(current.owner?.path).toBe(originalB.owner?.path);
        expect(current.native).not.toBe(originalB.native);
        expect(current.signal).not.toBe(originalB.signal);
        const { native, signal: successorSignal, result } = current;
        const nativeResult = native.result;
        assert(originalB.cancel);
        // Controlled stale-frame injection uses the captured DATA envelope on its original HOST port.
        hostPort.emit("message", originalB.cancel);
        expect(current.native).toBe(native);
        expect(native.result).toBe(nativeResult);
        expect(current.signal).toBe(successorSignal);
        expect(current.result).toBe(result);
        expect(successorSignal.aborted).toBe(false);
        expect(current.status).toBe("pending");
        release(2);
        await expect(observe(nativeResult)).resolves.toBeUndefined();
        await expect(observe(result)).resolves.toEqual({
          status: "fulfilled",
          value: undefined,
        });
        await expect(observe(current.finished.promise)).resolves.not.toHaveProperty("error");
        expect(current.dispatches).toBe(1);
        expect(observations).toHaveLength(3);
        expect(await observe(originalB.result)).toBe(rejected);
        expect(
          SessionManager.readSessionContext(successor.target, (messages) => [...messages]),
        ).toMatchObject([{ role: "user", content: "root" }]);
        expect(hostOpen).not.toHaveBeenCalled();
        expect(fs.existsSync(a.target.storePath)).toBe(false);
        expect(fs.existsSync(b.target.storePath)).toBe(false);
        expect(agentDatabase.listOpenIncognitoAgentDatabases()).toEqual([]);
      } catch (error) {
        failures.push(error);
      } finally {
        releaseGates();
        const cleanups: Array<() => void | Promise<void>> = [
          async () => {
            const released = await Promise.allSettled([
              ownerClose,
              ...references.map(async (reference) => {
                await reference.release();
              }),
            ]);
            for (const result of released) {
              if (result.status === "rejected") {
                failures.push(result.reason);
              }
            }
          },
          () => broker?.stop(),
          () => reconcilePool.closeSessionTranscriptReconcileWorkerPool(),
          async () => {
            await Promise.all(observations.map((row) => row.result));
            expect([...observer.workers].every((worker) => worker.threadId === -1)).toBe(true);
          },
          () => probe.restore(),
        ];
        for (const cleanup of cleanups) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length) {
        throw new AggregateError(failures, "Delegated owner cleanup failed", {
          cause: failures[0],
        });
      }
    },
  );

  it.skipIf(Boolean(process.versions.bun)).for([
    {
      title: "retains failed delegated native close until the original operation retries",
      failure: new Error("delegated native termination refused"),
    },
    {
      title:
        "retains undefined delegated native close failure until the original operation retries",
      failure: undefined,
    },
    {
      title:
        "retains empty-message delegated native close failure until the original operation retries",
      failure: new Error(""),
    },
  ])("$title", async ({ failure }, { signal }) => {
    const probe = observeDelegatedReconcile(["retry-enrollment", "retry-native-close"], signal);
    const { observe } = probe;
    const controller = new AbortController();
    const termination = createDeferred();
    const retryEntered = createDeferred();
    const exited = createDeferred();
    const failureMessage = failure instanceof Error ? failure.message : String(failure);
    let broker: ReturnType<typeof retainGatewaySessionBroker> | undefined;
    let execution: ReturnType<typeof captureOpenClawAgentDatabaseExecution> | undefined;
    let endpoint:
      | ReturnType<typeof reconcilePool.createSessionTranscriptReconcileEndpoint>
      | undefined;
    let enrollment: ReturnType<DelegatedEndpoint["enroll"]> | undefined;
    let operation:
      | ReturnType<reconcileDelegation.SessionReconcileTaskDelegate["begin"]>
      | undefined;
    let task: reconcileDelegation.SessionReconcileTask | undefined;
    let retry: Promise<void> | undefined;
    let restoreTerminate: (() => void) | undefined;
    let attempts = 0;
    let nativeCalls = 0;
    const abort = () => {
      termination.resolve();
      controller.abort(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    try {
      assert(probe.admitted[0] && probe.admitted[1]);
      assert(probe.sourceRead[0] && probe.sourceRead[1]);
      await observe(reconcilePool.closeSessionTranscriptReconcileWorkerPool());
      broker = retainGatewaySessionBroker();
      await observe(broker.ready);
      const target = {
        agentId: "delegated-close-retry",
        sessionId: "retry-enrollment",
        sessionKey: "agent:delegated-close-retry:dashboard:incognito",
        storePath: resolveIncognitoOpenClawAgentSqlitePath({
          agentId: "delegated-close-retry",
          env: ambient.env,
        }),
        env: ambient.env,
      };
      const manager = SessionManager.open(target, ambient.workspaceDir);
      const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
      manager.appendMessage({ role: "user", content: "abandoned", timestamp: 2 });
      execution = captureOpenClawAgentDatabaseExecution({
        agentId: target.agentId,
        path: target.storePath,
        env: target.env,
      });
      expect(execution.backend).toBe("volatile");
      manager.branch(root);
      manager.appendCustomEntry("delegated-reconcile", { branch: root });
      const seeded = await observe(probe.admitted[0].promise);
      await observe(probe.sourceRead[0].promise);
      probe.release(0);
      await expect(observe(seeded.result)).resolves.toEqual({
        status: "fulfilled",
        value: undefined,
      });
      await expect(observe(seeded.finished.promise)).resolves.not.toHaveProperty("error");
      const owner = seeded.owner;
      assert(
        owner &&
          typeof owner.id === "string" &&
          typeof owner.agentId === "string" &&
          typeof owner.path === "string" &&
          typeof owner.incarnation === "string",
      );
      const descriptor = {
        id: owner.id,
        agentId: owner.agentId,
        path: owner.path,
        incarnation: owner.incarnation,
      };
      const originalEnrollment = probe.enrollments.find((entry) => entry.target.id === owner.id);
      assert(originalEnrollment);
      execution.assertCurrent();
      // Enrollment validates the native incarnation; the execution binding is a separate opaque owner.
      originalEnrollment.assertCurrent(descriptor);
      expect(descriptor).toMatchObject({
        id: originalEnrollment.target.id,
        agentId: target.agentId,
        path: target.storePath,
      });
      // Reuse real DATA enrollment facts, but keep this endpoint's port on the host
      // so the fixture retains the actual delegate operation's explicit retry API.
      endpoint = reconcilePool.createSessionTranscriptReconcileEndpoint();
      enrollment = endpoint.enroll(originalEnrollment.target, originalEnrollment.assertCurrent);
      const delegate = reconcileDelegation.createSessionReconcileTaskDelegate(
        endpoint.port,
        endpoint.identity,
        () => descriptor,
      );
      operation = delegate.begin({ agentId: target.agentId, path: target.storePath }, controller);
      // This direct task proves endpoint retirement, not another DATA projection.
      task = operation.startTask({ mode: "memory", sessionIds: ["retry-native-close"] });
      const taskOutcome = task.completion.then(
        (value): PromiseFulfilledResult<void> => ({ status: "fulfilled", value }),
        (reason: unknown): PromiseRejectedResult => ({ status: "rejected", reason }),
      );
      const retained = await observe(probe.admitted[1].promise);
      await observe(probe.sourceRead[1].promise);
      expect(retained.owner).toEqual(descriptor);
      expect(retained.dispatches).toBe(1);
      const worker = retained.worker;
      assert(worker);
      expect(worker.threadId).toBeGreaterThan(0);
      worker.once("exit", () => exited.resolve());
      const terminate = worker.terminate.bind(worker);
      const terminateSpy = vi.spyOn(worker, "terminate").mockImplementation(() => {
        attempts++;
        if (attempts === 1) {
          // This boundary fault is not a claim about values Node terminate normally rejects.
          const refused = createDeferred<number>();
          refused.reject(failure);
          return refused.promise;
        }
        retryEntered.resolve();
        return termination.promise.then(() => {
          nativeCalls++;
          return terminate();
        });
      });
      restoreTerminate = () => terminateSpy.mockRestore();
      const reason = new Error("cancel original delegated task");
      controller.abort(reason);
      expect(task.controller.signal.reason).toBe(reason);
      const originalResult = await observe(retained.result);
      expect(originalResult.status).toBe("rejected");
      expect(retained.signal.aborted).toBe(true);
      const taskReply = await observe(retained.joined.promise);
      expect(retained.closes).toHaveLength(1);
      const firstClose = retained.closes[0];
      assert(firstClose);
      await expect(observe(firstClose)).rejects.toBe(failure);
      const rejectedTask = await observe(taskOutcome);
      expect(rejectedTask.status).toBe("rejected");
      assert(rejectedTask.status === "rejected");
      expect(rejectedTask.reason).toBeInstanceOf(Error);
      expect(rejectedTask.reason).not.toBe(failure);
      expect(rejectedTask.reason.message).toBe(failureMessage);
      expect(taskReply).toMatchObject({ kind: "task", error: failureMessage });
      const firstFinish = operation.close();
      await expect(observe(firstFinish)).rejects.toThrow("Transcript compute cleanup did not join");
      expect(retained.finishReplies).toEqual([
        expect.objectContaining({
          kind: "finish",
          attempt: 1,
          error: "Transcript compute cleanup did not join",
        }),
      ]);
      expect(attempts).toBe(1);
      expect(nativeCalls).toBe(0);
      expect(retained.closes).toHaveLength(1);
      expect(retained.dispatches).toBe(1);
      expect(worker.threadId).toBeGreaterThan(0);
      expect(retained.order).not.toContain("native-exit");
      expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
        workers: 1,
        activeTasks: 1,
        pendingTasks: 1,
      });

      // Endpoint/global drainage can also retry. Neither runs until this same
      // operation has observed its failed finish and explicitly retried it.
      retry = operation.close();
      let settled = false;
      void retry.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      expect(operation.close()).toBe(retry);
      await observe(retryEntered.promise);
      expect(attempts).toBe(2);
      expect(nativeCalls).toBe(0);
      expect(retained.closes).toHaveLength(2);
      expect(retained.finishReplies).toHaveLength(1);
      expect(worker.threadId).toBeGreaterThan(0);
      expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
        workers: 1,
        activeTasks: 1,
        pendingTasks: 1,
      });
      const secondClose = retained.closes[1];
      assert(secondClose);
      expect(settled).toBe(false);
      termination.resolve();
      await observe(exited.promise);
      await observe(retry);
      await observe(secondClose);
      await observe(Promise.all([task.closed, task.leaseRelease]));
      expect(retained.finishReplies).toHaveLength(2);
      expect(retained.finishReplies[1]).toMatchObject({ kind: "finish", attempt: 2 });
      expect(retained.finishReplies[1]).not.toHaveProperty("error");
      expect(retained.order.indexOf("native-exit")).toBeLessThan(
        retained.order.lastIndexOf("finish-reply"),
      );
      expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
        workers: 0,
        activeTasks: 0,
        pendingTasks: 0,
      });
      expect(worker.threadId).toBe(-1);
      expect(attempts).toBe(2);
      expect(nativeCalls).toBe(1);
      expect(retained.dispatches).toBe(1);
      expect(probe.observations).toHaveLength(2);
      expect(await observe(retained.result)).toBe(originalResult);
      expect(await observe(taskOutcome)).toBe(rejectedTask);
      expect(operation.close()).toBe(retry);
      expect(probe.hostOpen).not.toHaveBeenCalled();
      execution.assertCurrent();
    } finally {
      probe.releaseGates();
      termination.resolve();
      controller.abort();
      try {
        await (retry ?? operation?.close());
      } finally {
        try {
          await endpoint?.close();
          // This joins the original enrolled lifecycle, not an array.
          // oxlint-disable-next-line unicorn/require-array-join-separator
          await enrollment?.join();
          await Promise.allSettled([task?.completion, task?.closed, task?.leaseRelease]);
        } finally {
          try {
            await execution?.release();
          } finally {
            try {
              await broker?.stop();
            } finally {
              try {
                await reconcilePool.closeSessionTranscriptReconcileWorkerPool();
                await Promise.all(probe.observations.map((row) => row.result));
                expect([...observer.workers].every((worker) => worker.threadId === -1)).toBe(true);
              } finally {
                restoreTerminate?.();
                signal.removeEventListener("abort", abort);
                probe.restore();
              }
            }
          }
        }
      }
    }
  });

  it.skipIf(Boolean(process.versions.bun)).for(["enrollment", "endpoint"] as const)(
    "joins all delegated operations after a recorded close failure (%s)",
    async (mode, { signal }) => {
      const probe = observeDelegatedReconcile(["outer-enrollment", "outer-a", "outer-b"], signal);
      const { observe } = probe;
      const controllers = [new AbortController(), new AbortController()];
      type Operation = ReturnType<reconcileDelegation.SessionReconcileTaskDelegate["begin"]>;
      const operations: Operation[] = [];
      const tasks: reconcileDelegation.SessionReconcileTask[] = [];
      const failures: unknown[] = [];
      const termination = createDeferred();
      const retryEntered = createDeferred();
      const nativeEntered = createDeferred();
      const exited = createDeferred();
      const failure = new Error("recorded delegated retirement failure");
      let broker: ReturnType<typeof retainGatewaySessionBroker> | undefined;
      let execution: ReturnType<typeof captureOpenClawAgentDatabaseExecution> | undefined;
      let endpoint:
        | ReturnType<typeof reconcilePool.createSessionTranscriptReconcileEndpoint>
        | undefined;
      let joinEnrollment: (() => Promise<void>) | undefined;
      let outer: Promise<void> | undefined;
      let outerOutcome: Promise<PromiseSettledResult<void>> | undefined;
      let restoreTerminate: (() => void) | undefined;
      let removeFinishObserver: (() => void) | undefined;
      let allowNative = false;
      let attempts = 0;
      let nativeCalls = 0;
      let bFinished = false;
      let bTaskClosed = false;
      let atSettlement: { finished: boolean; taskClosed: boolean } | undefined;
      const abort = () => {
        allowNative = true;
        termination.resolve();
        for (const controller of controllers) {
          controller.abort(signal.reason);
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
      try {
        assert(probe.admitted[0] && probe.admitted[1] && probe.admitted[2]);
        assert(probe.sourceRead[0] && probe.sourceRead[1]);
        await observe(reconcilePool.closeSessionTranscriptReconcileWorkerPool());
        broker = retainGatewaySessionBroker();
        await observe(broker.ready);
        const target = {
          agentId: "delegated-outer-drain",
          sessionId: "outer-enrollment",
          sessionKey: "agent:delegated-outer-drain:dashboard:incognito",
          storePath: resolveIncognitoOpenClawAgentSqlitePath({
            agentId: "delegated-outer-drain",
            env: ambient.env,
          }),
          env: ambient.env,
        };
        const manager = SessionManager.open(target, ambient.workspaceDir);
        const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
        manager.appendMessage({ role: "user", content: "abandoned", timestamp: 2 });
        execution = captureOpenClawAgentDatabaseExecution({
          agentId: target.agentId,
          path: target.storePath,
          env: target.env,
        });
        manager.branch(root);
        manager.appendCustomEntry("delegated-reconcile", { branch: root });
        const seeded = await observe(probe.admitted[0].promise);
        await observe(probe.sourceRead[0].promise);
        probe.release(0);
        expect(await observe(seeded.result)).toEqual({
          status: "fulfilled",
          value: undefined,
        });
        expect(await observe(seeded.finished.promise)).not.toHaveProperty("error");
        const owner = seeded.owner;
        assert(
          owner &&
            typeof owner.id === "string" &&
            typeof owner.agentId === "string" &&
            typeof owner.path === "string" &&
            typeof owner.incarnation === "string",
        );
        const descriptor = {
          id: owner.id,
          agentId: owner.agentId,
          path: owner.path,
          incarnation: owner.incarnation,
        };
        const originalEnrollment = probe.enrollments.find((entry) => entry.target.id === owner.id);
        assert(originalEnrollment);
        originalEnrollment.assertCurrent(descriptor);
        endpoint = reconcilePool.createSessionTranscriptReconcileEndpoint();
        const enrollment = endpoint.enroll(
          originalEnrollment.target,
          originalEnrollment.assertCurrent,
        );
        joinEnrollment = enrollment.join.bind(enrollment);
        // The actual delegate stays on the host to retain its explicit finish/retry API.
        // This proves delegated drainage, not another DATA projection or sweep.
        const delegate = reconcileDelegation.createSessionReconcileTaskDelegate(
          endpoint.port,
          endpoint.identity,
          () => descriptor,
        );
        const aController = controllers[0];
        const bController = controllers[1];
        assert(aController && bController);
        const logicalTarget = { agentId: target.agentId, path: target.storePath };
        const aOperation = delegate.begin(logicalTarget, aController);
        operations.push(aOperation);
        const aTask = aOperation.startTask({ mode: "memory", sessionIds: ["outer-a"] });
        tasks.push(aTask);
        const aTaskOutcome = Promise.allSettled([aTask.completion]);
        const a = await observe(probe.admitted[1].promise);
        await observe(probe.sourceRead[1].promise);
        const worker = a.worker;
        assert(worker);
        worker.once("exit", () => exited.resolve());
        const terminate = worker.terminate.bind(worker);
        const terminateSpy = vi.spyOn(worker, "terminate").mockImplementation(() => {
          attempts++;
          if (!allowNative && attempts <= 2) {
            if (attempts === 2) {
              retryEntered.resolve();
            }
            // Controlled recorded-close failure; ordinary Node termination need not reject.
            return Promise.reject(failure);
          }
          nativeEntered.resolve();
          return termination.promise.then(() => {
            nativeCalls++;
            return terminate();
          });
        });
        restoreTerminate = () => terminateSpy.mockRestore();
        aController.abort(new Error("cancel A before recorded retirement failure"));
        await observe(a.joined.promise);
        assert(a.closes[0]);
        await expect(observe(a.closes[0])).rejects.toBe(failure);
        expect((await observe(aTaskOutcome))[0]?.status).toBe("rejected");
        await expect(observe(aOperation.close())).rejects.toThrow(
          "Transcript compute cleanup did not join",
        );
        const bOperation = delegate.begin(logicalTarget, bController);
        operations.push(bOperation);
        probe.beforeClose = (allocation, close) => {
          const pending = close();
          if (allocation.input.sessionIds.includes("outer-b")) {
            void pending.then(
              () => {
                bTaskClosed = true;
              },
              () => {},
            );
          }
          return pending;
        };
        const bTask = bOperation.startTask({ mode: "memory", sessionIds: ["outer-b"] });
        tasks.push(bTask);
        const bTaskOutcome = Promise.allSettled([bTask.completion]);
        const b = await observe(probe.admitted[2].promise);
        expect(b.dispatches).toBe(0);
        expect(b.worker).toBeUndefined();
        const host = probe.hostPort;
        assert(host && b.start);
        const bId = b.start.operation;
        const finished = (message: unknown) => {
          if (isRecord(message) && message.kind === "finish" && message.operation === bId) {
            bFinished = true;
          }
        };
        // Registered after the original HOST handler: this witnesses consumed finish, not close().
        host.on("message", finished);
        removeFinishObserver = () => host.off("message", finished);
        bController.abort(new Error("cancel queued B without native dispatch"));
        expect((await observe(bTaskOutcome))[0]?.status).toBe("rejected");
        const retainedEndpoint = endpoint;
        const drain =
          mode === "enrollment" ? joinEnrollment : retainedEndpoint.close.bind(retainedEndpoint);
        // Attach settlement observation before the microtask starts the original outer call.
        outerOutcome = Promise.resolve()
          .then(() => {
            outer = drain();
            return outer;
          })
          .then(
            (value): PromiseFulfilledResult<void> => {
              atSettlement = { finished: bFinished, taskClosed: bTaskClosed };
              return { status: "fulfilled", value };
            },
            (reason: unknown): PromiseRejectedResult => {
              atSettlement = { finished: bFinished, taskClosed: bTaskClosed };
              return { status: "rejected", reason };
            },
          );
        await observe(retryEntered.promise);
        assert(a.closes[1]);
        await expect(observe(a.closes[1])).rejects.toBe(failure);
        await observe(nextTurn());
        const bFinish = bOperation.close();
        await observe(bFinish);
        const result = await observe(outerOutcome);
        expect(atSettlement).toEqual({ finished: true, taskClosed: true });
        assert(result.status === "rejected" && result.reason instanceof AggregateError);
        expect(result.reason.message).toBe("Transcript compute cleanup did not join");
        expect(result.reason.errors).toHaveLength(1);
        expect(result.reason.errors[0]).toBe(failure);
        expect(b.dispatches).toBe(0);
        expect(attempts).toBe(2);
        expect(nativeCalls).toBe(0);
        expect(worker.threadId).toBeGreaterThan(0);
        expect(a.dispatches).toBe(1);
        expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
          workers: 1,
          activeTasks: 1,
          pendingTasks: 1,
        });
        allowNative = true;
        const retry = aOperation.close();
        await observe(nativeEntered.promise);
        probe.releaseGates();
        termination.resolve();
        await observe(exited.promise);
        await observe(retry);
        await observe(drain());
        expect(attempts).toBe(3);
        expect(nativeCalls).toBe(1);
        expect(a.dispatches).toBe(1);
        expect(b.dispatches).toBe(0);
        expect((await observe(aTaskOutcome))[0]?.status).toBe("rejected");
        expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
          workers: 0,
          activeTasks: 0,
          pendingTasks: 0,
        });
        execution.assertCurrent();
        expect(probe.hostOpen).not.toHaveBeenCalled();
      } catch (error) {
        failures.push(error);
      } finally {
        allowNative = true;
        probe.releaseGates();
        termination.resolve();
        for (const controller of controllers) {
          controller.abort();
        }
        const cleanups: Array<() => void | Promise<void>> = [
          async () => {
            const results = await Promise.allSettled(
              operations.map(async (operation) => operation.close()),
            );
            for (const result of results) {
              if (result.status === "rejected") {
                failures.push(result.reason);
              }
            }
            await outerOutcome;
          },
          () => endpoint?.close(),
          () => joinEnrollment?.(),
          async () => {
            await Promise.allSettled(tasks.map((task) => task.completion));
            const results = await Promise.allSettled(
              tasks.flatMap((task) => [task.closed, task.leaseRelease]),
            );
            for (const result of results) {
              if (result.status === "rejected") {
                failures.push(result.reason);
              }
            }
          },
          () => execution?.release(),
          () => broker?.stop(),
          () => reconcilePool.closeSessionTranscriptReconcileWorkerPool(),
          async () => {
            await Promise.all(probe.observations.map((row) => row.result));
            expect([...observer.workers].every((worker) => worker.threadId === -1)).toBe(true);
          },
          () => removeFinishObserver?.(),
          () => restoreTerminate?.(),
          () => signal.removeEventListener("abort", abort),
          () => probe.restore(),
        ];
        for (const cleanup of cleanups) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length) {
        throw new AggregateError(failures, "Delegated outer drainage cleanup failed", {
          cause: failures[0],
        });
      }
    },
  );
});

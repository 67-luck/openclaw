import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { registerActiveCronTaskRun } from "../cron/service/active-run-cancellation.js";
import { createRuntimeAsyncTasks } from "../plugins/runtime/runtime-tasks-async.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getDetachedTaskLifecycleRuntime } from "./detached-task-runtime.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "./detached-task-runtime.test-support.js";
import { cancelFlowByIdForOwner } from "./task-flow-cancellation.async.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import * as taskFlowRuntime from "./task-flow-runtime-internal.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import * as taskRegistryState from "./task-registry-state.js";
import { getTaskRegistryStore } from "./task-registry.store.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  resetDetachedTaskLifecycleRuntimeForTests();
  await closeOpenClawStateDatabaseAsync();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
});

it("does not acknowledge cancellation until its committed flow publication settles", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    const ownerKey = "agent:main:cancellation-publication";
    const flows = createRuntimeAsyncTasks().managedFlows.bindSession({ sessionKey: ownerKey });
    const flow = await flows.createManaged({
      controllerId: "tests/cancellation",
      goal: "Publish committed cancellation",
    });
    const mutate = taskFlowRuntime.runTaskFlowRegistryWorkerMutation;
    const publication = vi
      .spyOn(taskFlowRuntime, "runTaskFlowRegistryWorkerMutation")
      .mockImplementation((context, operation, readCurrent) =>
        mutate(context, operation, async () => {
          const current = await readCurrent();
          if (current?.status === "cancelled") {
            throw new Error("Synthetic committed flow readback failure");
          }
          return current;
        }),
      );

    expect(
      await cancelFlowByIdForOwner({ cfg: {}, flowId: flow.flowId, callerOwnerKey: ownerKey }),
    ).toMatchObject({
      found: true,
      cancelled: false,
      reason: expect.stringContaining("publication"),
    });
    expect(taskFlowRuntime.readResidentTaskFlow(flow.flowId)?.status).toBe(flow.status);
    publication.mockRestore();
    // The next canonical read repairs projection only; the acknowledged write is not replayed.
    await expect(flows.get(flow.flowId)).resolves.toMatchObject({
      status: "cancelled",
      revision: flow.revision + 2,
    });
  });
});

it("settles a committed child's projection before acknowledging its flow cancellation", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    const ownerKey = "agent:main:child-publication";
    const flows = createRuntimeAsyncTasks().managedFlows.bindSession({ sessionKey: ownerKey });
    const flow = await flows.createManaged({
      controllerId: "tests/cancellation",
      goal: "Settle child publication",
    });
    const child = await flows.runTask({
      flowId: flow.flowId,
      runtime: "cron",
      runId: "child-publication-run",
      status: "running",
      task: "Publish cancellation",
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
    });
    if (!child.created) {
      throw new Error("Expected linked child task");
    }
    const read = await prepareTaskRegistryRead();
    if (!read) {
      throw new Error("Expected prepared task reader");
    }
    const controller = new AbortController();
    const release = registerActiveCronTaskRun({ runId: child.task.runId, controller });
    const mutate = taskRegistryState.runTaskRegistryWorkerMutation;
    vi.spyOn(taskRegistryState, "runTaskRegistryWorkerMutation").mockImplementation(
      (context, operation, readCurrent) =>
        mutate(context, operation, async () => {
          const snapshot = await readCurrent();
          if (snapshot.tasks.get(child.task.taskId)?.status === "cancelled") {
            throw new Error("Synthetic committed child readback failure");
          }
          return snapshot;
        }),
    );
    try {
      await expect(
        cancelFlowByIdForOwner({ cfg: {}, flowId: flow.flowId, callerOwnerKey: ownerKey }),
      ).resolves.toMatchObject({ found: true, cancelled: true });
      expect(controller.signal.aborted).toBe(true);
      expect(read.isTaskSettled(child.task.taskId)).toBe(true);
      expect(read.getTaskById(child.task.taskId)?.status).toBe("cancelled");
    } finally {
      release?.();
    }
  });
});

it.each(["child completion", "flow replacement", "caller retirement"] as const)(
  "reconciles %s while its original child's cancellation waits",
  async (change) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const ownerKey = "agent:main:cancellation";
      const flows = createRuntimeAsyncTasks().managedFlows.bindSession({ sessionKey: ownerKey });
      const flow = await flows.createManaged({
        controllerId: "tests/cancellation",
        goal: "Synthetic flow",
      });
      const child = await flows.runTask({
        flowId: flow.flowId,
        runtime: "cron",
        runId: "cancellation-child",
        status: "running",
        task: "Synthetic child",
      });
      if (!child.created) {
        throw new Error("Expected linked child task");
      }
      const entered = createDeferred();
      const release = createDeferred();
      let current = true;
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        async cancelDetachedTaskRunById() {
          entered.resolve();
          await release.promise;
          return {
            found: true,
            cancelled: false,
            reason: "Native child outcome is owned separately.",
          };
        },
      });
      const pending = cancelFlowByIdForOwner(
        { cfg: {}, flowId: flow.flowId, callerOwnerKey: ownerKey },
        () => {
          if (!current) {
            throw new Error("Synthetic caller retired");
          }
        },
      );
      try {
        await Promise.race([
          entered.promise,
          pending.then((result) => {
            throw new Error(`Child cancellation was not dispatched: ${JSON.stringify(result)}`);
          }),
        ]);
        await expect(flows.get(flow.flowId)).resolves.toMatchObject({
          cancelRequestedAt: expect.any(Number),
        });
        // Independent committed writers race the retained request, without updating its projection.
        if (change === "child completion") {
          getTaskRegistryStore().upsertTaskWithDeliveryState({
            task: { ...child.task, status: "succeeded", endedAt: Date.now() },
          });
        } else if (change === "flow replacement") {
          getTaskFlowRegistryStore().upsertFlow({
            ...flow,
            createdAt: flow.createdAt + 1,
            controllerId: "tests/replacement",
          });
        } else {
          current = false;
        }
        release.resolve();
        expect(await pending).toMatchObject({ cancelled: change === "child completion" });
        const persisted = await flows.get(flow.flowId);
        if (change === "child completion") {
          expect(persisted).toMatchObject({ status: "cancelled", endedAt: expect.any(Number) });
        } else if (change === "flow replacement") {
          expect(persisted).toMatchObject({
            controllerId: "tests/replacement",
            createdAt: flow.createdAt + 1,
            status: flow.status,
          });
          expect(persisted?.cancelRequestedAt).toBeUndefined();
        } else {
          expect(persisted).toMatchObject({
            status: flow.status,
            cancelRequestedAt: expect.any(Number),
          });
          expect(persisted?.endedAt).toBeUndefined();
        }
      } finally {
        release.resolve();
        await pending;
      }
    });
  },
);

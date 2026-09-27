import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getDetachedTaskLifecycleRuntime } from "./detached-task-runtime.js";
import {
  setDetachedTaskLifecycleRuntime,
  resetDetachedTaskLifecycleRuntimeForTests,
} from "./detached-task-runtime.test-support.js";
import {
  captureTaskCancellationControl,
  type TaskCancellationControl,
} from "./task-cancellation-context-state.js";
import { cancelDetachedTaskRunByIdAsync } from "./task-executor-cancel.async.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import { upsertTaskFlowRegistryRecordToSqlite } from "./task-flow-registry.store.sqlite.js";
import { cancelTaskById } from "./task-registry-cancel.js";
import { updateTask } from "./task-registry-mutation.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import { reloadTaskRegistryFromStoreAsync } from "./task-registry-state.js";
import { getTaskRegistryStore } from "./task-registry.store.js";
import {
  loadTaskRegistryStateFromSqliteReadOnly,
  upsertTaskWithDeliveryStateToSqlite,
} from "./task-registry.store.sqlite.js";
import type { TaskRecord } from "./task-registry.types.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

vi.mock("./task-registry-control.runtime.js", () => ({ cancelActiveCronTaskRun: () => false }));

const task: TaskRecord = {
  taskId: "runless-cancellation",
  runtime: "cron",
  ownerKey: "agent:main:main",
  requesterSessionKey: "agent:main:main",
  scopeKind: "session",
  task: "Legacy childless cron cleanup",
  status: "running",
  deliveryStatus: "not_applicable",
  notifyPolicy: "silent",
  createdAt: 1,
};

afterEach(async () => {
  vi.restoreAllMocks();
  resetDetachedTaskLifecycleRuntimeForTests();
  await closeOpenClawStateDatabaseAsync();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
});

it("cancels a cold unlinked row despite unrelated flow restore failure without host SQL", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    upsertTaskWithDeliveryStateToSqlite({ task });
    closeOpenClawStateDatabase();
    vi.spyOn(getTaskFlowRegistryStore(), "withSnapshotAsync").mockRejectedValue(
      new Error("Unrelated flow registry is unavailable."),
    );
    requireNodeSqlite();
    const sql = observeMainThreadSql();
    try {
      const result = await cancelDetachedTaskRunByIdAsync(
        { cfg: {}, taskId: task.taskId },
        { selectedTask: task, assertCurrent() {} },
      );
      expect(result, JSON.stringify(result)).toMatchObject({
        cancelled: true,
        task: { status: "cancelled", error: "Cancelled by operator." },
      });
      await closeOpenClawStateDatabaseAsync();
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
      status: "cancelled",
      error: "Cancelled by operator.",
    });
  });
});

it("rechecks caller authority after worker settlement preparation", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    upsertTaskWithDeliveryStateToSqlite({ task });
    const entered = createDeferred();
    const release = createDeferred();
    const store = getTaskRegistryStore();
    const mutation = store.runInitialMutationAsync.bind(store);
    let active = true;
    vi.spyOn(store, "runInitialMutationAsync").mockImplementation(
      async (context, command, assertCurrent, onGranted) => {
        if (command.type === "tasks.cancelRow") {
          entered.resolve();
          await release.promise;
        }
        return mutation(context, command, assertCurrent, onGranted);
      },
    );
    const pending = cancelDetachedTaskRunByIdAsync(
      { cfg: {}, taskId: task.taskId },
      {
        selectedTask: task,
        assertCurrent() {
          if (!active) {
            throw new Error("Caller retired during cancellation.");
          }
        },
      },
    );
    try {
      await Promise.race([
        entered.promise,
        pending.then((result) => {
          throw new Error(`Cancellation did not reach worker: ${JSON.stringify(result)}`);
        }),
      ]);
      active = false;
      release.resolve();
      expect(await pending).toMatchObject({
        cancelled: false,
        reason: expect.stringContaining("Caller retired"),
      });
      expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)?.status).toBe(
        "running",
      );
    } finally {
      release.resolve();
      await pending;
    }
  });
});

it.each(["return", "runtime replacement", "assignment replacement"] as const)(
  "retires a custom runtime's cancellation control after %s",
  async (retirement) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const selectedTask = { ...task, runId: "selected-run", createdAt: 1_000 };
      upsertTaskWithDeliveryStateToSqlite({ task: selectedTask });
      const inherited = getDetachedTaskLifecycleRuntime();
      let retained: TaskCancellationControl | undefined;
      let effect = false;
      setDetachedTaskLifecycleRuntime({
        ...inherited,
        async cancelDetachedTaskRunById() {
          retained = captureTaskCancellationControl();
          expect(retained).toBeDefined();
          retained!.assertCurrent();
          if (retirement === "runtime replacement") {
            await Promise.resolve();
            setDetachedTaskLifecycleRuntime({ ...inherited });
          }
          if (retirement === "assignment replacement") {
            updateTask(task.taskId, { runId: "successor-run", createdAt: 100, endedAt: 100 });
          }
          retained!.assertCurrent();
          effect = true;
          return { found: true, cancelled: false, reason: "Custom runtime retained ownership." };
        },
      });
      const result = await cancelDetachedTaskRunByIdAsync(
        { cfg: {}, taskId: task.taskId },
        { selectedTask, assertCurrent() {} },
      );
      expect(effect).toBe(retirement === "return");
      expect(result.cancelled).toBe(false);
      expect(retained).toBeDefined();
      expect(() => retained!.assertCurrent()).toThrow();
      expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
        status: "running",
        runId: retirement === "assignment replacement" ? "successor-run" : "selected-run",
      });
    });
  },
);

it.each(["selected", "same-run peer"] as const)(
  "requires linked flow readiness for the %s task before cancellation dispatch",
  async (linked) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const flowId = "required-cancellation-flow";
      const selected: TaskRecord = {
        ...task,
        runtime: "subagent",
        runId: "required-flow-run",
        childSessionKey: "agent:main:subagent:required-flow",
        ...(linked === "selected" ? { parentFlowId: flowId } : {}),
      };
      upsertTaskFlowRegistryRecordToSqlite({
        flowId,
        syncMode: "task_mirrored",
        ownerKey: selected.ownerKey,
        goal: "Required cancellation state",
        status: "running",
        notifyPolicy: "silent",
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      upsertTaskWithDeliveryStateToSqlite({ task: selected });
      if (linked === "same-run peer") {
        upsertTaskWithDeliveryStateToSqlite({
          task: { ...selected, taskId: "linked-peer", parentFlowId: flowId },
        });
      }
      closeOpenClawStateDatabase();
      vi.spyOn(getTaskFlowRegistryStore(), "withSnapshotAsync").mockRejectedValue(
        new Error("Required flow registry is unavailable."),
      );
      const cancel = vi.fn(async () => ({ found: true, cancelled: true }));
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        cancelDetachedTaskRunById: cancel,
      });
      const result = await cancelDetachedTaskRunByIdAsync(
        { cfg: {}, taskId: selected.taskId },
        { selectedTask: selected, assertCurrent() {} },
      );
      expect(result).toMatchObject({
        cancelled: false,
        reason: expect.stringContaining("Required flow registry is unavailable."),
      });
      expect(cancel).not.toHaveBeenCalled();
      expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(selected.taskId)?.status).toBe(
        "running",
      );
    });
  },
);

it.each([
  "owned externally",
  "owned externally with later core arrival",
  "later core arrival",
  "delegates to later core arrival",
  "runtime failure",
] as const)("preserves external-only cancellation selection for %s", async (outcome) => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    const coreArrives = outcome !== "owned externally" && outcome !== "runtime failure";
    const entered = createDeferred();
    const release = createDeferred();
    let retained: TaskCancellationControl | undefined;
    const externalCancel = vi.fn(async () => {
      retained = captureTaskCancellationControl();
      expect(retained).toBeDefined();
      retained!.assertCurrent();
      entered.resolve();
      await release.promise;
      retained!.assertCurrent();
      if (outcome === "runtime failure") {
        throw new Error("External runtime unavailable.");
      }
      if (outcome === "delegates to later core arrival") {
        return cancelTaskById({ cfg: {}, taskId: task.taskId });
      }
      return outcome.startsWith("owned externally")
        ? { found: true, cancelled: true }
        : { found: false, cancelled: false };
    });
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      cancelDetachedTaskRunById: externalCancel,
    });
    const pending = cancelDetachedTaskRunByIdAsync(
      { cfg: {}, taskId: task.taskId },
      { selectedTask: undefined, assertCurrent() {} },
    );
    const settled = Promise.allSettled([pending]);
    try {
      await Promise.race([
        entered.promise,
        pending.then((result) => {
          throw new Error(`External owner was not reached: ${JSON.stringify(result)}`);
        }),
      ]);
      if (coreArrives) {
        upsertTaskWithDeliveryStateToSqlite({ task });
        await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
        expect((await prepareTaskRegistryRead())?.getTaskById(task.taskId)).toEqual(task);
      }
      release.resolve();
      expect(await pending).toMatchObject(
        outcome === "runtime failure"
          ? { found: false, cancelled: false, reason: "External runtime unavailable." }
          : outcome.startsWith("owned externally")
            ? { found: true, cancelled: true }
            : { found: outcome === "delegates to later core arrival", cancelled: false },
      );
      expect(externalCancel).toHaveBeenCalledOnce();
      expect(() => retained!.assertCurrent()).toThrow("no longer active");
      expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toEqual(
        coreArrives ? task : undefined,
      );
    } finally {
      release.resolve();
      await settled;
    }
  });
});

it("retains a registered runtime's durable cancellation after caller retirement", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    upsertTaskWithDeliveryStateToSqlite({ task });
    let active = true;
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      async cancelDetachedTaskRunById(params) {
        const result = await cancelTaskById(params);
        expect(result.cancelled).toBe(true);
        active = false;
        return result;
      },
    });
    const result = await cancelDetachedTaskRunByIdAsync(
      { cfg: {}, taskId: task.taskId },
      {
        selectedTask: task,
        assertCurrent() {
          if (!active) {
            throw new Error("Caller retired after settled cancellation.");
          }
        },
      },
    );
    expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)?.status).toBe(
      "cancelled",
    );
    expect(result).toMatchObject({ found: true, cancelled: true, task: { status: "cancelled" } });
  });
});

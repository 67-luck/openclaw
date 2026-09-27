import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import { captureDetachedTaskRuntimeOwner } from "./detached-task-runtime-state.js";
import { prepareTaskBackingRead } from "./task-backing-authority.js";
import {
  prepareTaskCancellationControl,
  withTaskCancellationContext,
  withTaskCancellationControl,
} from "./task-cancellation-context.js";
import { captureTaskCancellationSelection } from "./task-cancellation-selection.capture.js";
import { matchesTaskCancellationSelection } from "./task-cancellation-selection.js";
import { captureTaskMutationContext } from "./task-executor-mutation-effects.async.js";
import { cancelTaskById, type TaskCancellationResult } from "./task-registry-cancel.js";
import { tasks } from "./task-registry-state.js";
import type { TaskRecord } from "./task-registry.types.js";
import { getTaskRunOwner } from "./task-run-owner.js";

/** Callers retain their selected task and runtime owner across worker preparation. */
export async function cancelDetachedTaskRunByIdAsync(
  params: { cfg: OpenClawConfig; taskId: string; reason?: string },
  authority: { selectedTask: TaskRecord | undefined; assertCurrent: () => void },
): Promise<TaskCancellationResult> {
  const owner = captureDetachedTaskRuntimeOwner({ settlement: true });
  const core = owner.runtime ? undefined : captureTaskMutationContext();
  const selection =
    authority.selectedTask && captureTaskCancellationSelection(authority.selectedTask);
  const selected = selection?.task;
  const selectedRunOwner = selected && getTaskRunOwner(selected);
  let active = true;
  const assertCurrent = () => {
    if (!active) {
      throw new Error("Task cancellation is no longer active.");
    }
    // A core producer may enter its admitting registry while retaining this task's custody.
    if (core) {
      core.assertStores();
    } else {
      owner.assertCurrent();
    }
    authority.assertCurrent();
  };
  try {
    assertCurrent();
    const read = await prepareTaskBackingRead(params.taskId);
    assertCurrent();
    if (!read) {
      return {
        found: selected !== undefined,
        cancelled: false,
        reason: "Task persistence preparation did not settle.",
      };
    }
    const task = read.getTaskById(params.taskId);
    if (
      Boolean(task) !== Boolean(selected) ||
      (task && selected && !matchesTaskCancellationSelection(task, selected))
    ) {
      return {
        found: Boolean(task),
        cancelled: false,
        reason: "Task changed while cancellation was in progress.",
        task,
      };
    }
    const assertSelected = () => {
      assertCurrent();
      if (!selected) {
        return;
      }
      const current = tasks.get(selected.taskId);
      if (
        !current ||
        !matchesTaskCancellationSelection(current, selected) ||
        getTaskRunOwner(current) !== selectedRunOwner
      ) {
        throw new Error("Task changed while cancellation was in progress.");
      }
    };
    return await withTaskCancellationContext(
      () => {
        assertSelected();
        if (!selected) {
          throw new Error("Task changed while cancellation was in progress.");
        }
      },
      async () => {
        const runtime = owner.runtime;
        if (runtime) {
          const inherited = task && prepareTaskCancellationControl(task);
          const control = {
            prepareRead: inherited?.prepareRead,
            assertCurrent() {
              inherited?.assertCurrent();
              assertSelected();
            },
          };
          control.assertCurrent();
          const result = await withTaskCancellationControl(control, () =>
            runtime.cancelDetachedTaskRunById(params),
          );
          // The runtime owns its settled result; new fallback work still checks the caller.
          owner.assertCurrent();
          if (result.found) {
            return result;
          }
        }
        assertCurrent();
        return task
          ? cancelTaskById(params)
          : { found: false, cancelled: false, reason: "Task not found." };
      },
      { selectedTask: task },
    );
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    return { found: true, cancelled: false, reason: formatErrorMessage(error) };
  } finally {
    active = false;
    selection?.release();
  }
}

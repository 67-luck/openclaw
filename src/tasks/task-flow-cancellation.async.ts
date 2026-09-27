import { captureGatewayToolCallerAssertion } from "../agents/tools/gateway-caller-context.js";
import { formatErrorMessage } from "../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  matchesTaskFlowCancellationSelection,
  captureTaskFlowCancellationSelection,
  type TaskFlowCancellationRequest,
  type TaskFlowCancellationResult,
  type TaskFlowCancellationSelection,
} from "./task-flow-cancellation.types.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import {
  prepareTaskFlowRegistryRead,
  readResidentTaskFlow,
  runTaskFlowRegistryWorkerMutation,
} from "./task-flow-runtime-internal.js";
import { prepareTaskRegistryRead, prepareTaskRegistryReadOwner } from "./task-registry-read.js";
import { getTaskRegistryStore } from "./task-registry.store.js";

export async function cancelTaskFlowAsync(
  params: TaskFlowCancellationRequest & { callerOwnerKey?: string },
  assertInvocation?: () => void,
): Promise<TaskFlowCancellationResult> {
  const expected = params.expectedFlow && {
    ...captureTaskFlowCancellationSelection(params.expectedFlow),
    revision: params.expectedFlow.revision,
  };
  const context = captureOpenClawStateWorkerContext();
  const flowStore = getTaskFlowRegistryStore();
  const taskStore = getTaskRegistryStore();
  const assertCaller = captureGatewayToolCallerAssertion();
  const signal = getAsyncWorkSignal();
  let active = true;
  let selected: TaskFlowCancellationSelection | undefined;
  let intentPublished = false;
  const assertCurrent = () => {
    if (!active) {
      throw new Error("Flow cancellation is no longer active.");
    }
    context.admission.assertCurrent();
    assertCaller?.();
    assertInvocation?.();
    signal?.throwIfAborted();
    if (getTaskFlowRegistryStore() !== flowStore || getTaskRegistryStore() !== taskStore) {
      throw new Error("Flow cancellation owner is no longer current.");
    }
    if (
      intentPublished &&
      selected &&
      !matchesTaskFlowCancellationSelection(readResidentTaskFlow(selected.flowId), selected)
    ) {
      throw new Error("Flow changed while cancellation was in progress.");
    }
  };
  try {
    assertCurrent();
    const flowRead = await prepareTaskFlowRegistryRead(context);
    assertCurrent();
    if (!flowRead) {
      throw new Error("Flow cancellation read preparation did not settle.");
    }
    const { runOpenClawStateWorkerOperation } =
      await import("../state/openclaw-state-worker-store.js");
    assertCurrent();
    return await runOpenClawStateWorkerOperation(
      context,
      async (scope) => {
        const flow = await scope.execute({
          type: "flows.current",
          input: { flowId: params.flowId.trim() },
        });
        assertCurrent();
        if (
          !flow ||
          (params.callerOwnerKey !== undefined &&
            flow.ownerKey.trim() !== params.callerOwnerKey.trim())
        ) {
          return { found: false, cancelled: false, reason: "Flow not found." };
        }
        if (
          expected &&
          (!matchesTaskFlowCancellationSelection(flow, expected) ||
            flow.revision !== expected.revision)
        ) {
          return {
            found: true,
            cancelled: false,
            reason: "Flow changed while cancellation was in progress.",
            flow,
          };
        }
        const selection = expected ?? captureTaskFlowCancellationSelection(flow);
        selected = selection;
        const mutate = async (phase: "request" | "finalize", expectedRevision: number) => {
          let publicationSettled = true;
          const result = await runTaskFlowRegistryWorkerMutation(
            {
              flowId: flow.flowId,
              admission: context.admission,
              onPublicationError: () => {
                publicationSettled = false;
              },
            },
            () =>
              scope.execute({
                type: "flows.cancel",
                input: { selected: selection, phase, expectedRevision, now: Date.now() },
              }),
            () => scope.execute({ type: "flows.current", input: { flowId: flow.flowId } }),
          );
          assertCurrent();
          if (!publicationSettled) {
            throw new Error("Flow cancellation publication did not settle.");
          }
          if (!flowRead.isTaskFlowCurrent(flow.flowId)) {
            // A newer committed publication can supersede this receipt's readback.
            const published = await prepareTaskFlowRegistryRead(context);
            assertCurrent();
            if (!published?.isTaskFlowCurrent(flow.flowId)) {
              throw new Error("Flow cancellation publication did not settle.");
            }
          }
          return result;
        };
        const { dispatch, ...requested } = await mutate("request", flow.revision);
        assertCurrent();
        if (!dispatch) {
          return requested;
        }
        intentPublished = true;
        assertCurrent();
        if (dispatch.length > 0) {
          const { cancelDetachedTaskRunByIdAsync } =
            await import("./task-executor-cancel.async.js");
          assertCurrent();
          for (const task of dispatch) {
            await cancelDetachedTaskRunByIdAsync(
              { cfg: params.cfg, taskId: task.taskId },
              { selectedTask: task, assertCurrent },
            );
            assertCurrent();
          }
          const taskReadOwner = await prepareTaskRegistryReadOwner(context, taskStore);
          assertCurrent();
          const taskRead = await prepareTaskRegistryRead(taskReadOwner);
          assertCurrent();
          // Later notification metadata keeps its own publication owner.
          if (!taskRead || dispatch.some((task) => !taskRead.isTaskCurrent(task.taskId))) {
            throw new Error("Child task cancellation publication did not settle.");
          }
        }
        const current = await scope.execute({
          type: "flows.current",
          input: { flowId: flow.flowId },
        });
        assertCurrent();
        if (!current || !matchesTaskFlowCancellationSelection(current, selection)) {
          return {
            found: Boolean(current),
            cancelled: false,
            reason: "Flow changed while cancellation was in progress.",
          };
        }
        const { dispatch: _dispatch, ...result } = await mutate("finalize", current.revision);
        return result;
      },
      {
        assertCurrent,
        requireStateLifecycle: true,
        createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
          context.admission.databasePath,
        ]),
      },
    );
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    return { found: selected !== undefined, cancelled: false, reason: formatErrorMessage(error) };
  } finally {
    active = false;
  }
}

export function cancelFlowByIdForOwner(
  params: TaskFlowCancellationRequest & { callerOwnerKey: string },
  assertInvocation?: () => void,
): Promise<TaskFlowCancellationResult> {
  return cancelTaskFlowAsync(params, assertInvocation);
}

import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { TaskRecord } from "./task-registry.types.js";

export type TaskCancellationTarget = Readonly<
  Pick<TaskRecord, "taskId" | "scopeKind" | "ownerKey" | "requesterAgentId">
>;

export type TaskCancellationControl = {
  prepareRead?: () => Promise<void> | undefined;
  assertCurrent: () => void;
};

export type TaskCancellationContext = {
  isActive: () => boolean;
  assertSelected: (task: TaskRecord | undefined) => void;
  assertCurrent: (task: TaskCancellationTarget) => void;
  prepareRead: () => Promise<void> | undefined;
};

export const taskCancellationContexts = resolveGlobalSingleton(
  Symbol.for("openclaw.taskCancellationContext"),
  () => ({
    caller: new AsyncLocalStorage<TaskCancellationContext>(),
    prepared: new AsyncLocalStorage<TaskCancellationControl>(),
  }),
);

/** Reading inherited custody does not initialize the core persistence owners. */
export function captureTaskCancellationControl(): TaskCancellationControl | undefined {
  return taskCancellationContexts.prepared.getStore();
}

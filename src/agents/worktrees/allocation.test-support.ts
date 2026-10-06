import type { Worker } from "node:worker_threads";
import { vi } from "vitest";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as workerCpu from "../../infra/worker-cpu.js";

/** Capture this operation's first lease worker so failure revokes its actual live owner. */
export function captureWorktreeAllocationHeartbeat(): () => Promise<void> {
  const heartbeatUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.stateLeaseHeartbeat);
  const createWorker = workerCpu.createCpuTrackedWorker;
  let heartbeat: Worker | undefined;
  vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((...args) => {
    const worker = createWorker(...args);
    if (!heartbeat && String(args[0]) === heartbeatUrl.href) {
      heartbeat = worker;
    }
    return worker;
  });
  return async () => {
    if (!heartbeat) {
      throw new Error("Worktree allocation heartbeat has not started");
    }
    await heartbeat.terminate();
  };
}

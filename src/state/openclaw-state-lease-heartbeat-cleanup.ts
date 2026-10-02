import type { Worker } from "node:worker_threads";
import { createDeferredCore } from "../shared/deferred.js";
import type { LeaseHeartbeatParentMessage } from "./openclaw-state-lease-heartbeat-shared.js";

export type LeaseHeartbeatCleanup = {
  readonly pending: boolean;
  close(): Promise<void>;
};

/** Acknowledgement follows the last native commit and every queued receipt on the same port. */
export async function drainLeaseHeartbeatMigrationReceipts(
  worker: Worker,
  pathname: string,
  acknowledgement: { promise: Promise<void>; reject(error: Error): void },
): Promise<void> {
  const { readSqliteInspectionBudget } = await import("../infra/sqlite-readonly-worker.js");
  const budget = readSqliteInspectionBudget("migration receipt drainage", pathname);
  const onExit = () =>
    acknowledgement.reject(new Error("State lease exited without draining migration receipts"));
  worker.once("exit", onExit);
  const timeout = setTimeout(
    () => acknowledgement.reject(new Error("State lease migration receipt drainage timed out")),
    Math.min(2_147_483_647, 2 * budget.timeoutMs),
  );
  timeout.unref();
  try {
    worker.postMessage({ shutdown: "drain" } satisfies LeaseHeartbeatParentMessage, []);
    await acknowledgement.promise;
  } finally {
    clearTimeout(timeout);
    worker.removeListener("exit", onExit);
  }
}

export function createLeaseHeartbeatCleanup(params: {
  cancel: () => void;
  drain?: (worker: Worker) => Promise<void>;
}) {
  let worker: Worker | undefined;
  let exitCode: number | undefined;
  const exited = createDeferredCore<number>();
  const startupRenewals = new Set<Promise<unknown>>();
  let closed = false;
  let stopping: Promise<number> | undefined;

  const cancel = () => {
    closed = true;
    params.cancel();
  };
  const stop = (): Promise<number> => {
    cancel();
    if (!stopping) {
      stopping = Promise.resolve().then(async () => {
        let drainFailure: unknown;
        if (worker && exitCode === undefined) {
          try {
            await params.drain?.(worker);
          } catch (error) {
            drainFailure = error;
          } finally {
            if (exitCode === undefined) {
              await worker.terminate();
            }
          }
          // A terminate result is not a substitute for the native exit event.
          await exited.promise;
        }
        await Promise.allSettled(startupRenewals);
        if (drainFailure !== undefined) {
          throw drainFailure;
        }
        return exitCode ?? 0;
      });
      void stopping.catch(() => {
        stopping = undefined;
      });
    }
    return stopping;
  };
  const cleanup: LeaseHeartbeatCleanup = {
    get pending() {
      // Publication precedes acquisition, so startup itself retains this owner.
      return (
        (!closed && worker === undefined) ||
        (worker !== undefined && exitCode === undefined) ||
        startupRenewals.size !== 0
      );
    },
    async close() {
      await stop();
    },
  };
  const assertOpen = () => {
    if (closed) {
      throw new Error("state lease heartbeat closed before startup");
    }
  };
  return {
    cleanup,
    stop,
    async joinStartupRenewals() {
      await Promise.allSettled(startupRenewals);
    },
    retainStartupRenewal(operation: Promise<unknown>) {
      assertOpen();
      startupRenewals.add(operation);
      const settled = () => startupRenewals.delete(operation);
      void operation.then(settled, settled);
    },
    start(createWorker: () => Worker) {
      assertOpen();
      worker = createWorker();
      worker.once("exit", (code) => {
        exitCode = code;
        exited.resolve(code);
      });
      return worker;
    },
    failStartup(error: unknown): never {
      cancel();
      throw error;
    },
  };
}

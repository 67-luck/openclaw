import { randomUUID } from "node:crypto";
import type { HeapInfo } from "node:v8";
import { MessageChannel, receiveMessageOnPort, type Transferable } from "node:worker_threads";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveNodeCompileCacheEnv } from "./node-compile-cache-env.js";
import {
  SqliteWorkerError,
  type SqliteWorkerReply,
  type SqliteWorkerRequest,
} from "./sqlite-worker-contract.js";
import {
  SQLITE_WORKER_HEAP_LIMIT_MB,
  SQLITE_WORKER_PROTOCOL_WAIT_NS,
  type SqliteWorkerTransportReply,
  type SqliteWorkerTransportRequest,
} from "./sqlite-worker-transport-contract.js";
import { createCpuTrackedWorker, registerNestedWorkerSource } from "./worker-cpu.js";

/** A private native transport; the broker still owns every job, grant and result. */
export function createSqliteWorkerTransport(options: {
  serviceUrl: URL;
  carrierUrl: URL;
  reply(reply: SqliteWorkerReply, pumping: boolean): void;
  posted(job: number, actor: number, attemptedAtNs: bigint): void;
  failure(this: void, error: Error): void;
  childExit(code: number, error?: string): void;
}) {
  const { port1, port2 } = new MessageChannel();
  const service = randomUUID(),
    child = randomUUID();
  const sourceArgs = (url: URL) =>
    url.pathname.endsWith(".ts") ? ["--import", import.meta.resolve("tsx/esm")] : [];
  const worker = (() => {
    try {
      return createCpuTrackedWorker(options.serviceUrl, {
        workerData: {
          port: port2,
          service,
          child,
          carrierUrl: options.carrierUrl.href,
          execArgv: sourceArgs(options.carrierUrl),
        },
        transferList: [port2],
        execArgv: sourceArgs(options.serviceUrl),
        env: resolveNodeCompileCacheEnv(),
        resourceLimits: { maxOldGenerationSizeMb: SQLITE_WORKER_HEAP_LIMIT_MB },
      });
    } catch (error) {
      port1.close();
      port2.close();
      throw error;
    }
  })();
  let nextSequence = 0;
  let retireChild: (() => void) | undefined;
  let stopped = false;
  let cpu:
    | {
        sequence: number;
        result: ReturnType<typeof createDeferredCore<NodeJS.CpuUsage | undefined>>;
      }
    | undefined;
  let heap:
    | { sequence: number; result: ReturnType<typeof createDeferredCore<HeapInfo | undefined>> }
    | undefined;
  const statuses = new Map<number, { job: number; accept(): void }>();
  const send = (request: SqliteWorkerTransportRequest, transfers: readonly Transferable[] = []) =>
    worker.postMessage(request, transfers);
  const stopSamples = () => {
    stopped = true;
    retireChild?.();
    retireChild = undefined;
    cpu?.result.resolve(undefined);
    heap?.result.resolve(undefined);
    cpu = undefined;
    heap = undefined;
  };
  const receive = (message: SqliteWorkerTransportReply, pumping = false) => {
    if (message.service !== service || message.child !== child) {
      options.failure(new Error("SQLite transport returned a different native incarnation"));
      return;
    }
    switch (message.kind) {
      case "ready":
        if (retireChild || stopped) {
          return;
        }
        retireChild = registerNestedWorkerSource(options.carrierUrl, {
          cpuUsage() {
            if (stopped) {
              return Promise.resolve(undefined);
            }
            if (!cpu) {
              cpu = { sequence: ++nextSequence, result: createDeferredCore() };
              try {
                send({ kind: "sample", service, child, sequence: cpu.sequence, metric: "cpu" });
              } catch {
                cpu.result.resolve(undefined);
              }
            }
            return cpu.result.promise;
          },
          getHeapStatistics() {
            if (stopped) {
              return Promise.resolve(undefined);
            }
            if (!heap) {
              heap = { sequence: ++nextSequence, result: createDeferredCore() };
              try {
                send({ kind: "sample", service, child, sequence: heap.sequence, metric: "heap" });
              } catch {
                heap.result.resolve(undefined);
              }
            }
            return heap.result.promise;
          },
        });
        return;
      case "posted":
        options.posted(message.job, message.actor, message.attemptedAtNs);
        return;
      case "reply":
        options.reply(message.reply, pumping);
        return;
      case "status": {
        const pending = statuses.get(message.sequence);
        if (pending?.job === message.job) {
          statuses.delete(message.sequence);
          pending.accept();
        }
        return;
      }
      case "cpu":
        if (cpu?.sequence === message.sequence) {
          cpu.result.resolve(message.value);
          cpu = undefined;
        }
        return;
      case "heap":
        if (heap?.sequence === message.sequence) {
          heap.result.resolve(message.value);
          heap = undefined;
        }
        return;
      case "exit":
        stopSamples();
        options.childExit(message.code, message.error);
    }
  };
  const pump = () => {
    const queued = receiveMessageOnPort(port1);
    if (!queued) {
      return false;
    }
    // SAFETY: Only the captured service owns this private channel; receive checks both incarnations.
    receive(queued.message as SqliteWorkerTransportReply, true);
    return true;
  };
  port1.on("message", receive);
  port1.unref();
  return {
    worker,
    pump,
    post(this: void, request: SqliteWorkerRequest, transfers: readonly Transferable[]) {
      send({ kind: "request", service, child, request }, transfers);
    },
    watch(job: number) {
      let pending: { sequence: number; at: bigint } | undefined;
      let next = 0n;
      return {
        check() {
          const now = process.hrtime.bigint();
          if (pending && now - pending.at >= SQLITE_WORKER_PROTOCOL_WAIT_NS) {
            throw new SqliteWorkerError(
              "SQLite native transport custody is unknown",
              "outcome-unknown",
            );
          }
          if (!pending && now >= next) {
            const sequence = ++nextSequence;
            pending = { sequence, at: now };
            statuses.set(sequence, {
              job,
              accept() {
                pending = undefined;
                next = process.hrtime.bigint() + 250_000_000n;
              },
            });
            send({ kind: "status", service, child, sequence, job });
          }
        },
        finish() {
          if (pending) {
            statuses.delete(pending.sequence);
          }
        },
      };
    },
    nativeExit() {
      // An actual service exit joins its registered child. Drain facts before using that witness.
      let failure: { error: unknown } | undefined;
      try {
        while (true) {
          try {
            if (!pump()) {
              break;
            }
          } catch (error) {
            failure ??= { error };
          }
        }
      } finally {
        stopSamples();
        port1.close();
      }
      if (failure) {
        throw failure.error;
      }
    },
  };
}

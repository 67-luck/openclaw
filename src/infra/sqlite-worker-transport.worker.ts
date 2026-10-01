import { parentPort, Worker, workerData } from "node:worker_threads";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import type { SqliteWorkerReply } from "./sqlite-worker-contract.js";
import {
  SQLITE_WORKER_HEAP_LIMIT_MB,
  type SqliteWorkerTransportInput,
  type SqliteWorkerTransportReply,
  type SqliteWorkerTransportRequest,
} from "./sqlite-worker-transport-contract.js";

if (!parentPort) {
  throw new Error("SQLite transport requires its native owner port");
}
// SAFETY: The broker constructs this private entry with its captured carrier and channel.
const input = workerData as SqliteWorkerTransportInput;
const { port, service, child } = input;
const send = (reply: SqliteWorkerTransportReply) => port.postMessage(reply);
const worker = new Worker(new URL(input.carrierUrl), {
  execArgv: input.execArgv,
  resourceLimits: { maxOldGenerationSizeMb: SQLITE_WORKER_HEAP_LIMIT_MB },
});
let stopped = false;
let failure: string | undefined;
let postedJob: number | undefined;
const sampling = new Set<"cpu" | "heap">();

worker.on("message", (reply: SqliteWorkerReply) => {
  port.postMessage(
    { kind: "reply", service, child, reply },
    reply.ok && reply.value.buffer instanceof ArrayBuffer ? [reply.value.buffer] : [],
  );
});
worker.on("error", (error) => {
  failure ??= coerceErrorMessage(error);
});
worker.on("messageerror", (error) => {
  failure ??= String(error);
  void worker.terminate().catch(() => undefined);
});
const onExited = (code: number) => {
  // The child channel is drained and the native thread joined before forwarding this witness.
  stopped = true;
  send({ kind: "exit", service, child, code, error: failure });
  port.close();
  parentPort?.close();
};
worker.once("exit", (code) => {
  stopped = true;
  // Bun joins after the raw exit callback; this continuation is its existing native barrier.
  if (process.versions.bun) {
    void Promise.resolve().then(() => onExited(code));
  } else {
    onExited(code);
  }
});

parentPort.on("message", (message: SqliteWorkerTransportRequest) => {
  if (message.service !== service || message.child !== child) {
    throw new Error("SQLite transport incarnation differs from its native owner");
  }
  if (stopped) {
    return;
  }
  if (message.kind === "status") {
    // This acknowledges custody, not SQL progress or a completed command.
    send({ kind: "status", service, child, sequence: message.sequence, job: message.job });
    return;
  }
  if (message.kind === "sample") {
    const { metric, sequence } = message;
    if (sampling.has(metric)) {
      return;
    }
    sampling.add(metric);
    const sample = Promise.resolve().then(() =>
      metric === "cpu"
        ? Promise.resolve()
            .then(() => worker.cpuUsage())
            .then(
              (value) => send({ kind: "cpu", service, child, sequence, value }),
              () => send({ kind: "cpu", service, child, sequence }),
            )
        : Promise.resolve()
            .then(() => worker.getHeapStatistics())
            .then(
              (value) => send({ kind: "heap", service, child, sequence, value }),
              () => send({ kind: "heap", service, child, sequence }),
            ),
    );
    void sample.finally(() => sampling.delete(metric)).catch(() => undefined);
    return;
  }
  const request = message.request;
  const attemptedAtNs = process.hrtime.bigint();
  worker.postMessage(
    request,
    [
      request.operationAdmission,
      ...(request.type === "open" ? [request.backendService] : []),
    ].filter((entry) => entry !== undefined),
  );
  if (postedJob !== request.id) {
    postedJob = request.id;
    send({ kind: "posted", service, child, job: request.id, actor: request.actor, attemptedAtNs });
  }
});
send({ kind: "ready", service, child });

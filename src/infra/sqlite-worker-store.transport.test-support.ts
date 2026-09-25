import { Worker } from "node:worker_threads";
import { vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SqliteWorkerReply, SqliteWorkerRequest } from "./sqlite-worker-contract.js";
import * as transportOwner from "./sqlite-worker-transport.js";
import * as workerCpu from "./worker-cpu.js";

export function createReadyPredecessorReleaser(gatePath: string) {
  const release = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
  const ready = createDeferred();
  const releaser = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     const { writeFileSync } = require("node:fs");
     const release = new Int32Array(workerData.release);
     parentPort.postMessage("ready");
     while (Atomics.load(release, 0) === 0) Atomics.wait(release, 0, 0);
     Atomics.wait(release, 1, 0, 5_500);
     writeFileSync(workerData.gatePath, "released");`,
    { eval: true, workerData: { release: release.buffer, gatePath } },
  );
  const releaserExit = new Promise<void>((resolve, reject) => {
    releaser.once("message", () => ready.resolve());
    releaser.once("error", (error) => {
      ready.reject(error);
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- The actual Worker error is retained verbatim, including raw OPEN failures.
      reject(error);
    });
    releaser.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const error = new Error(`Fixture releaser exited with code ${code}`);
        ready.reject(error);
        reject(error);
      }
    });
  });
  void releaserExit.catch(() => undefined);
  return { release, ready, releaserExit };
}

export function observeNativeOpenFailure(
  position: "service" | "data",
  value: "undefined" | "string" | "Error",
) {
  const workers: Worker[] = [];
  const exits: Promise<number>[] = [];
  const errors: unknown[] = [];
  const childExits: Array<{ code: number; error?: string }> = [];
  const failure = "native open fixture failure";
  const expression =
    value === "undefined"
      ? "undefined"
      : value === "string"
        ? JSON.stringify(failure)
        : `new Error(${JSON.stringify(failure)})`;
  const requestExpression =
    position === "service"
      ? 'message?.kind === "request" ? message.request : undefined'
      : "message";
  const preload = `
    import { parentPort } from "node:worker_threads";
    const on = parentPort.on;
    parentPort.on = function(event, listener) {
      if (event !== "message") return Reflect.apply(on, this, [event, listener]);
      return Reflect.apply(on, this, [event, function(...args) {
        const message = args[0];
        const request = ${requestExpression};
        // A separate throwing listener would still let MessagePort dispatch OPEN.
        if (request?.type === "open") throw ${expression};
        return Reflect.apply(listener, this, args);
      }]);
    };
  `;
  const createWorker = workerCpu.createCpuTrackedWorker;
  const workerSpy = vi
    .spyOn(workerCpu, "createCpuTrackedWorker")
    .mockImplementation((filename, options) => {
      if (!options?.workerData?.carrierUrl) {
        return createWorker(filename, options);
      }
      const injected = ["--import", `data:text/javascript,${encodeURIComponent(preload)}`];
      const worker = createWorker(
        filename,
        position === "service"
          ? { ...options, execArgv: [...(options.execArgv ?? []), ...injected] }
          : {
              ...options,
              workerData: {
                ...options.workerData,
                execArgv: [...options.workerData.execArgv, ...injected],
              },
            },
      );
      workers.push(worker);
      worker.on("error", (error) => errors.push(error));
      exits.push(
        new Promise((resolve) => {
          worker.once("exit", resolve);
        }),
      );
      return worker;
    });
  const createTransport = transportOwner.createSqliteWorkerTransport;
  const transportSpy = vi
    .spyOn(transportOwner, "createSqliteWorkerTransport")
    .mockImplementation((options) =>
      createTransport({
        ...options,
        childExit(code, error) {
          childExits.push({ code, error });
          options.childExit(code, error);
        },
      }),
    );
  return { workers, exits, errors, childExits, failure, transportSpy, workerSpy };
}

type ObservedStorageTransport =
  | ReturnType<typeof transportOwner.createSqliteWorkerTransport>
  | Worker;

export function observeStorageTransport() {
  const hooks: {
    reply?: (
      reply: SqliteWorkerReply,
      deliver: (reply?: SqliteWorkerReply) => void,
      transport: ObservedStorageTransport,
    ) => void;
    beforePost?: (request: SqliteWorkerRequest, transport: ObservedStorageTransport) => void;
    posted?: (request: SqliteWorkerRequest) => void;
  } = {};
  const requests: SqliteWorkerRequest[] = [];
  const records: Array<{
    request: SqliteWorkerRequest;
    transport: ObservedStorageTransport;
    worker: Worker;
  }> = [];
  const workers = new Set<Worker>();
  const failures: unknown[] = [];
  const create = transportOwner.createSqliteWorkerTransport;
  const transport = vi
    .spyOn(transportOwner, "createSqliteWorkerTransport")
    .mockImplementation((options) => {
      const posted = new Map<number, SqliteWorkerRequest>();
      const value = create({
        ...options,
        reply(reply, pumping) {
          const deliver = (replacement = reply) => options.reply(replacement, pumping);
          if (hooks.reply) {
            hooks.reply(reply, deliver, value);
          } else {
            deliver();
          }
        },
        posted(id, actor, at) {
          options.posted(id, actor, at);
          const request = posted.get(id);
          posted.delete(id);
          if (request) {
            hooks.posted?.(request);
          }
        },
        failure(error) {
          failures.push(error);
          options.failure(error);
        },
        childExit(code, error) {
          if (error) {
            failures.push(error);
          }
          options.childExit(code, error);
        },
      });
      workers.add(value.worker);
      const post = value.post;
      value.post = (request, transfers) => {
        requests.push(request);
        records.push({ request, transport: value, worker: value.worker });
        posted.set(request.id, request);
        hooks.beforePost?.(request, value);
        post(request, transfers);
      };
      return value;
    });
  // Bun's exclusive carrier has no service port; keep observing the actual native replies.
  const emit = vi.spyOn(Worker.prototype, "emit");
  emit.mockRestore();
  const events = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
    this: Worker,
    ...args: Parameters<Worker["emit"]>
  ) {
    if (args[0] === "error") {
      failures.push(args[1]);
    }
    if (process.versions.bun && args[0] === "message" && hooks.reply) {
      const reply = args[1] as SqliteWorkerReply;
      hooks.reply(
        reply,
        (replacement = reply) => {
          Reflect.apply(emit, this, ["message", replacement]);
        },
        this,
      );
      return true;
    }
    return Reflect.apply(emit, this, args);
  });
  const post = vi.spyOn(Worker.prototype, "postMessage");
  post.mockRestore();
  const sends = process.versions.bun
    ? vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
        this: Worker,
        ...args: Parameters<Worker["postMessage"]>
      ) {
        const request = args[0] as SqliteWorkerRequest;
        workers.add(this);
        requests.push(request);
        records.push({ request, transport: this, worker: this });
        hooks.beforePost?.(request, this);
        Reflect.apply(post, this, args);
        hooks.posted?.(request);
      })
    : undefined;
  return {
    hooks,
    requests,
    records,
    workers,
    failures,
    restore() {
      hooks.reply = undefined;
      hooks.beforePost = undefined;
      hooks.posted = undefined;
      transport.mockRestore();
      events.mockRestore();
      sends?.mockRestore();
    },
  };
}

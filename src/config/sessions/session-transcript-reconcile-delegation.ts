import { randomUUID } from "node:crypto";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { joinOwnedWorkerTasks } from "../../infra/worker-task-pool-owned.js";
import type { OwnedWorkerTask } from "../../infra/worker-task-pool.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { SessionTranscriptReconcileWorkerInput } from "./session-transcript-reconcile.worker.js";

type LogicalOwner = { id: string; agentId: string; path: string; incarnation: string };
export type SessionReconcileEndpointIdentity = { id: string; generation: number };
type MemoryInput = Extract<SessionTranscriptReconcileWorkerInput, { mode: "memory" }>;
type Request = SessionReconcileEndpointIdentity &
  (
    | {
        kind: "begin";
        operation: string;
        owner: LogicalOwner;
      }
    | {
        kind: "start";
        operation: string;
        task: string;
        input: MemoryInput;
        port: MessagePort;
      }
    | { kind: "cancel"; operation: string; task: string }
    | { kind: "finish"; operation: string; attempt: number }
  );
type Reply = SessionReconcileEndpointIdentity &
  (
    | {
        kind: "task";
        operation: string;
        task: string;
        error?: string;
      }
    | { kind: "cancel"; operation: string }
    | { kind: "finish"; operation: string; attempt: number; error?: string }
  );

export type SessionReconcileTask = {
  port: MessagePort;
  controller: AbortController;
  completion: Promise<void>;
  closed: Promise<void>;
  leaseRelease: Promise<{ released: boolean; releaseFailed: boolean; failure?: Error }>;
};

export type SessionReconcileTaskDelegate = {
  begin(
    owner: { agentId: string; path: string },
    controller: AbortController,
  ): {
    startTask(input: SessionTranscriptReconcileWorkerInput): SessionReconcileTask;
    close(): Promise<void>;
  };
};

/** Ordinary endpoint delivery owns compute delegation; the ready pump never services this port. */
export function createSessionReconcileHostEndpoint(params: {
  generation: number;
  assertCurrent(): void;
  startTask(input: MemoryInput, port: MessagePort, signal: AbortSignal): OwnedWorkerTask<void>;
}) {
  const identity = Object.freeze({ id: randomUUID(), generation: params.generation });
  const { port1: port, port2: workerPort } = new MessageChannel();
  type Task = {
    controller: AbortController;
    native?: OwnedWorkerTask<void>;
    joined: Promise<void>;
    closeFailed?: true;
  };
  type Operation = {
    owner: LogicalOwner;
    dataFinished: ReturnType<typeof createDeferredCore<void>>;
    finishing: boolean;
    cancelled: boolean;
    tasks: Map<string, Task>;
    closing?: Promise<void>;
    closeFailure?: { error: unknown };
  };
  const operations = new Map<string, Operation>();
  const logical = new Map<string, { assertCurrent(owner: LogicalOwner): void; revoked: boolean }>();
  let stopped = false;
  let closing = false;
  const send = (reply: Reply) => {
    if (!stopped) {
      try {
        port.postMessage(reply);
      } catch {
        cancelEndpoint();
      }
    }
  };
  const cancel = (id: string, operation: Operation) => {
    operation.cancelled = true;
    for (const task of operation.tasks.values()) {
      task.controller.abort();
    }
    if (!stopped) {
      try {
        port.postMessage({ ...identity, kind: "cancel", operation: id } satisfies Reply);
      } catch {
        /* Failed delivery does not settle the data operation. */
      }
    }
  };
  const cancelEndpoint = () => {
    closing = true;
    for (const [id, operation] of operations) {
      cancel(id, operation);
    }
  };
  const join = (operation: Operation, retry: boolean): Promise<void> => {
    if (operation.closing) {
      return operation.closing;
    }
    if (operation.closeFailure && !retry) {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Repeated close exposes the original cached native cleanup failure unchanged.
      return Promise.reject(operation.closeFailure.error);
    }
    const failed = operation.closeFailure;
    const attempt = (async () => {
      // Data completion follows its final handler, source clear, and native borrow release.
      await operation.dataFinished.promise;
      if (failed) {
        for (const task of operation.tasks.values()) {
          if (!task.closeFailed || !task.native) {
            continue;
          }
          const native = task.native;
          // Only another explicit close retries failed retirement. Never execute
          // the task again or discard the original controller/native identity.
          task.joined = Promise.resolve()
            .then(() => native.close())
            .then(() => {
              task.closeFailed = undefined;
            });
        }
      }
      const results = await Promise.allSettled(
        [...operation.tasks.values()].map((task) => task.joined),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) {
        throw new AggregateError(errors, "Transcript compute cleanup did not join");
      }
    })();
    operation.closing = attempt.catch((error: unknown) => {
      operation.closeFailure = { error };
      operation.closing = undefined;
      throw error;
    });
    return operation.closing;
  };
  port.on("close", cancelEndpoint);
  port.on("messageerror", cancelEndpoint);
  port.on("message", (message: Request) => {
    if (message.id !== identity.id || message.generation !== identity.generation) {
      if (message.kind === "start") {
        message.port.close();
      }
      return;
    }
    if (message.kind === "begin") {
      const operation: Operation = {
        owner: message.owner,
        dataFinished: createDeferredCore(),
        finishing: false,
        cancelled: false,
        tasks: new Map(),
      };
      if (operations.has(message.operation)) {
        return;
      }
      operations.set(message.operation, operation);
      if (stopped) {
        operation.finishing = true;
        operation.dataFinished.resolve();
      }
      try {
        params.assertCurrent();
        const owner = logical.get(message.owner.id);
        if (closing || stopped || !owner || owner.revoked) {
          throw new Error("Transcript compute owner is closing");
        }
        owner.assertCurrent(message.owner);
      } catch {
        cancel(message.operation, operation);
      }
      return;
    }
    const operation = operations.get(message.operation);
    if (!operation) {
      if (message.kind === "start") {
        message.port.close();
        send({
          ...identity,
          kind: "task",
          operation: message.operation,
          task: message.task,
          error: "Transcript compute operation is unavailable",
        });
      }
      return;
    }
    if (message.kind === "cancel") {
      operation.tasks.get(message.task)?.controller.abort();
      return;
    }
    if (message.kind === "finish") {
      operation.finishing = true;
      operation.dataFinished.resolve();
      void join(operation, message.attempt > 1).then(
        () => {
          send({
            ...identity,
            kind: "finish",
            operation: message.operation,
            attempt: message.attempt,
          });
          operations.delete(message.operation);
        },
        (error: unknown) =>
          send({
            ...identity,
            kind: "finish",
            operation: message.operation,
            attempt: message.attempt,
            error: toStringifiedError(error).message,
          }),
      );
      return;
    }
    if (operation.tasks.has(message.task) || operation.cancelled || operation.finishing) {
      message.port.close();
      send({
        ...identity,
        kind: "task",
        operation: message.operation,
        task: message.task,
        error: "Transcript compute start was revoked",
      });
      return;
    }
    const controller = new AbortController();
    const task: Task = { controller, joined: Promise.resolve() };
    operation.tasks.set(message.task, task);
    try {
      params.assertCurrent();
      const owner = logical.get(operation.owner.id);
      if (closing || stopped || !owner || owner.revoked) {
        throw new Error("Transcript compute owner is closing");
      }
      owner.assertCurrent(operation.owner);
      const native = params.startTask(message.input, message.port, controller.signal);
      task.native = native;
      task.joined = (async () => {
        let failure: { error: unknown } | undefined;
        try {
          await native.result;
        } catch (error) {
          failure = { error };
        }
        try {
          await native.close();
        } catch (error) {
          task.closeFailed = true;
          failure = { error };
          throw error;
        } finally {
          message.port.close();
          send({
            ...identity,
            kind: "task",
            operation: message.operation,
            task: message.task,
            ...(failure ? { error: toStringifiedError(failure.error).message } : {}),
          });
        }
      })();
      void task.joined.catch(() => undefined);
    } catch (error) {
      message.port.close();
      send({
        ...identity,
        kind: "task",
        operation: message.operation,
        task: message.task,
        error: toStringifiedError(error).message,
      });
    }
  });
  return {
    identity,
    port: workerPort,
    enroll(this: void, target: { id: string }, assertCurrent: (owner: LogicalOwner) => void) {
      if (logical.has(target.id) || closing || stopped) {
        throw new Error("Transcript compute endpoint cannot enroll this owner");
      }
      const owner = { assertCurrent, revoked: false };
      logical.set(target.id, owner);
      return {
        revoke() {
          owner.revoked = true;
          for (const [id, operation] of operations) {
            if (operation.owner.id === target.id) {
              cancel(id, operation);
            }
          }
        },
        async join() {
          const selected = [...operations].filter(
            ([, operation]) => operation.owner.id === target.id,
          );
          await joinOwnedWorkerTasks(selected.map(([, operation]) => join(operation, true)));
          logical.delete(target.id);
        },
      };
    },
    nativeStopped() {
      stopped = true;
      for (const [id, operation] of operations) {
        cancel(id, operation);
        operation.finishing = true;
        operation.dataFinished.resolve();
      }
    },
    async close() {
      cancelEndpoint();
      await joinOwnedWorkerTasks(
        [...operations.values()].map((operation) => join(operation, true)),
      );
      operations.clear();
      port.close();
      workerPort.close();
    },
  };
}

/** The data owner keeps source frames and all projection writes; only compute task custody crosses. */
export function createSessionReconcileTaskDelegate(
  port: MessagePort,
  identity: SessionReconcileEndpointIdentity,
  resolveOwner: (owner: { agentId: string; path: string }) => LogicalOwner,
): SessionReconcileTaskDelegate {
  type Operation = {
    controller: AbortController;
    closing?: { attempt: number; done: ReturnType<typeof createDeferredCore<void>> };
    tasks: Map<
      string,
      { controller: AbortController; done: ReturnType<typeof createDeferredCore<void>> }
    >;
  };
  const operations = new Map<string, Operation>();
  let closed = false;
  port.on("close", () => {
    closed = true;
    const failure = new Error("Transcript compute endpoint closed before joined completion");
    for (const operation of operations.values()) {
      operation.controller.abort(failure);
      for (const task of operation.tasks.values()) {
        task.controller.abort(failure);
        task.done.reject(failure);
      }
      operation.closing?.done.reject(failure);
    }
  });
  port.on("message", (message: Reply) => {
    if (message.id !== identity.id || message.generation !== identity.generation) {
      return;
    }
    const operation = operations.get(message.operation);
    if (!operation) {
      return;
    }
    if (message.kind === "cancel") {
      operation.controller.abort(new Error("Transcript compute operation was revoked"));
      for (const task of operation.tasks.values()) {
        task.controller.abort();
      }
    } else if (message.kind === "task") {
      const task = operation.tasks.get(message.task);
      if (Object.hasOwn(message, "error")) {
        task?.done.reject(new Error(message.error));
      } else {
        task?.done.resolve();
      }
    } else {
      if (operation.closing?.attempt !== message.attempt) {
        return;
      }
      if (Object.hasOwn(message, "error")) {
        operation.closing.done.reject(new Error(message.error));
      } else {
        operations.delete(message.operation);
        operation.closing.done.resolve();
      }
    }
  });
  return {
    begin(owner, controller) {
      if (closed) {
        throw new Error("Transcript compute endpoint is closed");
      }
      const logical = resolveOwner(owner);
      const operation = randomUUID();
      const retained: Operation = { controller, tasks: new Map() };
      operations.set(operation, retained);
      const abort = () => {
        for (const task of retained.tasks.values()) {
          task.controller.abort(controller.signal.reason);
        }
      };
      controller.signal.addEventListener("abort", abort, { once: true });
      let openingFailure: { error: unknown } | undefined;
      try {
        port.postMessage({
          ...identity,
          kind: "begin",
          operation,
          owner: logical,
        } satisfies Request);
      } catch (error) {
        openingFailure = { error };
      }
      let closing: Promise<void> | undefined;
      let closeAttempt = 0;
      let finishing = false;
      return {
        startTask(input): SessionReconcileTask {
          if (openingFailure) {
            throw openingFailure.error;
          }
          controller.signal.throwIfAborted();
          if (finishing || closed || input.mode !== "memory") {
            throw new Error("Transcript compute delegation requires its active memory owner");
          }
          const task = randomUUID();
          const control = new AbortController();
          const done = createDeferredCore();
          const { port1, port2 } = new MessageChannel();
          const taskClosed = new Promise<void>((resolve) => {
            port1.once("close", resolve);
          });
          retained.tasks.set(task, { controller: control, done });
          void done.promise.catch(() => undefined);
          control.signal.addEventListener(
            "abort",
            () => {
              if (!closed) {
                try {
                  port.postMessage({
                    ...identity,
                    kind: "cancel",
                    operation,
                    task,
                  } satisfies Request);
                } catch (error) {
                  done.reject(error);
                }
              }
            },
            { once: true },
          );
          try {
            port.postMessage(
              { ...identity, kind: "start", operation, task, input, port: port2 } satisfies Request,
              [port2],
            );
          } catch (error) {
            control.abort(error);
            port2.close();
            done.reject(error);
          }
          const leaseRelease = Promise.allSettled([done.promise, taskClosed]).then(([result]) => ({
            released: false,
            releaseFailed: false,
            ...(result.status === "rejected" ? { failure: toStringifiedError(result.reason) } : {}),
          }));
          return {
            port: port1,
            controller: control,
            completion: done.promise,
            closed: taskClosed,
            leaseRelease,
          };
        },
        close() {
          if (!closing) {
            if (closed) {
              return Promise.reject(new Error("Transcript compute endpoint did not join"));
            }
            finishing = true;
            const attempt = ++closeAttempt;
            const done = createDeferredCore();
            retained.closing = { attempt, done };
            closing = done.promise
              .then(() => controller.signal.removeEventListener("abort", abort))
              .catch((error: unknown) => {
                closing = undefined;
                throw error;
              });
            try {
              port.postMessage({
                ...identity,
                kind: "finish",
                operation,
                attempt,
              } satisfies Request);
            } catch (error) {
              done.reject(error);
            }
          }
          return closing;
        },
      };
    },
  };
}

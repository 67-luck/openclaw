import { MessageChannel, type MessagePort, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import * as reconcileDelegation from "./session-transcript-reconcile-delegation.js";
import type { useReconcileWorkerObserver } from "./session-transcript-reconcile.test-support.js";

export type DelegatedEndpoint = ReturnType<
  typeof reconcileDelegation.createSessionReconcileHostEndpoint
>;

type DelegatedStartTask = Parameters<
  typeof reconcileDelegation.createSessionReconcileHostEndpoint
>[0]["startTask"];

type DelegatedAllocation = {
  input: Parameters<DelegatedStartTask>[0];
  port: MessagePort;
  signal: AbortSignal;
  status: "pending" | "fulfilled" | "rejected";
  start?: Record<string, unknown>;
  owner?: Record<string, unknown>;
  cancel?: Record<string, unknown>;
  worker?: Worker;
  dispatches: number;
  order: string[];
  joined: ReturnType<typeof createDeferred<Record<string, unknown>>>;
  finished: ReturnType<typeof createDeferred<Record<string, unknown>>>;
  finishReplies: Record<string, unknown>[];
  portClosed: ReturnType<typeof createDeferred<void>>;
  closes: Promise<void>[];
};

type DelegatedObservation = DelegatedAllocation & {
  native: ReturnType<DelegatedStartTask>;
  result: Promise<PromiseSettledResult<void>>;
};
export function createDelegatedReconcileProbe(
  observer: ReturnType<typeof useReconcileWorkerObserver>,
) {
  return function observeDelegatedReconcile(sessions: string[], signal: AbortSignal) {
    const admitted = sessions.map(() => createDeferred<DelegatedObservation>());
    const sourceRead = sessions.map(() => createDeferred());
    const gates = new Int32Array(
      new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * sessions.length),
    );
    const ports: MessagePort[] = [];
    const allocations: DelegatedAllocation[] = [];
    const observations: DelegatedObservation[] = [];
    const restores: Array<() => void> = [];
    const enrollments: Array<{
      target: Parameters<DelegatedEndpoint["enroll"]>[0];
      assertCurrent: Parameters<DelegatedEndpoint["enroll"]>[1];
    }> = [];
    let beforeClose:
      | ((allocation: DelegatedAllocation, close: () => Promise<void>) => Promise<void>)
      | undefined;
    let hostPort: MessagePort | undefined;
    const release = (index: number) => {
      Atomics.store(gates, index, 1);
      Atomics.notify(gates, index);
    };
    const releaseGates = () => {
      for (let index = 0; index < gates.length; index++) {
        release(index);
      }
    };
    // Test abort releases native gates and unwinds each observation; the retained
    // fixture body still joins its original cleanup before observer teardown.
    const observe = <T>(pending: PromiseLike<T>) => withinTest(pending, signal);
    observer.beforeCreate = (filename, workerOptions) => {
      // Forward the real source request first; proof traffic must not enter the pool's reply port.
      const proof = new MessageChannel();
      ports.push(proof.port1, proof.port2);
      proof.port1.on("message", (value: unknown) => {
        if (isRecord(value) && value.type === "source-read") {
          const index = sessions.indexOf(String(value.sessionId));
          sourceRead[index]?.resolve();
        }
      });
      return {
        filename: `const {workerData,MessagePort}=require("node:worker_threads");
        const post=MessagePort.prototype.postMessage;
        const held=new Set();
        MessagePort.prototype.postMessage=function(message,...args){
          const result=post.call(this,message,...args);
          const index=workerData.sessions.indexOf(message?.sessionId);
          if(message?.type==="source-read" && index>=0 && !held.has(index)){
            held.add(index);
            workerData.proofPort.postMessage({type:"source-read",sessionId:message.sessionId});
            Atomics.wait(new Int32Array(workerData.gates),index,0);
          }
          return result;
        };
        void import(${JSON.stringify(String(filename))});`,
        options: {
          ...workerOptions,
          eval: true,
          workerData: {
            ...workerOptions.workerData,
            proofPort: proof.port2,
            sessions,
            gates: gates.buffer,
          },
          transferList: [...(workerOptions.transferList ?? []), proof.port2],
        },
      };
    };
    const createEndpoint = reconcileDelegation.createSessionReconcileHostEndpoint;
    const endpointSpy = vi
      .spyOn(reconcileDelegation, "createSessionReconcileHostEndpoint")
      .mockImplementation((params) => {
        const endpoint = createEndpoint({
          ...params,
          startTask(input, port, taskSignal) {
            const allocation: DelegatedAllocation = {
              input,
              port,
              signal: taskSignal,
              status: "pending",
              dispatches: 0,
              order: [],
              joined: createDeferred<Record<string, unknown>>(),
              finished: createDeferred<Record<string, unknown>>(),
              finishReplies: [],
              portClosed: createDeferred(),
              closes: [],
            };
            // An idle pool dispatches synchronously inside the original allocation.
            allocations.push(allocation);
            port.once("close", () => allocation.portClosed.resolve());
            const native = params.startTask(input, port, taskSignal);
            const close = native.close;
            const closeSpy = vi.spyOn(native, "close").mockImplementation(function (...args) {
              const forward = () => close.apply(native, args);
              const promise = beforeClose ? beforeClose(allocation, forward) : forward();
              allocation.closes.push(promise);
              return promise;
            });
            restores.push(() => closeSpy.mockRestore());
            const row: DelegatedObservation = Object.assign(allocation, {
              native,
              result: native.result.then(
                (value): PromiseFulfilledResult<void> => {
                  allocation.status = "fulfilled";
                  return { status: "fulfilled", value };
                },
                (reason: unknown): PromiseRejectedResult => {
                  allocation.status = "rejected";
                  return { status: "rejected", reason };
                },
              ),
            });
            observations.push(row);
            for (const id of input.sessionIds) {
              admitted[sessions.indexOf(id)]?.resolve(row);
            }
            return native;
          },
        });
        const enroll = endpoint.enroll;
        const enrollSpy = vi
          .spyOn(endpoint, "enroll")
          .mockImplementation((target, assertCurrent) => {
            const enrollment = enroll(target, assertCurrent);
            enrollments.push({ target, assertCurrent });
            return enrollment;
          });
        restores.push(() => enrollSpy.mockRestore());
        const parent = observer.parents.get(endpoint.port)?.port;
        hostPort = parent;
        if (parent) {
          const owners = new Map<unknown, Record<string, unknown>>();
          parent.on("message", (value: unknown) => {
            if (!isRecord(value)) {
              return;
            }
            if (value.kind === "begin" && isRecord(value.owner)) {
              owners.set(value.operation, value.owner);
            } else if (value.kind === "start") {
              const row = observations.find((entry) => entry.port === value.port);
              if (row) {
                row.start = value;
                row.owner = owners.get(value.operation);
              }
            } else if (value.kind === "cancel") {
              const row = observations.find(
                (entry) =>
                  entry.start &&
                  entry.start.operation === value.operation &&
                  entry.start.task === value.task,
              );
              if (row) {
                row.cancel = value;
              }
            }
          });
          const post = parent.postMessage.bind(parent);
          const spy = vi.spyOn(parent, "postMessage").mockImplementation(function (
            this: MessagePort,
            ...args: Parameters<MessagePort["postMessage"]>
          ) {
            const result = post.apply(this, args);
            const [value] = args;
            if (isRecord(value)) {
              for (const row of observations) {
                const start = row.start;
                if (!start || start.operation !== value.operation) {
                  continue;
                }
                if (value.kind === "task" && start.task === value.task) {
                  row.order.push("native-joined");
                  row.joined.resolve(value);
                } else if (value.kind === "finish") {
                  row.order.push("finish-reply");
                  row.finishReplies.push(value);
                  row.finished.resolve(value);
                }
              }
            }
            return result;
          });
          restores.push(() => spy.mockRestore());
        }
        return endpoint;
      });
    const workerPost = vi.spyOn(Worker.prototype, "postMessage");
    workerPost.mockRestore();
    const dispatchSpy = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      ...args: Parameters<Worker["postMessage"]>
    ) {
      const [value] = args;
      if (isRecord(value) && isRecord(value.input)) {
        const task = value.input;
        const row = allocations.find(
          (entry) => entry.port === task.port && entry.input === task.input,
        );
        if (row) {
          row.worker = this;
          row.dispatches++;
          this.once("exit", () => row.order.push("native-exit"));
        }
      }
      return workerPost.apply(this, args);
    });
    const hostOpen = vi.spyOn(agentDatabase, "openOpenClawAgentDatabase").mockImplementation(() => {
      throw new Error("Delegated memory fixture opened agent SQLite on the host");
    });
    signal.addEventListener("abort", releaseGates, { once: true });
    if (signal.aborted) {
      releaseGates();
    }
    return {
      admitted,
      sourceRead,
      observations,
      enrollments,
      endpointSpy,
      hostOpen,
      get hostPort() {
        return hostPort;
      },
      set beforeClose(observeClose: typeof beforeClose) {
        beforeClose = observeClose;
      },
      observe,
      release,
      releaseGates,
      restore() {
        for (const port of ports) {
          port.close();
        }
        for (const restore of restores) {
          restore();
        }
        hostOpen.mockRestore();
        dispatchSpy.mockRestore();
        endpointSpy.mockRestore();
        observer.beforeCreate = undefined;
        signal.removeEventListener("abort", releaseGates);
      },
    };
  };
}

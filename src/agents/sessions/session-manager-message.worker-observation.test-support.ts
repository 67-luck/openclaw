import { getEnvironmentData, setEnvironmentData, type Worker } from "node:worker_threads";
import { expect } from "vitest";
export type MessageWorkerObservation = {
  control: SharedArrayBuffer;
  path: SharedArrayBuffer;
};
export function createMessageWorkerMock(
  actual: typeof import("../../infra/worker-cpu.js"),
  observation: MessageWorkerObservation,
) {
  const observationKey = "openclaw.sessionMessageWorkerObservation";
  // Observe the real native owner. Barriers suspend the worker, never the
  // synchronous host grant; only the named COMMIT/receipt fault is injected.
  const preload = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { DatabaseSync } from "node:sqlite";
    import { MessagePort, workerData, threadId, getEnvironmentData } from "node:worker_threads";
    const observation = workerData ?? getEnvironmentData(${JSON.stringify(observationKey)});
    const state = new Int32Array(observation.messageTestControl);
    let operation;
    const target = () => Buffer.from(observation.messageTestPath, 0, Atomics.load(state, 7)).toString();
    const pause = () => {
      Atomics.store(state, 1, 1);
      Atomics.notify(state, 1);
      while (Atomics.load(state, 2) === 0) { Atomics.wait(state, 2, 0); }
    };
    const chmod = fs.chmodSync;
    fs.chmodSync = function(pathname, mode) {
      if (operation && pathname === target() && Atomics.load(state, 0) === 7 && Atomics.load(state, 1) === 1) {
        Atomics.add(state, 6, 1);
        throw Object.assign(new Error("message fixture permission refusal"), { code: "EACCES" });
      }
      return chmod.call(this, pathname, mode);
    };
    syncBuiltinESMExports();
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      if (operation && this.location() === target() && /^COMMIT;?$/i.test(sql.trim())) {
        Atomics.store(state, 3, threadId);
        const mode = Atomics.load(state, 0);
        if ((mode === 1 || mode === 4) && Atomics.compareExchange(state, 5, 0, 1) === 0) {
          pause();
          if (mode === 4) { throw new Error("message fixture native COMMIT refusal"); }
        }
        const value = exec.call(this, sql);
        Atomics.add(state, 4, 1);
        return value;
      }
      return exec.call(this, sql);
    };
    const postMessage = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function(message, ...rest) {
      if (message?.stage === "transaction" && message.facts?.domain?.operationId) {
        operation = message.facts.domain.operationId;
        if (Atomics.load(state, 0) === 6 && Atomics.compareExchange(state, 5, 0, 1) === 0) {
          pause();
        }
      }
      if (message?.stage === "commit" && message.facts?.domain?.operationId &&
          (Atomics.load(state, 0) === 2 || Atomics.load(state, 0) === 7) &&
          Atomics.compareExchange(state, 5, 0, 1) === 0) {
        pause();
      }
      if (message?.kind === "native-commit" && message.committed?.facts?.operationId) {
        operation = undefined;
        if (Atomics.load(state, 0) === 5 && Atomics.compareExchange(state, 5, 0, 1) === 0) {
          pause();
          process.exit(19);
        }
        if (Atomics.load(state, 0) === 3 && Atomics.compareExchange(state, 5, 0, 1) === 0) {
          throw new Error("message fixture receipt delivery refusal");
        }
      }
      if (message?.kind === "native-settlement") { operation = undefined; }
      return postMessage.call(this, message, ...rest);
    };
  `;
  return {
    ...actual,
    createCpuTrackedWorker(
      filename: string | URL,
      options: ConstructorParameters<typeof Worker>[1],
    ) {
      const importArgs = ["--import", `data:text/javascript,${encodeURIComponent(preload)}`];
      const data = {
        messageTestControl: observation.control,
        messageTestPath: observation.path,
      };
      if (options?.workerData?.carrierUrl) {
        // The service snapshots environment data synchronously; its later child
        // inherits that snapshot. Only the SQL child receives the native hooks.
        const previous = getEnvironmentData(observationKey);
        setEnvironmentData(observationKey, data);
        try {
          return actual.createCpuTrackedWorker(filename, {
            ...options,
            workerData: {
              ...options.workerData,
              execArgv: [...options.workerData.execArgv, ...importArgs],
            },
          });
        } finally {
          setEnvironmentData(observationKey, previous);
        }
      }
      return actual.createCpuTrackedWorker(filename, {
        ...options,
        execArgv: [...(options?.execArgv ?? []), ...importArgs],
        workerData: {
          ...options?.workerData,
          ...data,
        },
      });
    },
  };
}

function arm(observation: MessageWorkerObservation, pathname: string, mode = 0) {
  const control = new Int32Array(observation.control);
  control.fill(0);
  const encoded = Buffer.from(pathname);
  new Uint8Array(observation.path).set(encoded);
  Atomics.store(control, 7, encoded.length);
  Atomics.store(control, 0, mode);
  return control;
}

function releaseBarrier(observation: MessageWorkerObservation) {
  const control = new Int32Array(observation.control);
  Atomics.store(control, 2, 1);
  Atomics.notify(control, 2);
}

async function reachBarrier(observation: MessageWorkerObservation, operation: Promise<unknown>) {
  const control = new Int32Array(observation.control);
  const reached = Atomics.waitAsync(control, 1, 0);
  await Promise.race([
    Promise.resolve(reached.value),
    operation.then(() => {
      throw new Error("Message operation settled before the native barrier");
    }),
  ]);
  expect(Atomics.load(control, 1)).toBe(1);
}

export function bindMessageWorkerObservation(observation: MessageWorkerObservation) {
  return {
    arm: (pathname: string, mode = 0) => arm(observation, pathname, mode),
    releaseBarrier: () => releaseBarrier(observation),
    reachBarrier: (operation: Promise<unknown>) => reachBarrier(observation, operation),
  };
}

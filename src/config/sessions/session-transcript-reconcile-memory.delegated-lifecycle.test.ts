import { getEnvironmentData, setEnvironmentData, Worker } from "node:worker_threads";
import { assert, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { isSqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as scopedRuntime from "../../infra/sqlite-worker-scoped-operation.js";
import * as sqliteTransport from "../../infra/sqlite-worker-transport.js";
import * as workerCpu from "../../infra/worker-cpu.js";
import { agentDatabaseLifecycle } from "../../state/openclaw-agent-db-lifecycle.js";
import * as agentResources from "../../state/openclaw-agent-db-resources.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import {
  captureOpenClawAgentDatabaseExecution,
  retainGatewaySessionBroker,
} from "../../state/openclaw-agent-execution.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDelegatedReconcileProbe } from "./session-transcript-reconcile-memory.delegated.test-support.js";
import { useMemoryReconcileFixture } from "./session-transcript-reconcile-memory.fixture.test-support.js";
import * as reconcilePool from "./session-transcript-reconcile-pool.js";
import { useReconcileWorkerObserver } from "./session-transcript-reconcile.test-support.js";
vi.mock("node:worker_threads", async () =>
  (await import("./session-transcript-reconcile.test-support.js")).createObservedWorkerThreads(),
);

const observer = useReconcileWorkerObserver();
const observeDelegatedReconcile = createDelegatedReconcileProbe(observer);

describe("incognito transcript reconciliation", () => {
  let ambient: OpenClawTestState;
  const { seedDelegatedManager } = useMemoryReconcileFixture((ambientState) => {
    ambient = ambientState;
  });

  it.skipIf(Boolean(process.versions.bun))(
    "drains later logical owners after the original DATA close exits",
    async ({ signal }) => {
      const probe = observeDelegatedReconcile(["drain-logical-a"], signal);
      const { observe } = probe;
      const failures: unknown[] = [];
      const executions: ReturnType<typeof captureOpenClawAgentDatabaseExecution>[] = [];
      const key = "openclaw.test.logicalCloseExit";
      const previous = getEnvironmentData(key);
      const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
      const fault = new Int32Array(control);
      const aPath = resolveIncognitoOpenClawAgentSqlitePath({
        agentId: "drain-logical-a",
        env: ambient.env,
      });
      const bPath = resolveIncognitoOpenClawAgentSqlitePath({
        agentId: "drain-logical-b",
        env: ambient.env,
      });
      setEnvironmentData(key, { control, path: aPath, agentId: "drain-logical-a" });
      const preload = `
        import { deserialize } from "node:v8";
        import { getEnvironmentData, parentPort } from "node:worker_threads";
        const target = getEnvironmentData(${JSON.stringify(key)});
        const control = new Int32Array(target.control);
        const on = parentPort.on;
        parentPort.on = function(event, listener) {
          if (event !== "message") return on.call(this, event, listener);
          return on.call(this, event, function(...args) {
            const request = args[0];
            if (request?.type === "execute" && Atomics.load(control, 0) === 1) {
              const command = deserialize(request.input);
              if (command.type === "database.volatile.close" &&
                  command.input.path === target.path &&
                  command.input.agentId === target.agentId &&
                  Atomics.compareExchange(control, 0, 1, 0) === 1) {
                Atomics.add(control, 1, 1);
                process.exit(19);
              }
            }
            return listener.apply(this, args);
          });
        };
      `;
      const nativeWorkers: Array<{
        worker: Worker;
        exited: ReturnType<typeof createDeferred<number>>;
      }> = [];
      const createWorker = workerCpu.createCpuTrackedWorker;
      const workerSpy = vi
        .spyOn(workerCpu, "createCpuTrackedWorker")
        .mockImplementation((filename, options) => {
          const worker = createWorker(
            filename,
            options?.workerData?.carrierUrl
              ? {
                  ...options,
                  // Only the original DATA child receives the one-shot logical-close fault.
                  workerData: {
                    ...options.workerData,
                    execArgv: [
                      ...options.workerData.execArgv,
                      "--import",
                      `data:text/javascript,${encodeURIComponent(preload)}`,
                    ],
                  },
                }
              : options,
          );
          if (options?.workerData?.carrierUrl) {
            const exited = createDeferred<number>();
            worker.once("exit", (code) => exited.resolve(code));
            nativeWorkers.push({ worker, exited });
          }
          return worker;
        });
      const transports: Array<{
        transport: ReturnType<typeof sqliteTransport.createSqliteWorkerTransport>;
        exits: number[];
      }> = [];
      const createTransport = sqliteTransport.createSqliteWorkerTransport;
      const transportSpy = vi
        .spyOn(sqliteTransport, "createSqliteWorkerTransport")
        .mockImplementation((options) => {
          const exits: number[] = [];
          const transport = createTransport({
            ...options,
            childExit(code, error) {
              try {
                options.childExit(code, error);
              } finally {
                exits.push(code);
              }
            },
          });
          transports.push({ transport, exits });
          return transport;
        });
      const registrations: Array<{
        resource: agentResources.OpenClawAgentDatabaseAsyncResource;
        unregisters: number;
      }> = [];
      let capturingOwner: string | undefined;
      const register = agentResources.registerOpenClawAgentDatabaseAsyncResource;
      const registrationSpy = vi
        .spyOn(agentResources, "registerOpenClawAgentDatabaseAsyncResource")
        .mockImplementation((resource, ...args) => {
          const unregister = register(resource, ...args);
          if (resource.path !== capturingOwner) {
            return unregister;
          }
          const retained = { resource, unregisters: 0 };
          registrations.push(retained);
          return () => {
            unregister();
            retained.unregisters++;
          };
        });
      const closeCommands: Array<{
        id: string;
        path: string;
        outcome: Promise<PromiseSettledResult<unknown>>;
      }> = [];
      const projectionCloses: Promise<void>[] = [];
      let broker: ReturnType<typeof retainGatewaySessionBroker> | undefined;
      let firstStop: Promise<PromiseSettledResult<void>> | undefined;
      let restoreExecute: (() => void) | undefined;
      let restoreProjection: (() => void) | undefined;
      const abort = () => {
        Atomics.store(fault, 0, 0);
        probe.releaseGates();
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
      try {
        assert(probe.admitted[0] && probe.sourceRead[0]);
        await observe(reconcilePool.closeSessionTranscriptReconcileWorkerPool());
        broker = retainGatewaySessionBroker();
        await observe(broker.ready);
        const owner = agentDatabaseLifecycle.gatewayExecution;
        assert(owner?.store);
        const store = owner.store;
        const execute = store.execute.bind(store);
        const executeSpy = vi.spyOn(store, "execute").mockImplementation((command, options) => {
          const pending = execute(command, options);
          if (command.type === "database.volatile.close" && "path" in command.input) {
            closeCommands.push({
              id: command.input.id,
              path: command.input.path,
              outcome: pending.then(
                (value): PromiseFulfilledResult<unknown> => ({ status: "fulfilled", value }),
                (reason: unknown): PromiseRejectedResult => ({ status: "rejected", reason }),
              ),
            });
          }
          return pending;
        });
        restoreExecute = () => executeSpy.mockRestore();
        const closeProjection = owner.projection.close.bind(owner.projection);
        const projectionSpy = vi.spyOn(owner.projection, "close").mockImplementation(() => {
          const pending = closeProjection();
          projectionCloses.push(pending);
          return pending;
        });
        restoreProjection = () => projectionSpy.mockRestore();
        for (const [agentId, pathname] of [
          ["drain-logical-a", aPath],
          ["drain-logical-b", bPath],
        ] as const) {
          capturingOwner = pathname;
          try {
            executions.push(
              captureOpenClawAgentDatabaseExecution({
                agentId,
                path: pathname,
                env: ambient.env,
              }),
            );
          } finally {
            capturingOwner = undefined;
          }
        }
        const a = seedDelegatedManager("drain-logical-a");
        seedDelegatedManager("drain-logical-b");
        expect(aPath).not.toBe(bPath);
        expect(registrations.map(({ resource }) => resource.path)).toEqual([aPath, bPath]);
        const aRegistration = registrations[0];
        const bRegistration = registrations[1];
        assert(aRegistration && bRegistration);
        const aEnrollment = probe.enrollments.find(
          (entry) => "path" in entry.target && entry.target.path === aPath,
        );
        const bEnrollment = probe.enrollments.find(
          (entry) => "path" in entry.target && entry.target.path === bPath,
        );
        assert(aEnrollment && bEnrollment);
        expect(aEnrollment.target.id).not.toBe(bEnrollment.target.id);
        for (const execution of executions) {
          execution.assertCurrent();
        }
        a.dirty();
        const row = await observe(probe.admitted[0].promise);
        await observe(probe.sourceRead[0].promise);
        const compute = row.worker;
        assert(compute);
        expect(nativeWorkers).toHaveLength(1);
        const service = nativeWorkers[0];
        assert(service);
        const transport = transports.find((entry) => entry.transport.worker === service.worker);
        assert(transport);
        Atomics.store(fault, 0, 1);
        firstStop = broker.stop().then(
          (value): PromiseFulfilledResult<void> => ({ status: "fulfilled", value }),
          (reason: unknown): PromiseRejectedResult => ({ status: "rejected", reason }),
        );
        const stopped = await observe(firstStop);
        assert(stopped.status === "rejected");
        // These witnesses precede the regression oracle, so setup/refusal is not a valid red.
        expect(Atomics.load(fault, 1)).toBe(1);
        expect(transport.exits).toEqual([19]);
        expect(closeCommands).toHaveLength(1);
        const originalClose = closeCommands[0];
        assert(originalClose);
        expect(originalClose).toMatchObject({ id: aEnrollment.target.id, path: aPath });
        const closeOutcome = await observe(originalClose.outcome);
        assert(closeOutcome.status === "rejected");
        expect(isSqliteWorkerError(closeOutcome.reason, "outcome-unknown")).toBe(true);
        expect(stopped.reason).toBe(closeOutcome.reason);
        expect(Number.isInteger(await observe(service.exited.promise))).toBe(true);
        expect(service.worker.threadId).toBe(-1);
        expect(owner.dataClosed).toBe(true);
        expect(projectionCloses).toHaveLength(1);
        await observe(Promise.all(projectionCloses));
        expect(compute.threadId).toBe(-1);
        expect(row.order).toContain("native-exit");
        expect(row.dispatches).toBe(1);
        expect((await observe(row.result)).status).toBe("rejected");
        expect(aRegistration.unregisters).toBe(0);
        expect(bRegistration.unregisters).toBe(1);
        expect(closeCommands.filter((command) => command.path === bPath)).toEqual([]);
        expect(agentDatabaseLifecycle.gatewayExecution).toBe(owner);
        await observe(broker.stop());
        expect(aRegistration.unregisters).toBe(1);
        expect(bRegistration.unregisters).toBe(1);
        expect(closeCommands).toHaveLength(1);
        expect(nativeWorkers).toHaveLength(1);
        expect(row.dispatches).toBe(1);
        expect(agentDatabaseLifecycle.gatewayExecution).toBeUndefined();
      } catch (error) {
        failures.push(error);
      } finally {
        abort();
        const cleanups: Array<() => void | Promise<void>> = [
          async () => {
            await firstStop;
            const results = await Promise.allSettled(
              executions.map(async (execution) => execution.release()),
            );
            for (const result of results) {
              if (result.status === "rejected") {
                failures.push(result.reason);
              }
            }
          },
          () => broker?.stop(),
          () => reconcilePool.closeSessionTranscriptReconcileWorkerPool(),
          async () => {
            const results = await Promise.allSettled(projectionCloses);
            for (const result of results) {
              if (result.status === "rejected") {
                failures.push(result.reason);
              }
            }
            await Promise.all(nativeWorkers.map((entry) => entry.exited.promise));
            await Promise.all(probe.observations.map((row) => row.result));
            expect([...observer.workers].every((worker) => worker.threadId === -1)).toBe(true);
          },
          () => restoreProjection?.(),
          () => restoreExecute?.(),
          () => {
            registrationSpy.mockRestore();
          },
          () => {
            transportSpy.mockRestore();
          },
          () => {
            workerSpy.mockRestore();
          },
          () => setEnvironmentData(key, previous),
          () => signal.removeEventListener("abort", abort),
          () => probe.restore(),
        ];
        for (const cleanup of cleanups) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length) {
        throw new AggregateError(failures, "Logical owner drainage cleanup failed", {
          cause: failures[0],
        });
      }
    },
  );

  it.skipIf(Boolean(process.versions.bun))(
    "joins delegated host compute after the original DATA child exits",
    async ({ signal }) => {
      const probe = observeDelegatedReconcile(["delegated-data-exit"], signal);
      const { observe } = probe;
      const key = "openclaw.test.delegatedDataExit";
      const previous = getEnvironmentData(key);
      const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
      const fault = new Int32Array(control);
      setEnvironmentData(key, control);
      const preload = `
        import { getEnvironmentData, MessagePort } from "node:worker_threads";
        const control = new Int32Array(getEnvironmentData(${JSON.stringify(key)}));
        const post = MessagePort.prototype.postMessage;
        MessagePort.prototype.postMessage = function(message, ...args) {
          if (message?.kind === "native-commit" &&
              Atomics.compareExchange(control, 0, 1, 0) === 1) {
            Atomics.add(control, 1, 1);
            process.exit(19);
          }
          return post.call(this, message, ...args);
        };
      `;
      const createWorker = workerCpu.createCpuTrackedWorker;
      const workerSpy = vi
        .spyOn(workerCpu, "createCpuTrackedWorker")
        .mockImplementation((filename, options) =>
          createWorker(
            filename,
            options?.workerData?.carrierUrl
              ? {
                  ...options,
                  // This belongs to the real DATA child, never its native parent service.
                  workerData: {
                    ...options.workerData,
                    execArgv: [
                      ...options.workerData.execArgv,
                      "--import",
                      `data:text/javascript,${encodeURIComponent(preload)}`,
                    ],
                  },
                }
              : options,
          ),
        );
      const transports: Array<{
        transport: ReturnType<typeof sqliteTransport.createSqliteWorkerTransport>;
        exits: number[];
      }> = [];
      const childExited = createDeferred();
      const createTransport = sqliteTransport.createSqliteWorkerTransport;
      const transportSpy = vi
        .spyOn(sqliteTransport, "createSqliteWorkerTransport")
        .mockImplementation((options) => {
          const exits: number[] = [];
          const transport = createTransport({
            ...options,
            childExit(code, error) {
              exits.push(code);
              try {
                options.childExit(code, error);
              } finally {
                if (code === 19) {
                  childExited.resolve();
                }
              }
            },
          });
          transports.push({ transport, exits });
          return transport;
        });
      type HostScope = ReturnType<typeof scopedRuntime.createSqliteWorkerHostScope>;
      let actor: Parameters<HostScope["bind"]>[0] | undefined;
      const createScope = scopedRuntime.createSqliteWorkerHostScope;
      const scopeSpy = vi
        .spyOn(scopedRuntime, "createSqliteWorkerHostScope")
        .mockImplementation((run, ...args) => {
          let bound: typeof actor;
          const scope = createScope(
            (step, cursor) => {
              if (step.kind === "fresh-input") {
                actor = bound;
              }
              return run(step, cursor);
            },
            ...args,
          );
          const bind = scope.bind;
          scope.bind = (owner, ...rest) => {
            bind(owner, ...rest);
            bound = owner;
          };
          return scope;
        });
      const termination = createDeferred();
      const terminationEntered = createDeferred();
      const computeExited = createDeferred();
      let broker: ReturnType<typeof retainGatewaySessionBroker> | undefined;
      let stopped: Promise<PromiseSettledResult<void>> | undefined;
      let restoreTerminate: (() => void) | undefined;
      let nativeCalls = 0;
      const abort = () => termination.resolve();
      signal.addEventListener("abort", abort, { once: true });
      try {
        assert(probe.admitted[0] && probe.sourceRead[0]);
        await observe(reconcilePool.closeSessionTranscriptReconcileWorkerPool());
        broker = retainGatewaySessionBroker();
        await observe(broker.ready);
        const owner = agentDatabaseLifecycle.gatewayExecution;
        assert(owner);
        const seeded = seedDelegatedManager("delegated-data-exit");
        seeded.dirty();
        const row = await observe(probe.admitted[0].promise);
        await observe(probe.sourceRead[0].promise);
        const compute = row.worker;
        assert(compute);
        compute.once("exit", () => computeExited.resolve());
        const terminate = compute.terminate.bind(compute);
        const terminateSpy = vi.spyOn(compute, "terminate").mockImplementation(() => {
          terminationEntered.resolve();
          return termination.promise.then(() => {
            nativeCalls++;
            return terminate();
          });
        });
        restoreTerminate = () => terminateSpy.mockRestore();
        const fresh = vi.fn(() => {
          assert(actor?.volatile);
          expect(actor.slot.transport).toBeDefined();
          Atomics.store(fault, 0, 1);
        });
        let failure: unknown;
        try {
          seeded.manager.appendMessage(
            { role: "user", content: "lose the DATA receipt", timestamp: 3 },
            { beforeFreshMessageCommit: fresh },
          );
        } catch (error) {
          failure = error;
        }
        expect(fresh).toHaveBeenCalledOnce();
        expect(isSqliteWorkerError(failure, "outcome-unknown")).toBe(true);
        expect(Atomics.load(fault, 1)).toBe(1);
        assert(actor);
        const originalActor = actor;
        const originalTransport = transports.find(
          (entry) => entry.transport === originalActor.slot.transport,
        );
        assert(originalTransport);
        await observe(childExited.promise);
        expect(originalTransport.exits).toEqual([19]);
        expect(originalTransport.transport.worker).toBe(actor.slot.worker);
        expect(row.dispatches).toBe(1);
        let stopSettled = false;
        stopped = broker
          .stop()
          .then(
            (value): PromiseFulfilledResult<void> => ({ status: "fulfilled", value }),
            (reason: unknown): PromiseRejectedResult => ({ status: "rejected", reason }),
          )
          .finally(() => {
            stopSettled = true;
          });
        await observe(terminationEntered.promise);
        expect(row.signal.aborted).toBe(true);
        expect(compute.threadId).toBeGreaterThan(0);
        expect(nativeCalls).toBe(0);
        expect(stopSettled).toBe(false);
        expect(row.order).not.toContain("native-exit");
        expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
          workers: 1,
          activeTasks: 1,
          pendingTasks: 1,
        });
        probe.releaseGates();
        termination.resolve();
        await observe(computeExited.promise);
        const stopResult = await observe(stopped);
        expect(stopResult).toEqual({ status: "fulfilled", value: undefined });
        expect(owner.dataClosed).toBe(true);
        expect(compute.threadId).toBe(-1);
        expect(nativeCalls).toBe(1);
        expect((await observe(row.result)).status).toBe("rejected");
        expect(row.dispatches).toBe(1);
        expect(probe.observations).toHaveLength(1);
        expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
          workers: 0,
          activeTasks: 0,
          pendingTasks: 0,
        });
      } finally {
        Atomics.store(fault, 0, 0);
        probe.releaseGates();
        termination.resolve();
        try {
          await (stopped ?? broker?.stop());
        } finally {
          try {
            await reconcilePool.closeSessionTranscriptReconcileWorkerPool();
            await Promise.all(probe.observations.map((row) => row.result));
            expect([...observer.workers].every((worker) => worker.threadId === -1)).toBe(true);
          } finally {
            restoreTerminate?.();
            scopeSpy.mockRestore();
            transportSpy.mockRestore();
            workerSpy.mockRestore();
            setEnvironmentData(key, previous);
            signal.removeEventListener("abort", abort);
            probe.restore();
          }
        }
      }
    },
  );

  it.skipIf(Boolean(process.versions.bun))(
    "retains the original delegated borrow through ready deferral and the final DATA sweep",
    async ({ signal }) => {
      const id = "delegated-final-sweep";
      const probe = observeDelegatedReconcile([id], signal);
      const key = "openclaw.test.delegatedFinalSweep";
      const previous = getEnvironmentData(key);
      const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 8));
      const path = resolveIncognitoOpenClawAgentSqlitePath({ agentId: id, env: ambient.env });
      setEnvironmentData(key, { control: control.buffer, agentId: id, path });
      const preload = `
        import { channel } from "node:diagnostics_channel";
        import { getEnvironmentData, MessagePort } from "node:worker_threads";
        // Register before importing source diagnostics in the compiled DATA carrier.
        const { register } = await import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))});
        register();
        const { agentDatabaseLifecycle: lifecycle } = await import(${JSON.stringify(new URL("../../state/openclaw-agent-db-lifecycle.ts", import.meta.url).href)});
        const { runExclusiveSqliteSessionWrite } = await import(${JSON.stringify(new URL("./session-accessor.sqlite-scope.ts", import.meta.url).href)});
        const { getSqliteWorkerStateContext } = await import(${JSON.stringify(new URL("../../infra/sqlite-worker-state-context.ts", import.meta.url).href)});
        const config = getEnvironmentData(${JSON.stringify(key)});
        const control = new Int32Array(config.control);
        const on = MessagePort.prototype.on;
        const post = MessagePort.prototype.postMessage;
        const sources = new WeakSet();
        let retained;
        let entered = false;
        channel("openclaw.session.write").subscribe(message => {
          if (message?.operation !== "sessions.transcript-index.orphan-sweep" ||
              message.outcome !== "ok" || !entered || !retained) return;
          const database = [...lifecycle.databases.values()].find(value => value.path === config.path);
          const borrowers = database && lifecycle.borrowers.get(database.db);
          Atomics.add(control, 6, 1);
          Atomics.store(control, 7,
            borrowers === retained.borrowers && borrowers?.has(retained.token) &&
            Atomics.load(control, 4) === 0 ? 1 : -1);
        });
        MessagePort.prototype.on = function(event, listener) {
          if (event !== "message") return on.call(this, event, listener);
          return on.call(this, event, function(...args) {
            const [message] = args;
            if (message?.type === "source-read" && message.sessionId === config.agentId)
              sources.add(this);
            if (message?.type === "done" && sources.has(this) && !entered) {
              entered = true;
              // Enter the actual DATA FIFO before forwarding its original done handler.
              void runExclusiveSqliteSessionWrite({
                agentId: config.agentId, path: config.path,
                env: getSqliteWorkerStateContext().environment,
              }, async () => {
                const database = [...lifecycle.databases.values()].find(value => value.path === config.path);
                const borrowers = database && lifecycle.borrowers.get(database.db);
                const token = retained?.token;
                Atomics.store(control, 2,
                  borrowers === retained?.borrowers && borrowers?.size === 1 && borrowers.has(token) ? 1 : -1);
                Atomics.store(control, 1, 1);
                Atomics.notify(control, 1);
                await Atomics.waitAsync(control, 0, 0).value;
                Atomics.store(control, 3, borrowers?.has(token) ? 1 : -1);
              }, "sessions.transcript-index.preflight").catch(() => {
                Atomics.store(control, 2, -2);
                Atomics.store(control, 1, 1);
                Atomics.notify(control, 1);
              });
            }
            return listener.apply(this, args);
          });
        };
        MessagePort.prototype.postMessage = function(message, ...args) {
          if (message?.kind === "start" && message.input?.sessionIds?.includes(config.agentId)) {
            const database = [...lifecycle.databases.values()].find(value => value.path === config.path);
            const borrowers = database && lifecycle.borrowers.get(database.db);
            retained = { borrowers, token: borrowers && [...borrowers][0] };
          }
          if (message?.kind === "finish" && retained) {
            Atomics.store(control, 4, 1);
            Atomics.store(control, 5, retained.borrowers?.has(retained.token) === false ? 1 : -1);
          }
          return post.call(this, message, ...args);
        };
      `;
      const createWorker = workerCpu.createCpuTrackedWorker;
      const workerSpy = vi
        .spyOn(workerCpu, "createCpuTrackedWorker")
        .mockImplementation((filename, options) =>
          createWorker(
            filename,
            options?.workerData?.carrierUrl
              ? {
                  ...options,
                  workerData: {
                    ...options.workerData,
                    execArgv: [
                      ...options.workerData.execArgv,
                      "--import",
                      `data:text/javascript,${encodeURIComponent(preload)}`,
                    ],
                  },
                }
              : options,
          ),
        );
      const releaseSweep = () => {
        Atomics.store(control, 0, 1);
        Atomics.notify(control, 0);
      };
      signal.addEventListener("abort", releaseSweep, { once: true });
      let broker: ReturnType<typeof retainGatewaySessionBroker> | undefined;
      try {
        assert(probe.admitted[0] && probe.sourceRead[0]);
        await probe.observe(reconcilePool.closeSessionTranscriptReconcileWorkerPool());
        broker = retainGatewaySessionBroker();
        await probe.observe(broker.ready);
        const seeded = seedDelegatedManager(id);
        seeded.dirty();
        // The ready transport returned the real write before ordinary endpoint delivery.
        expect(probe.observations).toHaveLength(0);
        const row = await probe.observe(probe.admitted[0].promise);
        await probe.observe(probe.sourceRead[0].promise);
        probe.release(0);
        await probe.observe(Promise.resolve(Atomics.waitAsync(control, 1, 0).value));
        expect(Atomics.load(control, 1)).toBe(1);
        expect(Atomics.load(control, 2)).toBe(1);
        await expect(probe.observe(row.result)).resolves.toEqual({
          status: "fulfilled",
          value: undefined,
        });
        await probe.observe(row.joined.promise);
        expect(row.finishReplies).toEqual([]);
        expect(Atomics.load(control, 4)).toBe(0);
        expect(Atomics.load(control, 6)).toBe(0);
        expect(row.worker?.threadId).toBeGreaterThan(0);
        releaseSweep();
        await expect(probe.observe(row.finished.promise)).resolves.not.toHaveProperty("error");
        expect(Atomics.load(control, 3)).toBe(1);
        expect(Atomics.load(control, 4)).toBe(1);
        expect(Atomics.load(control, 5)).toBe(1);
        expect(Atomics.load(control, 6)).toBe(1);
        expect(Atomics.load(control, 7)).toBe(1);
        expect(row.dispatches).toBe(1);
        expect(probe.observations).toHaveLength(1);
        expect(
          SessionManager.readSessionContext(seeded.target, (messages) => [...messages]),
        ).toMatchObject([{ role: "user", content: "root" }]);
        expect(probe.hostOpen).not.toHaveBeenCalled();
      } finally {
        probe.releaseGates();
        releaseSweep();
        try {
          await broker?.stop();
        } finally {
          try {
            await reconcilePool.closeSessionTranscriptReconcileWorkerPool();
            await Promise.all(probe.observations.map((row) => row.result));
            expect([...observer.workers].every((worker) => worker.threadId === -1)).toBe(true);
          } finally {
            signal.removeEventListener("abort", releaseSweep);
            workerSpy.mockRestore();
            setEnvironmentData(key, previous);
            probe.restore();
          }
        }
      }
    },
  );

  it.skipIf(Boolean(process.versions.bun))(
    "retains delegated compute until owned close and counts cold and warm idle exits exactly",
    async ({ signal }) => {
      const sessions = ["delegated-idle-cold", "delegated-idle-warm", "delegated-idle-reuse"];
      const probe = observeDelegatedReconcile(sessions, signal);
      const closeEntered = createDeferred();
      const releaseClose = createDeferred();
      const terminationEntered = createDeferred();
      const releaseTermination = createDeferred();
      const coldExit = createDeferred();
      const warmExit = createDeferred();
      const release = () => {
        releaseClose.resolve();
        releaseTermination.resolve();
      };
      signal.addEventListener("abort", release, { once: true });
      let broker: ReturnType<typeof retainGatewaySessionBroker> | undefined;
      let restoreTerminate: (() => void) | undefined;
      let nativeCalls = 0;
      const counts = () => {
        const row = workerCpu
          .getTrackedWorkerLifecycleSnapshot()
          .workerLifecycle.find(
            (entry) => entry.script === "session-transcript-reconcile.worker.js",
          );
        return {
          idle: row?.retired.find((entry) => entry.reason === "idle_timeout")?.count ?? 0,
          live:
            (row?.started ?? 0) -
            (row?.retired.reduce((total, entry) => total + entry.count, 0) ?? 0),
        };
      };
      probe.beforeClose = async (allocation, close) => {
        if (allocation.input.sessionIds.includes("delegated-idle-cold")) {
          closeEntered.resolve();
          await releaseClose.promise;
        }
        await close();
      };
      try {
        await probe.observe(reconcilePool.closeSessionTranscriptReconcileWorkerPool());
        broker = retainGatewaySessionBroker();
        await probe.observe(broker.ready);
        const seeds = sessions.map(seedDelegatedManager);
        const baseline = counts();
        // This is the clock captured by the real pool constructor, not a sampled
        // idle estimate. DATA and the probe's hard deadline retain their real clocks.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
        assert(seeds[0] && probe.admitted[0] && probe.sourceRead[0]);
        seeds[0].dirty();
        const cold = await probe.observe(probe.admitted[0].promise);
        await probe.observe(probe.sourceRead[0].promise);
        const worker = cold.worker;
        assert(worker);
        worker.once("exit", () => coldExit.resolve());
        const terminate = worker.terminate.bind(worker);
        const terminateSpy = vi.spyOn(worker, "terminate").mockImplementation(() => {
          terminationEntered.resolve();
          return releaseTermination.promise.then(() => {
            nativeCalls++;
            return terminate();
          });
        });
        restoreTerminate = () => terminateSpy.mockRestore();
        probe.release(0);
        await expect(probe.observe(cold.result)).resolves.toEqual({
          status: "fulfilled",
          value: undefined,
        });
        await probe.observe(closeEntered.promise);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(cold.finishReplies).toEqual([]);
        expect(nativeCalls).toBe(0);
        expect(worker.threadId).toBeGreaterThan(0);
        expect(counts()).toEqual({ idle: baseline.idle, live: baseline.live + 1 });
        expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
          workers: 1,
          activeTasks: 1,
          pendingTasks: 1,
        });
        releaseClose.resolve();
        await probe.observe(cold.finished.promise);
        expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
          workers: 1,
          activeTasks: 0,
          pendingTasks: 0,
        });
        await vi.advanceTimersByTimeAsync(59_999);
        expect(nativeCalls).toBe(0);
        expect(counts().idle).toBe(baseline.idle);
        await vi.advanceTimersByTimeAsync(1);
        await probe.observe(terminationEntered.promise);
        expect(worker.threadId).toBeGreaterThan(0);
        expect(counts()).toEqual({ idle: baseline.idle, live: baseline.live + 1 });
        expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot().workers).toBe(1);
        releaseTermination.resolve();
        await probe.observe(coldExit.promise);
        expect(worker.threadId).toBe(-1);
        expect(nativeCalls).toBe(1);
        expect(counts()).toEqual({ idle: baseline.idle + 1, live: baseline.live });
        restoreTerminate();
        restoreTerminate = undefined;
        let warm: Worker | undefined;
        for (const index of [1, 2]) {
          const seed = seeds[index];
          const admitted = probe.admitted[index];
          const source = probe.sourceRead[index];
          assert(seed && admitted && source);
          seed.dirty();
          const row = await probe.observe(admitted.promise);
          await probe.observe(source.promise);
          if (warm) {
            expect(row.worker).toBe(warm);
          } else {
            warm = row.worker;
            assert(warm);
            warm.once("exit", () => warmExit.resolve());
          }
          probe.release(index);
          await expect(probe.observe(row.result)).resolves.toEqual({
            status: "fulfilled",
            value: undefined,
          });
          await probe.observe(row.finished.promise);
          expect(row.dispatches).toBe(1);
          if (index === 1) {
            await vi.advanceTimersByTimeAsync(70_000);
            expect(warm.threadId).toBeGreaterThan(0);
            expect(counts().idle).toBe(baseline.idle + 1);
          }
        }
        assert(warm);
        expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot().workersCreated).toBe(
          2,
        );
        await vi.advanceTimersByTimeAsync(299_999);
        expect(warm.threadId).toBeGreaterThan(0);
        expect(counts().idle).toBe(baseline.idle + 1);
        await vi.advanceTimersByTimeAsync(1);
        await probe.observe(warmExit.promise);
        expect(warm.threadId).toBe(-1);
        expect(counts()).toEqual({ idle: baseline.idle + 2, live: baseline.live });
        expect(probe.observations).toHaveLength(3);
        expect(
          SessionManager.readSessionContext(seeds[0].target, (messages) => [...messages]),
        ).toMatchObject([{ role: "user", content: "root" }]);
        expect(probe.hostOpen).not.toHaveBeenCalled();
      } finally {
        probe.releaseGates();
        release();
        vi.useRealTimers();
        try {
          await broker?.stop();
        } finally {
          try {
            await reconcilePool.closeSessionTranscriptReconcileWorkerPool();
            await Promise.all(probe.observations.map((row) => row.result));
            expect([...observer.workers].every((worker) => worker.threadId === -1)).toBe(true);
          } finally {
            restoreTerminate?.();
            signal.removeEventListener("abort", release);
            probe.restore();
          }
        }
      }
    },
  );
});

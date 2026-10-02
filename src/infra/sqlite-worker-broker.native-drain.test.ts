import { deserialize } from "node:v8";
import { MessagePort, type Worker } from "node:worker_threads";
import { assert, expect, it, vi, type MockInstance } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import type { SqliteWorkerRequest, SqliteWorkerStore } from "./sqlite-worker-contract.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";
import * as sqliteTransport from "./sqlite-worker-transport.js";
import * as workerCpu from "./worker-cpu.js";

const nodeIt = process.versions.bun ? it.skip : it;

nodeIt.for(["Error", "undefined"] as const)(
  "retains the first native exit-drain failure %s after later queued delivery",
  async (kind, { signal }) => {
    const first = kind === "Error" ? new Error("Original native drain reply failure") : undefined;
    const later = new Error("Later native child exit failure");
    const broker = new SqliteWorkerBroker();
    const initial = workerCpu.getTrackedWorkerCpuSources();
    const order: string[] = [];
    const ports: Array<{
      port: MessagePort;
      listener: Parameters<MessagePort["on"]>[1];
      closed: Promise<void>;
    }> = [];
    const serviceExit = createDeferred<number>();
    const drained = createDeferred();
    const cleanupFailures: unknown[] = [];
    const workerErrors: unknown[] = [];
    const childExits: number[] = [];
    const drainOutcomes: Array<{ error: unknown } | { completed: true }> = [];
    let service: Worker | undefined;
    let peer: MessagePort | undefined;
    let peerClosed: Promise<void> | undefined;
    let originalTransport:
      | ReturnType<typeof sqliteTransport.createSqliteWorkerTransport>
      | undefined;
    let constructingTransport = false;
    let serviceConstructed = false;
    let inNativeExit = false;
    let drainCompleted = false;
    let replyFaults = 0;
    let childFaults = 0;
    let selected: Extract<SqliteWorkerRequest, { type: "execute" }> | undefined;
    let decoded: unknown;
    let store: SqliteWorkerStore<FixtureOperations> | undefined;
    type CommandOutcome =
      | { status: "fulfilled"; value: FixtureOperations["commitThenReplyAndExit"]["output"] }
      | { status: "rejected"; error: unknown };
    let commandOutcome: Promise<CommandOutcome> | undefined;
    let paused: (typeof ports)[number] | undefined;
    let pumpsDuringPause: number | undefined;
    let restoreNativeExit: (() => void) | undefined;
    let pumpSpy:
      | MockInstance<ReturnType<typeof sqliteTransport.createSqliteWorkerTransport>["pump"]>
      | undefined;
    const on = vi.spyOn(MessagePort.prototype, "on");
    on.mockRestore();
    const portSpy = vi.spyOn(MessagePort.prototype, "on").mockImplementation(function (
      this: MessagePort,
      ...args: Parameters<MessagePort["on"]>
    ) {
      if (constructingTransport && serviceConstructed && args[0] === "message") {
        ports.push({
          port: this,
          listener: args[1],
          closed: new Promise<void>((resolve) => {
            this.once("close", resolve);
          }),
        });
      }
      return Reflect.apply(on, this, args);
    });
    const createWorker = workerCpu.createCpuTrackedWorker;
    const workerSpy = vi
      .spyOn(workerCpu, "createCpuTrackedWorker")
      .mockImplementation((...args) => {
        const port = args[1]?.workerData?.port;
        if (constructingTransport && port instanceof MessagePort) {
          peer = port;
          peerClosed = new Promise<void>((resolve) => {
            port.once("close", resolve);
          });
          service = createWorker(...args);
          service.once("exit", (code) => {
            order.push("service-exit");
            serviceExit.resolve(code);
          });
          service.on("error", (error) => workerErrors.push(error));
          serviceConstructed = true;
          return service;
        }
        return createWorker(...args);
      });
    const createTransport = sqliteTransport.createSqliteWorkerTransport;
    const transportSpy = vi
      .spyOn(sqliteTransport, "createSqliteWorkerTransport")
      .mockImplementation((options) => {
        constructingTransport = true;
        serviceConstructed = false;
        let transport: ReturnType<typeof createTransport>;
        try {
          transport = createTransport({
            ...options,
            reply(reply, pumping) {
              options.reply(reply, pumping);
              if (inNativeExit && pumping && selected?.id === reply.id && reply.ok) {
                replyFaults += 1;
                order.push("reply-fault");
                // oxlint-disable-next-line typescript/only-throw-error -- The first real drain callback failure must survive even when its exact value is undefined.
                throw first;
              }
            },
            childExit(code, error) {
              childExits.push(code);
              order.push("child-exit");
              options.childExit(code, error);
              if (inNativeExit && code === 19) {
                childFaults += 1;
                throw later;
              }
            },
          });
        } finally {
          constructingTransport = false;
        }
        originalTransport = transport;
        const post = transport.post;
        transport.post = (request, transfers) => {
          if (request.type === "execute") {
            selected = request;
            decoded = deserialize(request.input);
          }
          post(request, transfers);
        };
        pumpSpy = vi.spyOn(transport, "pump");
        const nativeExit = vi.spyOn(transport, "nativeExit");
        nativeExit.mockRestore();
        const exitSpy = vi.spyOn(transport, "nativeExit").mockImplementation(() => {
          order.push("native-drain-entry");
          inNativeExit = true;
          try {
            nativeExit.call(transport);
            drainOutcomes.push({ completed: true });
          } catch (error) {
            drainOutcomes.push({ error });
            order.push("drain-throws");
            throw error;
          } finally {
            inNativeExit = false;
            drainCompleted = true;
            order.push("native-drain-complete");
            drained.resolve();
          }
        });
        restoreNativeExit = () => {
          exitSpy.mockRestore();
        };
        return transport;
      });
    let failure: { error: unknown } | undefined;
    try {
      const opened = await broker.open<FixtureOperations>(
        {
          moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
          databasePath: ":memory:",
          input: undefined,
        },
        undefined,
        undefined,
        { volatile: { id: `native-drain-${kind}` } },
      );
      assert(opened);
      store = opened;
      assert(service && peer && peerClosed && pumpSpy);
      expect(originalTransport?.worker).toBe(service);
      expect(ports).toHaveLength(1);
      const captured = ports[0];
      assert(captured);
      expect(captured.port).not.toBe(peer);
      expect(captured.port.listenerCount("message")).toBe(1);
      // Node pauses native delivery when the exact last listener is removed; queued frames
      // remain available to the original nativeExit receiveMessageOnPort drain.
      captured.port.removeListener("message", captured.listener);
      paused = captured;
      expect(captured.port.listenerCount("message")).toBe(0);
      pumpSpy.mockClear();
      commandOutcome = store
        .execute({
          type: "commitThenReplyAndExit",
          input: { value: "original native drain commit" },
        })
        .then<CommandOutcome, CommandOutcome>(
          (value) => ({ status: "fulfilled", value }),
          (error: unknown) => ({ status: "rejected", error }),
        );
      await withinTest(drained.promise, signal);
      pumpsDuringPause = pumpSpy.mock.calls.length;
    } catch (error) {
      failure = { error };
    } finally {
      // A failed setup may need normal delivery to finish its original close. That recovery
      // cannot satisfy the positive drain observations recorded before cleanup.
      if (paused && !drainCompleted) {
        on.call(paused.port, "message", paused.listener);
      }
      const closing = Promise.allSettled([store?.close(), broker.close()]);
      const originalJoins = [
        commandOutcome,
        peerClosed,
        ...ports.map(({ closed }) => closed),
        ...(service ? [serviceExit.promise] : []),
      ];
      try {
        const joined = await Promise.allSettled([...originalJoins, closing]);
        for (const result of joined) {
          if (result.status === "rejected") {
            cleanupFailures.push(result.reason);
          }
        }
        for (const result of await closing) {
          if (result.status === "rejected") {
            cleanupFailures.push(result.reason);
          }
        }
      } finally {
        restoreNativeExit?.();
        pumpSpy?.mockRestore();
        transportSpy.mockRestore();
        workerSpy.mockRestore();
        portSpy.mockRestore();
      }
    }
    const failures = [...(failure ? [failure.error] : []), ...cleanupFailures];
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length) {
      throw new AggregateError(failures, "Native drain fixture cleanup failed");
    }
    expect(order).toEqual([
      "service-exit",
      "native-drain-entry",
      "reply-fault",
      "child-exit",
      "drain-throws",
      "native-drain-complete",
    ]);
    expect(replyFaults).toBe(1);
    expect(childFaults).toBe(1);
    expect(childExits).toEqual([19]);
    expect(drainOutcomes).toHaveLength(1);
    const drainOutcome = drainOutcomes[0];
    assert(drainOutcome && "error" in drainOutcome);
    expect(drainOutcome.error).toBe(first);
    expect(pumpsDuringPause).toBe(0);
    expect(selected).toMatchObject({
      type: "execute",
      id: expect.any(Number),
      actor: expect.any(Number),
    });
    expect(decoded).toEqual({
      type: "commitThenReplyAndExit",
      input: { value: "original native drain commit" },
    });
    // The real reply settles this job before the injected callback failure.
    // Native drainage retains that failure without rewriting its completed receipt.
    const outcome = await commandOutcome;
    assert(outcome?.status === "fulfilled");
    expect(outcome.value).toEqual({
      actor: expect.any(String),
      writes: 1,
      threadId: expect.any(Number),
    });
    expect(outcome.value.threadId).toBeGreaterThan(0);
    expect(await serviceExit.promise).toBe(0);
    expect(service?.threadId).toBe(-1);
    expect(workerErrors).toEqual([]);
    expect(workerCpu.getTrackedWorkerCpuSources().workers).toEqual(initial.workers);
  },
);

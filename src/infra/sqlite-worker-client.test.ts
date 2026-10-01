import { deserialize, serialize } from "node:v8";
import { MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { dispatchSqliteWorkerJob } from "./sqlite-worker-broker-dispatch.js";
import { settleSqliteWorkerJob } from "./sqlite-worker-broker-reply.js";
import type { Actor, Job, OperationScope, Slot } from "./sqlite-worker-broker.types.js";
import {
  createSqliteWorkerClient,
  runSqliteWorkerClientOperation,
} from "./sqlite-worker-client.js";
import {
  captureSqliteWorkerCallerTransaction,
  executeSqliteWorkerScopedCommand,
  stageSqliteWorkerCallerRollback,
} from "./sqlite-worker-host-context.js";
import {
  createSqliteWorkerAdmissionFactory,
  createSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "./sqlite-worker-operation-settlement.js";
import {
  createSqliteWorkerHostScope,
  createSqliteWorkerHostTransaction,
} from "./sqlite-worker-scoped-operation.js";
import { createSqliteWorkerScopedTransfer } from "./sqlite-worker-transfer.js";

type Operations = { write: { input: string; output: string } };
const closedError = { code: "closed", message: "SQLite worker store is closed" };

it.each(["Error", "undefined", "null"] as const)(
  "retains the first scoped transfer callback failure %s through later native port close",
  async (kind) => {
    const sentinel =
      kind === "Error"
        ? new Error("Original transfer callback failure")
        : kind === "null"
          ? null
          : undefined;
    const { port1, port2 } = new MessageChannel();
    const closed = [port1, port2].map(
      (port) =>
        new Promise<void>((resolve) => {
          port.once("close", resolve);
        }),
    );
    const failed = createDeferred();
    const peerClosed = createDeferred();
    const failures: unknown[] = [];
    const values: unknown[] = [];
    const receiver = createSqliteWorkerScopedTransfer(
      port1,
      (value) => {
        values.push(value);
        // The original callback may throw undefined or null; neither may become an absent failure.
        // oxlint-disable-next-line typescript/only-throw-error
        throw sentinel;
      },
      (error) => {
        failures.push(error);
        if (failures.length === 1) {
          failed.resolve();
        } else {
          peerClosed.resolve();
        }
      },
    );
    const peer = createSqliteWorkerScopedTransfer(port2, () => {
      throw new Error("The producer must not receive an application reply after callback failure");
    });
    const assertFirstFailure = () => {
      for (const attempt of [
        () => receiver.assertOpen(),
        () => receiver.post("must not post"),
        () => receiver.service(),
      ]) {
        let observed: { error: unknown } | undefined;
        try {
          attempt();
        } catch (error) {
          observed = { error };
        }
        expect(observed).toBeDefined();
        expect(observed?.error).toBe(sentinel);
      }
    };
    try {
      peer.post({ accepted: "original native transfer" });
      await withTestTimeout(failed.promise, 5_000, "Original transfer callback did not fail");
      expect(values).toEqual([{ accepted: "original native transfer" }]);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toBe(sentinel);
      assertFirstFailure();
      peer.close();
      await withTestTimeout(peerClosed.promise, 5_000, "Original peer close was not delivered");
      expect(failures).toHaveLength(2);
      expect(failures[1]).toBe(sentinel);
      assertFirstFailure();
      expect(values).toHaveLength(1);
    } finally {
      receiver.close();
      peer.close();
      await Promise.all(closed);
    }
  },
);

function serviceScopedFrames(complete: () => boolean, service: () => void): void {
  // These small records each need START, data, and terminal-count round trips.
  // Bound fixture progress so a missing endpoint fails instead of spinning.
  for (let turn = 0; turn < 16 && !complete(); turn++) {
    service();
  }
  expect(complete()).toBe(true);
}

function createActor(): Actor {
  return {
    nativeStopped: Promise.resolve(),
    markNativeStopped() {},
    id: 1,
    key: "client-fixture",
    databasePath: "/fixture/state.sqlite",
    pathReferences: new Map([["/fixture/state.sqlite", 1]]),
    moduleUrl: "file:///fixture/sqlite-backend.js",
    inputHash: "client-fixture",
    get slot(): never {
      throw new Error("Client scope must not access the broker's native Worker slot");
    },
    references: 1,
    opened: Promise.resolve(),
    openDispatch: { dispatched: true },
    initialized: true,
    backendClosed: false,
  };
}

it.each(["missing", "sealed"] as const)(
  "refuses a %s client before entering an operation or dispatching work",
  async (boundary) => {
    const dispatch = vi.fn(async () => "committed");
    const { client, store } = createSqliteWorkerClient<Operations>({
      actor: createActor(),
      isDraining: () => boundary === "sealed",
      isAvailable: () => true,
      dispatch,
      retireFailed: async () => {},
      release: async () => {},
    });
    const operation = vi.fn(() => store.execute({ type: "write", input: "must not enter" }));
    const track = vi.fn(() => () => {});
    const assertCurrent = vi.fn();
    const createAdmission = vi.fn(() => {
      throw new Error("Refused operation must not acquire admission");
    });

    await expect(
      runSqliteWorkerClientOperation(
        boundary === "missing" ? undefined : client,
        operation,
        undefined,
        track,
        assertCurrent,
        createSqliteWorkerAdmissionFactory(false, createAdmission),
      ),
    ).rejects.toMatchObject(closedError);
    expect(operation).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
    expect(assertCurrent).not.toHaveBeenCalled();
    expect(createAdmission).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    await store.close();
  },
);

it("lets an admitted scope finish through close before releasing its owner", async () => {
  const resume = createDeferred();
  const dispatched = createDeferred();
  const committed = createDeferred<string>();
  const events: string[] = [];
  let draining = false;
  const release = vi.fn(async () => {
    events.push("released");
  });
  const { client, store } = createSqliteWorkerClient<Operations>({
    actor: createActor(),
    isDraining: () => draining,
    isAvailable: () => true,
    dispatch: () => {
      events.push("dispatched");
      dispatched.resolve();
      return committed.promise;
    },
    retireFailed: async () => {},
    release,
  });
  const accepted = runSqliteWorkerClientOperation<Operations, string>(
    client,
    async (scope) => {
      await resume.promise;
      const result = await scope.execute({ type: "write", input: "accepted before close" });
      events.push("completed");
      return result;
    },
    undefined,
    () => () => {},
  );
  draining = true;
  const closing = store.close();
  const lateOperation = vi.fn(async () => "must not enter");
  try {
    await expect(
      runSqliteWorkerClientOperation(client, lateOperation, undefined, () => () => {}),
    ).rejects.toMatchObject(closedError);
    await expect(store.execute({ type: "write", input: "after close" })).rejects.toMatchObject(
      closedError,
    );
    expect(lateOperation).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    resume.resolve();
    await Promise.race([dispatched.promise, accepted]);
    expect(release).not.toHaveBeenCalled();
    committed.resolve("committed");
    await expect(accepted).resolves.toBe("committed");
    await closing;
    expect(events).toEqual(["dispatched", "completed", "released"]);
    expect(release).toHaveBeenCalledOnce();
  } finally {
    resume.resolve();
    committed.resolve("committed");
    await Promise.allSettled([accepted, closing]);
  }
});

it.each([
  "removed target",
  "closed backend",
  "foreign generation",
  "revoked source",
  "private wait",
  "different carrier",
] as const)(
  "retains direct descendant ownership at the %s boundary without enqueueing behind its caller",
  async (boundary) => {
    const source = createActor();
    const target = createActor();
    target.id = 2;
    target.volatile = true;
    const slot = { actors: new Set([source, target]), transport: {}, queue: [] } as unknown as Slot;
    Object.defineProperty(source, "slot", { value: slot });
    Object.defineProperty(target, "slot", {
      value: boundary === "different carrier" ? { ...slot, actors: new Set([target]) } : slot,
    });
    if (boundary === "removed target") {
      slot.actors.delete(target);
    }
    if (boundary === "closed backend") {
      target.backendClosed = true;
    }
    if (boundary === "foreign generation") {
      target.runtimeGeneration = Object.create(null) as NonNullable<Actor["runtimeGeneration"]>;
    }
    const refusal = new Error("Target source revoked before native use");
    const createAdmission = vi.fn(() => {
      throw new Error("Refused descendant acquired native admission");
    });
    const operation: OperationScope = {
      active: true,
      pending: new Set(),
      createAdmission: createSqliteWorkerAdmissionFactory(false, createAdmission),
      assertCurrent: () => {
        if (boundary === "revoked source") {
          throw refusal;
        }
      },
    };
    const dispatch = vi.fn(() => {
      throw new Error("Descendant queued behind its suspended caller");
    });
    const { client, store } = createSqliteWorkerClient<Operations>({
      actor: target,
      isDraining: () => false,
      isAvailable: () => true,
      dispatch,
      retireFailed: async () => {},
      release: async () => {},
    });
    const attempted = vi.fn(() => {
      if (boundary === "different carrier") {
        expect(
          executeSqliteWorkerScopedCommand(
            target,
            serialize({ type: "write", input: "separate" }),
            operation,
            () => {},
          ),
        ).toBeUndefined();
      } else {
        expect(() => client.executeReady({ type: "write", input: "refused" }, operation)).toThrow(
          boundary === "revoked source"
            ? refusal
            : expect.objectContaining({ code: "unavailable" }),
        );
      }
    });
    const host = createSqliteWorkerHostScope((_step, continuation) => {
      if (boundary === "private wait") {
        continuation.call({ kind: "next" });
      } else {
        attempted();
      }
    });
    host.bind(source, [source.databasePath]);
    const finished = vi.fn();
    const peer = createSqliteWorkerScopedTransfer(host.port, (value) => {
      const frame = value as { kind: string; sequence: number };
      if (frame.kind === "finish") {
        expect(frame).toMatchObject({ id: 1, abort: false });
        finished();
      } else if (frame.kind === "call") {
        peer.post({
          kind: "result",
          sequence: frame.sequence,
          result: { ok: true, value: undefined },
        });
      }
    });
    const service = () => {
      host.service();
      peer.service();
    };
    try {
      peer.post({ kind: "enter", id: 1, step: { kind: "entry-before-write" } });
      serviceScopedFrames(() => host.pending, service);
      expect(host.pending).toBe(true);
      host.drive((complete) => {
        attempted();
        serviceScopedFrames(complete, service);
        return undefined;
      });
      expect(host.hostFailure).toBeUndefined();
      serviceScopedFrames(() => finished.mock.calls.length > 0, service);
      expect(finished).toHaveBeenCalledOnce();
      expect(attempted).toHaveBeenCalledOnce();
      expect(createAdmission).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(operation.pending.size).toBe(0);
    } finally {
      host.close();
      peer.close();
      await store.close();
    }
  },
);

type TerminalCase = "success" | "native error" | "undefined failure";
const terminalCases: TerminalCase[] = ["success", "native error", "undefined failure"];

it.each(["same actor", "independent actor"] as const)(
  "binds the selected %s transaction before capturing descendant admission",
  async (boundary) => {
    const source = createActor();
    const target = boundary === "same actor" ? source : createActor();
    target.volatile = true;
    if (target !== source) {
      target.id = 2;
    }
    const slot = { actors: new Set([source, target]), transport: {}, queue: [] } as unknown as Slot;
    Object.defineProperty(source, "slot", { value: slot });
    if (target !== source) {
      Object.defineProperty(target, "slot", { value: slot });
    }
    const transaction = createSqliteWorkerHostTransaction();
    let selected: object | undefined;
    let childScope: ReturnType<typeof createSqliteWorkerHostScope> | undefined;
    let childPeer: ReturnType<typeof createSqliteWorkerScopedTransfer> | undefined;
    let childPort: MessagePort | undefined;
    const entered = vi.fn(() => {
      expect(captureSqliteWorkerCallerTransaction()).toBe(selected);
    });
    const createAdmission = vi.fn((retained: RetainedWorkerTransactionAdmission) => {
      selected = retained.transaction;
      if (boundary === "same actor") {
        expect(selected).toBe(transaction);
      } else {
        expect(selected).not.toBe(transaction);
      }
      childScope = createSqliteWorkerHostScope(() => {
        entered();
      });
      return {
        admission: createSqliteWorkerOperationAdmission(
          (_request, grant) => grant(),
          undefined,
          childScope,
        ),
        nativeLocations: [source.databasePath],
      };
    });
    const operation: OperationScope = {
      active: true,
      pending: new Set(),
      createAdmission: createSqliteWorkerAdmissionFactory(true, createAdmission),
    };
    const host = createSqliteWorkerHostScope(() => {
      expect(captureSqliteWorkerCallerTransaction()).toBe(transaction);
      expect(
        executeSqliteWorkerScopedCommand(
          target,
          serialize({ type: "write", input: "selected transaction" }),
          operation,
          () => {},
        )?.value,
      ).toBe("completed child");
      expect(captureSqliteWorkerCallerTransaction()).toBe(transaction);
    });
    host.bind(source, [source.databasePath], { transaction });
    const finished = vi.fn();
    const peer = createSqliteWorkerScopedTransfer(host.port, (value, transferred) => {
      const frame = value as { kind: string; sequence: number; action: { targetActor: number } };
      if (frame.kind === "finish") {
        expect(frame).toMatchObject({ id: 1, abort: false });
        finished();
        return;
      }
      if (frame.kind !== "call") {
        return;
      }
      expect(frame.action.targetActor).toBe(target.id);
      expect(transferred).toHaveLength(1);
      childPort = transferred[0]!;
      const attachment = receiveMessageOnPort(childPort)?.message as {
        kind: string;
        scope: MessagePort;
      };
      expect(attachment.kind).toBe("sqlite-operation-attachment");
      childPeer = createSqliteWorkerScopedTransfer(attachment.scope, (reply) => {
        expect(reply).toMatchObject({ kind: "finish", abort: false });
        childPort!.postMessage(
          {
            kind: "native-settlement",
            settlement: { kind: "completed" },
          },
          [],
        );
        peer.post({
          kind: "result",
          sequence: frame.sequence,
          result: { ok: true, value: "completed child" },
        });
      });
      childPeer.post({ kind: "enter", id: 1, step: { kind: "fresh-input" } });
    });
    const service = () => {
      host.service();
      peer.service();
      childPeer?.service();
    };
    try {
      peer.post({ kind: "enter", id: 1, step: { kind: "entry-before-write" } });
      serviceScopedFrames(() => host.pending, service);
      expect(host.pending).toBe(true);
      host.drive((complete) => {
        serviceScopedFrames(complete, service);
        return undefined;
      });
      expect(host.hostFailure).toBeUndefined();
      serviceScopedFrames(() => finished.mock.calls.length > 0, service);
      expect(finished).toHaveBeenCalledOnce();
      expect(createAdmission).toHaveBeenCalledOnce();
      expect(entered).toHaveBeenCalledOnce();
      await Promise.all(operation.pending);
      expect(operation.pending.size).toBe(0);
      expect(slot.queue).toEqual([]);
    } finally {
      host.close();
      childScope?.close();
      peer.close();
      childPeer?.close();
      childPort?.close();
    }
  },
);

/** Real framing/admission/settlement owners; only the native result source is controlled. */
function terminalFixture(outcome: TerminalCase, nested: boolean) {
  const actor = createActor();
  actor.volatile = true;
  const nativeError = new Error("Original native failure");
  const jobs: Job[] = [];
  const peers: ReturnType<typeof createSqliteWorkerScopedTransfer>[] = [];
  const ports: MessagePort[] = [];
  const frames: unknown[] = [];
  const caught: unknown[] = [];
  let originalTransaction: object | undefined;
  const childAdmission = vi.fn((retained: RetainedWorkerTransactionAdmission) => {
    expect(retained.transaction).toBe(originalTransaction);
    return {
      admission: createSqliteWorkerOperationAdmission((_request, grant) => grant()),
      nativeLocations: [actor.databasePath],
    };
  });
  const childOperation: OperationScope = {
    active: true,
    pending: new Set(),
    createAdmission: createSqliteWorkerAdmissionFactory(false, childAdmission),
  };
  const host = createSqliteWorkerHostScope(() => {
    expect(captureSqliteWorkerCallerTransaction()).toBe(originalTransaction);
    try {
      client.executeReady({ type: "write", input: "nested" }, childOperation);
      throw new Error("A terminal interruption must not fabricate a nested result");
    } catch (error) {
      caught.push(error);
    }
    expect(captureSqliteWorkerCallerTransaction()).toBeUndefined();
    expect(stageSqliteWorkerCallerRollback(() => {})).toBe(false);
    try {
      client.executeReady({ type: "write", input: "caught terminal" }, childOperation);
      throw new Error("A caught terminal must not admit another child");
    } catch (error) {
      caught.push(error);
    }
    return true;
  });
  const service = vi.spyOn(host, "service");
  const admission = createSqliteWorkerOperationAdmission(
    (_request, grant) => grant(),
    undefined,
    host,
  );
  const settle = vi.fn(() => {
    if (outcome === "undefined failure") {
      // oxlint-disable-next-line typescript/only-throw-error -- Original native settlement must preserve a thrown undefined, not manufacture an Error.
      throw undefined;
    }
  });
  const operation: OperationScope = {
    active: true,
    pending: new Set(),
    createAdmission: createSqliteWorkerAdmissionFactory(true, (retained) => {
      originalTransaction = retained.transaction;
      return { admission, nativeLocations: [actor.databasePath], settle };
    }),
  };
  let receivedChild = false;
  const slot = {
    actors: new Set([actor]),
    queue: [],
    exited: false,
    pendingOpens: 0,
    exit: Promise.resolve(),
    receiveReply() {
      throw new Error("Controlled lifecycle result uses the original Job settlement owner");
    },
    transport: {
      post(request: Job["request"]) {
        if (!request.operationAdmission) {
          return;
        }
        const attachment = receiveMessageOnPort(request.operationAdmission)?.message as {
          kind: string;
          scope: MessagePort;
        };
        expect(attachment.kind).toBe("sqlite-operation-attachment");
        const peer = createSqliteWorkerScopedTransfer(attachment.scope, (value, transferred) => {
          frames.push(value);
          expect(value).toMatchObject({ kind: "call", action: { kind: "execute" } });
          expect(transferred).toHaveLength(1);
          const childPort = transferred[0]!;
          ports.push(childPort);
          // A lost scoped reply does not discard the child's original outer rollback fact.
          childPort.postMessage(
            { kind: "native-settlement", settlement: { kind: "completed" } },
            [],
          );
          receivedChild = true;
        });
        peers.push(peer);
        if (nested) {
          peer.post({ kind: "enter", id: 1, step: { kind: "fresh-input" } });
        }
      },
      pump: () => false,
      watch() {
        const watched = slot.current;
        return {
          check() {
            if (watched?.terminal) {
              throw new Error("Terminal result lost to a stale liveness check");
            }
          },
          finish() {},
        };
      },
    },
  } as unknown as Slot;
  Object.defineProperty(actor, "slot", { value: slot });
  const { client, store } = createSqliteWorkerClient<Operations>({
    actor,
    isDraining: () => false,
    isAvailable: () => true,
    retireFailed: async () => {},
    release: async () => {},
    dispatch(payload, _signal, _scope, _assertCurrent, createAdmission, ready) {
      const completion = createDeferred<unknown>();
      const command = deserialize(payload) as { input: string };
      const job: Job = {
        request: { type: "execute", id: jobs.length + 1, actor: actor.id, input: payload },
        bytes: payload.byteLength,
        createAdmission,
        ready,
        resolve: completion.resolve,
        reject: completion.reject,
        detach() {},
      };
      jobs.push(job);
      slot.current = job;
      if (ready) {
        ready.job = job;
      }
      dispatchSqliteWorkerJob(slot, job, (error) => {
        settleSqliteWorkerJob(job, error);
        slot.current = undefined;
      });
      slot.transport!.pump = () => {
        if (job.terminal) {
          return false;
        }
        if (command.input !== "follower") {
          for (const peer of peers) {
            peer.service();
          }
        }
        if (nested && command.input !== "follower" && !receivedChild) {
          return false;
        }
        settleSqliteWorkerJob(
          job,
          command.input !== "follower" && outcome === "native error" ? nativeError : undefined,
          command.input === "follower" ? "follower result" : "original native result",
        );
        slot.current = undefined;
        return true;
      };
      return completion.promise;
    },
  });
  return {
    actor,
    client,
    operation,
    host,
    service,
    settle,
    jobs,
    caught,
    frames,
    childAdmission,
    expectedError: outcome === "native error" ? nativeError : undefined,
    async close() {
      admission.finish();
      for (const peer of peers) {
        peer.close();
      }
      for (const port of ports) {
        port.close();
      }
      await store.close();
    },
  };
}

it.each(terminalCases)(
  "delivers a lifecycle terminal %s before touching its closed scope",
  async (outcome) => {
    const fixture = terminalFixture(outcome, false);
    let observed: { value: unknown } | { error: unknown };
    try {
      try {
        observed = {
          value: fixture.client.executeReady(
            { type: "write", input: "original" },
            fixture.operation,
          ),
        };
      } catch (error) {
        observed = { error };
      }
      expect(observed).toEqual(
        outcome === "success"
          ? { value: "original native result" }
          : { error: fixture.expectedError },
      );
      if ("error" in observed) {
        expect(observed.error).toBe(fixture.expectedError);
      }
      expect(fixture.service).not.toHaveBeenCalled();
      expect(fixture.jobs[0]?.terminal?.settlement).toEqual({ kind: "completed" });
      expect(fixture.jobs[0]?.ready?.result).toBeUndefined();
      expect(fixture.settle).toHaveBeenCalledOnce();
      expect(fixture.actor.protocolFailure).toBeUndefined();
      expect(fixture.client.sealed).toBe(false);
      expect(fixture.client.executeReady({ type: "write", input: "follower" })).toBe(
        "follower result",
      );
    } finally {
      await fixture.close();
    }
  },
);

it.each(
  terminalCases.flatMap((outcome) => ["ready", "async"].map((mode) => [mode, outcome] as const)),
)(
  "unwinds a %s nested wait into the original %s without reopening caught terminal custody",
  async (mode, outcome) => {
    const fixture = terminalFixture(outcome, true);
    let observed: { value: unknown } | { error: unknown };
    try {
      try {
        observed = {
          value:
            mode === "ready"
              ? fixture.client.executeReady({ type: "write", input: "original" }, fixture.operation)
              : await fixture.client.execute(
                  { type: "write", input: "original" },
                  {},
                  fixture.operation,
                ),
        };
      } catch (error) {
        observed = { error };
      }
      expect(observed).toEqual(
        outcome === "success"
          ? { value: "original native result" }
          : { error: fixture.expectedError },
      );
      if ("error" in observed) {
        expect(observed.error).toBe(fixture.expectedError);
      }
      expect(fixture.caught).toHaveLength(2);
      expect(fixture.caught[0]).toBe(fixture.caught[1]);
      if (outcome === "success") {
        expect(typeof fixture.caught[0]).toBe("symbol");
      } else {
        expect(fixture.caught[0]).toBe(fixture.expectedError);
      }
      expect(fixture.host.hostFailure).toBeUndefined();
      expect(fixture.childAdmission).toHaveBeenCalledOnce();
      expect(fixture.frames).toHaveLength(1);
      expect(fixture.settle).toHaveBeenCalledOnce();
      expect(fixture.jobs).toHaveLength(1);
      if (mode === "async") {
        await expect(fixture.jobs[0]?.scopeDriver).resolves.toBeUndefined();
      }
      expect(fixture.actor.protocolFailure).toBeUndefined();
      expect(fixture.client.sealed).toBe(false);
      expect(fixture.client.executeReady({ type: "write", input: "follower" })).toBe(
        "follower result",
      );
    } finally {
      await fixture.close();
    }
  },
);

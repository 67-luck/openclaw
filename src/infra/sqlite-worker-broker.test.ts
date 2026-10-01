import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { deserialize } from "node:v8";
import type { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import * as logging from "../logging/logger.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { initializeSqliteRuntimeCapabilities } from "./bun-sqlite-library.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import { SQLITE_WORKER_MAX_RESULT_BYTES } from "./sqlite-worker-contract.js";
import {
  useSqliteWorkerStoreFixture,
  appendWorkerRow as append,
  readWorkerRows as read,
} from "./sqlite-worker-fixture.test-support.js";
import {
  reserveSqliteWorkerInputPreparation,
  openVolatileAgentDatabaseSqliteWorkerStore,
  retainSqliteWorkerStoreOperation,
  runSqliteWorkerStoreOperation,
  runSqliteWorkerStoreWrite,
  type SqliteWorkerStore,
} from "./sqlite-worker-store.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";
import { createReadyPredecessorReleaser } from "./sqlite-worker-store.transport.test-support.js";
import { SQLITE_WORKER_TRANSFER_FRAME_BYTES } from "./sqlite-worker-transfer.js";
import { SQLITE_WORKER_PROTOCOL_WAIT_NS } from "./sqlite-worker-transport-contract.js";
import * as sqliteTransport from "./sqlite-worker-transport.js";
import * as workerCpu from "./worker-cpu.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 32,
}));

const {
  stores,
  tempDirs: dirs,
  databasePath,
  open,
} = useSqliteWorkerStoreFixture("sqlite-worker-broker-", () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const { explicitSqliteCloseReleasesNativeResources } = await initializeSqliteRuntimeCapabilities();
const poolIt = explicitSqliteCloseReleasesNativeResources ? it : it.skip;

poolIt("keeps an independent database responsive while another worker is at capacity", async () => {
  const held = createDeferredCore();
  let release: (() => void) | undefined;
  let busyThread: number | undefined;
  const createTransport = sqliteTransport.createSqliteWorkerTransport;
  const messages = vi.spyOn(sqliteTransport, "createSqliteWorkerTransport");
  messages.mockImplementation((options) =>
    createTransport({
      ...options,
      reply(reply, pumping) {
        if (busyThread !== undefined && !release && reply.ok && !reply.transfer && !reply.input) {
          const value: unknown = deserialize(reply.value);
          if (isRecord(value) && value.threadId === busyThread) {
            release = () => options.reply(reply, pumping);
            held.resolve();
            return;
          }
        }
        options.reply(reply, pumping);
      },
    }),
  );
  const busy = await open(databasePath());
  const independent = await open(databasePath());
  busyThread = (await append(busy, "before saturation")).threadId;
  const accepted = Promise.allSettled(
    Array.from({ length: 128 }, (_, index) => append(busy, String(index))),
  );
  const canceled = new Error("Waiting command canceled");
  const revoked = new Error("Waiting command authority revoked");
  let waiting: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await held.promise;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const completed = expect(append(independent, "independent write")).resolves.toMatchObject({
      writes: 1,
    });
    // A different worker must not spend the busy worker's admission timeout waiting for room.
    vi.advanceTimersByTime(10_000);
    await completed;
    expect(await read(independent)).toEqual(["independent write"]);
    vi.useRealTimers();
    const cancel = new AbortController();
    let current = true;
    waiting = Promise.allSettled([
      busy.execute({ type: "append", input: { value: "canceled" } }, { signal: cancel.signal }),
      runSqliteWorkerStoreOperation(
        busy,
        (scope) => scope.execute({ type: "append", input: { value: "revoked" } }),
        undefined,
        () => {
          if (!current) {
            throw revoked;
          }
        },
      ),
      append(busy, "oldest surviving waiter"),
      append(busy, "later arrival"),
    ]);
    current = false;
    cancel.abort(canceled);
  } finally {
    vi.useRealTimers();
    messages.mockRestore();
    release?.();
    expect((await accepted).every((outcome) => outcome.status === "fulfilled")).toBe(true);
  }
  expect(await waiting).toMatchObject([
    { status: "rejected", reason: canceled },
    { status: "rejected", reason: revoked },
    { status: "fulfilled" },
    { status: "fulfilled" },
  ]);
  expect(await read(busy)).toEqual([
    "before saturation",
    ...Array.from({ length: 128 }, (_, index) => String(index)),
    "oldest surviving waiter",
    "later arrival",
  ]);
});

it("settles volatile predecessors before a ready call without running Promise observers", async () => {
  const root = dirs.make("sqlite-worker-ready-");
  const markerPath = path.join(root, "preparing");
  const gatePath = path.join(root, "release");
  const caller = new AsyncLocalStorage<object>();
  const identity = {};
  const { release, ready, releaserExit } = createReadyPredecessorReleaser(gatePath);
  const posted: Array<{ id: number; actor: number; value: string; gateOpen: boolean }> = [];
  const requested = new Map<number, string>();
  const nativePosts: bigint[] = [];
  const createTransport = sqliteTransport.createSqliteWorkerTransport;
  vi.spyOn(sqliteTransport, "createSqliteWorkerTransport").mockImplementation((options) =>
    createTransport({
      ...options,
      posted(id, actor, attemptedAtNs) {
        const value = requested.get(id);
        if (value !== undefined) {
          posted.push({ id, actor, value, gateOpen: existsSync(gatePath) });
          nativePosts.push(attemptedAtNs);
        }
        options.posted(id, actor, attemptedAtNs);
      },
    }),
  );
  const createWorker = workerCpu.createCpuTrackedWorker;
  vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((...args) => {
    const worker = createWorker(...args);
    const postMessage = worker.postMessage.bind(worker);
    vi.spyOn(worker, "postMessage").mockImplementation((...message) => {
      const envelope: unknown = message[0];
      const request: unknown =
        isRecord(envelope) && envelope.kind === "request" ? envelope.request : envelope;
      if (isRecord(request) && request.type === "execute" && request.input instanceof Uint8Array) {
        const command: unknown = deserialize(request.input);
        if (
          isRecord(command) &&
          command.type === "append" &&
          isRecord(command.input) &&
          typeof command.input.value === "string" &&
          typeof request.id === "number" &&
          typeof request.actor === "number"
        ) {
          requested.set(request.id, command.input.value);
        }
      }
      return postMessage(...message);
    });
    return worker;
  });
  let store: SqliteWorkerStore<FixtureOperations> | undefined;
  let operation: ReturnType<typeof retainSqliteWorkerStoreOperation<FixtureOperations>> | undefined;
  let first: Promise<FixtureOperations["append"]["output"]> | undefined;
  let observation: Promise<unknown> | undefined;
  const observed = vi.fn();
  const failures: unknown[] = [];
  try {
    await ready.promise;
    store = await caller.run(identity, () =>
      openVolatileAgentDatabaseSqliteWorkerStore<FixtureOperations>({
        id: "broker-ready-fixture",
        moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
        input: { type: "prepare", markerPath, gatePath },
        assertCurrent() {
          expect(caller.getStore()).toBe(identity);
        },
      }),
    );
    stores.add(store);
    const retained = (operation = retainSqliteWorkerStoreOperation(store));
    const current = store;
    first = caller.run(identity, () =>
      runSqliteWorkerStoreOperation(
        current,
        (scope) => scope.execute({ type: "append", input: { value: "async predecessor" } }),
        undefined,
        () => expect(caller.getStore()).toBe(identity),
      ),
    );
    observation = first.then(observed);
    void observation.catch(() => undefined);
    await vi.waitFor(() => expect(existsSync(markerPath)).toBe(true));
    expect(existsSync(gatePath)).toBe(false);
    expect(posted).toHaveLength(1);
    const started = performance.now();
    Atomics.store(release, 0, 1);
    Atomics.notify(release, 0);
    const second = caller.run(identity, () =>
      retained.executeReady({
        type: "append",
        input: { value: "ready follower" },
      }),
    );
    expect(performance.now() - started).toBeGreaterThan(5_000);
    expect(posted).toEqual([
      {
        id: expect.any(Number),
        actor: expect.any(Number),
        value: "async predecessor",
        gateOpen: false,
      },
      {
        id: expect.any(Number),
        actor: expect.any(Number),
        value: "ready follower",
        gateOpen: true,
      },
    ]);
    expect(posted[1]?.actor).toBe(posted[0]?.actor);
    expect(posted[1]?.id).not.toBe(posted[0]?.id);
    const [predecessorPost, followerPost] = nativePosts;
    if (predecessorPost === undefined || followerPost === undefined) {
      throw new Error("Both native dispatch witnesses are required");
    }
    expect(followerPost - predecessorPost).toBeGreaterThan(5_000_000_000n);
    expect(second.writes).toBe(2);
    expect(second.threadId).toBeGreaterThan(0);
    expect(observed).not.toHaveBeenCalled();
    expect(
      caller.run(identity, () => retained.executeReady({ type: "read", input: undefined })),
    ).toEqual(["async predecessor", "ready follower"]);
    await expect(first).resolves.toMatchObject({ writes: 1, actor: second.actor });
    await observation;
    expect(observed).toHaveBeenCalledOnce();
    await releaserExit;
  } catch (error) {
    failures.push(error);
  } finally {
    writeFileSync(gatePath, "cleanup release");
    Atomics.store(release, 0, 1);
    Atomics.notify(release, 0);
    Atomics.store(release, 1, 1);
    Atomics.notify(release, 1);
    // Store retirement settles failed native work retained by the operation close.
    const closing = Promise.allSettled([operation?.close(), store?.close()]);
    await Promise.allSettled([first, observation, releaserExit]);
    const results = await closing;
    failures.push(
      ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    );
    if (store && results[1]?.status === "fulfilled") {
      stores.delete(store);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "SQLite ready fixture cleanup failed");
  }
});

it("does not expose ready execution on a durable store", async () => {
  const store = await open(databasePath());
  const operation = retainSqliteWorkerStoreOperation(store);
  const failures: unknown[] = [];
  try {
    expect(() => operation.executeReady({ type: "read", input: undefined })).toThrow(
      "ready volatile owner",
    );
    expect(await read(store)).toEqual([]);
  } catch (error) {
    failures.push(error);
  } finally {
    const results = await Promise.allSettled([operation.close(), store.close()]);
    failures.push(
      ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    );
    if (results[1]?.status === "fulfilled") {
      stores.delete(store);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "SQLite ready fixture cleanup failed");
  }
});

nodeIt("keeps one ready deadline while native result frames continue", async () => {
  const posts: Array<{ id: number; actor: number; atNs: bigint }> = [];
  const frames: Array<{
    id: number;
    sequence: number;
    offset: number;
    bytes: number;
    recordBytes: number;
    recordDone: boolean;
    atNs: bigint;
  }> = [];
  const terminalFrames: Array<{ id: number; sequence: number }> = [];
  const nativeCompleted = createDeferred();
  const waiting = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  let watching = false;
  let armed = false;
  const createTransport = sqliteTransport.createSqliteWorkerTransport;
  vi.spyOn(sqliteTransport, "createSqliteWorkerTransport").mockImplementation((options) =>
    createTransport({
      ...options,
      posted(id, actor, atNs) {
        if (watching) {
          posts.push({ id, actor, atNs });
        }
        options.posted(id, actor, atNs);
      },
      reply(reply, pumping) {
        // Let the canonical owner request the next real frame before delaying its delivery.
        options.reply(reply, pumping);
        const target = posts[0];
        if (!target || reply.id !== target.id || !reply.ok || reply.transfer !== "frame") {
          return;
        }
        const frame: unknown = deserialize(reply.value);
        if (
          !isRecord(frame) ||
          typeof frame.id !== "number" ||
          typeof frame.sequence !== "number" ||
          typeof frame.done !== "boolean"
        ) {
          throw new Error("A real native transfer frame is required");
        }
        if (frame.done) {
          terminalFrames.push({ id: frame.id, sequence: frame.sequence });
          nativeCompleted.resolve();
          return;
        }
        if (
          typeof frame.offset !== "number" ||
          typeof frame.recordBytes !== "number" ||
          typeof frame.recordDone !== "boolean" ||
          !(frame.bytes instanceof Uint8Array)
        ) {
          throw new Error("A real native data frame is required");
        }
        frames.push({
          id: frame.id,
          sequence: frame.sequence,
          offset: frame.offset,
          bytes: frame.bytes.byteLength,
          recordBytes: frame.recordBytes,
          recordDone: frame.recordDone,
          atNs: process.hrtime.bigint(),
        });
        if (armed && frames.length <= 3) {
          Atomics.wait(waiting, 0, 0, 1_800);
        }
      },
    }),
  );
  const store = await openVolatileAgentDatabaseSqliteWorkerStore<FixtureOperations>({
    id: "native-frame-deadline",
    moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
    input: undefined,
    assertCurrent() {},
  });
  stores.add(store);
  const operation = retainSqliteWorkerStoreOperation(store);
  const observed = vi.fn();
  let observation: Promise<unknown> | undefined;
  const seedRows = Math.ceil(SQLITE_WORKER_MAX_RESULT_BYTES / SQLITE_WORKER_TRANSFER_FRAME_BYTES);
  const failures: unknown[] = [];
  try {
    // Cross the real inline-result threshold without creating an oversized input command.
    for (let index = 0; index < seedRows; index++) {
      await expect(
        append(store, String.fromCharCode(97 + index).repeat(SQLITE_WORKER_TRANSFER_FRAME_BYTES)),
      ).resolves.toMatchObject({ writes: index + 1 });
    }
    await expect(append(store, "tail".repeat(1024))).resolves.toMatchObject({
      writes: seedRows + 1,
    });
    observation = Promise.resolve().then(observed);
    watching = true;
    armed = true;
    let failure: unknown;
    try {
      operation.executeReady({ type: "read", input: undefined });
    } catch (error) {
      failure = error;
    } finally {
      armed = false;
    }
    const returnedAtNs = process.hrtime.bigint();
    expect(failure).toMatchObject({
      name: "SqliteWorkerError",
      code: "outcome-unknown",
      message: "SQLite worker protocol settlement is unknown",
    });
    expect(posts).toHaveLength(1);
    expect(frames).toHaveLength(3);
    const [target] = posts;
    const [first, second, third] = frames;
    if (!target || !first || !second || !third) {
      throw new Error("The original post and three native data frames are required");
    }
    expect(first.recordBytes).toBeGreaterThan(SQLITE_WORKER_MAX_RESULT_BYTES);
    expect(
      frames.map(({ id, sequence, offset, bytes, recordDone }) => ({
        id,
        sequence,
        offset,
        bytes,
        recordDone,
      })),
    ).toEqual(
      [0, 1, 2].map((sequence) => ({
        id: first.id,
        sequence,
        offset: sequence * SQLITE_WORKER_TRANSFER_FRAME_BYTES,
        bytes: SQLITE_WORKER_TRANSFER_FRAME_BYTES,
        recordDone: false,
      })),
    );
    expect(first.atNs).toBeGreaterThanOrEqual(target.atNs);
    expect(second.atNs).toBeGreaterThan(first.atNs);
    expect(third.atNs).toBeGreaterThan(second.atNs);
    expect(third.atNs - target.atNs).toBeLessThan(SQLITE_WORKER_PROTOCOL_WAIT_NS);
    expect(returnedAtNs - target.atNs).toBeGreaterThanOrEqual(SQLITE_WORKER_PROTOCOL_WAIT_NS);
    expect(terminalFrames).toEqual([]);
    expect(observed).not.toHaveBeenCalled();
    await expect(read(store)).rejects.toBe(failure);
    await observation;
    expect(observed).toHaveBeenCalledOnce();
    expect(posts).toHaveLength(1);
    // Explicit close retires a failed slot; observe its accepted result before cleanup.
    await withTestTimeout(
      nativeCompleted.promise,
      5_000,
      "Native result transfer did not finish before fixture cleanup",
    );
  } catch (error) {
    failures.push(error);
  } finally {
    armed = false;
    await Promise.allSettled([observation]);
    watching = false;
    const results = await Promise.allSettled([operation.close(), store.close()]);
    failures.push(
      ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    );
    if (results[1]?.status === "fulfilled") {
      stores.delete(store);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "SQLite ready fixture cleanup failed");
  }
  expect(frames.map(({ sequence }) => sequence)).toEqual(
    Array.from({ length: seedRows + 1 }, (_, index) => index),
  );
  expect(terminalFrames).toEqual([{ id: frames[0]?.id, sequence: seedRows + 1 }]);
  expect(posts).toHaveLength(1);
});

nodeIt.each(["predecessor", "ready"] as const)(
  "retains a %s lost native result without replaying an undispatched follower",
  async (mode) => {
    const initial = workerCpu.getTrackedWorkerCpuSources();
    const store = await openVolatileAgentDatabaseSqliteWorkerStore<FixtureOperations>({
      id: `native-exit-${mode}`,
      moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
      input: undefined,
      assertCurrent() {},
    });
    stores.add(store);
    const operation = retainSqliteWorkerStoreOperation(store);
    const command = { type: "commitThenExit" as const, input: { value: "one native commit" } };
    let predecessor: Promise<unknown> | undefined;
    const observed = vi.fn();
    const failures: unknown[] = [];
    try {
      if (mode === "predecessor") {
        predecessor = store.execute(command);
        void predecessor.then(observed, observed);
      }
      expect(() =>
        operation.executeReady(mode === "ready" ? command : { type: "read", input: undefined }),
      ).toThrow(
        expect.objectContaining({ code: mode === "ready" ? "outcome-unknown" : "unavailable" }),
      );
      expect(observed).not.toHaveBeenCalled();
      if (predecessor) {
        await expect(predecessor).rejects.toMatchObject({ code: "outcome-unknown" });
      }
    } catch (error) {
      failures.push(error);
    } finally {
      const closing = Promise.allSettled([operation.close(), store.close()]);
      await Promise.allSettled([predecessor]);
      const results = await closing;
      failures.push(
        ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      );
      if (results[1]?.status === "fulfilled") {
        stores.delete(store);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "SQLite ready fixture cleanup failed");
    }
    expect(workerCpu.getTrackedWorkerCpuSources().workers).toEqual(initial.workers);
  },
);

nodeIt("drains a real committed reply before using the child exit witness", async () => {
  const initial = workerCpu.getTrackedWorkerCpuSources();
  let nativeStopped: Promise<void> | undefined;
  const store = await openVolatileAgentDatabaseSqliteWorkerStore<FixtureOperations>({
    id: "native-reply-before-exit",
    moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
    input: undefined,
    assertCurrent() {},
    onNativeStopped(stopped) {
      nativeStopped = stopped;
    },
  });
  stores.add(store);
  const operation = retainSqliteWorkerStoreOperation(store);
  const failures: unknown[] = [];
  try {
    expect(
      operation.executeReady({
        type: "commitThenReplyAndExit",
        input: { value: "committed before native exit" },
      }),
    ).toMatchObject({ writes: 1, threadId: expect.any(Number) });
    assert(nativeStopped, "Expected the original native-stop promise");
    // Observe native stop before cleanup can dispatch a close command.
    await withTestTimeout(
      nativeStopped,
      5_000,
      "Native DATA stop was not observed before fixture cleanup",
    );
  } catch (error) {
    failures.push(error);
  } finally {
    const results = await Promise.allSettled([operation.close(), store.close()]);
    failures.push(
      ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    );
    if (results[1]?.status === "fulfilled") {
      stores.delete(store);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "SQLite ready fixture cleanup failed");
  }
  expect(workerCpu.getTrackedWorkerCpuSources().workers).toEqual(initial.workers);
});

nodeIt(
  "accounts for a pooled volatile pair as two native workers and samples the real child",
  async () => {
    vi.spyOn(os, "availableParallelism").mockReturnValue(1);
    const broker = new SqliteWorkerBroker();
    const initial = workerCpu.getTrackedWorkerCpuSources();
    const initialMemory = workerCpu.sampleTrackedWorkerMemory();
    const threads = new Set<number>();
    try {
      for (let index = 0; index < 5; index++) {
        const store = await broker.open<FixtureOperations>(
          {
            moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
            databasePath: ":memory:",
            input: undefined,
          },
          undefined,
          undefined,
          { volatile: { id: `physical-pair-${index}` } },
        );
        if (!store) {
          throw new Error("Volatile fixture store was not created");
        }
        threads.add((await append(store, "same physical child")).threadId);
        expect(workerCpu.getTrackedWorkerCpuSources().workers).toHaveLength(
          initial.workers.length + 2,
        );
      }
      expect(threads.size).toBe(1);
      const durable = await broker.open<FixtureOperations>({
        moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
        databasePath: databasePath(),
        input: undefined,
      });
      if (!durable) {
        throw new Error("Durable fixture store was not created");
      }
      expect(threads.has((await append(durable, "independent durable actor")).threadId)).toBe(true);
      expect(await read(durable)).toEqual(["independent durable actor"]);
      expect(() => broker.executeReady(durable, { type: "read", input: undefined })).toThrow(
        expect.objectContaining({ code: "unavailable" }),
      );
      const sources = workerCpu.getTrackedWorkerCpuSources();
      const added = sources.workers.filter((source) => !initial.workers.includes(source));
      const samples = await Promise.all(added.map((source) => source.cpuUsage()));
      expect(samples).toHaveLength(2);
      for (const sample of samples) {
        expect(sample).toEqual({ user: expect.any(Number), system: expect.any(Number) });
      }
      await vi.waitFor(() => {
        const memory = workerCpu.sampleTrackedWorkerMemory();
        expect(memory.workerHeapSampledCount).toBe(initialMemory.workerHeapSampledCount + 2);
        expect(memory.workerHeaps.map(({ script }) => script)).toEqual([
          ...initialMemory.workerHeaps.map(({ script }) => script),
          "sqlite-worker-transport.worker.js",
          "sqlite-store.worker.js",
        ]);
      });
    } finally {
      await broker.close();
    }
    expect(workerCpu.getTrackedWorkerCpuSources().workers).toEqual(initial.workers);
    expect(workerCpu.getTrackedWorkerCpuSources().revision).toBeGreaterThan(initial.revision);
    expect(workerCpu.sampleTrackedWorkerMemory().workerCount).toBe(initialMemory.workerCount);
  },
);

nodeIt(
  "retains the original pair until native service exit after a blocked ready waiter",
  async () => {
    const root = dirs.make("sqlite-worker-service-exit-");
    const markerPath = path.join(root, "preparing");
    const gatePath = path.join(root, "release");
    const initial = workerCpu.getTrackedWorkerCpuSources();
    let service: Worker | undefined;
    const serviceUrl = resolveRuntimeProcessEntrypointUrl("sqliteTransport");
    const createWorker = workerCpu.createCpuTrackedWorker;
    vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((...args) => {
      const worker = createWorker(...args);
      if (args[0] instanceof URL && args[0].href === serviceUrl.href) {
        service = worker;
      }
      return worker;
    });
    const store = await openVolatileAgentDatabaseSqliteWorkerStore<FixtureOperations>({
      id: "native-service-exit",
      moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
      input: { type: "prepare", markerPath, gatePath },
      assertCurrent() {},
    });
    stores.add(store);
    const operation = retainSqliteWorkerStoreOperation(store);
    let predecessor: Promise<unknown> | undefined;
    let termination: Promise<number> | undefined;
    const observed = vi.fn();
    const failures: unknown[] = [];
    try {
      predecessor = append(store, "unsettled predecessor");
      void predecessor.then(observed, observed);
      await vi.waitFor(() => expect(existsSync(markerPath)).toBe(true));
      if (!service) {
        throw new Error("The real native service is required");
      }
      const exited = vi.fn();
      service.once("exit", exited);
      termination = service.terminate();
      expect(() => operation.executeReady({ type: "read", input: undefined })).toThrow(
        expect.objectContaining({ code: "outcome-unknown" }),
      );
      expect(exited).not.toHaveBeenCalled();
      expect(observed).not.toHaveBeenCalled();
      expect(workerCpu.getTrackedWorkerCpuSources().workers).toHaveLength(
        initial.workers.length + 2,
      );
      await termination;
      expect(exited).toHaveBeenCalledOnce();
      await expect(predecessor).rejects.toMatchObject({ code: "outcome-unknown" });
    } catch (error) {
      failures.push(error);
    } finally {
      writeFileSync(gatePath, "cleanup release");
      const closing = Promise.allSettled([operation.close(), store.close()]);
      await Promise.allSettled([predecessor, termination]);
      const results = await closing;
      failures.push(
        ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      );
      if (results[1]?.status === "fulfilled") {
        stores.delete(store);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "SQLite ready fixture cleanup failed");
    }
    expect(workerCpu.getTrackedWorkerCpuSources().workers).toEqual(initial.workers);
  },
);

nodeIt.each([
  { first: "durable", closeFirst: "durable" },
  { first: "durable", closeFirst: "volatile" },
  { first: "volatile", closeFirst: "durable" },
  { first: "volatile", closeFirst: "volatile" },
] as const)(
  "shares the minimum pair for $first first and joins it after $closeFirst closes first",
  async ({ first, closeFirst }) => {
    vi.spyOn(os, "availableParallelism").mockReturnValue(1);
    const broker = new SqliteWorkerBroker();
    const initial = workerCpu.getTrackedWorkerCpuSources();
    const create = sqliteTransport.createSqliteWorkerTransport;
    let service: Worker | undefined;
    vi.spyOn(sqliteTransport, "createSqliteWorkerTransport").mockImplementation((options) => {
      const transport = create(options);
      service = transport.worker;
      return transport;
    });
    const file = databasePath();
    const openActor = (kind: "durable" | "volatile") =>
      broker.open<FixtureOperations>(
        {
          moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
          databasePath: kind === "durable" ? file : ":memory:",
          input: undefined,
        },
        undefined,
        undefined,
        kind === "volatile" ? { volatile: { id: "mixed-close-order" } } : {},
      );
    const release = createDeferred();
    let closing: Promise<void> | undefined;
    try {
      const a = await openActor(first);
      const b = await openActor(first === "durable" ? "volatile" : "durable");
      if (!a || !b || !service) {
        throw new Error("Expected both actors on their retained pair");
      }
      const durable = first === "durable" ? a : b;
      const volatile = first === "volatile" ? a : b;
      const disk = await append(durable, "disk");
      const memory = await append(volatile, "memory");
      expect(disk.threadId).toBe(memory.threadId);
      expect(disk.actor).not.toBe(memory.actor);
      expect(() => broker.executeReady(durable, { type: "read", input: undefined })).toThrow(
        expect.objectContaining({ code: "unavailable" }),
      );
      const survivor = closeFirst === "durable" ? volatile : durable;
      await (closeFirst === "durable" ? durable : volatile).close();
      expect(await read(survivor)).toEqual([closeFirst === "durable" ? "memory" : "disk"]);
      expect(service.threadId).not.toBe(-1);
      expect(workerCpu.getTrackedWorkerCpuSources().workers).toHaveLength(
        initial.workers.length + 2,
      );
      const entered = createDeferred();
      const terminate = service.terminate.bind(service);
      vi.spyOn(service, "terminate").mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return terminate();
      });
      closing = survivor.close();
      await entered.promise;
      expect(service.threadId).not.toBe(-1);
      expect(workerCpu.getTrackedWorkerCpuSources().workers).toHaveLength(
        initial.workers.length + 2,
      );
      release.resolve();
      await closing;
      expect(service.threadId).toBe(-1);
      expect(workerCpu.getTrackedWorkerCpuSources().workers).toEqual(initial.workers);
    } finally {
      release.resolve();
      try {
        await closing;
      } finally {
        await broker.close();
      }
    }
  },
);

it.each([
  { writeAdmission: false, revoke: false },
  { writeAdmission: false, revoke: true },
  { writeAdmission: true, revoke: false },
  { writeAdmission: true, revoke: true },
])(
  "retains queued command context and live ownership (write admission: $writeAdmission, revoke: $revoke)",
  async ({ writeAdmission, revoke }) => {
    const file = databasePath();
    const store = await open(file);
    const caller = new AsyncLocalStorage<{ current: boolean }>();
    const owner = { current: true };
    const revoked = new Error("Queued command owner was revoked");
    const assertCurrent = () => {
      if (caller.getStore() !== owner) {
        throw new Error("Queued command lost its caller context");
      }
      if (!owner.current) {
        throw revoked;
      }
    };
    const write = (scope: Pick<SqliteWorkerStore<FixtureOperations>, "execute">) =>
      scope.execute({ type: "append", input: { value: "queued" } });

    // Both commands enqueue before a Worker reply can dispatch the guarded follower.
    const predecessor = append(store, "before");
    const queued = caller.run(owner, () =>
      writeAdmission
        ? runSqliteWorkerStoreWrite(store, write, assertCurrent, [file])
        : runSqliteWorkerStoreOperation(store, write, undefined, assertCurrent),
    );
    const outcomes = Promise.allSettled([predecessor, queued]);
    owner.current = !revoke;

    const [first, second] = await outcomes;
    expect(first.status).toBe("fulfilled");
    if (revoke) {
      expect(second).toEqual({ status: "rejected", reason: revoked });
    } else {
      expect(second.status).toBe("fulfilled");
    }
    expect(await read(store)).toEqual(revoke ? ["before"] : ["before", "queued"]);
    expect(caller.getStore()).toBeUndefined();
  },
);

it.each(["abort", "drain", "timeout"] as const)(
  "releases admission waiters on %s without losing accepted writes",
  async (action) => {
    const file = databasePath();
    const store = await open(file);
    const accepted = Promise.allSettled(
      Array.from({ length: 128 }, (_, index) => append(store, String(index))),
    );
    const cancel = new AbortController();
    const reason = new Error("waiting caller canceled");
    const logger = logging.getChildLogger();
    const warn = vi.spyOn(logger, "warn");
    const logs = vi.spyOn(logging, "getChildLogger").mockReturnValue(logger);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    const waiters = Promise.allSettled(
      Array.from({ length: 2 }, () =>
        store.execute(
          { type: "append", input: { value: "never dispatched" } },
          { signal: cancel.signal },
        ),
      ),
    );
    let settled = false;
    void waiters.then(() => {
      settled = true;
    });
    let closing: Promise<void> | undefined;
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      if (action === "abort") {
        cancel.abort(reason);
      } else if (action === "drain") {
        closing = drainGlobalSingletonLifecycleState("restart");
      } else {
        vi.advanceTimersByTime(9_999);
        await Promise.resolve();
        expect(settled).toBe(false);
        vi.advanceTimersByTime(1);
      }
      for (const outcome of await waiters) {
        expect(outcome).toMatchObject({
          status: "rejected",
          reason: action === "abort" ? reason : { code: "overloaded" },
        });
      }
      if (action === "timeout") {
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith("SQLite worker admission delayed", {
          queueDepth: 2,
          waitMs: 10_000,
        });
      }
    } finally {
      vi.useRealTimers();
      logs.mockRestore();
      warn.mockRestore();
      cancel.abort(reason);
      expect((await accepted).every((outcome) => outcome.status === "fulfilled")).toBe(true);
      await closing;
    }
    const reader = action === "drain" ? await open(file) : store;
    expect(await read(reader)).toEqual(Array.from({ length: 128 }, (_, index) => String(index)));
    expect(await append(reader, "capacity returned")).toMatchObject({
      writes: action === "drain" ? 1 : 129,
    });
  },
);

it("charges admission waiters to the byte budget and releases canceled reservations", async () => {
  const store = await open(databasePath());
  const independent = await open(databasePath());
  const concurrentInputs = Array.from({ length: 3 }, () =>
    reserveSqliteWorkerInputPreparation(64 * 1024 * 1024),
  );
  const accepted = Promise.allSettled(Array.from({ length: 128 }, () => read(store)));
  const cancel = new AbortController();
  const waiting = store.execute(
    { type: "append", input: { value: "x".repeat(40 * 1024 * 1024) } },
    { signal: cancel.signal },
  );
  const outcome = Promise.allSettled([waiting]);
  try {
    await expect(append(independent, "x".repeat(30 * 1024 * 1024))).rejects.toMatchObject({
      code: "overloaded",
    });
    cancel.abort(new Error("release waiting bytes"));
    expect(await outcome).toMatchObject([
      { status: "rejected", reason: { message: "release waiting bytes" } },
    ]);
    const replacement = new AbortController();
    const replacementOutcome = Promise.allSettled([
      store.execute(
        { type: "append", input: { value: "x".repeat(40 * 1024 * 1024) } },
        { signal: replacement.signal },
      ),
    ]);
    replacement.abort(new Error("replacement admitted"));
    expect(await replacementOutcome).toMatchObject([
      { status: "rejected", reason: { message: "replacement admitted" } },
    ]);
  } finally {
    for (const prepared of concurrentInputs) {
      prepared.release();
    }
    cancel.abort();
    await outcome;
    await accepted;
  }
  expect(await read(store)).toEqual([]);
});

poolIt.each([
  { cores: 1, workers: 2 },
  { cores: 24, workers: 3 },
  { cores: 128, workers: 8 },
])(
  "bounds service pairs within $workers physical workers for $cores available CPUs",
  async ({ cores, workers }) => {
    const parallelism = vi.spyOn(os, "availableParallelism").mockReturnValue(cores);
    const broker = new SqliteWorkerBroker();
    const initial = workerCpu.getTrackedWorkerCpuSources();
    try {
      const threads = new Set<number>();
      for (let index = 0; index <= workers; index++) {
        const store = await broker.open<FixtureOperations>({
          moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
          databasePath: databasePath(),
          input: undefined,
        });
        if (!store) {
          throw new Error("Fixture store missing");
        }
        threads.add((await append(store, "thread count")).threadId);
      }
      expect(threads.size).toBe(Math.floor(workers / 2));
      expect(workerCpu.getTrackedWorkerCpuSources().workers).toHaveLength(
        initial.workers.length + 2 * Math.floor(workers / 2),
      );
    } finally {
      await broker.close();
      parallelism.mockRestore();
    }
    expect(workerCpu.getTrackedWorkerCpuSources().workers).toEqual(initial.workers);
  },
);

import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferredCore } from "./deferred.js";
import { resolveGlobalSingleton } from "./global-singleton.js";

const MAX_WRITERS_PER_TURN = 4;
const WRITER_TURN_BUDGET_MS = 4;

/** Pending exclusive store write plus the promise hooks for its caller. */
type StoreWriterTask = {
  /** Write operation to run once earlier tasks for the same store path finish. */
  fn: () => Promise<unknown>;
  /** Resolves the caller's promise with the write result. */
  resolve: (value: unknown) => void;
  /** Rejects the caller's promise with the write failure or test cleanup error. */
  reject: (reason: unknown) => void;
};

/** Per-store-path FIFO queue that serializes writes within one process. */
export type StoreWriterQueue = {
  /** Writes waiting behind the active drain. */
  pending: StoreWriterTask[];
  /** Active drain promise, reused by waiters until the current batch settles. */
  drainPromise: Promise<void> | null;
};

/** Store writer queues keyed by the canonical store path. */
type StoreWriterQueues = Map<string, StoreWriterQueue>;

/** Request-owned monotonic timestamps; queued work may be rejected without entering. */
export type StoreWriterTiming = { startedAt?: number; finishedAt?: number; reentrant?: boolean };

type ActiveStoreWriter = {
  active: boolean;
  native: Set<object>;
  hostSteps: Set<object>;
  parent: ActiveStoreWriter | undefined;
  queues: StoreWriterQueues;
  storePath: string;
};

// Queue maps are often global singletons shared by separately bundled runtime
// chunks. Their reentrancy context must cross the same module boundary.
const activeStoreWriters = resolveGlobalSingleton(
  Symbol.for("openclaw.activeStoreWriters"),
  () => new AsyncLocalStorage<ActiveStoreWriter>(),
);

// Independently draining stores share one event loop, including separately bundled callers.
const writerTurn = resolveGlobalSingleton(
  Symbol.for("openclaw.storeWriterTurn"),
  (): {
    started: number;
    startedAt: number;
    reset: Promise<void> | undefined;
    wait: Promise<void> | undefined;
    nativeWaitDepth: number;
  } => ({
    started: 0,
    startedAt: 0,
    reset: undefined,
    wait: undefined,
    nativeWaitDepth: 0,
  }),
);

function claimStoreWriterTurn(immediate: boolean): Promise<void> | undefined {
  const now = performance.now();
  if (!writerTurn.reset) {
    writerTurn.started = 0;
    writerTurn.startedAt = now;
    writerTurn.reset = nextTurn().then(() => {
      writerTurn.reset = undefined;
    });
  }
  // Idle first writers retain synchronous acquisition; their work still consumes the turn.
  if (
    !immediate &&
    (writerTurn.wait ||
      writerTurn.started >= MAX_WRITERS_PER_TURN ||
      now - writerTurn.startedAt >= WRITER_TURN_BUDGET_MS)
  ) {
    // The reset can precede I/O queued during this turn. Yield from exhaustion, not its start.
    return (writerTurn.wait ??= nextTurn().then(() => {
      writerTurn.wait = undefined;
    }));
  }
  writerTurn.started++;
  return undefined;
}

async function runActiveStoreWriter<T>(
  queues: StoreWriterQueues,
  storePath: string,
  fn: () => Promise<T>,
  timing?: StoreWriterTiming,
): Promise<T> {
  const writer = {
    active: true,
    native: new Set<object>(),
    hostSteps: new Set<object>(),
    parent: activeStoreWriters.getStore(),
    queues,
    storePath,
  };
  if (timing) {
    timing.reentrant = false;
    timing.startedAt = performance.now();
  }
  try {
    return await activeStoreWriters.run(writer, () => runStoreWriterHostPhase(writer, fn));
  } finally {
    if (timing) {
      timing.finishedAt = performance.now();
    }
    writer.active = false;
  }
}

function findActiveStoreWriter(queues: StoreWriterQueues, storePath: string) {
  // A new lane cannot be reentrant; bulk acquisition must not scan held owners.
  if (!queues.has(storePath)) {
    return undefined;
  }
  let writer = activeStoreWriters.getStore();
  while (writer) {
    if (writer.active && writer.queues === queues && writer.storePath === storePath) {
      return writer;
    }
    writer = writer.parent;
  }
  return undefined;
}

function assertStoreWriterHostPhase(writer: ActiveStoreWriter) {
  if (
    !writer.active ||
    writerTurn.nativeWaitDepth > 0 ||
    [...writer.native].some((operation) => !writer.hostSteps.has(operation))
  ) {
    throw new Error("Store writer host execution is not active");
  }
}

function runStoreWriterHostPhase<T>(writer: ActiveStoreWriter, run: () => T): T {
  assertStoreWriterHostPhase(writer);
  return run();
}

/** Only a normal owner continuation may resume hooks; an inherited ALS value is not this capability. */
export function captureStoreWriterHostExecution(queues: StoreWriterQueues, storePath: string) {
  const execution = captureActiveStoreWriterHostExecution(queues, storePath);
  if (!execution) {
    throw new Error("Store writer has no live host execution capability");
  }
  return execution;
}

/** Reads suspend an existing writer, but never acquire one by observing an idle lane. */
export function captureActiveStoreWriterHostExecution(
  queues: StoreWriterQueues,
  storePath: string,
) {
  const writer = findActiveStoreWriter(queues, storePath);
  if (!writer) {
    return undefined;
  }
  assertStoreWriterHostPhase(writer);
  const runInOwner = AsyncLocalStorage.snapshot();
  return {
    run<T>(run: () => T): T {
      return runInOwner(() => runStoreWriterHostPhase(writer, run));
    },
    beginNative() {
      assertStoreWriterHostPhase(writer);
      const operation = {};
      writer.native.add(operation);
      let settled = false;
      return {
        runHostStep<T>(this: void, run: () => T): T {
          if (settled || !writer.active || writerTurn.nativeWaitDepth > 0) {
            throw new Error("Native session continuation lost its original writer");
          }
          const reentrant = writer.hostSteps.has(operation);
          writer.hostSteps.add(operation);
          try {
            return runInOwner(() => runStoreWriterHostPhase(writer, run));
          } finally {
            if (!reentrant) {
              writer.hostSteps.delete(operation);
            }
          }
        },
        settle(this: void) {
          settled = true;
          writer.native.delete(operation);
        },
      };
    },
  };
}

/** Native reply service can settle fixed state, but cannot activate caller hooks or reentry. */
export function runWithStoreWriterNativeWait<T>(run: () => T): T {
  writerTurn.nativeWaitDepth += 1;
  try {
    return run();
  } finally {
    writerTurn.nativeWaitDepth -= 1;
  }
}

/** Ready calls reuse the original callback lifetime only after its native outcome was consumed. */
export function runReadyStoreWrite<T>(params: {
  queues: StoreWriterQueues;
  storePath: string;
  fn: () => T;
}): T {
  const active = findActiveStoreWriter(params.queues, params.storePath);
  if (writerTurn.nativeWaitDepth > 0) {
    throw new Error("Synchronous session work requires its live host execution owner");
  }
  if (active) {
    return runStoreWriterHostPhase(active, params.fn);
  }
  if (params.queues.has(params.storePath)) {
    throw new Error(
      "Synchronous session work requires a quiescent store; await its admitted operation",
    );
  }
  const queue = getOrCreateStoreWriterQueue(params.queues, params.storePath);
  const drain = createDeferredCore();
  queue.drainPromise = drain.promise;
  const writer: ActiveStoreWriter = {
    active: true,
    native: new Set<object>(),
    hostSteps: new Set<object>(),
    parent: activeStoreWriters.getStore(),
    queues: params.queues,
    storePath: params.storePath,
  };
  try {
    return activeStoreWriters.run(writer, () => runStoreWriterHostPhase(writer, params.fn));
  } finally {
    writer.active = false;
    queue.drainPromise = null;
    drain.resolve();
    if (queue.pending.length) {
      void drainStoreWriterQueue(params.queues, params.storePath);
    } else {
      params.queues.delete(params.storePath);
    }
  }
}

function getOrCreateStoreWriterQueue(
  queues: StoreWriterQueues,
  storePath: string,
): StoreWriterQueue {
  const existing = queues.get(storePath);
  if (existing) {
    return existing;
  }
  const created: StoreWriterQueue = { pending: [], drainPromise: null };
  queues.set(storePath, created);
  return created;
}

async function drainStoreWriterQueue(queues: StoreWriterQueues, storePath: string): Promise<void> {
  const queue = queues.get(storePath);
  if (!queue || queue.drainPromise) {
    return;
  }
  const drain = createDeferredCore();
  // Publish ownership before the first writer can enqueue more work, without
  // yielding its place to a competing lifecycle admission on an idle lane.
  queue.drainPromise = drain.promise;
  let first = true;
  try {
    while (queue.pending.length > 0) {
      let wait: Promise<void> | undefined;
      // Every resumed drain claims again; sharing only the wakeup would admit the whole herd.
      while ((wait = claimStoreWriterTurn(first))) {
        await wait;
      }
      first = false;
      const task = queue.pending.shift();
      if (!task) {
        continue;
      }
      await task.fn().then(task.resolve, task.reject);
    }
  } finally {
    queue.drainPromise = null;
    // No enqueue can interleave with this synchronous empty-queue cleanup.
    queues.delete(storePath);
    drain.resolve();
  }
}

/** Runs one store write after prior writes for the same store path have finished. */
export async function runQueuedStoreWrite<T>(params: {
  queues: StoreWriterQueues;
  storePath: string;
  label: string;
  fn: () => Promise<T>;
  reentrant?: boolean;
  timing?: StoreWriterTiming;
  /** Cancellation removes only a waiting task; admitted work must settle normally. */
  signal?: AbortSignal;
}): Promise<T> {
  if (!params.storePath || typeof params.storePath !== "string") {
    throw new Error(
      `${params.label}: storePath must be a non-empty string, got ${JSON.stringify(
        params.storePath,
      )}`,
    );
  }
  params.signal?.throwIfAborted();
  // Explicit reentrancy keeps one logical read/decide/write section on the
  // active lane; ordinary async children must queue behind the current writer.
  const active =
    params.reentrant === true ? findActiveStoreWriter(params.queues, params.storePath) : undefined;
  if (active) {
    if (params.timing) {
      params.timing.reentrant = true;
      params.timing.startedAt = performance.now();
    }
    try {
      return await runStoreWriterHostPhase(active, params.fn);
    } finally {
      if (params.timing) {
        params.timing.finishedAt = performance.now();
      }
    }
  }
  // A queued writer retains its caller's authority, never the preceding writer's
  // async context. The active-writer scope still belongs to actual execution.
  const runInAsyncContext = AsyncLocalStorage.snapshot();
  const queue = getOrCreateStoreWriterQueue(params.queues, params.storePath);
  let detach = () => {};
  const completion = new Promise<T>((resolve, reject) => {
    detach = () => params.signal?.removeEventListener("abort", abort);
    const abort = () => {
      const index = queue.pending.indexOf(task);
      if (index !== -1) {
        queue.pending.splice(index, 1);
        task.reject(params.signal?.reason);
      }
    };
    const task: StoreWriterTask = {
      fn: async () => {
        detach();
        return await runInAsyncContext(
          runActiveStoreWriter,
          params.queues,
          params.storePath,
          params.fn,
          params.timing,
        );
      },
      resolve: (value) => resolve(value as T),
      reject,
    };
    queue.pending.push(task);
    params.signal?.addEventListener("abort", abort, { once: true });
    void drainStoreWriterQueue(params.queues, params.storePath);
  });
  if (params.signal) {
    // Observe cleanup without adding a settlement hop to the writer's result.
    void completion.then(detach, detach);
  }
  return await completion;
}

/** Rejects pending queued writes and clears idle queue state for test cleanup. */
export function clearStoreWriterQueuesForTest(queues: StoreWriterQueues, message: string): void {
  for (const [storePath, queue] of queues) {
    for (const task of queue.pending) {
      task.reject(new Error(message));
    }
    queue.pending.length = 0;
    // An active writer keeps its lane; a fresh queue would admit a second writer.
    if (!queue.drainPromise) {
      queues.delete(storePath);
    }
  }
}

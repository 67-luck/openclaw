import { MessageChannel } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { createOwnedWorkerTaskPool } from "../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  withSqliteWorkerLifecycleCoordination,
  type SqliteMutationWorkerCoordination,
} from "./session-accessor.sqlite-worker-coordination.js";
import {
  createSessionReconcileHostEndpoint,
  type SessionReconcileTask,
  type SessionReconcileTaskDelegate,
} from "./session-transcript-reconcile-delegation.js";
import type {
  SessionTranscriptReconcileWorkerInput,
  SessionTranscriptReconcileWorkerMessage,
  SessionTranscriptReconcileWorkerTask,
} from "./session-transcript-reconcile.worker.js";

type ReconcilePool = ReturnType<
  typeof createOwnedWorkerTaskPool<SessionTranscriptReconcileWorkerTask, void>
>;
type ReconcileRuntime = {
  pool?: ReconcilePool;
  operations: Set<Promise<unknown>>;
  generation: number;
  stopped: boolean;
  closing?: Promise<void>;
  delegate?: SessionReconcileTaskDelegate;
  endpoints: Set<ReturnType<typeof createSessionReconcileHostEndpoint>>;
};
const MAX_WORKERS = 1;
const runtime = resolveGlobalSingleton<ReconcileRuntime>(
  Symbol.for("openclaw.sessionTranscriptReconcilePool"),
  () => ({ operations: new Set(), endpoints: new Set(), generation: 0, stopped: false }),
  () => closeSessionTranscriptReconcileWorkerPool(),
);

export type SessionTranscriptReconcileOperation = {
  signal: AbortSignal;
  readonly retirement: Promise<void> | undefined;
  retainLeaseForCleanup(
    lease: Extract<SessionTranscriptReconcileWorkerInput, { mode: "release" }>,
  ): void;
  startTask(
    input: SessionTranscriptReconcileWorkerInput,
  ): ReturnType<typeof startReconcileWorkerTask>;
};

export function captureSessionTranscriptReconcileGeneration(): number {
  return runtime.generation;
}

export function isSessionTranscriptReconcileGenerationCurrent(generation: number): boolean {
  return !runtime.stopped && generation === runtime.generation;
}

/** A data isolate delegates compute before any logical database is admitted. */
export function attachSessionTranscriptReconcileDelegate(delegate: SessionReconcileTaskDelegate) {
  if (runtime.delegate || runtime.pool || runtime.operations.size) {
    throw new Error("Transcript compute ownership is already established");
  }
  runtime.delegate = delegate;
}

export function createSessionTranscriptReconcileEndpoint() {
  const generation = runtime.generation;
  const endpoint = createSessionReconcileHostEndpoint({
    generation,
    assertCurrent() {
      if (!isSessionTranscriptReconcileGenerationCurrent(generation)) {
        throw new Error("Transcript compute endpoint belongs to a closed lifecycle");
      }
    },
    startTask(input, port, signal) {
      return resolveReconcilePool().runTask(
        { input, port },
        {
          inputBytes: 128 + input.sessionIds.reduce((bytes, id) => bytes + 2 * id.length, 0),
          transferList: (task) => [task.port],
          signal,
        },
      );
    },
  });
  runtime.endpoints.add(endpoint);
  return {
    ...endpoint,
    async close() {
      await endpoint.close();
      runtime.endpoints.delete(endpoint);
    },
  };
}

/** Track the complete owner, including parent writes and independent lease recovery. */
export function runSessionTranscriptReconcileOperation<T>(
  generation: number,
  run: (operation: SessionTranscriptReconcileOperation) => Promise<T>,
  owner?: { agentId: string; path: string },
): Promise<T> {
  if (!isSessionTranscriptReconcileGenerationCurrent(generation)) {
    return Promise.reject(new Error("Session transcript reconciliation lifecycle is closed"));
  }
  let active = true;
  const controller = new AbortController();
  let remote: ReturnType<SessionReconcileTaskDelegate["begin"]> | undefined;
  let remoteJoined = true;
  let cleanupLease: Extract<SessionTranscriptReconcileWorkerInput, { mode: "release" }> | undefined;
  let unregister: (() => void) | undefined;
  let retirement: Promise<void> | undefined;
  const completion = createDeferredCore<T>();
  const promise = completion.promise.finally(() => {
    active = false;
    runtime.operations.delete(promise);
    if (!cleanupLease && remoteJoined) {
      unregister?.();
    }
  });
  runtime.operations.add(promise);
  try {
    unregister =
      owner &&
      registerOpenClawAgentDatabaseAsyncResource(
        {
          ...owner,
          revoke: () =>
            controller.abort(new Error("Session transcript reconciliation was revoked")),
          close() {
            // Failed projection work is advisory; an unsettled native lease retains custody.
            const closing = promise
              .catch(() => {})
              .then(async () => {
                if (remote) {
                  await remote.close();
                  remoteJoined = true;
                }
                if (cleanupLease) {
                  await releaseReconcileWorkerLease(cleanupLease);
                  cleanupLease = undefined;
                  unregister?.();
                }
                if (remoteJoined && !cleanupLease) {
                  unregister?.();
                }
              });
            runtime.operations.add(closing);
            return closing.finally(() => runtime.operations.delete(closing));
          },
        },
        (attempt) => {
          retirement = attempt;
        },
      );
    if (runtime.delegate) {
      if (!owner) {
        throw new Error("Delegated transcript compute requires its logical owner");
      }
      remote = runtime.delegate.begin(owner, controller);
      remoteJoined = false;
    }
    const running = run({
      signal: controller.signal,
      get retirement() {
        return retirement;
      },
      retainLeaseForCleanup: (lease) => {
        cleanupLease ??= lease;
      },
      startTask: async (input) => {
        if (!active) {
          throw new Error("Session transcript reconciliation operation is closed");
        }
        // Native exit may require a release task after the agent owner revokes new work.
        if (input.mode !== "release") {
          controller.signal.throwIfAborted();
        }
        const task = await (remote
          ? remote.startTask(input)
          : startReconcileWorkerTask(
              input,
              input.mode === "release" ? undefined : controller.signal,
            ));
        // Only memory tasks depend on revocable source access. Accepted disk tasks
        // must drain their independent native lease before database retirement.
        if (input.mode === "memory") {
          const abort = () => task.controller.abort(controller.signal.reason);
          controller.signal.addEventListener("abort", abort, { once: true });
          if (controller.signal.aborted) {
            abort();
          }
          void task.completion
            .finally(() => controller.signal.removeEventListener("abort", abort))
            .catch(() => undefined);
        }
        return task;
      },
    });
    completion.resolve(
      (async () => {
        try {
          return await running;
        } finally {
          if (remote) {
            await remote.close();
          }
          remoteJoined = true;
        }
      })(),
    );
  } catch (error) {
    completion.reject(error);
  }
  return promise;
}

async function releaseReconcileWorkerLease(
  input: Extract<SessionTranscriptReconcileWorkerInput, { mode: "release" }>,
): Promise<void> {
  const task = await startReconcileWorkerTask(input);
  try {
    const cleanup = await task.leaseRelease;
    if (cleanup.failure) {
      throw cleanup.failure;
    }
  } finally {
    task.port.close();
    task.port.removeAllListeners();
  }
}

/** Close admission first; accepted owners may still dispatch their lease-release tasks. */
export function closeSessionTranscriptReconcileWorkerPool(): Promise<void> {
  if (runtime.closing) {
    return runtime.closing;
  }
  runtime.stopped = true;
  runtime.generation++;
  runtime.closing = Promise.resolve()
    .then(async () => {
      // Gateway endpoint drainage precedes global compute retirement; a sibling close does not.
      for (const endpoint of runtime.endpoints) {
        await endpoint.close();
        runtime.endpoints.delete(endpoint);
      }
      while (runtime.operations.size) {
        await Promise.allSettled(runtime.operations);
      }
      await runtime.pool?.close();
      runtime.pool = undefined;
      // Calls captured during close must not enter the next lifecycle either.
      runtime.generation++;
      runtime.stopped = false;
    })
    .finally(() => {
      runtime.closing = undefined;
    });
  return runtime.closing;
}

function resolveReconcilePool(): ReconcilePool {
  if (runtime.delegate) {
    throw new Error("The data owner cannot construct a projection worker");
  }
  return (runtime.pool ??= createOwnedWorkerTaskPool<SessionTranscriptReconcileWorkerTask, void>({
    workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscriptReconcile),
    workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 512 } },
    maxWorkers: MAX_WORKERS,
    // Fleet work queues small locators; the pool's byte budget bounds admission.
    maxPendingTasks: Number.MAX_SAFE_INTEGER,
  }));
}

export function getSessionTranscriptReconcileWorkerPoolSnapshot() {
  return (
    runtime.pool?.getSnapshot() ?? {
      maxWorkers: MAX_WORKERS,
      workers: 0,
      workersCreated: 0,
      activeTasks: 0,
      pendingTasks: 0,
    }
  );
}

async function startReconcileWorkerTask(
  input: SessionTranscriptReconcileWorkerInput,
  signal?: AbortSignal,
): Promise<SessionReconcileTask> {
  const owner =
    input.mode === "memory"
      ? undefined
      : {
          actorId: `transcript:${input.mode}:${input.leaseId}`,
          context: captureOpenClawStateWorkerContext({
            initializationAgentPaths: [input.path],
            env: {
              OPENCLAW_STATE_DIR: input.stateDir,
              ...(input.externallySupervised ? { OPENCLAW_SUPERVISOR_MODE: "external" } : {}),
            },
          }),
        };
  const sourceIdentity =
    input.mode === "disk" ? readDatabasePathIdentitySync(input.path).key : undefined;
  if (owner && input.mode === "disk" && owner.context.admission.identity.key.startsWith("path:")) {
    // Finish canonical first creation before publishing a task that could claim an agent lease.
    const { runOpenClawStateWorkerOperation } =
      await import("../../state/openclaw-state-worker-store.js");
    await runOpenClawStateWorkerOperation(owner.context, async () => undefined, {
      assertCurrent: () => signal?.throwIfAborted(),
    });
  }
  signal?.throwIfAborted();
  const pool = resolveReconcilePool();
  const { port1: port, port2 } = new MessageChannel();
  const controller = new AbortController();
  const closed = new Promise<void>((resolve) => {
    port.once("close", resolve);
  });
  let released = false;
  let releaseFailed = false;
  let failure: Error | undefined;
  port.on("message", (message: SessionTranscriptReconcileWorkerMessage) => {
    if (message.type === "lease-released") {
      released = true;
    } else if (message.type === "lease-release-failed") {
      releaseFailed = true;
      failure = new Error(message.error);
    }
  });
  const inputBytes =
    128 +
    (owner
      ? 2 *
        (owner.actorId.length +
          owner.context.admission.databasePath.length +
          owner.context.environment.OPENCLAW_STATE_DIR.length)
      : 0) +
    (input.mode === "memory"
      ? input.sessionIds.reduce((bytes, id) => bytes + 2 * id.length, 0)
      : 2 * (input.stateDir.length + input.leaseId.length + input.path.length) +
        (input.mode === "disk" ? 2 * input.agentId.length : 0));
  let poolCompletion: Promise<void> | undefined;
  const execute = async (coordination?: SqliteMutationWorkerCoordination) => {
    poolCompletion = pool.run(
      {
        input,
        port: port2,
        coordination,
        sourceIdentity,
      },
      {
        inputBytes,
        transferList: (task) => [
          task.port,
          ...(task.coordination?.reconciliation
            ? [task.coordination.reconciliation.admission]
            : []),
        ],
        signal: controller.signal,
      },
    );
    try {
      await poolCompletion;
    } finally {
      port2.close();
      await closed;
    }
  };
  const completion = (
    !owner
      ? execute()
      : withSqliteWorkerLifecycleCoordination(
          owner.context,
          owner.actorId,
          execute,
          async () => {
            controller.abort();
            await poolCompletion?.catch(() => {});
            port2.close();
            await closed;
          },
          "reconciliation",
        )
  ).finally(() => port2.close());
  const leaseRelease = Promise.allSettled([completion, closed]).then(([result]) => {
    if (result.status === "rejected") {
      failure ??= toStringifiedError(result.reason);
    }
    if (!released) {
      failure ??= new Error("transcript worker task closed before lease release");
    }
    return { released, releaseFailed, failure };
  });
  return { port, controller, completion, closed, leaseRelease };
}

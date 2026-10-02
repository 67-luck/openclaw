// Transcript projection reconciliation owner. Gateway startup awaits it;
// Request paths schedule it and may wait boundedly for their session's projection.
// Native timers keep accepted work runnable after a caller replaces its timer globals.
import path from "node:path";
import { setImmediate as yieldToGateway, setTimeout as delay } from "node:timers/promises";
import { computeBackoffSchedule } from "../../../packages/retry/src/index.js";
import { createAbortError, racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { throwSqliteLifecycleErrors } from "../../infra/sqlite-lifecycle-errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readOpenClawAgentDatabaseOwnerEnvironment } from "../../state/openclaw-agent-db-lifecycle.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  AgentDatabaseResourceAdmissionError,
  captureAgentDatabaseCloseFence,
} from "../../state/openclaw-agent-db-resources.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  isIncognitoOpenClawAgentDatabase,
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
  type OpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { resolveStateDir } from "../paths.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";
import {
  reconcilePreparedTranscriptIndexes,
  type SessionTranscriptReconcileResult,
} from "./session-transcript-projection-writer.js";
import { createMemoryTranscriptProjectionSource } from "./session-transcript-reconcile-memory.js";
import {
  captureSessionTranscriptReconcileGeneration,
  isSessionTranscriptReconcileGenerationCurrent,
  runSessionTranscriptReconcileOperation,
  type SessionTranscriptReconcileOperation,
} from "./session-transcript-reconcile-pool.js";

const log = createSubsystemLogger("sessions/transcript-index");
const PROJECTION_READY_POLL_MS = 10;
// Repeated pending passes can keep respawning workers for a contended snapshot.
// Do not reset on aggregate progress: other sessions may finish while it races.
// Zero preserves one immediate retry; ready targets poll independently.
const RECONCILE_RETRY_BACKOFF_MS: readonly number[] = [0, 50, 200, 500, 1_000];

type RunningReconcile = {
  key: string;
  generation: number;
  ownerStateDir: string;
  pending?: ScheduledReconcileRequest;
  assertCurrent?: () => void;
  release(request: ScheduledReconcileRequest): void;
  signal?: AbortSignal;
  promise?: Promise<SessionTranscriptReconcileResult>;
};

const runningReconciles = new Map<string, RunningReconcile>();
// Admission can move to a successor before the original borrow finishes releasing.
// Maintenance must still join every accepted owner, not just the latest map slot.
const acceptedReconciles = new Set<RunningReconcile>();

export type { SessionTranscriptReconcileResult } from "./session-transcript-projection-writer.js";

type SessionTranscriptReconcileParams = OpenClawAgentDatabaseOptions & {
  preferredSessionId?: string;
};

type PreparedReconcileParams = SessionTranscriptReconcileParams & {
  env: NodeJS.ProcessEnv;
  path: string;
  generation: number;
};
type ScheduledReconcileRequest = {
  params: PreparedReconcileParams;
  memory: ReturnType<typeof captureMemorySource>;
  execution?: OpenClawAgentDatabaseExecution;
  assertCurrent(this: void): void;
  release(): Promise<void>;
};

function prepareReconcileParams(params: SessionTranscriptReconcileParams): PreparedReconcileParams {
  const env = { ...(params.env ?? process.env) };
  // Resolve the physical path before adopting a cached owner's state root.
  // Reinterpreting a relative caller path under that owner could select another database.
  const databasePath = resolveOpenClawAgentSqlitePath({ ...params, env });
  const database = getOpenClawAgentDatabaseIfOpen({ ...params, env, path: databasePath });
  return {
    ...params,
    path: databasePath,
    env: database ? readOpenClawAgentDatabaseOwnerEnvironment(database) : env,
    generation: captureSessionTranscriptReconcileGeneration(),
  };
}

function reconcileKey(params: OpenClawAgentDatabaseOptions): string {
  return resolveOpenClawAgentSqlitePath(params);
}

function captureMemorySource(params: OpenClawAgentDatabaseOptions) {
  const database = getOpenClawAgentDatabaseIfOpen(params);
  return database && isIncognitoOpenClawAgentDatabase(database)
    ? {
        database,
        source: createMemoryTranscriptProjectionSource(database, {
          ...params,
          path: database.path,
        }),
      }
    : undefined;
}

function captureReconcileRequest(params: PreparedReconcileParams): ScheduledReconcileRequest {
  const memory = captureMemorySource(params);
  const volatile = isIncognitoOpenClawAgentSqlitePath(reconcileKey(params), params);
  if (volatile && !memory) {
    throw new Error(
      "Incognito transcript reconciliation requires its original live native database",
    );
  }
  const execution =
    !memory && supportsOpenClawAgentDatabaseExecution(params)
      ? captureOpenClawAgentDatabaseExecution(params)
      : undefined;
  let released: Promise<void> | undefined;
  return {
    params,
    memory,
    execution,
    assertCurrent() {
      memory?.source.assertCurrentOwner();
      execution?.assertCurrent();
    },
    release() {
      return (released ??= (async () => {
        await execution?.release();
      })());
    },
  };
}

function sameReconcileOwner(left: ScheduledReconcileRequest, right: ScheduledReconcileRequest) {
  return (
    left.memory?.database === right.memory?.database &&
    left.execution?.binding.incarnation === right.execution?.binding.incarnation
  );
}

/** Prepares full trees off-thread, then commits bounded chunks through the runtime writer owner. */
export async function reconcileSessionTranscriptIndexes(
  params: SessionTranscriptReconcileParams,
): Promise<SessionTranscriptReconcileResult> {
  const prepared = prepareReconcileParams(params);
  const request = captureReconcileRequest(prepared);
  try {
    return await runSessionTranscriptReconcileOperation(
      prepared.generation,
      (operation) =>
        reconcilePreparedTranscriptIndexes(
          prepared,
          operation,
          request.memory?.source,
          request.execution,
        ),
      { agentId: prepared.agentId, path: reconcileKey(prepared) },
    );
  } finally {
    await request.release();
  }
}

/** Starts one deferred reconcile. No transcript rows are read on the caller's stack. */
export function startSessionTranscriptIndexReconcile(
  input: SessionTranscriptReconcileParams,
): void {
  startPreparedSessionTranscriptIndexReconcile(prepareReconcileParams(input));
}

function startPreparedSessionTranscriptIndexReconcile(params: PreparedReconcileParams): void {
  if (!isSessionTranscriptReconcileGenerationCurrent(params.generation)) {
    return;
  }
  const reportFailure = (error: unknown) => {
    log.warn(
      `session transcript reconcile failed agent=${params.agentId} error=${formatErrorMessage(error)}`,
    );
  };
  const key = reconcileKey(params);
  let request: ScheduledReconcileRequest;
  try {
    // Capture both the native source and durable borrow before any coalescing or yield.
    request = captureReconcileRequest(params);
  } catch (error) {
    // Post-commit scheduling records refusal without turning committed work into a retry.
    reportFailure(error);
    return;
  }
  const running = runningReconciles.get(key);
  if (running) {
    if (running.generation === params.generation) {
      if (running.pending) {
        running.release(running.pending);
      }
      running.pending = request;
    } else {
      running.release(request);
    }
    return;
  }
  const releases = new Set<Promise<void>>();
  let releaseFailure: { error: unknown } | undefined;
  const state: RunningReconcile = {
    key,
    generation: params.generation,
    ownerStateDir: path.resolve(resolveStateDir(params.env)),
    assertCurrent: request.assertCurrent,
    release(retired) {
      const releasing = retired.release().then(
        () => {
          releases.delete(releasing);
        },
        (error: unknown) => {
          releases.delete(releasing);
          releaseFailure ??= { error };
        },
      );
      releases.add(releasing);
    },
  };
  runningReconciles.set(key, state);
  acceptedReconciles.add(state);
  const pending = (async () => {
    let current = request;
    let reconciledSessions = 0;
    const failures: unknown[] = [];
    try {
      while (isSessionTranscriptReconcileGenerationCurrent(current.params.generation)) {
        current.assertCurrent();
        state.assertCurrent = current.assertCurrent;
        let operation: SessionTranscriptReconcileOperation | undefined;
        try {
          await runSessionTranscriptReconcileOperation(
            current.params.generation,
            async (owner) => {
              operation = owner;
              state.signal = owner.signal;
              await yieldToGateway();
              let retryCount = 0;
              while (true) {
                owner.signal.throwIfAborted();
                current.assertCurrent();
                const result = await reconcilePreparedTranscriptIndexes(
                  current.params,
                  owner,
                  current.memory?.source,
                  current.execution,
                );
                reconciledSessions += result.reconciledSessions;
                const next = state.pending;
                if (!next || !sameReconcileOwner(current, next)) {
                  return;
                }
                state.pending = undefined;
                await current.release();
                current = next;
                state.assertCurrent = current.assertCurrent;
                await delay(computeBackoffSchedule(RECONCILE_RETRY_BACKOFF_MS, ++retryCount));
              }
            },
            { agentId: current.params.agentId, path: key },
          );
        } catch (error) {
          if (
            !operation &&
            current.memory &&
            error instanceof AgentDatabaseResourceAdmissionError &&
            error.retirements
          ) {
            // Registration refused before work started. Join only its captured blockers;
            // a pending successor already owns its own facts and is never rediscovered.
            await Promise.all(error.retirements);
            if (state.pending) {
              if (!state.pending.memory) {
                break;
              }
              const next = state.pending;
              state.pending = undefined;
              await current.release();
              current = next;
            }
            continue;
          }
          reportFailure(error);
        }
        // Native resource close joins the operation, not this scheduler. Hold its
        // map slot through retirement so the old request cannot drain successor demand.
        await operation?.retirement;
        const next = state.pending;
        state.pending = undefined;
        if (
          !operation ||
          !next ||
          (operation.signal.aborted && sameReconcileOwner(current, next))
        ) {
          if (next) {
            state.release(next);
          }
          break;
        }
        await current.release();
        current = next;
      }
    } catch (error) {
      failures.push(error);
    } finally {
      // Remove the slot without a yield after the final pending check. New demand
      // owns a new scheduler; this owner still joins every discarded borrow.
      if (runningReconciles.get(key) === state) {
        runningReconciles.delete(key);
      }
      state.release(current);
      if (state.pending) {
        state.release(state.pending);
        state.pending = undefined;
      }
      await Promise.all(releases);
    }
    if (releaseFailure && !failures.includes(releaseFailure.error)) {
      failures.push(releaseFailure.error);
    }
    throwSqliteLifecycleErrors(failures, "Transcript reconciliation and release failed");
    return { reconciledSessions };
  })()
    .catch((error: unknown) => {
      reportFailure(error);
      return { reconciledSessions: 0 };
    })
    .finally(() => {
      if (runningReconciles.get(key) === state) {
        runningReconciles.delete(key);
      }
      acceptedReconciles.delete(state);
    });
  state.promise = pending;
}

export function isSessionTranscriptIndexReconcileRunning(
  params: OpenClawAgentDatabaseOptions,
): boolean {
  const key = reconcileKey(params);
  return [...acceptedReconciles].some((owner) => owner.key === key);
}

/** Test and maintenance wait hook for an already-scheduled reconcile. */
export async function waitForSessionTranscriptIndexReconcile(
  params: OpenClawAgentDatabaseOptions,
): Promise<void> {
  const key = reconcileKey(params);
  while (true) {
    const owners = [...acceptedReconciles]
      .filter((owner) => owner.key === key)
      .flatMap((owner) => (owner.promise ? [owner.promise] : []));
    if (owners.length === 0) {
      return;
    }
    await Promise.all(owners);
  }
}

/** Test and maintenance drain for scheduled reconciles owned by one state directory. */
export async function waitForSessionTranscriptIndexReconcilesInStateDir(
  stateDir: string,
): Promise<void> {
  const ownerStateDir = path.resolve(stateDir);
  while (true) {
    const owners = [...acceptedReconciles]
      .filter((owner) => owner.ownerStateDir === ownerStateDir)
      .flatMap((owner) => (owner.promise ? [owner.promise] : []));
    if (owners.length === 0) {
      return;
    }
    // Handoffs and other fixture databases may register owners while this batch settles.
    await Promise.all(owners);
  }
}

/** Waits only until the requested session's scheduled projection rebuild settles. */
export async function waitForSessionTranscriptProjection(
  scope: SessionTranscriptReadScope,
  abortSignal?: AbortSignal,
): Promise<void> {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const databaseOptions = prepareReconcileParams(toDatabaseOptions(resolved));
  const key = reconcileKey(databaseOptions);
  let running = runningReconciles.get(key);
  if (!running) {
    return;
  }
  let needsReconcile: () => Promise<boolean>;
  if (
    !isIncognitoOpenClawAgentSqlitePath(key, databaseOptions) &&
    supportsOpenClawAgentDatabaseExecution(databaseOptions)
  ) {
    let runtime: Promise<typeof import("./session-transcript-worker-runtime.js")> | undefined;
    needsReconcile = async () => {
      const closing = captureAgentDatabaseCloseFence({
        agentId: databaseOptions.agentId,
        path: key,
      });
      if (closing) {
        await racePromiseWithAbortSignal(closing, abortSignal);
        if (!isSessionTranscriptReconcileGenerationCurrent(databaseOptions.generation)) {
          return false;
        }
      }
      const execution = captureOpenClawAgentDatabaseExecution(databaseOptions);
      try {
        const { withSessionHistoryWorkerDatabase } = await (runtime ??=
          import("./session-transcript-worker-runtime.js"));
        execution.assertCurrent();
        return await withSessionHistoryWorkerDatabase(databaseOptions, (owner) =>
          owner.readProjectionStatus(
            { env: databaseOptions.env, sessionId: resolved.sessionId },
            abortSignal,
          ),
        );
      } finally {
        await execution.release();
      }
    };
  } else {
    needsReconcile = async () => {
      const pending = withOpenClawAgentDatabaseReadOnly(
        ({ db }) => sessionTranscriptIndexNeedsReconcile(db, resolved.sessionId),
        databaseOptions,
      );
      return pending.found && pending.value;
    };
  }
  try {
    while (running) {
      abortSignal?.throwIfAborted();
      // Revoked work retains its close fence until settlement. Do not admit a reader
      // or recreate a disposed incognito owner while that fence is held.
      if (!running.signal?.aborted) {
        running.assertCurrent?.();
        if (!(await needsReconcile())) {
          return;
        }
      }
      await delay(
        PROJECTION_READY_POLL_MS,
        undefined,
        abortSignal ? { signal: abortSignal } : undefined,
      );
      if (
        !runningReconciles.has(key) &&
        running.signal?.aborted &&
        !isIncognitoOpenClawAgentSqlitePath(key, databaseOptions) &&
        isSessionTranscriptReconcileGenerationCurrent(running.generation) &&
        (await needsReconcile())
      ) {
        // Re-admit through the existing owner after cache turnover, within the same lifecycle.
        startPreparedSessionTranscriptIndexReconcile({
          ...databaseOptions,
          generation: running.generation,
          preferredSessionId: resolved.sessionId,
        });
      }
      running = runningReconciles.get(key);
    }
  } catch (error) {
    // Worker reads settle before exposing the same cancellation shape as polling.
    if (abortSignal?.aborted && error === abortSignal.reason) {
      throw createAbortError("Operation aborted", { cause: error });
    }
    throw error;
  }
}

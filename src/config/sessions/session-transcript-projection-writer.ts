import { randomInt, randomUUID } from "node:crypto";
import { setImmediate as yieldToGateway } from "node:timers/promises";
import type { MessagePort } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { isGatewayExternallySupervised } from "../../infra/gateway-supervision.js";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-contract.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  borrowOpenClawAgentDatabase,
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
  isIncognitoOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseAsync,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import {
  openOpenClawAgentSqliteWorkerStore,
  type OpenClawAgentSqliteWorkerStore,
} from "../../state/openclaw-agent-worker-store.js";
import { resolveStateDir } from "../paths.js";
import {
  getSessionKysely,
  runExclusiveSqliteSessionWrite,
} from "./session-accessor.sqlite-scope.js";
import type { SqliteSessionWriteOperation } from "./session-accessor.sqlite-write-operation.js";
import {
  deleteOrphanedTranscriptIndexRowsInTransaction,
  hasOrphanedTranscriptIndexRows,
  hasSessionsNeedingTranscriptIndexReconcile,
  listSessionsNeedingTranscriptIndexReconcile,
} from "./session-transcript-index.js";
import type { TranscriptProjectionPublicationOperations } from "./session-transcript-projection-publication.worker.js";
import {
  appendPreparedSessionTranscriptProjectionChunkInTransaction,
  claimPreparedSessionTranscriptProjectionInTransaction,
  deletePreparedSessionTranscriptProjectionChunkInTransaction,
  finalizePreparedSessionTranscriptProjectionInTransaction,
  type PreparedSessionTranscriptProjectionMetadata,
} from "./session-transcript-projection-rebuild.js";
import type { MemoryTranscriptProjectionSource } from "./session-transcript-reconcile-memory.js";
import type { SessionTranscriptReconcileOperation } from "./session-transcript-reconcile-pool.js";
import type {
  EncodedTranscriptFtsChunk,
  SessionTranscriptReconcileWorkerInput,
  SessionTranscriptReconcileWorkerMessage,
} from "./session-transcript-reconcile.worker.js";

export type SessionTranscriptReconcileResult = {
  reconciledSessions: number;
};

const PROJECTION_WRITE_CHUNK_ROWS = 512;
export type ReconcileDatabaseOptions = OpenClawAgentDatabaseOptions & {
  env: NodeJS.ProcessEnv;
  path: string;
};
export type ProjectionPublisher = Pick<
  SqliteWorkerStore<TranscriptProjectionPublicationOperations>,
  "execute"
>;
export type ActivePreparedProjection = {
  claimId: number;
  plan: PreparedSessionTranscriptProjectionMetadata;
};
function nextProjectionClaimId(): number {
  return -randomInt(1, 2 ** 47);
}

export async function runProjectionWrite<T>(
  databaseOptions: ReconcileDatabaseOptions,
  operationLabel: Extract<SqliteSessionWriteOperation, `sessions.transcript-index.${string}`>,
  operation: (database: OpenClawAgentDatabase) => T,
  memorySource?: MemoryTranscriptProjectionSource,
): Promise<T> {
  return await runExclusiveSqliteSessionWrite(
    databaseOptions,
    async () => {
      const write = () => {
        // Disposal revokes a memory source. Check inside the queue before the opener
        // can materialize a successor database for a late worker result.
        memorySource?.assertCurrentOwner();
        return runOpenClawAgentWriteTransaction(operation, databaseOptions, { operationLabel });
      };
      return !isIncognitoOpenClawAgentSqlitePath(databaseOptions.path, databaseOptions) &&
        !getOpenClawAgentDatabaseIfOpen(databaseOptions)
        ? withOpenClawAgentDatabaseAsync(databaseOptions, write)
        : write();
    },
    operationLabel,
  );
}

export async function claimPreparedSessionTranscriptProjection(
  databaseOptions: ReconcileDatabaseOptions,
  plan: PreparedSessionTranscriptProjectionMetadata,
  memorySource?: MemoryTranscriptProjectionSource,
  publication?: ProjectionPublisher,
): Promise<ActivePreparedProjection | undefined> {
  const claimId = nextProjectionClaimId();
  const claimed = publication
    ? await publication.execute({ type: "claim", input: { plan, claimId } })
    : await runProjectionWrite(
        databaseOptions,
        "sessions.transcript-index.claim",
        (database) =>
          (!memorySource || memorySource.isCurrentPlan(plan)) &&
          claimPreparedSessionTranscriptProjectionInTransaction(database.db, plan, claimId),
        memorySource,
      );
  if (!claimed) {
    return undefined;
  }

  let deleteResult = { hasMore: true, owned: true };
  while (deleteResult.hasMore && deleteResult.owned) {
    deleteResult = publication
      ? await publication.execute({
          type: "deleteChunk",
          input: {
            maxRowsPerTable: PROJECTION_WRITE_CHUNK_ROWS,
            sessionId: plan.sessionId,
            claimId,
          },
        })
      : await runProjectionWrite(
          databaseOptions,
          "sessions.transcript-index.delete-chunk",
          (database) =>
            deletePreparedSessionTranscriptProjectionChunkInTransaction(database.db, {
              maxRowsPerTable: PROJECTION_WRITE_CHUNK_ROWS,
              sessionId: plan.sessionId,
              claimId,
            }),
          memorySource,
        );
    await yieldToGateway();
  }
  if (!deleteResult.owned) {
    return undefined;
  }
  return { claimId, plan };
}

export async function appendPreparedProjectionChunk(
  databaseOptions: ReconcileDatabaseOptions,
  active: ActivePreparedProjection,
  rows:
    | {
        activeRows: Parameters<
          typeof appendPreparedSessionTranscriptProjectionChunkInTransaction
        >[1]["activeRows"];
      }
    | {
        ftsRows: Parameters<
          typeof appendPreparedSessionTranscriptProjectionChunkInTransaction
        >[1]["ftsRows"];
      },
  memorySource?: MemoryTranscriptProjectionSource,
  publication?: ProjectionPublisher,
): Promise<boolean> {
  const owned = publication
    ? await publication.execute({
        type: "appendChunk",
        input: {
          ...rows,
          claimId: active.claimId,
          sessionId: active.plan.sessionId,
        },
      })
    : await runProjectionWrite(
        databaseOptions,
        "activeRows" in rows
          ? "sessions.transcript-index.active-chunk"
          : "sessions.transcript-index.fts-chunk",
        (database) =>
          appendPreparedSessionTranscriptProjectionChunkInTransaction(database.db, {
            ...rows,
            claimId: active.claimId,
            sessionId: active.plan.sessionId,
          }),
        memorySource,
      );
  await yieldToGateway();
  return owned;
}

export async function finalizePreparedProjection(
  databaseOptions: ReconcileDatabaseOptions,
  active: ActivePreparedProjection,
  memorySource?: MemoryTranscriptProjectionSource,
  publication?: ProjectionPublisher,
): Promise<boolean> {
  if (publication) {
    const result = await publication.execute({ type: "finalize", input: active });
    if (result.sessionKey !== undefined) {
      sessionChanges.emit({
        storePath: databaseOptions.path,
        sessionKey: result.sessionKey,
        facts: { kind: "unchanged" },
      });
    }
    return result.finalized;
  }
  return await runProjectionWrite(
    databaseOptions,
    "sessions.transcript-index.finalize",
    (database) => {
      const finalized =
        (!memorySource || memorySource.isCurrentPlan(active.plan)) &&
        finalizePreparedSessionTranscriptProjectionInTransaction(
          database.db,
          active.plan,
          active.claimId,
        );
      const session =
        finalized &&
        executeSqliteQueryTakeFirstSync(
          database.db,
          getSessionKysely(database.db)
            .selectFrom("session_windows")
            .select("session_key")
            .where("session_id", "=", active.plan.sessionId),
        );
      if (session) {
        sessionChanges.emit(
          {
            storePath: database.path,
            sessionKey: session.session_key,
            facts: { kind: "unchanged" },
          },
          database.db,
        );
      }
      return finalized;
    },
    memorySource,
  );
}

// Node Worker messages take a transfer list, unlike Window.postMessage.
// Keep the empty list explicit so the platform contract stays unambiguous.
function continueProjectionWorker(worker: MessagePort, accepted: boolean): void {
  worker.postMessage({ accepted, type: "continue" }, []);
}

function decodeFtsChunk(chunk: EncodedTranscriptFtsChunk) {
  const decoder = new TextDecoder();
  return chunk.rows.map((row) => ({
    messageId: row.messageId,
    role: row.role,
    text: decoder.decode(
      chunk.textBytes.subarray(row.textByteOffset, row.textByteOffset + row.textByteLength),
    ),
    timestamp: row.timestamp,
  }));
}

export async function reconcilePreparedTranscriptIndexes(
  params: ReconcileDatabaseOptions & { preferredSessionId?: string },
  operation: SessionTranscriptReconcileOperation,
  memorySource?: MemoryTranscriptProjectionSource,
  execution?: OpenClawAgentDatabaseExecution,
): Promise<SessionTranscriptReconcileResult> {
  operation.signal.throwIfAborted();
  const databasePath = resolveOpenClawAgentSqlitePath(params);
  const databaseOptions: ReconcileDatabaseOptions = {
    agentId: params.agentId,
    env: params.env,
    path: databasePath,
  };
  let publicationClient:
    | OpenClawAgentSqliteWorkerStore<TranscriptProjectionPublicationOperations>
    | undefined;
  let publication: ProjectionPublisher | undefined;
  let releaseDatabase: (() => void) | undefined;
  let memorySessionIds: string[] = [];
  try {
    if (execution) {
      const { withSessionHistoryWorkerDatabase } =
        await import("./session-transcript-worker-runtime.js");
      execution.assertCurrent();
      const pending = await runExclusiveSqliteSessionWrite(
        databaseOptions,
        async () => {
          execution.assertCurrent();
          return await withSessionHistoryWorkerDatabase(databaseOptions, (owner) =>
            owner.readProjectionStatus({ env: params.env }, operation.signal),
          ).catch(() => true);
        },
        "sessions.transcript-index.preflight",
      );
      execution.assertCurrent();
      if (!pending) {
        return { reconciledSessions: 0 };
      }
      operation.signal.throwIfAborted();
      const client =
        await openOpenClawAgentSqliteWorkerStore<TranscriptProjectionPublicationOperations>(
          databaseOptions,
          { execution },
          {
            moduleUrl: resolveRuntimeWorkerUrl(
              runtimeProcessEntrypoints.sessionTranscriptProjectionPublication,
            ),
            input: undefined,
          },
        );
      publicationClient = client;
      publication = {
        execute: (command) =>
          client.execute(command, () => {
            operation.signal.throwIfAborted();
            execution.assertCurrent();
          }),
      };
      if (!(await publication.execute({ type: "preflight", input: undefined }))) {
        return { reconciledSessions: 0 };
      }
    } else {
      if (!memorySource) {
        const clean = await runExclusiveSqliteSessionWrite(
          databaseOptions,
          async () => {
            try {
              const pending = withOpenClawAgentDatabaseReadOnly(
                ({ db }) =>
                  runSqliteDeferredTransactionSync(
                    db,
                    () =>
                      hasSessionsNeedingTranscriptIndexReconcile(db) ||
                      hasOrphanedTranscriptIndexRows(db),
                  ),
                databaseOptions,
              );
              return pending.found && !pending.value;
            } catch {
              // Preserve the writable owner's repair and integrity refusal for uncertain reads.
              return false;
            }
          },
          "sessions.transcript-index.preflight",
        );
        if (clean) {
          return { reconciledSessions: 0 };
        }
      }
      operation.signal.throwIfAborted();
      // Recheck under write admission: a request may commit after the read-only probe.
      // Keep the post-worker orphan sweep for writers racing projection publication.
      await runProjectionWrite(
        databaseOptions,
        "sessions.transcript-index.preflight",
        (database) => {
          deleteOrphanedTranscriptIndexRowsInTransaction(database.db);
          const sessionIds = listSessionsNeedingTranscriptIndexReconcile(database.db);
          if (sessionIds.length > 0) {
            // Retain this verified handle across worker awaits; explicit disposal still revokes it.
            releaseDatabase = borrowOpenClawAgentDatabase(databaseOptions).release;
            if (memorySource) {
              const preferred = params.preferredSessionId;
              memorySessionIds =
                preferred && sessionIds.includes(preferred)
                  ? [preferred, ...sessionIds.filter((sessionId) => sessionId !== preferred)]
                  : sessionIds;
            }
          }
        },
        memorySource,
      );
      if (!releaseDatabase) {
        return { reconciledSessions: 0 };
      }
    }
    const input: SessionTranscriptReconcileWorkerInput = memorySource
      ? { mode: "memory", sessionIds: memorySessionIds }
      : {
          mode: "disk",
          leaseId: randomUUID(),
          agentId: params.agentId,
          path: databasePath,
          stateDir: resolveStateDir(params.env),
          externallySupervised: isGatewayExternallySupervised(params.env),
          ...(params.preferredSessionId ? { preferredSessionId: params.preferredSessionId } : {}),
        };
    const task = await operation.startTask(input);
    const worker = task.port;
    let handlingMessage: Promise<void> | undefined;
    let terminalReceived = false;
    let outcome: Result<SessionTranscriptReconcileResult, unknown>;
    try {
      if (memorySource) {
        // Task production can yield. Recheck the original memory owner before
        // handling its first message, but still join this exact task on refusal.
        operation.signal.throwIfAborted();
        memorySource.assertCurrentOwner();
      }
      const value = await new Promise<SessionTranscriptReconcileResult>((resolve, reject) => {
        let active: ActivePreparedProjection | undefined;
        let reconciledSessions = 0;
        let settled = false;
        const settle = (finish: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          finish();
        };
        const handleMessage = async (
          message: Exclude<
            SessionTranscriptReconcileWorkerMessage,
            { type: "lease-released" | "lease-release-failed" }
          >,
        ) => {
          if (message.type === "failed") {
            terminalReceived = true;
            settle(() => reject(new Error(message.error)));
            return;
          }
          if (message.type === "done") {
            terminalReceived = true;
            if (active) {
              settle(() => reject(new Error("session transcript reconcile worker ended mid-plan")));
              return;
            }
            try {
              if (publication) {
                // Finalized receipts survive retirement before new cleanup admission.
                // A later preflight still detects and removes derived orphan rows.
                if (!operation.signal.aborted) {
                  await publication.execute({ type: "sweep", input: undefined });
                }
              } else {
                await runProjectionWrite(
                  databaseOptions,
                  "sessions.transcript-index.orphan-sweep",
                  (database) => deleteOrphanedTranscriptIndexRowsInTransaction(database.db),
                  memorySource,
                );
              }
            } catch (error) {
              settle(() => reject(toStringifiedError(error)));
              return;
            }
            settle(() => resolve({ reconciledSessions }));
            return;
          }
          try {
            if (message.type === "source-read") {
              if (!memorySource || !memorySessionIds.includes(message.sessionId)) {
                throw new Error("session transcript worker requested an unavailable memory source");
              }
              const frame = memorySource.read(message.sessionId);
              await yieldToGateway();
              worker.postMessage(frame, frame.type === "source-frame" ? [frame.bytes.buffer] : []);
              return;
            }
            if (message.type === "plan-start") {
              if (active) {
                throw new Error("session transcript reconcile worker started overlapping plans");
              }
              active = await claimPreparedSessionTranscriptProjection(
                databaseOptions,
                message.plan,
                memorySource,
                publication,
              );
              continueProjectionWorker(worker, active !== undefined);
              return;
            }
            if (!active || active.plan.sessionId !== message.sessionId) {
              throw new Error(
                "session transcript reconcile worker sent a chunk for no active plan",
              );
            }
            if (message.type === "plan-finish") {
              const finalized = await finalizePreparedProjection(
                databaseOptions,
                active,
                memorySource,
                publication,
              );
              active = undefined;
              if (finalized) {
                reconciledSessions += 1;
              }
              continueProjectionWorker(worker, finalized);
              return;
            }
            const owned = await appendPreparedProjectionChunk(
              databaseOptions,
              active,
              message.type === "active-chunk"
                ? { activeRows: message.rows }
                : { ftsRows: decodeFtsChunk(message.chunk) },
              memorySource,
              publication,
            );
            if (!owned) {
              active = undefined;
            }
            continueProjectionWorker(worker, owned);
          } catch (error) {
            settle(() => reject(toStringifiedError(error)));
          }
        };
        worker.on("message", (message: SessionTranscriptReconcileWorkerMessage) => {
          if (
            settled ||
            message.type === "lease-released" ||
            message.type === "lease-release-failed"
          ) {
            return;
          }
          handlingMessage = handleMessage(message);
        });
        worker.once("messageerror", (error) => {
          settle(() => reject(toStringifiedError(error)));
        });
        void task.completion.then(
          async () => {
            // Port closure follows its queued messages, unlike the pool's separate result port.
            await task.closed;
            if (!terminalReceived) {
              settle(() =>
                reject(new Error("session transcript worker task ended without a result")),
              );
            }
          },
          (error: unknown) => settle(() => reject(toStringifiedError(error))),
        );
      });
      outcome = ok(value);
    } catch (error) {
      outcome = err(error);
    }
    let plannerFailure: Error | undefined;
    try {
      if (!terminalReceived) {
        task.controller.abort();
      }
      // A handler may initiate settlement. Join it here, outside that handler, before releasing
      // the independent lease; native exit and cleanup messages must not replace this task.
      await handlingMessage;
      if (input.mode === "disk" && terminalReceived) {
        worker.postMessage({ type: "release" }, []);
      }
      const plannerRelease = await task.leaseRelease;
      if (input.mode === "disk") {
        let cleanup = plannerRelease;
        if (!cleanup.released && !cleanup.releaseFailed) {
          const releaseTask = await operation.startTask({
            mode: "release",
            leaseId: input.leaseId,
            path: input.path,
            stateDir: input.stateDir,
            externallySupervised: input.externallySupervised,
          });
          try {
            cleanup = await releaseTask.leaseRelease;
          } finally {
            releaseTask.port.close();
            releaseTask.port.removeAllListeners();
          }
        }
        if (cleanup.failure) {
          throw cleanup.failure;
        }
        if (outcome.ok && plannerRelease.failure) {
          plannerFailure = plannerRelease.failure;
        }
      }
    } catch (error) {
      const failure = new Error(
        `Transcript lease cleanup incomplete; restart OpenClaw before deleting this agent: ${toStringifiedError(error).message}`,
        { cause: error },
      );
      if (input.mode === "disk") {
        operation.retainLeaseForCleanup({
          mode: "release",
          leaseId: input.leaseId,
          path: input.path,
          stateDir: input.stateDir,
          externallySupervised: input.externallySupervised,
        });
      }
      throw outcome.ok
        ? failure
        : new AggregateError([outcome.error, failure], failure.message, { cause: failure });
    } finally {
      worker.close();
      worker.removeAllListeners();
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    if (plannerFailure) {
      throw plannerFailure;
    }
    return outcome.value;
  } finally {
    memorySource?.clear();
    releaseDatabase?.();
    await publicationClient?.close();
  }
}

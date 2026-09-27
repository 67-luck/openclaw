import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import { publishCommittedSessionIdentity } from "../../config/sessions/session-accessor.sqlite-identity.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { startSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import {
  sameSessionTranscriptTargetBinding,
  sessionTranscriptExecution,
} from "../../config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "../../config/sessions/transcript-write-context.js";
import { runInDetachedAsyncContext } from "../../shared/async-work-scope.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../../state/openclaw-state-worker-error.js";
import { createSessionManagerMessageRuntime } from "./session-manager-message-runtime.js";
import type { SessionMetadataWorkerOperations } from "./session-manager-metadata-contract.js";
import {
  SessionManagerPersistence,
  isSqliteTranscriptMutationConflict,
  type PersistRecordResult,
} from "./session-manager-persistence.js";
import type { ModelChangeEntry, ThinkingLevelChangeEntry } from "./session-manager-types.js";
import type {
  PreparedSessionTranscriptReload,
  SessionManagerPersistenceTarget,
} from "./session-manager-view-types.js";
import type { SessionManagerWriteAdmission } from "./session-manager-write-admission.js";

export type PersistWorkerRecordResult = {
  result: PersistRecordResult;
  reload?: PreparedSessionTranscriptReload;
  committedVersion: SessionTranscriptContextVersion;
  viewFailure?: Error;
};

export class SessionManagerWorkerPersistence extends SessionManagerPersistence {
  #messageRuntime:
    | {
        target: SessionManagerPersistenceTarget;
        runtime: ReturnType<typeof createSessionManagerMessageRuntime>;
        close(): Promise<void>;
      }
    | undefined;

  protected getMessageRuntime() {
    this.assertTranscriptWriteActive();
    const target = this.persistenceTarget;
    if (!target) {
      throw new Error("Session message worker requires a persistent session");
    }
    const previous = this.#messageRuntime;
    if (previous && sameSessionTranscriptTargetBinding(previous.target, target)) {
      return previous.runtime;
    }
    if (previous) {
      void previous.close().catch(() => undefined);
    }
    const binding = target[sessionTranscriptExecution];
    const resolved = binding?.scope ?? resolveSqliteTranscriptScope(target);
    const execution =
      binding?.execution.borrow() ??
      captureOpenClawAgentDatabaseExecution(toDatabaseOptions(resolved));
    const captured = { ...target };
    let revoked = false;
    const assertCurrent = () => {
      if (revoked || !sameSessionTranscriptTargetBinding(captured, this.persistenceTarget)) {
        throw new SessionTranscriptWriterClaimReboundError();
      }
      this.assertTranscriptWriteActive();
    };
    const runtime = createSessionManagerMessageRuntime({
      execution,
      scope: {
        ...withOwnedSessionTranscriptWriterFence(captured),
        agentId: resolved.agentId,
        sessionKey: resolved.sessionKey,
        storePath: execution.path,
      },
      pending: this.pendingToolResults,
      assertCurrent,
      commit: (facts) => this.adoptMessageInitialization(facts),
      publishCommit: (facts) => this.publishMessageInitialization(facts),
    });
    let unregister: () => void;
    const close = async () => {
      revoked = true;
      await runtime.close();
      unregister();
    };
    try {
      unregister = registerOpenClawAgentDatabaseAsyncResource({
        agentId: execution.agentId,
        path: execution.path,
        revoke: () => {
          revoked = true;
        },
        close,
      });
    } catch (error) {
      void runtime.close().catch(() => undefined);
      throw error;
    }
    this.#messageRuntime = { target: captured, runtime, close };
    return runtime;
  }

  protected async persistWorkerRecord(
    entry: ModelChangeEntry | ThinkingLevelChangeEntry,
    appendIntent: "active-branch" | undefined,
    writeAdmission: SessionManagerWriteAdmission,
  ): Promise<PersistWorkerRecordResult> {
    this.assertTranscriptWriteActive();
    const target = this.persistenceTarget;
    if (!target) {
      throw new Error("Session writer worker requires a persistent session");
    }
    const identity = { ...target };
    const sessionId = this.getSessionId();
    const { database, options } = writeAdmission;
    const databaseIdentity = readOpenClawAgentDatabaseIdentity(database).identity;
    const { env: _env, ...writeTarget } = withOwnedSessionTranscriptWriterFence(target);
    const captured: SessionMetadataWorkerOperations["session.metadata.append"]["input"]["scope"] = {
      ...writeTarget,
      storePath: database.path,
    };
    if (database.db.isTransaction) {
      throw new Error("Asynchronous session writes must own their transaction");
    }
    const initialWriter = this.captureInitialTranscriptWriter();
    const assertOwned = captureOwnedTranscriptWriteAssertion(identity);
    const assertBinding = () => {
      const current = this.persistenceTarget;
      if (
        this.getSessionId() !== sessionId ||
        !sameSessionTranscriptTargetBinding(identity, current)
      ) {
        throw new SessionTranscriptWriterClaimReboundError();
      }
    };
    const assertCurrent = () => {
      assertBinding();
      initialWriter?.assertActive();
      assertOwned();
    };
    const admission = resolveSessionTranscriptReadFence(captured);
    const { withSessionMetadataWorker } = await runInDetachedAsyncContext(
      () => import("./session-manager-metadata-runtime.js"),
    );
    assertCurrent();
    return await withSessionMetadataWorker(options, database, assertCurrent, async (worker) => {
      if (this.persistenceHeaderPending || (initialWriter && !initialWriter.committedFence)) {
        const committed = await worker.execute({
          type: "session.metadata.initialize",
          input: {
            scope: captured,
            entry: { sessionId: captured.sessionId, updatedAt: Date.now() },
            ...(initialWriter && !initialWriter.committedFence
              ? { initialWriterRunId: initialWriter.writerRunId }
              : {}),
          },
        });
        try {
          if (committed.fence) {
            initialWriter?.recordCommitted(committed.fence);
            Object.assign(target, committed.fence);
            Object.assign(captured, committed.fence);
          }
        } finally {
          if (committed.identity) {
            publishCommittedSessionIdentity(
              captured.agentId,
              databaseIdentity,
              committed.identity.previous,
              committed.identity.current,
            );
          }
        }
        if (!committed.owned) {
          if (captured.expectedWriterRunId !== undefined) {
            throw new SessionTranscriptWriterClaimReboundError();
          }
          throw new Error("Session transcript header was not persisted");
        }
        assertCurrent();
      }
      const appendEvent = async (
        event: Parameters<typeof worker.execute<"session.metadata.append">>[0]["input"]["event"],
        expectedMutationAt: number | null | undefined,
        intent?: "active-branch",
      ) => {
        const result = await worker.execute({
          type: "session.metadata.append",
          input: {
            scope: captured,
            event,
            options: {
              ...(intent ? { appendIntent: intent } : {}),
              ...(expectedMutationAt !== undefined ? { expectedMutationAt } : {}),
            },
            ...(event.type !== "session"
              ? {
                  view: {
                    loadedVersion: this.transcriptVersion,
                    limits: this.boundedContextLimits,
                    admission,
                  },
                }
              : {}),
          },
        });
        if (result.projectionNeedsReconcile) {
          startSessionTranscriptIndexReconcile({
            ...options,
            preferredSessionId: captured.sessionId,
          });
        }
        return result;
      };
      let loadedVersion = this.transcriptVersion;
      const append = async (expectedMutationAt: number | null | undefined) => {
        let mutationAt = expectedMutationAt;
        if (this.persistenceHeaderPending) {
          const header = this.fileEntries[0];
          if (!header || header.type !== "session") {
            throw new Error("Session transcript header was not persisted");
          }
          const headerSnapshot = (await appendEvent(header, mutationAt)).snapshot;
          if (!headerSnapshot.ok || !headerSnapshot.value.result?.appended) {
            throw new Error("Session transcript header was not persisted", {
              cause: headerSnapshot.ok ? undefined : headerSnapshot.error,
            });
          }
          const committed = headerSnapshot.value;
          assertBinding();
          if (!this.hasNewerPublishedTranscriptView(committed.after)) {
            this.transcriptVersion = committed.after;
            this.transcriptMutationAt = committed.after.updatedAt;
          }
          this.persistenceHeaderPending = false;
          mutationAt = this.transcriptMutationAt;
        }
        loadedVersion = this.transcriptVersion;
        const outcome = await appendEvent(entry, mutationAt, appendIntent);
        const snapshot = outcome.snapshot;
        if (!snapshot.ok || !snapshot.value.result || !snapshot.value.result.appended) {
          throw new Error(`Session transcript entry was not persisted: ${entry.id}`, {
            cause: snapshot.ok ? undefined : snapshot.error,
          });
        }
        return {
          committed: { ...snapshot.value, result: snapshot.value.result },
          reload: outcome.reload,
        };
      };
      let outcome;
      try {
        outcome = await append(this.transcriptMutationAt);
      } catch (error) {
        if (!isSqliteTranscriptMutationConflict(error)) {
          throw error;
        }
        const fresh = await worker.execute({
          type: "session.metadata.mutation",
          input: { scope: captured },
        });
        outcome = await append(fresh);
      }
      const { committed, reload } = outcome;
      const receipt = committed.result;
      const effectiveParentId =
        "effectiveParentId" in receipt && receipt.effectiveParentId !== undefined
          ? receipt.effectiveParentId
          : entry.parentId;
      const reloadAfterAppend =
        receipt.appended &&
        loadedVersion !== undefined &&
        (committed.before.generation !== loadedVersion.generation ||
          committed.before.rawSeq !== loadedVersion.rawSeq);
      let viewFailure: Error | undefined;
      if (reload?.ok === false) {
        const error = new Error("Committed session transcript view could not be reconstructed");
        if (reload.error) {
          retainOpenClawStateWorkerErrorPayload(error, reload.error);
        }
        viewFailure = hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
      }
      return {
        result: {
          appended: receipt.appended,
          lifecycleRevision: committed.lifecycleRevision,
          effectiveParentId,
          ...(reloadAfterAppend ? { reloadAfterAppend: true } : {}),
        },
        reload: reload?.ok ? reload.value : undefined,
        committedVersion: committed.after,
        viewFailure,
      };
    });
  }
}

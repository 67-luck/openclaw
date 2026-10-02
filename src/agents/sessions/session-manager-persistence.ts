import type { DatabaseSync } from "node:sqlite";
import {
  ensureSessionEntrySync,
  readTranscriptMutationAtSync,
} from "../../config/sessions/session-accessor.js";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import { publishCommittedSessionIdentity } from "../../config/sessions/session-accessor.sqlite-identity.js";
import { toDatabaseOptions } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { requireTranscriptEventAppendSnapshot } from "../../config/sessions/session-accessor.sqlite-transcript-append-result.js";
import type { PreparedTranscriptMessageAppend } from "../../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import {
  appendTranscriptEventSnapshotSync,
  appendTranscriptMessageSnapshotSync,
} from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { startSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import {
  sameSessionTranscriptTargetBinding,
  sessionTranscriptExecution,
} from "../../config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptInitialWriter,
  getOwnedSessionTranscriptWriterFence,
  SessionTranscriptWriterClaimReboundError,
  type InitialSessionTranscriptWriter,
} from "../../config/sessions/transcript-write-context.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import {
  captureSqliteWorkerCallerTransaction,
  stageSqliteWorkerCallerRollback,
} from "../../infra/sqlite-worker-host-context.js";
import {
  assertUserTurnFreshInputCommit,
  sessionFreshInputCommit,
} from "../../sessions/user-turn-transcript-admission.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../../state/openclaw-state-worker-error.js";
import type { AgentMessage } from "../runtime/index.js";
import { preparePendingToolResultDelta } from "../session-tool-result-pending-facts.js";
import {
  sessionToolResultPending,
  sessionToolResultRepair,
} from "../session-tool-result-pending.js";
import { copyCodeModeSourceAppendOptions } from "../transcript-code-mode-source.js";
import { getSessionCompactionPersistence } from "./session-compaction-persistence.js";
import { isIndexedSessionEntry, parseOpaqueLeafEntry } from "./session-manager-codec.js";
import { SessionManagerCore } from "./session-manager-core.js";
import type { SessionMetadataWorkerOperations } from "./session-manager-metadata-contract.js";
import { withReadySessionMetadata } from "./session-manager-metadata-runtime.js";
import type {
  NativeMessageAppendContinuation,
  PersistRecordOptions,
  PersistRecordResult,
} from "./session-manager-persistence-contract.js";
import { type SessionEntry, sessionTranscriptAppendPublication } from "./session-manager-types.js";
import type {
  PreparedSessionTranscriptReload,
  SessionManagerPersistenceTarget,
} from "./session-manager-view-types.js";
import { withSessionManagerReadyWrite } from "./session-manager-write-admission.js";
import type { SessionMessageCommitFacts } from "./session-message-append-receipt.js";

export class SessionManagerPersistence extends SessionManagerCore {
  #initialWriter: InitialSessionTranscriptWriter | undefined;
  #tentativeInitial:
    | {
        transaction: object;
        target: SessionManagerPersistenceTarget;
        fence: NonNullable<InitialSessionTranscriptWriter["committedFence"]> | undefined;
      }
    | undefined;

  // Async persistence captures this exact writer before yielding; the base
  // still owns its initial and tentative fences.
  protected captureInitialTranscriptWriter(): InitialSessionTranscriptWriter | undefined {
    return this.#initialWriter;
  }

  protected messageInitialization() {
    if (this.currentTentativeInitial()) {
      return undefined;
    }
    const writer = this.#initialWriter;
    return this.persistenceHeaderPending || (writer && !writer.committedFence)
      ? writer && !writer.committedFence
        ? { initialWriterRunId: writer.writerRunId }
        : {}
      : undefined;
  }

  protected adoptMessageInitialization(facts: SessionMessageCommitFacts): void {
    if (facts.kind !== "manager" || !facts.initial) {
      return;
    }
    const initial = facts.initial;
    if (initial.fence) {
      this.#initialWriter?.recordCommitted(initial.fence);
      Object.assign(this.persistenceTarget!, initial.fence);
    }
    this.persistenceHeaderPending = false;
    this.#tentativeInitial = undefined;
  }

  private currentTentativeInitial() {
    const retained = this.#tentativeInitial;
    return retained &&
      retained.transaction === captureSqliteWorkerCallerTransaction() &&
      sameSessionTranscriptTargetBinding(retained.target, this.persistenceTarget)
      ? retained
      : undefined;
  }

  private stageInitialFence(fence: InitialSessionTranscriptWriter["committedFence"]) {
    const transaction = captureSqliteWorkerCallerTransaction();
    if (!transaction || !this.persistenceTarget) {
      throw new Error("Tentative session initialization lost its original snapshot");
    }
    const previous = this.#tentativeInitial;
    const retained = { transaction, target: this.persistenceTarget, fence };
    this.#tentativeInitial = retained;
    if (fence) {
      Object.assign(this.persistenceTarget, fence);
    }
    return () => {
      if (this.#tentativeInitial === retained) {
        this.#tentativeInitial = previous;
      }
    };
  }

  protected stageMessageView(facts: SessionMessageCommitFacts, update: () => void) {
    let restoreInitial: (() => void) | undefined;
    const rollbackView = this.stageTranscriptView(() => {
      if (facts.kind === "manager" && facts.initial) {
        restoreInitial = this.stageInitialFence(facts.initial.fence);
        this.persistenceHeaderPending = false;
      }
      try {
        update();
      } catch (error) {
        restoreInitial?.();
        throw error;
      }
    });
    return () => {
      rollbackView();
      restoreInitial?.();
    };
  }

  protected publishMessageInitialization(facts: SessionMessageCommitFacts): void {
    if (facts.kind === "manager" && facts.initial?.identity) {
      const { databaseIdentity, previous, current } = facts.initial.identity;
      publishCommittedSessionIdentity(
        facts.receipt.anchor!.agentId,
        databaseIdentity,
        previous,
        current,
      );
    }
  }

  protected retainTranscriptWriter(): void {
    const sessionTarget = this.persistenceTarget;
    if (sessionTarget && getOwnedSessionTranscriptWriterFence({ sessionTarget })) {
      this.#initialWriter ??= getOwnedSessionTranscriptInitialWriter({ sessionTarget });
    }
  }

  protected assertTranscriptWriteActive(): void {
    this.assertTranscriptViewAvailable();
    if (!this.persistenceTarget) {
      return;
    }
    const scope = this.persistenceTarget;
    const inheritedWriter = getOwnedSessionTranscriptInitialWriter({ sessionTarget: scope });
    this.#initialWriter ??= inheritedWriter;
    const initialWriter = this.#initialWriter;
    if (!initialWriter) {
      return;
    }
    initialWriter.assertActive();
    if (!initialWriter.committedFence && inheritedWriter !== initialWriter) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
    Object.assign(
      scope,
      initialWriter.committedFence ??
        this.currentTentativeInitial()?.fence ?? {
          expectedLifecycleRevision: undefined,
          expectedWriterRunId: initialWriter.writerRunId,
        },
    );
  }

  protected hasNewerPublishedTranscriptView(version: SessionTranscriptContextVersion): boolean {
    this.assertTranscriptViewAvailable();
    // Appends and rewrites strictly advance this owner-held watermark, including maintenance.
    return (
      this.transcriptMutationAt != null &&
      version.updatedAt !== null &&
      this.transcriptMutationAt >= version.updatedAt
    );
  }

  protected persistRecord(
    entry: unknown,
    options?: PersistRecordOptions,
    preparedMessage?: PreparedTranscriptMessageAppend<AgentMessage>,
    native?: NativeMessageAppendContinuation,
  ): PersistRecordResult {
    if (this.persistenceTarget) {
      return this.persistSqliteRecord(entry, options, preparedMessage, native);
    }
    if (getSessionCompactionPersistence(this)) {
      throw new Error("Compaction boundary validation failed");
    }
    return undefined;
  }

  public persist(entry: SessionEntry, options?: PersistRecordOptions): PersistRecordResult {
    return this.persistRecord(entry, options);
  }

  protected captureTranscriptMutationReader(): () => number | null {
    const target = this.persistenceTarget ? { ...this.persistenceTarget } : undefined;
    const execution = target?.[sessionTranscriptExecution];
    const assertOwned = target ? captureOwnedTranscriptWriteAssertion(target) : () => undefined;
    const assertCurrent = () => {
      assertOwned();
      this.assertTranscriptWriteActive();
      if (!sameSessionTranscriptTargetBinding(target, this.persistenceTarget)) {
        throw new SessionTranscriptWriterClaimReboundError();
      }
    };
    // A conflict cannot recapture a replacement target or downgrade a revoked
    // ready owner to host SQLite. Successful appends never dispatch this read.
    return () => {
      assertCurrent();
      if (!target) {
        return null;
      }
      const mutationAt = execution
        ? this.withReadyMetadata(target, assertOwned, (worker) => {
            assertCurrent();
            const {
              env: _env,
              [sessionTranscriptExecution]: _execution,
              ...scope
            } = this.persistenceTarget!;
            return worker.execute({ type: "session.metadata.mutation", input: { scope } });
          })
        : readTranscriptMutationAtSync(target);
      assertCurrent();
      return mutationAt;
    };
  }

  private withReadyMetadata<T>(
    target: SessionManagerPersistenceTarget,
    assertOwned: () => void,
    operation: Parameters<typeof withReadySessionMetadata<T>>[2],
  ): T {
    return withSessionManagerReadyWrite(this, () =>
      withReadySessionMetadata(
        target,
        () => {
          assertOwned();
          this.assertTranscriptWriteActive();
          if (!sameSessionTranscriptTargetBinding(target, this.persistenceTarget)) {
            throw new SessionTranscriptWriterClaimReboundError();
          }
        },
        operation,
      ),
    );
  }

  private persistSqliteRecord(
    entry: unknown,
    options?: PersistRecordOptions,
    preparedMessage?: PreparedTranscriptMessageAppend<AgentMessage>,
    native?: NativeMessageAppendContinuation,
  ): PersistRecordResult {
    const target = this.persistenceTarget;
    if (target?.[sessionTranscriptExecution]) {
      return this.withReadyMetadata(
        target,
        captureOwnedTranscriptWriteAssertion(target),
        (worker) => this.persistSqliteRecordInOwner(entry, options, preparedMessage, worker),
      );
    }
    return this.persistSqliteRecordInOwner(entry, options, preparedMessage, undefined, native);
  }

  private persistSqliteRecordInOwner(
    entry: unknown,
    options?: PersistRecordOptions,
    preparedMessage?: PreparedTranscriptMessageAppend<AgentMessage>,
    worker?: Parameters<Parameters<typeof withReadySessionMetadata>[2]>[0],
    native?: NativeMessageAppendContinuation,
  ): PersistRecordResult {
    if (!this.persistenceTarget) {
      return undefined;
    }
    this.assertTranscriptWriteActive();
    const scope = this.persistenceTarget;
    const { env: _env, [sessionTranscriptExecution]: _execution, ...workerScope } = scope;
    let preparedReload: PreparedSessionTranscriptReload | undefined;
    const appendEvent: typeof appendTranscriptEventSnapshotSync = (
      target,
      event,
      eventOptions,
      projection,
      view,
    ) => {
      if (!worker) {
        return appendTranscriptEventSnapshotSync(target, event, eventOptions, projection, view);
      }
      view?.assertCurrent();
      const result = worker.execute({
        type: "session.metadata.append",
        input: {
          scope: workerScope,
          event:
            // Callers supply canonical headers, codec-accepted non-message entries or leaf controls.
            // SAFETY: these events already have the metadata command's shape; preserve their bytes.
            event as SessionMetadataWorkerOperations["session.metadata.append"]["input"]["event"],
          options: eventOptions ?? {},
          view: {
            loadedVersion: this.transcriptVersion,
            limits: this.boundedContextLimits,
            admission: resolveSessionTranscriptReadFence(scope),
          },
        },
      });
      view?.assertCurrent();
      if (result.reload?.ok === false) {
        const error = new Error("Committed session transcript view could not be reconstructed");
        if (result.reload.error) {
          retainOpenClawStateWorkerErrorPayload(error, result.reload.error);
        }
        throw hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
      }
      preparedReload = result.reload?.value;
      if (result.projectionNeedsReconcile && _execution?.execution.backend !== "volatile") {
        worker.publish(() =>
          startSessionTranscriptIndexReconcile({
            ...toDatabaseOptions(_execution!.scope),
            preferredSessionId: scope.sessionId,
          }),
        );
      }
      return result.snapshot;
    };
    const initialWriter = this.#initialWriter;
    const persistCompaction = getSessionCompactionPersistence(this);
    const sessionId = this.sessionId;
    const isCurrentView = () =>
      this.sessionId === sessionId &&
      sameSessionTranscriptTargetBinding(scope, this.persistenceTarget);
    const onPendingTransaction = (database: DatabaseSync) => {
      if (!isCurrentView()) {
        return;
      }
      const previous = this.captureTranscriptView(true);
      stageSqliteTransactionState(database, {
        stage: () => {},
        commit: () => {},
        rollback: () => {
          if (isCurrentView()) {
            Object.assign(this, previous);
          }
        },
      });
    };
    const viewGuard = {
      assertCurrent: () => {
        this.assertTranscriptViewAvailable();
        if (!isCurrentView()) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
      },
      onPendingTransaction,
    };
    if (persistCompaction && isIndexedSessionEntry(entry) && entry.type === "compaction") {
      // Atomic accounting accepts exactly one boundary, never lazy transcript initialization.
      if (this.persistenceHeaderPending) {
        throw new Error("Compaction boundary validation failed");
      }
      const loadedVersion = this.transcriptVersion;
      const expectedMutationAt =
        options?.expectedMutationAt !== undefined
          ? options.expectedMutationAt
          : this.transcriptMutationAt;
      const committed = persistCompaction({
        scope: { ...scope },
        event: entry,
        ...(options?.appendIntent ? { appendIntent: options.appendIntent } : {}),
        ...(expectedMutationAt !== undefined ? { expectedMutationAt } : {}),
        ...(initialWriter && !initialWriter.committedFence ? { initializeEntry: true } : {}),
      });
      if (initialWriter?.committedFence) {
        Object.assign(scope, initialWriter.committedFence);
      }
      this.transcriptVersion = committed.after;
      this.transcriptMutationAt = committed.after.updatedAt;
      const reloadAfterAppend =
        loadedVersion !== undefined &&
        (committed.before.generation !== loadedVersion.generation ||
          committed.before.rawSeq !== loadedVersion.rawSeq);
      return {
        appended: true,
        effectiveParentId: committed.result.parentId,
        ...(reloadAfterAppend ? { reloadAfterAppend: true } : {}),
      };
    }
    let initialized = false;
    if (
      this.persistenceHeaderPending ||
      (initialWriter && !initialWriter.committedFence && !this.currentTentativeInitial())
    ) {
      const initial = worker?.execute({
        type: "session.metadata.initialize",
        input: {
          scope: workerScope,
          entry: { sessionId: scope.sessionId, updatedAt: Date.now() },
          ...(initialWriter && !initialWriter.committedFence
            ? { initialWriterRunId: initialWriter.writerRunId }
            : {}),
        },
      });
      if (initial?.owned && worker?.tentative) {
        const restore = this.stageInitialFence(initial.fence);
        const tentativeInitial = this.#tentativeInitial;
        if (!stageSqliteWorkerCallerRollback(restore)) {
          restore();
          throw new Error("Tentative session initialization lost its rollback owner");
        }
        worker.publish(() => {
          if (this.#tentativeInitial === tentativeInitial) {
            this.#tentativeInitial = undefined;
          }
        });
      }
      if (initial?.fence) {
        worker!.publish(() => {
          initialWriter?.recordCommitted(initial.fence!);
          this.#tentativeInitial = undefined;
        });
        Object.assign(scope, initial.fence);
        Object.assign(workerScope, initial.fence);
      }
      if (initial?.identity) {
        worker!.publish(() =>
          publishCommittedSessionIdentity(
            _execution!.scope.agentId,
            initial.identity!.databaseIdentity,
            initial.identity!.previous,
            initial.identity!.current,
          ),
        );
      }
      if (
        worker
          ? !initial?.owned
          : !ensureSessionEntrySync(scope, {
              sessionId: scope.sessionId,
              updatedAt: Date.now(),
            })
      ) {
        throw new Error("Session transcript header was not persisted");
      }
      initialWriter?.assertActive();
      if (initialWriter?.committedFence) {
        Object.assign(scope, initialWriter.committedFence);
      }
      initialized = true;
    }
    const persistedHeader = this.persistenceHeaderPending;
    if (persistedHeader) {
      const header = this.fileEntries[0];
      if (!header || header.type !== "session") {
        throw new Error("Session transcript header was not persisted");
      }
      this.transcriptVersion = requireTranscriptEventAppendSnapshot(
        appendEvent(
          scope,
          header,
          options?.expectedMutationAt !== undefined
            ? { expectedMutationAt: options.expectedMutationAt }
            : this.transcriptMutationAt !== undefined
              ? { expectedMutationAt: this.transcriptMutationAt }
              : {},
          undefined,
          viewGuard,
        ),
        "Session transcript header was not persisted",
      ).after;
      this.transcriptMutationAt = this.transcriptVersion.updatedAt;
      this.persistenceHeaderPending = false;
    }
    const expectedMutationAt = persistedHeader
      ? this.transcriptMutationAt
      : options?.expectedMutationAt !== undefined
        ? options.expectedMutationAt
        : this.transcriptMutationAt;
    const leafEntry = parseOpaqueLeafEntry(entry);
    if (leafEntry) {
      this.transcriptVersion = requireTranscriptEventAppendSnapshot(
        appendEvent(
          scope,
          entry,
          expectedMutationAt !== undefined ? { expectedMutationAt } : {},
          undefined,
          viewGuard,
        ),
        `Session transcript leaf control was not persisted: ${leafEntry.id}`,
      ).after;
      this.transcriptMutationAt = this.transcriptVersion.updatedAt;
      return undefined;
    }
    if (!isIndexedSessionEntry(entry)) {
      return undefined;
    }
    if (entry.type !== "message") {
      const loadedVersion = this.transcriptVersion;
      const outcome = appendEvent(
        scope,
        entry,
        {
          ...(options?.appendIntent === "active-branch"
            ? { appendIntent: options.appendIntent }
            : {}),
          ...(expectedMutationAt !== undefined ? { expectedMutationAt } : {}),
        },
        undefined,
        viewGuard,
      );
      const committed = requireTranscriptEventAppendSnapshot(
        outcome,
        `Session transcript entry was not persisted: ${entry.id}`,
      );
      const effectiveParentId =
        committed.result.effectiveParentId !== undefined
          ? committed.result.effectiveParentId
          : entry.parentId;
      this.transcriptVersion = committed.after;
      this.transcriptMutationAt = this.transcriptVersion.updatedAt;
      const reloadAfterAppend =
        loadedVersion !== undefined &&
        (committed.before.generation !== loadedVersion.generation ||
          committed.before.rawSeq !== loadedVersion.rawSeq);
      return effectiveParentId === entry.parentId && !reloadAfterAppend
        ? undefined
        : {
            appended: true,
            effectiveParentId,
            ...(reloadAfterAppend ? { reloadAfterAppend: true } : {}),
            ...(preparedReload ? { reload: preparedReload } : {}),
          };
    }
    const freshInput = options?.[sessionFreshInputCommit];
    const appendOptions = copyCodeModeSourceAppendOptions(options, {
      cwd: this.cwd,
      eventId: entry.id,
      ...(options?.beforeFreshMessageCommit || freshInput
        ? {
            beforeFreshMessageCommit: () => {
              if (options?.beforeFreshMessageCommit) {
                const leave = native?.enterPublicFresh();
                try {
                  options.beforeFreshMessageCommit();
                } finally {
                  leave?.();
                }
              }
              // The caller may revoke recorder custody. Preserve the native
              // once-only assertion after it, at the kernel's fresh branch.
              if (freshInput?.assertCurrent) {
                freshInput.assertCurrent();
              } else if (freshInput?.authority) {
                assertUserTurnFreshInputCommit(freshInput.authority);
              }
            },
          }
        : {}),
      ...(options?.config ? { config: options.config } : {}),
      ...(options?.idempotencyLookup ? { idempotencyLookup: options.idempotencyLookup } : {}),
      ...(expectedMutationAt !== undefined ? { expectedMutationAt } : {}),
      message: entry.message,
      now: Date.parse(entry.timestamp),
      parentId: entry.parentId,
      ...(options?.appendIntent === "active-branch" ? { appendIntent: options.appendIntent } : {}),
    } satisfies Parameters<typeof appendTranscriptMessageSnapshotSync>[1]);
    const loadedVersion = this.transcriptVersion;
    const { owner } = this[sessionToolResultPending];
    const pending = this.pendingToolResults.capture(owner);
    const repairedCall = options?.[sessionToolResultRepair];
    const repairedToken = repairedCall && pending.token(repairedCall);
    let deferPublication: ((observer: () => void) => boolean) | undefined;
    let completed = false;
    let persisted: PersistRecordResult;
    const finish = (
      outcome: ReturnType<typeof appendTranscriptMessageSnapshotSync<AgentMessage>>,
    ): PersistRecordResult => {
      if (!outcome.ok) {
        throw new Error(`Session transcript message was not persisted: ${entry.id}`, {
          cause: outcome.error,
        });
      }
      const result = outcome.value.result;
      this.transcriptVersion = outcome.value.after;
      if (!result) {
        throw new Error(`Session transcript message was not persisted: ${entry.id}`);
      }
      if (result.appended) {
        this.transcriptMutationAt = outcome.value.after.updatedAt;
      }
      // Carry the canonical storage bytes even when adopting a context-excluded row.
      entry.message = result.message;
      const publication = native
        ? {
            [sessionTranscriptAppendPublication]: (observer: () => void) => {
              if (completed) {
                observer();
              } else if (!deferPublication?.(observer)) {
                throw new Error("Session message publication lost its original transaction");
              }
            },
          }
        : {};
      if (result.messageId !== entry.id) {
        const idempotencyKey =
          entry.message.role === "user" &&
          "idempotencyKey" in entry.message &&
          typeof entry.message.idempotencyKey === "string" &&
          entry.message.idempotencyKey.length > 0
            ? entry.message.idempotencyKey
            : undefined;
        if (idempotencyKey && options?.idempotencyLookup !== "caller-checked") {
          // Ingress can commit the keyed user after this manager loaded. The
          // caller reloads and adopts only when that canonical row is still active.
          if (!result.anchor) {
            throw new Error(`Session transcript anchor was not returned: ${result.messageId}`);
          }
          return {
            adoptedMessageId: result.messageId,
            anchor: result.anchor,
            appended: result.appended,
            effectiveParentId: result.effectiveParentId ?? null,
            ...publication,
          };
        }
        throw new Error(`Session transcript parent entry was not persisted: ${entry.id}`);
      }
      if (
        options?.idempotencyLookup === "caller-checked" &&
        (!result.appended || result.messageId !== entry.id)
      ) {
        throw new Error(`Session transcript append was not persisted: ${entry.id}`);
      }
      if (result.effectiveParentId === undefined) {
        throw new Error(`Session transcript append parent was not returned: ${entry.id}`);
      }
      const reloadAfterAppend =
        result.appended &&
        loadedVersion !== undefined &&
        (outcome.value.before.generation !== loadedVersion.generation ||
          outcome.value.before.rawSeq !== loadedVersion.rawSeq);
      return {
        ...(result.anchor ? { anchor: result.anchor } : {}),
        lifecycleRevision: outcome.value.lifecycleRevision,
        appended: result.appended,
        effectiveParentId: result.effectiveParentId,
        ...(reloadAfterAppend ? { reloadAfterAppend: true } : {}),
        ...publication,
      };
    };
    const outcome = appendTranscriptMessageSnapshotSync(
      scope,
      appendOptions,
      preparedMessage,
      {
        preparePending: ({ result, snapshot, deferPublication: defer }) => {
          deferPublication = defer;
          if (!result.anchor) {
            throw new Error(`Session transcript anchor was not returned: ${result.messageId}`);
          }
          return pending.stage(
            preparePendingToolResultDelta({
              entry: {
                ...entry,
                id: result.messageId,
                parentId: result.effectiveParentId ?? null,
                // preparePending erases TMessage from this manager's AgentMessage preparation.
                // SAFETY: the canonical kernel returns the stored or replayed message.
                message: result.message as AgentMessage,
              },
              appended: result.appended,
              calls: pending.facts,
              repairedToken,
              events: () => snapshot().rows.map((row) => row.event),
            }),
          );
        },
      },
      {
        view: viewGuard,
        continuation: native && {
          enter: (database, nested) =>
            native.enter(database, nested, initialized || persistedHeader),
          complete: (snapshot) => {
            native.assertCurrent();
            persisted = finish(snapshot);
            native.complete(persisted);
          },
          retainPublication: (publish) => {
            completed = true;
            native.retainPublication(publish);
          },
        },
      },
    );
    return native ? persisted : finish(outcome);
  }
}

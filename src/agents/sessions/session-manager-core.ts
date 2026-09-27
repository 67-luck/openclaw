import type { DatabaseSync } from "node:sqlite";
import type { SessionTranscriptBoundedActiveContext } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { assertCurrentSessionTranscriptHeader } from "../../config/sessions/session-entry-codec.js";
import { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";
import {
  captureSessionTranscriptTargetBinding,
  sameSessionTranscriptTargetBinding,
  sessionTranscriptExecution,
} from "../../config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  SessionTranscriptWriterClaimReboundError,
} from "../../config/sessions/transcript-write-context.js";
import {
  captureSqliteTransactionState,
  type CapturedSqliteTransactionState,
} from "../../infra/sqlite-post-commit.js";
import {
  captureSqliteWorkerCallerTransaction,
  captureSqliteWorkerCallerViewRollback,
} from "../../infra/sqlite-worker-host-context.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  sessionToolResultPending,
  type PendingToolResult,
} from "../session-tool-result-pending.js";
import {
  isIndexedSessionEntry,
  migrateToCurrentVersion,
  partitionSessionFileEntries,
} from "./session-manager-codec.js";
import { createManagedSessionId } from "./session-manager-id.js";
import {
  assertCommittedSessionTranscriptReload,
  prepareCommittedSessionTranscriptReload,
  type SessionTranscriptAppendExpectation,
} from "./session-manager-reload.js";
import type { FileEntry } from "./session-manager-types.js";
import type {
  SessionManagerPersistenceTarget,
  PreparedSessionTranscriptReload,
  SessionManagerBoundedContext,
} from "./session-manager-view-types.js";
import { SessionManagerView } from "./session-manager-view.js";

type NativeTranscriptViewOwner = {
  database: DatabaseSync;
  path: string;
  journal: CapturedSqliteTransactionState;
  target: SessionManagerPersistenceTarget;
  disposition: { live: boolean; hydrated: boolean };
};

export class SessionManagerCore extends SessionManagerView {
  private hydrationRevision = 0;
  private publishedHydration = {};
  private nativeViewOwner: NativeTranscriptViewOwner | undefined;
  private readonly nativePublicFresh: NativeTranscriptViewOwner[] = [];
  protected cwd: string;

  override get [sessionToolResultPending]() {
    return {
      ...super[sessionToolResultPending],
      retireSelected: (calls: readonly PendingToolResult[]) => this.retirePendingToolResults(calls),
    };
  }

  private retirePendingToolResults(calls: readonly PendingToolResult[]): void {
    this.assertTranscriptViewAvailable();
    const target = this.persistenceTarget;
    const boundary = super[sessionToolResultPending];
    const native = [this.nativeViewOwner, ...this.nativePublicFresh.toReversed()].find(
      (owner) =>
        owner?.disposition.live && sameSessionTranscriptTargetBinding(owner.target, target),
    );
    const rollback = captureSqliteWorkerCallerViewRollback(
      target?.[sessionTranscriptExecution]?.execution.incarnation,
    );
    const transaction = native
      ? captureSqliteTransactionState(native.database)?.transaction
      : rollback
        ? captureSqliteWorkerCallerTransaction()
        : undefined;
    if ((native && transaction !== native.journal.transaction) || (rollback && !transaction)) {
      throw new Error("Pending retirement lost its original transaction");
    }
    const captured = boundary.pending.capture(boundary.owner, transaction);
    const change = captured.stage({ remove: calls.map(captured.token), add: [] });
    if (native) {
      // Policy-only retirement shares the real journal; rollback restores the
      // original occurrences without erasing another branch's committed work.
      if (!native.journal.stage(change)) {
        throw new Error("Pending retirement lost its original transaction");
      }
    } else if (rollback) {
      // Capture the matching execution's inverse before changing its host ledger.
      if (!rollback(change.rollback)) {
        throw new Error("Pending retirement lost its original transaction");
      }
      change.stage(transaction);
    } else {
      change.stage();
      change.commit();
    }
  }

  constructor(
    cwd: string,
    persistenceTarget?: SessionManagerPersistenceTarget,
    loadedEntries?: readonly unknown[],
    boundedContext?: SessionManagerBoundedContext,
    transcriptMutationAt?: number | null,
    version?: SessionTranscriptContextVersion,
  ) {
    super();
    this.cwd = cwd;
    this.persistenceTarget = persistenceTarget;
    this.boundedContextLimits = boundedContext?.limits;
    this.boundedContextIncomplete = boundedContext !== undefined;
    this.persistedBoundaryCount = boundedContext?.boundaryCount;
    this.persistedSuffixStartSeq = boundedContext?.persistedSuffixStartSeq;
    this.transcriptMutationAt =
      boundedContext !== undefined ? boundedContext.transcriptMutationAt : transcriptMutationAt;
    this.transcriptVersion = version ?? boundedContext?.version;
    if (persistenceTarget || loadedEntries) {
      this.setLoadedSessionTarget(persistenceTarget, loadedEntries ?? [], boundedContext, version);
    } else {
      this.newSession();
    }
  }

  /** @deprecated Runtime callers should await setSessionTargetAsync. */
  setSessionTarget(target: SessionTranscriptRuntimeTarget): void {
    this.assertTranscriptViewAvailable();
    this.hydrationRevision++;
    const hydration = prepareSessionTranscriptHydration(target, this.boundedContextLimits);
    let capturedReader:
      | { database: DatabaseSync; journal: CapturedSqliteTransactionState }
      | undefined;
    const prepared = hydration.initializeReady((database) => {
      const journal = captureSqliteTransactionState(database);
      if (journal) {
        capturedReader = { database, journal };
      }
    });
    const reader = capturedReader;
    const candidate = this.prepareHydratedView(hydration.target, prepared, false);
    const replacement = candidate.captureTranscriptViewImage();
    const previous = this.captureTranscriptViewImage();
    const owner =
      reader &&
      [this.nativeViewOwner, ...this.nativePublicFresh.toReversed()].find(
        (value) =>
          value?.disposition.live &&
          value.database === reader.database &&
          value.journal.transaction === reader.journal.transaction &&
          sameSessionTranscriptTargetBinding(value.target, hydration.target),
      );
    const joined = owner && sameSessionTranscriptTargetBinding(previous.target, owner.target);
    const published = {};
    let adopted = false;
    if (
      owner &&
      reader &&
      !reader.journal.stage({
        stage() {},
        commit() {},
        rollback: () => {
          if (
            !adopted ||
            this.publishedHydration !== published ||
            !sameSessionTranscriptTargetBinding(this.persistenceTarget, hydration.target)
          ) {
            return;
          }
          // A same-journal reload is canonical, even when the previous local view
          // was stale. Cross-target undo instead preserves the independently chosen view.
          this.restoreTranscriptViewImage(
            joined
              ? {
                  ...replacement,
                  identity: previous.identity,
                  owner: previous.owner,
                }
              : previous,
            true,
          );
        },
      })
    ) {
      throw new Error("Transcript hydration lost its original native snapshot");
    }
    this.restoreTranscriptViewImage(replacement, true);
    this.publishedHydration = published;
    this.nativeViewOwner = owner;
    adopted = true;
    if (owner && joined) {
      owner.disposition.hydrated = true;
    }
  }

  /** Prepare off-thread and publish the entire view only while this manager is unchanged. */
  setSessionTargetAsync(
    target: SessionTranscriptRuntimeTarget,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.hydrateSessionTarget(target, false, signal);
  }

  private async hydrateSessionTarget(
    target: SessionTranscriptRuntimeTarget,
    preserveCwd: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertTranscriptViewAvailable();
    const hydration = prepareSessionTranscriptHydration(target, this.boundedContextLimits, signal);
    const assertOwned = captureOwnedTranscriptWriteAssertion(hydration.target);
    const revision = ++this.hydrationRevision;
    const prior = this.captureTranscriptView();
    const entryCount = this.fileEntries.length;
    const opaqueCount = this.opaqueFileEntries.length;
    assertOwned();
    const prepared = await hydration.read().catch((error: unknown) => {
      assertOwned();
      throw error;
    });
    signal?.throwIfAborted();
    assertOwned();
    hydration.assertCurrent();
    this.assertTranscriptViewAvailable();
    const current = this.captureTranscriptView();
    if (
      revision !== this.hydrationRevision ||
      this.fileEntries.length !== entryCount ||
      this.opaqueFileEntries.length !== opaqueCount ||
      Object.keys(prior).some((key) => Reflect.get(prior, key) !== Reflect.get(current, key))
    ) {
      throw new Error("Session manager changed during transcript hydration");
    }
    // Validate and index a candidate first; a malformed transcript cannot damage the current view.
    const candidate = this.prepareHydratedView(hydration.target, prepared);
    Object.assign(this, candidate.captureTranscriptView());
    this.persistenceTarget = candidate.persistenceTarget;
    this.persistenceHeaderPending = candidate.persistenceHeaderPending;
    if (!preserveCwd) {
      this.cwd = candidate.fileEntries.find((entry) => entry.type === "session")?.cwd ?? this.cwd;
    }
    this.hydrationRevision++;
    this.publishedHydration = {};
    this.nativeViewOwner = undefined;
  }

  /** Reload an existing view without changing the runtime working directory. */
  async reloadPersistedTranscriptAsync(signal?: AbortSignal): Promise<void> {
    if (!this.persistenceTarget) {
      return;
    }
    await this.hydrateSessionTarget(this.persistenceTarget, true, signal);
  }

  /** Active-only loads can omit sibling rows even when they fit the context limits. */
  protected ensureCompletePersistedHistory(): void {
    this.assertTranscriptViewAvailable();
    if (!this.persistenceTarget || !this.boundedContextIncomplete) {
      return;
    }
    const limits = this.boundedContextLimits;
    this.boundedContextLimits = undefined;
    this.setSessionTarget(this.persistenceTarget);
    this.boundedContextLimits = limits;
  }

  protected setLoadedSessionTarget(
    target: SessionManagerPersistenceTarget | undefined,
    entries: readonly unknown[],
    bounded?: Pick<
      SessionTranscriptBoundedActiveContext,
      "activeLeafEntryId" | "version" | "opaqueParents" | "parents" | "firstKeptRanges"
    >,
    version?: SessionTranscriptContextVersion,
  ): void {
    this.assertTranscriptViewAvailable();
    this.transcriptVersion = version ?? bounded?.version;
    this.boundedFirstKeptById.clear();
    this.boundedParentIds.clear();
    const partitioned = partitionSessionFileEntries(entries);
    // Only a physically empty transcript may initialize lazily. Opaque persisted rows still need
    // a canonical header, or runtime would silently replace malformed history with a fresh session.
    if (partitioned.fileEntries.length === 0 && partitioned.opaqueEntries.length === 0) {
      this.persistenceTarget = target ? captureSessionTranscriptTargetBinding(target) : undefined;
      this.initializeSession({ id: target?.sessionId });
      this.persistenceHeaderPending = target !== undefined;
      return;
    }
    const header = partitioned.fileEntries.find((entry) => entry.type === "session");
    if (target) {
      assertCurrentSessionTranscriptHeader(header);
    }
    this.persistenceHeaderPending = false;
    this.persistenceTarget = target ? captureSessionTranscriptTargetBinding(target) : undefined;
    this.fileEntries = partitioned.fileEntries;
    this.opaqueFileEntries = partitioned.opaqueEntries;
    this.sessionId = header?.id ?? target?.sessionId ?? createManagedSessionId();
    this.migrated = migrateToCurrentVersion(
      this.fileEntries,
      partitioned.fileEntriesByOriginalIndex,
    );
    this.buildIndex();
    if (bounded) {
      this.boundedParentIds = new Map(bounded.parents);
      for (const [id, parentId] of bounded.opaqueParents) {
        this.opaqueParentsById.set(id, parentId);
      }
      this.adoptSelectedTranscriptPath(bounded.activeLeafEntryId, bounded.parents);
      for (const [boundaryId, range] of bounded.firstKeptRanges) {
        // An empty retained slice starts at the boundary itself, never at an
        // earlier ancestor. Opaque entries do not become model-context cut points.
        let firstKeptEntryId = boundaryId;
        for (let index = range.startIndex; index < range.endIndex; index++) {
          const entry = partitioned.fileEntriesByOriginalIndex[index];
          if (isIndexedSessionEntry(entry)) {
            firstKeptEntryId = entry.id;
            break;
          }
        }
        this.boundedFirstKeptById.set(boundaryId, firstKeptEntryId);
      }
    }
  }

  protected captureTranscriptViewRollback() {
    const previous = this.captureTranscriptViewImage();
    const target = this.persistenceTarget;
    const revision = this.hydrationRevision;
    const restore = (image = previous) => this.restoreTranscriptViewImage(image);
    let version = this.transcriptVersion;
    let count = this.fileEntries.length;
    let leaf = this.leafId;
    const rollback = (image = previous) => {
      // Rollback must not resurrect this branch over an independently replaced view.
      if (
        sameSessionTranscriptTargetBinding(this.persistenceTarget, target) &&
        this.publishedHydration === previous.identity &&
        this.fileEntries.length === count &&
        this.leafId === leaf &&
        this.transcriptVersion?.generation === version?.generation &&
        this.transcriptVersion?.rawSeq === version?.rawSeq &&
        this.transcriptVersion?.updatedAt === version?.updatedAt
      ) {
        restore(image);
      }
    };
    return {
      image: previous,
      restore,
      rollback,
      assertCurrent: () => {
        if (
          this.hydrationRevision !== revision ||
          !sameSessionTranscriptTargetBinding(this.persistenceTarget, target)
        ) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
      },
      checkpoint: () => {
        version = this.transcriptVersion;
        count = this.fileEntries.length;
        leaf = this.leafId;
      },
    };
  }

  private captureTranscriptViewImage() {
    const target = this.persistenceTarget;
    return {
      view: structuredClone(this.captureTranscriptView()),
      headerPending: this.persistenceHeaderPending,
      target,
      cwd: this.cwd,
      fence: target && {
        expectedLifecycleRevision: target.expectedLifecycleRevision,
        expectedWriterRunId: target.expectedWriterRunId,
      },
      // These are ownership identities, not data. Cloning them breaks reverse undo.
      identity: this.publishedHydration,
      owner: this.nativeViewOwner,
    };
  }

  private restoreTranscriptViewImage(
    image: ReturnType<SessionManagerCore["captureTranscriptViewImage"]>,
    replaceTarget = false,
  ): void {
    // A caught savepoint failure can publish this data while an outer inverse
    // still owns the image. Later local writes must not mutate that before-image.
    Object.assign(this, structuredClone(image.view));
    this.persistenceHeaderPending = image.headerPending;
    this.publishedHydration = image.identity;
    this.nativeViewOwner = image.owner;
    if (replaceTarget) {
      this.persistenceTarget = image.target;
      this.cwd = image.cwd;
    }
    if (this.persistenceTarget && image.fence) {
      Object.assign(this.persistenceTarget, image.fence);
    }
  }

  private prepareHydratedView(
    target: SessionManagerPersistenceTarget,
    prepared: PreparedSessionTranscriptReload,
    preserveCwd = true,
  ): SessionManagerCore {
    const candidate = new SessionManagerCore(this.cwd);
    candidate.persistenceTarget = target;
    candidate.boundedContextLimits = this.boundedContextLimits;
    candidate.adoptPreparedTranscriptReload(prepared);
    if (!preserveCwd) {
      candidate.cwd = candidate.getHeader()?.cwd ?? this.cwd;
    }
    return candidate;
  }

  protected captureNativeTranscriptViewRollback(onCommit: () => void) {
    const target = this.persistenceTarget!;
    let view = this.captureTranscriptViewRollback();
    let owner: NativeTranscriptViewOwner | undefined;
    let ownsLifetime = false;
    let messageSettled = false;
    let source: ReturnType<SessionManagerCore["captureTranscriptViewImage"]> | undefined;
    type EarlyBoundary = {
      view: typeof view;
      source: ReturnType<SessionManagerCore["captureTranscriptViewImage"]>;
      settled: boolean;
    };
    let early: EarlyBoundary | undefined;
    const retire = () => {
      if (!ownsLifetime || !owner) {
        return;
      }
      owner.disposition.live = false;
      if (this.nativeViewOwner === owner) {
        this.nativeViewOwner = undefined;
      }
    };
    const bindOwner = (
      database: DatabaseSync,
      path: string,
      journal: CapturedSqliteTransactionState,
    ) => {
      const previous = this.nativeViewOwner;
      const shared =
        previous?.disposition.live &&
        previous.database === database &&
        previous.journal.transaction === journal.transaction &&
        sameSessionTranscriptTargetBinding(previous.target, target);
      owner = shared
        ? previous
        : {
            database,
            path,
            journal,
            target,
            disposition: { live: true, hydrated: false },
          };
      ownsLifetime = !shared;
    };
    const readSource = (expected: Pick<NativeTranscriptViewOwner, "database" | "journal">) => {
      view.assertCurrent();
      let matched = false;
      const prepared = prepareSessionTranscriptHydration(
        target,
        this.boundedContextLimits,
      ).initializeReady((database) => {
        const journal = captureSqliteTransactionState(database);
        if (
          database !== expected.database ||
          journal?.transaction !== expected.journal.transaction
        ) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
        matched = true;
      });
      if (!matched) {
        throw new SessionTranscriptWriterClaimReboundError();
      }
      // An uninitialized transcript has no persisted header to replace the
      // manager's original lazy header. Descendant initialization can still roll back.
      return this.persistenceHeaderPending && prepared.snapshot.events.length === 0
        ? view.image
        : {
            ...this.prepareHydratedView(target, prepared).captureTranscriptViewImage(),
            identity: view.image.identity,
            owner: view.image.owner,
          };
    };
    if (this.nativePublicFresh.length) {
      const path = resolveOpenClawAgentSqlitePath(
        toDatabaseOptions(resolveSqliteTranscriptScope(target)),
      );
      const caller = this.nativePublicFresh.findLast(
        (frame) => frame.disposition.live && frame.path === path,
      );
      // Path selects only capture timing. The actual reader above must prove
      // this exact connection/journal before any tentative initialization begins.
      if (caller) {
        source = readSource(caller);
        bindOwner(caller.database, caller.path, caller.journal);
        const boundary: EarlyBoundary = { view, source, settled: false };
        early = boundary;
        if (
          !owner!.journal.stage({
            stage: () => {
              this.nativeViewOwner = owner;
            },
            commit: () => {
              boundary.settled = true;
              retire();
            },
            rollback: () => {
              if (boundary.settled) {
                return;
              }
              boundary.settled = true;
              boundary.view.rollback(
                owner!.disposition.hydrated ? boundary.source : boundary.view.image,
              );
              retire();
            },
          })
        ) {
          throw new Error("Native session view requires its original transaction");
        }
      }
    }
    return {
      enter: (
        database: { db: DatabaseSync; path: string },
        nested: boolean,
        initialized: boolean,
      ) => {
        view.assertCurrent();
        const journal = captureSqliteTransactionState(database.db);
        if (!journal) {
          throw new Error("Native session view requires its original transaction");
        }
        if (owner) {
          if (owner.database !== database.db || owner.journal.transaction !== journal.transaction) {
            throw new SessionTranscriptWriterClaimReboundError();
          }
          // Initialization already RELEASEd into the outer journal. A caught
          // message failure restores only this post-header savepoint boundary.
          view = this.captureTranscriptViewRollback();
          source = early && {
            ...early.source,
            identity: view.image.identity,
            owner: view.image.owner,
          };
        } else {
          if (!nested) {
            view = this.captureTranscriptViewRollback();
          }
          bindOwner(database.db, database.path, journal);
        }
        if (
          !owner!.journal.stage({
            stage: () => {
              this.nativeViewOwner = owner;
            },
            commit: () => {
              if (messageSettled) {
                return;
              }
              messageSettled = true;
              onCommit();
              if (!early) {
                retire();
              }
            },
            rollback: () => {
              if (messageSettled) {
                return;
              }
              messageSettled = true;
              view.rollback(owner!.disposition.hydrated && source ? source : view.image);
              if (early && !early.settled) {
                early.view.checkpoint();
              } else {
                retire();
              }
            },
          })
        ) {
          throw new Error("Native session view requires its original transaction");
        }
        // Only actual initializer/header work requires a second SQL before-image.
        // It belongs to the message savepoint, not the earlier pre-init boundary.
        if ((early && initialized) || (!source && this.nativePublicFresh.length)) {
          source = readSource(owner!);
        }
        return () => {
          view.checkpoint();
          if (early && !early.settled) {
            early.view.checkpoint();
          }
        };
      },
      enterPublicFresh: () => {
        if (!owner || !owner.disposition.live) {
          throw new Error("Native public callback lost its original transaction");
        }
        source ??= readSource(owner);
        this.nativePublicFresh.push(owner);
        return () => {
          this.nativePublicFresh.pop();
        };
      },
      assertCurrent: () => view.assertCurrent(),
      abort: () => {
        // Failed initialization can leave earlier RELEASEd work in the outer
        // transaction. Keep its inverse live until that original journal settles.
        if (early && !early.settled) {
          early.view.checkpoint();
        }
      },
    };
  }

  /** A nested native savepoint exposes its view locally, but cannot publish it as committed. */
  protected stageTranscriptView(update: () => void): () => void {
    const view = this.captureTranscriptViewRollback();
    try {
      update();
    } catch (error) {
      view.restore();
      throw error;
    }
    view.checkpoint();
    return view.rollback;
  }

  protected withTentativeTranscriptView<T>(update: () => T): T {
    const stage = captureSqliteWorkerCallerViewRollback(
      this.persistenceTarget?.[sessionTranscriptExecution]?.execution.incarnation,
    );
    // An unrelated native transaction cannot undo this target's committed view,
    // including when publication throws after its independently completed write.
    if (!stage) {
      return update();
    }
    let result: { value: T } | undefined;
    const rollback = this.stageTranscriptView(() => {
      result = { value: update() };
    });
    if (!stage(rollback)) {
      rollback();
      throw new Error("Tentative transcript view lost its original native snapshot");
    }
    return result!.value;
  }

  /** @deprecated Runtime callers should await reloadPersistedTranscriptAsync. */
  reloadPersistedTranscript(): void {
    this.assertTranscriptViewAvailable();
    if (this.persistenceTarget) {
      const runtimeCwd = this.cwd;
      this.setSessionTarget(this.persistenceTarget);
      this.cwd = runtimeCwd;
    }
  }

  /** Reloads a committed append without adopting a later user turn. */
  protected reloadPersistedTranscriptAfterAppend(
    expectedMutationAt: number | null,
    expectedEntryId: string,
    admittedUserId: string,
  ): void {
    if (!this.persistenceTarget) {
      return;
    }
    this.adoptPreparedTranscriptReload(
      prepareCommittedSessionTranscriptReload(this.persistenceTarget, this.boundedContextLimits),
      { expectedMutationAt, expectedEntryId, admittedUserId },
    );
  }

  /** Adopt owner-prepared bytes without reading SQLite again on the receiving thread. */
  protected adoptPreparedTranscriptReload(
    prepared: PreparedSessionTranscriptReload,
    append?: SessionTranscriptAppendExpectation,
  ): void {
    const target = this.persistenceTarget;
    if (!target) {
      return;
    }
    const runtimeCwd = this.cwd;
    const previousView = append ? structuredClone(this.captureTranscriptView()) : undefined;
    let reloaded = false;
    try {
      assertCommittedSessionTranscriptReload(prepared, append);
      if (prepared.kind === "bounded") {
        const bounded = prepared.snapshot;
        // SAFETY: SQLite transcript readers return the same persisted entry union used by SessionManager.
        const entries = bounded.events as FileEntry[];
        this.boundedContextIncomplete = true;
        this.persistedBoundaryCount = bounded.boundaryCount;
        this.persistedSuffixStartSeq = bounded.persistedSuffixStartSeq;
        this.transcriptMutationAt = bounded.transcriptMutationAt;
        this.setLoadedSessionTarget(target, entries, bounded);
        reloaded = true;
      } else {
        const snapshot = prepared.snapshot;
        // SAFETY: SQLite transcript readers return the same persisted entry union used by SessionManager.
        const entries = snapshot.events as FileEntry[];
        this.transcriptMutationAt = snapshot.version.updatedAt;
        this.setLoadedSessionTarget(target, entries, undefined, snapshot.version);
        reloaded = true;
      }
      if (!append) {
        return;
      }
      const activeBranch = this.getBranch();
      const admittedUserIndex = activeBranch.findIndex(
        (entry) => entry.id === append.admittedUserId,
      );
      const activeBranchHasNewerUser =
        admittedUserIndex < 0 ||
        activeBranch
          .slice(admittedUserIndex + 1)
          .some((entry) => entry.type === "message" && entry.message.role === "user");
      if (activeBranchHasNewerUser) {
        this.adoptSelectedTranscriptPath(
          append.expectedEntryId,
          [...this.byId].map(([id, entry]) => [id, entry.parentId]),
        );
      }
    } catch (error) {
      if (reloaded && previousView) {
        Object.assign(this, previousView);
      }
      throw error;
    } finally {
      this.cwd = runtimeCwd;
    }
  }
}

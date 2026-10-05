import { inspectTranscriptEventsSync } from "../../config/sessions/session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import type {
  SessionTranscriptBoundedActiveContext,
  SessionTranscriptContextVersion,
} from "../../config/sessions/session-accessor.sqlite-contract.js";
import { loadTranscriptReadSnapshotSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { bindCacheTtlProjectionPrefixes } from "../../config/sessions/session-cache-ttl-prefix.js";
import { assertCurrentSessionTranscriptHeader } from "../../config/sessions/session-entry-codec.js";
import { isSessionContextMessageEntry } from "../../config/sessions/session-history-context.js";
import {
  captureSessionTranscriptTargetBinding,
  sameSessionTranscriptTargetBinding,
} from "../../config/sessions/transcript-target-binding.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import {
  buildSessionTree,
  isIndexedSessionEntry,
  migrateToCurrentVersion,
  parseOpaqueLeafEntry,
  parseParentLinkedOpaqueEntry,
  partitionSessionFileEntries,
} from "./session-manager-codec.js";
import { createManagedSessionId, generateSessionEntryId } from "./session-manager-id.js";
import {
  prepareSessionManagerSync,
  captureSessionManagerIncognitoBinding,
  installSessionManagerIncognitoBinding,
} from "./session-manager-incognito-scope.js";
import { prepareSessionManagerHydration } from "./session-manager-incognito.js";
import {
  canReuseResidentSessionView,
  SessionManagerResidentNavigation,
  evictResidentSessionMessages,
  normalizeResidentSessionBoundary,
} from "./session-manager-resident-window.js";
import { sessionManagerResolveTranscriptSeq } from "./session-manager-transcript-seq.js";
import type {
  FileEntry,
  NewSessionOptions,
  PreservedOpaqueFileEntry,
  SessionEntry,
  SessionHeader,
  SessionInfoEntry,
  SessionTreeNode,
  SessionLeafControl,
} from "./session-manager-types.js";
import type {
  SessionManagerPersistenceTarget,
  SessionManagerBoundedContextLimits,
  PreparedSessionTranscriptReload,
  SessionManagerBoundedContext,
  SessionManagerBoundedView,
} from "./session-manager-view-types.js";

export class SessionManagerCore extends SessionManagerResidentNavigation {
  migrated = false;
  protected sessionId = "";
  protected transcriptVersion: SessionTranscriptContextVersion | undefined;
  private transcriptViewFailure: Error | undefined;
  private hydrationRevision = 0;
  protected cwd: string;
  protected fileEntries: FileEntry[] = [];
  protected opaqueFileEntries: PreservedOpaqueFileEntry[] = [];
  private boundedFirstKeptById = new Map<string, string>();
  protected cacheTtlProjectionPrefixes: SessionTranscriptBoundedActiveContext["cacheTtlProjectionPrefixes"];
  protected pendingDeliberateAppend = false;
  protected persistenceTarget: SessionManagerPersistenceTarget | undefined;
  protected persistenceHeaderPending = false;
  protected boundedContextLimits: SessionManagerBoundedContextLimits | undefined;
  protected boundedContextIncomplete = false;
  protected persistedBoundaryCount: number | undefined;
  protected persistedSuffixStartSeq: number | undefined;
  protected transcriptMutationAt: number | null | undefined;
  protected contextStartEntryId: string | null | undefined;

  constructor(
    cwd: string,
    persistenceTarget?: SessionManagerPersistenceTarget,
    loadedEntries?: readonly unknown[],
    boundedContext?: SessionManagerBoundedContext,
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
      boundedContext !== undefined ? boundedContext.transcriptMutationAt : version?.updatedAt;
    this.transcriptVersion = version ?? boundedContext?.version;
    if (persistenceTarget || loadedEntries) {
      this.setLoadedSessionTarget(persistenceTarget, loadedEntries ?? [], boundedContext, version);
      installSessionManagerIncognitoBinding(
        this,
        captureSessionManagerIncognitoBinding(persistenceTarget),
      );
    } else {
      this.newSession();
    }
  }

  /** @deprecated Runtime callers should await setSessionTargetAsync. */
  setSessionTarget(target: SessionTranscriptRuntimeTarget): void {
    prepareSessionManagerSync("setSessionTarget", target, this);
    this.setSessionTargetSync(target);
  }

  protected setSessionTargetSync(
    target: SessionTranscriptRuntimeTarget,
    preserveResident = false,
  ): void {
    this.assertTranscriptViewAvailable();
    this.hydrationRevision++;
    const capturedTarget = captureSessionTranscriptTargetBinding(target);
    const bounded = this.boundedContextLimits
      ? readSessionTranscriptBoundedActiveContextCore(capturedTarget, this.boundedContextLimits)
      : undefined;
    const current = preserveResident ? this.captureTranscriptView() : undefined;
    if (canReuseResidentSessionView(current, this.persistenceTarget, capturedTarget, bounded)) {
      return;
    }
    const snapshot = bounded ? undefined : loadTranscriptReadSnapshotSync(capturedTarget);
    const entries = (bounded?.events ?? snapshot?.events ?? []) as FileEntry[];
    this.boundedContextIncomplete = bounded !== undefined;
    this.persistedBoundaryCount = bounded?.boundaryCount;
    this.persistedSuffixStartSeq = bounded?.persistedSuffixStartSeq;
    this.transcriptMutationAt =
      bounded !== undefined ? bounded.transcriptMutationAt : snapshot?.version.updatedAt;
    const header = entries.find(
      (entry) => typeof entry === "object" && entry !== null && entry.type === "session",
    );
    this.setLoadedSessionTarget(
      capturedTarget,
      entries,
      bounded,
      bounded?.version ?? snapshot?.version,
    );
    if (header?.cwd) {
      this.cwd = header.cwd;
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
    const capturedTarget = captureSessionTranscriptTargetBinding(target);
    const retarget =
      !preserveCwd && !sameSessionTranscriptTargetBinding(capturedTarget, this.persistenceTarget);
    const hydration = prepareSessionManagerHydration(
      capturedTarget,
      this.boundedContextLimits
        ? { ...this.boundedContextLimits, retainContextUsageEvidence: true }
        : undefined,
      signal,
      this,
      retarget,
    );
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
    this.adoptPreparedTranscriptReload(prepared, undefined, hydration.target);
    installSessionManagerIncognitoBinding(this, hydration.incognitoBinding);
    if (!preserveCwd) {
      this.cwd = this.fileEntries.find((entry) => entry.type === "session")?.cwd ?? this.cwd;
    }
    this.hydrationRevision++;
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
    this.setSessionTargetSync(this.persistenceTarget);
    this.boundedContextLimits = limits;
  }

  protected setLoadedSessionTarget(
    target: SessionManagerPersistenceTarget | undefined,
    entries: readonly unknown[],
    bounded?: SessionManagerBoundedView,
    version?: SessionTranscriptContextVersion,
  ): void {
    this.assertTranscriptViewAvailable();
    this.transcriptVersion = version ?? bounded?.version;
    this.cacheTtlProjectionPrefixes = undefined;
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
    this.buildIndex(
      this.bindSnapshotResidentEntries(partitioned.fileEntriesByOriginalIndex, bounded),
    );
    this.transcriptSeqByEntryId = new Map(bounded?.entryTranscriptSeqs);
    if (bounded) {
      this.boundedParentIds = new Map(bounded.parents);
      for (const [id, parentId] of bounded.opaqueParents) {
        this.opaqueParentsById.set(id, parentId);
      }
      this.adoptSelectedTranscriptPath(
        bounded.selectedLeafEntryId,
        bounded.activeLeafEntryId,
        [...bounded.parents]
          .filter(([id]) => this.byId.has(id))
          .map(([id, parent]) => [id, parent.canonicalParentId]),
      );
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
      this.cacheTtlProjectionPrefixes = bindCacheTtlProjectionPrefixes(bounded, this);
    }
    this.contextStartEntryId =
      bounded?.contextStartEntryId !== undefined
        ? bounded.contextStartEntryId
        : bounded
          ? (this.getBranch().find(isSessionContextMessageEntry)?.id ?? null)
          : undefined;
  }

  /** The loaded view only: bounded managers must never hydrate inactive history for a rewrite. */
  protected captureTranscriptView(copy = false) {
    this.assertTranscriptViewAvailable();
    return {
      sessionId: this.sessionId,
      transcriptVersion: this.transcriptVersion,
      persistenceHeaderPending: this.persistenceHeaderPending,
      migrated: this.migrated,
      fileEntries: copy ? [...this.fileEntries] : this.fileEntries,
      opaqueFileEntries: copy
        ? this.opaqueFileEntries.map((entry) => ({ ...entry }))
        : this.opaqueFileEntries,
      ...this.captureResidentNavigation(copy),
      boundedFirstKeptById: copy ? new Map(this.boundedFirstKeptById) : this.boundedFirstKeptById,
      cacheTtlProjectionPrefixes: this.cacheTtlProjectionPrefixes,
      boundedContextIncomplete: this.boundedContextIncomplete,
      boundedContextLimits: this.boundedContextLimits,
      persistedBoundaryCount: this.persistedBoundaryCount,
      persistedSuffixStartSeq: this.persistedSuffixStartSeq,
      transcriptMutationAt: this.transcriptMutationAt,
      contextStartEntryId: this.contextStartEntryId,
      leafId: this.leafId,
      rawLeafId: this.rawLeafId,
      appendParentId: this.appendParentId,
      appendMode: this.appendMode,
      pendingDeliberateAppend: this.pendingDeliberateAppend,
    };
  }

  /** @deprecated Runtime callers should await reloadPersistedTranscriptAsync. */
  reloadPersistedTranscript(): void {
    prepareSessionManagerSync("reloadPersistedTranscript", this.persistenceTarget, this);
    this.reloadPersistedTranscriptSync();
  }

  protected reloadPersistedTranscriptSync(): void {
    this.assertTranscriptViewAvailable();
    if (this.persistenceTarget) {
      const runtimeCwd = this.cwd;
      this.setSessionTargetSync(this.persistenceTarget, true);
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
    const target = this.persistenceTarget;
    if (this.boundedContextLimits) {
      this.adoptPreparedTranscriptReload(
        {
          kind: "bounded",
          snapshot: readSessionTranscriptBoundedActiveContextCore(target, {
            ...this.boundedContextLimits,
            ignoreReadFence: true,
          }),
        },
        { expectedMutationAt, expectedEntryId, admittedUserId },
      );
    } else {
      const inspected = inspectTranscriptEventsSync(target);
      this.adoptPreparedTranscriptReload(
        {
          kind: "full",
          snapshot: {
            events: inspected.events,
            version: {
              generation: inspected.snapshot.generation,
              rawSeq: inspected.snapshot.lastSeq,
              updatedAt: inspected.snapshot.transcriptUpdatedAt,
            },
          },
        },
        { expectedMutationAt, expectedEntryId, admittedUserId },
      );
    }
  }

  /** Adopt owner-prepared bytes without reading SQLite again on the receiving thread. */
  protected adoptPreparedTranscriptReload(
    prepared: PreparedSessionTranscriptReload,
    append?: { expectedMutationAt: number | null; expectedEntryId: string; admittedUserId: string },
    target = this.persistenceTarget,
  ): void {
    if (!target) {
      return;
    }
    const { events, version } = prepared.snapshot;
    const bounded = prepared.kind === "bounded" ? prepared.snapshot : undefined;
    const mutationAt = bounded ? bounded.transcriptMutationAt : version.updatedAt;
    if (
      append &&
      mutationAt !== append.expectedMutationAt &&
      !events.some((entry) => isIndexedSessionEntry(entry) && entry.id === append.expectedEntryId)
    ) {
      throw new Error("SQLite transcript changed before adopting the committed append");
    }
    // Validate the replacement before publication; the retained view needs no rollback copy.
    const candidate = new SessionManagerCore(this.cwd);
    candidate.boundedContextLimits = this.boundedContextLimits;
    candidate.boundedContextIncomplete = bounded !== undefined;
    candidate.persistedBoundaryCount = bounded?.boundaryCount;
    candidate.persistedSuffixStartSeq = bounded?.persistedSuffixStartSeq;
    candidate.transcriptMutationAt = mutationAt;
    candidate.setLoadedSessionTarget(target, events, bounded, version);
    if (append) {
      const activeBranch = candidate.getBranch();
      const admittedUserIndex = activeBranch.findIndex(
        (entry) => entry.id === append.admittedUserId,
      );
      const activeBranchHasNewerUser =
        admittedUserIndex < 0 ||
        activeBranch
          .slice(admittedUserIndex + 1)
          .some((entry) => entry.type === "message" && entry.message.role === "user");
      if (activeBranchHasNewerUser) {
        candidate.adoptSelectedTranscriptPath(
          append.expectedEntryId,
          append.expectedEntryId,
          [...candidate.byId].map(([id, entry]) => [id, entry.parentId]),
        );
      }
    }
    Object.assign(this, candidate.captureTranscriptView());
    this.persistenceTarget = candidate.persistenceTarget;
  }

  newSession(options?: NewSessionOptions): string | undefined {
    if (this.persistenceTarget) {
      throw new Error("Persisted session managers cannot change session identity in place");
    }
    return this.initializeSession(options);
  }

  private initializeSession(options?: NewSessionOptions): string | undefined {
    this.sessionId = options?.id ?? this.persistenceTarget?.sessionId ?? createManagedSessionId();
    this.migrated = false;
    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: this.sessionId,
      timestamp: new Date().toISOString(),
      cwd: this.cwd,
      parentSession: options?.parentSession,
    };
    this.fileEntries = [header];
    this.opaqueFileEntries = [];
    this.clearNavigation();
    this.cacheTtlProjectionPrefixes = undefined;
    this.boundedFirstKeptById.clear();
    this.boundedParentIds.clear();
    this.pendingDeliberateAppend = false;
    this.contextStartEntryId = this.boundedContextLimits ? null : undefined;
    this.residentContextEntries = this.boundedContextLimits ? new Set() : undefined;
    return this.persistenceTarget ? this.sessionId : undefined;
  }

  protected buildIndex(admittedLabels = this.admittedLabelRecords): void {
    this.clearNavigation();
    this.pendingDeliberateAppend = false;
    let opaqueIndex = 0;
    for (let index = 0; index <= this.fileEntries.length; index += 1) {
      while (this.opaqueFileEntries[opaqueIndex]?.index === index) {
        this.appendOpaqueNavigationRecord(this.opaqueFileEntries[opaqueIndex]?.record);
        opaqueIndex += 1;
      }
      const entry = this.fileEntries[index];
      // Current entries were validated by partition/append. Legacy imports retain readable rows
      // through migration, so only those need the final shape check before indexing.
      if (!entry || entry.type === "session" || (this.migrated && !isIndexedSessionEntry(entry))) {
        continue;
      }
      this.appendCanonicalNavigationEntry(entry, undefined, admittedLabels.get(entry));
    }
    this.finishNavigation();
  }

  protected enforceResidentBudget(selectedContext?: ReadonlySet<SessionEntry>): void {
    if (!this.persistenceTarget || !this.boundedContextLimits) {
      return;
    }
    const branch = this.getBranch();
    this.resolveTranscriptEntrySeq(branch.at(-1)?.id);
    const view = this.captureTranscriptView();
    if (
      evictResidentSessionMessages(
        view,
        this.boundedContextLimits,
        branch,
        (entry) => this.resolveEntryParentId(entry),
        selectedContext,
      )
    ) {
      Object.assign(this, view);
      this.boundedContextIncomplete = true;
    }
  }

  [sessionManagerResolveTranscriptSeq](entryId: string | null | undefined): number | undefined {
    this.assertTranscriptViewAvailable();
    return this.resolveTranscriptEntrySeq(entryId);
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

  protected override normalizeEntryParent(entry: SessionEntry): SessionEntry {
    const normalized = super.normalizeEntryParent(entry);
    if (normalized.type !== "compaction" && normalized.type !== "reset") {
      return normalized;
    }
    return normalizeResidentSessionBoundary(
      normalized,
      this.boundedFirstKeptById.get(normalized.id),
      this.resolveEntryParentId(entry),
      this.byId,
      this.opaqueParentsById,
      this.fileEntries,
    );
  }

  protected resolveBranchTargetId(branchFromId: string): string | null | undefined {
    if (this.byId.has(branchFromId)) {
      return branchFromId;
    }
    return this.opaqueParentsById.has(branchFromId)
      ? this.resolveCanonicalParentId(branchFromId)
      : undefined;
  }

  protected clampOpaqueFileEntryIndexes(): void {
    let previousOpaqueIndex = 0;
    for (const opaqueEntry of this.opaqueFileEntries) {
      opaqueEntry.index = Math.max(
        previousOpaqueIndex,
        Math.min(opaqueEntry.index, this.fileEntries.length),
      );
      previousOpaqueIndex = opaqueEntry.index;
    }
  }

  protected createLeafControl(
    parentId: string | null,
    appendParentId: string | null = this.appendParentId,
    appendMode?: "side",
    targetId: string | null = this.rawLeafId,
  ): SessionLeafControl {
    return {
      type: "leaf",
      id: generateSessionEntryId(),
      parentId,
      timestamp: new Date().toISOString(),
      targetId,
      ...(appendParentId !== targetId ? { appendParentId } : {}),
      ...(appendMode ? { appendMode } : {}),
    };
  }

  protected rememberLeafControl(
    leafEntry: SessionLeafControl,
    selectedTargetId = leafEntry.targetId,
  ): void {
    this.opaqueFileEntries.push({ index: this.fileEntries.length, record: leafEntry });
    this.opaqueParentsById.set(leafEntry.id, selectedTargetId);
  }

  getSessionName(): string | undefined {
    this.assertTranscriptViewAvailable();
    const sessionInfo = this.fileEntries.findLast(
      (entry): entry is SessionInfoEntry =>
        entry.type === "session_info" && this.byId.has(entry.id),
    );
    return sessionInfo?.name?.trim() || undefined;
  }

  getChildren(parentId: string): SessionEntry[] {
    this.assertTranscriptViewAvailable();
    const children: SessionEntry[] = [];
    for (const entry of this.byId.values()) {
      const normalizedEntry = this.normalizeEntryParent(entry);
      if (normalizedEntry.parentId === parentId) {
        children.push(normalizedEntry);
      }
    }
    return children;
  }

  getLabel(id: string): string | undefined {
    this.assertTranscriptViewAvailable();
    return this.labelsById.get(id);
  }

  getBoundaryCount(): number {
    this.assertTranscriptViewAvailable();
    return (
      this.persistedBoundaryCount ??
      this.getBranch().filter((entry) => entry.type === "compaction" || entry.type === "reset")
        .length
    );
  }

  getHeader(): SessionHeader | null {
    this.assertTranscriptViewAvailable();
    return this.fileEntries.find((entry) => entry.type === "session") ?? null;
  }

  getEntries(): SessionEntry[] {
    this.assertTranscriptViewAvailable();
    return this.fileEntries
      .filter((entry): entry is SessionEntry => entry.type !== "session" && this.byId.has(entry.id))
      .map((entry) => this.normalizeEntryParent(entry));
  }

  getTree(): SessionTreeNode[] {
    return buildSessionTree(this.getEntries(), this.labelsById, this.labelTimestampsById);
  }

  getLeafId(): string | null {
    this.assertTranscriptViewAvailable();
    return this.leafId;
  }

  getLeafEntry(): SessionEntry | undefined {
    this.assertTranscriptViewAvailable();
    return this.leafId ? this.getEntry(this.leafId) : undefined;
  }

  getEntry(id: string): SessionEntry | undefined {
    this.assertTranscriptViewAvailable();
    const entry = this.byId.get(id);
    return entry ? this.normalizeEntryParent(entry) : undefined;
  }

  getAppendParentId(): string | null {
    this.assertTranscriptViewAvailable();
    return this.appendParentId;
  }

  getAppendMode(): "side" | undefined {
    this.assertTranscriptViewAvailable();
    return this.appendMode;
  }

  protected getPersistedFileEntries(leafAppendMode?: "side", persistSelection = false): unknown[] {
    this.assertTranscriptViewAvailable();
    this.clampOpaqueFileEntryIndexes();
    const entries: unknown[] = [];
    let opaqueIndex = 0;
    for (let index = 0; index <= this.fileEntries.length; index += 1) {
      while (this.opaqueFileEntries[opaqueIndex]?.index === index) {
        entries.push(this.opaqueFileEntries[opaqueIndex]?.record);
        opaqueIndex += 1;
      }
      const entry = this.fileEntries[index];
      if (entry) {
        entries.push(entry);
      }
    }
    while (opaqueIndex < this.opaqueFileEntries.length) {
      entries.push(this.opaqueFileEntries[opaqueIndex]?.record);
      opaqueIndex += 1;
    }

    let persistedLeafId: string | null = null;
    let persistedAppendParentId: string | null = null;
    let rawTailId: string | null = null;
    for (const entry of entries) {
      const leafEntry = parseOpaqueLeafEntry(entry);
      if (leafEntry) {
        rawTailId = leafEntry.id;
        if (this.invalidLeafControlIds.has(leafEntry.id)) {
          continue;
        }
        persistedLeafId = leafEntry.targetId;
        persistedAppendParentId =
          leafEntry.appendParentId === undefined
            ? persistedLeafId
            : this.resolveOpaqueAppendParentId(leafEntry.appendParentId);
        continue;
      }
      if (isIndexedSessionEntry(entry)) {
        persistedLeafId = entry.id;
        persistedAppendParentId = entry.id;
        rawTailId = entry.id;
        continue;
      }
      const opaqueLink = parseParentLinkedOpaqueEntry(entry);
      if (opaqueLink) {
        persistedAppendParentId = opaqueLink.id;
        rawTailId = opaqueLink.id;
      }
    }
    if (
      persistSelection ||
      persistedLeafId !== this.rawLeafId ||
      persistedAppendParentId !== this.appendParentId
    ) {
      const leafEntry = this.createLeafControl(rawTailId, this.appendParentId, leafAppendMode);
      this.rememberLeafControl(leafEntry);
      entries.push(leafEntry);
    }
    return entries;
  }

  getPersistedEntries(): unknown[] {
    return this.getPersistedFileEntries();
  }

  clearPreservedOpaqueFileEntries(): void {
    this.assertTranscriptViewAvailable();
    this.opaqueFileEntries = [];
    this.opaqueParentsById.clear();
    this.invalidLeafControlIds.clear();
    this.appendParentId = null;
    this.appendMode = undefined;
    this.pendingDeliberateAppend = false;
  }

  protected invalidateTranscriptView(error: Error): void {
    this.transcriptViewFailure = error;
    this.transcriptVersion = undefined;
  }

  protected assertTranscriptViewAvailable(): void {
    if (this.transcriptViewFailure) {
      throw this.transcriptViewFailure;
    }
  }

  override getBranch(fromId?: string): SessionEntry[] {
    this.assertTranscriptViewAvailable();
    return super.getBranch(fromId);
  }

  isPersisted(): boolean {
    return this.persistenceTarget !== undefined;
  }

  getCwd(): string {
    return this.cwd;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionTarget(): SessionManagerPersistenceTarget | undefined {
    const target = this.persistenceTarget;
    return target ? { ...target, ...(target.env ? { env: { ...target.env } } : {}) } : undefined;
  }
}

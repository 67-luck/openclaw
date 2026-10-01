import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import {
  resolveOpaqueSessionFirstKeptEntryId,
  SessionEntryNavigation,
} from "../../config/sessions/session-entry-navigation.js";
import { sessionTranscriptExecution } from "../../config/sessions/transcript-target-binding.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  pendingToolResultEntries,
  selectActivePendingToolResults,
  type PendingToolResultOccurrence,
} from "../session-tool-result-pending-facts.js";
import {
  createSessionToolResultPending,
  sessionToolResultPending,
} from "../session-tool-result-pending.js";
import {
  isIndexedSessionEntry,
  parseOpaqueLeafEntry,
  parseParentLinkedOpaqueEntry,
} from "./session-manager-codec.js";
import { createManagedSessionId, generateSessionEntryId } from "./session-manager-id.js";
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
} from "./session-manager-view-types.js";

// Loaded state stays on the manager instance. Core invokes initialization only
// after its fields and cwd are ready, and owns hydration and rollback journals.
export abstract class SessionManagerView extends SessionEntryNavigation<SessionEntry> {
  protected abstract cwd: string;
  protected readonly pendingToolResults = createSessionToolResultPending();
  get [sessionToolResultPending]() {
    const target = this.persistenceTarget;
    return {
      pending: this.pendingToolResults,
      selectActive: <T extends PendingToolResultOccurrence>(calls: readonly T[]) => {
        // Derive from the canonical view so branch changes and transaction inverses
        // share one projection without replacing the original pending objects.
        const entries = calls.length
          ? pendingToolResultEntries(this.getBranch(), this.getLeafId())
          : [];
        return { entries, calls: selectActivePendingToolResults(entries, calls) };
      },
      owner: target
        ? {
            sessionId: target.sessionId,
            databasePath:
              target[sessionTranscriptExecution]?.execution.path ??
              resolveOpenClawAgentSqlitePath(
                toDatabaseOptions(resolveSqliteTranscriptScope(target)),
              ),
          }
        : undefined,
    };
  }
  migrated = false;
  protected sessionId = "";
  protected transcriptVersion: SessionTranscriptContextVersion | undefined;
  private transcriptViewFailure: Error | undefined;
  protected fileEntries: FileEntry[] = [];
  protected opaqueFileEntries: PreservedOpaqueFileEntry[] = [];
  protected boundedParentIds = new Map<string, string | null>();
  protected boundedFirstKeptById = new Map<string, string>();
  protected pendingDeliberateAppend = false;
  protected persistenceTarget: SessionManagerPersistenceTarget | undefined;
  protected persistenceHeaderPending = false;
  protected boundedContextLimits: SessionManagerBoundedContextLimits | undefined;
  protected boundedContextIncomplete = false;
  protected persistedBoundaryCount: number | undefined;
  protected persistedSuffixStartSeq: number | undefined;
  protected transcriptMutationAt: number | null | undefined;

  newSession(options?: NewSessionOptions): string | undefined {
    if (this.persistenceTarget) {
      throw new Error("Persisted session managers cannot change session identity in place");
    }
    return this.initializeSession(options);
  }

  protected initializeSession(options?: NewSessionOptions): string | undefined {
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
    this.boundedFirstKeptById.clear();
    this.boundedParentIds.clear();
    this.pendingDeliberateAppend = false;
    return this.persistenceTarget ? this.sessionId : undefined;
  }

  protected adoptSelectedTranscriptPath(
    appendParentId: string | null,
    parents: Iterable<readonly [string, string | null]>,
  ): void {
    // Selected payloads omit navigation controls. Use their resolved ancestry,
    // not the side-append parent guesses made while indexing those payloads.
    this.logicalParentsById.clear();
    for (const [id, parentId] of parents) {
      this.logicalParentsById.set(id, this.resolveCanonicalParentId(parentId));
    }
    this.appendParentId = appendParentId;
    this.leafId = this.resolveOpaqueLeafTargetId(appendParentId);
    this.appendMode = undefined;
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
      byId: copy ? new Map(this.byId) : this.byId,
      opaqueParentsById: copy ? new Map(this.opaqueParentsById) : this.opaqueParentsById,
      logicalParentsById: copy ? new Map(this.logicalParentsById) : this.logicalParentsById,
      invalidLeafControlIds: copy
        ? new Set(this.invalidLeafControlIds)
        : this.invalidLeafControlIds,
      labelsById: copy ? new Map(this.labelsById) : this.labelsById,
      labelTimestampsById: copy ? new Map(this.labelTimestampsById) : this.labelTimestampsById,
      boundedFirstKeptById: copy ? new Map(this.boundedFirstKeptById) : this.boundedFirstKeptById,
      boundedParentIds: copy ? new Map(this.boundedParentIds) : this.boundedParentIds,
      boundedContextIncomplete: this.boundedContextIncomplete,
      boundedContextLimits: this.boundedContextLimits,
      persistedBoundaryCount: this.persistedBoundaryCount,
      persistedSuffixStartSeq: this.persistedSuffixStartSeq,
      transcriptMutationAt: this.transcriptMutationAt,
      leafId: this.leafId,
      appendParentId: this.appendParentId,
      appendMode: this.appendMode,
      pendingDeliberateAppend: this.pendingDeliberateAppend,
    };
  }

  protected buildIndex(): void {
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
      this.appendCanonicalNavigationEntry(entry);
    }
    this.finishNavigation();
  }

  protected override normalizeEntryParent(entry: SessionEntry): SessionEntry {
    let normalized = super.normalizeEntryParent(entry);
    const boundedFirstKept = this.boundedFirstKeptById.get(normalized.id);
    if (
      boundedFirstKept !== undefined &&
      (normalized.type === "compaction" || normalized.type === "reset")
    ) {
      normalized = { ...normalized, firstKeptEntryId: boundedFirstKept };
    }
    if (
      (normalized.type === "compaction" || normalized.type === "reset") &&
      normalized.firstKeptEntryId !== undefined &&
      !this.byId.has(normalized.firstKeptEntryId) &&
      this.opaqueParentsById.has(normalized.firstKeptEntryId)
    ) {
      const firstKeptEntryId = resolveOpaqueSessionFirstKeptEntryId({
        firstKeptEntryId: normalized.firstKeptEntryId,
        parentId: normalized.parentId,
        fallbackParentId: this.resolveEntryParentId(entry),
        byId: this.byId,
        opaqueParentsById: this.opaqueParentsById,
        entries: () => this.fileEntries.filter(isIndexedSessionEntry),
      });
      if (firstKeptEntryId && firstKeptEntryId !== normalized.firstKeptEntryId) {
        normalized = { ...normalized, firstKeptEntryId };
      }
    }
    return normalized;
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
  ): SessionLeafControl {
    return {
      type: "leaf",
      id: generateSessionEntryId(),
      parentId,
      timestamp: new Date().toISOString(),
      targetId: this.leafId,
      ...(appendParentId !== this.leafId ? { appendParentId } : {}),
      ...(appendMode ? { appendMode } : {}),
    };
  }

  protected rememberLeafControl(leafEntry: SessionLeafControl): void {
    this.opaqueFileEntries.push({ index: this.fileEntries.length, record: leafEntry });
    this.opaqueParentsById.set(leafEntry.id, leafEntry.targetId);
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
    const entries = this.getEntries();
    const nodeMap = new Map<string, SessionTreeNode>();
    const roots: SessionTreeNode[] = [];
    for (const entry of entries) {
      nodeMap.set(entry.id, {
        entry,
        children: [],
        label: this.labelsById.get(entry.id),
        labelTimestamp: this.labelTimestampsById.get(entry.id),
      });
    }
    for (const entry of entries) {
      const node = nodeMap.get(entry.id)!;
      const parentId = this.resolveCanonicalParentId(entry.parentId);
      const parent = parentId !== null && parentId !== entry.id ? nodeMap.get(parentId) : undefined;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
    const stack = [...roots];
    while (stack.length > 0) {
      const node = stack.pop()!;
      node.children.sort(
        (left, right) =>
          new Date(left.entry.timestamp).getTime() - new Date(right.entry.timestamp).getTime(),
      );
      stack.push(...node.children);
    }
    return roots;
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

  protected getPersistedFileEntries(
    leafAppendParentId: string | null = this.appendParentId,
    leafAppendMode?: "side",
  ): unknown[] {
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
        const targetId = this.resolveOpaqueLeafTargetId(leafEntry.targetId);
        persistedLeafId = targetId;
        persistedAppendParentId =
          leafEntry.appendParentId === undefined
            ? targetId
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
    if (persistedLeafId !== this.leafId || persistedAppendParentId !== this.appendParentId) {
      const leafEntry = this.createLeafControl(rawTailId, leafAppendParentId, leafAppendMode);
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

  /** No buffered writes remain here; asynchronous metadata methods own their settlement. */
  protected flushPendingPersistence(): void {}

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

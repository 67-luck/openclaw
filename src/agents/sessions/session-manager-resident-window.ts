import type {
  SessionTranscriptBoundedActiveContext,
  SessionTranscriptContextVersion,
} from "../../config/sessions/session-accessor.sqlite-contract.js";
import { selectSessionResidentEvidence } from "../../config/sessions/session-context-usage-evidence.js";
import {
  isIndexedSessionEntry,
  parseOpaqueLeafEntry,
  parseParentLinkedOpaqueEntry,
} from "../../config/sessions/session-entry-codec.js";
import {
  SessionEntryNavigation,
  resolveOpaqueSessionFirstKeptEntryId,
  resolveSessionCanonicalParentId,
  type SessionLabelAdmission,
} from "../../config/sessions/session-entry-navigation.js";
import {
  isSessionContextMessageEntry,
  selectSessionHistoryWindow,
} from "../../config/sessions/session-history-context.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import type { FileEntry, PreservedOpaqueFileEntry, SessionEntry } from "./session-manager-types.js";
import type {
  SessionManagerBoundedContextLimits,
  SessionManagerPersistenceTarget,
} from "./session-manager-view-types.js";

type ResidentView = {
  fileEntries: FileEntry[];
  opaqueFileEntries: PreservedOpaqueFileEntry[];
  byId: Map<string, SessionEntry>;
  residentContextEntries: Set<SessionEntry> | undefined;
  logicalParentsById: Map<string, string | null>;
  boundedParentIds: SessionTranscriptBoundedActiveContext["parents"];
  transcriptSeqByEntryId: Map<string, number>;
  cacheTtlProjectionPrefixes: SessionTranscriptBoundedActiveContext["cacheTtlProjectionPrefixes"];
  boundedFirstKeptById: Map<string, string>;
  opaqueParentsById: Map<string, string | null>;
  labelsById: Map<string, string>;
  labelTimestampsById: Map<string, string | undefined>;
  leafId: string | null;
  rawLeafId: string | null;
  appendParentId: string | null;
};

/** Resident canonical ancestry and ordinals share one publication and pruning lifecycle. */
export class SessionManagerResidentNavigation extends SessionEntryNavigation<SessionEntry> {
  protected boundedParentIds: SessionTranscriptBoundedActiveContext["parents"] = new Map();
  protected transcriptSeqByEntryId = new Map<string, number>();
  protected residentContextEntries: Set<SessionEntry> | undefined;

  protected captureResidentNavigation(copy: boolean) {
    return {
      byId: copy ? new Map(this.byId) : this.byId,
      opaqueParentsById: copy ? new Map(this.opaqueParentsById) : this.opaqueParentsById,
      logicalParentsById: copy ? new Map(this.logicalParentsById) : this.logicalParentsById,
      invalidLeafControlIds: copy
        ? new Set(this.invalidLeafControlIds)
        : this.invalidLeafControlIds,
      labelsById: copy ? new Map(this.labelsById) : this.labelsById,
      labelTimestampsById: copy ? new Map(this.labelTimestampsById) : this.labelTimestampsById,
      admittedLabelRecords: copy ? new Map(this.admittedLabelRecords) : this.admittedLabelRecords,
      boundedParentIds: copy ? new Map(this.boundedParentIds) : this.boundedParentIds,
      residentContextEntries:
        copy && this.residentContextEntries
          ? new Set(this.residentContextEntries)
          : this.residentContextEntries,
      transcriptSeqByEntryId: copy
        ? new Map(this.transcriptSeqByEntryId)
        : this.transcriptSeqByEntryId,
    };
  }

  protected captureTranscriptEntrySeqs(entryIds: Iterable<string>): Map<string, number> {
    const retained = new Map<string, number>();
    for (const id of entryIds) {
      const seq = this.transcriptSeqByEntryId.get(id);
      if (seq !== undefined) {
        retained.set(id, seq);
      }
    }
    return retained;
  }

  protected admitResidentContextEntry(entry: SessionEntry | undefined): void {
    if (entry && isSessionContextMessageEntry(entry)) {
      this.residentContextEntries?.add(entry);
    }
  }

  protected selectCurrentResidentContext(
    limits: SessionManagerBoundedContextLimits | undefined,
    header: FileEntry | null,
  ) {
    if (!this.residentContextEntries && !limits) {
      return undefined;
    }
    const branch = this.getBranch();
    const window = limits
      ? selectSessionHistoryWindow(branch, {
          ...limits,
          headerBytes: header ? serializedEntryBytes(header) : 0,
          retainedEntryIds: new Set(
            [...this.byId.values()]
              .filter((entry) => entry.type !== "message")
              .map((entry) => entry.id),
          ),
          // Rewrite preparations remain mutable until storage redaction and receipt adoption.
          bytesFor: (entry) => serializedEntryBytes(this.byId.get(entry.id)!),
        })
      : undefined;
    const members = new Set(
      [...(window?.modelEntries ?? branch.filter(isSessionContextMessageEntry))].map((entry) =>
        this.byId.get(entry.id)!,
      ),
    );
    this.residentContextEntries = members;
    return {
      entries: members,
      contextStartEntryId: window
        ? window.contextStartEntryId
        : (branch.find((entry) => members.has(this.byId.get(entry.id)!))?.id ?? null),
    };
  }

  /** Controlled copies inherit prompt membership from their captured source records. */
  protected inheritResidentContextEntries(
    source: SessionManagerResidentNavigation,
    replacements?: ReadonlyMap<string, SessionEntry>,
  ): void {
    const prior = source.residentContextEntries;
    const current = this.residentContextEntries;
    this.residentContextEntries =
      prior === undefined
        ? undefined
        : new Set(
            [...this.byId.values()].filter((entry) => {
              const replacement = replacements?.get(entry.id);
              const original = source.byId.get(replacement?.id ?? entry.id);
              return original ? prior.has(original) : current?.has(entry) === true;
            }),
          );
  }

  protected bindSnapshotResidentEntries(
    entries: readonly (FileEntry | undefined)[],
    snapshot:
      | Pick<
          SessionTranscriptBoundedActiveContext,
          "admittedLabelRecords" | "residentContextEntryIndexes"
        >
      | undefined,
  ): Map<SessionEntry, SessionLabelAdmission> {
    this.residentContextEntries = snapshot
      ? new Set(
          snapshot.residentContextEntryIndexes.flatMap((index) => {
            const entry = entries[index];
            return entry && entry.type !== "session" ? [entry] : [];
          }),
        )
      : undefined;
    const admittedLabels = new Map<SessionEntry, SessionLabelAdmission>();
    for (const { eventIndex, rawSeq } of snapshot?.admittedLabelRecords ?? []) {
      const entry = entries[eventIndex];
      if (entry?.type === "label") {
        admittedLabels.set(entry, { targetId: entry.targetId, rawSeq });
      }
    }
    return admittedLabels;
  }

  /** Selected parents can be normalized copies; admission stays tied to their loaded source. */
  protected bindDetachedLabelRecords(entries: readonly SessionEntry[]) {
    const admitted = new Map<SessionEntry, SessionLabelAdmission>();
    for (const entry of entries) {
      if (entry.type !== "label") {
        continue;
      }
      const original = this.byId.get(entry.id);
      const admission = original && this.admittedLabelRecords.get(original);
      if (
        original?.type === "label" &&
        admission?.targetId === original.targetId &&
        admission.targetId === entry.targetId
      ) {
        admitted.set(entry, { targetId: entry.targetId, rawSeq: null });
      }
    }
    return admitted;
  }

  protected override clearNavigation(): void {
    super.clearNavigation();
    this.transcriptSeqByEntryId.clear();
  }

  /** Reconstruct through canonical parents; clipped display roots do not reset transcript ordinals. */
  protected resolveTranscriptEntrySeq(entryId: string | null | undefined): number | undefined {
    if (!entryId) {
      return 0;
    }
    const cached = this.transcriptSeqByEntryId.get(entryId);
    if (cached !== undefined) {
      return cached;
    }
    const pending = new Map<string, SessionEntry>();
    let currentId: string | null = entryId;
    let seq = 0;
    while (currentId !== null) {
      const anchor = this.transcriptSeqByEntryId.get(currentId);
      if (anchor !== undefined) {
        seq = anchor;
        break;
      }
      const entry = this.byId.get(currentId);
      if (!entry || pending.has(currentId)) {
        return undefined;
      }
      pending.set(currentId, entry);
      const parents = this.boundedParentIds.get(currentId);
      currentId = parents ? parents.canonicalParentId : super.normalizeEntryParent(entry).parentId;
    }
    for (const entry of [...pending.values()].reverse()) {
      seq += entry.type === "message" || entry.type === "compaction" ? 1 : 0;
      this.transcriptSeqByEntryId.set(entry.id, seq);
    }
    return seq;
  }

  protected cacheAppendedTranscriptEntrySeq(
    entry: SessionEntry,
    canonicalParentId: string | null,
  ): void {
    const predecessorSeq = this.resolveTranscriptEntrySeq(canonicalParentId);
    if (predecessorSeq !== undefined) {
      this.transcriptSeqByEntryId.set(
        entry.id,
        predecessorSeq + (entry.type === "message" || entry.type === "compaction" ? 1 : 0),
      );
    }
  }
}

// Frozen row identity owns the byte fact; eviction releases the weak key with its payload.
const residentEntryBytes = new WeakMap<FileEntry, number>();

function serializedEntryBytes(entry: FileEntry): number {
  return Buffer.byteLength(JSON.stringify(entry)) + 1;
}

function residentBytesFor(entry: FileEntry): number {
  let bytes = residentEntryBytes.get(entry);
  if (bytes === undefined) {
    freezeJsonSnapshot(entry);
    bytes = serializedEntryBytes(entry);
    residentEntryBytes.set(entry, bytes);
  }
  return bytes;
}

/** The deprecated synchronous reload can retain immutable pins only at its unchanged revision. */
export function canReuseResidentSessionView(
  view:
    | {
        transcriptVersion: SessionTranscriptContextVersion | undefined;
        appendParentId: string | null;
        pendingDeliberateAppend: boolean;
        persistenceHeaderPending: boolean;
      }
    | undefined,
  currentTarget: SessionManagerPersistenceTarget | undefined,
  target: SessionManagerPersistenceTarget,
  snapshot: SessionTranscriptBoundedActiveContext | undefined,
): boolean {
  return (
    view !== undefined &&
    snapshot !== undefined &&
    !view.pendingDeliberateAppend &&
    !view.persistenceHeaderPending &&
    sameSessionTranscriptTargetBinding(currentTarget, target) &&
    view.appendParentId === snapshot.activeLeafEntryId &&
    view.transcriptVersion !== undefined &&
    view.transcriptVersion.generation === snapshot.version.generation &&
    view.transcriptVersion.rawSeq === snapshot.version.rawSeq &&
    view.transcriptVersion.updatedAt === snapshot.version.updatedAt
  );
}

function pruneOpaqueParentIndex(view: ResidentView): boolean {
  // Excluded payloads own cursor links only while the prepared view still references them.
  const referencedOpaqueIds = new Set<string>();
  const referencedCanonicalIds = new Set(view.byId.keys());
  const retainOpaqueParent = (id: string | null | undefined) => {
    let currentId = id;
    if (currentId && view.boundedParentIds.has(currentId)) {
      referencedCanonicalIds.add(currentId);
    }
    while (
      currentId &&
      view.opaqueParentsById.has(currentId) &&
      !referencedOpaqueIds.has(currentId)
    ) {
      referencedOpaqueIds.add(currentId);
      currentId = view.opaqueParentsById.get(currentId);
      if (currentId && view.boundedParentIds.has(currentId)) {
        referencedCanonicalIds.add(currentId);
      }
    }
  };
  retainOpaqueParent(view.leafId);
  retainOpaqueParent(view.rawLeafId);
  retainOpaqueParent(view.appendParentId);
  for (const entry of view.byId.values()) {
    retainOpaqueParent(entry.parentId);
    if (entry.type === "compaction" || entry.type === "reset") {
      retainOpaqueParent(entry.firstKeptEntryId);
    }
  }
  for (const parents of [view.logicalParentsById, view.boundedFirstKeptById]) {
    for (const parent of parents.values()) {
      retainOpaqueParent(parent);
    }
  }
  // Nonresident identity anchors do not recursively retain their own omitted ancestors.
  for (const id of view.byId.keys()) {
    const parents = view.boundedParentIds.get(id);
    if (parents) {
      retainOpaqueParent(parents.rawParentId);
      retainOpaqueParent(parents.canonicalParentId);
    }
  }
  for (const { record } of view.opaqueFileEntries) {
    const leaf = parseOpaqueLeafEntry(record);
    const link = leaf ?? parseParentLinkedOpaqueEntry(record);
    if (link) {
      retainOpaqueParent(link.id);
      retainOpaqueParent(link.parentId);
    }
    if (leaf) {
      retainOpaqueParent(leaf.targetId);
      retainOpaqueParent(leaf.appendParentId);
    }
  }
  let changed = false;
  for (const id of view.opaqueParentsById.keys()) {
    if (!referencedOpaqueIds.has(id)) {
      view.opaqueParentsById.delete(id);
      changed = true;
    }
  }
  for (const id of view.boundedParentIds.keys()) {
    if (!referencedCanonicalIds.has(id)) {
      view.boundedParentIds.delete(id);
      changed = true;
    }
  }
  for (const id of view.transcriptSeqByEntryId.keys()) {
    if (!referencedCanonicalIds.has(id)) {
      view.transcriptSeqByEntryId.delete(id);
      changed = true;
    }
  }
  return changed;
}

/** SQLite owns old message payloads; synchronous SDK metadata and label targets remain pinned. */
export function evictResidentSessionMessages(
  view: ResidentView,
  limits: SessionManagerBoundedContextLimits,
  branch: readonly SessionEntry[],
  resolveParent: (entry: SessionEntry) => string | null,
  selectedContext?: ReadonlySet<SessionEntry>,
): boolean {
  const header = view.fileEntries.find((entry) => entry.type === "session");
  let bytes = header ? residentBytesFor(header) : 0;
  let events = 0;
  let exhausted = false;
  const requiredMessages = new Set(
    selectSessionResidentEvidence(branch).retainedEntries.map((entry) => entry.id),
  );
  // Explicit navigation has already selected its bounded model window. Preserve it for this
  // pruning operation; ordinary appends must never pin their growing membership set.
  const retainedMessages = new Set(Array.from(selectedContext ?? [], (entry) => entry.id));
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = view.byId.get(branch[index]!.id)!;
    bytes += residentBytesFor(entry);
    events++;
    exhausted ||= bytes > limits.maxBytes || events > limits.maxEvents;
    // Generic custom history is a shipped synchronous SDK contract. The newest message/user
    // also anchor synchronous suffix cleanup and current-turn identity across oversized metadata.
    // Inspection adds at most two assistant witnesses outside this raw budget.
    const pinned = entry.type !== "message" || requiredMessages.has(entry.id);
    if (entry.type === "message" && (!exhausted || pinned)) {
      retainedMessages.add(entry.id);
    }
  }
  const removed = new Set(
    view.fileEntries.flatMap((entry) =>
      entry.type === "message" &&
      !retainedMessages.has(entry.id) &&
      !view.labelsById.has(entry.id) &&
      entry.id !== view.leafId &&
      entry.id !== view.rawLeafId &&
      entry.id !== view.appendParentId
        ? [entry.id]
        : [],
    ),
  );
  const parents = new Map([...view.byId].map(([id, entry]) => [id, resolveParent(entry)]));
  for (const [id, entry] of view.byId) {
    if (view.boundedParentIds.has(id)) {
      continue;
    }
    const rawParentId = view.logicalParentsById.has(id)
      ? view.logicalParentsById.get(id)!
      : entry.parentId;
    const canonicalParentId = resolveSessionCanonicalParentId(
      rawParentId,
      { has: (parent) => view.byId.has(parent) || view.boundedParentIds.has(parent) },
      view.opaqueParentsById,
    );
    view.boundedParentIds.set(id, { rawParentId, canonicalParentId });
  }
  if (removed.size === 0) {
    return pruneOpaqueParentIndex(view);
  }
  const retainedParent = (parent: string | null): string | null => {
    let seen: Set<string> | undefined;
    let currentParent = parent;
    while (currentParent !== null && removed.has(currentParent)) {
      if (seen?.has(currentParent)) {
        return null;
      }
      (seen ??= new Set()).add(currentParent);
      currentParent = parents.get(currentParent) ?? null;
    }
    return currentParent;
  };
  let nextRetained: string | undefined;
  const nextByRemovedId = new Map<string, string | undefined>();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (removed.has(entry.id)) {
      nextByRemovedId.set(entry.id, nextRetained);
    } else {
      nextRetained = entry.id;
    }
  }
  // Only active-branch removals have successors; another branch cannot inherit the prefix.
  view.cacheTtlProjectionPrefixes = view.cacheTtlProjectionPrefixes?.flatMap((prefix) => {
    if (prefix.anchorIds.length === 0) {
      return [prefix];
    }
    const anchorIds = prefix.anchorIds.flatMap((id) => {
      const anchor = removed.has(id) ? nextByRemovedId.get(id) : id;
      return anchor && view.byId.has(anchor) ? [anchor] : [];
    });
    return anchorIds.length > 0 ? [{ ...prefix, anchorIds }] : [];
  });
  for (const [id, entry] of view.byId) {
    if (removed.has(id)) {
      view.opaqueParentsById.set(id, retainedParent(parents.get(id) ?? null));
      view.byId.delete(id);
      view.logicalParentsById.delete(id);
      view.labelsById.delete(id);
      view.labelTimestampsById.delete(id);
      continue;
    }
    const parent = parents.get(id) ?? null;
    view.logicalParentsById.set(id, retainedParent(parent));
    if (entry.type === "compaction" || entry.type === "reset") {
      const first = view.boundedFirstKeptById.get(id) ?? entry.firstKeptEntryId;
      if (first && removed.has(first)) {
        view.boundedFirstKeptById.set(id, nextByRemovedId.get(first) ?? id);
      }
    }
  }
  for (const [id, parent] of view.opaqueParentsById) {
    if (view.boundedParentIds.has(id)) {
      // Canonical payload proxies may clip; actual opaque links retain their canonical anchor.
      view.opaqueParentsById.set(id, retainedParent(parent));
    }
  }
  pruneOpaqueParentIndex(view);
  const retainedBeforeIndex = [0];
  for (const entry of view.fileEntries) {
    if (entry.type !== "session" && removed.has(entry.id)) {
      view.residentContextEntries?.delete(entry);
    }
    retainedBeforeIndex.push(
      retainedBeforeIndex.at(-1)! + (entry.type === "session" || !removed.has(entry.id) ? 1 : 0),
    );
  }
  view.opaqueFileEntries = view.opaqueFileEntries.map((entry) => ({
    ...entry,
    index: retainedBeforeIndex[entry.index] ?? retainedBeforeIndex.at(-1)!,
  }));
  view.fileEntries = view.fileEntries.filter(
    (entry) => entry.type === "session" || !removed.has(entry.id),
  );
  return true;
}

/** Normalize first-kept markers against the resident window without hydrating omitted rows. */
export function normalizeResidentSessionBoundary(
  entry: Extract<SessionEntry, { type: "compaction" | "reset" }>,
  boundedFirstKept: string | undefined,
  fallbackParentId: string | null,
  byId: ReadonlyMap<string, SessionEntry>,
  opaqueParentsById: ReadonlyMap<string, string | null>,
  fileEntries: readonly FileEntry[],
): SessionEntry {
  let normalized =
    boundedFirstKept === undefined ? entry : { ...entry, firstKeptEntryId: boundedFirstKept };
  if (
    normalized.firstKeptEntryId !== undefined &&
    !byId.has(normalized.firstKeptEntryId) &&
    opaqueParentsById.has(normalized.firstKeptEntryId)
  ) {
    const firstKeptEntryId = resolveOpaqueSessionFirstKeptEntryId({
      firstKeptEntryId: normalized.firstKeptEntryId,
      parentId: normalized.parentId,
      fallbackParentId,
      byId,
      opaqueParentsById,
      entries: () => fileEntries.filter(isIndexedSessionEntry),
    });
    if (firstKeptEntryId && firstKeptEntryId !== normalized.firstKeptEntryId) {
      normalized = { ...normalized, firstKeptEntryId };
    }
  }
  return normalized;
}

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionTranscriptParentIds } from "../../config/sessions/session-accessor.sqlite-contract.js";
import type { SessionLabelAdmission } from "../../config/sessions/session-entry-navigation.js";
import {
  isIndexedSessionEntry,
  parseOpaqueLeafEntry,
  parseParentLinkedOpaqueEntry,
} from "./session-manager-codec.js";
import type { FileEntry, PreservedOpaqueFileEntry, SessionEntry } from "./session-manager-types.js";

/** Transfer admission only to the same physical rows acquired under the view's version fence. */
export function admitLoadedSuffixLabels(
  admitted: Map<SessionEntry, SessionLabelAdmission>,
  suffix: { events: readonly unknown[]; eventSeqs: readonly number[] },
): void {
  const sequences = new Map(
    [...admitted].flatMap(([entry, fact]) =>
      entry.type === "label" && entry.targetId === fact.targetId && fact.rawSeq !== null
        ? [[fact.rawSeq, fact] as const]
        : [],
    ),
  );
  for (const [index, event] of suffix.events.entries()) {
    const fact = sequences.get(suffix.eventSeqs[index]!);
    if (
      isIndexedSessionEntry(event) &&
      event.type === "label" &&
      fact?.targetId === event.targetId
    ) {
      admitted.set(event, fact);
    }
  }
}

/** The storage plan preserves a sparse prefix, then inserts one contiguous replacement tail. */
export function publishRewrittenSuffixLabels(
  admitted: Map<SessionEntry, SessionLabelAdmission>,
  events: readonly unknown[],
  rewritten: { firstIndex: number; firstSeq: number } | undefined,
): void {
  if (!rewritten) {
    throw new Error("Committed suffix has no physical row positions");
  }
  for (let index = rewritten.firstIndex; index < events.length; index++) {
    const event = events[index];
    const fact =
      isIndexedSessionEntry(event) && event.type === "label" ? admitted.get(event) : undefined;
    if (
      isIndexedSessionEntry(event) &&
      event.type === "label" &&
      fact?.targetId === event.targetId
    ) {
      admitted.set(event, {
        targetId: event.targetId,
        rawSeq: rewritten.firstSeq + index - rewritten.firstIndex,
      });
    }
  }
}

/** Rewrite surviving payload and control links through the suffix removal owner's ancestry. */
export function remapSuffixEntries(
  fileEntries: readonly FileEntry[],
  opaqueFileEntries: readonly PreservedOpaqueFileEntry[],
  resolveParent: (parentId: string | null) => string | null,
  admittedLabels: ReadonlyMap<SessionEntry, SessionLabelAdmission>,
  residentContextEntries?: ReadonlySet<SessionEntry>,
) {
  const contextEntries = residentContextEntries === undefined ? undefined : new Set<SessionEntry>();
  const admittedLabelRecords = new Map(admittedLabels);
  return {
    residentContextEntries: contextEntries,
    admittedLabelRecords,
    fileEntries: fileEntries.map((entry) => {
      if (!isIndexedSessionEntry(entry)) {
        return entry;
      }
      const parentId = resolveParent(entry.parentId);
      const replacement = parentId === entry.parentId ? entry : { ...entry, parentId };
      if (residentContextEntries?.has(entry)) {
        contextEntries!.add(replacement);
      }
      const admission = admittedLabels.get(entry);
      if (entry.type === "label" && admission?.targetId === entry.targetId) {
        admittedLabelRecords.set(replacement, admission);
      }
      return replacement;
    }),
    opaqueFileEntries: opaqueFileEntries.map((opaqueEntry) => {
      if (!isRecord(opaqueEntry.record)) {
        return opaqueEntry;
      }
      const record = opaqueEntry.record;
      const parentId =
        record.parentId === null || typeof record.parentId === "string"
          ? resolveParent(record.parentId)
          : undefined;
      const leafEntry = parseOpaqueLeafEntry(record);
      const targetId = leafEntry ? resolveParent(leafEntry.targetId) : undefined;
      const appendParentId =
        leafEntry?.appendParentId !== undefined
          ? resolveParent(leafEntry.appendParentId)
          : undefined;
      if (
        (parentId === undefined || parentId === record.parentId) &&
        (targetId === undefined || targetId === leafEntry?.targetId) &&
        (appendParentId === undefined || appendParentId === leafEntry?.appendParentId)
      ) {
        return opaqueEntry;
      }
      return {
        ...opaqueEntry,
        record: {
          ...record,
          ...(parentId !== undefined ? { parentId } : {}),
          ...(targetId !== undefined ? { targetId } : {}),
          ...(appendParentId !== undefined ? { appendParentId } : {}),
        },
      };
    }),
  };
}

/** Raw rewrite anchors and canonical callback parents follow their own retained predecessors. */
export function remapSuffixParentFacts(
  parentsById: ReadonlyMap<string, SessionTranscriptParentIds>,
  removedParentById: ReadonlyMap<string, string | null>,
  resolveParent: (
    parentId: string | null,
    parentFor?: (id: string) => string | null,
  ) => string | null,
): Map<string, SessionTranscriptParentIds> {
  return new Map(
    [...parentsById]
      .filter(([id]) => !removedParentById.has(id))
      .map(([id, parents]) => [
        id,
        {
          rawParentId: resolveParent(parents.rawParentId),
          canonicalParentId: resolveParent(
            parents.canonicalParentId,
            (removedId) => parentsById.get(removedId)!.canonicalParentId,
          ),
        },
      ]),
  );
}

/** A missing row ends resident inspection; only the fenced worker can continue across that gap. */
export function* walkResidentSessionSuffix(
  rawLeafId: string | null,
  branch: readonly SessionEntry[],
  byId: ReadonlyMap<string, SessionEntry>,
  opaqueEntries: readonly PreservedOpaqueFileEntry[],
  invalidLeafControlIds: ReadonlySet<string>,
  boundedParentIds: ReadonlyMap<string, SessionTranscriptParentIds>,
  resolveEntryParent: (entry: SessionEntry) => string | null,
  canonical: boolean,
): Generator<SessionEntry | undefined> {
  const resolveParent = (entry: SessionEntry) =>
    boundedParentIds.has(entry.id)
      ? boundedParentIds.get(entry.id)!.canonicalParentId
      : resolveEntryParent(entry);
  const opaqueParents = new Map<string, string | null>();
  for (const { record } of opaqueEntries) {
    const leaf = parseOpaqueLeafEntry(record);
    const link = leaf ?? parseParentLinkedOpaqueEntry(record);
    if (link) {
      opaqueParents.set(
        link.id,
        leaf && !invalidLeafControlIds.has(leaf.id) ? leaf.targetId : link.parentId,
      );
    }
  }
  // Even an empty visible branch must prove its selected raw tail through resident records.
  // The terminal step proves the oldest row's logical predecessor, independent of its raw cursor.
  for (let index = Math.max(0, branch.length - 1); index >= -1; index--) {
    const entry = branch[index];
    const child = branch[index + 1];
    // Prepared canonical ancestry already resolves disjoint physical append cursors.
    const parents = child
      ? entry && !boundedParentIds.has(child.id)
        ? [byId.get(child.id)?.parentId, resolveParent(child)]
        : [resolveParent(child)]
      : [rawLeafId];
    for (let parentId of parents) {
      let remainingOpaque = opaqueParents.size;
      while (parentId && !byId.has(parentId)) {
        // A resident side cursor cannot prove continuity across an omitted logical parent.
        if (remainingOpaque-- === 0 || !opaqueParents.has(parentId)) {
          yield undefined;
          return;
        }
        parentId = opaqueParents.get(parentId);
      }
      if (!child && parentId !== (entry?.id ?? null)) {
        yield undefined;
        return;
      }
    }
    if (!entry) {
      return;
    }
    // Boundary payloads can have a projected first-kept ID; the worker owns their raw facts.
    if (canonical && (entry.type === "compaction" || entry.type === "reset")) {
      yield undefined;
      return;
    }
    yield canonical ? { ...byId.get(entry.id)!, parentId: resolveParent(entry) } : entry;
  }
}

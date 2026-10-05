import type { SessionTreeEntry } from "@openclaw/agent-core";
import { iterateSessionContextEntries } from "../../../packages/agent-core/src/harness/session/session.js";

export const SESSION_HISTORY_PAGE_BYTES = 4 * 1024 * 1024;
export const SESSION_HISTORY_COLLECTION_ENTRIES = 100_000;

export type SessionHistoryCollectionBudget = {
  remainingBytes: number;
  largestOversizedBytes: number;
};

export function isSessionContextMessageEntry(entry: { type: unknown }): boolean {
  return (
    entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary"
  );
}

/** Recovery admits one largest complete result beyond the ordinary operation budget. */
export function assertSessionHistoryCollectionBudget(
  bytes: number,
  oversizedBytes: number,
  budget: SessionHistoryCollectionBudget | undefined,
): void {
  if (
    budget &&
    bytes > budget.remainingBytes + Math.max(0, oversizedBytes - budget.largestOversizedBytes)
  ) {
    throw new RangeError("Session history exceeds the operation acquisition limit");
  }
}

/** An absent boundary cannot establish that a terminal message belongs to the current run. */
export function selectSessionTerminalMessageAfter(
  branch: readonly Pick<SessionTreeEntry, "id" | "type">[],
  boundaryEntryId: string | null,
): string | undefined {
  const boundary =
    boundaryEntryId === null ? -1 : branch.findIndex((entry) => entry.id === boundaryEntryId);
  if (boundaryEntryId !== null && boundary < 0) {
    return undefined;
  }
  return branch.findLast((entry, index) => index > boundary && entry.type === "message")?.id;
}

/** Keep retention cuts valid when acquisition omits their original anchor. */
export function selectSessionHistoryContext<T extends SessionTreeEntry>(
  branch: readonly T[],
  contextStartEntryId?: string | null,
  includeMessageEntry?: (entry: T) => boolean,
): T[] {
  if (contextStartEntryId === null) {
    const boundary = branch.findLast(
      (entry) => entry.type === "compaction" || entry.type === "reset",
    );
    return boundary?.type === "compaction" ? [{ ...boundary, firstKeptEntryId: boundary.id }] : [];
  }
  const start =
    contextStartEntryId === undefined
      ? 0
      : branch.findIndex((entry) => entry.id === contextStartEntryId);
  if (start < 0) {
    throw new Error("Session history context anchor is no longer available");
  }
  const boundaryIndex = branch.findLastIndex(
    (entry) => entry.type === "compaction" || entry.type === "reset",
  );
  const boundary = branch[boundaryIndex];
  const firstKept =
    boundary && (boundary.type === "compaction" || boundary.type === "reset")
      ? branch.findIndex((entry) => entry.id === boundary.firstKeptEntryId)
      : -1;
  const window = branch.slice(start);
  if (boundary && firstKept >= 0 && firstKept < start && start < boundaryIndex) {
    window[boundaryIndex - start] = { ...boundary, firstKeptEntryId: branch[start]!.id };
  }
  if (boundary && boundaryIndex < start) {
    window.unshift(boundary);
  }
  const selected = new Set(Array.from(iterateSessionContextEntries(window), ({ entry }) => entry));
  const entries = window.filter(
    (entry) =>
      selected.has(entry) &&
      (!includeMessageEntry || !isSessionContextMessageEntry(entry) || includeMessageEntry(entry)),
  );
  const selectedBoundaryIndex = entries.findIndex(
    (entry) => entry.type === "compaction" || entry.type === "reset",
  );
  const selectedBoundary = entries[selectedBoundaryIndex];
  if (
    selectedBoundary &&
    (selectedBoundary.type === "compaction" || selectedBoundary.type === "reset") &&
    selectedBoundary.firstKeptEntryId !== undefined
  ) {
    const firstKeptEntryId = entries[0]!.id;
    if (selectedBoundary.firstKeptEntryId !== firstKeptEntryId) {
      entries[selectedBoundaryIndex] = { ...selectedBoundary, firstKeptEntryId };
    }
  }
  return entries;
}

/** Resident payload custody survives loss of the separate stable asynchronous context anchor. */
export function selectResidentSessionHistoryContext<T extends SessionTreeEntry>(
  branch: readonly T[],
  members: ReadonlySet<T> | undefined,
  sources: ReadonlyMap<string, T>,
): readonly T[] {
  if (!members) {
    return branch;
  }
  const includes = (entry: T) => {
    const source = sources.get(entry.id);
    return source !== undefined && members.has(source);
  };
  const first = branch.find((entry) => isSessionContextMessageEntry(entry) && includes(entry));
  return selectSessionHistoryContext(branch, first?.id ?? null, includes);
}

/** One bounded selection contract for worker acquisition and resident navigation. */
export function selectSessionHistoryWindow<T extends SessionTreeEntry>(
  canonicalBranch: readonly T[],
  options: {
    headerBytes: number;
    maxBytes: number;
    maxEvents: number;
    retainedEntryIds: ReadonlySet<string>;
    contextStartEntryId?: string | null;
    bytesFor(entry: T): number;
  },
) {
  const canonicalById = new Map(canonicalBranch.map((entry) => [entry.id, entry]));
  const context = new Set(
    Array.from(iterateSessionContextEntries(canonicalBranch), ({ entry }) => entry.id),
  );
  const selected = new Map<string, T>();
  let serializedBytes = options.headerBytes;
  let events = 0;
  let truncated = false;
  for (let index = canonicalBranch.length - 1; index >= 0; index--) {
    const entry = canonicalBranch[index]!;
    const contextBearing = isSessionContextMessageEntry(entry);
    if (
      (options.retainedEntryIds.has(entry.id) && !contextBearing) ||
      (contextBearing && !context.has(entry.id))
    ) {
      continue;
    }
    const entryBytes = options.bytesFor(entry);
    if (events >= options.maxEvents || serializedBytes + entryBytes > options.maxBytes) {
      truncated = true;
      break;
    }
    selected.set(entry.id, entry);
    events++;
    serializedBytes += entryBytes;
  }
  const boundary = canonicalBranch.findLast(
    (entry) => entry.type === "compaction" || entry.type === "reset",
  );
  if (boundary && !selected.has(boundary.id) && !options.retainedEntryIds.has(boundary.id)) {
    const boundaryBytes = options.bytesFor(boundary);
    if (serializedBytes + boundaryBytes <= options.maxBytes) {
      selected.set(boundary.id, boundary);
      serializedBytes += boundaryBytes;
    } else {
      truncated = true;
    }
  }
  const selectedLeaf = canonicalBranch.at(-1);
  if (
    selectedLeaf &&
    !selected.has(selectedLeaf.id) &&
    (!isSessionContextMessageEntry(selectedLeaf) || context.has(selectedLeaf.id))
  ) {
    selected.set(selectedLeaf.id, selectedLeaf);
    serializedBytes += options.bytesFor(selectedLeaf);
  }
  const contextStartEntryId =
    options.contextStartEntryId === null ||
    (options.contextStartEntryId !== undefined && canonicalById.has(options.contextStartEntryId))
      ? options.contextStartEntryId
      : (canonicalBranch.find(
          (entry) => selected.has(entry.id) && isSessionContextMessageEntry(entry),
        )?.id ?? null);
  const modelEntries = new Set([...selected.values()].filter(isSessionContextMessageEntry));
  return {
    canonicalById,
    context,
    selected,
    selectedLeaf,
    contextStartEntryId,
    modelEntries,
    serializedBytes,
    truncated,
  };
}

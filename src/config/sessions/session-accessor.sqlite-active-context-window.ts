import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionTranscriptContextVersion,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  DEFAULT_VISIBLE_MESSAGE_MAX_BYTES,
  DEFAULT_VISIBLE_MESSAGE_MAX_MESSAGES,
  MAX_VISIBLE_MESSAGE_MAX_BYTES,
  MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
  normalizeVisibleMessageLimit,
} from "./session-accessor.sqlite-visible-cursor.js";

export type SessionTranscriptBoundedActiveContext = {
  activeLeafEntryId: string | null;
  selectedLeafEntryId: string | null;
  version: SessionTranscriptContextVersion;
  opaqueParents: Map<string, string | null>;
  parents: Map<string, string | null>;
  firstKeptRanges: Map<string, { startIndex: number; endIndex: number }>;
  persistedSuffixStartSeq: number;
  boundaryCount: number;
  events: TranscriptEvent[];
  serializedBytes: number;
  totalEvents: number;
  transcriptMutationAt: number | null;
  truncated: boolean;
};

type ContextRow = { event: TranscriptEvent; seq: number };
type ContextSize = { seq: number; serializedBytes: number };

export function normalizeBoundedActiveContextLimits(options: {
  maxBytes: number;
  maxEvents: number;
}) {
  return {
    maxBytes: normalizeVisibleMessageLimit(
      options.maxBytes,
      DEFAULT_VISIBLE_MESSAGE_MAX_BYTES,
      MAX_VISIBLE_MESSAGE_MAX_BYTES,
      "maxBytes",
    ),
    maxEvents: normalizeVisibleMessageLimit(
      options.maxEvents,
      DEFAULT_VISIBLE_MESSAGE_MAX_MESSAGES,
      MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
      "maxEvents",
    ),
  };
}

/** Retention moves forward from a cut independently of backward append ancestry. */
export function resolveBoundedRetentionRanges(
  rows: readonly ContextRow[],
  headerOffset: number,
  sequences: ReadonlyMap<string, number>,
  requireEarlierAnchor: boolean,
): SessionTranscriptBoundedActiveContext["firstKeptRanges"] {
  const ranges: SessionTranscriptBoundedActiveContext["firstKeptRanges"] = new Map();
  rows.forEach(({ event, seq }, endIndex) => {
    const entry = asOptionalRecord(event);
    if (
      typeof entry?.id !== "string" ||
      (entry.type !== "compaction" && entry.type !== "reset") ||
      typeof entry.firstKeptEntryId !== "string"
    ) {
      return;
    }
    const firstSeq = sequences.get(entry.firstKeptEntryId);
    if (firstSeq === undefined || (requireEarlierAnchor && firstSeq >= seq)) {
      return;
    }
    // An injected boundary can precede sorted rows; preserve its first-match position.
    let start = endIndex > 0 && rows[0]!.seq >= firstSeq ? 0 : Math.min(1, endIndex);
    let end = start === 0 ? 0 : endIndex;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (rows[middle]!.seq < firstSeq) {
        start = middle + 1;
      } else {
        end = middle;
      }
    }
    ranges.set(entry.id, { startIndex: start + headerOffset, endIndex: endIndex + headerOffset });
  });
  return ranges;
}

/** Projection and transaction-local raw facts share byte selection and the complete view envelope. */
export function readBoundedActiveContextWindow(params: {
  maxBytes: number;
  maxEvents: number;
  header: ContextSize | undefined;
  newestRows: Iterable<ContextSize>;
  readBoundary: () => { boundary: ContextSize | undefined; boundaryCount: number };
  activeLeafEntryId: string | null;
  totalEvents: number;
  readVersion: () => SessionTranscriptContextVersion;
  readPayloads: (sequences: readonly number[]) => Map<number, TranscriptEvent>;
  readParents: (
    sequences: readonly number[],
    payloads: ReadonlyMap<number, TranscriptEvent>,
  ) => Map<string, string | null>;
  readRetentionRanges: (
    rows: ContextRow[],
    headerOffset: number,
  ) => SessionTranscriptBoundedActiveContext["firstKeptRanges"];
}): SessionTranscriptBoundedActiveContext {
  let serializedBytes = params.header?.serializedBytes ?? 0;
  if (serializedBytes > params.maxBytes) {
    throw new RangeError("Session transcript header exceeds the active-context byte limit");
  }
  const selectedSequences: number[] = [];
  let truncated = false;
  for (const row of params.newestRows) {
    if (
      selectedSequences.length >= params.maxEvents ||
      serializedBytes + row.serializedBytes > params.maxBytes
    ) {
      truncated = true;
      break;
    }
    selectedSequences.push(row.seq);
    serializedBytes += row.serializedBytes;
  }
  const { boundary, boundaryCount } = params.readBoundary();
  const contextSequences = selectedSequences.toSorted((left, right) => left - right);
  let injectedBoundarySeq: number | undefined;
  if (boundary && !selectedSequences.includes(boundary.seq)) {
    if (serializedBytes + boundary.serializedBytes <= params.maxBytes) {
      injectedBoundarySeq = boundary.seq;
      contextSequences.unshift(boundary.seq);
      serializedBytes += boundary.serializedBytes;
    } else {
      truncated = true;
    }
  }
  // Decide all byte limits before fetching payloads, including the canonical header.
  const payloads = params.readPayloads(
    params.header ? [params.header.seq, ...contextSequences] : contextSequences,
  );
  const parents = params.readParents(contextSequences, payloads);
  const events: TranscriptEvent[] = params.header ? [payloads.get(params.header.seq)!] : [];
  const rows = contextSequences.map((seq) => ({ event: payloads.get(seq)!, seq }));
  const opaqueParents = new Map<string, string | null>();
  let previousId: unknown;
  for (const { event, seq } of rows) {
    const entry = asOptionalRecord(event);
    if (seq === injectedBoundarySeq) {
      previousId = entry?.id;
    } else if (entry && "id" in entry && "parentId" in entry) {
      // Omitted display payloads retain ancestry links, never fabricated entries.
      if (
        typeof previousId === "string" &&
        typeof entry.parentId === "string" &&
        entry.parentId !== previousId
      ) {
        opaqueParents.set(entry.parentId, previousId);
      }
      previousId = entry.id;
    }
    events.push(event);
  }
  if (params.activeLeafEntryId && previousId !== params.activeLeafEntryId) {
    opaqueParents.set(params.activeLeafEntryId, typeof previousId === "string" ? previousId : null);
  }
  const firstKeptRanges = params.readRetentionRanges(rows, params.header ? 1 : 0);
  const version = params.readVersion();
  return {
    version,
    activeLeafEntryId: params.activeLeafEntryId,
    selectedLeafEntryId: typeof previousId === "string" ? previousId : null,
    opaqueParents,
    parents,
    firstKeptRanges,
    persistedSuffixStartSeq: contextSequences[0] ?? (params.header ? params.header.seq + 1 : 0),
    boundaryCount,
    events,
    serializedBytes,
    totalEvents: params.totalEvents,
    transcriptMutationAt: version.updatedAt,
    truncated,
  };
}

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import type { LabelEntry } from "../../agents/sessions/session-manager-types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import type {
  SessionTranscriptBoundedActiveContext,
  SessionTranscriptReadScope,
  SessionTranscriptParentIds,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { iterateUnindexedActiveTranscriptNavigation } from "./session-accessor.sqlite-history-navigation.js";
import {
  getActiveTranscriptKysely,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import {
  readUnindexedHistoryControls,
  resolveTranscriptBoundaryWindow,
} from "./session-accessor.sqlite-reset-window.js";
import type { ResolvedTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  DEFAULT_VISIBLE_MESSAGE_MAX_BYTES,
  DEFAULT_VISIBLE_MESSAGE_MAX_MESSAGES,
  MAX_VISIBLE_MESSAGE_MAX_BYTES,
  MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
  normalizeVisibleMessageLimit,
} from "./session-accessor.sqlite-visible-cursor.js";
import { readCacheTtlProjectionPrefix } from "./session-cache-ttl-prefix.js";
import { iterateSessionTranscriptActiveNavigation } from "./session-context-usage-evidence.sqlite.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import type { SessionTranscriptNavigationFacts } from "./session-entry-navigation.js";
import { isSessionContextMessageEntry } from "./session-history-context.js";
import {
  readSessionLabelDependencies,
  type SessionLabelTargetPin,
} from "./session-label-targets.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { projectTranscriptRetainedDataSql } from "./session-transcript-retained-data.js";
import { transcriptEventJsonSql, transcriptEventNavigationSql } from "./transcript-payload.js";

function readBoundedRetentionRanges(
  projection: CurrentTranscriptProjection,
  rows: Array<{ event: TranscriptEvent; seq: number }>,
  headerOffset: number,
  activeIds?: Pick<ReadonlySet<string>, "has">,
): SessionTranscriptBoundedActiveContext["firstKeptRanges"] {
  const sequences = new Map<string, number>();
  const cuts = rows.flatMap(({ event, seq }, endIndex) => {
    const entry = asOptionalRecord(event);
    if (typeof entry?.id !== "string" || (activeIds && !activeIds.has(entry.id))) {
      return [];
    }
    if (!projection.hasUnindexedPrefix || !sequences.has(entry.id)) {
      sequences.set(entry.id, seq);
    }
    return (entry.type === "compaction" || entry.type === "reset") &&
      typeof entry.firstKeptEntryId === "string"
      ? [{ id: entry.id, firstKeptEntryId: entry.firstKeptEntryId, endIndex, seq }]
      : [];
  });
  const missing = [...new Set(cuts.map((cut) => cut.firstKeptEntryId))].filter(
    (id) => !sequences.has(id),
  );
  if (missing.length > 0) {
    const lastSelectedSeq = rows.reduce((maximum, row) => Math.max(maximum, row.seq), -Infinity);
    const db = getActiveTranscriptKysely(projection.database);
    const anchors = executeSqliteQuerySync(
      projection.database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("session_transcript_active_events as active", (join) =>
          join
            .onRef("active.session_id", "=", "identity.session_id")
            .onRef("active.event_seq", "=", "identity.seq"),
        )
        .select(["identity.event_id", "identity.seq"])
        .where("identity.session_id", "=", projection.resolved.sessionId)
        .where("identity.event_id", "in", sqliteStringSet(missing))
        .where("identity.seq", "<=", lastSelectedSeq),
    ).rows;
    for (const anchor of anchors) {
      sequences.set(anchor.event_id, anchor.seq);
    }
  }
  if (projection.hasUnindexedPrefix && cuts.length > 0) {
    // Imported duplicates can precede an indexed owner or the selected byte window.
    const unresolved = new Set(cuts.map((cut) => cut.firstKeptEntryId));
    for (const row of iterateUnindexedActiveTranscriptNavigation(projection, {
      eventIds: [...unresolved],
      maxRawSeq: cuts.reduce((maximum, cut) => Math.max(maximum, cut.seq), -Infinity) - 1,
      first: true,
    })) {
      const id = typeof row.event.id === "string" ? row.event.id : undefined;
      if (id === undefined || !unresolved.delete(id)) {
        continue;
      }
      const selectedSeq = sequences.get(id);
      if (selectedSeq === undefined || row.event_seq < selectedSeq) {
        sequences.set(id, row.event_seq);
      }
      if (unresolved.size === 0) {
        break;
      }
    }
  }
  const ranges: SessionTranscriptBoundedActiveContext["firstKeptRanges"] = new Map();
  for (const cut of cuts) {
    const firstSeq = sequences.get(cut.firstKeptEntryId);
    if (firstSeq === undefined || (projection.hasUnindexedPrefix && firstSeq >= cut.seq)) {
      continue;
    }
    let start = 0;
    let end = cut.endIndex;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (rows[middle]!.seq < firstSeq) {
        start = middle + 1;
      } else {
        end = middle;
      }
    }
    if (activeIds) {
      while (start < cut.endIndex) {
        const id = asOptionalRecord(rows[start]?.event)?.id;
        if (typeof id === "string" && activeIds.has(id)) {
          break;
        }
        start++;
      }
    }
    ranges.set(cut.id, {
      startIndex: start + headerOffset,
      endIndex: cut.endIndex + headerOffset,
    });
  }
  return ranges;
}

export type SessionTranscriptBoundedContextOptions = {
  maxBytes: number;
  maxEvents: number;
  ignoreReadFence?: boolean;
  readOnly?: boolean;
};

export type SessionTranscriptResidentPin = Readonly<{
  serializedBytes: number;
  contextBearing: boolean;
}>;

export type PreparedSessionTranscriptResidentPins = {
  prepareNavigation?: (
    retainedIds: ReadonlySet<string>,
  ) => (id: string) => SessionTranscriptNavigationFacts | undefined;
  canonicalLeafEntryId: string | null;
  selectedLeafEntryId: string | null;
  entryNavigation: ReadonlyMap<
    string,
    { transcriptSeq: number; parents: SessionTranscriptParentIds }
  >;
  labelSequences: ReadonlySet<number>;
  metadataSequences: ReadonlyMap<number, SessionTranscriptResidentPin>;
  selectedContextLeaf?: { seq: number; serializedBytes: number };
  messageSequences: ReadonlyMap<number, number>;
  retainedMessagePositions: readonly number[];
  retainedEntryIds: ReadonlySet<string>;
  retainedCustomDataIds: readonly string[];
  fence: ReturnType<typeof resolveSqliteSessionTranscriptReadFence>;
};

export function prepareSessionTranscriptContextLimits<
  T extends SessionTranscriptBoundedContextOptions,
>(options: T): T {
  return {
    ...options,
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

/** Reads one strict byte-bounded active branch without resident compatibility acquisition. */
export function readSessionTranscriptBoundedActiveContextCore(
  scope: SessionTranscriptReadScope,
  options: SessionTranscriptBoundedContextOptions & {
    readOnly?: boolean;
    resolvedScope?: ResolvedTranscriptReadScope;
  },
): SessionTranscriptBoundedActiveContext {
  const preparedOptions = prepareSessionTranscriptContextLimits(options);
  return withCurrentProjectionSnapshot(
    scope,
    (projection) =>
      readSessionTranscriptBoundedActiveContextInProjection(projection, preparedOptions),
    preparedOptions,
  );
}

/** Worker owners prepare retention facts inside this same snapshot before selecting payloads. */
export function readSessionTranscriptBoundedActiveContextInProjection(
  projection: CurrentTranscriptProjection,
  options: SessionTranscriptBoundedContextOptions,
  prepared?: PreparedSessionTranscriptResidentPins,
): SessionTranscriptBoundedActiveContext {
  const { maxBytes, maxEvents } = options;
  const db = getActiveTranscriptKysely(projection.database);
  const fence = prepared
    ? prepared.fence
    : options.ignoreReadFence
      ? undefined
      : resolveSqliteSessionTranscriptReadFence({
          database: projection.database,
          ...projection.resolved,
        });
  const transcript = db
    .selectFrom("transcript_events")
    .where("session_id", "=", projection.resolved.sessionId);
  // Migrated transcripts may place a delivery mirror before the header or lack the auxiliary
  // identity rows entirely. Select the canonical stored event by type so runtime keeps its version.
  const header = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    transcript
      .select([
        "seq",
        /* kysely-allow-raw: reject an oversized header before acquiring its JSON payload. */
        sql<number>`${transcriptEventReadBytesSql()} + 1`.as("serialized_bytes"),
      ])
      .where(
        /* kysely-allow-raw: the canonical transcript event type is stored inside event_json. */
        sql<string>`json_extract(${transcriptEventNavigationSql()}, '$.type')`,
        "=",
        "session",
      )
      .orderBy("seq", "asc")
      .limit(1),
  );
  const headerBytes = header?.serialized_bytes ?? 0;
  if (headerBytes > maxBytes) {
    throw new RangeError("Session transcript header exceeds the active-context byte limit");
  }
  const retainedIds = prepared?.retainedEntryIds ?? new Set<string>();
  const pinnedSequences =
    prepared?.metadataSequences ?? new Map<number, SessionTranscriptResidentPin>();
  // Explicit reset retention wins over ordinary exclusion. The window owner
  // selects paired entries; only its newest candidates can fit this bounded read.
  const retained = (
    prepared
      ? prepared.retainedMessagePositions
      : (resolveTranscriptBoundaryWindow(projection, "context", fence?.beforeRawSeq)
          ?.keptMessagePositions ?? [])
  ).slice(-(maxEvents + 1));
  const metadata = iterateSqliteQuerySync(
    projection.database.db,
    db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select([
        "active.event_seq",
        "active.active_position",
        /* kysely-allow-raw: active-context byte caps exclude rows before fetching or parsing. */
        sql<number>`${transcriptEventReadBytesSql("event")} + 1`.as("serialized_bytes"),
      ])
      .where("active.session_id", "=", projection.resolved.sessionId)
      .$if(fence !== undefined, (query) =>
        query.where("active.event_seq", "<", fence!.beforeRawSeq),
      )
      .where((eb) =>
        retained.length > 0
          ? eb.or([
              eb("active.context_eligible", "=", 1),
              eb("active.message_position", "in", retained),
            ])
          : eb("active.context_eligible", "=", 1),
      )
      .orderBy("active.active_position", "desc")
      .limit(maxEvents + pinnedSequences.size + 1),
  );
  const selectedRows: { event_seq: number; active_position: number }[] = [];
  let serializedBytes = headerBytes;
  let truncated = false;
  for (const row of metadata) {
    const pin = pinnedSequences.get(row.event_seq);
    if (pin && !pin.contextBearing) {
      continue;
    }
    if (selectedRows.length >= maxEvents || serializedBytes + row.serialized_bytes > maxBytes) {
      truncated = true;
      break;
    }
    selectedRows.push(row);
    serializedBytes += row.serialized_bytes;
  }
  const selectedSequences = selectedRows.map((row) => row.event_seq);
  const budgetedBytes = serializedBytes;
  if (
    prepared?.selectedContextLeaf &&
    !selectedSequences.includes(prepared.selectedContextLeaf.seq)
  ) {
    selectedSequences.push(prepared.selectedContextLeaf.seq);
    serializedBytes += prepared.selectedContextLeaf.serializedBytes;
  }
  const ordinaryContextSequences = new Set(selectedSequences);
  for (const [seq, pin] of pinnedSequences) {
    if (!selectedSequences.includes(seq)) {
      selectedSequences.push(seq);
      serializedBytes += pin.serializedBytes;
    }
  }
  for (const [seq, bytes] of prepared?.messageSequences ?? []) {
    if (!selectedSequences.includes(seq)) {
      selectedSequences.push(seq);
      serializedBytes += bytes;
    }
  }
  let boundary = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    db
      .selectFrom(
        db
          .selectFrom("transcript_event_identities as identity")
          .innerJoin("session_transcript_active_events as active", (join) =>
            join
              .onRef("active.session_id", "=", "identity.session_id")
              .onRef("active.event_seq", "=", "identity.seq"),
          )
          .select((eb) => [
            "active.active_position",
            "identity.seq",
            eb.fn.count<number>("identity.seq").over().as("boundary_count"),
          ])
          .where("identity.session_id", "=", projection.resolved.sessionId)
          .where("identity.event_type", "in", ["compaction", "reset"])
          .$if(fence !== undefined, (query) =>
            query.where("identity.seq", "<", fence!.beforeRawSeq),
          )
          .orderBy("active.active_position", "desc")
          .limit(1)
          .as("boundary"),
      )
      .innerJoin("transcript_events as event", (join) =>
        join
          .on("event.session_id", "=", projection.resolved.sessionId)
          .onRef("event.seq", "=", "boundary.seq"),
      )
      .select([
        "boundary.active_position",
        "boundary.seq",
        "boundary.boundary_count",
        /* kysely-allow-raw: count boundaries without carrying payloads through the window query. */
        sql<number>`${transcriptEventReadBytesSql("event")} + 1`.as("serialized_bytes"),
      ]),
  );
  let boundaryCount = boundary?.boundary_count ?? 0;
  if (projection.hasUnindexedPrefix) {
    for (const row of readUnindexedHistoryControls(projection, fence?.beforeRawSeq)) {
      if (
        (row.event.type !== "compaction" && row.event.type !== "reset") ||
        (fence !== undefined && row.event_seq >= fence.beforeRawSeq)
      ) {
        continue;
      }
      boundaryCount += 1;
      if (!boundary || row.active_position > boundary.active_position) {
        boundary = {
          active_position: row.active_position,
          seq: row.event_seq,
          serialized_bytes: row.serialized_bytes,
          boundary_count: boundaryCount,
        };
      }
    }
  }
  let injectedBoundarySeq: number | undefined;
  if (boundary && !selectedSequences.includes(boundary.seq)) {
    if (budgetedBytes + boundary.serialized_bytes <= maxBytes) {
      selectedSequences.push(boundary.seq);
      injectedBoundarySeq = boundary.seq;
      serializedBytes += boundary.serialized_bytes;
    } else {
      truncated = true;
    }
  }
  // Carry raw rewrite anchors and canonical callback parents through the existing ordinal scan.
  const { entryNavigation, canonicalLeafEntryId, selectedLeafEntryId, labelSequences } =
    prepared ??
    (() => {
      const entryNavigation: Map<
        string,
        { transcriptSeq: number; parents: SessionTranscriptParentIds }
      > = new Map();
      const labelSequences = new Set<number>();
      const navigation = iterateSessionTranscriptActiveNavigation(projection, fence?.beforeRawSeq);
      let next = navigation.next();
      for (; !next.done; next = navigation.next()) {
        const { entry, transcriptSeq, parents, eventSeq } = next.value;
        entryNavigation.set(entry.id, { transcriptSeq, parents });
        if (entry.type === "label") {
          labelSequences.add(eventSeq);
        }
      }
      return { entryNavigation, labelSequences, ...next.value };
    })();
  const selectedLabelSequences = new Set(
    selectedSequences.filter((seq) => labelSequences.has(seq)),
  );
  const labelDependencies =
    options.readOnly || prepared
      ? readSessionLabelDependencies(projection, selectedLabelSequences, fence?.beforeRawSeq)
      : undefined;
  const admittedLabels = labelDependencies?.admittedLabels ?? new Map<number, LabelEntry>();
  const labelTargetPins = labelDependencies?.targetPins ?? new Map<string, SessionLabelTargetPin>();
  for (const { seq, serializedBytes: bytes } of labelTargetPins.values()) {
    if (!selectedSequences.includes(seq)) {
      selectedSequences.push(seq);
      serializedBytes += bytes;
    }
  }
  const contextSequences = selectedSequences.toSorted((left, right) => left - right);
  const payloadSequences = header ? [header.seq, ...contextSequences] : contextSequences;
  // One payload read follows all byte decisions; header-first ordering also supports migrated mirrors.
  const payloads = new Map<number, TranscriptEvent>(
    (payloadSequences.length === 0
      ? []
      : executeSqliteQuerySync(
          projection.database.db,
          transcript
            .select([
              "seq",
              projectTranscriptRetainedDataSql(
                transcriptEventJsonSql(projection.database.db),
                prepared?.retainedCustomDataIds ?? [],
              ).as("event_json"),
            ])
            .where(
              "seq",
              "in",
              /* kysely-allow-raw: SDK metadata pins must not grow SQLite's parameter count. */
              sql<number>`(SELECT value FROM json_each(${JSON.stringify(payloadSequences)}))`,
            ),
        ).rows
    ).map((row) => [row.seq, JSON.parse(row.event_json)]),
  );
  const parents: SessionTranscriptBoundedActiveContext["parents"] = new Map();
  const selectedIds = new Set(
    [...payloads.values()].flatMap((entry) => (isIndexedSessionEntry(entry) ? [entry.id] : [])),
  );
  const entryTranscriptSeqs = new Map<string, number>();
  let inactiveNavigation:
    | ReturnType<NonNullable<PreparedSessionTranscriptResidentPins["prepareNavigation"]>>
    | undefined;
  const retainParents = (id: string | null) => {
    const facts = id === null ? undefined : (entryNavigation.get(id) ?? inactiveNavigation?.(id));
    if (facts) {
      parents.set(id!, facts.parents);
      entryTranscriptSeqs.set(id!, facts.transcriptSeq);
    }
    return facts;
  };
  const events: TranscriptEvent[] = header ? [payloads.get(header.seq)!] : [];
  const rows = contextSequences.map((seq) => ({ event: payloads.get(seq)!, seq }));
  const opaqueParents = new Map<string, string | null>();
  let previousId: string | null = null;
  // Imported row order can differ from ancestry; clip only in active navigation order.
  for (const [id, facts] of entryNavigation) {
    if (!selectedIds.has(id)) {
      continue;
    }
    const { canonicalParentId } = facts.parents;
    if (canonicalParentId !== null && !selectedIds.has(canonicalParentId)) {
      opaqueParents.set(canonicalParentId, previousId);
    }
    previousId = id;
  }
  for (const { event } of rows) {
    if (isIndexedSessionEntry(event)) {
      const active = entryNavigation.has(event.id);
      if (!active) {
        inactiveNavigation ??= prepared?.prepareNavigation?.(selectedIds);
      }
      const facts = entryNavigation.get(event.id) ?? inactiveNavigation?.(event.id);
      if (facts) {
        retainParents(event.id);
        retainParents(facts.parents.rawParentId);
        retainParents(facts.parents.canonicalParentId);
        const { rawParentId, canonicalParentId } = facts.parents;
        if (rawParentId !== null && !parents.has(rawParentId)) {
          opaqueParents.set(rawParentId, canonicalParentId);
        }
        if (!active && canonicalParentId !== null && !selectedIds.has(canonicalParentId)) {
          opaqueParents.set(
            canonicalParentId,
            inactiveNavigation?.(canonicalParentId)?.retainedParentId ?? null,
          );
        }
      }
    }
    events.push(event);
  }
  const firstSelected = selectedRows.findLast(
    (row) => typeof asOptionalRecord(payloads.get(row.event_seq))?.id === "string",
  );
  const anchorEntry = firstSelected
    ? asOptionalRecord(payloads.get(firstSelected.event_seq))
    : undefined;
  const injectedEntry =
    injectedBoundarySeq === undefined
      ? undefined
      : asOptionalRecord(payloads.get(injectedBoundarySeq));
  const anchors = [
    ...(boundary && isIndexedSessionEntry(injectedEntry) && injectedEntry.type === "compaction"
      ? [{ activePosition: boundary.active_position, id: injectedEntry.id, entry: injectedEntry }]
      : []),
    ...(firstSelected && typeof anchorEntry?.id === "string"
      ? [
          {
            activePosition: firstSelected.active_position,
            id: anchorEntry.id,
            entry: anchorEntry,
          },
        ]
      : []),
  ];
  const cacheTtlProjectionPrefixes = anchors.flatMap((anchor) => {
    const prefix = readCacheTtlProjectionPrefix(projection, {
      ...anchor,
      beforeRawSeq: fence?.beforeRawSeq,
    });
    return prefix ? [prefix] : [];
  });
  const activeLeafEntryId = fence
    ? fence.admission.effectiveParentId
    : projection.state.leafEventId;
  retainParents(activeLeafEntryId);
  retainParents(selectedLeafEntryId);
  if (selectedLeafEntryId && previousId !== selectedLeafEntryId) {
    if (!entryNavigation.has(selectedLeafEntryId)) {
      opaqueParents.set(selectedLeafEntryId, canonicalLeafEntryId);
      retainParents(canonicalLeafEntryId);
      if (canonicalLeafEntryId !== null && !selectedIds.has(canonicalLeafEntryId)) {
        opaqueParents.set(canonicalLeafEntryId, previousId);
      }
    } else {
      opaqueParents.set(selectedLeafEntryId, previousId);
    }
  }
  if (
    activeLeafEntryId &&
    !selectedIds.has(activeLeafEntryId) &&
    !opaqueParents.has(activeLeafEntryId)
  ) {
    opaqueParents.set(activeLeafEntryId, previousId);
  }
  // Retention moves forward from a cut; append ancestry moves backward. Keep both
  // outside the byte-counted events so excluded payloads cannot change either boundary.
  const firstKeptRanges = readBoundedRetentionRanges(
    projection,
    rows,
    header ? 1 : 0,
    retainedIds.size > 0 || labelTargetPins.size > 0 ? entryNavigation : undefined,
  );
  const version = readTranscriptContextVersionInTransaction(
    projection.database,
    projection.resolved.sessionId,
  );
  const contextStart =
    options.readOnly || prepared
      ? rows.find(
          ({ event, seq }) =>
            ordinaryContextSequences.has(seq) &&
            isIndexedSessionEntry(event) &&
            isSessionContextMessageEntry(event),
        )?.event
      : undefined;
  return {
    version,
    entryTranscriptSeqs,
    residentContextEntryIndexes: rows.flatMap(({ event, seq }, index) =>
      ordinaryContextSequences.has(seq) &&
      isIndexedSessionEntry(event) &&
      isSessionContextMessageEntry(event)
        ? [index + (header ? 1 : 0)]
        : [],
    ),
    admittedLabelRecords: rows.flatMap(({ seq }, index) =>
      admittedLabels.has(seq) ? [{ eventIndex: index + (header ? 1 : 0), rawSeq: seq }] : [],
    ),
    ...(options.readOnly || prepared
      ? {
          contextStartEntryId: isIndexedSessionEntry(contextStart) ? contextStart.id : null,
        }
      : {}),
    activeLeafEntryId,
    selectedLeafEntryId,
    opaqueParents,
    parents,
    firstKeptRanges,
    persistedSuffixStartSeq: contextSequences[0] ?? (header ? header.seq + 1 : 0),
    boundaryCount,
    events,
    cacheTtlProjectionPrefixes,
    serializedBytes,
    totalEvents: projection.state.activeEventCount,
    transcriptMutationAt: version.updatedAt,
    truncated,
  };
}

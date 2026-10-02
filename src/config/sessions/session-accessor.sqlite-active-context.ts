import type { DatabaseSync } from "node:sqlite";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import {
  normalizeBoundedActiveContextLimits,
  readBoundedActiveContextWindow,
  resolveBoundedRetentionRanges,
} from "./session-accessor.sqlite-active-context-window.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptReadScope,
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
import { readSelectedTranscriptPayloads } from "./session-accessor.sqlite-transcript-raw-rows.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  transcriptEventNavigationSql,
  transcriptEventResetNavigationSql,
} from "./transcript-payload.js";

export type SessionTranscriptBoundedActiveContext = {
  activeLeafEntryId: string | null;
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

function readBoundedRetentionRanges(
  projection: CurrentTranscriptProjection,
  rows: Array<{ event: TranscriptEvent; seq: number }>,
  headerOffset: number,
): SessionTranscriptBoundedActiveContext["firstKeptRanges"] {
  const sequences = new Map<string, number>();
  const cuts = rows.flatMap(({ event, seq }) => {
    const entry = asOptionalRecord(event);
    if (typeof entry?.id !== "string") {
      return [];
    }
    if (!projection.hasUnindexedPrefix || !sequences.has(entry.id)) {
      sequences.set(entry.id, seq);
    }
    return (entry.type === "compaction" || entry.type === "reset") &&
      typeof entry.firstKeptEntryId === "string"
      ? [{ firstKeptEntryId: entry.firstKeptEntryId, seq }]
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
        .where("identity.event_id", "in", missing)
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
  return resolveBoundedRetentionRanges(
    rows,
    headerOffset,
    sequences,
    projection.hasUnindexedPrefix,
  );
}

function readUnindexedLogicalParents(
  projection: CurrentTranscriptProjection,
  contextSequences: readonly number[],
  payloads: ReadonlyMap<number, TranscriptEvent>,
): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  if (contextSequences.length === 0) {
    return parents;
  }
  const rows = executeSqliteQuerySync(
    projection.database.db,
    getActiveTranscriptKysely(projection.database)
      .selectFrom("session_transcript_active_events as active")
      .leftJoin("session_transcript_active_events as previous", (join) =>
        join
          .onRef("previous.session_id", "=", "active.session_id")
          .on((eb) => eb("previous.active_position", "=", eb("active.active_position", "-", 1))),
      )
      .leftJoin("transcript_events as parent", (join) =>
        join
          .onRef("parent.session_id", "=", "previous.session_id")
          .onRef("parent.seq", "=", "previous.event_seq"),
      )
      .select((eb) => [
        "active.event_seq",
        "previous.event_seq as parent_seq",
        eb.fn
          .coalesce(transcriptEventResetNavigationSql("parent"), eb.val("null"))
          .as("parent_json"),
      ])
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where("active.event_seq", "in", contextSequences),
  ).rows;
  for (const row of rows) {
    const entry = asOptionalRecord(payloads.get(row.event_seq));
    if (typeof entry?.id !== "string") {
      continue;
    }
    const parent =
      row.parent_seq === null ? undefined : asOptionalRecord(JSON.parse(row.parent_json));
    parents.set(entry.id, typeof parent?.id === "string" ? parent.id : null);
  }
  return parents;
}

/** Reads one byte-bounded active branch without materializing abandoned transcript history. */
export function readSessionTranscriptBoundedActiveContextCore(
  scope: SessionTranscriptReadScope,
  options: {
    maxBytes: number;
    maxEvents: number;
    ignoreReadFence?: boolean;
    readOnly?: boolean;
    resolvedScope?: ResolvedTranscriptReadScope;
    onRead?: (database: DatabaseSync) => void;
  },
): SessionTranscriptBoundedActiveContext {
  const limits = normalizeBoundedActiveContextLimits(options);
  const { maxEvents } = limits;
  const read = (projection: CurrentTranscriptProjection): SessionTranscriptBoundedActiveContext => {
    options.onRead?.(projection.database.db);
    const db = getActiveTranscriptKysely(projection.database);
    const fence = options.ignoreReadFence
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
        .select("seq")
        .where(
          /* kysely-allow-raw: the canonical transcript event type is stored inside event_json. */
          sql<string>`json_extract(${transcriptEventNavigationSql()}, '$.type')`,
          "=",
          "session",
        )
        .orderBy("seq", "asc")
        .limit(1),
    );
    const headerBytes = header
      ? executeSqliteQueryTakeFirstSync(
          projection.database.db,
          transcript
            .select(
              /* kysely-allow-raw: reject an oversized header before acquiring its JSON payload. */
              sql<number>`${transcriptEventReadBytesSql()} + 1`.as("serialized_bytes"),
            )
            .where("seq", "=", header.seq),
        )!.serialized_bytes
      : 0;
    // Keep acquisition lazy so the shared selector rejects an oversized header first.
    function* newestRows() {
      // Explicit reset retention wins over ordinary exclusion. The window owner
      // selects paired entries; only its newest candidates can fit this bounded read.
      const retained =
        resolveTranscriptBoundaryWindow(
          projection,
          "context",
          fence?.beforeRawSeq,
        )?.keptMessagePositions.slice(-(maxEvents + 1)) ?? [];
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
          .limit(maxEvents + 1),
      );
      for (const row of metadata) {
        yield { seq: row.event_seq, serializedBytes: row.serialized_bytes };
      }
    }
    const { selectedLeafEntryId: _selectedLeafEntryId, ...context } =
      readBoundedActiveContextWindow({
        ...limits,
        header: header ? { seq: header.seq, serializedBytes: headerBytes } : undefined,
        newestRows: newestRows(),
        readBoundary: () => {
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
          return {
            boundary: boundary
              ? { seq: boundary.seq, serializedBytes: boundary.serialized_bytes }
              : undefined,
            boundaryCount,
          };
        },
        activeLeafEntryId: fence ? fence.admission.effectiveParentId : projection.state.leafEventId,
        totalEvents: projection.state.activeEventCount,
        readPayloads: (payloadSequences) =>
          readSelectedTranscriptPayloads(
            projection.database,
            projection.resolved.sessionId,
            payloadSequences,
            "full",
          ),
        readParents: (contextSequences, payloads) => {
          // Retain logical ancestry across the byte cutoff without loading parent payloads.
          // Raw parent_id can point into an abandoned branch after a leaf control.
          return projection.hasUnindexedPrefix
            ? readUnindexedLogicalParents(projection, contextSequences, payloads)
            : new Map(
                (contextSequences.length === 0
                  ? []
                  : executeSqliteQuerySync(
                      projection.database.db,
                      db
                        .selectFrom("session_transcript_active_events as active")
                        .innerJoin("transcript_event_identities as entry", (join) =>
                          join
                            .onRef("entry.session_id", "=", "active.session_id")
                            .onRef("entry.seq", "=", "active.event_seq"),
                        )
                        .leftJoin("session_transcript_active_events as previous", (join) =>
                          join
                            .onRef("previous.session_id", "=", "active.session_id")
                            .on((eb) =>
                              eb(
                                "previous.active_position",
                                "=",
                                eb("active.active_position", "-", 1),
                              ),
                            ),
                        )
                        .leftJoin("transcript_event_identities as parent", (join) =>
                          join
                            .onRef("parent.session_id", "=", "previous.session_id")
                            .onRef("parent.seq", "=", "previous.event_seq"),
                        )
                        .select(["entry.event_id", "parent.event_id as parent_id"])
                        .where("active.session_id", "=", projection.resolved.sessionId)
                        .where("active.event_seq", "in", contextSequences),
                    ).rows
                ).map((row) => [row.event_id, row.parent_id]),
              );
        },
        readRetentionRanges: (rows, headerOffset) =>
          readBoundedRetentionRanges(projection, rows, headerOffset),
        readVersion: () =>
          readTranscriptContextVersionInTransaction(
            projection.database,
            projection.resolved.sessionId,
          ),
      });
    // Selected-leaf bookkeeping belongs to writer snapshots, not this public read shape.
    return context;
  };
  return withCurrentProjectionSnapshot(scope, read, {
    readOnly: options.readOnly,
    resolvedScope: options.resolvedScope,
  });
}

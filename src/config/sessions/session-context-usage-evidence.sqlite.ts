import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  getActiveTranscriptKysely,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type { SessionContextUsageEntry } from "./session-context-usage-evidence.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import {
  transcriptEventJsonSql,
  transcriptEventModelNavigationSql,
  transcriptEventNavigationSql,
  transcriptEventResetNavigationSql,
  type TranscriptPayloadAlias,
} from "./transcript-payload.js";

export function transcriptHistoryNavigationSql(alias: TranscriptPayloadAlias) {
  const source = transcriptEventNavigationSql(alias);
  const entryType = /* kysely-allow-raw: legacy duplicate entry kinds follow JSON.parse's last member before payload-shape projection. */ sql`(SELECT value FROM json_each(${source})
    WHERE key = 'type' ORDER BY id DESC LIMIT 1)`;
  return {
    entryType,
    navigation: transcriptEventModelNavigationSql(alias, entryType),
    native: /* kysely-allow-raw: SQLite's nesting limit must not reject readable legacy JSON. */ sql<number>`json_valid(${source})`,
  };
}

/** Supported over-depth JSON keeps JavaScript navigation without optional usage. */
export function selectTranscriptHistoryNavigationSql(
  alias: TranscriptPayloadAlias = "transcript_events",
) {
  const { navigation, native } = transcriptHistoryNavigationSql(alias);
  return [
    /* kysely-allow-raw: only native-readable rows enter JSON extraction; the existing parser owns all fallback rows. */
    sql<string>`CASE WHEN ${native} THEN ${navigation}
      ELSE ${transcriptEventResetNavigationSql(alias)} END`.as("navigation"),
    native.as("native_navigation"),
  ] as const;
}

/** Candidate sequences belong to the caller's still-open, version-fenced snapshot. */
export function readSessionTranscriptUsageEvidence<T extends { seq: number }>(
  database: DatabaseSync,
  sessionId: string,
  entries: readonly T[],
) {
  const payload = transcriptEventJsonSql(database);
  const { entryType, navigation, native } = transcriptHistoryNavigationSql("transcript_events");
  const bySeq = new Map<number, NonNullable<SessionContextUsageEntry["message"]>>();
  for (const row of iterateSqliteQuerySync(
    database,
    getSessionKysely(database)
      .selectFrom("transcript_events")
      .select([
        "seq",
        /* kysely-allow-raw: selected assistants reuse bounded navigation decoding; bodies stay in SQLite and non-native JSON has no optional evidence. */
        sql<string | null>`CASE WHEN NOT ${native} THEN NULL
          WHEN ${entryType} = 'message'
            AND json_extract(${navigation}, '$.message.role') = 'assistant'
          THEN json_set(${navigation},
            '$.message.api', json_extract(${payload}, '$.message.api'),
            '$.message.usage', json_extract(${payload}, '$.message.usage'))
          ELSE NULL END`.as("navigation"),
      ])
      .where("session_id", "=", sessionId)
      .where(
        "seq",
        "in",
        /* kysely-allow-raw: prepared physical sequences use one bound JSON set, independent of SQLite's variable limit. */
        sql<number>`(SELECT value FROM json_each(${JSON.stringify(entries.map((entry) => entry.seq))}))`,
      ),
  )) {
    const entry: unknown = row.navigation === null ? undefined : JSON.parse(row.navigation);
    if (isIndexedSessionEntry(entry) && entry.type === "message") {
      bySeq.set(row.seq, entry.message);
    }
  }
  return new Map(
    entries.flatMap((entry) => {
      const message = bySeq.get(entry.seq);
      return message ? [[entry, message] as const] : [];
    }),
  );
}

export function parseTranscriptHistoryNavigation(row: {
  navigation: string;
  native_navigation: number;
}): unknown {
  const entry: unknown = JSON.parse(row.navigation);
  if (!row.native_navigation && isRecord(entry) && isRecord(entry.message)) {
    // Fallback bytes preserve navigation, never optional usage or checkpoint witnesses.
    delete entry.message.usage;
    delete entry.message.providerReplay;
  }
  return entry;
}

/** Admitted identity remains usable when optional indexed navigation bytes are unreadable. */
export function parseTranscriptHistoryNavigationOrIdentity(row: {
  navigation: string;
  native_navigation: number;
  event_id: string | null;
  event_type: string | null;
}):
  | { kind: "navigation"; entry: unknown }
  | { kind: "identity"; entry: { id: string; type: string }; error: SyntaxError } {
  try {
    return { kind: "navigation", entry: parseTranscriptHistoryNavigation(row) };
  } catch (error) {
    if (
      row.native_navigation ||
      row.event_id === null ||
      row.event_type === null ||
      !(error instanceof SyntaxError)
    ) {
      throw error;
    }
    return { kind: "identity", entry: { id: row.event_id, type: row.event_type }, error };
  }
}

/** Canonical ordinals count the complete admitted path before any resident payload cutoff. */
export function* iterateSessionTranscriptActiveNavigation(
  projection: CurrentTranscriptProjection,
  beforeRawSeq?: number,
) {
  let transcriptSeq = 0;
  let rawParentId: string | null = null;
  let canonicalParentId: string | null = null;
  for (const row of iterateSqliteQuerySync(
    projection.database.db,
    getActiveTranscriptKysely(projection.database)
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .leftJoin("transcript_event_identities as identity", (join) =>
        join
          .onRef("identity.session_id", "=", "active.session_id")
          .onRef("identity.seq", "=", "active.event_seq"),
      )
      .select([
        "active.event_seq",
        "active.context_eligible",
        "active.message_position",
        "identity.event_id",
        "identity.event_type",
        transcriptEventReadBytesSql("event").as("bytes"),
        ...selectTranscriptHistoryNavigationSql("event"),
      ])
      .where("active.session_id", "=", projection.resolved.sessionId)
      .$if(beforeRawSeq !== undefined, (query) =>
        query.where("active.event_seq", "<", beforeRawSeq!),
      )
      .orderBy("active.active_position", "asc"),
  )) {
    let entry: SessionContextUsageEntry | undefined;
    const previousRawParentId = rawParentId;
    rawParentId = row.event_id;
    const parsed = parseTranscriptHistoryNavigationOrIdentity(row);
    if (parsed.kind === "identity") {
      // Selecting the payload still uses the strict reader; identity only preserves its ordinal.
      entry = parsed.entry;
    } else {
      const navigation = parsed.entry;
      rawParentId =
        isRecord(navigation) && typeof navigation.id === "string" ? navigation.id : null;
      if (isIndexedSessionEntry(navigation)) {
        entry = navigation;
      }
    }
    if (!entry) {
      continue;
    }
    if (entry.type === "message" || entry.type === "compaction") {
      transcriptSeq++;
    }
    yield {
      entry,
      transcriptSeq,
      parents: { rawParentId: previousRawParentId, canonicalParentId },
      eventSeq: row.event_seq,
      contextEligible: row.context_eligible,
      messagePosition: row.message_position,
      serializedBytes: row.bytes + 1,
    };
    canonicalParentId = entry.id;
  }
  return { selectedLeafEntryId: rawParentId, canonicalLeafEntryId: canonicalParentId };
}

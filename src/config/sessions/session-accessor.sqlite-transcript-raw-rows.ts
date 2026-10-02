import { sql } from "kysely";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { projectSessionEntryAdmissionSql } from "./session-model-context-projection.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

/** Read identities on the caller's connection, including its uncommitted suffix. */
export function readTranscriptIdentityRows(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  range: { startSeq?: number; limit?: number } = {},
) {
  let query = getSessionKysely(database.db)
    .selectFrom("transcript_event_identities")
    .select(["event_id", "seq", "parent_id", "message_idempotency_key"])
    .where("session_id", "=", sessionId)
    .orderBy("seq", "asc");
  if (range.startSeq !== undefined) {
    query = query.where("seq", ">=", range.startSeq);
  }
  if (range.limit !== undefined) {
    query = query.limit(range.limit);
  }
  return executeSqliteQuerySync(database.db, query).rows;
}

/** Materialize only the selected raw payloads without reopening the admitted connection. */
export function readSelectedTranscriptPayloads(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  sequences: readonly number[],
  projection: "full" | "admission",
): Map<number, TranscriptEvent> {
  if (sequences.length === 0) {
    return new Map();
  }
  const payload = transcriptEventJsonSql(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("transcript_events")
      .select([
        "seq",
        (projection === "admission" ? projectSessionEntryAdmissionSql(payload) : payload).as(
          "event_json",
        ),
      ])
      .where("session_id", "=", sessionId)
      .where(
        "seq",
        "in",
        /* kysely-allow-raw: one bound numeric set avoids SQLite parameter limits for an admitted view. */
        sql<number>`(SELECT value FROM json_each(${JSON.stringify(sequences)}))`,
      )
      .orderBy("seq", "asc"),
  ).rows;
  return new Map(rows.map((row) => [row.seq, JSON.parse(row.event_json)]));
}

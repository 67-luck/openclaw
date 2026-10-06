import type { DatabaseSync } from "node:sqlite";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";

function transcriptStorageSchemaSql(schema: string): string {
  return extractSqliteTableSchema(schema, "transcript_storage_sessions", {
    endMarker: "CREATE VIRTUAL TABLE IF NOT EXISTS session_transcript_fts USING fts5(",
    includeEndMarker: false,
  });
}

export function withoutTranscriptStorageSchema(schema: string): string {
  return schema.includes("CREATE TABLE IF NOT EXISTS transcript_storage_sessions (")
    ? schema.replace(transcriptStorageSchemaSql(schema), "")
    : schema;
}

/** Doctor publishes the reader contract before draining metadata in resumable batches. */
export function initializeTranscriptStorageMigration(database: DatabaseSync, schema: string): void {
  for (const [table, copiedColumns] of [
    [
      "transcript_event_identities",
      [
        "session_id",
        "event_id",
        "seq",
        "event_type",
        "parent_id",
        "message_idempotency_key",
        "created_at",
      ],
    ],
    [
      "session_transcript_active_events",
      ["session_id", "active_position", "event_seq", "message_position", "context_eligible"],
    ],
  ] as const) {
    // sqlite-allow-raw -- Doctor must reject data it cannot preserve before admitting bounded row retirement.
    const columns = database.prepare(`PRAGMA table_xinfo(${table})`).all();
    const expected = new Set<string>(copiedColumns);
    if (
      columns.length !== expected.size ||
      columns.some((column) => typeof column.name !== "string" || !expected.has(column.name))
    ) {
      throw new Error(
        `Transcript metadata migration cannot discard unknown columns from ${table}; preserve this database and use a build that supports its metadata.`,
      );
    }
  }
  database.exec(transcriptStorageSchemaSql(schema));
  database.exec(`INSERT OR IGNORE INTO transcript_storage_sessions(session_id, phase)
    SELECT session_id, 'legacy' FROM session_windows;
    UPDATE transcript_storage_migration SET phase = 'identities', cursor = NULL,
      identity_high_water = (SELECT max(rowid) FROM transcript_event_identities),
      active_high_water = (SELECT max(rowid) FROM session_transcript_active_events)
    WHERE id = 1;`);
}

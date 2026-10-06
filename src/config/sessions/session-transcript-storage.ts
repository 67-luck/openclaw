import type { DatabaseSync } from "node:sqlite";
import { sql, type RawBuilder } from "kysely";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";

type TranscriptStorageDatabase = Pick<
  DB,
  | "transcript_storage_sessions"
  | "transcript_event_identities"
  | "transcript_event_identity_rows"
  | "session_transcript_active_events"
  | "session_transcript_active_rows"
  | "session_windows"
>;

export type TranscriptStorageQueryParameters = {
  sessionId: string | RawBuilder<string>;
  key: string | number | RawBuilder<string | number>;
};

/** Resolve once inside the read snapshot or synchronous transaction that consumes this route. */
export function readSessionTranscriptStorage(database: DatabaseSync, sessionId: string) {
  const db = getNodeSqliteKysely<TranscriptStorageDatabase>(database);
  const stored = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("session_windows as session")
      .leftJoin(
        "transcript_storage_sessions as storage",
        "storage.session_id",
        "session.session_id",
      )
      .select(["storage.sid", "storage.phase"])
      .where("session.session_id", "=", sessionId),
  );
  if (stored && stored.sid === null) {
    throw new Error(`Transcript storage mapping is missing for session ${sessionId}`);
  }
  return createSessionTranscriptStorage(
    database,
    sessionId,
    stored?.phase === "compact" ? stored.sid! : sessionId,
    stored?.phase === "compact",
    stored !== undefined,
  );
}

/** Doctor repairs shipped TEXT-only schemas before the format migration creates storage mappings. */
export function legacySessionTranscriptStorageForMigration(
  database: DatabaseSync,
  sessionId: string,
) {
  return createSessionTranscriptStorage(database, sessionId, sessionId, false, true);
}

function createSessionTranscriptStorage(
  database: DatabaseSync,
  sessionId: string,
  key: string | number,
  compact: boolean,
  exists: boolean,
) {
  const db = getNodeSqliteKysely<TranscriptStorageDatabase>(database);
  const identityTable = compact
    ? ("transcript_event_identity_rows" as const)
    : ("transcript_event_identities" as const);
  const activeTable = compact
    ? ("session_transcript_active_rows" as const)
    : ("session_transcript_active_events" as const);
  const parameters = { key, sessionId };

  return {
    exists,
    compact,
    key,
    sessionId,
    identityTable,
    activeTable,
    identities(index?: "sequence" | "type", values: TranscriptStorageQueryParameters = parameters) {
      const physical = db
        .selectFrom(identityTable)
        .selectAll()
        .$if(index !== undefined, (query) =>
          query.modifyEnd(
            /* kysely-allow-raw: history owners require the physical sequence or type index before the scoped source is flattened. */
            compact
              ? index === "sequence"
                ? sql`INDEXED BY idx_agent_transcript_identity_rows_sequence`
                : sql`INDEXED BY idx_agent_transcript_identity_rows_type_sequence`
              : index === "sequence"
                ? sql`INDEXED BY idx_agent_transcript_event_identity_sequence`
                : sql`INDEXED BY idx_agent_transcript_event_sequence`,
          ),
        )
        .as("stored_identity");
      return db
        .selectFrom(physical)
        .select([
          "event_id",
          "seq",
          "event_type",
          "parent_id",
          "message_idempotency_key",
          "created_at",
        ])
        .select(
          /* kysely-allow-raw: a compact physical key is private; every logical reader keeps the owning canonical session ID. */
          sql<string>`${values.sessionId}`.as("session_id"),
        )
        .where("stored_identity.session_id", "=", values.key);
    },
    activeEvents(values: TranscriptStorageQueryParameters = parameters) {
      return db
        .selectFrom(activeTable)
        .select(["active_position", "event_seq", "message_position", "context_eligible"])
        .select(
          /* kysely-allow-raw: preserve canonical session IDs when projecting compact active rows. */
          sql<string>`${values.sessionId}`.as("session_id"),
        )
        .where("session_id", "=", values.key);
    },
  };
}

export type SessionTranscriptStorage = ReturnType<typeof readSessionTranscriptStorage>;

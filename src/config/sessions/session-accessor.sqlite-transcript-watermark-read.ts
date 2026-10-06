import type { DatabaseSync } from "node:sqlite";
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { SessionTranscriptWatermark } from "./session-history-read.types.js";

export type { SessionTranscriptWatermark } from "./session-history-read.types.js";

type WatermarkDatabase = Pick<
  DB,
  "transcript_events" | "transcript_rewrite_watermarks" | "session_transcript_cold_archives"
>;

function createWatermarkReader(database: DatabaseSync, includeCold: boolean) {
  const db = getNodeSqliteKysely<WatermarkDatabase>(database);
  const read = prepareSqliteQueryTakeFirstSync<
    string,
    { generation: string | null; max_seq: number | null }
  >(database, (parameter) => {
    const sessionId = parameter((value) => value);
    return db.selectNoFrom((eb) => {
      const hotMaxSeq = eb
        .selectFrom("transcript_events")
        .select((inner) => inner.fn.max<number>("seq").as("max_seq"))
        .where("session_id", "=", sessionId);
      const maxSeq = includeCold
        ? eb.fn.coalesce(
            eb
              .selectFrom("session_transcript_cold_archives")
              .select("last_seq")
              .where("session_id", "=", sessionId),
            hotMaxSeq,
          )
        : hotMaxSeq;
      return [
        maxSeq.as("max_seq"),
        eb
          .selectFrom("transcript_rewrite_watermarks")
          .select("generation")
          .where("session_id", "=", sessionId)
          .as("generation"),
      ];
    });
  });
  return (sessionId: string): SessionTranscriptWatermark => {
    const row = read(sessionId);
    return { generation: row?.generation ?? null, maxSeq: row?.max_seq ?? null };
  };
}

// Compiled queries are retained; each use reads current rows on the admitted connection.
const hotWatermarkQuery = createSqliteQueryCache((database) =>
  createWatermarkReader(database, false),
);
const watermarkQuery = createSqliteQueryCache((database) => createWatermarkReader(database, true));

/** Reads hot append and rewrite tokens together on the caller's admitted connection. */
export function readSessionTranscriptHotWatermark(
  database: { db: DatabaseSync },
  sessionId: string,
): SessionTranscriptWatermark {
  return hotWatermarkQuery(database.db)(sessionId);
}

/** Read hot generation and retained cold position together on the admitted snapshot. */
export function readSessionTranscriptWatermarkInDatabase(
  database: { db: DatabaseSync },
  sessionId: string,
): SessionTranscriptWatermark {
  return watermarkQuery(database.db)(sessionId);
}

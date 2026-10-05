import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import {
  resolveSqliteSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import {
  projectTranscriptRetainedDataSql,
  transcriptRetainedDataBytesSql,
} from "./session-transcript-retained-data.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

/** Loads one raw suffix only after SQL-side row and byte bounds are proven. */
export function loadTranscriptSuffixEventsBoundedSync(
  scope: SessionTranscriptReadScope,
  startSeq: number,
  limits: {
    maxBytes: number;
    maxEvents: number;
    retainedCustomDataIds?: readonly string[];
  },
): { events: TranscriptEvent[]; eventSeqs: number[] } {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  return loadTranscriptSuffixEventsBoundedFromDatabase(
    openOpenClawAgentDatabase(toDatabaseOptions(resolved)),
    scope,
    startSeq,
    limits,
  );
}

export function loadTranscriptSuffixEventsBoundedFromDatabase(
  database: Pick<ReturnType<typeof openOpenClawAgentDatabase>, "db" | "path">,
  scope: SessionTranscriptReadScope,
  startSeq: number,
  limits: { maxBytes: number; maxEvents: number; retainedCustomDataIds?: readonly string[] },
): { events: TranscriptEvent[]; eventSeqs: number[] } {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      assertSessionTranscriptHot(database.db, resolved.sessionId);
      const db = getSessionKysely(database.db);
      const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
      if (fence) {
        const hiddenSuffix = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("transcript_events")
            .select("seq")
            .where("session_id", "=", resolved.sessionId)
            .where("seq", ">=", fence.beforeRawSeq)
            .limit(1),
        );
        if (hiddenSuffix) {
          throw new SessionTranscriptReadFenceError(
            `Current-turn transcript admission hides rows needed for suffix mutation: ${fence.admission.entryId}`,
          );
        }
      }
      const metadata = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select([
            "seq",
            /* kysely-allow-raw: reject oversized suffixes before acquiring their JSON payloads. */
            sql<number>`${transcriptRetainedDataBytesSql(limits.retainedCustomDataIds ?? [])} + 1`.as(
              "serialized_bytes",
            ),
          ])
          .where("session_id", "=", resolved.sessionId)
          .where("seq", ">=", startSeq)
          .orderBy("seq", "asc")
          .limit(limits.maxEvents + 1),
      ).rows;
      if (metadata.length > limits.maxEvents) {
        throw new Error(
          `Transcript suffix exceeds synchronous planning row limit for ${resolved.sessionId}`,
        );
      }
      let bytes = 0;
      for (const row of metadata) {
        bytes += row.serialized_bytes;
        if (bytes > limits.maxBytes) {
          throw new Error(
            `Transcript suffix exceeds synchronous planning byte limit for ${resolved.sessionId}`,
          );
        }
      }
      if (metadata.length === 0) {
        return { events: [], eventSeqs: [] };
      }
      const rows = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select([
            projectTranscriptRetainedDataSql(
              transcriptEventJsonSql(database.db),
              limits.retainedCustomDataIds ?? [],
            ).as("event_json"),
            "seq",
          ])
          .where("session_id", "=", resolved.sessionId)
          .where(
            "seq",
            "in",
            metadata.map((row) => row.seq),
          )
          .orderBy("seq", "asc"),
      ).rows;
      if (
        rows.length !== metadata.length ||
        rows.some((row, index) => row.seq !== metadata[index]?.seq)
      ) {
        throw new Error(`SQLite transcript changed while reading suffix for ${resolved.sessionId}`);
      }
      return {
        events: rows.map((row): TranscriptEvent => JSON.parse(row.event_json)),
        eventSeqs: rows.map((row) => row.seq),
      };
    },
    {
      databaseLabel: database.path,
      operationLabel: "bounded transcript suffix read",
    },
  );
}

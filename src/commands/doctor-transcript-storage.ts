import type { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";

type MigrationPhase = "identities" | "active" | "publish" | "cleanup" | "complete";
type LegacyTable = "transcript_event_identities" | "session_transcript_active_events";
type MigrationDatabase = Pick<DB, LegacyTable> & {
  transcript_storage_migration: {
    id: number;
    phase: MigrationPhase;
    cursor: bigint | null;
    identity_high_water: bigint | null;
    active_high_water: bigint | null;
  };
  transcript_storage_sessions: {
    sid: bigint;
    session_id: string;
    phase: "legacy" | "compact";
  };
  transcript_event_identity_rows: Omit<DB["transcript_event_identities"], "session_id"> & {
    session_id: bigint;
  };
  session_transcript_active_rows: Omit<DB["session_transcript_active_events"], "session_id"> & {
    session_id: bigint;
  };
};

type DoctorTranscriptStorageBatchResult = {
  phase: MigrationPhase;
  copiedRows: number;
  publishedSessions: number;
  deletedRows: number;
  done: boolean;
};

export type DoctorTranscriptStorageProgress = {
  phase: MigrationPhase;
  result: DoctorTranscriptStorageBatchResult;
  batches: number;
  batchElapsedMs: number;
  elapsedMs: number;
};

export function readDoctorTranscriptStoragePhase(database: DatabaseSync): MigrationPhase {
  const progress = executeSqliteQueryTakeFirstSync(
    database,
    getNodeSqliteKysely<MigrationDatabase>(database)
      .selectFrom("transcript_storage_migration")
      .select("phase")
      .where("id", "=", 1),
  );
  if (!progress) {
    throw new Error("Transcript storage migration has no admitted progress row");
  }
  return progress.phase;
}

/** Doctor keeps stopped-writer custody while each committed batch remains independently resumable. */
export async function migrateDoctorTranscriptStorage(
  database: DatabaseSync,
  options: {
    signal: AbortSignal;
    assertCurrent: () => void;
    onProgress?: (progress: DoctorTranscriptStorageProgress) => void;
  },
): Promise<{ batches: number; elapsedMs: number }> {
  const started = performance.now();
  const assertCurrent = () => {
    options.signal.throwIfAborted();
    options.assertCurrent();
  };
  assertCurrent();
  let phase = readDoctorTranscriptStoragePhase(database);
  let batches = 0;
  while (phase !== "complete") {
    await setImmediate();
    assertCurrent();
    const batchStarted = performance.now();
    const result = runSqliteImmediateTransactionSync(
      database,
      () => {
        assertCurrent();
        return migrateDoctorTranscriptStorageBatchInTransaction(database);
      },
      {
        operationLabel: "doctor.transcript-storage.migrate",
        withCommit(commit) {
          assertCurrent();
          return commit();
        },
      },
    );
    batches += 1;
    options.onProgress?.({
      phase,
      result,
      batches,
      batchElapsedMs: performance.now() - batchStarted,
      elapsedMs: performance.now() - started,
    });
    phase = result.phase;
  }
  return { batches, elapsedMs: performance.now() - started };
}

const BATCH_ROWS = 256;
const BATCH_BYTES = 2 * 1024 * 1024;
const rowid = /* kysely-allow-raw: native rowids bound migration work without hydrating or rounding legacy metadata. */ sql<bigint>`rowid`;
const legacyRowid = /* kysely-allow-raw: the fixed legacy alias owns the selected physical rowids. */ sql<bigint>`legacy.rowid`;
// Logical column bytes, not index/WAL costs; nullable integers use a conservative eight bytes each.
const identityBytes = /* kysely-allow-raw: native lengths bound unbounded historical IDs without hydrating their strings. */ sql<number>`octet_length(session_id) + octet_length(event_id)
  + coalesce(octet_length(event_type), 0) + coalesce(octet_length(parent_id), 0)
  + coalesce(octet_length(message_idempotency_key), 0) + 16`;
const activeBytes = /* kysely-allow-raw: active metadata retains an unbounded legacy session ID and four integer columns. */ sql<number>`octet_length(session_id) + 32`;

/** Copy, publish, or retire one bounded batch under Doctor's transaction and commit authority. */
function migrateDoctorTranscriptStorageBatchInTransaction(
  database: DatabaseSync,
): DoctorTranscriptStorageBatchResult {
  const kysely = getNodeSqliteKysely<MigrationDatabase>(database);
  const progress = executeSqliteQueryTakeFirstSync(
    database,
    kysely
      .selectFrom("transcript_storage_migration")
      .select((eb) => [
        "phase",
        eb.cast<string | null>("cursor", "text").as("cursor"),
        eb.cast<string | null>("identity_high_water", "text").as("identityHighWater"),
        eb.cast<string | null>("active_high_water", "text").as("activeHighWater"),
      ])
      .where("id", "=", 1),
  );
  if (!progress) {
    throw new Error("Transcript storage migration has no admitted progress row");
  }
  let phase = progress.phase;
  let cursor = progress.cursor === null ? null : BigInt(progress.cursor);
  const result: DoctorTranscriptStorageBatchResult = {
    phase,
    copiedRows: 0,
    publishedSessions: 0,
    deletedRows: 0,
    done: phase === "complete",
  };
  if (result.done) {
    return result;
  }
  const selectBatch = (
    table: LegacyTable,
    limit: number,
    byteBudget: number,
    allowOversized: boolean,
    after: bigint | null = null,
    through?: bigint,
  ) => {
    let query = kysely
      .selectFrom(table)
      .select((eb) => [
        eb.cast<string>(rowid, "text").as("storageRowid"),
        (table === "transcript_event_identities" ? identityBytes : activeBytes).as("bytes"),
      ])
      .orderBy(rowid)
      .limit(limit);
    if (after !== null) {
      query = query.where(rowid, ">", after);
    }
    if (through !== undefined) {
      query = query.where(rowid, "<=", through);
    }
    const candidates = executeSqliteQuerySync(database, query).rows;
    const rowids: bigint[] = [];
    let bytes = 0;
    for (const candidate of candidates) {
      if (bytes + candidate.bytes > byteBudget && (rowids.length > 0 || !allowOversized)) {
        break;
      }
      rowids.push(BigInt(candidate.storageRowid));
      bytes += candidate.bytes;
    }
    return {
      rowids,
      bytes,
      exhausted: candidates.length < limit && rowids.length === candidates.length,
    };
  };

  if (phase === "identities" || phase === "active") {
    const table =
      phase === "identities" ? "transcript_event_identities" : "session_transcript_active_events";
    const highWater =
      phase === "identities" ? progress.identityHighWater : progress.activeHighWater;
    const selected =
      highWater === null
        ? { rowids: [], bytes: 0, exhausted: true }
        : selectBatch(table, BATCH_ROWS, BATCH_BYTES, true, cursor, BigInt(highWater));
    const { rowids } = selected;
    if (rowids.length > 0) {
      const copied =
        phase === "identities"
          ? executeSqliteQuerySync(
              database,
              kysely
                .insertInto("transcript_event_identity_rows")
                .columns([
                  "session_id",
                  "event_id",
                  "seq",
                  "event_type",
                  "parent_id",
                  "message_idempotency_key",
                  "created_at",
                ])
                .expression(
                  kysely
                    .selectFrom("transcript_event_identities as legacy")
                    .innerJoin(
                      "transcript_storage_sessions as storage",
                      "storage.session_id",
                      "legacy.session_id",
                    )
                    .select([
                      "storage.sid as session_id",
                      "legacy.event_id",
                      "legacy.seq",
                      "legacy.event_type",
                      "legacy.parent_id",
                      "legacy.message_idempotency_key",
                      "legacy.created_at",
                    ])
                    .where(legacyRowid, "in", rowids),
                )
                .onConflict((conflict) =>
                  conflict.columns(["session_id", "event_id"]).doUpdateSet((eb) => ({
                    seq: eb.ref("excluded.seq"),
                    event_type: eb.ref("excluded.event_type"),
                    parent_id: eb.ref("excluded.parent_id"),
                    message_idempotency_key: eb.ref("excluded.message_idempotency_key"),
                    created_at: eb.ref("excluded.created_at"),
                  })),
                ),
            )
          : executeSqliteQuerySync(
              database,
              kysely
                .insertInto("session_transcript_active_rows")
                .columns([
                  "session_id",
                  "active_position",
                  "event_seq",
                  "message_position",
                  "context_eligible",
                ])
                .expression(
                  kysely
                    .selectFrom("session_transcript_active_events as legacy")
                    .innerJoin(
                      "transcript_storage_sessions as storage",
                      "storage.session_id",
                      "legacy.session_id",
                    )
                    .select([
                      "storage.sid as session_id",
                      "legacy.active_position",
                      "legacy.event_seq",
                      "legacy.message_position",
                      "legacy.context_eligible",
                    ])
                    .where(legacyRowid, "in", rowids),
                )
                .onConflict((conflict) =>
                  conflict.columns(["session_id", "event_seq"]).doUpdateSet((eb) => ({
                    active_position: eb.ref("excluded.active_position"),
                    message_position: eb.ref("excluded.message_position"),
                    context_eligible: eb.ref("excluded.context_eligible"),
                  })),
                ),
            );
      if (copied.numAffectedRows !== BigInt(rowids.length)) {
        throw new Error("Transcript storage migration found metadata without its session mapping");
      }
      result.copiedRows = rowids.length;
      cursor = rowids.at(-1)!;
    }
    if (selected.exhausted) {
      phase = phase === "identities" ? "active" : "publish";
      cursor = null;
    }
  } else if (phase === "publish") {
    const sessions = executeSqliteQuerySync(
      database,
      kysely
        .selectFrom("transcript_storage_sessions")
        .select((eb) => eb.cast<string>("sid", "text").as("storageSessionId"))
        .where("phase", "=", "legacy")
        .orderBy("sid")
        .limit(BATCH_ROWS),
    ).rows;
    if (sessions.length > 0) {
      executeSqliteQuerySync(
        database,
        kysely
          .updateTable("transcript_storage_sessions")
          .set({ phase: "compact" })
          .where(
            "sid",
            "in",
            sessions.map((session) => BigInt(session.storageSessionId)),
          ),
      );
      result.publishedSessions = sessions.length;
    }
    if (sessions.length < BATCH_ROWS) {
      phase = "cleanup";
    }
  } else if (phase === "cleanup") {
    let remaining = BATCH_ROWS;
    let byteBudget = BATCH_BYTES;
    let exhausted = true;
    for (const table of [
      "transcript_event_identities",
      "session_transcript_active_events",
    ] as const) {
      const selected = selectBatch(table, remaining, byteBudget, result.deletedRows === 0);
      const { rowids } = selected;
      if (rowids.length > 0) {
        executeSqliteQuerySync(database, kysely.deleteFrom(table).where(rowid, "in", rowids));
        result.deletedRows += rowids.length;
        remaining -= rowids.length;
        byteBudget -= selected.bytes;
      }
      if (!selected.exhausted) {
        exhausted = false;
        break;
      }
    }
    if (exhausted) {
      phase = "complete";
    }
  }
  executeSqliteQuerySync(
    database,
    kysely.updateTable("transcript_storage_migration").set({ phase, cursor }).where("id", "=", 1),
  );
  result.phase = phase;
  result.done = phase === "complete";
  return result;
}

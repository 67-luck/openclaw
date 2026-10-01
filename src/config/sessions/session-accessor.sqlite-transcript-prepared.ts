import { sql } from "kysely";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  readTranscriptIdentityInTransaction,
  resolveTranscriptMessageAppendParent,
  transcriptEntryIsAncestor,
} from "./session-accessor.sqlite-transcript-parent.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { resolveSessionTranscriptQuestionAnswer } from "./session-transcript-read-fence.js";
import { transcriptEventNavigationSql } from "./transcript-payload.js";

// Stamped by the Talk voice writer in src/talk/client-voice-session.ts.
const REALTIME_VOICE_PROVENANCE = { kind: "realtime_voice", sourceChannel: "talk" } as const;

const PREPARED_ASSISTANT_MAX_NEWER_MESSAGES = 256;
const PREPARED_ASSISTANT_MAX_NEWER_BYTES = 1024 * 1024;

/** Validates a prepared assistant from bounded indexed message metadata. */
export function canRebasePreparedAssistantInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
  preparedParentId: string | null,
  admittedUserId?: string,
): boolean {
  const tailId = resolveTranscriptMessageAppendParent(database, sessionId, {});
  if (tailId !== preparedParentId) {
    if (
      tailId === null ||
      !transcriptEntryIsAncestor(database, sessionId, tailId, preparedParentId)
    ) {
      return false;
    }
  }
  if (
    admittedUserId &&
    tailId !== admittedUserId &&
    (tailId === null || !transcriptEntryIsAncestor(database, sessionId, tailId, admittedUserId))
  ) {
    return false;
  }
  const db = getSessionKysely(database.db);
  const preparedParent =
    preparedParentId === null
      ? undefined
      : readTranscriptIdentityInTransaction(database, sessionId, preparedParentId);
  if (preparedParentId !== null && !preparedParent) {
    return false;
  }
  const admitted = admittedUserId
    ? admittedUserId === preparedParentId
      ? preparedParent
      : readTranscriptIdentityInTransaction(database, sessionId, admittedUserId)
    : undefined;
  if (admittedUserId && !admitted) {
    return false;
  }
  const newerMessageMetadata = Array.from(
    iterateSqliteQuerySync(
      database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "identity.session_id")
            .onRef("event.seq", "=", "identity.seq"),
        )
        .select([
          "identity.event_id",
          "identity.seq",
          /* kysely-allow-raw: bound newer-message validation before hydrating event JSON. */
          transcriptEventReadBytesSql("event").as("serialized_bytes"),
        ])
        .where("identity.session_id", "=", sessionId)
        .where("identity.event_type", "=", "message")
        .where("identity.seq", ">", preparedParent?.seq ?? -1)
        .orderBy("identity.seq", "asc")
        .limit(PREPARED_ASSISTANT_MAX_NEWER_MESSAGES + 1),
    ),
  );
  if (
    newerMessageMetadata.length > PREPARED_ASSISTANT_MAX_NEWER_MESSAGES ||
    newerMessageMetadata.reduce((sum, row) => sum + row.serialized_bytes, 0) >
      PREPARED_ASSISTANT_MAX_NEWER_BYTES
  ) {
    return false;
  }
  const admittedIsNewer = admitted !== undefined && admitted.seq > (preparedParent?.seq ?? -1);
  if (admittedIsNewer && !newerMessageMetadata.some((row) => row.event_id === admittedUserId)) {
    return false;
  }
  if (newerMessageMetadata.length === 0) {
    return !admittedIsNewer;
  }
  const newerRoles = Array.from(
    iterateSqliteQuerySync(
      database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "identity.session_id")
            .onRef("event.seq", "=", "identity.seq"),
        )
        .leftJoin("session_transcript_active_events as active", (join) =>
          join
            .onRef("active.session_id", "=", "identity.session_id")
            .onRef("active.event_seq", "=", "identity.seq"),
        )
        .leftJoin("transcript_rewrite_watermarks as rewrite", (join) =>
          join.onRef("rewrite.session_id", "=", "identity.session_id"),
        )
        .select([
          "identity.event_id",
          "identity.seq",
          "identity.parent_id",
          "active.message_position",
          "rewrite.generation",
          /* kysely-allow-raw: validate the canonical message role without hydrating content. */
          sql<string>`json_extract(${transcriptEventNavigationSql("event")}, '$.message.role')`.as(
            "message_role",
          ),
          /* kysely-allow-raw: only exact canonical booleans exempt a command from model context. */
          sql<
            number | null
          >`json_type(${transcriptEventNavigationSql("event")}, '$.message.excludeFromContext') = 'true'
            AND json_type(${transcriptEventNavigationSql("event")}, '$.message.__openclaw.contextFreeCommand') = 'true'`.as(
            "context_free_command",
          ),
          /* kysely-allow-raw: classify realtime voice records without hydrating content. */
          sql<
            string | null
          >`json_extract(${transcriptEventNavigationSql("event")}, '$.message.provenance.kind')`.as(
            "provenance_kind",
          ),
          /* kysely-allow-raw: pair the kind with its channel so a partial marker cannot match. */
          sql<
            string | null
          >`json_extract(${transcriptEventNavigationSql("event")}, '$.message.provenance.sourceChannel')`.as(
            "provenance_source_channel",
          ),
        ])
        .where("identity.session_id", "=", sessionId)
        .where("identity.seq", ">=", newerMessageMetadata[0]!.seq)
        .where("identity.seq", "<=", newerMessageMetadata.at(-1)!.seq)
        .where("identity.event_type", "=", "message")
        .orderBy("identity.seq", "asc")
        .limit(PREPARED_ASSISTANT_MAX_NEWER_MESSAGES),
    ),
  );
  return newerRoles.every((row) => {
    if (
      row.message_role !== "user" ||
      row.event_id === admittedUserId ||
      row.context_free_command === 1
    ) {
      return true;
    }
    // Final Talk speech records history without admitting another agent turn.
    // Both writer markers must match; other provenance still faces the fence.
    if (
      row.provenance_kind === REALTIME_VOICE_PROVENANCE.kind &&
      row.provenance_source_channel === REALTIME_VOICE_PROVENANCE.sourceChannel
    ) {
      return true;
    }
    const answer = resolveSessionTranscriptQuestionAnswer(
      database,
      sessionId,
      row.event_id,
      admittedUserId,
    );
    return (
      answer !== undefined &&
      answer.rawSeq === row.seq &&
      answer.effectiveParentId === row.parent_id &&
      answer.activeMessagePosition === row.message_position &&
      answer.generation === row.generation
    );
  });
}

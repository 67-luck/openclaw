import { sql } from "kysely";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { hasReadableSessionPendingInputs } from "./session-accessor.sqlite-pending-input-receipts.js";
import {
  projectSessionPendingInput,
  type SessionPendingInputPage,
} from "./session-accessor.sqlite-pending-inputs.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";

/** Exact live-owner candidates only: retained terminal history never participates in this page. */
export function listActiveSessionPendingInputs(
  scope: SessionAccessScope & { agentId: string; sessionId: string },
  options: { inputIds: readonly string[]; before?: number; limit: number },
): Pick<SessionPendingInputPage, "items" | "nextBefore"> {
  if (!options.inputIds.length) {
    return { items: [] };
  }
  const resolved = resolveSqliteTranscriptScope(scope);
  const limit = Math.max(1, Math.min(20, Math.trunc(options.limit)));
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    if (!hasReadableSessionPendingInputs(database.db)) {
      return { items: [] };
    }
    const db = getSessionKysely(database.db);
    // CROSS JOIN keeps live IDs outermost: lookup cost cannot grow with retained history.
    let query = db
      .selectFrom(
        /* kysely-allow-raw: a bound ID relation avoids variable-count limits and full history scans. */
        sql<{ value: string }>`json_each(${JSON.stringify(options.inputIds)})`.as("active_inputs"),
      )
      .crossJoin("session_pending_inputs")
      .whereRef("session_pending_inputs.input_id", "=", "active_inputs.value")
      .where("session_key", "=", resolved.sessionKey)
      .where("session_id", "=", scope.sessionId)
      .where("state", "=", "queued")
      .where("consumed_event_id", "is", null);
    if (options.before !== undefined) {
      query = query.where("seq", "<", options.before);
    }
    const metadata = executeSqliteQuerySync(
      database.db,
      query
        .select([
          "seq",
          "input_id",
          /* kysely-allow-raw: bound accepted JSON bytes before loading payloads. */
          sql<number>`OCTET_LENGTH(message_json)`.as("bytes"),
        ])
        .orderBy("seq", "desc")
        .limit(limit + 1),
    ).rows;
    const selected: string[] = [];
    let bytes = 0;
    for (const row of metadata) {
      if (selected.length === limit || bytes + row.bytes > MAX_PAYLOAD_BYTES) {
        break;
      }
      selected.push(row.input_id);
      bytes += row.bytes;
    }
    if (metadata.length && !selected.length) {
      throw new Error("Stored pending input exceeds the Gateway payload limit");
    }
    const rows = selected.length
      ? executeSqliteQuerySync(
          database.db,
          query.selectAll("session_pending_inputs").where("input_id", "in", selected),
        ).rows.toSorted((left, right) => left.seq - right.seq)
      : [];
    return {
      items: rows.map(projectSessionPendingInput),
      ...(selected.length < metadata.length
        ? { nextBefore: metadata[selected.length - 1]?.seq }
        : {}),
    };
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : { items: [] };
}

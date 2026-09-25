import { classifyAgentRunTerminalOutcome } from "@openclaw/normalization-core/agent-run-terminal-outcome";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { hasSessionPendingInputsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import type {
  SessionPendingInput,
  SessionPendingInputRow,
  SessionPendingInputAppend,
  SessionPendingInputAppendIdentity,
} from "./session-pending-input.types.js";
type PendingInputDatabase = Pick<OpenClawAgentDatabase, "db" | "path">;

export function parseSessionPendingInputMessage(messageJson: string): PersistedUserTurnMessage {
  const value: unknown = JSON.parse(messageJson);
  if (asOptionalRecord(value)?.role !== "user") {
    throw new Error("Pending input has an invalid persisted user message");
  }
  // SAFETY: only typed admission writes this JSON; parsing preserves its canonical message shape.
  return value as PersistedUserTurnMessage;
}

export function isFinalInputCompletion(outcome: AgentRunTerminalOutcome): boolean {
  return (
    outcome.reason === "completed" ||
    (outcome.reason === "cancelled" && outcome.stopReason !== "restart")
  );
}

type SessionInputCompletionScope = Pick<ResolvedTranscriptScope, "sessionId" | "sessionKey"> & {
  idempotencyKey: string;
};

export function readSessionInputCompletion(
  database: PendingInputDatabase,
  scope: SessionInputCompletionScope,
) {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_input_completions")
      .selectAll()
      .where("session_key", "=", scope.sessionKey)
      .where("session_id", "=", scope.sessionId)
      .where("idempotency_key", "=", scope.idempotencyKey),
  );
  if (!row) {
    return undefined;
  }
  // SAFETY: only writeSessionInputCompletion writes this feature-owned table with typed terminal outcomes.
  const outcome = JSON.parse(row.outcome_json) as AgentRunTerminalOutcome;
  return { ...row, outcome };
}

/** The caller holds the write transaction and has revalidated the exact live admission owner. */
export function writeSessionInputCompletion(
  database: PendingInputDatabase,
  scope: SessionInputCompletionScope & {
    runId: string;
    requestHash: string;
    lifecycleGeneration: string;
  },
  outcome: AgentRunTerminalOutcome,
): AgentRunTerminalOutcome {
  const retained = readSessionInputCompletion(database, scope);
  if (retained && isFinalInputCompletion(retained.outcome)) {
    return retained.outcome;
  }
  const succeeded = classifyAgentRunTerminalOutcome(outcome) === "success";
  executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .insertInto("session_input_completions")
      .values({
        session_key: scope.sessionKey,
        session_id: scope.sessionId,
        idempotency_key: scope.idempotencyKey,
        run_id: scope.runId,
        request_hash: scope.requestHash,
        outcome_json: JSON.stringify(outcome),
        succeeded: succeeded ? 1 : 0,
        completed_at: Date.now(),
      })
      .onConflict((conflict) =>
        conflict
          .columns(["session_id", "idempotency_key"])
          .doUpdateSet({
            outcome_json: JSON.stringify(outcome),
            succeeded: succeeded ? 1 : 0,
            completed_at: Date.now(),
          })
          .where("session_input_completions.succeeded", "=", 0),
      ),
  );
  if (isFinalInputCompletion(outcome)) {
    // Handled hooks can finish without appending a user message. The completion
    // receipt retires that exact custody atomically in the caller's transaction.
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .deleteFrom("session_pending_inputs")
        .where("session_key", "=", scope.sessionKey)
        .where("session_id", "=", scope.sessionId)
        .where("idempotency_key", "=", scope.idempotencyKey)
        .where("run_id", "=", scope.runId)
        .where("request_hash", "=", scope.requestHash)
        .where("lifecycle_generation", "=", scope.lifecycleGeneration),
    );
  }
  return outcome;
}

export function projectSessionPendingInput(row: SessionPendingInputRow): SessionPendingInput {
  if (row.state !== "queued" && row.state !== "interrupted" && row.state !== "cancelled") {
    throw new Error("Pending input has an invalid disposition");
  }
  return {
    id: row.input_id,
    runId: row.run_id,
    message: parseSessionPendingInputMessage(row.message_json),
    acceptedAt: row.accepted_at,
    state: row.state,
  };
}

/** Query only the exact physical transcript; copied keys cannot adopt another generation. */
export function readSessionPendingInputByKey(
  database: PendingInputDatabase,
  scope: Pick<ResolvedTranscriptScope, "sessionId" | "sessionKey">,
  idempotencyKey: string,
): SessionPendingInputRow | undefined {
  if (!hasSessionPendingInputsSchema(database.db)) {
    return undefined;
  }
  return executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_pending_inputs")
      .selectAll()
      .where("session_id", "=", scope.sessionId)
      .where("session_key", "=", scope.sessionKey)
      .where("idempotency_key", "=", idempotencyKey),
  );
}

/** These are row selectors, not authority. The caller retains and checks the exact live owner. */
export function readSessionPendingInputAppendInTransaction(
  database: PendingInputDatabase,
  scope: ResolvedTranscriptScope,
  message: unknown,
  owner: SessionPendingInputAppendIdentity | undefined,
): (SessionPendingInputAppend & { requiresCurrent: boolean }) | undefined {
  const record = asOptionalRecord(message);
  if (record?.role !== "user" || typeof record.idempotencyKey !== "string") {
    return undefined;
  }
  const idempotencyKey = record.idempotencyKey.trim();
  const row = readSessionPendingInputByKey(database, scope, idempotencyKey);
  // A bound-session mirror shares source correlation, never its pending custody.
  const ownsInput =
    owner?.idempotencyKey === idempotencyKey &&
    owner.databasePath === database.path &&
    owner.sessionId === scope.sessionId &&
    owner.sessionKey === scope.sessionKey;
  if (!row && !ownsInput) {
    return undefined;
  }
  if (
    !owner ||
    !ownsInput ||
    (row &&
      (row.input_id !== owner.inputId ||
        row.consumed_event_id != null ||
        row.state !== "queued" ||
        row.lifecycle_generation !== owner.lifecycleGeneration ||
        row.message_json !== owner.messageJson))
  ) {
    throw new SessionPendingInputCustodyError(
      "Pending input cannot be appended outside its admitted turn",
    );
  }
  if (owner.sources) {
    const acceptedByKey = new Map(
      executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .selectFrom("session_pending_inputs")
          .selectAll()
          .where("session_id", "=", scope.sessionId)
          .where("session_key", "=", scope.sessionKey)
          .where(
            "idempotency_key",
            "in",
            owner.sources.map((source) => source.idempotencyKey),
          ),
      ).rows.map((sourceRow) => [sourceRow.idempotency_key, sourceRow]),
    );
    const sources = owner.sources.map((source) => {
      const accepted = acceptedByKey.get(source.idempotencyKey);
      if (
        !accepted ||
        accepted.input_id !== source.inputId ||
        accepted.lifecycle_generation !== source.lifecycleGeneration ||
        accepted.message_json !== source.messageJson
      ) {
        throw new SessionPendingInputCustodyError(
          "Collected input custody changed before transcript promotion",
        );
      }
      return accepted;
    });
    const alreadyPromoted = sources.every((source) => source.consumed_event_id === owner.inputId);
    if (!alreadyPromoted) {
      if (sources.some((source) => source.consumed_event_id != null || source.state !== "queued")) {
        throw new SessionPendingInputCustodyError(
          "Collected input custody ended before transcript promotion",
        );
      }
    }
    return {
      inputId: owner.transcriptInputId,
      message: parseSessionPendingInputMessage(owner.messageJson),
      messageJson: owner.messageJson,
      alreadyPromoted,
      sourceInputIds: sources.map((source) => source.input_id),
      requiresCurrent: !alreadyPromoted,
    };
  }
  // Terminal mirroring may replay a consumed input after cancellation. The caller
  // must prove the existing message; this never permits a new append.
  const messageJson = row?.message_json ?? owner.messageJson;
  return {
    inputId: owner.transcriptInputId,
    message: parseSessionPendingInputMessage(messageJson),
    messageJson,
    alreadyPromoted: !row,
    requiresCurrent: Boolean(row),
  };
}

/** The committed receipt, not this connection-local write, retires host custody. */
export function consumeSessionPendingInputInTransaction(
  database: PendingInputDatabase,
  pending: SessionPendingInputAppend,
): readonly string[] {
  if (pending.alreadyPromoted) {
    return [];
  }
  if (pending.sourceInputIds) {
    const updated = executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .updateTable("session_pending_inputs")
        .set({ consumed_event_id: pending.inputId })
        .where("input_id", "in", [...pending.sourceInputIds])
        .where("state", "=", "queued")
        .where("consumed_event_id", "is", null),
    );
    if (updated.numAffectedRows !== BigInt(pending.sourceInputIds.length)) {
      throw new SessionPendingInputCustodyError(
        "Collected input custody changed during transcript promotion",
      );
    }
  } else {
    const deleted = executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .deleteFrom("session_pending_inputs")
        .where("input_id", "=", pending.inputId)
        .where("state", "=", "queued"),
    );
    if (deleted.numAffectedRows !== 1n) {
      return [];
    }
  }
  return pending.sourceInputIds ?? [pending.inputId];
}

/** Logical deletion also clears custody when transcript windows are retained. */
export function deleteSessionPendingInputs(
  database: PendingInputDatabase,
  sessionKey: string,
): void {
  if (hasSessionPendingInputsSchema(database.db)) {
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .deleteFrom("session_pending_inputs")
        .where("session_key", "=", sessionKey),
    );
  }
}

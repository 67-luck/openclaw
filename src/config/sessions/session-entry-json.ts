import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { InternalSessionEntry } from "./types.js";

export function hasValidSessionEntryIdentity(entry: {
  sessionId?: unknown;
  updatedAt?: unknown;
}): entry is { sessionId: string; updatedAt: number } {
  return (
    typeof entry.sessionId === "string" &&
    typeof entry.updatedAt === "number" &&
    Number.isFinite(entry.updatedAt)
  );
}

export function parseSqliteSessionEntryRecord(row: {
  current_session_id?: string;
  entry_json: string;
  updated_at?: number;
}): (Record<string, unknown> & { sessionId: string; updatedAt: number }) | null {
  try {
    const record: unknown = JSON.parse(row.entry_json);
    if (!isRecord(record)) {
      return null;
    }
    if (!hasValidSessionEntryIdentity(record)) {
      return null;
    }
    if (
      (row.current_session_id !== undefined && row.current_session_id !== record.sessionId) ||
      (row.updated_at !== undefined && row.updated_at !== record.updatedAt)
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

/** Released readers already keep this recovery envelope out of public projections. */
export function serializeSqliteSessionEntryRecord(entry: InternalSessionEntry): string {
  const { restartRecoveryRequester, ...record } = entry;
  return JSON.stringify(
    restartRecoveryRequester
      ? {
          ...record,
          mainRestartRecovery: {
            ...(record.mainRestartRecovery ?? {
              cycleId: restartRecoveryRequester.sourceRunId,
              revision: 1,
              chargedAttempts: 0,
              requesterOnly: true,
            }),
            requester: restartRecoveryRequester,
          },
        }
      : record,
  );
}

/** Raw repair/inventory readers retain stored bytes; runtime readers unwrap private custody. */
export function decodeSqliteSessionEntryRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const recovery = isRecord(record.mainRestartRecovery) ? record.mainRestartRecovery : undefined;
  if (
    !Object.hasOwn(record, "restartRecoveryRequester") &&
    (!recovery || !Object.hasOwn(recovery, "requester"))
  ) {
    return record;
  }
  // An unrecognized old top-level value is not surviving requester custody.
  const { restartRecoveryRequester: _unsupportedRootRequester, ...entry } = record;
  if (!recovery || !Object.hasOwn(recovery, "requester")) {
    return entry;
  }
  const { requester, requesterOnly, ...state } = recovery;
  // Older releases need a valid cycle even for a custody-only envelope. Once
  // their recovery owner changes it, preserve that state on the next upgrade.
  const untouchedEnvelope =
    requesterOnly === true &&
    isRecord(requester) &&
    state.cycleId === requester.sourceRunId &&
    state.revision === 1 &&
    state.chargedAttempts === 0 &&
    Object.keys(state).length === 3;
  return {
    ...entry,
    mainRestartRecovery: untouchedEnvelope || Object.keys(state).length === 0 ? undefined : state,
    restartRecoveryRequester: requester,
  };
}

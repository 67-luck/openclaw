import { inspectTranscriptEventsSync } from "../../config/sessions/session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import { isIndexedSessionEntry } from "./session-manager-codec.js";
import type { FileEntry } from "./session-manager-types.js";
import type {
  PreparedSessionTranscriptReload,
  SessionManagerBoundedContextLimits,
  SessionManagerPersistenceTarget,
} from "./session-manager-view-types.js";

export type SessionTranscriptAppendExpectation = {
  expectedMutationAt: number | null;
  expectedEntryId: string;
  admittedUserId: string;
};

export function prepareCommittedSessionTranscriptReload(
  target: SessionManagerPersistenceTarget,
  limits: SessionManagerBoundedContextLimits | undefined,
): PreparedSessionTranscriptReload {
  if (limits) {
    return {
      kind: "bounded",
      snapshot: readSessionTranscriptBoundedActiveContextCore(target, {
        ...limits,
        ignoreReadFence: true,
      }),
    };
  }
  const inspected = inspectTranscriptEventsSync(target);
  return {
    kind: "full",
    snapshot: {
      events: inspected.events,
      version: {
        generation: inspected.snapshot.generation,
        rawSeq: inspected.snapshot.lastSeq,
        updatedAt: inspected.snapshot.transcriptUpdatedAt,
      },
    },
  };
}

export function assertCommittedSessionTranscriptReload(
  prepared: PreparedSessionTranscriptReload,
  append: SessionTranscriptAppendExpectation | undefined,
): void {
  // SAFETY: SQLite transcript readers return the same persisted entry union used by SessionManager.
  const entries = prepared.snapshot.events as FileEntry[];
  const mutationAt =
    prepared.kind === "bounded"
      ? prepared.snapshot.transcriptMutationAt
      : prepared.snapshot.version.updatedAt;
  if (
    append &&
    mutationAt !== append.expectedMutationAt &&
    !entries.some((entry) => isIndexedSessionEntry(entry) && entry.id === append.expectedEntryId)
  ) {
    throw new Error("SQLite transcript changed before adopting the committed append");
  }
}

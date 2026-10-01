import type { DatabaseSync } from "node:sqlite";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type {
  SessionEntryCacheDatabase,
  SessionEntryCacheSnapshot,
  SessionSharingEntry,
} from "./session-accessor.sqlite-entry-cache.types.js";
import {
  cacheValidityTokensEqual,
  readSessionEntryCacheValidityToken,
  type SqliteSessionEntryRevision,
} from "./session-accessor.sqlite-entry-revision.js";
import {
  reconcileSessionSharingAcquisition,
  type CommittedSessionSharingFacts,
  type PreparedSessionSharingRead,
  type SessionSharingRetentionRequest,
} from "./session-accessor.sqlite-sharing-acquisition.js";
import type { SessionParticipantProjection } from "./session-membership-facts.types.js";
import type { SessionEntry } from "./types.js";

export const preparedSharingReads = resolveGlobalSingleton(
  Symbol.for("openclaw.preparedSessionSharingReads"),
  () => new Map<string, Set<PreparedSessionSharingRead>>(),
);
export type PendingSessionEntryPublication = {
  superseded: Map<string, Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | undefined>;
  membershipInvalidated: Set<string>;
  settled: boolean;
};
export const pendingSessionEntryPublications = resolveGlobalSingleton(
  Symbol.for("openclaw.pendingSessionEntryPublications"),
  () => new Map<string, Set<PendingSessionEntryPublication>>(),
);

export function recordCommittedSessionEntryPublication(
  database: SessionEntryCacheDatabase | string,
  sessionKey: string,
  entry: SessionSharingEntry | undefined,
): void {
  const identity =
    typeof database === "string" ? database : findOpenClawAgentDatabaseIdentity(database)?.identity;
  if (typeof identity !== "string") {
    return;
  }
  for (const pending of pendingSessionEntryPublications.get(`file:${identity}\0${sessionKey}`) ??
    []) {
    pending.superseded.set(
      sessionKey,
      entry
        ? { sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision }
        : undefined,
    );
  }
}

/** The existing entry writer advances retained facts before any commit observer can reenter. */
export function retainPreparedSessionSharingFacts(params: SessionSharingRetentionRequest) {
  // A cold enrolled reader has an actor but no native incarnation yet. This
  // second key is publication custody only; its retained actor still authorizes reads.
  const keys = [
    ...(params.databaseIdentity ? [`${params.databaseIdentity}\0${params.sessionKey}`] : []),
    ...(params.workerPath ? [`volatile-owner:${params.workerPath}\0${params.sessionKey}`] : []),
  ];
  const initial = "acquiring" in params ? undefined : params;
  const read: PreparedSessionSharingRead = {
    pending: new Set(),
    facts: initial && {
      entry: initial.entry,
      placeholder: initial.placeholder,
      membership: initial.membership,
    },
    generation: initial?.generation,
    acquisition: initial ? undefined : { invalidated: false, membership: new Map() },
  };
  const registrations = keys.map((key) => {
    const reads = preparedSharingReads.get(key) ?? new Set<PreparedSessionSharingRead>();
    reads.add(read);
    preparedSharingReads.set(key, reads);
    return { key, reads };
  });
  const pendingPublications = () =>
    keys.flatMap((key) => [...(pendingSessionEntryPublications.get(key) ?? [])]);
  let active = true;
  return {
    initialize: (snapshot: CommittedSessionSharingFacts) => {
      const acquisition = read.acquisition;
      if (!active || !acquisition) {
        throw new Error("Session sharing acquisition is no longer current");
      }
      read.facts = reconcileSessionSharingAcquisition(acquisition, snapshot);
      read.acquisition = undefined;
    },
    readGeneration: () =>
      read.pending.size > 0 ||
      pendingPublications().some(
        (pending) => !pending.settled && !pending.superseded.has(params.sessionKey),
      )
        ? undefined
        : active
          ? read.generation?.current
          : undefined,
    readCurrent: () =>
      read.pending.size > 0 ||
      pendingPublications().some(
        (pending) =>
          !pending.settled &&
          (!pending.superseded.has(params.sessionKey) ||
            pending.membershipInvalidated.has(params.sessionKey)),
      )
        ? undefined
        : read.facts,
    release: () => {
      if (!active) {
        return;
      }
      active = false;
      read.facts = undefined;
      read.acquisition = undefined;
      for (const { key, reads } of registrations) {
        reads.delete(read);
        if (reads.size === 0 && preparedSharingReads.get(key) === reads) {
          preparedSharingReads.delete(key);
        }
      }
    },
  };
}

/** Generation custody shares the entry publication owner, independently of membership. */
export function retainPreparedSessionGenerationFacts(params: {
  databaseIdentity: string;
  sessionKey: string;
  entry: SessionSharingEntry | undefined;
}) {
  const retained = retainPreparedSessionSharingFacts({
    ...params,
    membership: new Set(),
    generation: { current: params.entry ?? null, initiallyAbsent: params.entry ? undefined : true },
  });
  return { readCurrent: retained.readGeneration, release: retained.release };
}

export function retainedSharingReads(
  database: SessionEntryCacheDatabase | string,
  sessionKey: string,
) {
  const identity =
    typeof database === "string" ? database : findOpenClawAgentDatabaseIdentity(database)?.identity;
  return typeof identity === "string"
    ? preparedSharingReads.get(`file:${identity}\0${sessionKey}`)
    : undefined;
}

export type SqliteSessionEntryCache = SessionEntryCacheSnapshot & {
  validityToken: SqliteSessionEntryRevision;
};

// Retain listing metadata only; complete prompt snapshots belong to the caller's full read.
// Weak connection ownership lets closed read-only and evicted database handles release their
// snapshots. The connection-local validity token plus tracked-write invalidation keeps live
// snapshots current; narrow tracked upserts patch one authoritative row after commit, while
// structural/unknown writes invalidate. Without both, every read would re-query and re-parse
// every entry_json document.
export const sessionEntryCaches = new WeakMap<DatabaseSync, SqliteSessionEntryCache>();

export function publishTrackedCacheUpdate(
  database: SessionEntryCacheDatabase,
  publish: () => void,
  stage?: () => () => void,
): boolean {
  let settle: (() => void) | undefined;
  // Committed cache state must settle before observers can reenter with newer writes.
  if (
    stageSqliteTransactionState(database.db, {
      stage: () => {
        settle = stage?.();
      },
      rollback: () => settle?.(),
      commit: () => {
        try {
          publish();
        } finally {
          settle?.();
        }
      },
    })
  ) {
    return true;
  }
  if (database.db.isTransaction) {
    throw new Error(
      "SQLite session entry writes must use runOpenClawAgentWriteTransaction for cache publication",
    );
  }
  publish();
  return false;
}

/** Participant display facts may be borrowed in a transaction only at its native revision. */
export function readCurrentSessionEntryCacheParticipants(
  database: DatabaseSync,
  sessionKey: string,
): SessionParticipantProjection | undefined {
  const cached = sessionEntryCaches.get(database);
  const entry = cached?.entries.get(sessionKey);
  if (
    !cached ||
    !entry ||
    !getAdmittedSqliteSchemaFacts(database) ||
    !cacheValidityTokensEqual(
      cached.validityToken,
      readSessionEntryCacheValidityToken(database, "cached"),
    )
  ) {
    return undefined;
  }
  return entry.participants
    ? {
        participants: entry.participants.map(({ identity }) => ({ identity: { ...identity } })),
        participantCount: entry.participantCount,
      }
    : {};
}

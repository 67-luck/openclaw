import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { withCurrentProjectionSnapshot } from "../../config/sessions/session-accessor.sqlite-active-projection.js";
import { prepareTranscriptRewriteSync } from "../../config/sessions/session-accessor.sqlite-branch-rewrite.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptWriteScope,
} from "../../config/sessions/session-accessor.sqlite-contract.js";
import { iterateUnindexedActiveTranscriptNavigation } from "../../config/sessions/session-accessor.sqlite-history-navigation.js";
import { getActiveTranscriptKysely } from "../../config/sessions/session-accessor.sqlite-projection-read.js";
import { inspectTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import { resolveTranscriptMessageAppendParent } from "../../config/sessions/session-accessor.sqlite-transcript-parent.js";
import { readTranscriptContextVersionInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-state.js";
import { redactTranscriptMessageForStorage } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import { MAX_VISIBLE_MESSAGE_MAX_BYTES } from "../../config/sessions/session-accessor.sqlite-visible-cursor.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import {
  parseTranscriptHistoryNavigation,
  selectTranscriptHistoryNavigationSql,
  transcriptHistoryNavigationSql,
} from "../../config/sessions/session-context-usage-evidence.sqlite.js";
import {
  isIndexedSessionEntry,
  parseParentLinkedOpaqueEntry,
} from "../../config/sessions/session-entry-codec.js";
import { normalizeSessionContextEntryBoundaries } from "../../config/sessions/session-entry-navigation.js";
import {
  assertSessionHistoryCollectionBudget,
  SESSION_HISTORY_COLLECTION_ENTRIES,
  SESSION_HISTORY_PAGE_BYTES,
} from "../../config/sessions/session-history-context.js";
import { reconcileSessionTranscriptIndexInTransaction } from "../../config/sessions/session-transcript-index.js";
import { transcriptEventReadBytesSql } from "../../config/sessions/session-transcript-read-bytes.js";
import { readSessionTranscriptResidentContext } from "../../config/sessions/session-transcript-resident-context.worker.js";
import {
  transcriptEventJsonSql,
  transcriptEventModelNavigationSql,
  transcriptEventNavigationSql,
} from "../../config/sessions/transcript-payload.js";
import { scanSessionTranscriptTree } from "../../config/sessions/transcript-tree.js";
import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { prepareSessionTranscriptMessageRewrite } from "./session-manager-rewrite-plan.js";
import type {
  SessionTranscriptMessageRewrite,
  SessionTranscriptRewriteRetention,
} from "./session-manager-rewrite.js";
import type { SessionEntry } from "./session-manager-types.js";
import type {
  PreparedSessionTranscriptReload,
  SessionManagerBoundedContextLimits,
} from "./session-manager-view-types.js";

type RewriteTarget = SessionTranscriptWriteScope & SessionTranscriptRuntimeTarget;

/** Acquire only the canonical active suffix; historical payloads never cross to the manager. */
function readRewriteSource(
  target: RewriteTarget,
  request: SessionTranscriptMessageRewrite,
  expected: SessionTranscriptContextVersion,
  appendParentId: string | null,
  sourceDatabase: DatabaseSync,
) {
  return runSqliteDeferredTransactionSync(sourceDatabase, () => {
    const version = readTranscriptContextVersionInTransaction(
      { db: sourceDatabase },
      target.sessionId,
    );
    if (
      version.generation !== expected.generation ||
      version.rawSeq !== expected.rawSeq ||
      version.updatedAt !== expected.updatedAt
    ) {
      throw new Error("Session transcript changed before rewrite preparation");
    }
    return withCurrentProjectionSnapshot(target, (projection) => {
      const { database, resolved } = projection;
      if (database.db !== sourceDatabase) {
        throw new Error("Session rewrite lost its canonical source database");
      }
      if (
        resolveTranscriptMessageAppendParent(database, resolved.sessionId, {}) !== appendParentId
      ) {
        throw new Error("Session transcript changed before rewrite preparation");
      }
      const ids = request.replacements.map(({ entryId }) => entryId).filter((id) => id.trim());
      const branch: SessionEntry[] = [];
      const parents = new Map<string, string | null>();
      const firstKeptById = new Map<string, string>();
      if (ids.length === 0) {
        return { branch, parents, firstKeptById };
      }
      const db = getActiveTranscriptKysely(database);
      let first = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("session_transcript_active_events as active")
          .innerJoin("transcript_event_identities as identity", (join) =>
            join
              .onRef("identity.session_id", "=", "active.session_id")
              .onRef("identity.seq", "=", "active.event_seq"),
          )
          .select("active.active_position")
          .where("active.session_id", "=", resolved.sessionId)
          .where("identity.event_id", "in", sqliteStringSet(ids))
          .orderBy("active.active_position", "asc")
          .limit(1),
      )?.active_position;
      for (const row of iterateUnindexedActiveTranscriptNavigation(projection, { eventIds: ids })) {
        if (typeof row.event.id === "string" && ids.includes(row.event.id)) {
          first = first === undefined ? row.active_position : Math.min(first, row.active_position);
        }
      }
      if (first === undefined) {
        return { branch, parents, firstKeptById };
      }
      const events = db
        .selectFrom("session_transcript_active_events as active")
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "active.session_id")
            .onRef("event.seq", "=", "active.event_seq"),
        )
        .where("active.session_id", "=", resolved.sessionId);
      const suffix = events.where("active.active_position", ">=", first);
      const navigationJson = transcriptEventNavigationSql("event");
      const { entryType, native } = transcriptHistoryNavigationSql("event");
      const budget = { remainingBytes: MAX_VISIBLE_MESSAGE_MAX_BYTES, largestOversizedBytes: 0 };
      let entryCount = 0;
      // Raw suffixes include excluded messages and complete custom data absent from model context.
      // Admit their canonical sizes before SQLite transfers any suffix payload to this process.
      for (const row of iterateSqliteQuerySync(
        database.db,
        suffix
          .select([
            transcriptEventReadBytesSql("event").as("bytes"),
            /* kysely-allow-raw: readable navigation proves the complete tool-result exception without hydrating its body. */
            sql<number | null>`CASE WHEN ${native} THEN
            ${entryType} = 'message'
            AND json_extract(${navigationJson}, '$.message.role') = 'toolResult'
            ELSE 0 END`.as("tool_result"),
          ])
          .orderBy("active.active_position", "asc"),
      )) {
        if (++entryCount > SESSION_HISTORY_COLLECTION_ENTRIES) {
          throw new RangeError("Session history exceeds the operation acquisition limit");
        }
        const oversizedBytes =
          row.tool_result && row.bytes > SESSION_HISTORY_PAGE_BYTES ? row.bytes : 0;
        assertSessionHistoryCollectionBudget(row.bytes, oversizedBytes, budget);
        const largestOversizedBytes = Math.max(budget.largestOversizedBytes, oversizedBytes);
        budget.remainingBytes += largestOversizedBytes - budget.largestOversizedBytes - row.bytes;
        budget.largestOversizedBytes = largestOversizedBytes;
      }
      const payloads = events.select(transcriptEventJsonSql(database.db, "event").as("event_json"));
      let parentId: string | null = null;
      for (const row of iterateSqliteQuerySync(
        database.db,
        events
          .select(selectTranscriptHistoryNavigationSql("event"))
          .where("active.active_position", "<", first)
          .orderBy("active.active_position", "desc"),
      )) {
        const entry = parseTranscriptHistoryNavigation(row);
        const parent = isIndexedSessionEntry(entry) ? entry : parseParentLinkedOpaqueEntry(entry);
        if (parent) {
          parentId = parent.id;
          break;
        }
      }
      for (const row of iterateSqliteQuerySync(
        database.db,
        payloads
          .where("active.active_position", ">=", first)
          .orderBy("active.active_position", "asc"),
      )) {
        const entry: unknown = JSON.parse(row.event_json);
        const indexed = isIndexedSessionEntry(entry);
        if (indexed) {
          parents.set(entry.id, parentId);
          branch.push(entry);
        }
        const link = indexed ? entry : parseParentLinkedOpaqueEntry(entry);
        if (link) {
          parentId = link.id;
        }
      }
      const sourceIds = new Set(branch.map((entry) => entry.id));
      if (
        branch.some(
          (entry) =>
            (entry.type === "compaction" || entry.type === "reset") &&
            entry.firstKeptEntryId !== undefined &&
            !sourceIds.has(entry.firstKeptEntryId),
        )
      ) {
        // Keep markers may reference opaque rows outside the selected path. Normalize only
        // their planning facts; conflict validation still receives untouched canonical sources.
        const navigation = scanSessionTranscriptTree(
          (function* () {
            for (const row of iterateSqliteQuerySync(
              database.db,
              db
                .selectFrom("transcript_events")
                .select(transcriptEventModelNavigationSql().as("navigation"))
                .where("session_id", "=", resolved.sessionId)
                .orderBy("seq", "asc"),
            )) {
              const entry: unknown = JSON.parse(row.navigation);
              yield entry;
            }
          })(),
        );
        for (const entry of normalizeSessionContextEntryBoundaries(branch, navigation.nodes)) {
          if ((entry.type === "compaction" || entry.type === "reset") && entry.firstKeptEntryId) {
            firstKeptById.set(entry.id, entry.firstKeptEntryId);
          }
        }
      }
      return { branch, parents, firstKeptById };
    });
  });
}

export function readCommittedTranscriptRewrite(
  target: RewriteTarget,
  limits?: SessionManagerBoundedContextLimits,
  retainedEntryIds: readonly string[] = [],
  retainedCustomDataIds: readonly string[] = [],
  selectedLeafEntryId?: string,
): PreparedSessionTranscriptReload {
  if (limits) {
    return {
      kind: "bounded",
      snapshot: readSessionTranscriptResidentContext(target, {
        ...limits,
        ignoreReadFence: true,
        retainedEntryIds,
        retainedCustomDataIds,
        selectedLeafEntryId,
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

/** One command owns preparation through native settlement; no preparation survives its worker. */
export function rewriteSessionTranscriptMessages(
  target: RewriteTarget,
  request: SessionTranscriptMessageRewrite,
  expected: SessionTranscriptContextVersion,
  appendParentId: string | null,
  database: DatabaseSync,
  assertCurrent: () => void,
  retention: SessionTranscriptRewriteRetention,
  admit?: (stage: "transaction" | "commit") => void,
  adopt?: (
    version: SessionTranscriptContextVersion,
    retained: SessionTranscriptRewriteRetention & {
      customDataSources: Array<[string, string]>;
    },
  ) => void,
) {
  assertCurrent();
  const source = readRewriteSource(target, request, expected, appendParentId, database);
  const prepared = prepareSessionTranscriptMessageRewrite(
    source.branch,
    request,
    undefined,
    source,
  );
  const customDataSources: Array<[string, string]> = [];
  const retained = {
    retainedEntryIds: [...retention.retainedEntryIds],
    retainedCustomDataIds: [...retention.retainedCustomDataIds],
    contextStartEntryId: retention.contextStartEntryId,
    customDataSources,
  };
  for (const entry of prepared.entries) {
    const sourceEntry = prepared.sources.get(entry.id);
    if (sourceEntry && sourceEntry.id === retained.contextStartEntryId) {
      retained.contextStartEntryId = entry.id;
    }
    if (entry.type !== "message" && entry.type !== "leaf") {
      retained.retainedEntryIds.push(entry.id);
    }
    if (
      entry.type === "custom" &&
      sourceEntry &&
      retention.retainedCustomDataIds.includes(sourceEntry.id)
    ) {
      retained.retainedCustomDataIds.push(entry.id);
      retained.customDataSources.push([entry.id, sourceEntry.id]);
    }
  }
  let version: SessionTranscriptContextVersion | undefined;
  if (prepared.result.changed) {
    for (const entry of prepared.entries) {
      if (entry.type === "message") {
        entry.message = redactTranscriptMessageForStorage(entry.message, {});
      }
    }
    const publish = prepareTranscriptRewriteSync(
      target,
      appendParentId,
      assertCurrent,
      expected,
      (stage) => {
        if (stage === "commit") {
          // Publish the branch projection with its rewrite so bounded reload needs no later repair.
          reconcileSessionTranscriptIndexInTransaction(database, target.sessionId);
        }
        admit?.(stage);
      },
      { messagesAlreadyRedacted: true, scheduleProjectionReconcile: false },
    );
    publish(prepared.entries, prepared.sources, (committed) => {
      version = committed;
      adopt?.(committed, retained);
    });
  }
  return { result: prepared.result, version, retained };
}

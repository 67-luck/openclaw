import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import {
  readSessionTranscriptBoundedActiveContextInProjection,
  prepareSessionTranscriptContextLimits,
  type PreparedSessionTranscriptResidentPins,
  type SessionTranscriptResidentPin,
} from "./session-accessor.sqlite-active-context.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import type {
  SessionTranscriptParentIds,
  SessionTranscriptReadScope,
} from "./session-accessor.sqlite-contract.js";
import { iterateUnindexedTranscriptNavigation } from "./session-accessor.sqlite-history-navigation.js";
import { getActiveTranscriptKysely } from "./session-accessor.sqlite-projection-read.js";
import { resolveTranscriptBoundaryWindow } from "./session-accessor.sqlite-reset-window.js";
import type { ResolvedTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import { selectSessionResidentEvidence } from "./session-context-usage-evidence.js";
import {
  iterateSessionTranscriptActiveNavigation,
  parseTranscriptHistoryNavigationOrIdentity,
  readSessionTranscriptUsageEvidence,
  selectTranscriptHistoryNavigationSql,
} from "./session-context-usage-evidence.sqlite.js";
import { createSessionTranscriptNavigationFacts } from "./session-entry-navigation.js";
import { isSessionContextMessageEntry } from "./session-history-context.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { isCanonicalSessionTranscriptEntry, scanSessionTranscriptTree } from "./transcript-tree.js";

/** Worker reloads and the captured incognito owner prepare pins inside the selected snapshot. */
export function readSessionTranscriptResidentContext(
  scope: SessionTranscriptReadScope,
  options: {
    maxBytes: number;
    maxEvents: number;
    ignoreReadFence?: boolean;
    readOnly?: boolean;
    resolvedScope?: ResolvedTranscriptReadScope;
    retainedEntryIds?: readonly string[];
    retainedCustomDataIds?: readonly string[];
    selectedLeafEntryId?: string;
  },
) {
  const preparedOptions = prepareSessionTranscriptContextLimits(options);
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => {
      const db = getActiveTranscriptKysely(projection.database);
      const fence = options.ignoreReadFence
        ? undefined
        : resolveSqliteSessionTranscriptReadFence({
            database: projection.database,
            ...projection.resolved,
          });
      const retainedEntryIds = options.retainedEntryIds ?? [];
      const retainedIds = new Set(retainedEntryIds);
      const labelSequences = new Set<number>();
      const metadataSequences = new Map<number, SessionTranscriptResidentPin>();
      if (retainedEntryIds.length > 0) {
        const pinned = executeSqliteQuerySync(
          projection.database.db,
          db
            .selectFrom("transcript_event_identities as identity")
            .innerJoin("transcript_events as event", (join) =>
              join
                .onRef("event.session_id", "=", "identity.session_id")
                .onRef("event.seq", "=", "identity.seq"),
            )
            .select([
              "identity.seq",
              "identity.event_type",
              /* kysely-allow-raw: account for the explicit non-message SDK retention exception. */
              sql<number>`${transcriptEventReadBytesSql("event")} + 1`.as("serialized_bytes"),
            ])
            .where("identity.session_id", "=", projection.resolved.sessionId)
            .where("identity.event_id", "in", sqliteStringSet(retainedEntryIds))
            .where("identity.event_type", "not in", ["message", "session", "leaf"])
            .$if(fence !== undefined, (query) =>
              query.where("identity.seq", "<", fence!.beforeRawSeq),
            ),
        ).rows;
        for (const row of pinned) {
          if (row.event_type === "label") {
            labelSequences.add(row.seq);
          }
          metadataSequences.set(row.seq, {
            serializedBytes: row.serialized_bytes,
            contextBearing: isSessionContextMessageEntry({ type: row.event_type }),
          });
        }
      }
      for (const row of iterateUnindexedTranscriptNavigation(projection, {
        eventIds: retainedEntryIds,
        maxRawSeq: fence === undefined ? undefined : fence.beforeRawSeq - 1,
      })) {
        const { id, type } = row.event;
        if (typeof id !== "string" || typeof type !== "string") {
          continue;
        }
        if (retainedIds.has(id) && !["message", "session", "leaf"].includes(type)) {
          metadataSequences.set(row.event_seq, {
            serializedBytes: row.serialized_bytes,
            contextBearing: isSessionContextMessageEntry({ type }),
          });
        }
        if (type === "label" && retainedIds.has(id)) {
          labelSequences.add(row.event_seq);
        }
      }
      let selectedLeafFound = false;
      let canonicalLeafEntryId: string | null = null;
      let selectedLeafEntryId: string | null = null;
      let selectedContextLeaf: PreparedSessionTranscriptResidentPins["selectedContextLeaf"];
      const retainedMessagePositions =
        resolveTranscriptBoundaryWindow(projection, "context", fence?.beforeRawSeq)
          ?.keptMessagePositions ?? [];
      const retainedMessages = new Set(retainedMessagePositions);
      const entryNavigation = new Map<
        string,
        {
          transcriptSeq: number;
          parents: SessionTranscriptParentIds;
        }
      >();
      const evidence = selectSessionResidentEvidence(
        (function* () {
          const navigation = iterateSessionTranscriptActiveNavigation(
            projection,
            fence?.beforeRawSeq,
          );
          let next = navigation.next();
          for (; !next.done; next = navigation.next()) {
            const facts = next.value;
            const {
              entry,
              transcriptSeq,
              parents,
              eventSeq,
              contextEligible,
              messagePosition,
              serializedBytes,
            } = facts;
            entryNavigation.set(entry.id, { transcriptSeq, parents });
            if (entry.type === "label") {
              labelSequences.add(eventSeq);
            }
            if (entry.id === options.selectedLeafEntryId) {
              selectedLeafFound = true;
            }
            if (
              entry.type !== "message" ||
              contextEligible === 1 ||
              (messagePosition !== null && retainedMessages.has(messagePosition))
            ) {
              if (entry.id === options.selectedLeafEntryId && isSessionContextMessageEntry(entry)) {
                selectedContextLeaf = { seq: eventSeq, serializedBytes };
              }
              yield {
                id: entry.id,
                type: entry.type,
                ...(entry.type === "message" ? { message: entry.message } : {}),
                seq: eventSeq,
                serializedBytes,
              };
            }
          }
          ({ canonicalLeafEntryId, selectedLeafEntryId } = next.value);
        })(),
        (entries) =>
          readSessionTranscriptUsageEvidence(
            projection.database.db,
            projection.resolved.sessionId,
            entries,
          ),
      );
      const messageSequences = new Map(
        evidence.retainedEntries.map((entry) => [entry.seq, entry.serializedBytes]),
      );
      if (options.selectedLeafEntryId !== undefined && !selectedLeafFound) {
        throw new Error("Selected branch leaf is no longer available");
      }
      const pins: PreparedSessionTranscriptResidentPins = {
        prepareNavigation: (retainedIds) => {
          let readNavigation: ReturnType<typeof createSessionTranscriptNavigationFacts> | undefined;
          const unavailableNavigation = new Map<string, SyntaxError>();
          return (id) => {
            readNavigation ??= createSessionTranscriptNavigationFacts(
              scanSessionTranscriptTree(
                (function* () {
                  for (const row of iterateSqliteQuerySync(
                    projection.database.db,
                    db
                      .selectFrom("transcript_events as event")
                      .leftJoin("transcript_event_identities as identity", (join) =>
                        join
                          .onRef("identity.session_id", "=", "event.session_id")
                          .onRef("identity.seq", "=", "event.seq"),
                      )
                      .select([
                        "identity.event_id",
                        "identity.event_type",
                        "identity.parent_id",
                        ...selectTranscriptHistoryNavigationSql("event"),
                      ])
                      .where("event.session_id", "=", projection.resolved.sessionId)
                      .$if(fence !== undefined, (query) =>
                        query.where("event.seq", "<", fence!.beforeRawSeq),
                      )
                      .orderBy("event.seq", "asc"),
                  )) {
                    const parsed = parseTranscriptHistoryNavigationOrIdentity(row);
                    if (parsed.kind === "navigation") {
                      yield parsed.entry;
                    } else {
                      // Missing control fields can change later paths; identity cannot restore them.
                      if (parsed.entry.type === "leaf" || parsed.entry.type === "reset") {
                        throw parsed.error;
                      }
                      const identity = { ...parsed.entry, parentId: row.parent_id };
                      if (isCanonicalSessionTranscriptEntry(identity)) {
                        unavailableNavigation.set(identity.id, parsed.error);
                      }
                      yield identity;
                    }
                  }
                })(),
              ).byId,
              retainedIds,
              (node) => {
                const error = unavailableNavigation.get(node.id);
                if (error) {
                  throw error;
                }
              },
            );
            return readNavigation(id);
          };
        },
        entryNavigation,
        labelSequences,
        canonicalLeafEntryId,
        selectedLeafEntryId,
        metadataSequences,
        selectedContextLeaf,
        messageSequences,
        retainedMessagePositions,
        retainedEntryIds: retainedIds,
        retainedCustomDataIds: options.retainedCustomDataIds ?? [],
        fence,
      };
      return readSessionTranscriptBoundedActiveContextInProjection(
        projection,
        preparedOptions,
        pins,
      );
    },
    preparedOptions,
  );
}

import type { SessionTreeEntry } from "@openclaw/agent-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import { selectResetKeptEntries } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  normalizeBoundedActiveContextLimits,
  readBoundedActiveContextWindow,
  resolveBoundedRetentionRanges,
} from "./session-accessor.sqlite-active-context-window.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { readTranscriptEventId } from "./session-accessor.sqlite-read.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import {
  readSelectedTranscriptPayloads,
  readTranscriptIdentityRows,
} from "./session-accessor.sqlite-transcript-raw-rows.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  hasTranscriptMessage,
  shouldProjectActiveEvent,
  transcriptEventContextEligibility,
} from "./session-transcript-projection-append.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import {
  transcriptEventModelNavigationSql,
  transcriptEventNavigationSql,
} from "./transcript-payload.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

/** One admitted raw snapshot: navigation and byte facts never stand in for persisted payloads. */
export function readTranscriptRawSnapshotInTransaction(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  resolved: ResolvedTranscriptScope,
) {
  const db = getSessionKysely(database.db);
  const navigation = transcriptEventNavigationSql("event");
  const identities = new Map(
    readTranscriptIdentityRows(database, resolved.sessionId).map((row) => [row.event_id, row]),
  );
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events as event")
      .select([
        "event.seq",
        /* kysely-allow-raw: preserve opaque/overdepth parser behavior while excluding historical bodies. */
        sql<string>`CASE WHEN json_valid(${navigation}) THEN
          CASE WHEN json_type(${navigation}) = 'object'
            THEN ${transcriptEventModelNavigationSql("event")}
            ELSE ${navigation} END
          ELSE ${navigation} END`.as("navigation_json"),
        /* kysely-allow-raw: explicit null messages still occupy canonical active message positions. */
        sql<number | null>`CASE WHEN json_valid(${navigation})
          THEN json_type(${navigation}, '$.message') IS NOT NULL ELSE NULL END`.as("has_message"),
        /* kysely-allow-raw: only an exact boolean on an object message excludes context. */
        sql<number | null>`CASE WHEN json_valid(${navigation}) THEN CASE
          WHEN json_type(${navigation}, '$.message') = 'object'
            AND json_type(${navigation}, '$.message.excludeFromContext') = 'true'
          THEN 0 ELSE 1 END ELSE NULL END`.as("context_eligible"),
        /* kysely-allow-raw: charge canonical uncompressed/native bytes before decoding selected payloads. */
        sql<number>`${transcriptEventReadBytesSql("event")} + 1`.as("serialized_bytes"),
      ])
      .where("event.session_id", "=", resolved.sessionId)
      .orderBy("event.seq", "asc"),
  ).rows.map((row) => {
    const event: TranscriptEvent = JSON.parse(row.navigation_json);
    const hasMessage =
      row.has_message === null ? hasTranscriptMessage(event) : row.has_message === 1;
    const identity = identities.get(readTranscriptEventId(event) ?? "");
    return {
      seq: row.seq,
      event,
      serializedBytes: row.serialized_bytes,
      hasMessage,
      contextEligible: row.context_eligible ?? transcriptEventContextEligibility(event),
      projectsActive:
        shouldProjectActiveEvent(event) ||
        (isRecord(event) && event.type !== "session" && hasMessage),
      identity:
        identity?.seq !== row.seq
          ? undefined
          : {
              entryId: identity.event_id,
              parentId: identity.parent_id,
              idempotencyKey: identity.message_idempotency_key,
            },
    };
  });
  const tree = scanSessionTranscriptTree(rows.map((row) => row.event));
  const path = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  const visible = path.length
    ? path.map((node) => rows[node.index]!)
    : tree.hasLeafControl
      ? []
      : rows;
  let messagePosition = 0;
  const active = visible
    .filter((row) => row.projectsActive)
    .map((row) =>
      Object.assign({}, row, {
        messagePosition: row.hasMessage ? messagePosition++ : null,
      }),
    );
  const version = readTranscriptContextVersionInTransaction(database, resolved.sessionId);
  const anchors = new Map<string, TranscriptEntryAnchor>();
  for (const row of active) {
    const identity = row.identity;
    if (
      !version.generation ||
      row.messagePosition === null ||
      !identity ||
      readTranscriptEventId(row.event) !== identity.entryId
    ) {
      continue;
    }
    anchors.set(
      identity.entryId,
      Object.freeze({
        agentId: resolved.agentId,
        sessionId: resolved.sessionId,
        sessionKey: resolved.sessionKey,
        storePath: database.path,
        generation: version.generation,
        entryId: identity.entryId,
        rawSeq: row.seq,
        effectiveParentId: identity.parentId,
        activeMessagePosition: row.messagePosition,
        ...(identity.idempotencyKey ? { idempotencyKey: identity.idempotencyKey } : {}),
      }),
    );
  }
  // Payload acquisition stays synchronous on the caller's admitted connection/version.
  return {
    rows,
    tree,
    active,
    anchors,
    version,
    readPayloads: (sequences: readonly number[]) =>
      readSelectedTranscriptPayloads(database, resolved.sessionId, sequences, "full"),
    readAdmissionEntries: (sequences: readonly number[]) =>
      readSelectedTranscriptPayloads(database, resolved.sessionId, sequences, "admission"),
  };
}

export type TranscriptRawSnapshot = ReturnType<typeof readTranscriptRawSnapshotInTransaction>;

/** Adopts bounded committed writer state without a before-user read fence or projection repair. */
export function readBoundedContextFromRawSnapshot(
  snapshot: TranscriptRawSnapshot,
  options: { maxBytes: number; maxEvents: number },
) {
  const limits = normalizeBoundedActiveContextLimits(options);
  const { rows, active, tree, version, readPayloads } = snapshot;
  const boundaries = active.filter(
    (row) => isRecord(row.event) && (row.event.type === "reset" || row.event.type === "compaction"),
  );
  const boundary = boundaries.at(-1);
  const retained = new Set<number>();
  if (boundary && isRecord(boundary.event) && typeof boundary.event.firstKeptEntryId === "string") {
    const boundaryEvent = boundary.event;
    const boundaryIndex = active.indexOf(boundary);
    const firstIndex = active.findIndex(
      (row) => readTranscriptEventId(row.event) === boundaryEvent.firstKeptEntryId,
    );
    if (firstIndex >= 0 && firstIndex < boundaryIndex) {
      const candidates = active
        .slice(firstIndex, boundaryIndex)
        .filter(
          (row) => row.hasMessage && (boundaryEvent.type === "reset" || row.contextEligible === 1),
        );
      const pairingEntries = candidates.map((row) => {
        // SAFETY: The canonical navigation projection retains the reset window's pairing fields.
        return row.event as SessionTreeEntry;
      });
      const kept: ReadonlySet<unknown> | undefined =
        boundaryEvent.type === "reset"
          ? new Set(selectResetKeptEntries(pairingEntries))
          : undefined;
      for (const row of candidates) {
        if (isRecord(row.event) && row.event.type === "message" && (!kept || kept.has(row.event))) {
          retained.add(row.seq);
        }
      }
    }
  }
  const parents = new Map<string, string | null>();
  const sequences = new Map<string, number>();
  let previousId: string | null = null;
  for (const row of active) {
    const id = readTranscriptEventId(row.event);
    if (id) {
      parents.set(id, previousId);
      if (!sequences.has(id)) {
        sequences.set(id, row.seq);
      }
    }
    previousId = id ?? null;
  }
  return readBoundedActiveContextWindow({
    ...limits,
    header: rows.find((row) => isRecord(row.event) && row.event.type === "session"),
    newestRows: active
      .filter((row) => row.contextEligible === 1 || retained.has(row.seq))
      .toReversed(),
    readBoundary: () => ({ boundary, boundaryCount: boundaries.length }),
    activeLeafEntryId: tree.appendParentId,
    totalEvents: active.length,
    readVersion: () => version,
    readPayloads,
    readParents: (selected, payloads) =>
      new Map(
        selected.flatMap((seq) => {
          const id = readTranscriptEventId(payloads.get(seq));
          return id ? [[id, parents.get(id) ?? null] as const] : [];
        }),
      ),
    readRetentionRanges: (selected, headerOffset) =>
      resolveBoundedRetentionRanges(selected, headerOffset, sequences, true),
  });
}

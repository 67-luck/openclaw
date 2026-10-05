import { sql } from "kysely";
import type { LabelEntry } from "../../agents/sessions/session-manager-types.js";
import {
  executeSqliteQuerySync,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { iterateUnindexedTranscriptNavigation } from "./session-accessor.sqlite-history-navigation.js";
import {
  getActiveTranscriptKysely,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import {
  parseTranscriptHistoryNavigationOrIdentity,
  selectTranscriptHistoryNavigationSql,
} from "./session-context-usage-evidence.sqlite.js";
import { SessionLabelAdmissionReader } from "./session-label-admission.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { isCanonicalSessionTranscriptEntry } from "./transcript-tree.js";

export type SessionLabelTargetPin = { seq: number; serializedBytes: number; type: string };

/** Label dependencies join the retained metadata set; each target is resolved once per snapshot. */
export function collectSessionLabelDependencies<T extends { seq: number; type: string }>(
  selectedLabelSequences: Iterable<number>,
  readLabels: (sequences: ReadonlySet<number>) => ReadonlyMap<number, LabelEntry>,
  readTargets: (ids: ReadonlySet<string>) => ReadonlyMap<string, T>,
) {
  const requiredLabels = new Set(selectedLabelSequences);
  const pendingLabels = new Set(requiredLabels);
  const latest = new Map<string, number>();
  const liveTargets = new Set<string>();
  const pendingTargets = new Set<string>();
  const resolvedTargets = new Set<string>();
  const targetPins = new Map<string, T>();
  let admittedLabels: ReadonlyMap<number, LabelEntry> = new Map();
  while (pendingLabels.size > 0) {
    admittedLabels = readLabels(pendingLabels);
    for (const seq of pendingLabels) {
      const label = admittedLabels.get(seq);
      if (!label || (latest.get(label.targetId) ?? -1) >= seq) {
        continue;
      }
      latest.set(label.targetId, seq);
      if (label.label) {
        liveTargets.add(label.targetId);
        if (!resolvedTargets.has(label.targetId)) {
          pendingTargets.add(label.targetId);
        }
      } else {
        liveTargets.delete(label.targetId);
        pendingTargets.delete(label.targetId);
      }
    }
    pendingLabels.clear();
    for (const id of pendingTargets) {
      resolvedTargets.add(id);
    }
    for (const [id, target] of readTargets(pendingTargets)) {
      targetPins.set(id, target);
      if (target.type === "label" && !requiredLabels.has(target.seq)) {
        requiredLabels.add(target.seq);
        pendingLabels.add(target.seq);
      }
    }
    pendingTargets.clear();
  }
  return {
    admittedLabels,
    targetPins: new Map(
      [...targetPins].filter(
        ([id, target]) =>
          (liveTargets.has(id) || target.type === "label") &&
          (target.type !== "label" || admittedLabels.has(target.seq)),
      ),
    ),
  };
}

/** Worker/native owners extend the same chronological scan only for newly required label rows. */
export function readSessionLabelDependencies(
  projection: CurrentTranscriptProjection,
  selectedLabelSequences: ReadonlySet<number>,
  beforeRawSeq?: number,
) {
  const admission = new SessionLabelAdmissionReader();
  let through = -1;
  return collectSessionLabelDependencies(
    selectedLabelSequences,
    (sequences) => {
      let last = through;
      for (const seq of sequences) {
        last = Math.max(last, seq);
      }
      if (last > through) {
        admission.read(
          (function* () {
            for (const row of iterateSqliteQuerySync(
              projection.database.db,
              getActiveTranscriptKysely(projection.database)
                .selectFrom("transcript_events as event")
                .leftJoin("transcript_event_identities as identity", (join) =>
                  join
                    .onRef("identity.session_id", "=", "event.session_id")
                    .onRef("identity.seq", "=", "event.seq"),
                )
                .select([
                  "event.seq",
                  "identity.event_id",
                  "identity.event_type",
                  ...selectTranscriptHistoryNavigationSql("event"),
                ])
                .where("event.session_id", "=", projection.resolved.sessionId)
                .where("event.seq", ">", through)
                .where("event.seq", "<=", last)
                .orderBy("event.seq", "asc"),
            )) {
              const parsed = parseTranscriptHistoryNavigationOrIdentity(row);
              if (parsed.kind === "navigation") {
                yield { seq: row.seq, event: parsed.entry };
              } else if (isCanonicalSessionTranscriptEntry(parsed.entry)) {
                yield { seq: row.seq, unavailable: { id: parsed.entry.id, error: parsed.error } };
              }
            }
          })(),
        );
        through = last;
      }
      admission.assertAvailable(sequences);
      return admission.labels;
    },
    (ids) => readSessionLabelTargetPins(projection, ids, beforeRawSeq),
  );
}

/** Exact indexed ownership overrides the final legacy row, including opaque replacements. */
function readSessionLabelTargetPins(
  projection: CurrentTranscriptProjection,
  targets: ReadonlySet<string>,
  beforeRawSeq?: number,
): Map<string, SessionLabelTargetPin> {
  const pins = new Map<string, SessionLabelTargetPin>();
  if (targets.size === 0) {
    return pins;
  }
  const ids = [...targets];
  for (const row of iterateUnindexedTranscriptNavigation(projection, {
    eventIds: ids,
    maxRawSeq: beforeRawSeq === undefined ? undefined : beforeRawSeq - 1,
  })) {
    const id = row.event.id;
    if (typeof id !== "string" || !targets.has(id)) {
      continue;
    }
    if (isCanonicalSessionTranscriptEntry(row.event)) {
      pins.set(id, {
        seq: row.event_seq,
        serializedBytes: row.serialized_bytes,
        type: row.event.type,
      });
    } else {
      pins.delete(id);
    }
  }
  const rows = executeSqliteQuerySync(
    projection.database.db,
    getActiveTranscriptKysely(projection.database)
      .selectFrom("transcript_event_identities as identity")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "identity.session_id")
          .onRef("event.seq", "=", "identity.seq"),
      )
      .select([
        "identity.seq",
        "identity.event_id",
        "identity.event_type",
        /* kysely-allow-raw: live label targets are explicit SDK dependencies, outside model membership. */
        sql<number>`${transcriptEventReadBytesSql("event")} + 1`.as("serialized_bytes"),
      ])
      .where("identity.session_id", "=", projection.resolved.sessionId)
      .where("identity.event_id", "in", sqliteStringSet(ids))
      .$if(beforeRawSeq !== undefined, (query) => query.where("identity.seq", "<", beforeRawSeq!)),
  ).rows;
  for (const row of rows) {
    const identity = { type: row.event_type };
    if (isCanonicalSessionTranscriptEntry(identity)) {
      pins.set(row.event_id, {
        seq: row.seq,
        serializedBytes: row.serialized_bytes,
        type: identity.type,
      });
    } else {
      pins.delete(row.event_id);
    }
  }
  return pins;
}

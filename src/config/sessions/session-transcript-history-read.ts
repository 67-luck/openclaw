import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { collectEntriesForBranchSummaryFromBranches } from "../../../packages/agent-core/src/harness/compaction/branch-summarization.js";
import type { SessionEntry } from "../../agents/sessions/session-manager-types.js";
import { iterateSqliteQuerySync, prepareSqliteQuerySync } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import type {
  SessionTranscriptBoundedActiveContext,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { collectCacheTtlProjectionPrefix } from "./session-cache-ttl-prefix.js";
import { readWithCanonicalSessionAdmission } from "./session-canonical-key.js";
import {
  selectSessionResidentEvidence,
  type SessionContextUsageReader,
} from "./session-context-usage-evidence.js";
import {
  parseTranscriptHistoryNavigation,
  readSessionTranscriptUsageEvidence,
  selectTranscriptHistoryNavigationSql,
} from "./session-context-usage-evidence.sqlite.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import {
  createSessionTranscriptNavigationFacts,
  normalizeSessionContextEntryBoundaries,
  resolveSessionCanonicalParentId,
} from "./session-entry-navigation.js";
import {
  assertSessionHistoryCollectionBudget,
  selectSessionHistoryContext,
  selectSessionHistoryWindow,
  selectSessionTerminalMessageAfter,
} from "./session-history-context.js";
import { SessionLabelAdmissionReader } from "./session-label-admission.js";
import { collectSessionLabelDependencies } from "./session-label-targets.js";
import type {
  SessionTranscriptMaintenanceFacts,
  SessionTranscriptMaintenanceRead,
} from "./session-transcript-hydration.types.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  projectTranscriptRetainedDataSql,
  transcriptRetainedDataBytesSql,
} from "./session-transcript-retained-data.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

type HistoryRequest = Extract<SessionTranscriptMaintenanceRead, { operation: "history-page" }>;
type HistoryEntry = SessionEntry & { seq: number; serializedBytes: number };

function selectBoundedHistoryContext(
  canonicalBranch: HistoryEntry[],
  allEntries: Iterable<HistoryEntry>,
  header: { seq: number; serializedBytes: number } | undefined,
  request: HistoryRequest,
  version: SessionTranscriptBoundedActiveContext["version"],
  read: (entry: { seq: number }) => TranscriptEvent,
  readUsage: SessionContextUsageReader<HistoryEntry>,
  labelAdmission: SessionLabelAdmissionReader,
  prepareNavigation: (
    retainedIds: ReadonlySet<string>,
  ) => ReturnType<typeof createSessionTranscriptNavigationFacts>,
): SessionTranscriptBoundedActiveContext {
  if (!header || header.serializedBytes > request.maxBytes) {
    throw new Error("Session transcript header is unavailable within the context limit");
  }
  const retainedIds = new Set(request.retainedEntryIds);
  const window = selectSessionHistoryWindow(canonicalBranch, {
    ...request,
    headerBytes: header.serializedBytes,
    retainedEntryIds: retainedIds,
    bytesFor: (entry) => entry.serializedBytes,
  });
  const {
    canonicalById,
    context,
    selected,
    selectedLeaf,
    contextStartEntryId,
    modelEntries,
    truncated,
  } = window;
  let { serializedBytes } = window;
  // Synchronous SDK metadata keeps its existing rows and the exact targets of live labels.
  const entriesById = new Map<string, HistoryEntry>();
  for (const entry of allEntries) {
    entriesById.set(entry.id, entry);
    if (retainedIds.has(entry.id) && entry.type !== "message" && !selected.has(entry.id)) {
      selected.set(entry.id, canonicalById.get(entry.id) ?? entry);
      serializedBytes += entry.serializedBytes;
    }
  }
  const labelDependencies = collectSessionLabelDependencies(
    [...selected.values()].flatMap((entry) => (entry.type === "label" ? [entry.seq] : [])),
    (sequences) => {
      labelAdmission.assertAvailable(sequences);
      return labelAdmission.labels;
    },
    (ids) =>
      new Map(
        [...ids].flatMap((id) => {
          const target = entriesById.get(id);
          return target ? [[id, target] as const] : [];
        }),
      ),
  );
  for (const [id, target] of labelDependencies.targetPins) {
    if (!selected.has(id)) {
      selected.set(id, canonicalById.get(id) ?? target);
      serializedBytes += target.serializedBytes;
    }
  }
  // Current-turn anchors and inspection witnesses do not extend the selected prompt window.
  for (const entry of selectSessionResidentEvidence(
    canonicalBranch.filter(
      (candidate) => candidate.type !== "message" || context.has(candidate.id),
    ),
    readUsage,
  ).retainedEntries) {
    if (!selected.has(entry.id)) {
      selected.set(entry.id, entry);
      serializedBytes += entry.serializedBytes;
    }
  }
  const ordered = [...selected.values()].toSorted((left, right) => left.seq - right.seq);
  const payloads = new Map(ordered.map((entry) => [entry.id, read(entry)]));
  const cacheTtlProjectionPrefixes: NonNullable<
    SessionTranscriptBoundedActiveContext["cacheTtlProjectionPrefixes"]
  > = [];
  let previousSelectedIndex = -1;
  for (let index = 0; index < canonicalBranch.length; index++) {
    const anchor = canonicalBranch[index]!;
    if (!selected.has(anchor.id)) {
      continue;
    }
    if (index > previousSelectedIndex + 1) {
      const prefix = collectCacheTtlProjectionPrefix(
        { id: anchor.id, entry: payloads.get(anchor.id) },
        (function* () {
          for (let cursor = index - 1; cursor > previousSelectedIndex; cursor--) {
            const entry = canonicalBranch[cursor]!;
            if (entry.type === "reset") {
              yield entry;
            } else if (entry.type === "custom" && entry.customType === "openclaw.cache-ttl") {
              yield read(entry);
            }
          }
        })(),
      );
      if (prefix) {
        cacheTtlProjectionPrefixes.push(prefix);
      }
    }
    previousSelectedIndex = index;
  }
  const parents: SessionTranscriptBoundedActiveContext["parents"] = new Map();
  const entryTranscriptSeqs = new Map<string, number>();
  const opaqueParents = new Map<string, string | null>();
  const navigationFor = prepareNavigation(new Set(selected.keys()));
  const retainNavigation = (id: string | null) => {
    const facts = id === null ? undefined : navigationFor(id);
    if (facts) {
      parents.set(id!, facts.parents);
      entryTranscriptSeqs.set(id!, facts.transcriptSeq);
    }
    return facts;
  };
  for (const entry of ordered) {
    const facts = retainNavigation(entry.id);
    if (!facts) {
      continue;
    }
    const { rawParentId, canonicalParentId } = facts.parents;
    const rawParent = retainNavigation(rawParentId);
    const canonicalParent = retainNavigation(canonicalParentId);
    if (rawParentId !== null && !rawParent) {
      opaqueParents.set(rawParentId, canonicalParentId);
    }
    if (canonicalParentId !== null && !selected.has(canonicalParentId)) {
      opaqueParents.set(canonicalParentId, canonicalParent?.retainedParentId ?? null);
    }
  }
  if (selectedLeaf && !selected.has(selectedLeaf.id)) {
    const facts = retainNavigation(selectedLeaf.id);
    opaqueParents.set(selectedLeaf.id, facts?.retainedParentId ?? null);
  }
  const firstKeptRanges = new Map<string, { startIndex: number; endIndex: number }>();
  for (let index = 0; index < ordered.length; index++) {
    const entry = ordered[index]!;
    if (
      (entry.type !== "compaction" && entry.type !== "reset") ||
      !parents.has(entry.id) ||
      !entry.firstKeptEntryId
    ) {
      continue;
    }
    const first = canonicalBranch.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
    const boundaryIndex = canonicalBranch.findIndex((candidate) => candidate.id === entry.id);
    const firstSelected =
      first < 0
        ? undefined
        : canonicalBranch
            .slice(first, boundaryIndex)
            .find((candidate) => selected.has(candidate.id));
    const startIndex = firstSelected
      ? ordered.findIndex((candidate) => candidate.id === firstSelected.id)
      : index;
    firstKeptRanges.set(entry.id, { startIndex: startIndex + 1, endIndex: index + 1 });
  }
  if (request.leafId !== null && request.leafId !== selectedLeaf?.id) {
    opaqueParents.set(request.leafId, selectedLeaf?.id ?? null);
  }
  return {
    version,
    contextStartEntryId,
    entryTranscriptSeqs,
    residentContextEntryIndexes: ordered.flatMap((entry, index) =>
      modelEntries.has(entry) ? [index + 1] : [],
    ),
    admittedLabelRecords: ordered.flatMap((entry, index) =>
      labelAdmission.labels.has(entry.seq) ? [{ eventIndex: index + 1, rawSeq: entry.seq }] : [],
    ),
    activeLeafEntryId: request.leafId,
    selectedLeafEntryId: request.leafId,
    opaqueParents,
    parents,
    firstKeptRanges,
    persistedSuffixStartSeq: ordered[0]?.seq ?? header.seq + 1,
    boundaryCount: canonicalBranch.filter(
      (entry) => entry.type === "compaction" || entry.type === "reset",
    ).length,
    events: [read(header), ...ordered.map((entry) => payloads.get(entry.id)!)],
    cacheTtlProjectionPrefixes,
    serializedBytes,
    totalEvents: canonicalBranch.length,
    transcriptMutationAt: version.updatedAt,
    truncated,
  };
}

/** Payloads remain page-bounded; the worker owns canonical navigation and context selection. */
export function readSessionTranscriptHistoryPage(
  database: OpenClawAgentReadOnlyDatabase,
  target: SessionTranscriptRuntimeTarget,
  request: HistoryRequest,
): SessionTranscriptMaintenanceFacts {
  return readWithCanonicalSessionAdmission(database, () =>
    runSqliteDeferredTransactionSync(database.db, () => {
      const version = readTranscriptContextVersionInTransaction(database, target.sessionId);
      if (
        version.generation !== request.version.generation ||
        version.rawSeq !== request.version.rawSeq ||
        version.updatedAt !== request.version.updatedAt
      ) {
        throw new Error("Session transcript changed during history acquisition");
      }
      // The manager's committed version admits its own suffix beyond the original user fence.
      // Validate that original authority without applying its older acquisition cutoff.
      resolveSqliteSessionTranscriptReadFence({ database, ...target });
      const base = getSessionKysely(database.db)
        .selectFrom("transcript_events")
        .where("session_id", "=", target.sessionId);
      let header: { seq: number; serializedBytes: number } | undefined;
      const tree = scanSessionTranscriptTree(
        (function* () {
          for (const row of iterateSqliteQuerySync(
            database.db,
            base
              .select([
                "seq",
                transcriptRetainedDataBytesSql(request.retainedCustomDataIds).as("serializedBytes"),
                ...selectTranscriptHistoryNavigationSql(),
              ])
              .orderBy("seq", "asc"),
          )) {
            const navigation = parseTranscriptHistoryNavigation(row);
            if (!isRecord(navigation)) {
              continue;
            }
            if (navigation.type === "session") {
              header ??= { seq: row.seq, serializedBytes: row.serializedBytes };
            }
            yield {
              ...navigation,
              seq: row.seq,
              serializedBytes: row.serializedBytes,
            };
          }
          if (request.pendingLeafControl) {
            // The same scanner owns committed and prospective reset-aware leaf selection.
            yield { ...request.pendingLeafControl, seq: version.rawSeq + 1, serializedBytes: 0 };
          }
        })(),
      );
      if (request.appendParentId !== null && !tree.byId.has(request.appendParentId)) {
        throw new Error("Session history append cursor is no longer available");
      }
      if (request.selection === "identity") {
        const node = request.leafId !== null ? tree.byId.get(request.leafId) : undefined;
        const entry = node?.entry;
        const canonical = isIndexedSessionEntry(entry);
        const firstCanonicalRawSeq = node
          ? tree.nodes.find(
              (candidate) => candidate.id === node.id && isIndexedSessionEntry(candidate.entry),
            )?.entry.seq
          : undefined;
        return {
          kind: "transcript-maintenance",
          version,
          entryNavigation: node
            ? {
                id: node.id,
                rawSeq: node.entry.seq,
                ...(firstCanonicalRawSeq === undefined ? {} : { firstCanonicalRawSeq }),
                type: canonical ? entry.type : "opaque",
                parentId: node.parentId,
                canonicalParentId: resolveSessionCanonicalParentId(
                  node.parentId,
                  { has: (id) => isIndexedSessionEntry(tree.byId.get(id)?.entry) },
                  { get: (id) => tree.byId.get(id)?.parentId },
                ),
                ...(canonical && entry.type === "message"
                  ? { messageRole: entry.message.role }
                  : {}),
              }
            : null,
        };
      }
      if (request.leafId !== null && !tree.byId.has(request.leafId)) {
        throw new Error(`Entry ${request.leafId} not found`);
      }
      const pendingControl = request.pendingLeafControl;
      if (pendingControl) {
        const appendParentId =
          pendingControl.appendParentId === undefined
            ? pendingControl.targetId
            : pendingControl.appendParentId;
        if (appendParentId !== null && !tree.byId.has(appendParentId)) {
          throw new Error(`Append parent ${appendParentId} not found`);
        }
        request = { ...request, leafId: tree.leafId };
      }
      const branchFor = (leafId: string | null) => {
        const entries: HistoryEntry[] = [];
        for (const { entry, parentId: rawParentId } of selectSessionTranscriptTreePathNodes(
          tree,
          leafId,
        )) {
          if (isIndexedSessionEntry(entry)) {
            const parentId = resolveSessionCanonicalParentId(
              rawParentId,
              { has: (id) => isIndexedSessionEntry(tree.byId.get(id)?.entry) },
              { get: (id) => tree.byId.get(id)?.parentId },
            );
            entries.push(entry.parentId === parentId ? entry : { ...entry, parentId });
          }
        }
        return normalizeSessionContextEntryBoundaries(entries, tree.nodes);
      };
      let branch = branchFor(request.leafId);
      if (request.selection === "terminal-after-boundary") {
        return {
          kind: "transcript-maintenance",
          version,
          terminalMessageEntryId:
            selectSessionTerminalMessageAfter(branch, request.boundaryEntryId ?? null) ?? null,
        };
      }
      let targetEntry: HistoryEntry | undefined;
      let commonAncestorId: string | null = null;
      if (request.selection === "abandoned") {
        const targetBranch = branchFor(request.targetLeafId ?? null);
        targetEntry = targetBranch.find((entry) => entry.id === request.targetLeafId);
        if (!targetEntry) {
          throw new Error(`Entry ${request.targetLeafId} not found`);
        }
        const abandoned = collectEntriesForBranchSummaryFromBranches(branch, targetBranch);
        branch = abandoned.entries;
        commonAncestorId = abandoned.commonAncestorId;
      }
      const thinking = branch.findLast((entry) => entry.type === "thinking_level_change");
      const model = branch.findLast(
        (entry) =>
          entry.type === "model_change" ||
          (entry.type === "message" && entry.message.role === "assistant"),
      );
      const contextState = {
        thinkingLevel: thinking?.type === "thinking_level_change" ? thinking.thinkingLevel : "off",
        model:
          model?.type === "model_change"
            ? { provider: model.provider, modelId: model.modelId }
            : model?.type === "message" && model.message.role === "assistant"
              ? { provider: model.message.provider, modelId: model.message.model }
              : null,
      };
      const selection =
        request.selection === "context"
          ? selectSessionHistoryContext(branch, request.contextStartEntryId)
          : branch;
      if (request.direction === "reverse") {
        selection.reverse();
      }
      const payload = prepareSqliteQuerySync<{ seq: number }, { event_json: string }>(
        database.db,
        (parameter) =>
          base
            .select(
              projectTranscriptRetainedDataSql(
                transcriptEventJsonSql(database.db),
                request.retainedCustomDataIds,
              ).as("event_json"),
            )
            .where(
              "seq",
              "=",
              parameter((entry) => entry.seq),
            ),
      );
      if (request.selection === "window") {
        const labelAdmission = new SessionLabelAdmissionReader();
        labelAdmission.read(tree.nodes.map(({ entry }) => ({ event: entry, seq: entry.seq })));
        const selectedContext = selectBoundedHistoryContext(
          branch,
          tree.nodes
            .filter((node) => tree.byId.get(node.id) === node)
            .map(({ entry }) => entry)
            .filter((entry): entry is HistoryEntry => isIndexedSessionEntry(entry)),
          header,
          request,
          version,
          (entry) => {
            const row = payload(entry).rows[0];
            if (!row) {
              throw new Error("Selected session history entry is unavailable");
            }
            const event: TranscriptEvent = JSON.parse(row.event_json);
            return event;
          },
          (entries) => readSessionTranscriptUsageEvidence(database.db, target.sessionId, entries),
          labelAdmission,
          (retainedIds) => createSessionTranscriptNavigationFacts(tree.byId, retainedIds),
        );
        const leafControlNavigation = pendingControl
          ? {
              targetId: tree.leafId,
              appendParentId: tree.appendParentId,
              appendMode: tree.byId.get(pendingControl.id)?.appendMode,
            }
          : undefined;
        if (leafControlNavigation) {
          selectedContext.activeLeafEntryId = leafControlNavigation.appendParentId;
        }
        return { kind: "transcript-maintenance", version, selectedContext, leafControlNavigation };
      }
      let oversizedBytes = 0;
      const targetPayload =
        targetEntry && request.offset === 0
          ? (() => {
              if (targetEntry.serializedBytes > request.maxBytes) {
                if (
                  request.oversizedToolResults !== "complete" ||
                  targetEntry.type !== "message" ||
                  targetEntry.message.role !== "toolResult"
                ) {
                  throw new RangeError(
                    "Session navigation target exceeds the acquisition byte limit",
                  );
                }
                oversizedBytes = targetEntry.serializedBytes;
              }
              assertSessionHistoryCollectionBudget(
                targetEntry.serializedBytes,
                oversizedBytes,
                request.collectionBudget,
              );
              const row = payload(targetEntry).rows[0];
              if (!row) {
                throw new Error("Selected session navigation target is unavailable");
              }
              const event: unknown = JSON.parse(row.event_json);
              if (!isIndexedSessionEntry(event)) {
                throw new Error("Selected session navigation target is not canonical");
              }
              return {
                ...event,
                parentId: targetEntry.parentId,
              };
            })()
          : undefined;
      const events: SessionEntry[] = [];
      const rawParentIds = new Map<string, string | null>();
      let serializedBytes = targetPayload ? targetEntry!.serializedBytes : 0;
      // The target owns the first continuation slot, including a target-only first page.
      const targetOffset = targetEntry ? 1 : 0;
      let offset = Math.max(0, request.offset - targetOffset);
      for (; offset < selection.length && events.length < request.maxEvents; offset++) {
        const entry = selection[offset]!;
        if (entry.serializedBytes > request.maxBytes) {
          if (serializedBytes > 0) {
            break;
          }
          if (
            request.oversizedToolResults !== "complete" ||
            entry.type !== "message" ||
            entry.message.role !== "toolResult"
          ) {
            throw new RangeError("Session history entry exceeds the acquisition byte limit");
          }
          // Recovery must see one complete result before the existing planner can shrink it.
          oversizedBytes = entry.serializedBytes;
        }
        if (serializedBytes > 0 && serializedBytes + entry.serializedBytes > request.maxBytes) {
          break;
        }
        assertSessionHistoryCollectionBudget(
          serializedBytes + entry.serializedBytes,
          oversizedBytes,
          request.collectionBudget,
        );
        const row = payload(entry).rows[0];
        if (!row) {
          throw new Error("Selected session history entry is unavailable");
        }
        const event: unknown = JSON.parse(row.event_json);
        if (!isIndexedSessionEntry(event)) {
          throw new Error("Selected session history entry is not canonical");
        }
        events.push({
          ...event,
          parentId: entry.parentId,
          ...((entry.type === "compaction" || entry.type === "reset") &&
          entry.firstKeptEntryId !== undefined
            ? { firstKeptEntryId: entry.firstKeptEntryId }
            : {}),
        });
        rawParentIds.set(entry.id, tree.byId.get(entry.id)!.parentId);
        serializedBytes += entry.serializedBytes;
      }
      return {
        kind: "transcript-maintenance",
        version,
        events,
        rawParentIds,
        serializedBytes,
        oversizedBytes,
        contextState,
        ...(targetPayload ? { targetEntry: targetPayload } : {}),
        ...(request.selection === "abandoned" ? { commonAncestorId } : {}),
        complete: offset === selection.length,
        ...(offset < selection.length ? { nextOffset: offset + targetOffset } : {}),
      };
    }),
  );
}

import { collectEntriesForBranchSummaryFromBranches } from "../../../packages/agent-core/src/harness/compaction/branch-summarization.js";
import { buildSessionContext } from "../../../packages/agent-core/src/harness/session/session.js";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import {
  MAX_VISIBLE_MESSAGE_MAX_BYTES,
  MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
  normalizeVisibleMessageLimit,
} from "../../config/sessions/session-accessor.sqlite-visible-cursor.js";
import {
  assertSessionHistoryCollectionBudget,
  SESSION_HISTORY_COLLECTION_ENTRIES,
  SESSION_HISTORY_PAGE_BYTES,
  selectSessionHistoryContext,
  selectResidentSessionHistoryContext,
  selectSessionTerminalMessageAfter,
  type SessionHistoryCollectionBudget,
} from "../../config/sessions/session-history-context.js";
import type {
  SessionHistoryEntryNavigation,
  SessionLeafControlNavigation,
} from "../../config/sessions/session-transcript-hydration.types.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { isIndexedSessionEntry } from "./session-manager-codec.js";
import { prepareSessionManagerHydration } from "./session-manager-incognito.js";
import type { SessionEntry, SessionLeafControl } from "./session-manager-types.js";
import type {
  PreparedSessionTranscriptReload,
  SessionManagerBoundedContextLimits,
} from "./session-manager-view-types.js";
import type { SessionManager } from "./session-manager.js";

/** @internal Operation-owned history never expands the manager's resident view. */
export const sessionManagerPrepareHistoryRead: unique symbol = Symbol.for(
  "openclaw.session-manager.prepare-history-read",
);

type HistoryView = {
  transcriptVersion: SessionTranscriptContextVersion | undefined;
  boundedContextIncomplete: boolean;
  appendParentId: string | null;
  leafId: string | null;
  rawLeafId: string | null;
  contextStartEntryId?: string | null;
  byId: ReadonlyMap<string, SessionEntry>;
  residentContextEntries: ReadonlySet<SessionEntry> | undefined;
  opaqueParentsById: ReadonlyMap<string, string | null>;
};

type HistorySelection = {
  leafId?: string | null;
  selection?: "context" | "branch" | "abandoned";
  targetLeafId?: string;
  direction?: "forward" | "reverse";
  maxBytes?: number;
  maxEvents?: number;
  oversizedToolResults?: "complete";
  reuseResidentCustomData?: boolean;
};

export function prepareSessionManagerHistoryRead(
  manager: Pick<SessionManager, "getSessionTarget" | "getBranch">,
  readView: () => HistoryView,
  assertWriteActive: () => void,
  publication: { assertCurrent(): void; assertNavigationCurrent(): void },
  signal?: AbortSignal,
) {
  assertWriteActive();
  const view = readView();
  const target = manager.getSessionTarget();
  const version = view.transcriptVersion ? { ...view.transcriptVersion } : undefined;
  const assertOwned = target ? captureOwnedTranscriptWriteAssertion(target) : undefined;
  const reader = target
    ? prepareSessionManagerHydration(target, undefined, signal, manager)
    : undefined;
  const assertNavigationCurrent = () => {
    signal?.throwIfAborted();
    assertWriteActive();
    assertOwned?.();
    publication.assertNavigationCurrent();
    reader?.assertCurrent();
  };
  const assertCurrent = () => {
    assertNavigationCurrent();
    publication.assertCurrent();
  };
  assertCurrent();
  async function* readPages(
    options: HistorySelection = {},
    collectionBudget?: SessionHistoryCollectionBudget,
  ) {
    assertCurrent();
    const maxBytes = normalizeVisibleMessageLimit(
      options.maxBytes,
      SESSION_HISTORY_PAGE_BYTES,
      MAX_VISIBLE_MESSAGE_MAX_BYTES,
      "maxBytes",
    );
    const maxEvents = normalizeVisibleMessageLimit(
      options.maxEvents,
      1_000,
      MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
      "maxEvents",
    );
    const selection = options.selection ?? "context";
    const leafId = options.leafId === undefined ? view.rawLeafId : options.leafId;
    const direction = options.direction ?? "forward";
    const retainedCustomData = new Map(
      options.reuseResidentCustomData
        ? [...view.byId].flatMap(([id, entry]) =>
            entry.type === "custom" && entry.data !== undefined ? [[id, entry.data] as const] : [],
          )
        : [],
    );
    if (!reader) {
      // Navigation admitted the default selection; explicit IDs can also name opaque ancestors.
      if (
        options.leafId !== undefined &&
        leafId !== null &&
        !view.byId.has(leafId) &&
        !view.opaqueParentsById.has(leafId)
      ) {
        throw new Error(`Entry ${leafId} not found`);
      }
      let branch = leafId === null ? [] : manager.getBranch(leafId);
      const targetBranch =
        options.targetLeafId && view.byId.has(options.targetLeafId)
          ? manager.getBranch(options.targetLeafId)
          : [];
      const targetEntry = targetBranch.at(-1);
      let commonAncestorId: string | null = null;
      if (selection === "abandoned") {
        if (!targetEntry) {
          throw new Error(`Entry ${options.targetLeafId} not found`);
        }
        const abandoned = collectEntriesForBranchSummaryFromBranches(branch, targetBranch);
        branch = abandoned.entries;
        commonAncestorId = abandoned.commonAncestorId;
      }
      const { thinkingLevel, model } = buildSessionContext(branch);
      const contextState = { thinkingLevel, model };
      const entries =
        selection === "context"
          ? leafId === view.rawLeafId && view.residentContextEntries
            ? [
                ...selectResidentSessionHistoryContext(
                  branch,
                  view.residentContextEntries,
                  view.byId,
                ),
              ]
            : selectSessionHistoryContext(
                branch,
                leafId === view.rawLeafId ? view.contextStartEntryId : undefined,
              )
          : branch;
      if (direction === "reverse") {
        entries.reverse();
      }
      const entryBytes = (entry: SessionEntry) =>
        Buffer.byteLength(
          JSON.stringify(
            retainedCustomData.has(entry.id) && entry.type === "custom"
              ? { ...entry, data: undefined }
              : entry,
          ),
        );
      let page: SessionEntry[] = [];
      let pendingTarget = targetEntry;
      let serializedBytes = pendingTarget ? entryBytes(pendingTarget) : 0;
      let oversizedBytes = serializedBytes > maxBytes ? serializedBytes : 0;
      if (
        oversizedBytes > 0 &&
        (options.oversizedToolResults !== "complete" ||
          pendingTarget?.type !== "message" ||
          pendingTarget.message.role !== "toolResult")
      ) {
        throw new RangeError("Session navigation target exceeds the acquisition byte limit");
      }
      assertSessionHistoryCollectionBudget(serializedBytes, oversizedBytes, collectionBudget);
      const takePage = () => {
        const result = {
          entries: page,
          rawParentIds: undefined,
          serializedBytes,
          oversizedBytes,
          contextState,
          targetEntry: pendingTarget,
          commonAncestorId,
        };
        page = [];
        serializedBytes = 0;
        pendingTarget = undefined;
        oversizedBytes = 0;
        return result;
      };
      for (const entry of entries) {
        const bytes = entryBytes(entry);
        if (bytes > maxBytes) {
          if (serializedBytes > 0) {
            yield takePage();
            assertCurrent();
          }
          if (
            options.oversizedToolResults !== "complete" ||
            entry.type !== "message" ||
            entry.message.role !== "toolResult"
          ) {
            throw new RangeError("Session history entry exceeds the acquisition byte limit");
          }
          assertSessionHistoryCollectionBudget(bytes, bytes, collectionBudget);
          page = [entry];
          serializedBytes = bytes;
          oversizedBytes = bytes;
          yield takePage();
          assertCurrent();
          continue;
        }
        if (page.length >= maxEvents || serializedBytes + bytes > maxBytes) {
          yield takePage();
          assertCurrent();
        }
        assertSessionHistoryCollectionBudget(serializedBytes + bytes, 0, collectionBudget);
        page.push(entry);
        serializedBytes += bytes;
      }
      yield takePage();
      assertCurrent();
      return;
    }
    if (!version) {
      throw new Error("Session transcript has no committed history version");
    }
    let offset = 0;
    for (;;) {
      assertCurrent();
      const result = await reader.readMaintenance({
        operation: "history-page",
        version,
        appendParentId: view.appendParentId,
        leafId,
        targetLeafId: options.targetLeafId,
        contextStartEntryId: leafId === view.rawLeafId ? view.contextStartEntryId : undefined,
        selection,
        direction,
        offset,
        maxBytes,
        maxEvents,
        oversizedToolResults: options.oversizedToolResults,
        collectionBudget,
        retainedCustomDataIds: [...retainedCustomData.keys()],
      });
      assertCurrent();
      if (
        !result.events ||
        !result.rawParentIds ||
        result.complete === undefined ||
        result.serializedBytes === undefined ||
        !result.contextState
      ) {
        throw new Error("Session history reader returned an incomplete result");
      }
      const entries = result.events.filter(isIndexedSessionEntry);
      // Hydration owns these fresh envelopes; resident custom payloads retain their shared references.
      for (const entry of entries) {
        if (
          entry.type === "custom" &&
          !Object.hasOwn(entry, "data") &&
          retainedCustomData.has(entry.id)
        ) {
          entry.data = retainedCustomData.get(entry.id);
        }
      }
      yield {
        entries,
        rawParentIds: result.rawParentIds,
        serializedBytes: result.serializedBytes,
        oversizedBytes: result.oversizedBytes ?? 0,
        contextState: result.contextState,
        targetEntry: isIndexedSessionEntry(result.targetEntry) ? result.targetEntry : undefined,
        commonAncestorId: result.commonAncestorId ?? null,
      };
      assertCurrent();
      if (result.complete) {
        return;
      }
      if (result.nextOffset === undefined || result.nextOffset <= offset) {
        throw new Error("Session history reader did not advance its continuation");
      }
      offset = result.nextOffset;
    }
  }
  async function collect(options?: HistorySelection) {
    const entries: SessionEntry[] = [];
    const budget: SessionHistoryCollectionBudget = {
      remainingBytes: MAX_VISIBLE_MESSAGE_MAX_BYTES,
      largestOversizedBytes: 0,
    };
    let targetEntry: SessionEntry | undefined;
    let commonAncestorId: string | null = null;
    let contextState: {
      thinkingLevel: string;
      model: { provider: string; modelId: string } | null;
    } = {
      thinkingLevel: "off",
      model: null,
    };
    for await (const page of readPages(options, budget)) {
      const largestOversizedBytes = Math.max(budget.largestOversizedBytes, page.oversizedBytes);
      budget.remainingBytes +=
        largestOversizedBytes - budget.largestOversizedBytes - page.serializedBytes;
      budget.largestOversizedBytes = largestOversizedBytes;
      if (entries.length + page.entries.length > SESSION_HISTORY_COLLECTION_ENTRIES) {
        throw new RangeError("Session history exceeds the operation acquisition limit");
      }
      entries.push(...page.entries);
      contextState = page.contextState;
      targetEntry ??= page.targetEntry;
      commonAncestorId = page.commonAncestorId;
    }
    return { entries, contextState, targetEntry, commonAncestorId };
  }
  return {
    version,
    assertCurrent,
    assertNavigationCurrent,
    async readTerminalMessageAfter(boundaryEntryId: string | null) {
      assertCurrent();
      const branch = manager.getBranch();
      const terminalEntryId = selectSessionTerminalMessageAfter(branch, boundaryEntryId);
      const boundaryIndex =
        boundaryEntryId === null ? -1 : branch.findIndex((entry) => entry.id === boundaryEntryId);
      const suffixStart = terminalEntryId
        ? branch.findIndex((entry) => entry.id === terminalEntryId)
        : boundaryIndex;
      // A known boundary and an uninterrupted tail prove the answer without joining a writer.
      const residentTail =
        (boundaryEntryId === null || boundaryIndex >= 0) &&
        branch.at(-1)?.id === view.leafId &&
        branch
          .slice(suffixStart + 1)
          .every(
            (entry, offset) =>
              view.byId.get(entry.id)?.parentId === (branch[suffixStart + offset]?.id ?? null),
          );
      if (!reader || !view.boundedContextIncomplete || view.leafId === null || residentTail) {
        return terminalEntryId;
      }
      if (!version) {
        throw new Error("Session transcript has no committed history version");
      }
      const result = await reader.readMaintenance({
        operation: "history-page",
        version,
        appendParentId: view.appendParentId,
        leafId: view.leafId,
        selection: "terminal-after-boundary",
        boundaryEntryId,
        direction: "forward",
        offset: 0,
        maxBytes: 1,
        maxEvents: 1,
        retainedCustomDataIds: [],
      });
      assertCurrent();
      if (result.terminalMessageEntryId === undefined) {
        throw new Error("Session history reader returned no terminal message fact");
      }
      return result.terminalMessageEntryId ?? undefined;
    },
    async readEntryNavigation(entryId: string): Promise<SessionHistoryEntryNavigation | undefined> {
      assertCurrent();
      if (!reader) {
        const entry = view.byId.has(entryId) ? manager.getBranch(entryId).at(-1) : undefined;
        return entry
          ? {
              id: entry.id,
              type: entry.type,
              parentId: entry.parentId,
              canonicalParentId: entry.parentId,
              ...(entry.type === "message" ? { messageRole: entry.message.role } : {}),
            }
          : undefined;
      }
      if (!version) {
        throw new Error("Session transcript has no committed history version");
      }
      const result = await reader.readMaintenance({
        operation: "history-page",
        version,
        appendParentId: view.appendParentId,
        leafId: entryId,
        selection: "identity",
        direction: "forward",
        offset: 0,
        maxBytes: 1,
        maxEvents: 1,
        retainedCustomDataIds: [],
      });
      assertCurrent();
      if (result.entryNavigation === undefined) {
        throw new Error("Session history reader returned no entry identity");
      }
      return result.entryNavigation ?? undefined;
    },
    async readSelectedContext(
      leafId: string | null,
      limits: SessionManagerBoundedContextLimits,
      options: {
        retainedEntryIds?: readonly string[];
        preserveContextStart?: boolean;
        pendingLeafControl?: SessionLeafControl;
      } = {},
    ): Promise<
      PreparedSessionTranscriptReload & { leafControlNavigation?: SessionLeafControlNavigation }
    > {
      assertCurrent();
      if (!reader || !version) {
        throw new Error("Selected session context requires committed history");
      }
      const metadata = [...view.byId.values()].filter((entry) => entry.type !== "message");
      const customData = new Map(
        metadata.flatMap((entry) =>
          entry.type === "custom" && entry.data !== undefined
            ? [[entry.id, entry.data] as const]
            : [],
        ),
      );
      const result = await reader.readMaintenance({
        operation: "history-page",
        version,
        appendParentId: view.appendParentId,
        leafId,
        contextStartEntryId: options.preserveContextStart ? view.contextStartEntryId : undefined,
        selection: "window",
        pendingLeafControl: options.pendingLeafControl,
        direction: "forward",
        offset: 0,
        ...limits,
        retainedEntryIds: [
          ...new Set([...metadata.map((entry) => entry.id), ...(options.retainedEntryIds ?? [])]),
        ],
        retainedCustomDataIds: [...customData.keys()],
      });
      assertCurrent();
      if (
        !result.selectedContext ||
        (options.pendingLeafControl && !result.leafControlNavigation)
      ) {
        throw new Error("Session history reader returned no selected context");
      }
      // The acquired snapshot is operation-owned until its caller publishes it.
      for (const entry of result.selectedContext.events) {
        if (isIndexedSessionEntry(entry) && entry.type === "custom" && customData.has(entry.id)) {
          entry.data = customData.get(entry.id);
        }
      }
      return {
        kind: "bounded",
        snapshot: result.selectedContext,
        leafControlNavigation: result.leafControlNavigation,
      };
    },
    pages: readPages,
    async readBranch(options?: HistorySelection) {
      return (await collect(options)).entries;
    },
    async readNavigation(targetLeafId: string) {
      const result = await collect({
        selection: "abandoned",
        targetLeafId,
        oversizedToolResults: "complete",
      });
      if (!result.targetEntry) {
        throw new Error(`Entry ${targetLeafId} not found`);
      }
      return {
        targetEntry: result.targetEntry,
        entriesToSummarize: result.entries,
        commonAncestorId: result.commonAncestorId,
      };
    },
    async readContext() {
      const { entries, contextState } = await collect({ oversizedToolResults: "complete" });
      return { ...buildSessionContext(entries), ...contextState };
    },
  };
}

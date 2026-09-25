import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { iterateSessionContextEntries } from "../../packages/agent-core/src/harness/session/session.js";
import {
  classifyToolUseResultPairing,
  extractToolCallsFromAssistant,
} from "../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import { isIndexedSessionEntry } from "../config/sessions/session-entry-codec.js";
import { normalizeSessionContextEntryBoundaries } from "../config/sessions/session-entry-navigation.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "../config/sessions/transcript-tree.js";
import type { SessionMessageEntry } from "./sessions/session-manager-types.js";

export type PendingToolResultOccurrence = {
  readonly originId: string;
  readonly callIndex: number;
  readonly id: string;
  readonly name?: string;
  /** A later fragment of the same response is not a pending-call boundary. */
  readonly responseIds?: readonly string[];
};

/** Tokens identify exact objects retained by one operation, not provider IDs or durable authority. */
export type PendingToolResultFact = PendingToolResultOccurrence & { readonly token: number };

export class SessionToolResultPendingConflictError extends Error {
  constructor() {
    super("Transcript tool occurrence changed before its prepared operation committed");
    this.name = "SessionToolResultPendingConflictError";
  }
}

function pendingToolResultOccurrences(entry: SessionMessageEntry) {
  const message = entry.message;
  return message.role === "assistant" &&
    message.stopReason !== "error" &&
    message.stopReason !== "aborted"
    ? extractToolCallsFromAssistant(message).map((call, callIndex) => ({
        originId: entry.id,
        callIndex,
        id: call.id,
        name: call.name,
        responseIds: [message.responseId, message.turnId].flatMap(
          (id) => normalizeOptionalString(id) ?? [],
        ),
      }))
    : [];
}

/** Retention can preserve old bodies, but reset history cannot authorize a new repair. */
export function pendingToolResultEntries(events: readonly unknown[], leafId: string | null) {
  const tree = scanSessionTranscriptTree(events);
  const path = selectSessionTranscriptTreePathNodes(tree, leafId);
  const positions = new Map(path.map((node, index) => [node.id, index]));
  const resetIndex = path.findLastIndex(
    (node) => isIndexedSessionEntry(node.entry) && node.entry.type === "reset",
  );
  const entries = normalizeSessionContextEntryBoundaries(
    path.map((node) => node.entry).filter(isIndexedSessionEntry),
    tree.nodes,
  );
  return [...iterateSessionContextEntries(entries)].flatMap(({ entry }) =>
    entry.type === "message" && (positions.get(entry.id) ?? -1) > resetIndex ? [entry] : [],
  );
}

function classifyPendingToolResults<T extends PendingToolResultOccurrence>(
  entries: readonly SessionMessageEntry[],
  calls: readonly T[],
  suffix: readonly AgentMessage[] = [],
) {
  const facts: { call: T; resultIndex?: number }[] = [];
  for (const frame of classifyToolUseResultPairing([
    ...entries.map((entry) => entry.message),
    ...suffix,
  ]).frames) {
    const originId = entries[frame.startIndex]?.id;
    for (const call of calls) {
      if (call.originId !== originId) {
        continue;
      }
      const occurrence = frame.occurrences[call.callIndex];
      if (!occurrence || occurrence.id !== call.id || occurrence.name !== call.name) {
        throw new SessionToolResultPendingConflictError();
      }
      facts.push({ call, resultIndex: occurrence.sourceResultIndex });
    }
  }
  return facts;
}

/** Navigation selects repairable objects; it never retires inactive occurrence custody. */
export function selectActivePendingToolResults<T extends PendingToolResultOccurrence>(
  entries: readonly SessionMessageEntry[],
  calls: readonly T[],
): T[] {
  return classifyPendingToolResults(entries, calls)
    .filter((fact) => fact.resultIndex === undefined)
    .map((fact) => fact.call);
}

/** Resolve names from the same exact occurrence pairing used by native settlement. */
export function selectPendingToolResult(
  entries: readonly SessionMessageEntry[],
  calls: readonly PendingToolResultFact[],
  message: AgentMessage,
) {
  return classifyPendingToolResults(entries, calls, [message]).find(
    (fact) => fact.resultIndex === entries.length,
  )?.call.token;
}

function settlePendingToolResults(params: {
  entries: readonly SessionMessageEntry[];
  entry: SessionMessageEntry;
  calls: readonly PendingToolResultFact[];
  repairedToken?: number;
}) {
  const { entry, entries, calls, repairedToken } = params;
  if (repairedToken !== undefined && !calls.some((call) => call.token === repairedToken)) {
    throw new SessionToolResultPendingConflictError();
  }
  if (entry.message.role !== "toolResult") {
    return repairedToken === undefined ? [] : [repairedToken];
  }
  const facts = classifyPendingToolResults(entries, calls);
  const resultIndex = entries.findIndex((candidate) => candidate.id === entry.id);
  if (
    repairedToken !== undefined &&
    facts.find((fact) => fact.resultIndex === resultIndex)?.call.token !== repairedToken
  ) {
    throw new SessionToolResultPendingConflictError();
  }
  return facts.filter((fact) => fact.resultIndex !== undefined).map((fact) => fact.call.token);
}

export function preparePendingToolResultDelta(params: {
  entry: SessionMessageEntry;
  appended: boolean;
  calls: readonly PendingToolResultFact[];
  repairedToken?: number;
  events(): readonly unknown[];
}) {
  const { entry, calls, repairedToken } = params;
  return {
    remove: settlePendingToolResults({
      entry,
      calls,
      repairedToken,
      entries:
        entry.message.role === "toolResult" && calls.length
          ? pendingToolResultEntries(params.events(), entry.id)
          : [],
    }),
    add: params.appended ? pendingToolResultOccurrences(entry) : [],
  };
}

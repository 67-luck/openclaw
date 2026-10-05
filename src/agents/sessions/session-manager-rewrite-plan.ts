import { stripCompactionReplayCheckpoint } from "@openclaw/ai/transports";
import type {
  TranscriptRewriteReplacement,
  TranscriptRewriteResult,
} from "../../context-engine/types.js";
import { generateSessionEntryId } from "./session-manager-id.js";
import { canonicalizeSessionEntry } from "./session-manager-persistence-entry.js";
import type { SessionTranscriptMessageRewrite } from "./session-manager-rewrite.js";
import type { SessionEntry, SessionLeafControl } from "./session-manager-types.js";

function stripPrefixReplay(message: TranscriptRewriteReplacement["message"]) {
  return message.role === "assistant" ? stripCompactionReplayCheckpoint(message) : message;
}

/** Pure preparation shared by canonical storage and detached, process-owned transcripts. */
export function prepareSessionTranscriptMessageRewrite(
  branch: readonly SessionEntry[],
  request: SessionTranscriptMessageRewrite,
  parentId = branch[0]?.parentId ?? null,
  sourceNavigation?: {
    parents: ReadonlyMap<string, string | null>;
    firstKeptById: ReadonlyMap<string, string>;
  },
): {
  result: TranscriptRewriteResult;
  entries: Array<SessionEntry | SessionLeafControl>;
  sources: Map<string, SessionEntry>;
} {
  const replacements = new Map(
    request.replacements
      .filter(({ entryId }) => entryId.trim().length > 0)
      .map(({ entryId, message }) => [
        entryId,
        request.preserveReplacementCompactionReplay ? message : stripPrefixReplay(message),
      ]),
  );
  let first = -1;
  let bytesFreed = 0;
  let rewrittenEntries = 0;
  for (const [index, entry] of branch.entries()) {
    if (entry.type !== "message") {
      continue;
    }
    const replacement = replacements.get(entry.id);
    if (!replacement) {
      continue;
    }
    const before = JSON.stringify(entry.message);
    const after = JSON.stringify(replacement);
    if (before !== after) {
      if (first < 0) {
        first = index;
      }
      rewrittenEntries++;
      bytesFreed += Math.max(0, Buffer.byteLength(before) - Buffer.byteLength(after));
    }
  }
  const entries: Array<SessionEntry | SessionLeafControl> = [];
  const sources = new Map<string, SessionEntry>();
  if (first < 0) {
    return {
      result: {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason:
          replacements.size === 0
            ? "no replacements requested"
            : branch.length === 0
              ? "empty session"
              : "no changed matching message entries",
      },
      entries,
      sources,
    };
  }
  const ids = new Map<string, string>();
  // An unchanged earlier request can precede omitted opaque ancestors of the first actual rewrite.
  let tail = sourceNavigation
    ? (sourceNavigation.parents.get(branch[first]!.id) ?? null)
    : first === 0
      ? parentId
      : branch[first - 1]!.id;
  const remap = (id: string) => ids.get(id) ?? id;
  for (const source of branch.slice(first)) {
    const id = generateSessionEntryId();
    const entry = canonicalizeSessionEntry({
      ...source,
      ...(source.type === "message"
        ? { message: replacements.get(source.id) ?? stripPrefixReplay(source.message) }
        : {}),
      id,
      parentId: tail,
      timestamp: new Date().toISOString(),
      appendMode: "side",
    });
    if (entry.type === "compaction" || entry.type === "reset") {
      if (entry.firstKeptEntryId) {
        entry.firstKeptEntryId = remap(
          sourceNavigation?.firstKeptById.get(source.id) ?? entry.firstKeptEntryId,
        );
      }
    } else if (entry.type === "label") {
      entry.targetId = remap(entry.targetId);
    } else if (entry.type === "branch_summary") {
      entry.fromId = tail ?? "root";
    }
    entries.push(entry);
    sources.set(id, source);
    ids.set(source.id, id);
    tail = id;
  }
  entries.push({
    type: "leaf",
    id: generateSessionEntryId(),
    parentId: tail,
    targetId: tail,
    timestamp: new Date().toISOString(),
  });
  return { result: { changed: true, bytesFreed, rewrittenEntries }, entries, sources };
}

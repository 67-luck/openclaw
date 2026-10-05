import type { Usage } from "@openclaw/llm-core";
import {
  calculateContextTokens,
  isUnavailableContextBarrier,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { isCompactionReplayCheckpoint } from "../../../packages/ai/src/transports/provider-compaction-checkpoint.js";

export type SessionContextUsageEntry = {
  id: string;
  type: string;
  message?: {
    role: string;
    api?: string;
    stopReason?: string;
    providerReplay?: unknown;
    usage?: Usage;
  };
};

export type SessionContextUsageReader<T> = (
  entries: readonly T[],
) => ReadonlyMap<T, Pick<NonNullable<SessionContextUsageEntry["message"]>, "api" | "usage">>;

/** Current-turn anchors and at most two assistant witnesses survive raw-window eviction. */
export function selectSessionResidentEvidence<T extends SessionContextUsageEntry>(
  entries: Iterable<T>,
  readUsage?: SessionContextUsageReader<T>,
): {
  mode: "usage" | "content" | "unknown";
  retainedEntries: T[];
} {
  let compacted = false;
  let checkpoint: T | undefined;
  const candidates: Array<[T, NonNullable<SessionContextUsageEntry["message"]>]> = [];
  let latestMessage: T | undefined;
  let latestUser: T | undefined;
  for (const entry of entries) {
    if (entry.type === "message") {
      latestMessage = entry;
      if (entry.message?.role === "user") {
        latestUser = entry;
      }
    }
    const assistant =
      entry.type === "message" && entry.message?.role === "assistant" ? entry.message : undefined;
    if (
      entry.type === "compaction" ||
      (assistant && isCompactionReplayCheckpoint(assistant.providerReplay))
    ) {
      compacted = true;
      checkpoint = assistant ? entry : undefined;
      candidates.length = 0;
      continue;
    }
    if (compacted && assistant) {
      candidates.push([entry, assistant]);
    }
  }
  // Earlier boundaries cannot affect the final witness; decode optional usage only now.
  const usageByEntry =
    candidates.length > 0 ? readUsage?.(candidates.map(([entry]) => entry)) : undefined;
  let witness: T | undefined;
  let mode: "usage" | "content" | "unknown" = compacted ? "unknown" : "usage";
  for (const [entry, assistant] of candidates) {
    const { api, usage } = readUsage ? (usageByEntry?.get(entry) ?? {}) : assistant;
    // Barriers invalidate older measurements even on aborted/error responses.
    if (isUnavailableContextBarrier({ role: assistant.role, api, usage })) {
      witness = entry;
      mode = checkpoint ? "unknown" : "content";
      continue;
    }
    if (assistant.stopReason === "aborted" || assistant.stopReason === "error") {
      continue;
    }
    if (!usage || (checkpoint && usage.contextUsage?.state !== "available")) {
      continue;
    }
    if (usage.contextUsage?.state === "unavailable") {
      if (!witness) {
        witness = entry;
        mode = "content";
      }
    } else if (calculateContextTokens(usage) > 0) {
      witness = entry;
      mode = "usage";
    }
  }
  return {
    mode,
    retainedEntries: [
      ...new Set([
        ...(latestMessage ? [latestMessage] : []),
        ...(latestUser ? [latestUser] : []),
        ...(checkpoint ? [checkpoint] : []),
        ...(witness ? [witness] : []),
      ]),
    ],
  };
}

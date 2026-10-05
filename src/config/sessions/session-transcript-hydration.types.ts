import type { SessionLeafControl } from "../../agents/sessions/session-manager-types.js";
import type { DatabaseFileIdentity } from "../../infra/sqlite-worker-identity.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type {
  SessionTranscriptBoundedActiveContext,
  SessionTranscriptContextVersion,
  SessionTranscriptReadScope,
  SessionTranscriptWriteScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import type { ResolvedTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import type { SessionHistoryCollectionBudget } from "./session-history-context.js";
import type {
  PreparedSessionTranscriptHydration,
  SessionTranscriptReadSnapshot,
} from "./session-history-read.types.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

export type { PreparedSessionTranscriptHydration } from "./session-history-read.types.js";

export type SessionHistoryEntryNavigation = {
  id: string;
  rawSeq?: number;
  /** Earliest canonical row for suffix removal; identity fields still describe the winning row. */
  firstCanonicalRawSeq?: number;
  type: string;
  parentId: string | null;
  /** Canonical selection skips opaque links without clipping evicted message ancestors. */
  canonicalParentId: string | null;
  messageRole?: string;
};

export type SessionLeafControlNavigation = {
  targetId: string | null;
  appendParentId: string | null;
  appendMode?: "side";
};

export type SessionTranscriptMaintenanceRead =
  | {
      operation: "history-page";
      version: SessionTranscriptContextVersion;
      appendParentId: string | null;
      leafId: string | null;
      contextStartEntryId?: string | null;
      pendingLeafControl?: SessionLeafControl;
      selection:
        | "context"
        | "branch"
        | "abandoned"
        | "window"
        | "identity"
        | "terminal-after-boundary";
      boundaryEntryId?: string | null;
      targetLeafId?: string;
      direction: "forward" | "reverse";
      offset: number;
      maxBytes: number;
      maxEvents: number;
      oversizedToolResults?: "complete";
      collectionBudget?: SessionHistoryCollectionBudget;
      retainedCustomDataIds: readonly string[];
      retainedEntryIds?: readonly string[];
    }
  | { operation: "identity"; eventId: string }
  | { operation: "version" }
  | {
      operation: "nested-activity";
      scopeId: string;
      firstEntryId: string;
      lastEntryId: string;
    }
  | {
      operation: "suffix";
      startSeq: number;
      maxBytes: number;
      maxEvents: number;
      retainedCustomDataIds: readonly string[];
    };

export type SessionTranscriptMaintenanceFacts = {
  kind: "transcript-maintenance";
  eventSeqs?: number[];
  seq?: number;
  version?: SessionTranscriptContextVersion;
  appendParentId?: string | null;
  lifecycleRevision?: SessionTranscriptWriteScope["expectedLifecycleRevision"];
  events?: TranscriptEvent[];
  /** Raw logical ancestry for page entries; their callback envelopes remain canonical. */
  rawParentIds?: Map<string, string | null>;
  nextOffset?: number;
  complete?: boolean;
  serializedBytes?: number;
  oversizedBytes?: number;
  selectedContext?: SessionTranscriptBoundedActiveContext;
  leafControlNavigation?: SessionLeafControlNavigation;
  entryNavigation?: SessionHistoryEntryNavigation | null;
  terminalMessageEntryId?: string | null;
  targetEntry?: TranscriptEvent;
  commonAncestorId?: string | null;
  contextState?: {
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
};

export type SessionTranscriptHydrationWorkerResult =
  | {
      kind: "full";
      version: SessionTranscriptReadSnapshot["version"];
      eventCount: number;
    }
  | Extract<PreparedSessionTranscriptHydration, { kind: "bounded" }>;

export type SessionTranscriptHydrationChunk = {
  kind: "transcript-hydration-chunk";
  encoding: string;
  frames: Array<{ data: Uint8Array; endOfEvent: boolean }>;
};

export type SessionTranscriptCurrentTurnEntryRead = {
  kind: "current-turn-entry";
  version: SessionTranscriptContextVersion;
  anchor?: TranscriptEntryAnchor;
  event?: TranscriptEvent;
};

export type SessionTranscriptCurrentTurnEntryRequest = {
  entryId: string;
  version: SessionTranscriptContextVersion;
  includeEntry: boolean;
};

export type SessionTranscriptHydrationWorkerInput = {
  kind: "transcript-hydration";
  database: { agentId: string; path: string };
  target: SessionTranscriptReadScope;
  resolvedScope: ResolvedTranscriptReadScope;
  expectedIdentity?: DatabaseFileIdentity;
  afterSeq?: number;
  includeEventJson?: boolean;
  limits?: { maxBytes: number; maxEvents: number; retainContextUsageEvidence?: boolean };
  admission?: UserTurnTranscriptAdmissionReceipt;
};

type SessionTranscriptRuntimeHydrationInput = Omit<
  SessionTranscriptHydrationWorkerInput,
  "kind" | "limits" | "target" | "expectedIdentity"
> & { target: SessionTranscriptRuntimeTarget & { env?: NodeJS.ProcessEnv } };

export type SessionTranscriptCurrentTurnEntryWorkerInput = SessionTranscriptRuntimeHydrationInput &
  SessionTranscriptCurrentTurnEntryRequest & { kind: "current-turn-entry" };

export type SessionTranscriptRecentActiveEventsWorkerInput =
  SessionTranscriptRuntimeHydrationInput & {
    kind: "recent-active-events";
    maxEvents: number;
  };

export type SessionTranscriptLatestActiveMessageWorkerInput =
  SessionTranscriptRuntimeHydrationInput & {
    kind: "latest-active-message";
  };

export type SessionTranscriptMaintenanceWorkerInput = SessionTranscriptRuntimeHydrationInput & {
  kind: "transcript-maintenance";
  request: SessionTranscriptMaintenanceRead;
};

export type SessionTranscriptHydrationWorkerRequest =
  | SessionTranscriptHydrationWorkerInput
  | SessionTranscriptMaintenanceWorkerInput
  | SessionTranscriptCurrentTurnEntryWorkerInput
  | SessionTranscriptRecentActiveEventsWorkerInput
  | SessionTranscriptLatestActiveMessageWorkerInput;

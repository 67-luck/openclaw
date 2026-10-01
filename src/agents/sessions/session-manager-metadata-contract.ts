import type { Result } from "@openclaw/normalization-core/result";
import type {
  ExactSessionEntry,
  SessionTranscriptContextVersion,
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
} from "../../config/sessions/session-accessor.sqlite-contract.js";
import type { SqliteLifecycleTargetSnapshot } from "../../config/sessions/session-accessor.sqlite-entry-equality.js";
import type { listSessionEntriesReadOnly } from "../../config/sessions/session-accessor.sqlite-entry-list.read.js";
import type { SessionEntryPatchSelection } from "../../config/sessions/session-accessor.sqlite-entry-mutation.js";
import type { listSessionChildEntriesReadOnly } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type {
  loadExactSessionEntryCandidates,
  ExactSessionEntryBatchScope,
  loadSessionEntryByIdReadOnly,
  resolveSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-exact-read.js";
import type { readCommittedIncognitoSessionSharing } from "../../config/sessions/session-accessor.sqlite-incognito-sharing.js";
import type { InitialSessionEntryCommit } from "../../config/sessions/session-accessor.sqlite-initial-entry.js";
import type {
  readSessionTranscriptModelContext,
  SessionModelContextLimits,
} from "../../config/sessions/session-accessor.sqlite-model-context.js";
import type { ResolvedSqliteScope } from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { appendTranscriptEventSnapshotSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import type {
  SessionTranscriptReadScope,
  SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.types.js";
import type { readSessionRowEntryInDatabase } from "../../config/sessions/session-entry-read.worker.js";
import type { listSessionMembersInDatabase } from "../../config/sessions/session-sharing-store.kernel.js";
import type {
  SessionTranscriptCurrentTurnEntryRequest,
  SessionTranscriptCurrentTurnEntryRead,
} from "../../config/sessions/session-transcript-worker.types.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { OpenClawStateWorkerErrorPayload } from "../../state/openclaw-state-worker-error.js";
import type { SessionEntry, SessionHeader, SessionLeafControl } from "./session-manager-types.js";
import type {
  PreparedSessionTranscriptReload,
  SessionManagerBoundedContextLimits,
} from "./session-manager-view-types.js";

export type MetadataTarget = Omit<SessionTranscriptWriteScope, "env"> &
  SessionTranscriptRuntimeTarget;

export type SessionWorkerInitialEntryCommit = Omit<InitialSessionEntryCommit, "identity"> & {
  identity?: NonNullable<InitialSessionEntryCommit["identity"]> & { databaseIdentity: string };
};

export type SessionEntryReadQuery =
  | {
      kind: "resolve";
      options: Pick<
        NonNullable<Parameters<typeof resolveSessionEntry>[1]>,
        "readOnly" | "keyFormat" | "allowCanonicalMove" | "databaseAgentId" | "projection"
      >;
    }
  | {
      kind: "resolve-result";
      projection?: NonNullable<Parameters<typeof resolveSessionEntry>[1]>["projection"];
    }
  | {
      kind: "candidates";
      sessionKeys: readonly string[];
      readOnly: boolean;
      projection?: Parameters<typeof loadExactSessionEntryCandidates>[0]["projection"];
    }
  | {
      kind: "batch";
      sessionKeys: readonly (readonly string[])[];
      projection?: ExactSessionEntryBatchScope["projection"];
      clone?: boolean;
    }
  | {
      kind: "by-id";
      sessionId: string;
      projection?: Parameters<typeof loadSessionEntryByIdReadOnly>[0]["projection"];
    }
  | { kind: "key-by-id"; sessionId: string }
  | { kind: "key-occupied"; sessionKeys: readonly string[] }
  | {
      kind: "children";
      projection?: Parameters<typeof listSessionChildEntriesReadOnly>[0]["projection"];
    }
  | { kind: "row" | "sharing" }
  | { kind: "members" }
  | { kind: "has-member"; identityId: string }
  | {
      kind: "list";
      scope: Omit<NonNullable<Parameters<typeof listSessionEntriesReadOnly>[0]>, "env">;
      options: NonNullable<Parameters<typeof listSessionEntriesReadOnly>[1]>;
    };
export type SessionEntryReadResult =
  | { kind: "resolve"; value: ReturnType<typeof resolveSessionEntry> }
  | {
      kind: "resolve-result";
      value: Result<InternalSessionEntry | undefined, OpenClawStateWorkerErrorPayload>;
    }
  | { kind: "candidates"; value: ReturnType<typeof loadExactSessionEntryCandidates> }
  | {
      kind: "batch";
      value: Array<Result<ExactSessionEntry[], OpenClawStateWorkerErrorPayload | undefined>>;
    }
  | { kind: "by-id"; value: ReturnType<typeof loadSessionEntryByIdReadOnly> }
  | { kind: "key-by-id"; value: string | undefined }
  | { kind: "key-occupied"; value: boolean }
  | { kind: "children"; value: ReturnType<typeof listSessionChildEntriesReadOnly> }
  | { kind: "row"; value: ReturnType<typeof readSessionRowEntryInDatabase> }
  | { kind: "sharing"; value: ReturnType<typeof readCommittedIncognitoSessionSharing> }
  | { kind: "members"; value: ReturnType<typeof listSessionMembersInDatabase> }
  | { kind: "has-member"; value: boolean }
  | { kind: "list"; value: ReturnType<typeof listSessionEntriesReadOnly> };

export type SessionMetadataOperations = {
  "session.metadata.entryRead": {
    input: {
      scope: Omit<ResolvedSqliteScope, "env">;
      query: SessionEntryReadQuery;
      expected?: { identity: string; birthtime?: string; incarnation?: string };
    };
    output: {
      result: SessionEntryReadResult;
      incarnation: string;
      physical: { identity: string; birthtime?: string };
    };
  };
  "session.metadata.entrySnapshot": {
    input: { scope: Omit<ResolvedSqliteScope, "env">; selection: SessionEntryPatchSelection };
    output: {
      prepared: SqliteLifecycleTargetSnapshot;
      incarnation: string;
      physical: { identity: string; birthtime?: string };
    };
  };
  "session.metadata.entryPatch": {
    input: {
      operationId: string;
      scope: Omit<ResolvedSqliteScope, "env">;
      selection: SessionEntryPatchSelection;
      incarnation: string;
      operationLabel: "session-entry.patch" | "session-entry-target.patch";
      validateCanonicalKeys: boolean;
      prepared: SqliteLifecycleTargetSnapshot;
      writeBase: InternalSessionEntry;
      next?: InternalSessionEntry;
      consumePendingReset?: boolean;
      providerReviewMutation?: boolean;
      shouldCommit: boolean;
      assertCommitAllowed: boolean;
    };
    output: {
      entry: InternalSessionEntry | null;
      identity?: {
        previous: Map<string, InternalSessionEntry>;
        current: Map<string, InternalSessionEntry>;
      };
    };
  };
  "session.metadata.context": {
    input: {
      scope: Omit<SessionTranscriptReadScope, "env">;
      admission?: UserTurnTranscriptAdmissionReceipt;
    };
    output: boolean;
  };
  "session.metadata.activeAnchor": {
    input: { scope: MetadataTarget; entryId: string };
    output: TranscriptEntryAnchor | undefined;
  };
  "session.metadata.modelContext": {
    input: {
      scope: MetadataTarget;
      admission?: UserTurnTranscriptAdmissionReceipt;
      through?: TranscriptEntryAnchor;
      limits?: SessionModelContextLimits;
    };
    output: ReturnType<typeof readSessionTranscriptModelContext>;
  };
  "session.metadata.validateContext": {
    input: {
      scope: MetadataTarget;
      admission?: UserTurnTranscriptAdmissionReceipt;
      through?: TranscriptEntryAnchor;
      version?: SessionTranscriptContextVersion;
    };
    output: void;
  };
  "session.metadata.read": {
    input: {
      scope: MetadataTarget;
      limits?: SessionManagerBoundedContextLimits;
      admission?: UserTurnTranscriptAdmissionReceipt;
    };
    output: PreparedSessionTranscriptReload;
  };
  "session.metadata.currentTurn": {
    input: {
      scope: MetadataTarget;
      request: SessionTranscriptCurrentTurnEntryRequest;
      admission?: UserTurnTranscriptAdmissionReceipt;
    };
    output: SessionTranscriptCurrentTurnEntryRead;
  };
  "session.metadata.initialize": {
    input: {
      scope: MetadataTarget;
      entry: InternalSessionEntry;
      initialWriterRunId?: string;
    };
    output: SessionWorkerInitialEntryCommit;
  };
  "session.metadata.append": {
    input: {
      scope: MetadataTarget;
      event: SessionHeader | Exclude<SessionEntry, { type: "message" }> | SessionLeafControl;
      options: Pick<
        NonNullable<Parameters<typeof appendTranscriptEventSnapshotSync>[2]>,
        "appendIntent" | "expectedMutationAt"
      >;
      view?: {
        loadedVersion?: SessionTranscriptContextVersion;
        limits?: SessionManagerBoundedContextLimits;
        admission?: UserTurnTranscriptAdmissionReceipt;
      };
    };
    output: {
      snapshot: ReturnType<typeof appendTranscriptEventSnapshotSync>;
      projectionNeedsReconcile: boolean;
      reload?: Result<PreparedSessionTranscriptReload, OpenClawStateWorkerErrorPayload | undefined>;
    };
  };
  "session.metadata.mutation": {
    input: { scope: MetadataTarget };
    output: number | null;
  };
};

export type SessionMetadataWorkerOperations = {
  [Key in keyof SessionMetadataOperations]: {
    input: SessionMetadataOperations[Key]["input"];
    output:
      | { ok: true; value: SessionMetadataOperations[Key]["output"] }
      | { ok: false; refusal?: TranscriptAppendRefusal };
  };
};

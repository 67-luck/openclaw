import type {
  AcpSessionEntryMutationInput,
  AcpSessionEntryMutationResult,
} from "../acp/runtime/session-meta-entry.types.js";
import type { SessionProviderReviewComparison } from "../config/sessions/provider-review.types.js";
import type {
  TranscriptArchivePublishPlan,
  TranscriptArchivePublishResult,
} from "../config/sessions/session-accessor.sqlite-archive-types.js";
import type { SessionTranscriptInitializationPublication } from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import type {
  SessionEntryReplacementCommit,
  SessionEntryReplacementCommitted,
} from "../config/sessions/session-accessor.sqlite-replacement-types.js";
import type {
  PublishedSessionTranscriptArchive,
  SessionLegacyArchiveRemovalResult,
} from "../config/sessions/session-history-archive-pruning.types.js";
import type { SessionPendingInputWithdrawal } from "../config/sessions/session-pending-input-withdrawal.worker.js";
import type {
  SessionReactionWrite,
  SetSessionReactionParams,
} from "../config/sessions/session-reaction-store.types.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions/types.js";
import type { SqliteWalReclamationResult } from "../infra/sqlite-wal-reclamation.js";
import type {
  SqliteWalPeriodicRequest,
  SqliteWalPeriodicResult,
} from "../infra/sqlite-wal-write-admission.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import type {
  SqliteWorkerAdmissionCreator,
  SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { SqliteTrajectoryRuntimeAppend } from "../trajectory/runtime-store.sqlite.js";
import type { AgentDatabaseRegistryChange } from "./openclaw-agent-db-registry-listing.js";
import type { AgentDatabaseDomainOperations } from "./openclaw-agent-execution-domain.js";
import type { AgentDatabaseExecutionScope } from "./openclaw-agent-execution-native.js";
import type { AgentDatabaseReadyOperation } from "./openclaw-agent-execution-volatile.js";

export type AgentDatabaseExecutionBinding = {
  readonly incarnation: object;
  readonly backend: "durable" | "volatile";
  readonly agentId: string;
  readonly path: string;
  assertCurrent(this: void): void;
  borrow(this: void): OpenClawAgentDatabaseExecution;
};

export type OpenClawAgentDatabaseExecution = {
  readonly binding: AgentDatabaseExecutionBinding;
  readonly backend: "durable" | "volatile";
  readonly agentId: string;
  readonly path: string;
  /** The accepted native receipt; reading this never adopts the current pathname. */
  readonly fileIdentity: AgentDatabaseExecutionFileIdentity | undefined;
  assertCurrent(): void;
  retainReadyOperation?: (
    source: AgentDatabaseRequestExecutionSource,
    options?: { createIfMissing?: boolean },
  ) => AgentDatabaseReadyOperation;
  captureGenerationClaim(): AgentDatabaseGenerationClaim;
  /** Initialize first-use storage through the same admitted native owner. */
  prepare(source: AgentDatabaseRequestExecutionSource, signal?: AbortSignal): Promise<void>;
  /** Admit a write against existing storage; a missing store remains missing. */
  runExisting<T>(
    source: AgentDatabaseRequestExecutionSource,
    operation: (scope: AgentDatabaseExecutionScope) => Promise<T>,
    options?: { retireNativeOnFailure: true },
  ): Promise<T | undefined>;
  /**
   * Join this reference's work; native cleanup failures remain with its resource owner.
   * The owner may retain one bounded idle generation.
   */
  release(): Promise<void>;
};

export type AgentDatabaseExecutionOwner = {
  readonly backend: "durable" | "volatile";
  readonly agentId: string;
  readonly sharedDatabaseKey: string;
  readVolatileTarget(): { agentId: string; storePath: string } | undefined;
  borrow(
    pathname: string,
    expectedIdentity?: AgentDatabaseExecutionFileIdentity,
    expectedCreationIdentity?: DatabasePathIdentity,
  ): OpenClawAgentDatabaseExecution;
  closeIdle(): Promise<void>;
  close(): Promise<void>;
};

/** Recorded by the native owner; a descriptor never grants access to that owner. */
export type AgentDatabaseExecutionIdentity = {
  kind: "file";
  physicalIdentity: string;
  birthtime?: string;
  incarnation: string;
  nativeLocation: string;
};

export type AgentDatabaseExecutionFileIdentity = Pick<
  AgentDatabaseExecutionIdentity,
  "kind" | "physicalIdentity" | "birthtime" | "nativeLocation"
>;

/** A borrowed native generation, never a file locator that can adopt a later open. */
export type AgentDatabaseGenerationClaim = {
  readonly identity: string;
  readonly incarnation: string;
  assertCurrent(): void;
};

export type AgentDatabaseExecutionOpen = {
  leaseId: string;
  agentId: string;
  databasePath: string;
  stateDatabasePath: string;
  environment: SqliteWorkerStateContext["environment"];
  expectedIdentity?: AgentDatabaseExecutionFileIdentity;
  /** Captured before a creating request yields; absence is an identity too. */
  creatingIdentity?: DatabasePathIdentity;
};

export type AgentDatabaseOperations = AgentDatabaseDomainOperations & {
  "database.walMaintenance": { input: SqliteWalPeriodicRequest; output: SqliteWalPeriodicResult };
  "trajectory.events.append": { input: SqliteTrajectoryRuntimeAppend; output: void };
  "session.archives.preparePublication": {
    input: {
      archiveDirectory: string;
      requested: readonly Pick<TranscriptArchivePublishPlan, "sessionId" | "generation">[];
    };
    output: TranscriptArchivePublishPlan[];
  };
  "session.archives.recordPublication": {
    input: { results: readonly TranscriptArchivePublishResult[]; nowMs: number };
    output: void;
  };
  "session.transcript.initialize": {
    input: { sessionKey: string; sessionId: string; cwd?: string };
    output: SessionTranscriptInitializationPublication;
  };
  "database.prepareWrite": { input: undefined; output: void };
  "session.entry.read": { input: { sessionKey: string }; output: InternalSessionEntry | undefined };
  "session.entry.acp": {
    input: AcpSessionEntryMutationInput;
    output: AcpSessionEntryMutationResult;
  };
  "session.entries.replace": {
    input: SessionEntryReplacementCommit & {
      initializeTranscript?: { sessionKey: string; sessionId: string; cwd?: string };
    };
    output: SessionEntryReplacementCommitted;
  };
  "session.providerReview.compare": {
    input: SessionProviderReviewComparison;
    output: SessionEntry;
  };
  "session.reaction.set": {
    input: { sessionKey: string; params: SetSessionReactionParams };
    output: SessionReactionWrite;
  };
  "session.pendingInputs.withdraw": {
    input: SessionPendingInputWithdrawal;
    output: boolean;
  };
  "session.archivePruning.deletePublished": {
    input: PublishedSessionTranscriptArchive;
    output: void;
  };
  "session.archivePruning.removeLegacy": {
    input: { filePath: string };
    output: SessionLegacyArchiveRemovalResult;
  };
  "session.archivePruning.reclaimPages": {
    input: { maxPages?: number };
    output: SqliteWalReclamationResult;
  };
};

export type AgentDatabaseRequestPreparation = {
  kind: "agent-execution";
  startupJournal: boolean;
  domain?: unknown;
};

/** A request owner composes its retained admission with the native owner's validation. */
export type AgentDatabaseRequestExecutionSource = {
  assertCurrent(): void;
  onRegistryChange?: (change: AgentDatabaseRegistryChange) => void;
  /** Execute can require its original caller; opening never runs a command continuation. */
  readonly requiresHostContinuation: boolean;
  createAdmission(params: {
    /** Original host job, independent of the worker's admission stage. */
    operation: "open" | "execute";
    attachment: AgentDatabaseRequestPreparation;
    nativeLocations: readonly string[];
    authorize(request: SqliteWorkerAdmissionRequest): void;
    assertCurrent(): void;
  }): SqliteWorkerAdmissionCreator;
};

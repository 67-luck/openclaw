import type { SessionPermissionMode } from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../../auto-reply/get-reply-options.types.js";
import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import {
  isAgentEventLifecycleGenerationCurrent,
  registerAgentEventLifecycleRotationHandler,
} from "../../infra/agent-events.js";
import {
  getActiveAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { DiagnosticEmbeddedRunOwner } from "../../logging/diagnostic-run-activity.js";
import type {
  ReplyOperation,
  ReplyBackendHandle,
  ReplyBackendQueueMessageOptions,
  ReplyToolAuthorityOverlay,
  ReplyTurnParticipants,
  ReplyBackendQueueMessageResult,
  ReplyBackendMessageInjection,
  ReplyBackendMessageInjectionV2,
} from "../../sessions/session-controller.contracts.js";
import {
  attachControllerNativeAttempt,
  detachControllerNativeAttempt,
  hasSessionControllerIdentity,
  resolveControllerNativeAttempt,
  activeSessionOperations,
  resolveReplyRunForCurrentSessionId,
  getSessionControllerEntryForOperation,
  getAttachedBackend,
} from "../../sessions/session-controller.state.js";
import type { SessionControllerWatchdogAttempt } from "../../sessions/session-controller.watchdog.js";
import type { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { OperationalRunInstanceRef } from "../admitted-run-context.js";
import type { ReplyExpectation } from "../reply-completion.js";

export const embeddedRunCleanupAttachment = Symbol("openclaw.embeddedRunCleanupAttachment");

export type EmbeddedAgentQueueHandle = {
  kind?: "embedded";
  [embeddedRunCleanupAttachment]?: ActiveEmbeddedRunAttachment;
  runId?: string;
  /** Exact process-local diagnostic lifecycle shared with this handle's model wrapper. */
  readonly diagnosticOwner?: DiagnosticEmbeddedRunOwner;
  /** Synchronously closes diagnostic authority before this handle is evicted. */
  readonly closeDiagnostics?: () => void;
  /** Core run start time used by live recovery projections. */
  startedAtMs?: number;
  /** Exact authority of the concrete provider/model attempt behind this handle. */
  toolAuthorityFingerprint?: string;
  /** Shared outer-run owner survives an intentional native-turn replacement. */
  permissionChangeOwner?: object;
  /** Fences prior tools, revokes their approvals, then acknowledges installed permissions. */
  applyPermissionMode?: (
    mode: SessionPermissionMode | null,
    revokeApprovals: () => void,
  ) => Promise<boolean>;
  /** Atomically consumes one plain-text answer for this run's pending user-input request. */
  claimPendingUserInputAnswer?: (
    text: string,
    options?: EmbeddedAgentQueueMessageOptions,
  ) => Promise<boolean>;
  /** Cancels this run's pending user-input request before an image is queued as a later turn. */
  cancelPendingUserInput?: (resolvedBy: string) => Promise<boolean>;
  /** Exact heartbeat owner retained after its reply-operation registration clears. */
  readonly preemptByVisibleTurn?: () => boolean;
  queueMessage: (
    text: string,
    options?: EmbeddedAgentQueueMessageOptions,
  ) => Promise<void | EmbeddedAgentQueueMessageResult>;
  messageInjection?: ReplyBackendMessageInjection;
  messageInjectionV2?: ReplyBackendMessageInjectionV2;
  isStreaming: () => boolean;
  isStopped?: () => boolean;
  /** True after this handle has accepted an abort, even while cleanup retains it. */
  isAborted?: () => boolean;
  /** True only while this exact runtime owns a live wait, not unresolved host work or cleanup. */
  ownsLiveness?: () => boolean;
  isAbortable?: () => boolean;
  isCompacting: () => boolean;
  supportsTranscriptCommitWait?: boolean;
  /** True only when queueMessage preserves images supplied in its options. */
  supportsQueueMessageImages?: boolean;
  cancel?: (reason?: "user_abort" | "restart" | "superseded") => void;
  abort: (reason?: "restart") => void;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  terminalReplyExpectation?: ReplyExpectation;
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
};

export type EmbeddedAgentQueueFailureReason =
  | "input_visibility_mismatch"
  | "no_active_run"
  | "not_streaming"
  | "stale_run"
  | "compacting"
  | "tool_authority_mismatch"
  | "image_input_unsupported"
  | "source_reply_delivery_mode_mismatch"
  | "task_suggestion_delivery_mode_mismatch"
  | "reply_expectation_mismatch"
  | "transcript_commit_wait_unsupported"
  | "guarded_injection_unsupported"
  | "runtime_rejected";

export type EmbeddedAgentQueueMessageOptions = ReplyBackendQueueMessageOptions;

export type EmbeddedAgentQueueMessageResult = ReplyBackendQueueMessageResult;

export type ActiveEmbeddedRunSnapshot = {
  transcriptLeafId: string | null;
  messages?: unknown[];
  inFlightPrompt?: string;
};

/** Host-private binding consumed before publishing one actual backend handle. */
export type EmbeddedRunToolAuthorityBinding = (registration: {
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  agentId?: string;
  handle: EmbeddedAgentQueueHandle;
}) => {
  source: "reply" | "attempt";
  detached?: true;
  operation?: ReplyOperation;
  sourceTurnId?: string;
  watchdogAttempt?: SessionControllerWatchdogAttempt;
  project: (overlay: ReplyToolAuthorityOverlay) => string | undefined;
  assertActive: () => void;
  personalToolParticipants?: ReplyTurnParticipants;
};

export type EmbeddedRunRegistration = {
  handle: EmbeddedAgentQueueHandle;
  lifecycleGeneration: string;
  /** Resolves only when this exact native producer clears, including after replacement. */
  settlement: ReturnType<typeof createDeferredCore<void>>;
  settled?: true;
  watchdogAttempt?: SessionControllerWatchdogAttempt;
  closeWatchdogWait?: () => void;
  /** Controller-owned presentation fact; retained cleanup must not reappear after context release. */
  projectSessionActive?: boolean;
  toolAuthority?: ReturnType<EmbeddedRunToolAuthorityBinding>;
  operationalRunInstance?: OperationalRunInstanceRef;
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  delegatedAuthority?: AgentRunDelegatedAuthority;
  humanInputWaits?: Set<() => boolean>;
  onHumanInputResolved?: () => void;
};

/** The controller's exact attachment for one scoped embedded attempt. */
export type EmbeddedRunAttachment = EmbeddedRunRegistration & {
  operation: ReplyOperation;
  backend?: ReplyBackendHandle;
};

/** Sessionless attempts have native authority but no controller operation. */
type DetachedEmbeddedRunAttachment = EmbeddedRunRegistration & {
  operation?: undefined;
  backend?: undefined;
};

export type ActiveEmbeddedRunAttachment = EmbeddedRunAttachment | DetachedEmbeddedRunAttachment;

export type EmbeddedRunCompletionRegistration = {
  toolAuthority: NonNullable<EmbeddedRunRegistration["toolAuthority"]>;
};

export type EmbeddedRunCompletionClaim = {
  runId: string;
  operation?: ReplyOperation;
  lifecycleGeneration: string;
  operationalRunInstance?: OperationalRunInstanceRef;
  promoted: boolean;
  settleRegistration: (registration: EmbeddedRunCompletionRegistration | undefined) => void;
};

export type AbandonedEmbeddedRun = {
  sessionId: string;
  runId?: string;
  sessionKey?: string;
  sessionFile?: string;
  abandonedAtMs: number;
  reason: "timeout" | "recovering_timeout";
  recoveryToken?: symbol;
};

const EMBEDDED_RUN_STATE_KEY = Symbol.for("openclaw.embeddedRunState");

// Lazy imports and reloads in one Gateway process must retain the same run owners.
const embeddedRunState = resolveGlobalSingleton(EMBEDDED_RUN_STATE_KEY, () => ({
  detachedAttempts: new Set<DetachedEmbeddedRunAttachment>(),
  activeRunsByRunId: new Map<string, ActiveEmbeddedRunAttachment>(),
  // Talk prepares before registration; only the matching live run promotes this
  // one-shot final-delivery claim. Replacement or lifecycle rotation revokes it.
  completionClaims: new Map<string, EmbeddedRunCompletionClaim>(),
  retainedAbortabilityRunIds: new Set<string>(),
  snapshots: new Map<string, ActiveEmbeddedRunSnapshot>(),
  sessionIdsByFile: new Map<string, string>(),
  abandonedRunsBySessionId: new Map<string, AbandonedEmbeddedRun>(),
  abandonedRunSessionIdsByKey: new Map<string, string>(),
  abandonedRunSessionIdsByFile: new Map<string, string>(),
  // The exact handle owns forced cleanup so a stale session id cannot release a replacement turn.
  forcedTerminalSettlements: new WeakMap<EmbeddedAgentQueueHandle, () => Promise<void>>(),
}));

// Detached/sessionless attempts retain native authority without creating a session
// scheduling identity. Scoped attempts exist only on their exact controller turn.
const detachedAttempts = embeddedRunState.detachedAttempts;
export function getControllerEmbeddedAttachment(
  operation: ReplyOperation,
): EmbeddedRunAttachment | undefined {
  const attachment = getSessionControllerEntryForOperation(operation).attachment;
  return attachment && "handle" in attachment && attachment.operation === operation
    ? attachment
    : undefined;
}

export function getEmbeddedRunAttachment(
  handle: EmbeddedAgentQueueHandle,
): ActiveEmbeddedRunAttachment | undefined {
  const indexed = handle.runId ? ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(handle.runId) : undefined;
  if (indexed?.handle === handle) {
    return indexed;
  }
  for (const operation of activeSessionOperations()) {
    const attachment = getControllerEmbeddedAttachment(operation);
    if (attachment?.handle === handle) {
      return attachment;
    }
  }
  for (const attachment of detachedAttempts) {
    if (attachment.handle === handle) {
      return attachment;
    }
  }
  return undefined;
}

export function getActiveNativeAttempt(sessionId: string): EmbeddedAgentQueueHandle | undefined {
  const scoped = resolveControllerNativeAttempt(sessionId);
  if (
    scoped ||
    resolveReplyRunForCurrentSessionId(sessionId).kind !== "none" ||
    hasSessionControllerIdentity(sessionId)
  ) {
    return scoped;
  }
  for (const attachment of detachedAttempts) {
    if (attachment.sessionId === sessionId) {
      return attachment.handle;
    }
  }
  return undefined;
}
export function* activeNativeAttempts(): IterableIterator<[string, EmbeddedAgentQueueHandle]> {
  for (const operation of activeSessionOperations()) {
    const attachment = getControllerEmbeddedAttachment(operation);
    if (attachment) {
      yield [operation.sessionId, attachment.handle];
    }
  }
  for (const attachment of detachedAttempts) {
    if (!hasSessionControllerIdentity(attachment.sessionId)) {
      yield [attachment.sessionId, attachment.handle];
    }
  }
}
export function attachNativeAttempt(attachment: ActiveEmbeddedRunAttachment): void {
  if (attachment.operation) {
    attachControllerNativeAttempt(attachment.operation, attachment);
  } else {
    detachedAttempts.add(attachment);
  }
}
export function detachNativeAttempt(attachment: ActiveEmbeddedRunAttachment): void {
  if (attachment.operation) {
    detachControllerNativeAttempt(attachment.operation, attachment);
  } else {
    detachedAttempts.delete(attachment);
  }
}
export const ACTIVE_EMBEDDED_RUNS_BY_RUN_ID =
  embeddedRunState.activeRunsByRunId ??
  (embeddedRunState.activeRunsByRunId = new Map<string, ActiveEmbeddedRunAttachment>());
export const EMBEDDED_RUN_COMPLETION_CLAIMS =
  embeddedRunState.completionClaims ??
  (embeddedRunState.completionClaims = new Map<string, EmbeddedRunCompletionClaim>());

type RetainedPreCutoverRegistration = Omit<
  EmbeddedRunRegistration,
  "handle" | "lifecycleGeneration"
> & {
  operation?: ReplyOperation;
  backend?: ReplyBackendHandle;
};

function isEmbeddedAgentQueueHandle(value: unknown): value is EmbeddedAgentQueueHandle {
  return (
    typeof value === "object" &&
    value !== null &&
    "queueMessage" in value &&
    typeof value.queueMessage === "function" &&
    "abort" in value &&
    typeof value.abort === "function"
  );
}

function isRetainedPreCutoverRegistration(value: unknown): value is RetainedPreCutoverRegistration {
  return (
    typeof value === "object" &&
    value !== null &&
    "sessionId" in value &&
    typeof value.sessionId === "string" &&
    "settlement" in value
  );
}

/** Converts the one retained pre-cutover singleton shape, then removes its retired maps. */
function migrateRetainedEmbeddedRunState(): void {
  const retainedMaps = Object.entries(embeddedRunState).flatMap(([key, value]) =>
    value instanceof WeakMap
      ? [
          {
            key,
            map: value as WeakMap<EmbeddedAgentQueueHandle, unknown>,
          },
        ]
      : [],
  );
  const rawDetachedAttempts = embeddedRunState.detachedAttempts as Set<unknown>;
  const rawRunsById = embeddedRunState.activeRunsByRunId as Map<string, unknown>;
  const handles = new Set<EmbeddedAgentQueueHandle>();
  for (const candidate of rawDetachedAttempts) {
    if (isEmbeddedAgentQueueHandle(candidate)) {
      handles.add(candidate);
    }
  }
  for (const candidate of rawRunsById.values()) {
    if (isEmbeddedAgentQueueHandle(candidate)) {
      handles.add(candidate);
    }
  }
  for (const operation of activeSessionOperations()) {
    const entry = getSessionControllerEntryForOperation(operation);
    for (const candidate of Object.values(entry)) {
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        "operation" in candidate &&
        candidate.operation === operation &&
        "handle" in candidate &&
        isEmbeddedAgentQueueHandle(candidate.handle)
      ) {
        handles.add(candidate.handle);
      }
    }
  }
  const retiredKeys = new Set<string>();
  for (const handle of handles) {
    let registration: RetainedPreCutoverRegistration | undefined;
    let lifecycleGeneration: string | undefined;
    for (const retained of retainedMaps) {
      const value = retained.map.get(handle);
      if (isRetainedPreCutoverRegistration(value)) {
        registration = value;
        retiredKeys.add(retained.key);
      } else if (typeof value === "string") {
        lifecycleGeneration = value;
        retiredKeys.add(retained.key);
      }
    }
    if (!registration || !lifecycleGeneration) {
      continue;
    }
    const indexAttachment = (attachment: ActiveEmbeddedRunAttachment) => {
      handle[embeddedRunCleanupAttachment] = attachment;
      for (const [runId, candidate] of rawRunsById) {
        if (candidate === handle) {
          ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.set(runId, attachment);
        }
      }
    };
    const operation = registration.operation;
    if (operation) {
      const attachment: EmbeddedRunAttachment = {
        ...registration,
        handle,
        lifecycleGeneration,
        operation,
      };
      indexAttachment(attachment);
      const entry = getSessionControllerEntryForOperation(operation);
      if (entry.active === operation) {
        attachControllerNativeAttempt(operation, attachment);
      }
    } else {
      const { operation: _operation, backend: _backend, ...retained } = registration;
      const attachment: DetachedEmbeddedRunAttachment = {
        ...retained,
        handle,
        lifecycleGeneration,
      };
      indexAttachment(attachment);
      rawDetachedAttempts.delete(handle);
      detachedAttempts.add(attachment);
    }
  }
  for (const key of retiredKeys) {
    Reflect.deleteProperty(embeddedRunState, key);
  }
}

migrateRetainedEmbeddedRunState();

/** Identity-only dispatch must resolve the same participant owner as in-process tools. */
export function captureActiveEmbeddedRunPersonalToolParticipants(identity: AgentRuntimeIdentity) {
  const instance = identity.operationalRunInstance;
  const attachment = ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(instance.runId);
  if (!attachment) {
    return undefined;
  }
  const handle = attachment.handle;
  const registration = attachment;
  const toolAuthority = registration?.toolAuthority;
  const delegatedAuthority = registration?.delegatedAuthority;
  const ownsRegistration = () =>
    registration !== undefined &&
    registration.operationalRunInstance?.instanceId === instance.instanceId &&
    registration.operationalRunInstance.runId === instance.runId &&
    registration.sessionKey === identity.sessionKey &&
    registration.agentId === identity.agentId &&
    handle.runId === instance.runId &&
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(instance.runId) === attachment &&
    getActiveNativeAttempt(registration.sessionId) === handle &&
    getEmbeddedRunAttachment(handle) === registration &&
    registration.delegatedAuthority === delegatedAuthority &&
    registration.toolAuthority === toolAuthority;
  const assertCurrent = () => {
    toolAuthority?.assertActive();
    if (
      !ownsRegistration() ||
      !toolAuthority ||
      !delegatedAuthority ||
      getActiveAgentRunDelegatedAuthority(instance) !== delegatedAuthority ||
      !validateAgentRunDelegatedAuthority(identity.delegatedAuthority, delegatedAuthority) ||
      handle.isAborted?.() ||
      handle.isStopped?.() ||
      !ownsRegistration()
    ) {
      throw new Error("Personal-tool turn authority is no longer active; ask again in a new turn.");
    }
  };
  assertCurrent();
  return { participants: toolAuthority?.personalToolParticipants, assertCurrent };
}

/** Only an accepted question's exact admitted owner may suppress stale-work recovery. */
export function registerActiveEmbeddedRunHumanInputWait(
  authority: AgentRunDelegatedAuthority,
  isPending: () => boolean,
): ((resolved: boolean) => void) | undefined {
  const registration = ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(authority.operationalRunInstance.runId);
  const handle = registration?.handle;
  const isRegistered = () =>
    registration?.operation
      ? getControllerEmbeddedAttachment(registration.operation) === registration
      : ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(authority.operationalRunInstance.runId) === registration;
  if (
    !handle ||
    !registration ||
    !isRegistered() ||
    !validateAgentRunDelegatedAuthority(authority) ||
    registration.delegatedAuthority !==
      getActiveAgentRunDelegatedAuthority(authority.operationalRunInstance)
  ) {
    return undefined;
  }
  const waits = (registration.humanInputWaits ??= new Set());
  waits.add(isPending);
  const wait = registration.watchdogAttempt?.beginWait({
    kind: "human_question",
    isCurrent: () =>
      waits.has(isPending) &&
      isPending() &&
      isRegistered() &&
      validateAgentRunDelegatedAuthority(authority) &&
      !handle.isAborted?.(),
  });
  return (resolved) => {
    wait?.close();
    if (
      waits.delete(isPending) &&
      resolved &&
      isRegistered() &&
      validateAgentRunDelegatedAuthority(authority) &&
      !handle.isAborted?.()
    ) {
      registration.watchdogAttempt?.progress("semantic", "human_input:resolved");
      registration.onHumanInputResolved?.();
    }
  };
}

/** Re-read at the recovery action, including after queued/lazy recovery dispatch. */
export function resolveActiveEmbeddedRunRecoveryBlocker(
  sessionId: string,
  expectedHandle?: object,
): "human_input_wait" | "runtime_owned_wait" | "stale_session_state" | undefined {
  const handle = getActiveNativeAttempt(sessionId);
  if (expectedHandle && handle !== expectedHandle) {
    return "stale_session_state";
  }
  const registration = handle && getEmbeddedRunAttachment(handle);
  const authority = registration?.delegatedAuthority;
  if (!handle || !authority) {
    return undefined;
  }
  for (const isPending of registration.humanInputWaits ?? []) {
    // Question validation can synchronously close authority or replace the run.
    const pending = isPending() && !handle.isAborted?.();
    if (
      getActiveNativeAttempt(sessionId) !== handle ||
      !registration.humanInputWaits?.has(isPending)
    ) {
      return "stale_session_state";
    }
    if (pending && validateAgentRunDelegatedAuthority(authority)) {
      return "human_input_wait";
    }
  }
  let ownsLiveness = false;
  try {
    ownsLiveness =
      handle.ownsLiveness?.() === true && !handle.isAborted?.() && !handle.isStopped?.();
  } catch {
    // A failed runtime probe cannot exempt work from recovery.
  }
  // Runtime probes may synchronously replace a handle or close its admission.
  if (
    getActiveNativeAttempt(sessionId) !== handle ||
    getEmbeddedRunAttachment(handle) !== registration
  ) {
    return "stale_session_state";
  }
  return ownsLiveness &&
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(authority.operationalRunInstance.runId) === registration &&
    getActiveAgentRunDelegatedAuthority(authority.operationalRunInstance) === authority
    ? "runtime_owned_wait"
    : undefined;
}
export const RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS =
  embeddedRunState.retainedAbortabilityRunIds ??
  (embeddedRunState.retainedAbortabilityRunIds = new Set<string>());
export const ACTIVE_EMBEDDED_RUN_SNAPSHOTS =
  embeddedRunState.snapshots ??
  (embeddedRunState.snapshots = new Map<string, ActiveEmbeddedRunSnapshot>());
export const ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE =
  embeddedRunState.sessionIdsByFile ??
  (embeddedRunState.sessionIdsByFile = new Map<string, string>());
export const ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID =
  embeddedRunState.abandonedRunsBySessionId ??
  (embeddedRunState.abandonedRunsBySessionId = new Map<string, AbandonedEmbeddedRun>());
export const ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY =
  embeddedRunState.abandonedRunSessionIdsByKey ??
  (embeddedRunState.abandonedRunSessionIdsByKey = new Map<string, string>());
export const ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE =
  embeddedRunState.abandonedRunSessionIdsByFile ??
  (embeddedRunState.abandonedRunSessionIdsByFile = new Map<string, string>());
export const EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS =
  embeddedRunState.forcedTerminalSettlements ??
  (embeddedRunState.forcedTerminalSettlements = new WeakMap<
    EmbeddedAgentQueueHandle,
    () => Promise<void>
  >());

function evictPriorLifecycleEmbeddedRuns(): void {
  const staleHandles = new Set<EmbeddedAgentQueueHandle>();
  const controllerOwnedHandles = new Set<EmbeddedAgentQueueHandle>();
  for (const [sessionId, handle] of activeNativeAttempts()) {
    const attachment = getEmbeddedRunAttachment(handle);
    const lifecycleGeneration = attachment?.lifecycleGeneration;
    if (lifecycleGeneration && isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
      continue;
    }
    handle.closeDiagnostics?.();
    attachment?.humanInputWaits?.clear();
    staleHandles.add(handle);
    if (
      attachment?.operation &&
      attachment.backend &&
      getSessionControllerEntryForOperation(attachment.operation).active === attachment.operation &&
      getAttachedBackend(attachment.operation) === attachment.backend
    ) {
      controllerOwnedHandles.add(handle);
    }
    if (getActiveNativeAttempt(sessionId) === handle) {
      if (attachment) {
        detachNativeAttempt(attachment);
      }
    }
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.delete(sessionId);
  }
  for (const [runId, attachment] of ACTIVE_EMBEDDED_RUNS_BY_RUN_ID) {
    const { handle, lifecycleGeneration } = attachment;
    if (lifecycleGeneration && isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
      continue;
    }
    handle.closeDiagnostics?.();
    staleHandles.add(handle);
    // This index only gates the separately owned chat abort controller; absence
    // is abortable. Keeping it would let stale ownership influence new work.
    if (ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(runId) === attachment) {
      ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.delete(runId);
      RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS.delete(runId);
    }
  }
  for (const [sessionId, claim] of EMBEDDED_RUN_COMPLETION_CLAIMS) {
    if (!isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)) {
      claim.settleRegistration(undefined);
      EMBEDDED_RUN_COMPLETION_CLAIMS.delete(sessionId);
    }
  }
  for (const index of [ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE]) {
    for (const [key, sessionId] of index) {
      if (!getActiveNativeAttempt(sessionId)) {
        index.delete(key);
      }
    }
  }
  const abortErrors: unknown[] = [];
  // Remove stale ownership first so synchronous abort callbacks may register a
  // replacement without the cleanup above erasing that current-generation run.
  for (const handle of staleHandles) {
    if (controllerOwnedHandles.has(handle)) {
      // The controller cancels its exact attached backend. This adapter only
      // revokes native indexes; detached or superseded attempts still cancel here.
      continue;
    }
    try {
      handle.abort("restart");
    } catch (error) {
      abortErrors.push(error);
    }
  }
  if (abortErrors.length > 0) {
    throw new AggregateError(abortErrors, "Failed to abort stale embedded agent runs");
  }
}

registerAgentEventLifecycleRotationHandler("embedded-agent-runs", evictPriorLifecycleEmbeddedRuns);

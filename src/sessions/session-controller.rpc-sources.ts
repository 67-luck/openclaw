import type { OperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import type { ChatAbortDiagnosticReason } from "../gateway/chat-abort-diagnostics.js";
import { chatRunBelongsToAgent } from "../gateway/chat-run-owner.js";
import type { AgentRunDelegatedAuthority } from "../infra/agent-run-authority.types.js";
import {
  isSessionControllerSourceQueued,
  retireSessionControllerInput,
  type SessionControllerInput,
  type SessionControllerSourceAdapter,
} from "./session-controller.mailbox.js";
import {
  getSessionControllerEntryForOperation,
  hasReplyOperationExecutionStarted,
  isCurrentSessionControllerOperation,
} from "./session-controller.state.js";
import {
  cancelCapturedSessionControllerSource,
  captureSessionControllerStop,
} from "./session-controller.stop.js";
import { rpcSourceByRunId, rpcSourceRemovalByRef } from "./session-controller.storage.js";

type ChatTerminalProducer = {
  sessionId: string;
  sessionKey: string;
  handoff: (settle: (producerCompleted: Promise<void>) => Promise<void>) => boolean;
};

export type RpcSourceAdapter = SessionControllerSourceAdapter & {
  /** Captures this run's canonical producer before cancellation releases its live slot. */
  resolveTerminalProducer?: () => ChatTerminalProducer | undefined;
  lifecycleGeneration?: string;
  /** Exact operational instance created by this controller registration. */
  operationalRunInstance?: OperationalRunInstanceRef;
  /** Exact approval lease captured when this controller's execution was admitted. */
  agentRunDelegatedAuthority?: AgentRunDelegatedAuthority;
  providerId?: string;
  authProviderId?: string;
  abortStopReason?: string;
  /** Owner-recorded diagnostic cause; does not change terminal lifecycle semantics. */
  abortDiagnosticReason?: ChatAbortDiagnosticReason;
  /** Latest argument-free validation diagnostic for operator-initiated aborts. */
  toolErrorSummary?: string;
  /**
   * False for backend/internal agent runs that may share a session key but must
   * not be projected into operator chat surfaces.
   */
  controlUiVisible?: boolean;
  /** True after the terminal session-store update has completed. */
  projectSessionTerminalPersisted?: boolean;
  /** A terminal lifecycle event was observed and is awaiting persistence. */
  projectSessionTerminalPending?: boolean;
  /** Store timestamp expected from the observed terminal lifecycle event. */
  projectSessionTerminalObservedAt?: number;
  /** In-flight terminal session-store update used by restart shutdown. */
  projectSessionTerminalPersistence?: Promise<void>;
  /** Which Gateway RPC owns this protocol projection. */
  kind?: "chat-send" | "agent";
  /** Side questions stay independent from main-turn TUI session stops. */
  turnKind?: "main" | "btw";
};

/** Byte-exact protocol correlation; scheduling and cancellation belong to input. */
export type RpcSourceRef = Readonly<{ input: SessionControllerInput; adapter: RpcSourceAdapter }>;

export type RpcSourceIdentity = Readonly<{
  sessionId: string;
  sessionKey: string;
  agentId?: string;
}>;

/** Reads logical identity from the exact operation, then its captured source target. */
export function getRpcSourceIdentity(ref: RpcSourceRef): RpcSourceIdentity {
  const operation = ref.input.claim?.operation;
  return {
    sessionId:
      operation?.sessionId ?? ref.input.sourceSessionId ?? ref.input.target?.incarnation ?? "",
    sessionKey: operation?.key ?? ref.input.target?.sessionKey ?? ref.input.mailbox.key,
    agentId: operation?.agentId ?? ref.input.target?.agentId,
  };
}

/** Reads lifecycle generation from the operation once a turn owns the source. */
export function getRpcSourceLifecycleGeneration(ref: RpcSourceRef): string | undefined {
  return ref.input.claim?.operation?.lifecycleGeneration ?? ref.adapter.lifecycleGeneration;
}

/** Updates the controller-owned source identity and its operation, when claimed. */
export function updateRpcSourceSessionId(ref: RpcSourceRef, sessionId: string): void {
  const normalized = sessionId.trim();
  if (!normalized) {
    return;
  }
  ref.input.sourceSessionId = normalized;
  ref.input.claim?.operation?.updateSessionId(normalized);
}

function removeRpcSource(runId: string, ref: RpcSourceRef): boolean {
  if (rpcSourceByRunId.get(runId) !== ref) {
    return false;
  }
  rpcSourceByRunId.delete(runId);
  const onRemoved = rpcSourceRemovalByRef.get(ref);
  rpcSourceRemovalByRef.delete(ref);
  try {
    onRemoved?.();
  } catch {
    // Removal observers cannot reject controller settlement.
  }
  return true;
}

/** Resolves the exact controller-owned source registered for a protocol run. */
export function getRpcSource(runId: string): RpcSourceRef | undefined {
  return rpcSourceByRunId.get(runId);
}

/** Reports whether the controller owns a source for a protocol run. */
export function hasRpcSource(runId: string): boolean {
  return getRpcSource(runId) !== undefined;
}

/** Returns a stable snapshot for Gateway projection, shutdown, and abort iteration. */
export function listRpcSourceEntries(): Array<[runId: string, ref: RpcSourceRef]> {
  return [...rpcSourceByRunId].flatMap(([runId, ref]) =>
    getRpcSource(runId) === ref ? [[runId, ref]] : [],
  );
}

/** Registers protocol correlation after the controller has reserved the source input. */
export function registerRpcSource(runId: string, ref: RpcSourceRef, onRemoved?: () => void): void {
  if (hasRpcSource(runId)) {
    throw new Error(`RPC source already registered for run ${runId}`);
  }
  rpcSourceByRunId.set(runId, ref);
  if (onRemoved) {
    rpcSourceRemovalByRef.set(ref, onRemoved);
  }
  const settled = () => removeRpcSource(runId, ref);
  void ref.input.settlement.promise.then(settled, settled);
}

/** Requests retirement; the index leaves only when the exact controller input settles. */
export function retireRpcSource(runId: string, expected?: RpcSourceRef): boolean {
  const ref = rpcSourceByRunId.get(runId);
  if (!ref || (expected && ref !== expected)) {
    return false;
  }
  if (
    ref.adapter.projectSessionTerminalPending === true &&
    !ref.adapter.projectSessionTerminalPersistence
  ) {
    ref.input.retirementRequested = true;
    return true;
  }
  retireSessionControllerInput(ref.input);
  // Unclaimed retirement settles synchronously; drop the index now so the same
  // protocol run ID can be reserved again before the settlement observer runs.
  if (ref.input.phase === "consumed") {
    removeRpcSource(runId, ref);
  }
  return true;
}

export function getRpcSourceSignal(ref: RpcSourceRef): AbortSignal {
  return ref.input.abortSignal;
}

export function isRpcSourceQueued(ref: RpcSourceRef | undefined): boolean {
  return (
    ref !== undefined &&
    isSessionControllerSourceQueued(ref.input) &&
    !ref.input.custody.cancellationRetired &&
    !ref.input.abortSignal.aborted
  );
}

/** Projection only: reservations, preparing input and retained receipts are not execution. */
export function isRpcSourceExecuting(ref: RpcSourceRef | undefined): boolean {
  const claim = ref?.input.claim;
  const operation = claim?.operation;
  return (
    ref !== undefined &&
    operation !== undefined &&
    !claim?.released &&
    !operation.result &&
    isCurrentSessionControllerOperation(operation) &&
    hasReplyOperationExecutionStarted(operation) &&
    !operation.abortSignal.aborted &&
    !ref.input.abortSignal.aborted
  );
}

export function isRpcSourceActive(ref: RpcSourceRef | undefined): boolean {
  return isRpcSourceExecuting(ref) && getRpcSourceProjectSessionActive(ref) !== false;
}

/** Reads the active-session presentation fact from the exact controller attachment. */
export function getRpcSourceProjectSessionActive(
  ref: RpcSourceRef | undefined,
): boolean | undefined {
  const terminalProjection =
    ref &&
    (ref.adapter.projectSessionTerminalPending === true ||
      ref.adapter.projectSessionTerminalPersisted === true)
      ? false
      : undefined;
  const operation = ref?.input.claim?.operation;
  if (!operation) {
    return terminalProjection ?? (ref?.input.retirementRequested === true ? false : undefined);
  }
  const attachment = getSessionControllerEntryForOperation(operation).attachment;
  return attachment?.operation === operation ? attachment.projectSessionActive : terminalProjection;
}

/** Updates presentation on the exact operation attachment without creating a second owner. */
export function setRpcSourceProjectSessionActive(
  ref: RpcSourceRef,
  active: boolean | undefined,
): void {
  const operation = ref.input.claim?.operation;
  if (!operation) {
    return;
  }
  const entry = getSessionControllerEntryForOperation(operation);
  if (entry.active !== operation) {
    return;
  }
  if (entry.attachment?.operation === operation) {
    entry.attachment.projectSessionActive = active;
    return;
  }
  entry.attachment = { operation, projectSessionActive: active };
}

export function getRpcSourceStartedAt(ref: RpcSourceRef): number | undefined {
  const operation = ref.input.claim?.operation;
  return operation && hasReplyOperationExecutionStarted(operation)
    ? operation.startedAtMs
    : undefined;
}

/** Exact owner operation, not a run-ID lookup; controller owns cancellation and settlement. */
export function requestRpcSourceCancellation(
  ref: RpcSourceRef,
  reason?: unknown,
  assertCurrent: () => void = () => {},
): boolean {
  const capture = captureSessionControllerStop({ inputs: [ref.input] });
  return cancelCapturedSessionControllerSource(capture, {
    reason,
    assertCurrent,
  }).abortedInputs.includes(ref.input);
}

export function isRpcSourceQueuedForSession(runId: string, scope: RpcSourceIdentity): boolean {
  const ref = getRpcSource(runId);
  const identity = ref && getRpcSourceIdentity(ref);
  return (
    ref !== undefined &&
    identity !== undefined &&
    isRpcSourceQueued(ref) &&
    identity.sessionId === scope.sessionId &&
    identity.sessionKey === scope.sessionKey &&
    identity.agentId === scope.agentId
  );
}

/** Capture presentation correlation with exact inputs; no scheduler state is copied. */
export function listRpcSourceEntriesForSession(params: {
  sessionKeys: Iterable<string>;
  sessionIds?: Iterable<string | undefined>;
  requiredSessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
  queuedOnly?: boolean;
}): Array<{ runId: string; entry: RpcSourceRef }> {
  const keys = new Set(params.sessionKeys);
  const ids = new Set(params.sessionIds ?? []);
  return listRpcSourceEntries().flatMap(([runId, entry]) => {
    const identity = getRpcSourceIdentity(entry);
    if (params.queuedOnly && !isRpcSourceQueued(entry)) {
      return [];
    }
    if (!keys.has(identity.sessionKey) && !ids.has(identity.sessionId)) {
      return [];
    }
    if (
      params.requiredSessionId !== undefined &&
      (!keys.has(identity.sessionKey) || identity.sessionId !== params.requiredSessionId)
    ) {
      return [];
    }
    if (
      params.agentId &&
      !chatRunBelongsToAgent(
        {
          agentId: identity.agentId,
          sessionKey: identity.sessionKey,
          defaultAgentId: params.defaultAgentId,
        },
        params.agentId,
      )
    ) {
      return [];
    }
    return [{ runId, entry }];
  });
}

import type { OperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import type { ChatAbortDiagnosticReason } from "../gateway/chat-abort-diagnostics.js";
import { chatRunBelongsToAgent } from "../gateway/chat-run-owner.js";
import type { AgentRunDelegatedAuthority } from "../infra/agent-run-authority.types.js";
import {
  isSessionControllerSourceQueued,
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

type ChatTerminalProducer = {
  sessionId: string;
  sessionKey: string;
  handoff: (settle: (producerCompleted: Promise<void>) => Promise<void>) => boolean;
};

export type RpcSourceAdapter = SessionControllerSourceAdapter & {
  /** Captures this run's canonical producer before cancellation releases its live slot. */
  resolveTerminalProducer?: () => ChatTerminalProducer | undefined;
  sessionId: string;
  sessionKey: string;
  lifecycleGeneration?: string;
  /** Exact operational instance created by this controller registration. */
  operationalRunInstance?: OperationalRunInstanceRef;
  /** Exact approval lease captured when this controller's execution was admitted. */
  agentRunDelegatedAuthority?: AgentRunDelegatedAuthority;
  agentId?: string;
  ownerConnId?: string;
  ownerDeviceId?: string;
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
  /** Caller completion requested cleanup before terminal lifecycle persistence settled. */
  registrationCleanupRequested?: boolean;
  /** False after the owning reply run commits a terminal outcome. */
  isAbortable?: (entry: RpcSourceRef) => boolean;
  /** Runs once when this registration is actually removed. */
  onRemoved?: () => void;
  /**
   * Which RPC owns this registration. Absent (undefined) is treated as
   * `"chat-send"` so pre-existing callers that constructed entries without
   * a kind keep their behavior. Consumers that need "chat.send specifically
   * is active" must check `kind !== "agent"`, not just `.has(runId)`.
   */
  kind?: "chat-send" | "agent";
  /** Side questions stay independent from main-turn TUI session stops. */
  turnKind?: "main" | "btw";
};

/** Byte-exact protocol correlation; scheduling and cancellation belong to input. */
export type RpcSourceRef = Readonly<{ input: SessionControllerInput; adapter: RpcSourceAdapter }>;
export type RpcSourceIndex = Map<string, RpcSourceRef>;

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
    return (
      terminalProjection ?? (ref?.adapter.registrationCleanupRequested === true ? false : undefined)
    );
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

export function isRpcSourceQueuedForSession(
  sources: ReadonlyMap<string, RpcSourceRef> | undefined,
  runId: string,
  scope: Pick<RpcSourceAdapter, "sessionId" | "sessionKey" | "agentId">,
): boolean {
  const ref = sources?.get(runId);
  return (
    ref !== undefined &&
    isRpcSourceQueued(ref) &&
    ref.adapter.sessionId === scope.sessionId &&
    ref.adapter.sessionKey === scope.sessionKey &&
    ref.adapter.agentId === scope.agentId
  );
}

/** Capture presentation correlation with exact inputs; no scheduler state is copied. */
export function listRpcSourcesForSession(params: {
  rpcSources: ReadonlyMap<string, RpcSourceRef>;
  sessionKeys: Iterable<string>;
  sessionIds?: Iterable<string | undefined>;
  requiredSessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
  queuedOnly?: boolean;
}): Array<{ runId: string; entry: RpcSourceRef }> {
  const keys = new Set(params.sessionKeys);
  const ids = new Set(params.sessionIds ?? []);
  return [...params.rpcSources].flatMap(([runId, entry]) => {
    const adapter = entry.adapter;
    if (params.queuedOnly && !isRpcSourceQueued(entry)) {
      return [];
    }
    if (!keys.has(adapter.sessionKey) && !ids.has(adapter.sessionId)) {
      return [];
    }
    if (
      params.requiredSessionId !== undefined &&
      (!keys.has(adapter.sessionKey) || adapter.sessionId !== params.requiredSessionId)
    ) {
      return [];
    }
    if (
      params.agentId &&
      !chatRunBelongsToAgent(
        {
          agentId: adapter.agentId,
          sessionKey: adapter.sessionKey,
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

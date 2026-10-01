import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import {
  createAgentRunRestartAbortError,
  resolveAgentRunAbortLifecycleFields,
} from "../agents/run-termination.js";
import { readToolValidationErrorSummary } from "../agents/tool-error-summary.js";
import { isAbortRequestText } from "../auto-reply/reply/abort-primitives.js";
import type { QueueSettings } from "../auto-reply/reply/queue/types.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import {
  releaseAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import type { SessionTarget } from "../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
  trackSessionControllerSourceWork,
  type SessionControllerSourceAdapter,
} from "../sessions/session-controller.mailbox.js";
import {
  getRpcSourceStartedAt,
  isRpcSourceExecuting,
  requestRpcSourceCancellation,
  type RpcSourceAdapter,
} from "../sessions/session-controller.rpc-sources.js";
import { captureSessionControllerStop, stopSession } from "../sessions/session-controller.stop.js";
import {
  resolveChatAbortDiagnosticReason,
  type ChatAbortDiagnosticReason,
} from "./chat-abort-diagnostics.js";
import { notifyChatAbortControllerRemoved } from "./chat-abort-lifecycle-internal.js";
import type { ChatAbortControllerEntry } from "./chat-abort.types.js";
import { appendChatCanvasBlocksToMessage } from "./chat-display-projection.canvas.js";
import { resolveChatRunOwnerAgentId } from "./chat-run-owner.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import { createChatAbortMarker, type ChatRunState } from "./server-chat-state.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import {
  resolveSessionSubscriptionKey,
  resolveSessionSubscriptionKeys,
} from "./session-subscription-keys.js";

export type { ChatAbortControllerEntry } from "./chat-abort.types.js";
export {
  projectInFlightRunSnapshot,
  resolveInFlightRunSnapshot,
  type InFlightRunSnapshot,
} from "./chat-in-flight-snapshot.js";

const DEFAULT_CHAT_RUN_ABORT_GRACE_MS = 60_000;

export type RestartRecoveryCandidate = {
  runId: string;
  lifecycleGeneration: string;
  sessionKey: string;
  sessionId: string;
  observedAt?: number;
};

type RegisteredChatAbortController = {
  controller: AbortController;
  markExecutionStarted: () => boolean;
  bindAgentRunDelegatedAuthority: (authority: AgentRunDelegatedAuthority) => void;
  cleanup: () => void;
} & (
  | { registered: true; entry: ChatAbortControllerEntry }
  | { registered: false; entry?: undefined }
);

export function isChatStopCommandText(text: string): boolean {
  return isAbortRequestText(text);
}

function createChatAbortSignalReason(stopReason: string | undefined): Error | undefined {
  if (stopReason === "restart") {
    return createAgentRunRestartAbortError();
  }
  if (stopReason !== "timeout") {
    return undefined;
  }
  const reason = new Error("chat run timed out");
  reason.name = "TimeoutError";
  return reason;
}

export function resolveChatRunExpiresAtMs(params: {
  now: number;
  timeoutMs: number;
  graceMs?: number;
  minMs?: number;
  maxMs?: number;
}): number {
  const {
    now,
    timeoutMs,
    graceMs = DEFAULT_CHAT_RUN_ABORT_GRACE_MS,
    minMs = 2 * 60_000,
    maxMs = 24 * 60 * 60_000,
  } = params;
  const safeNow = asDateTimestampMs(now);
  if (safeNow === undefined) {
    return 0;
  }
  const boundedTimeoutMs = Math.max(0, timeoutMs);
  const targetDurationMs = boundedTimeoutMs + graceMs;
  const target = resolveExpiresAtMsFromDurationMs(targetDurationMs, { nowMs: safeNow });
  const min = resolveExpiresAtMsFromDurationMs(minMs, { nowMs: safeNow });
  const max = resolveExpiresAtMsFromDurationMs(maxMs, { nowMs: safeNow });
  if (target === undefined || min === undefined || max === undefined) {
    return 0;
  }
  return Math.min(max, Math.max(min, target));
}

export function resolveAgentRunExpiresAtMs(params: {
  now: number;
  timeoutMs: number;
  graceMs?: number;
}): number {
  const graceMs = Math.max(0, params.graceMs ?? DEFAULT_CHAT_RUN_ABORT_GRACE_MS);
  return resolveChatRunExpiresAtMs({
    now: params.now,
    timeoutMs: params.timeoutMs,
    graceMs,
    minMs: graceMs,
    maxMs: Math.max(0, params.timeoutMs) + graceMs,
  });
}

export function registerChatAbortController(params: {
  rpcSources: Map<string, ChatAbortControllerEntry>;
  target?: SessionTarget;
  policy?: QueueSettings;
  authority?: SessionControllerSourceAdapter["authority"];
  runId: string;
  sessionId: string;
  sessionKey?: string | null;
  agentId?: string;
  timeoutMs: number;
  ownerConnId?: string;
  ownerDeviceId?: string;
  providerId?: string;
  authProviderId?: string;
  controlUiVisible?: boolean;
  projectSessionActive?: boolean;
  isAbortable?: (entry: ChatAbortControllerEntry) => boolean;
  resolveTerminalProducer?: (
    entry: ChatAbortControllerEntry,
  ) => ReturnType<NonNullable<RpcSourceAdapter["resolveTerminalProducer"]>>;
  onRemoved?: () => void;
  kind?: RpcSourceAdapter["kind"];
  turnKind?: RpcSourceAdapter["turnKind"];
  lifecycleGeneration?: string;
  operationalRunInstance?: OperationalRunInstanceRef;
  /** Raw source work includes preparation and source-specific terminal publication. */
  sourceWork?: Promise<unknown>;
  now?: number;
  expiresAtMs?: number;
}): RegisteredChatAbortController {
  // Sessionless RPCs retain prepared authority without a fabricated session owner.
  if (!params.sessionKey || params.rpcSources.has(params.runId)) {
    const controller = new AbortController();
    return {
      controller,
      registered: false,
      markExecutionStarted: () => false,
      bindAgentRunDelegatedAuthority: () => {
        throw new Error("Unregistered source cannot own a projected run authority");
      },
      cleanup: () => {},
    };
  }
  if (!params.target) {
    throw new Error("RPC source requires its captured physical session target");
  }
  const adapter: RpcSourceAdapter = {
    scope: params.target.storeScope,
    authority: params.authority,
    requester: { connectionId: params.ownerConnId, deviceId: params.ownerDeviceId },
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    lifecycleGeneration: params.lifecycleGeneration ?? getAgentEventLifecycleGeneration(),
    operationalRunInstance: params.operationalRunInstance,
    agentId: normalizeOptionalLowercaseString(params.agentId),
    ownerConnId: params.ownerConnId,
    ownerDeviceId: params.ownerDeviceId,
    providerId: normalizeOptionalLowercaseString(params.providerId),
    authProviderId: normalizeOptionalLowercaseString(params.authProviderId),
    controlUiVisible: params.controlUiVisible,
    isAbortable: params.isAbortable,
    onRemoved: params.onRemoved,
    projectSessionActive: params.projectSessionActive ?? true,
    kind: params.kind,
    turnKind: params.turnKind,
  };
  const input = reserveSessionControllerSource(params.sessionKey, {
    protocolRunId: params.runId,
    sourceTurnId: params.runId,
    policy: params.policy ?? { mode: "followup" },
    target: params.target,
    adapter,
  });
  if (params.sourceWork) {
    trackSessionControllerSourceWork(input, params.sourceWork);
  }
  const entry: ChatAbortControllerEntry = { input, adapter };
  adapter.cancel = (reason) => {
    adapter.abortStopReason ??=
      typeof reason === "string"
        ? reason
        : resolveAgentRunAbortLifecycleFields(input.abortSignal).stopReason;
    adapter.abortDiagnosticReason ??= resolveChatAbortDiagnosticReason(input.abortSignal, adapter);
  };
  adapter.resolveTerminalProducer = params.resolveTerminalProducer
    ? () => params.resolveTerminalProducer?.(entry)
    : undefined;
  // This forwarding handle owns no independent cancellation state.
  const controller: AbortController = {
    signal: input.abortSignal,
    abort: (reason?: unknown) => {
      requestRpcSourceCancellation(entry, reason);
    },
  };
  const cleanup = () => {
    if (params.rpcSources.get(params.runId) !== entry) {
      return;
    }
    if (adapter.agentRunDelegatedAuthority) {
      releaseAgentRunDelegatedAuthority(adapter.agentRunDelegatedAuthority);
    }
    adapter.registrationCleanupRequested = true;
    // Accepted injection retains this source through its native outcome. A
    // returning dispatcher releases only registration custody, not the input.
    if (input.injection) {
      return;
    }
    if (input.custody.work?.size || input.custody.adopting || input.custody.settling) {
      retireSessionControllerInput(input);
      return;
    }
    if (
      (input.claim && !input.claim.released) ||
      (input.custody.enqueued && input.phase !== "consumed")
    ) {
      return;
    }
    if (adapter.projectSessionTerminalPending) {
      return;
    }
    const persistence = adapter.projectSessionTerminalPersistence;
    if (persistence) {
      const finish = (persisted: boolean) => {
        if (
          params.rpcSources.get(params.runId) === entry &&
          adapter.projectSessionTerminalPersistence === persistence
        ) {
          // Keep a rejected write on the captured receipt: index removal is not
          // successful persistence, and the drain owner must retain that failure.
          if (persisted) {
            adapter.projectSessionTerminalPersistence = undefined;
          }
          removeChatAbortControllerEntry(params.rpcSources, params.runId, entry);
        }
      };
      void persistence
        .then(
          () => finish(true),
          () => finish(false),
        )
        .catch(() => {});
      return;
    }
    removeChatAbortControllerEntry(params.rpcSources, params.runId, entry);
  };
  adapter.onSettled = () => {
    if (adapter.registrationCleanupRequested) {
      cleanup();
    }
  };
  params.rpcSources.set(params.runId, entry);
  return {
    controller,
    registered: true,
    entry,
    markExecutionStarted: () => isRpcSourceExecuting(entry),
    bindAgentRunDelegatedAuthority: (authority) => {
      if (
        params.rpcSources.get(params.runId) !== entry ||
        !adapter.operationalRunInstance ||
        authority.operationalRunInstance !== adapter.operationalRunInstance ||
        (adapter.agentRunDelegatedAuthority && adapter.agentRunDelegatedAuthority !== authority)
      ) {
        throw new Error("Agent authority does not belong to this exact RPC source");
      }
      adapter.agentRunDelegatedAuthority = authority;
    },
    cleanup,
  };
}

export type ChatAbortOps = {
  rpcSources: Map<string, ChatAbortControllerEntry>;
  chatRunState: Pick<ChatRunState, "clearRun" | "getOrCreate" | "resolveBuffer" | "runs">;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => { sessionKey: string; agentId?: string; clientRunId: string } | undefined;
  agentRunSeq: Map<string, number>;
  getRuntimeConfig?: () => OpenClawConfig;
  broadcast: GatewayBroadcastFn;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  onRunAborted?: (runId: string) => void;
};

function resolveChatAbortDeliverySessionKeys(
  ops: ChatAbortOps,
  sessionKey: string,
  agentId: string | undefined,
): string[] {
  const scopedAgentId = normalizeOptionalLowercaseString(agentId);
  if (!scopedAgentId) {
    return [sessionKey];
  }
  const canonicalKey = resolveSessionSubscriptionKey(sessionKey, scopedAgentId);
  if (canonicalKey === sessionKey) {
    return [canonicalKey];
  }
  return resolveSessionSubscriptionKeys(
    sessionKey,
    scopedAgentId,
    resolveDefaultGlobalAgentId(ops),
  );
}

function broadcastChatAborted(
  ops: ChatAbortOps,
  params: {
    runId: string;
    sessionKey: string;
    agentId?: string;
    stopReason?: string;
    message?: Record<string, unknown>;
    errorMessage?: string;
    liveTextGroup?: AbortSignal;
  },
) {
  const { runId, sessionKey, stopReason } = params;
  const errorMessage = readToolValidationErrorSummary(params.errorMessage);
  const explicitAgentId = normalizeOptionalLowercaseString(params.agentId);
  const defaultGlobalAgentId =
    sessionKey === "global" && !explicitAgentId
      ? normalizeOptionalLowercaseString(resolveDefaultGlobalAgentId(ops))
      : undefined;
  const payloadAgentId =
    sessionKey === "global" ? (explicitAgentId ?? defaultGlobalAgentId) : explicitAgentId;
  const payload = {
    runId,
    sessionKey,
    ...(payloadAgentId ? { agentId: payloadAgentId } : {}),
    seq: (ops.agentRunSeq.get(runId) ?? 0) + 1,
    state: "aborted" as const,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    message: params.message ? { ...params.message, timestamp: Date.now() } : undefined,
  };
  const deliverySessionKeys = resolveChatAbortDeliverySessionKeys(ops, sessionKey, payloadAgentId);
  ops.broadcast("chat", payload, {
    sessionKeys: deliverySessionKeys,
    ...(params.liveTextGroup ? { liveText: { group: params.liveTextGroup } } : {}),
  });
  for (const deliverySessionKey of deliverySessionKeys) {
    ops.nodeSendToSession(deliverySessionKey, "chat", payload);
  }
}

function resolveDefaultGlobalAgentId(ops: ChatAbortOps): string | undefined {
  const cfg = ops.getRuntimeConfig?.();
  if (!cfg) {
    return undefined;
  }
  const resolved = resolveRequestedSessionAgentId(cfg, "global");
  return resolved.ok ? resolved.agentId : undefined;
}

export function isChatAbortControllerEntryAbortable(entry: ChatAbortControllerEntry): boolean {
  if (
    entry.input.abortSignal.aborted ||
    entry.input.phase === "consumed" ||
    entry.input.custody.cancellationRetired ||
    entry.input.retirementRequested ||
    entry.input.withdrawalHolds > 0 ||
    entry.input.claim?.operation?.abortFrozen ||
    entry.input.claim?.operation?.result
  ) {
    return false;
  }
  try {
    return entry.adapter.isAbortable?.(entry) !== false;
  } catch {
    return false;
  }
}

export function removeChatAbortControllerEntry(
  entries: Map<string, ChatAbortControllerEntry>,
  runId: string,
  expectedEntry?: ChatAbortControllerEntry,
): boolean {
  const entry = entries.get(runId);
  if (!entry || (expectedEntry && entry !== expectedEntry)) {
    return false;
  }
  // A timeout or terminal projection does not settle the source. In particular,
  // never seal a generic private timeout while its producer can still publish facts.
  if (
    entry.input.custody.work?.size ||
    entry.input.injection ||
    entry.input.custody.adopting ||
    entry.input.custody.settling ||
    (entry.input.claim && !entry.input.claim.released) ||
    (entry.input.custody.enqueued && entry.input.phase !== "consumed")
  ) {
    return false;
  }
  entries.delete(runId);
  retireSessionControllerInput(entry.input);
  try {
    entry.adapter.onRemoved?.();
  } catch {
    // Removal owns state cleanup even if a caller-provided release hook fails.
  } finally {
    notifyChatAbortControllerRemoved(entry);
  }
  return true;
}

export function captureChatRunAbortPresentation(ops: ChatAbortOps, runId: string) {
  const bufferedText = ops.chatRunState.resolveBuffer(runId, { final: true }).text;
  const run = ops.chatRunState.runs.get(runId);
  const liveTextGroup = run?.liveTextGroup?.signal;
  const partialText = bufferedText && bufferedText.trim() ? bufferedText : undefined;
  const canvasBlocks =
    run?.bufferIsCurrent?.() !== false &&
    (partialText || !(run?.rawBuffer ?? run?.buffer ?? "").trim())
      ? (run?.canvasBlocks ?? [])
      : [];
  // Abort listeners can clear buffers and revoke their owner synchronously.
  const message = appendChatCanvasBlocksToMessage(
    partialText || canvasBlocks.length
      ? { role: "assistant", content: partialText ? [{ type: "text", text: partialText }] : [] }
      : undefined,
    canvasBlocks,
  );
  return { message, liveTextGroup };
}

export function abortChatRunById(
  ops: ChatAbortOps,
  params: {
    runId: string;
    sessionKey: string;
    stopReason?: string;
    diagnosticReason?: ChatAbortDiagnosticReason;
    onAbortPrepared?: () => void;
    onAbortCommitted?: () => void;
    expectedEntry?: ChatAbortControllerEntry;
    /** Shutdown can cancel retained cleanup without replacing an already published terminal. */
    preserveTerminal?: boolean;
    presentation?: ReturnType<typeof captureChatRunAbortPresentation>;
    /** Exact primitive supplied by the common captured Stop sequencer. */
    cancel?: () => boolean;
    assertCurrent?: () => void;
  },
): { aborted: boolean } {
  const { runId, sessionKey, stopReason } = params;
  params.assertCurrent?.();
  const active = params.expectedEntry ?? ops.rpcSources.get(runId);
  if (!active || ops.rpcSources.get(runId) !== active) {
    return { aborted: false };
  }
  if (active.adapter.sessionKey !== sessionKey) {
    return { aborted: false };
  }
  if (!isChatAbortControllerEntryAbortable(active)) {
    return { aborted: false };
  }

  const executionStarted = isRpcSourceExecuting(active);
  const priorRetirement = active.input.retirementRequested;
  const priorOperationResult = active.input.claim?.operation?.result;
  const { message, liveTextGroup } =
    params.presentation ?? captureChatRunAbortPresentation(ops, runId);
  const runProjection = ops.chatRunState.getOrCreate(runId);
  const previousMarker = runProjection.abortMarker;
  const previous = {
    abortStopReason: active.adapter.abortStopReason,
    abortDiagnosticReason: active.adapter.abortDiagnosticReason,
    projectSessionActive: active.adapter.projectSessionActive,
    projectSessionTerminalPending: active.adapter.projectSessionTerminalPending,
    projectSessionTerminalObservedAt: active.adapter.projectSessionTerminalObservedAt,
    registrationCleanupRequested: active.adapter.registrationCleanupRequested,
  };
  runProjection.abortMarker = createChatAbortMarker();
  if (stopReason) {
    active.adapter.abortStopReason = stopReason;
  }
  active.adapter.abortDiagnosticReason = params.diagnosticReason;
  // Reserve transcript settlement while this exact producer still has authority.
  try {
    params.onAbortPrepared?.();
  } catch {
    // Transcript handoff failure cannot prevent an already accepted cancellation.
  }
  active.adapter.projectSessionActive = false;
  // Reserve terminal ownership before abort listeners run; synchronous caller
  // cleanup must not erase the entry before Gateway observes the event below.
  if (!params.preserveTerminal) {
    active.adapter.projectSessionTerminalPending = true;
    active.adapter.projectSessionTerminalObservedAt = undefined;
  }
  active.adapter.registrationCleanupRequested = true;
  let cancelled: boolean;
  let cancellationFailure: { error: unknown } | undefined;
  try {
    cancelled = params.cancel
      ? params.cancel()
      : requestRpcSourceCancellation(
          active,
          createChatAbortSignalReason(stopReason),
          params.assertCurrent,
        );
  } catch (error) {
    cancelled =
      (!priorOperationResult && active.input.claim?.operation?.result?.kind === "aborted") ||
      (!priorRetirement &&
        active.input.retirementRequested === true &&
        active.input.abortSignal.aborted);
    if (!cancelled) {
      Object.assign(active.adapter, previous);
      runProjection.abortMarker = previousMarker;
      throw error;
    }
    cancellationFailure = { error };
  }
  if (!cancelled) {
    Object.assign(active.adapter, previous);
    runProjection.abortMarker = previousMarker;
    return { aborted: false };
  }
  // Cancellation is committed. These publication/revocation receipts finish even if
  // a synchronous abort listener revoked the requesting connection.
  params.onAbortCommitted?.();
  if (active.adapter.agentRunDelegatedAuthority) {
    releaseAgentRunDelegatedAuthority(active.adapter.agentRunDelegatedAuthority);
  }
  const replacement = ops.rpcSources.get(runId);
  if (replacement && replacement !== active) {
    if (!params.preserveTerminal) {
      active.adapter.projectSessionTerminalPending = false;
    }
    if (cancellationFailure) {
      throw cancellationFailure.error;
    }
    return { aborted: true };
  }
  try {
    ops.onRunAborted?.(runId);
  } catch {
    /* Requested cancellation already committed. */
  }
  if (ops.chatRunState.runs.get(runId) === runProjection) {
    ops.chatRunState.clearRun(runId);
  }
  const removed = ops.removeChatRun(runId, runId, sessionKey);
  if (!params.preserveTerminal && active.adapter.controlUiVisible !== false) {
    broadcastChatAborted(ops, {
      runId,
      sessionKey,
      agentId: active.adapter.agentId,
      stopReason,
      message,
      errorMessage: active.adapter.toolErrorSummary,
      liveTextGroup,
    });
  }
  if (!params.preserveTerminal) {
    emitAgentEvent({
      runId,
      ...(active.adapter.lifecycleGeneration
        ? { lifecycleGeneration: active.adapter.lifecycleGeneration }
        : {}),
      sessionKey,
      sessionId: active.adapter.sessionId,
      agentId: active.adapter.agentId,
      stream: "lifecycle",
      data: {
        phase: "end",
        status: "cancelled",
        aborted: true,
        stopReason,
        ...(active.adapter.toolErrorSummary
          ? { toolErrorSummary: active.adapter.toolErrorSummary }
          : {}),
        // Pre-execution admission time is not an execution start.
        startedAt: !executionStarted ? undefined : (getRpcSourceStartedAt(active) ?? 0),
        ...(!executionStarted
          ? {
              executionStarted: false,
              providerStarted: false,
              ...(stopReason === "timeout" ? { timeoutPhase: "queue" } : {}),
            }
          : {}),
        endedAt: Date.now(),
      },
    });
  }
  // Gateway listeners synchronously stamp the terminal observation. Keep the
  // entry as suspension-visible ownership until its persistence write settles.
  if (
    !params.preserveTerminal &&
    ops.rpcSources.get(runId) === active &&
    active.adapter.projectSessionTerminalObservedAt === undefined &&
    !active.adapter.projectSessionTerminalPersistence
  ) {
    active.adapter.projectSessionTerminalPending = false;
    removeChatAbortControllerEntry(ops.rpcSources, runId, active);
  } else if (params.preserveTerminal) {
    removeChatAbortControllerEntry(ops.rpcSources, runId, active);
  }
  ops.agentRunSeq.delete(runId);
  if (removed?.clientRunId) {
    ops.agentRunSeq.delete(removed.clientRunId);
  }
  if (cancellationFailure) {
    throw cancellationFailure.error;
  }
  return { aborted: true };
}

export function updateChatRunProvider(
  rpcSources: Map<string, ChatAbortControllerEntry>,
  params: {
    runId: string;
    providerId?: string;
    authProviderId?: string;
  },
): boolean {
  const entry = rpcSources.get(params.runId);
  if (!entry) {
    return false;
  }
  entry.adapter.providerId = normalizeOptionalLowercaseString(params.providerId);
  entry.adapter.authProviderId = normalizeOptionalLowercaseString(params.authProviderId);
  return true;
}

export function abortChatRunsForProvider(
  ops: ChatAbortOps,
  params: {
    cfg: OpenClawConfig;
    providerId: string;
    agentId?: string;
    stopReason?: string;
  },
): { runIds: string[] } {
  const providerId = normalizeOptionalLowercaseString(params.providerId);
  const agentId = normalizeOptionalLowercaseString(params.agentId);
  if (!providerId) {
    return { runIds: [] };
  }
  const compatibilityOwnerAgentId = agentId && tryResolveLegacyCompatibilityAgentId(params.cfg);
  const matches = [...ops.rpcSources.entries()].filter(([, entry]) => {
    if (
      normalizeOptionalLowercaseString(entry.adapter.authProviderId) !== providerId &&
      normalizeOptionalLowercaseString(entry.adapter.providerId) !== providerId
    ) {
      return false;
    }
    return (
      !agentId ||
      resolveChatRunOwnerAgentId({
        agentId: entry.adapter.agentId,
        sessionKey: entry.adapter.sessionKey,
        defaultAgentId: compatibilityOwnerAgentId,
      }) === agentId
    );
  });
  const runIds: string[] = [];
  const byInput = new Map(
    matches.map(([runId, entry]) => [
      entry.input,
      { runId, entry, presentation: captureChatRunAbortPresentation(ops, runId) },
    ]),
  );
  const capture = captureSessionControllerStop({ inputs: byInput.keys() });
  stopSession({
    capture,
    source: "operator-revocation",
    reason: params.stopReason,
    cancelInput: (input, cancel) => {
      const target = byInput.get(input);
      if (!target) {
        return false;
      }
      return abortChatRunById(ops, {
        runId: target.runId,
        sessionKey: target.entry.adapter.sessionKey,
        expectedEntry: target.entry,
        presentation: target.presentation,
        cancel,
        stopReason: params.stopReason,
        onAbortCommitted: () => runIds.push(target.runId),
      }).aborted;
    },
  });
  return { runIds };
}

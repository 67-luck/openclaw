import fs from "node:fs";
import path from "node:path";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createMessageInjectionAuthority } from "../../auto-reply/reply/message-injection-authority.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import {
  getActiveAgentRunDelegatedAuthority,
  getAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  isDiagnosticEmbeddedRunOwnerClosed,
  markDiagnosticEmbeddedRunEnded,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
} from "../../logging/diagnostic-run-activity.js";
import { logMessageQueuedWithBacklogPolicy } from "../../logging/diagnostic-runtime.js";
import { diagnosticLogger as diag, logSessionStateChange } from "../../logging/diagnostic.js";
import { hasPromptImageInput } from "../../media/prompt-image-input.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type {
  ReplyMessageInjectionOptions,
  ReplyBackendHandle,
} from "../../sessions/session-controller.contracts.js";
import {
  abortActiveReplyRuns,
  abortReplyRunBySessionId,
  isReplyRunEvidenceStaleBySessionId,
  resolveActiveReplyOperationForSessionId,
  resolveActiveReplyRunSessionId,
  resolveReplyBackendQueueMessageMismatch,
  supersedeReplyRunByRunId,
  type ReplyOperation,
  waitForReplyOperationOwnerSettlement,
} from "../../sessions/session-controller.js";
import {
  assertSessionControllerOperation,
  getAttachedBackend,
  getSessionControllerEntryForOperation,
  markReplyOperationExecutionStarted,
  isReplyRunEvidenceStale,
} from "../../sessions/session-controller.state.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { QuestionAnswerUnconfirmedError } from "../harness/gateway-question-dispatch.js";
import { resolveSessionPlacementForcedTerminalSettlement } from "../session-placement-forced-terminal-settlement.js";
import { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import {
  getActiveNativeAttempt,
  activeNativeAttempts,
  attachNativeAttempt,
  detachNativeAttempt,
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID,
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
  ACTIVE_EMBEDDED_RUN_SNAPSHOTS,
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID,
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
  EMBEDDED_RUN_COMPLETION_CLAIMS,
  EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS,
  RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS,
  setActiveEmbeddedRunLifecycleGeneration,
  type ActiveEmbeddedRunSnapshot,
  type AbandonedEmbeddedRun,
  type EmbeddedAgentQueueHandle,
  type EmbeddedAgentQueueMessageOptions,
  type EmbeddedRunCompletionClaim,
  type EmbeddedRunCompletionRegistration,
  type EmbeddedRunRegistration,
  type EmbeddedAgentQueueFailureReason,
} from "./run-state.js";
import {
  canSteerEmbeddedRunDuringCompaction,
  isEmbeddedRunHandleAbortable,
  isEmbeddedRunHandleSupersedable,
} from "./runs.probes.js";

export type { EmbeddedAgentQueueHandle, EmbeddedAgentQueueMessageOptions } from "./run-state.js";

export type EmbeddedRunTimeoutRecoveryMarker = {
  sessionId: string;
  recoveryToken: symbol;
};

export type EmbeddedAgentQueueMessageOutcome =
  | {
      queued: true;
      sessionId: string;
      target: "embedded_run" | "reply_run";
      gatewayHealth: "live";
      /** Input is non-replayable, but its delivery or commitment could not be confirmed. */
      transcriptCommit?: "unconfirmed";
      errorMessage?: string;
      deliveredAtMs?: number;
      enqueuedAtMs?: number;
    }
  | {
      queued: false;
      sessionId: string;
      reason: EmbeddedAgentQueueFailureReason;
      gatewayHealth: "live";
      errorMessage?: string;
    };

type PreparedEmbeddedAgentQueueMessage =
  | {
      kind: "complete";
      outcome: EmbeddedAgentQueueMessageOutcome;
      pendingInput?: Pick<
        EmbeddedAgentQueueHandle,
        "claimPendingUserInputAnswer" | "cancelPendingUserInput"
      >;
    }
  | {
      kind: "embedded_run";
      queueMessage: EmbeddedAgentQueueHandle["queueMessage"];
      options: EmbeddedAgentQueueMessageOptions;
    };

function createQueueFailureOutcome(
  sessionId: string,
  reason: EmbeddedAgentQueueFailureReason,
  errorMessage?: string,
): EmbeddedAgentQueueMessageOutcome {
  return {
    queued: false,
    sessionId,
    reason,
    gatewayHealth: "live",
    ...(errorMessage ? { errorMessage } : {}),
  };
}

export function formatEmbeddedAgentQueueFailureSummary(
  outcome: EmbeddedAgentQueueMessageOutcome,
): string | undefined {
  if (outcome.queued) {
    return undefined;
  }
  const errorPart = outcome.errorMessage ? ` error=${outcome.errorMessage}` : "";
  return `queue_message_failed reason=${outcome.reason} sessionId=${outcome.sessionId} gatewayHealth=${outcome.gatewayHealth}${errorPart}`;
}
function clearActiveRunSessionIndex(
  index: Map<string, string>,
  sessionId: string,
  key?: string,
): void {
  // File aliases always use the sweep: cleanup may not retain the registration's file token.
  if (key) {
    if (index.get(key) === sessionId) {
      index.delete(key);
    }
    return;
  }
  for (const [entryKey, activeSessionId] of index) {
    if (activeSessionId === sessionId) {
      index.delete(entryKey);
    }
  }
}

function normalizeSessionFileRegistryKey(sessionFile: string | undefined): string | undefined {
  const normalized = sessionFile?.trim();
  if (!normalized) {
    return undefined;
  }
  if (
    normalized.startsWith("agent:") ||
    normalized.startsWith("sqlite:") ||
    normalized.startsWith("in-memory:")
  ) {
    return normalized;
  }
  const resolved = path.resolve(normalized);
  const parent = path.dirname(resolved);
  try {
    // Canonicalize only the parent so a registry key stays stable when the
    // transcript file itself is created or removed during the active run.
    // Artifact-file symlinks are not runtime session identity after SQLite migration.
    return path.join(fs.realpathSync(parent), path.basename(resolved));
  } catch {
    return resolved;
  }
}

function setActiveRunSessionFile(sessionFile: string | undefined, sessionId: string): void {
  const normalizedSessionFile = normalizeSessionFileRegistryKey(sessionFile);
  if (!normalizedSessionFile) {
    return;
  }
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.set(normalizedSessionFile, sessionId);
}

function clearEmbeddedRunAbandonmentBySessionId(sessionId: string): void {
  const abandonedRun = ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.get(sessionId);
  if (!abandonedRun) {
    return;
  }
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.delete(sessionId);
  const normalizedSessionKey = abandonedRun.sessionKey?.trim();
  if (
    normalizedSessionKey &&
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey) === sessionId
  ) {
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.delete(normalizedSessionKey);
  }
  const normalizedSessionFile = normalizeSessionFileRegistryKey(abandonedRun.sessionFile);
  if (
    normalizedSessionFile &&
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(normalizedSessionFile) === sessionId
  ) {
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.delete(normalizedSessionFile);
  }
}

function clearEmbeddedRunAbandonment(params: {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
}): void {
  const normalizedSessionId = params.sessionId?.trim();
  if (normalizedSessionId) {
    clearEmbeddedRunAbandonmentBySessionId(normalizedSessionId);
  }
  for (const [key, index] of [
    [params.sessionKey?.trim(), ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY],
    [
      normalizeSessionFileRegistryKey(params.sessionFile),
      ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
    ],
  ] as const) {
    const sessionId = key ? index.get(key) : undefined;
    if (sessionId) {
      clearEmbeddedRunAbandonmentBySessionId(sessionId);
    }
  }
}

function markEmbeddedRunAbandoned(params: {
  sessionId: string;
  runId?: string;
  sessionKey?: string;
  sessionFile?: string;
  reason: AbandonedEmbeddedRun["reason"];
}): void {
  const sessionId = params.sessionId.trim();
  if (!sessionId) {
    return;
  }
  clearEmbeddedRunAbandonment({
    sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
  });
  const normalizedSessionFile = normalizeSessionFileRegistryKey(params.sessionFile);
  const abandonedRun: AbandonedEmbeddedRun = {
    sessionId,
    ...(params.runId?.trim() ? { runId: params.runId.trim() } : {}),
    abandonedAtMs: Date.now(),
    reason: params.reason,
    ...(params.sessionKey?.trim() ? { sessionKey: params.sessionKey.trim() } : {}),
    ...(normalizedSessionFile ? { sessionFile: normalizedSessionFile } : {}),
  };
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.set(sessionId, abandonedRun);
  if (abandonedRun.sessionKey) {
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.set(abandonedRun.sessionKey, sessionId);
  }
  if (abandonedRun.sessionFile) {
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.set(abandonedRun.sessionFile, sessionId);
  }
}

export function markActiveEmbeddedRunAbandoned(params: {
  sessionId: string;
  handle: EmbeddedAgentQueueHandle;
  sessionKey?: string;
  sessionFile?: string;
  reason: AbandonedEmbeddedRun["reason"];
}): boolean {
  const sessionId = params.sessionId.trim();
  if (!sessionId || getActiveNativeAttempt(sessionId) !== params.handle) {
    return false;
  }
  markEmbeddedRunAbandoned({ ...params, runId: params.handle.runId });
  return true;
}

export function resolveEmbeddedRunAbandonment(params: {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
}): AbandonedEmbeddedRun["reason"] | undefined {
  const normalizedSessionId = params.sessionId?.trim();
  const normalizedSessionKey = params.sessionKey?.trim();
  const normalizedSessionFile = normalizeSessionFileRegistryKey(params.sessionFile);
  const sessionIds = [
    normalizedSessionId,
    normalizedSessionKey
      ? ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey)
      : undefined,
    normalizedSessionFile
      ? ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(normalizedSessionFile)
      : undefined,
  ];
  const reasons = new Set(
    sessionIds.map((sessionId) =>
      sessionId ? ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.get(sessionId)?.reason : undefined,
    ),
  );
  return reasons.has("timeout")
    ? "timeout"
    : reasons.has("recovering_timeout")
      ? "recovering_timeout"
      : undefined;
}

/**
 * Temporarily releases terminal-timeout delivery suppression while a timed-out
 * attempt is performing an eligible compaction-and-retry recovery.
 */
export function markEmbeddedRunRecoveringTimeout(params: {
  sessionId: string;
  runId?: string;
}): EmbeddedRunTimeoutRecoveryMarker | undefined {
  const abandoned = ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.get(params.sessionId.trim());
  if (
    !abandoned ||
    abandoned.reason !== "timeout" ||
    (abandoned.runId && abandoned.runId !== params.runId?.trim())
  ) {
    return undefined;
  }
  const recoveryToken = Symbol("openclaw.embeddedRunTimeoutRecovery");
  abandoned.reason = "recovering_timeout";
  abandoned.recoveryToken = recoveryToken;
  return { sessionId: abandoned.sessionId, recoveryToken };
}

/** Restores terminal-timeout suppression when recovery cannot continue. */
export function restoreEmbeddedRunTimeoutAbandonment(
  marker: EmbeddedRunTimeoutRecoveryMarker,
): boolean {
  const abandoned = ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.get(marker.sessionId.trim());
  if (
    !abandoned ||
    abandoned.reason !== "recovering_timeout" ||
    abandoned.recoveryToken !== marker.recoveryToken
  ) {
    return false;
  }
  abandoned.reason = "timeout";
  delete abandoned.recoveryToken;
  return true;
}

/**
 * @deprecated Prefer queueEmbeddedAgentMessageWithOutcomeAsync when callers need to
 * know whether steering was accepted. This sync helper is fire-and-forget after
 * initial eligibility and only logs later runtime rejection.
 */
export function queueEmbeddedAgentMessageWithOutcome(
  sessionId: string,
  text: string,
  options?: ReplyMessageInjectionOptions,
): EmbeddedAgentQueueMessageOutcome {
  const prepared = prepareEmbeddedAgentQueueMessage(sessionId, options);
  if (prepared.kind === "complete") {
    return prepared.outcome;
  }
  logActiveRunMessageAccepted(sessionId);
  void prepared.queueMessage(text, prepared.options).catch((err: unknown) => {
    const message = `queue message rejected after enqueue: sessionId=${sessionId} err=${formatErrorMessage(err)}`;
    if (err instanceof QuestionAnswerUnconfirmedError) {
      diag.warn(message);
    } else {
      diag.debug(message);
    }
  });
  return {
    queued: true,
    sessionId,
    target: "embedded_run",
    gatewayHealth: "live",
    enqueuedAtMs: Date.now(),
  };
}

function logActiveRunMessageAccepted(sessionId: string): void {
  // Active-run steering is consumed by the current turn, not queued as another
  // turn for the single idle transition to drain. Keep the event and activity.
  logMessageQueuedWithBacklogPolicy(
    {
      sessionId,
      source: "embedded-agent-runner",
    },
    false,
  );
}

function resolveEmbeddedInjection(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  sourceCanInject?: () => boolean,
):
  | Pick<
      EmbeddedAgentQueueHandle,
      "queueMessage" | "claimPendingUserInputAnswer" | "cancelPendingUserInput"
    >
  | undefined {
  try {
    const guarded = handle.messageInjectionV2;
    if (guarded?.version === 2) {
      const registration = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
      const operation = resolveActiveReplyOperationForSessionId(sessionId);
      const ownedOperation =
        operation && getAttachedBackend(operation) === handle ? operation : undefined;
      const assertCurrent = createMessageInjectionAuthority(() => {
        if (sourceCanInject && !sourceCanInject()) {
          return false;
        }
        registration?.toolAuthority?.assertActive();
        return (
          getActiveNativeAttempt(sessionId) === handle &&
          ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) === registration &&
          (!ownedOperation ||
            (resolveActiveReplyOperationForSessionId(sessionId) === ownedOperation &&
              getAttachedBackend(ownedOperation) === handle))
        );
      });
      const authorityKind = sourceCanInject ? "source-bound" : "run";
      return guarded.isAvailable()
        ? {
            queueMessage: (text, options) =>
              guarded.queueMessage(text, options, assertCurrent, authorityKind),
            claimPendingUserInputAnswer: guarded.claimPendingUserInputAnswer
              ? (text, options) =>
                  guarded.claimPendingUserInputAnswer!(text, options, assertCurrent, authorityKind)
              : undefined,
            cancelPendingUserInput: guarded.cancelPendingUserInput
              ? (resolvedBy) =>
                  guarded.cancelPendingUserInput!(resolvedBy, assertCurrent, authorityKind)
              : undefined,
          }
        : undefined;
    }
    // Shipped v2026.8.1 sinks have no source-lifetime enforcement contract.
    if (sourceCanInject) {
      return undefined;
    }
    const injection = handle.messageInjection;
    if (injection) {
      return injection.isAvailable()
        ? {
            queueMessage: (text, options) => injection.queueMessage(text, options),
            claimPendingUserInputAnswer: handle.claimPendingUserInputAnswer?.bind(handle),
            cancelPendingUserInput: handle.cancelPendingUserInput?.bind(handle),
          }
        : undefined;
    }
    // Legacy handles predate explicit injection capability. Preserve their
    // shipped eligibility probe while modern backends use messageInjection.
    const isAvailable = handle.isStopped ? !handle.isStopped() : handle.isStreaming();
    return isAvailable ? handle : undefined;
  } catch (err) {
    diag.warn(
      `queue message failed: sessionId=${sessionId} reason=injectable_check_failed err=${String(err)}`,
    );
    return undefined;
  }
}

export function isEmbeddedAgentRunAbortableForRunId(runId: string): boolean {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return true;
  }
  const handle = ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(normalizedRunId);
  return handle ? isEmbeddedRunHandleAbortable(normalizedRunId, handle) : true;
}

/** Cancels one exact process-local run after recording its superseded terminal owner. */
export function supersedeEmbeddedAgentRunByRunId(runId: string, beforeCancel: () => void): boolean {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return false;
  }
  const handle = ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(normalizedRunId);
  if (handle) {
    if (!isEmbeddedRunHandleSupersedable(normalizedRunId, handle)) {
      return false;
    }
    beforeCancel();
    if (handle.cancel) {
      handle.cancel("superseded");
    } else {
      handle.abort();
    }
    return true;
  }
  return supersedeReplyRunByRunId(normalizedRunId, beforeCancel);
}

export function clearEmbeddedAgentRunAbortabilityForRunId(runId: string): void {
  const normalizedRunId = runId.trim();
  if (normalizedRunId) {
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.delete(normalizedRunId);
    RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS.delete(normalizedRunId);
  }
}

export function retainEmbeddedAgentRunAbortabilityForRunId(runId: string): void {
  const normalizedRunId = runId.trim();
  if (normalizedRunId) {
    RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS.add(normalizedRunId);
  }
}

function clearEmbeddedRunAbortability(
  handle: EmbeddedAgentQueueHandle,
  opts?: { retainFinalizing?: boolean },
): void {
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle)?.humanInputWaits?.clear();
  if (!handle.runId || ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(handle.runId) !== handle) {
    return;
  }
  if (
    opts?.retainFinalizing &&
    RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS.has(handle.runId) &&
    !isEmbeddedRunHandleAbortable(handle.runId, handle)
  ) {
    return;
  }
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.delete(handle.runId);
}

export async function queueEmbeddedAgentMessageWithOutcomeAsync(
  sessionId: string,
  text: string,
  options?: ReplyMessageInjectionOptions,
): Promise<EmbeddedAgentQueueMessageOutcome> {
  return queueEmbeddedAgentMessageAsync(sessionId, text, options);
}

/** TUI preflight requires V2 ownership; failure leaves ordinary input to local queue policy. */
export async function claimPendingEmbeddedAgentQuestionAnswer(
  sessionId: string,
  text: string,
): Promise<{ runId: string } | null> {
  const handle = getActiveNativeAttempt(sessionId);
  if (!handle?.runId?.trim() || handle.messageInjectionV2?.version !== 2) {
    return null;
  }
  const runId = handle.runId;
  const registration = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  const injection = resolveEmbeddedInjection(sessionId, handle);
  if (!injection?.claimPendingUserInputAnswer) {
    return null;
  }
  try {
    registration?.toolAuthority?.assertActive();
  } catch {
    return null;
  }
  if (
    getActiveNativeAttempt(sessionId) !== handle ||
    ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) !== registration
  ) {
    return null;
  }
  // V2 carries the captured owner assertion through persistence and final dispatch.
  // An unconfirmed answer must propagate; queue fallback could replay accepted input.
  const claimed = await injection.claimPendingUserInputAnswer(text, { isInboundUserMessage: true });
  if (!claimed) {
    return null;
  }
  logActiveRunMessageAccepted(sessionId);
  return { runId };
}

/** Source-bound callers require an explicitly guarded backend, never a V1 fallback. */
export async function queueGuardedEmbeddedAgentMessageWithOutcomeAsync(
  sessionId: string,
  text: string,
  options: ReplyMessageInjectionOptions | undefined,
  canInject: () => boolean,
): Promise<EmbeddedAgentQueueMessageOutcome> {
  return queueEmbeddedAgentMessageAsync(sessionId, text, options, canInject);
}

async function queueEmbeddedAgentMessageAsync(
  sessionId: string,
  text: string,
  options?: ReplyMessageInjectionOptions,
  canInject?: () => boolean,
): Promise<EmbeddedAgentQueueMessageOutcome> {
  const prepared = prepareEmbeddedAgentQueueMessage(sessionId, options, canInject);
  const enqueuedAtMs = Date.now();
  const unconfirmed = (errorMessage: string): EmbeddedAgentQueueMessageOutcome => {
    diag.warn(
      `queue message accepted without confirmation: sessionId=${sessionId} err=${errorMessage}`,
    );
    logActiveRunMessageAccepted(sessionId);
    return {
      queued: true,
      sessionId,
      target: "embedded_run",
      gatewayHealth: "live",
      transcriptCommit: "unconfirmed",
      errorMessage,
      enqueuedAtMs,
    };
  };
  const failed = (error: unknown): EmbeddedAgentQueueMessageOutcome => {
    if (error instanceof QuestionAnswerUnconfirmedError) {
      throw error;
    }
    const errorMessage = formatErrorMessage(error);
    diag.debug(`queue message rejected: sessionId=${sessionId} err=${errorMessage}`);
    return createQueueFailureOutcome(sessionId, "runtime_rejected", errorMessage);
  };
  if (prepared.kind === "complete") {
    if (
      !prepared.outcome.queued &&
      (prepared.outcome.reason === "tool_authority_mismatch" ||
        prepared.outcome.reason === "input_visibility_mismatch" ||
        prepared.outcome.reason === "image_input_unsupported") &&
      options?.isInboundUserMessage === true &&
      hasPromptImageInput(options) &&
      prepared.pendingInput
    ) {
      try {
        await prepared.pendingInput.cancelPendingUserInput?.("image-reply");
      } catch (err) {
        diag.warn(
          `failed to cancel pending user input before queued image fallback: sessionId=${sessionId} err=${formatErrorMessage(err)}`,
        );
      }
    }
    if (
      !prepared.outcome.queued &&
      (prepared.outcome.reason === "tool_authority_mismatch" ||
        prepared.outcome.reason === "input_visibility_mismatch") &&
      options?.isInboundUserMessage === true &&
      !hasPromptImageInput(options) &&
      prepared.pendingInput
    ) {
      const claimPendingUserInputAnswer = prepared.pendingInput.claimPendingUserInputAnswer;
      if (claimPendingUserInputAnswer) {
        try {
          if (await claimPendingUserInputAnswer(text, options)) {
            options.onQueueAccepted?.(true);
            logActiveRunMessageAccepted(sessionId);
            return {
              queued: true,
              sessionId,
              target: "embedded_run",
              gatewayHealth: "live",
              enqueuedAtMs: Date.now(),
            };
          }
        } catch (err) {
          return failed(err);
        }
      }
    }
    return prepared.outcome;
  }
  try {
    const queueResult = await prepared.queueMessage(text, prepared.options);
    if (queueResult?.transcriptCommit === "unconfirmed") {
      return unconfirmed(queueResult.errorMessage);
    }
    const deliveredAtMs = options?.waitForTranscriptCommit ? Date.now() : undefined;
    logActiveRunMessageAccepted(sessionId);
    return {
      queued: true,
      sessionId,
      target: "embedded_run",
      gatewayHealth: "live",
      ...(deliveredAtMs !== undefined ? { deliveredAtMs } : {}),
      enqueuedAtMs,
    };
  } catch (err) {
    return failed(err);
  }
}

function prepareEmbeddedAgentQueueMessage(
  sessionId: string,
  options?: ReplyMessageInjectionOptions,
  sourceCanInject?: () => boolean,
): PreparedEmbeddedAgentQueueMessage {
  const reject = (reason: EmbeddedAgentQueueFailureReason): PreparedEmbeddedAgentQueueMessage => ({
    kind: "complete",
    outcome: createQueueFailureOutcome(sessionId, reason),
  });
  const handle = getActiveNativeAttempt(sessionId);
  if (!handle) {
    // A stale reply-backed run must produce the same closed reason as the
    // embedded gate so announce delivery falls through to direct instead of
    // reading the wedged op as active and dropping the handoff.
    if (isReplyRunEvidenceStaleBySessionId(sessionId)) {
      diag.debug(`queue message failed: sessionId=${sessionId} reason=stale_run`);
      return reject("stale_run");
    }
    if (options?.waitForTranscriptCommit === true) {
      diag.debug(
        `queue message failed: sessionId=${sessionId} reason=transcript_commit_wait_unsupported`,
      );
      return reject("transcript_commit_wait_unsupported");
    }
    return reject("no_active_run");
  }
  const registration = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  if (sourceCanInject && handle.messageInjectionV2?.version !== 2) {
    return reject("guarded_injection_unsupported");
  }
  const injection = resolveEmbeddedInjection(sessionId, handle, sourceCanInject);
  if (!injection) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=not_streaming`);
    return reject("not_streaming");
  }
  if (registration?.operation && isReplyRunEvidenceStale(registration.operation)) {
    return reject("stale_run");
  }
  if (!canSteerEmbeddedRunDuringCompaction(sessionId, handle)) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=compacting`);
    return reject("compacting");
  }
  if (options?.waitForTranscriptCommit === true && handle.supportsTranscriptCommitWait !== true) {
    diag.debug(
      `queue message failed: sessionId=${sessionId} reason=transcript_commit_wait_unsupported`,
    );
    return reject("transcript_commit_wait_unsupported");
  }
  const operation = resolveActiveReplyOperationForSessionId(sessionId);
  const ownedOperation =
    operation && getAttachedBackend(operation) === handle ? operation : undefined;
  const { toolAuthorityOverlay, ...backendOptions } = options ?? { steeringMode: "all" as const };
  if (toolAuthorityOverlay) {
    // An overlay is caller evidence; a supplied raw hash cannot override it.
    try {
      backendOptions.toolAuthorityFingerprint = registration?.toolAuthority
        ? registration.toolAuthority.project(toolAuthorityOverlay)
        : ownedOperation?.projectToolAuthorityFingerprint(toolAuthorityOverlay);
    } catch {
      backendOptions.toolAuthorityFingerprint = undefined;
    }
    if (!backendOptions.toolAuthorityFingerprint) {
      return reject("tool_authority_mismatch");
    }
  }
  const deliveryModeMismatch = resolveReplyBackendQueueMessageMismatch(
    handle,
    backendOptions,
    ownedOperation,
  );
  if (deliveryModeMismatch) {
    const activeFingerprint = normalizeOptionalString(handle.toolAuthorityFingerprint);
    // Projected caller authority takes precedence over raw route-mismatch proof.
    const pendingInputAuthorityProven =
      (!toolAuthorityOverlay || deliveryModeMismatch === "input_visibility_mismatch") &&
      (deliveryModeMismatch !== "input_visibility_mismatch" ||
        handle.messageInjectionV2?.version === 2) &&
      activeFingerprint &&
      (normalizeOptionalString(backendOptions.toolAuthorityFingerprint) === activeFingerprint ||
        (!toolAuthorityOverlay &&
          normalizeOptionalString(options?.pendingInputAuthorityFingerprint) ===
            activeFingerprint));
    diag.debug(`queue message failed: sessionId=${sessionId} reason=${deliveryModeMismatch}`);
    return {
      kind: "complete",
      outcome: createQueueFailureOutcome(sessionId, deliveryModeMismatch),
      ...(pendingInputAuthorityProven ? { pendingInput: injection } : {}),
    };
  }
  try {
    registration?.toolAuthority?.assertActive();
  } catch {
    return reject("tool_authority_mismatch");
  }
  if (
    getActiveNativeAttempt(sessionId) !== handle ||
    ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) !== registration ||
    (ownedOperation &&
      (resolveActiveReplyOperationForSessionId(sessionId) !== ownedOperation ||
        getAttachedBackend(ownedOperation) !== handle))
  ) {
    return reject("no_active_run");
  }
  return { kind: "embedded_run", queueMessage: injection.queueMessage, options: backendOptions };
}

function revokeCompletionClaim(sessionId: string, runId?: string): void {
  const claim = EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId);
  if (claim && (runId === undefined || claim.runId === runId)) {
    claim.settleRegistration(undefined);
    EMBEDDED_RUN_COMPLETION_CLAIMS.delete(sessionId);
  }
}

/**
 * Abort embedded OpenClaw runs.
 *
 * - With a sessionId, aborts that single run.
 * - With no sessionId, supports targeted abort modes (for example, compacting runs only).
 */
export function abortEmbeddedAgentRun(sessionId: string): boolean;
export function abortEmbeddedAgentRun(
  sessionId: undefined,
  opts: { mode: "all" | "compacting"; reason?: "restart" },
): boolean;
export function abortEmbeddedAgentRun(
  sessionId?: string,
  opts?: { mode?: "all" | "compacting"; reason?: "restart" },
): boolean {
  if (typeof sessionId === "string" && sessionId.length > 0) {
    const handle = getActiveNativeAttempt(sessionId);
    const operation = handle ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle)?.operation : undefined;
    if (operation) {
      return operation.abortByUser();
    }
    if (!handle) {
      return abortReplyRunBySessionId(sessionId);
    }
    if (
      !isEmbeddedRunHandleAbortable(sessionId, handle, "all") ||
      getActiveNativeAttempt(sessionId) !== handle
    ) {
      return false;
    }
    // Detached runtimes deliberately have no session turn. Their exact native
    // handle still owns cancellation and must not be replaced by an ID lookup.
    handle.abort();
    revokeCompletionClaim(sessionId, handle.runId);
    return true;
  }

  const mode = opts?.mode;
  if (mode !== "all" && mode !== "compacting") {
    return false;
  }
  const detachedTargets = [...activeNativeAttempts()].filter(
    ([, handle]) => !ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle)?.operation,
  );
  const replyAborted = abortActiveReplyRuns({
    mode,
    onAbortError: (id, err) =>
      diag.warn(`abort failed: sessionId=${id} owner=reply_run err=${String(err)}`),
  });
  let aborted = false;
  for (const [id, handle] of detachedTargets) {
    if (getActiveNativeAttempt(id) !== handle || !isEmbeddedRunHandleAbortable(id, handle, mode)) {
      continue;
    }
    diag.debug(`aborting ${mode === "compacting" ? "compacting " : ""}run: sessionId=${id}`);
    try {
      handle.abort(opts?.reason);
      revokeCompletionClaim(id, handle.runId);
      aborted = true;
    } catch (err) {
      diag.warn(`abort failed: sessionId=${id} err=${String(err)}`);
    }
  }
  return replyAborted || aborted;
}

type EmbeddedHeartbeatPreemptionResult = "not-heartbeat" | "drained" | "timed-out";

export async function preemptAndDrainEmbeddedHeartbeatRun(
  sessionId: string,
  timeoutMs: number,
): Promise<EmbeddedHeartbeatPreemptionResult> {
  const handle = getActiveNativeAttempt(sessionId);
  if (!handle?.preemptByVisibleTurn) {
    return "not-heartbeat";
  }
  const drainPromise = waitForCurrentEmbeddedAgentRunEnd(sessionId, timeoutMs, handle);
  try {
    handle.preemptByVisibleTurn();
  } catch (err) {
    diag.warn(`heartbeat preemption failed: sessionId=${sessionId} err=${String(err)}`);
  }
  return (await drainPromise) ? "drained" : "timed-out";
}

export function prepareEmbeddedAgentRunCompletionClaim(
  sessionId: string,
  runId: string,
): {
  bindOperationalRunInstance: (
    instance: NonNullable<EmbeddedRunRegistration["operationalRunInstance"]>,
  ) => boolean;
  claimCompletion: () => boolean;
  claimFailure: () => boolean;
  resolveCurrentRegistration: () => EmbeddedRunCompletionRegistration | undefined;
  registered: Promise<EmbeddedRunCompletionRegistration | undefined>;
} {
  let settleRegistration!: (registration: EmbeddedRunCompletionRegistration | undefined) => void;
  const registered = new Promise<EmbeddedRunCompletionRegistration | undefined>((resolve) => {
    settleRegistration = resolve;
  });
  const claim: EmbeddedRunCompletionClaim = {
    runId,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    promoted: false,
    settleRegistration,
  };
  revokeCompletionClaim(sessionId);
  EMBEDDED_RUN_COMPLETION_CLAIMS.set(sessionId, claim);
  const consume = (allowUnregistered: boolean): boolean => {
    if (EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) !== claim) {
      return false;
    }
    EMBEDDED_RUN_COMPLETION_CLAIMS.delete(sessionId);
    if (!claim.promoted) {
      claim.settleRegistration(undefined);
    }
    return (
      (allowUnregistered || claim.promoted) &&
      !claim.operation?.abortSignal.aborted &&
      isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)
    );
  };
  const bindOperationalRunInstance = (
    instance: NonNullable<EmbeddedRunRegistration["operationalRunInstance"]>,
  ): boolean => {
    if (
      EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) !== claim ||
      !isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration) ||
      instance.runId !== runId ||
      (claim.operationalRunInstance !== undefined && claim.operationalRunInstance !== instance)
    ) {
      return false;
    }
    claim.operationalRunInstance = instance;
    return true;
  };
  const resolveCurrentRegistration = (): EmbeddedRunCompletionRegistration | undefined => {
    if (
      EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) !== claim ||
      !isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)
    ) {
      return undefined;
    }
    const handle = getActiveNativeAttempt(sessionId);
    const registration = handle ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) : undefined;
    const toolAuthority = registration?.toolAuthority;
    if (
      !handle ||
      handle.runId !== runId ||
      !toolAuthority ||
      !claim.operationalRunInstance ||
      registration.operationalRunInstance !== claim.operationalRunInstance
    ) {
      return undefined;
    }
    try {
      toolAuthority.assertActive();
    } catch {
      return undefined;
    }
    return EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) === claim &&
      getActiveNativeAttempt(sessionId) === handle &&
      ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) === registration &&
      isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)
      ? { toolAuthority }
      : undefined;
  };
  return {
    bindOperationalRunInstance,
    claimCompletion: () => consume(false),
    claimFailure: () => consume(true),
    resolveCurrentRegistration,
    registered,
  };
}

export function isEmbeddedAgentRunHandleActive(sessionId: string): boolean {
  const active = Boolean(getActiveNativeAttempt(sessionId));
  if (active) {
    diag.debug(`run handle active check: sessionId=${sessionId} active=true`);
  }
  return active;
}

export function isEmbeddedAgentRunStreaming(sessionId: string): boolean {
  const handle = getActiveNativeAttempt(sessionId);
  return handle?.isStreaming() ?? false;
}

export function resolveActiveEmbeddedRunHandleSessionId(sessionKey: string): string | undefined {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    return undefined;
  }
  const operation = resolveActiveReplyOperationForSessionId(
    resolveActiveReplyRunSessionId(normalizedSessionKey) ?? "",
  );
  return operation && getActiveNativeAttempt(operation.sessionId) ? operation.sessionId : undefined;
}

function isEmbeddedRunHandleInProgress(
  handle: EmbeddedAgentQueueHandle | undefined,
): handle is EmbeddedAgentQueueHandle {
  if (!handle) {
    return false;
  }
  if (handle.isAborted) {
    try {
      if (handle.isAborted()) {
        return false;
      }
    } catch {
      // A failed optional status probe cannot prove that live work has ended.
    }
  }
  return true;
}

export type ActiveEmbeddedRunOwner = {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  startedAtMs?: number;
  abort: () => boolean;
  /** Stops this captured owner and distinguishes a frozen writer from a stale target. */
  stop: () => "aborted" | "finalizing" | "unchanged";
  /** Joins this captured native attempt and its producer, never a same-ID successor. */
  waitForSettlement: () => Promise<void>;
};

function projectActiveEmbeddedRunOwner(
  registration: EmbeddedRunRegistration,
  handle: EmbeddedAgentQueueHandle,
): ActiveEmbeddedRunOwner | undefined {
  const runId = handle.runId;
  if (!runId || !isEmbeddedRunHandleInProgress(handle)) {
    return undefined;
  }
  const stop = (): "aborted" | "finalizing" | "unchanged" => {
    if (
      getActiveNativeAttempt(registration.sessionId) !== handle ||
      ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) !== registration ||
      ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(runId) !== handle
    ) {
      return "unchanged";
    }
    if (registration.operation?.abortFrozen || !isEmbeddedRunHandleAbortable(runId, handle)) {
      return "finalizing";
    }
    try {
      const aborted = registration.operation
        ? registration.operation.abortByUser()
        : (() => {
            if (handle.cancel) {
              handle.cancel("user_abort");
            } else {
              handle.abort();
            }
            return true;
          })();
      if (!aborted) {
        return "unchanged";
      }
      revokeCompletionClaim(registration.sessionId, runId);
      return "aborted";
    } catch {
      // A throwing backend cannot undo cancellation already committed by its owner.
      return registration.operation?.result?.kind === "aborted" ? "aborted" : "unchanged";
    }
  };
  return {
    runId,
    sessionId: registration.sessionId,
    ...(registration.sessionKey ? { sessionKey: registration.sessionKey } : {}),
    ...(handle.startedAtMs === undefined ? {} : { startedAtMs: handle.startedAtMs }),
    waitForSettlement: async () => {
      await Promise.all([registration.settlement.promise, registration.operation?.ownerSettlement]);
    },
    // A recovered run ID is correlation only. Recheck the captured owner before
    // Stop so a stale UI action cannot abort replacement work in the session.
    stop,
    abort: () => stop() === "aborted",
  };
}

export function resolveActiveEmbeddedRunOwner(
  sessionId: string,
): ActiveEmbeddedRunOwner | undefined {
  const handle = getActiveNativeAttempt(sessionId);
  const registration = handle ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) : undefined;
  return handle && registration ? projectActiveEmbeddedRunOwner(registration, handle) : undefined;
}

export function resolveActiveEmbeddedRunOwnerByRunId(
  runId: string,
): ActiveEmbeddedRunOwner | undefined {
  const normalizedRunId = runId.trim();
  const handle = normalizedRunId ? ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(normalizedRunId) : undefined;
  if (!handle) {
    return undefined;
  }
  const registration = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  return registration && getActiveNativeAttempt(registration.sessionId) === handle
    ? projectActiveEmbeddedRunOwner(registration, handle)
    : undefined;
}

export function isActiveEmbeddedRunId(runId: string): boolean {
  const normalizedRunId = runId.trim();
  const handle = normalizedRunId ? ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(normalizedRunId) : undefined;
  const registration = handle ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) : undefined;
  return Boolean(
    handle &&
    registration &&
    getActiveNativeAttempt(registration.sessionId) === handle &&
    isEmbeddedRunHandleInProgress(handle),
  );
}

function resolveActiveEmbeddedRunHandleSessionIdBySessionFile(
  sessionFile: string,
): string | undefined {
  const normalizedSessionFile = normalizeSessionFileRegistryKey(sessionFile);
  if (!normalizedSessionFile) {
    return undefined;
  }
  return ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(normalizedSessionFile);
}

export { resolveActiveEmbeddedRunHandleSessionIdBySessionFile as resolveActiveEmbeddedRunSessionIdBySessionFile };

export function getActiveEmbeddedRunSnapshot(
  sessionId: string,
): ActiveEmbeddedRunSnapshot | undefined {
  return ACTIVE_EMBEDDED_RUN_SNAPSHOTS.get(sessionId);
}

async function waitForCurrentEmbeddedAgentRunEnd(
  sessionId: string,
  timeoutMs: number | null,
  handle: EmbeddedAgentQueueHandle,
): Promise<boolean> {
  const registration = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  if (!registration) {
    return true;
  }
  const settled = registration.settlement.promise.then(() => true);
  if (timeoutMs === null) {
    return await settled;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      settled,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(
          () => {
            diag.warn(`wait timeout: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
            resolve(false);
          },
          resolveTimerTimeoutMs(timeoutMs, 100, 100),
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function waitForEmbeddedAgentRunEnd(
  sessionId: string,
  timeoutMs: number | null = 15_000,
): Promise<boolean> {
  const handle = getActiveNativeAttempt(sessionId);
  const operation = handle
    ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle)?.operation
    : resolveActiveReplyOperationForSessionId(sessionId);
  const nativeSettlement = handle
    ? waitForCurrentEmbeddedAgentRunEnd(sessionId, timeoutMs, handle)
    : Promise.resolve(true);
  const ownerSettlement = operation
    ? timeoutMs === null
      ? operation.ownerSettlement.then(() => true)
      : waitForReplyOperationOwnerSettlement(operation, timeoutMs)
    : Promise.resolve(true);
  const [nativeSettled, ownerSettled] = await Promise.all([nativeSettlement, ownerSettlement]);
  return nativeSettled && ownerSettled;
}

export type AbortAndDrainEmbeddedAgentRunResult = {
  aborted: boolean;
  drained: boolean;
  forceCleared: boolean;
};

export async function abortAndDrainEmbeddedAgentRun(params: {
  sessionId: string;
  sessionKey?: string;
  settleMs?: number;
  forceClear?: boolean;
  reason?: string;
}): Promise<AbortAndDrainEmbeddedAgentRunResult> {
  const settleMs = params.settleMs ?? 15_000;
  const handle = getActiveNativeAttempt(params.sessionId);
  const operation = handle
    ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle)?.operation
    : resolveActiveReplyOperationForSessionId(params.sessionId);
  // Both receipts are captured before cancellation can reenter and install a successor.
  const nativeSettlement = handle
    ? waitForCurrentEmbeddedAgentRunEnd(params.sessionId, settleMs, handle)
    : Promise.resolve(true);
  const ownerSettlement = operation
    ? waitForReplyOperationOwnerSettlement(operation, settleMs)
    : Promise.resolve(true);
  let aborted = false;
  if (params.reason === "stuck_recovery") {
    if (operation) {
      const wasAborted = operation.abortSignal.aborted;
      const decision = await operation.watchdog.tick();
      // A committed Stop can correctly finish its tick as cleanup-blocked.
      // Report that accepted cancellation without mistaking it for settlement.
      aborted =
        (!wasAborted && operation.abortSignal.aborted) ||
        decision.action === "stop" ||
        decision.action === "expire_cleanup";
    }
  } else if (operation) {
    aborted = operation.abortByUser();
  } else if (handle) {
    handle.abort();
    aborted = true;
  }
  // Forced placement cleanup may revoke exact write authority, but cannot prove
  // the raw backend finished. Keep native registration and session custody until it does.
  if (params.forceClear && handle) {
    const cleanup = EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.get(handle);
    if (cleanup && ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle)?.operation === operation) {
      await cleanup();
    }
  }
  const [nativeSettled, ownerSettled] = await Promise.all([nativeSettlement, ownerSettlement]);
  return { aborted, drained: nativeSettled && ownerSettled, forceCleared: false };
}

function hasNativeBackendControl(
  handle: EmbeddedAgentQueueHandle,
): handle is EmbeddedAgentQueueHandle & ReplyBackendHandle {
  return handle.kind === "embedded" && typeof handle.cancel === "function";
}

export function setActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  sessionKey?: string,
  sessionFile?: string,
  agentId?: string,
  admittedOperation?: ReplyOperation,
) {
  const currentLifecycleGeneration = getAgentEventLifecycleGeneration();
  const incomingLifecycleGeneration = setActiveEmbeddedRunLifecycleGeneration(
    handle,
    currentLifecycleGeneration,
  );
  // The immutable handle generation rejects delayed stale registration even
  // when rotation left no replacement owner in the session slot.
  if (!isAgentEventLifecycleGenerationCurrent(incomingLifecycleGeneration)) {
    revokeCompletionClaim(sessionId, handle.runId);
    try {
      handle.abort("restart");
    } catch (error) {
      diag.warn(`stale run registration abort failed: sessionId=${sessionId} err=${String(error)}`);
      throw error;
    }
    return;
  }
  if (handle.diagnosticOwner && isDiagnosticEmbeddedRunOwnerClosed(handle.diagnosticOwner)) {
    revokeCompletionClaim(sessionId, handle.runId);
    handle.abort("restart");
    return;
  }
  const caller = getGatewayToolCallerIdentity();
  let toolAuthority: EmbeddedRunRegistration["toolAuthority"];
  try {
    toolAuthority = caller?.embeddedRunToolAuthorityBinding?.({
      sessionId,
      sessionKey,
      sessionFile,
      agentId,
      handle,
    });
  } catch (error) {
    revokeCompletionClaim(sessionId, handle.runId);
    throw error;
  }
  const operation = toolAuthority?.operation ?? admittedOperation;
  if (
    admittedOperation &&
    toolAuthority?.operation &&
    admittedOperation !== toolAuthority.operation
  ) {
    throw new Error("Native registration received conflicting session turn owners");
  }
  if (operation) {
    assertSessionControllerOperation(operation);
    if (
      operation.key !== sessionKey ||
      operation.sessionId !== sessionId ||
      (operation.agentId && agentId && operation.agentId !== normalizeAgentId(agentId))
    ) {
      throw new Error("Native registration does not match the exact admitted session turn");
    }
  } else if (sessionKey && toolAuthority?.detached === true) {
    // A prepared detached attempt can carry a policy key without owning that session.
    toolAuthority?.assertActive();
  } else if (sessionKey) {
    throw new Error("Native session registration requires controller turn admission");
  }
  const previousHandle = getActiveNativeAttempt(sessionId);
  const wasActive = previousHandle !== undefined;
  if (previousHandle) {
    ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(previousHandle)?.watchdogAttempt?.close();
    ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(previousHandle)?.closeWatchdogWait?.();
    previousHandle.closeDiagnostics?.();
    detachNativeAttempt(previousHandle);
    clearEmbeddedRunAbortability(previousHandle, { retainFinalizing: true });
    EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.delete(previousHandle);
  }
  try {
    toolAuthority?.assertActive();
  } catch (error) {
    revokeCompletionClaim(sessionId, handle.runId);
    throw error;
  }
  clearEmbeddedRunAbandonment({ sessionId, sessionKey, sessionFile });
  if (operation && getAttachedBackend(operation) !== handle) {
    if (hasNativeBackendControl(handle)) {
      operation.attachBackend(handle);
    } else {
      operation.attachBackend({
        ...handle,
        kind: "embedded",
        cancel: (reason) =>
          handle.cancel
            ? handle.cancel(reason)
            : handle.abort(reason === "restart" ? reason : undefined),
      });
    }
  }
  // The dispatch scope carries the admitted instance across both core and
  // plugin attempts. A handle's public runId alone cannot confer wait authority.
  const operationalRunInstance = caller?.operationalRunInstance;
  const runContext = handle.runId ? getAgentRunContext(handle.runId) : undefined;
  const watchdogAttempt = handle.diagnosticOwner?.watchdogAttempt ?? toolAuthority?.watchdogAttempt;
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS.set(handle, {
    settlement: createDeferredCore(),
    watchdogAttempt,
    operation,
    backend: operation ? getAttachedBackend(operation) : undefined,
    projectSessionActive:
      runContext?.lifecycleGeneration === incomingLifecycleGeneration
        ? runContext.projectSessionActive
        : undefined,
    toolAuthority,
    operationalRunInstance,
    sessionId,
    // Legacy SDK callers may omit this; a matching live binding proves the captured owner.
    agentId: agentId ?? (toolAuthority ? caller?.agentId : undefined),
    ...(sessionKey ? { sessionKey } : {}),
    delegatedAuthority:
      operationalRunInstance?.runId === handle.runId && operationalRunInstance
        ? getActiveAgentRunDelegatedAuthority(operationalRunInstance)
        : undefined,
    onHumanInputResolved: () => {
      if (operation && getActiveNativeAttempt(sessionId) === handle) {
        operation.recordActivity();
      }
      markDiagnosticRunProgress({ sessionId, sessionKey, reason: "human_input:resolved" });
      // A real resolution resumes work and invalidates recovery queued before it.
      // This does not refresh progress while waiting or extend any run deadline.
      logSessionStateChange({
        sessionId,
        sessionKey,
        sessionFile,
        state: "processing",
        reason: "human_input_resolved",
      });
    },
  });
  attachNativeAttempt(handle, operation);
  if (watchdogAttempt && handle.ownsLiveness) {
    const registration = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle)!;
    const wait = watchdogAttempt.beginWait({
      kind: "runtime_owned",
      isCurrent: () => {
        if (
          ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) !== registration ||
          (operation &&
            getSessionControllerEntryForOperation(operation).nativeAttempt?.handle !== handle)
        ) {
          return false;
        }
        toolAuthority?.assertActive();
        return handle.ownsLiveness?.() === true && !handle.isAborted?.() && !handle.isStopped?.();
      },
    });
    registration.closeWatchdogWait = () => wait.close();
  }
  if (operation) {
    if (toolAuthority?.sourceTurnId) {
      getSessionControllerEntryForOperation(operation).sourceTurnId = toolAuthority.sourceTurnId;
    }
    markReplyOperationExecutionStarted(operation);
    if (operation.phase === "queued") {
      operation.setPhase("running");
    }
    const native = getSessionControllerEntryForOperation(operation).nativeAttempt;
    if (native) {
      native.projectSessionActive =
        ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle)?.projectSessionActive;
    }
  }
  const forcedTerminalSettlement = resolveSessionPlacementForcedTerminalSettlement();
  if (forcedTerminalSettlement) {
    EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.set(handle, forcedTerminalSettlement);
  }
  if (handle.runId) {
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.set(handle.runId, handle);
  }
  clearActiveRunSessionIndex(ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE, sessionId);
  setActiveRunSessionFile(sessionFile, sessionId);
  logSessionStateChange({
    sessionId,
    sessionKey,
    sessionFile,
    state: "processing",
    reason: wasActive ? "run_replaced" : "run_started",
  });
  markDiagnosticEmbeddedRunStarted({
    sessionId,
    sessionKey,
    runId: handle.runId,
    owner: handle.diagnosticOwner,
  });
  if (!sessionId.startsWith("probe-")) {
    diag.debug(
      `run registered: sessionId=${sessionId} totalActive=${[...activeNativeAttempts()].length}`,
    );
  }
  const completionClaim = EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId);
  if (
    completionClaim &&
    completionClaim.runId === handle.runId &&
    completionClaim.lifecycleGeneration === incomingLifecycleGeneration &&
    (completionClaim.operationalRunInstance === undefined ||
      completionClaim.operationalRunInstance === operationalRunInstance)
  ) {
    completionClaim.operation = operation;
    completionClaim.promoted = true;
    completionClaim.settleRegistration(toolAuthority ? { toolAuthority } : undefined);
  } else if (completionClaim) {
    revokeCompletionClaim(sessionId);
  }
}

export function updateActiveEmbeddedRunSnapshot(
  sessionId: string,
  snapshot: ActiveEmbeddedRunSnapshot,
) {
  if (!getActiveNativeAttempt(sessionId)) {
    return;
  }
  ACTIVE_EMBEDDED_RUN_SNAPSHOTS.set(sessionId, snapshot);
}

export function clearActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  sessionKey?: string,
  sessionFile?: string,
  reason = "run_completed",
) {
  const activeHandle = getActiveNativeAttempt(sessionId);
  const registration = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  if (!registration) {
    return;
  }
  registration.closeWatchdogWait?.();
  registration?.watchdogAttempt?.close();
  if (registration?.operation && registration.backend) {
    registration.operation.detachBackend(registration.backend);
  }
  if (activeHandle === handle) {
    handle.closeDiagnostics?.();
    const operation = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle)?.operation;
    const backend = operation && getAttachedBackend(operation);
    detachNativeAttempt(handle);
    if (operation && backend) {
      operation.detachBackend(backend);
    }
    clearEmbeddedRunAbortability(handle, { retainFinalizing: true });
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.delete(sessionId);
    clearActiveRunSessionIndex(ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE, sessionId);
    logSessionStateChange({
      sessionId,
      sessionKey,
      sessionFile,
      state: "idle",
      reason,
    });
    if (!handle.diagnosticOwner) {
      markDiagnosticEmbeddedRunEnded({ sessionId, sessionKey });
    }
    if (!sessionId.startsWith("probe-")) {
      diag.debug(
        `run cleared: sessionId=${sessionId} totalActive=${[...activeNativeAttempts()].length}`,
      );
    }
  } else {
    detachNativeAttempt(handle);
    clearEmbeddedRunAbortability(handle, { retainFinalizing: true });
    diag.debug(`run clear skipped: sessionId=${sessionId} reason=handle_mismatch`);
  }
  EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.delete(handle);
  // Exact-handle waiters own teardown even after another run takes the session slot.
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS.delete(handle);
  registration.settlement.resolve();
}

const testing = {
  resetActiveEmbeddedRuns() {
    const attempts = [...activeNativeAttempts()];
    for (const [, handle] of attempts) {
      EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.delete(handle);
    }
    for (const [sessionId, handle] of attempts) {
      clearActiveEmbeddedRun(sessionId, handle);
    }
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.clear();
    for (const claim of EMBEDDED_RUN_COMPLETION_CLAIMS.values()) {
      claim.settleRegistration(undefined);
    }
    EMBEDDED_RUN_COMPLETION_CLAIMS.clear();
    RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS.clear();
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.clear();
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.clear();
    ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.clear();
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.clear();
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.clear();
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.embeddedRunsTestApi")] =
    testing;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

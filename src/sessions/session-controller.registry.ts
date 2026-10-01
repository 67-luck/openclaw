import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
// Tracks active reply runs so stop, queue, and status commands can coordinate.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isAgentEventLifecycleGenerationCurrent,
  registerAgentEventLifecycleRotationHandler,
} from "../infra/agent-events.js";
import { markDiagnosticRunProgress } from "../logging/diagnostic-run-activity.js";
import { settlesWithin } from "../shared/settle-within.js";
import {
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  replyRunInterruptTargetOperation,
  type ReplyOperation,
  type ReplyRunInterruptTarget,
  type ReplyRunRegistry,
} from "./session-controller.contracts.js";
import { captureReplyMessageInjectionTarget } from "./session-controller.message-injection.js";
import { createReplyOperation } from "./session-controller.operation.js";
import {
  evictReplyOperationByOperation,
  getAttachedBackend,
  isReplyOperationPreBackendPhase,
  isReplyRunCompacting,
  isReplyRunEvidenceStale,
  mergeReplyRunAdmissionSource,
  getSessionControllerEntry,
  pruneSessionControllerEntry,
  getSessionControllerOperation,
  activeSessionOperations,
  sessionControllers,
  findSessionControllerEntry,
  getSessionControllerEntryForOperation,
  isCurrentSessionControllerOperation,
  resolveReplyRunForCurrentSessionId,
  resolveReplyRunWaitKey,
  type ReplyRunAdmissionSource,
  type ReplyRunWaiter,
} from "./session-controller.state.js";
import { captureSessionControllerStop, stopSessionController } from "./session-controller.stop.js";

type ReplyRunAdmissionSettlement = {
  settled: boolean;
  sources?: ReplyRunAdmissionSource[];
};

export async function waitForReplyOperationOwnerSettlement(
  operation: ReplyOperation,
  timeoutMs: number,
): Promise<boolean> {
  return await settlesWithin(operation.ownerSettlement, resolveTimerTimeoutMs(timeoutMs, 100, 100));
}

export function markReplyOperationGlobalLaneWaitProgress(operation: ReplyOperation): void {
  if (operation.result || operation.phase !== "waiting_for_global_lane") {
    return;
  }
  markDiagnosticRunProgress({
    sessionKey: operation.key,
    sessionId: operation.sessionId,
    reason: "global_lane:waiting",
  });
}

export function isReplyRunEvidenceStaleBySessionId(sessionId: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  return operation ? isReplyRunEvidenceStale(operation) : false;
}

export const replyRunRegistry: ReplyRunRegistry = {
  begin(params) {
    return createReplyOperation(params);
  },
  get(sessionKey) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey) {
      return undefined;
    }
    return getSessionControllerOperation(normalizedSessionKey);
  },
  isActive(sessionKey) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey) {
      return false;
    }
    return Boolean(getSessionControllerOperation(normalizedSessionKey));
  },
  bindSourceTurnId(operation, sourceTurnId) {
    // Durable admission can finish after reset has replaced this operation.
    if (
      !isCurrentSessionControllerOperation(operation) ||
      operation.result ||
      operation.abortSignal.aborted
    ) {
      return;
    }
    getSessionControllerEntryForOperation(operation).sourceTurnId = sourceTurnId;
  },
  getSourceTurnId(sessionKey) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey) {
      return undefined;
    }
    return findSessionControllerEntry(normalizedSessionKey)?.sourceTurnId;
  },
  resolveCurrentMessageInjectionTarget(sessionKey) {
    return captureReplyMessageInjectionTarget(this.get(sessionKey));
  },
  resolveCurrentInterruptTarget(sessionKey) {
    const operation = this.get(sessionKey);
    return operation ? { [replyRunInterruptTargetOperation]: operation } : undefined;
  },
  abort(sessionKey) {
    const operation = this.get(sessionKey);
    if (!operation) {
      return false;
    }
    return operation.abortByUser();
  },
  waitForIdle(sessionKey, timeoutMs, opts) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey || !getSessionControllerOperation(normalizedSessionKey)) {
      return Promise.resolve(true);
    }
    if (opts?.signal?.aborted) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const owner = findSessionControllerEntry(normalizedSessionKey);
      if (!owner) {
        resolve(true);
        return;
      }
      const waiters = owner.waiters;
      let abortHandler: (() => void) | undefined;
      let settled = false;
      const waiter: ReplyRunWaiter = {
        finish: (ended) => {
          if (settled) {
            return;
          }
          settled = true;
          waiters.delete(waiter);
          pruneSessionControllerEntry(owner);
          if (waiter.timer) {
            clearTimeout(waiter.timer);
          }
          if (abortHandler) {
            opts?.signal?.removeEventListener("abort", abortHandler);
          }
          resolve(ended);
        },
      };
      if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
        waiter.timer = setTimeout(
          () => waiter.finish(false),
          resolveTimerTimeoutMs(timeoutMs, 100, 100),
        );
      }
      if (opts?.signal) {
        abortHandler = () => waiter.finish(false);
        opts.signal.addEventListener("abort", abortHandler, { once: true });
      }
      waiters.add(waiter);
      if (!getSessionControllerOperation(normalizedSessionKey)) {
        waiter.finish(true);
      }
    });
  },
  resolveSessionId(sessionKey) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey) {
      return undefined;
    }
    return getSessionControllerOperation(normalizedSessionKey)?.sessionId;
  },
};

/** Abort the captured operation; null skips settlement for source acknowledgements. */
export async function interruptReplyRunTarget(
  target: ReplyRunInterruptTarget,
  timeoutMs: number | null = REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
): Promise<{ aborted: boolean; settled: boolean }> {
  const operation = target[replyRunInterruptTargetOperation];
  const aborted = operation.abortByUser();
  const settled =
    timeoutMs === null ? false : await waitForReplyOperationOwnerSettlement(operation, timeoutMs);
  return { aborted, settled };
}

export function resolveActiveReplyRunSessionId(sessionKey: string): string | undefined {
  return replyRunRegistry.resolveSessionId(sessionKey);
}

/** Cancels the current reply backend only when its native run identity matches exactly. */
export function supersedeReplyRunByRunId(runId: string, beforeCancel: () => void): boolean {
  const expectedRunId = normalizeOptionalString(runId);
  if (!expectedRunId) {
    return false;
  }
  for (const operation of activeSessionOperations()) {
    const backend = getAttachedBackend(operation);
    if (normalizeOptionalString(backend?.runId) !== expectedRunId) {
      continue;
    }
    return operation.supersede(beforeCancel);
  }
  return false;
}

export function resolveActiveReplyRunThreadId(sessionKey: string): string | number | undefined {
  return replyRunRegistry.get(sessionKey)?.routeThreadId;
}

export function isReplyRunActiveForSessionId(sessionId: string): boolean {
  return resolveReplyRunForCurrentSessionId(sessionId) !== undefined;
}

export function abortReplyRunBySessionId(sessionId: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  if (!operation) {
    return false;
  }
  return operation.abortByUser();
}

export function resolveActiveReplyOperationForSessionId(
  sessionId: string,
): ReplyOperation | undefined {
  return resolveReplyRunForCurrentSessionId(sessionId);
}

export function clearReplyRunForResetBySessionId(sessionId: string): void {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  if (!operation || isReplyOperationPreBackendPhase(operation.phase)) {
    return;
  }
  // Reset requests cancellation; only the captured producer can certify its return.
  operation.abortForRestart();
}

export function waitForReplyRunEndBySessionId(
  sessionId: string,
  timeoutMs?: number | null,
): Promise<boolean> {
  const waitKey = resolveReplyRunWaitKey(sessionId);
  if (!waitKey) {
    return Promise.resolve(true);
  }
  return replyRunRegistry.waitForIdle(waitKey, timeoutMs);
}

async function waitForReplyRunAdmissionBarrier(params: {
  barrierKind: "followupBarrier" | "successorBarrier";
  minimumTimeoutMs: number;
  sessionKey: string;
  signal?: AbortSignal;
  timeoutMs?: number | null;
}): Promise<ReplyRunAdmissionSettlement> {
  const deadline =
    typeof params.timeoutMs === "number"
      ? Date.now() +
        resolveTimerTimeoutMs(params.timeoutMs, params.minimumTimeoutMs, params.minimumTimeoutMs)
      : undefined;
  const sources = new Map<ReplyRunAdmissionSource["databaseIdentity"], ReplyRunAdmissionSource>();
  while (true) {
    if (params.signal?.aborted) {
      return { settled: false };
    }
    const barrier = getSessionControllerEntry(params.sessionKey)[params.barrierKind];
    if (!barrier) {
      return { settled: true, ...(sources.size ? { sources: [...sources.values()] } : {}) };
    }
    const remainingMs = deadline === undefined ? undefined : deadline - Date.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      return { settled: false };
    }
    let timer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    const outcome = await Promise.race([
      barrier.settled.then(() => true),
      ...(remainingMs !== undefined
        ? [
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), Math.max(1, remainingMs));
              timer.unref?.();
            }),
          ]
        : []),
      ...(params.signal
        ? [
            new Promise<boolean>((resolve) => {
              abortHandler = () => resolve(false);
              params.signal?.addEventListener("abort", abortHandler, { once: true });
              if (params.signal?.aborted) {
                abortHandler();
              }
            }),
          ]
        : []),
    ]);
    if (timer) {
      clearTimeout(timer);
    }
    if (abortHandler) {
      params.signal?.removeEventListener("abort", abortHandler);
    }
    if (!outcome) {
      return { settled: false };
    }
    for (const [identity, source] of barrier.sources) {
      sources.set(
        identity,
        mergeReplyRunAdmissionSource(
          { ...source, sessionIds: new Set(source.sessionIds) },
          sources.get(identity),
        ),
      );
    }
  }
}

export async function waitForReplyRunFollowupAdmission(
  sessionKey: string,
  timeoutMs: number,
  opts?: { signal?: AbortSignal },
): Promise<ReplyRunAdmissionSettlement> {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  return normalizedSessionKey
    ? await waitForReplyRunAdmissionBarrier({
        barrierKind: "followupBarrier",
        minimumTimeoutMs: 100,
        sessionKey: normalizedSessionKey,
        signal: opts?.signal,
        timeoutMs,
      })
    : { settled: true };
}

export async function waitForReplyRunSuccessorAdmission(
  sessionKey: string,
  timeoutMs?: number | null,
  opts?: { signal?: AbortSignal },
): Promise<ReplyRunAdmissionSettlement> {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  return normalizedSessionKey
    ? await waitForReplyRunAdmissionBarrier({
        barrierKind: "successorBarrier",
        minimumTimeoutMs: 0,
        sessionKey: normalizedSessionKey,
        signal: opts?.signal,
        timeoutMs,
      })
    : { settled: true };
}

export function abortActiveReplyRuns(opts: {
  mode: "all" | "compacting";
  onAbortError?: (sessionId: string, error: unknown) => void;
}): boolean {
  const capture = captureSessionControllerStop({
    operations: [...activeSessionOperations()].filter(
      (operation) => opts.mode === "all" || isReplyRunCompacting(operation),
    ),
  });
  return (
    stopSessionController(capture, {
      source: "restart",
      onError: (target, error) => {
        if ("sessionId" in target) {
          opts.onAbortError?.(target.sessionId, error);
        }
        return "continue";
      },
    }).activeCancelled > 0
  );
}

export function listActiveReplyRunSessionKeys(): string[] {
  return [...activeSessionOperations()].map((operation) => operation.key);
}

function evictPriorLifecycleReplyRuns(): void {
  const errors: unknown[] = [];
  // Capture owners before cleanup can mutate the registry or publish a successor.
  const capturedOwners = Array.from(activeSessionOperations());
  for (const operation of capturedOwners) {
    if (
      operation.lifecycleGeneration &&
      isAgentEventLifecycleGenerationCurrent(operation.lifecycleGeneration)
    ) {
      continue;
    }
    try {
      evictReplyOperationByOperation.get(operation)?.();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "Failed to abort stale reply runs");
  }
}

registerAgentEventLifecycleRotationHandler("reply-runs", evictPriorLifecycleReplyRuns);

const replyRunRegistryTestApi = {
  resetReplyRunRegistry(): void {
    for (const operation of activeSessionOperations()) {
      markDiagnosticRunProgress({
        sessionKey: operation.key,
        sessionId: operation.sessionId,
        reason: "reply_operation:registry_reset",
      });
    }
    for (const entry of sessionControllers.values()) {
      entry.active?.watchdog.close();
      for (const operation of entry.lifecycle?.operations ?? []) {
        operation.watchdog.close();
      }
    }
    for (const entry of sessionControllers.values()) {
      for (const waiter of entry.waiters) {
        waiter.finish(false);
      }
    }
    sessionControllers.clear();
  },
};

if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
  Object.assign(globalThis, {
    [Symbol.for("openclaw.replyRunRegistryTestApi")]: replyRunRegistryTestApi,
  });
}

import { isAgentEventLifecycleGenerationCurrent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hasGatewayContextOwner } from "../plugins/runtime/gateway-request-scope.js";
import { sessionControllerMailboxes } from "../sessions/session-controller.mailbox.js";
import {
  getRpcSourceProjectSessionActive,
  isRpcSourceQueued,
  type RpcSourceIndex,
  type RpcSourceRef,
} from "../sessions/session-controller.rpc-sources.js";
import { activeSessionOperations } from "../sessions/session-controller.state.js";
import { captureSessionControllerStop, stopSession } from "../sessions/session-controller.stop.js";
import {
  abortChatRunById,
  captureChatRunAbortPresentation,
  type RestartRecoveryCandidate,
} from "./chat-abort.js";
import type { ChatRunEntry, ChatRunState } from "./server-chat-state.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { createGatewayShutdownTimeout, recordGatewayShutdownWarning } from "./server-shutdown.js";

const shutdownLog = createSubsystemLogger("gateway/shutdown");
const RESTART_REPLY_DRAIN_POLL_MS = 100;
const RESTART_TERMINAL_PERSISTENCE_WAIT_TIMEOUT_MS = 1_000;
const RESTART_MARKER_SLOW_WARNING_MS = 1_000;

function getRestartReplyDrainCounts(params: {
  getPendingReplyCount: () => number;
  rpcSources: RpcSourceIndex;
}) {
  const pendingReplyCount = params.getPendingReplyCount();
  const activeRuns = listRestartDrainRuns(params.rpcSources).length;
  const queuedTurns = Array.from(params.rpcSources.values()).filter(isRpcSourceQueued).length;
  return {
    pendingReplies:
      Number.isFinite(pendingReplyCount) && pendingReplyCount > 0
        ? Math.floor(pendingReplyCount)
        : 0,
    activeRuns,
    queuedTurns,
  };
}

function listUnabortedRuns(rpcSources: RpcSourceIndex): Array<[string, RpcSourceRef]> {
  return Array.from(rpcSources.entries()).filter(([, entry]) => !entry.input.abortSignal.aborted);
}

function listRestartDrainRuns(rpcSources: RpcSourceIndex): Array<[string, RpcSourceRef]> {
  return listUnabortedRuns(rpcSources).filter(
    ([, entry]) => entry.input.phase !== "consumed" && !isRpcSourceQueued(entry),
  );
}

function listRestartRecoveryRuns(rpcSources: RpcSourceIndex): Array<[string, RpcSourceRef]> {
  return listUnabortedRuns(rpcSources).filter(
    ([, entry]) =>
      ((entry.input.phase !== "consumed" && !isRpcSourceQueued(entry)) ||
        entry.adapter.projectSessionTerminalPending === true ||
        entry.adapter.projectSessionTerminalPersistence !== undefined) &&
      entry.adapter.controlUiVisible !== false &&
      ((entry.input.claim && !entry.input.claim.released) ||
        entry.adapter.projectSessionTerminalPersisted !== true),
  );
}

function formatRestartReplyDrainDetails(counts: {
  pendingReplies: number;
  activeRuns: number;
  queuedTurns: number;
}): string {
  const details: string[] = [];
  if (counts.pendingReplies > 0) {
    details.push(`${counts.pendingReplies} pending reply(ies)`);
  }
  if (counts.activeRuns > 0) {
    details.push(`${counts.activeRuns} active run(s)`);
  }
  if (counts.queuedTurns > 0) {
    details.push(`${counts.queuedTurns} queued turn(s)`);
  }
  return details.length > 0 ? details.join(", ") : "no pending reply work";
}

async function sleepForRestartReplyDrain(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

export type GatewayRunShutdownParams = {
  resolveGatewayContext: GatewayContextResolver;
  rpcSources: RpcSourceIndex;
  restartRecoveryCandidates?: Map<string, RestartRecoveryCandidate>;
  chatRunState: ChatRunState;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  agentRunSeq: Map<string, number>;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  markMainSessionsAbortedForRestart?: (params: {
    resolveGatewayContext: GatewayContextResolver;
    activeRuns: RestartRecoveryCandidate[];
    reason: string;
    isActiveRun: (run: RestartRecoveryCandidate) => boolean;
  }) => Promise<void> | void;
  resolveActiveSessionIdForKey?: (sessionKey: string) => string | undefined;
};

async function waitForRestartReplyDrain(params: {
  getPendingReplyCount: () => number;
  rpcSources: RpcSourceIndex;
  timeoutMs: number;
}): Promise<{
  drained: boolean;
  elapsedMs: number;
  counts: { pendingReplies: number; activeRuns: number; queuedTurns: number };
}> {
  const timeoutMs = Math.max(0, Math.floor(params.timeoutMs));
  let counts = getRestartReplyDrainCounts(params);
  if (counts.pendingReplies <= 0 && counts.activeRuns <= 0 && counts.queuedTurns <= 0) {
    return { drained: true, elapsedMs: 0, counts };
  }
  if (timeoutMs <= 0) {
    return { drained: false, elapsedMs: 0, counts };
  }

  const startedAt = Date.now();
  for (;;) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      return { drained: false, elapsedMs, counts };
    }
    await sleepForRestartReplyDrain(Math.min(RESTART_REPLY_DRAIN_POLL_MS, timeoutMs - elapsedMs));
    counts = getRestartReplyDrainCounts(params);
    if (counts.pendingReplies <= 0 && counts.activeRuns <= 0 && counts.queuedTurns <= 0) {
      return { drained: true, elapsedMs: Date.now() - startedAt, counts };
    }
  }
}

function collectActiveRestartSessionRefs(
  params: Pick<
    GatewayRunShutdownParams,
    "rpcSources" | "resolveActiveSessionIdForKey" | "restartRecoveryCandidates"
  >,
): RestartRecoveryCandidate[] {
  const activeRuns = new Map<string, RestartRecoveryCandidate>();
  const observedAt = Date.now();
  const addRun = (run: RestartRecoveryCandidate) => {
    activeRuns.set(`${run.runId}\u0000${run.lifecycleGeneration}`, {
      ...run,
      observedAt: run.observedAt ?? observedAt,
    });
  };
  for (const [runId, entry] of listRestartRecoveryRuns(params.rpcSources)) {
    const sessionKey = entry.adapter.sessionKey;
    // Registration metadata can predate a reset or compaction session-id rotation.
    const sessionId = entry.input.claim?.operation?.sessionId ?? entry.adapter.sessionId;
    if (runId && entry.adapter.lifecycleGeneration && sessionKey && sessionId) {
      addRun({
        runId,
        lifecycleGeneration: entry.adapter.lifecycleGeneration,
        sessionKey,
        sessionId,
        observedAt: entry.adapter.projectSessionTerminalObservedAt,
      });
    }
  }
  for (const candidate of params.restartRecoveryCandidates?.values() ?? []) {
    addRun(candidate);
  }
  return [...activeRuns.values()];
}

async function settleTerminalSessionPersistenceForRestart(
  rpcSources: RpcSourceIndex,
): Promise<void> {
  const pending = listUnabortedRuns(rpcSources).flatMap(([, entry]) => {
    const persistence = entry.adapter.projectSessionTerminalPersistence;
    if (getRpcSourceProjectSessionActive(entry) !== false || !persistence) {
      return [];
    }
    return [{ entry, persistence }];
  });
  if (pending.length === 0) {
    return;
  }
  const timeout = createGatewayShutdownTimeout(
    RESTART_TERMINAL_PERSISTENCE_WAIT_TIMEOUT_MS,
    () => null,
  );
  const results = await Promise.race([
    Promise.allSettled(pending.map(({ persistence }) => persistence)),
    timeout.promise,
  ]);
  timeout.clear();
  if (!results) {
    shutdownLog.warn(
      `terminal session persistence did not settle within ${RESTART_TERMINAL_PERSISTENCE_WAIT_TIMEOUT_MS}ms; preserving restart recovery`,
    );
    return;
  }
  for (const [index, result] of results.entries()) {
    const tracked = pending[index];
    if (
      !tracked ||
      tracked.entry.adapter.projectSessionTerminalPersistence !== tracked.persistence
    ) {
      continue;
    }
    tracked.entry.adapter.projectSessionTerminalPending = false;
    tracked.entry.adapter.projectSessionTerminalPersistence = undefined;
    if (result.status === "fulfilled") {
      tracked.entry.adapter.projectSessionTerminalPersisted = true;
    }
  }
}

async function markActiveRunsForRestartRecovery(
  params: GatewayRunShutdownParams & {
    reason: string;
    warnings: string[];
    capturedSources: RpcSourceIndex;
    capturedRecoveryCandidates: Map<string, RestartRecoveryCandidate>;
  },
): Promise<void> {
  if (!params.markMainSessionsAbortedForRestart) {
    return;
  }
  const activeEntries = params.capturedSources;
  const recoveryCandidates = params.capturedRecoveryCandidates;
  const activeRuns = collectActiveRestartSessionRefs({
    ...params,
    rpcSources: activeEntries,
    restartRecoveryCandidates: recoveryCandidates,
  });
  await settleTerminalSessionPersistenceForRestart(activeEntries);
  try {
    const markerTimeout = createGatewayShutdownTimeout(
      RESTART_MARKER_SLOW_WARNING_MS,
      () => "timeout" as const,
    );
    const markerOutcome = Promise.resolve(
      params.markMainSessionsAbortedForRestart({
        resolveGatewayContext: params.resolveGatewayContext,
        activeRuns,
        reason: params.reason,
        isActiveRun: (run) => {
          const entry = params.rpcSources.get(run.runId);
          const candidate = params.restartRecoveryCandidates?.get(run.runId);
          return (
            (entry &&
              entry === activeEntries.get(run.runId) &&
              !entry.input.abortSignal.aborted &&
              ((entry.input.claim && !entry.input.claim.released) ||
                entry.adapter.projectSessionTerminalPersisted !== true) &&
              entry.adapter.lifecycleGeneration === run.lifecycleGeneration) ||
            (candidate !== undefined &&
              candidate === recoveryCandidates.get(run.runId) &&
              candidate.lifecycleGeneration === run.lifecycleGeneration)
          );
        },
      }),
    ).then(
      () => ({ status: "completed" as const }),
      (error: unknown) => ({ status: "failed" as const, error }),
    );
    const firstOutcome = await Promise.race([markerOutcome, markerTimeout.promise]);
    markerTimeout.clear();
    if (firstOutcome === "timeout") {
      shutdownLog.warn(
        `restart session marker did not settle within ${RESTART_MARKER_SLOW_WARNING_MS}ms; waiting before shutdown`,
      );
      recordGatewayShutdownWarning(params.warnings, "restart-main-session-marker");
      const delayedOutcome = await markerOutcome;
      if (delayedOutcome.status === "failed") {
        throw delayedOutcome.error;
      }
    } else if (firstOutcome.status === "failed") {
      throw firstOutcome.error;
    }
    for (const run of activeRuns) {
      if (params.restartRecoveryCandidates?.get(run.runId) === recoveryCandidates.get(run.runId)) {
        params.restartRecoveryCandidates?.delete(run.runId);
      }
    }
  } catch (err) {
    shutdownLog.warn(`failed to mark active main session(s) for restart recovery: ${String(err)}`);
    recordGatewayShutdownWarning(params.warnings, "restart-main-session-marker");
  }
}

/** Completes grace and requests cancellation before execution joining begins. */
export async function prepareGatewayRunShutdown(
  params: {
    restart: boolean;
    getPendingReplyCount: () => number;
    timeoutMs: number;
    warnings: string[];
  } & GatewayRunShutdownParams,
): Promise<void> {
  let drainResult: Awaited<ReturnType<typeof waitForRestartReplyDrain>> | undefined;
  if (params.restart) {
    const initialCounts = getRestartReplyDrainCounts(params);
    if (
      initialCounts.pendingReplies > 0 ||
      initialCounts.activeRuns > 0 ||
      initialCounts.queuedTurns > 0
    ) {
      const timeoutMs = Math.max(0, Math.floor(params.timeoutMs));
      if (timeoutMs > 0) {
        shutdownLog.info(
          `waiting for ${formatRestartReplyDrainDetails(initialCounts)} before restart shutdown (timeout ${timeoutMs}ms)`,
        );
      }
      drainResult = await waitForRestartReplyDrain({
        getPendingReplyCount: params.getPendingReplyCount,
        rpcSources: params.rpcSources,
        timeoutMs,
      });
      if (!drainResult.drained) {
        shutdownLog.warn(
          `restart reply drain timed out after ${drainResult.elapsedMs}ms with ${formatRestartReplyDrainDetails(drainResult.counts)} still active; continuing shutdown`,
        );
        recordGatewayShutdownWarning(params.warnings, "restart-reply-drain");
      }
    }
  }
  // Preparation accepted during grace belongs to this cancellation boundary.
  const capturedSources = new Map(params.rpcSources);
  const capturedRecoveryCandidates = new Map(params.restartRecoveryCandidates);
  const sourceByInput = new Map(
    [...capturedSources].map(([runId, entry]) => [
      entry.input,
      { runId, entry, presentation: captureChatRunAbortPresentation(params, runId) },
    ]),
  );
  const capture = captureSessionControllerStop({
    inputs: [
      ...sourceByInput.keys(),
      ...[...sessionControllerMailboxes()].flatMap((mailbox) =>
        mailbox.entries.filter((input) =>
          hasGatewayContextOwner(input, params.resolveGatewayContext),
        ),
      ),
    ],
    operations: [...activeSessionOperations()].filter((operation) =>
      hasGatewayContextOwner(operation, params.resolveGatewayContext),
    ),
  });
  const cancelCaptured = (selection = capture) =>
    stopSession({
      capture: selection,
      source: params.restart ? "restart" : "operator-revocation",
      onError: (_target, error) => {
        shutdownLog.warn(`failed to cancel captured source during shutdown: ${String(error)}`);
        recordGatewayShutdownWarning(params.warnings, "restart-reply-abort");
        return "continue";
      },
      cancelInput: (input, cancel) => {
        const target = sourceByInput.get(input);
        if (!target) {
          return hasGatewayContextOwner(input, params.resolveGatewayContext) ? cancel() : false;
        }
        if (
          params.rpcSources.get(target.runId) !== target.entry ||
          (target.entry.adapter.lifecycleGeneration &&
            !isAgentEventLifecycleGenerationCurrent(target.entry.adapter.lifecycleGeneration))
        ) {
          return false;
        }
        return abortChatRunById(params, {
          runId: target.runId,
          sessionKey: target.entry.adapter.sessionKey,
          expectedEntry: target.entry,
          presentation: target.presentation,
          preserveTerminal: getRpcSourceProjectSessionActive(target.entry) === false,
          cancel,
          stopReason: params.restart ? "restart" : "rpc",
        }).aborted;
      },
      cancelOperation: (operation, cancel) =>
        operation.lifecycleGeneration !== undefined &&
        isAgentEventLifecycleGenerationCurrent(operation.lifecycleGeneration) &&
        hasGatewayContextOwner(operation, params.resolveGatewayContext)
          ? cancel()
          : false,
    });
  // Ordinary CLI stop already spent its grace period. Cancel only this Gateway's
  // remaining owners before joining them, without scheduling restart recovery.
  if (!params.restart) {
    cancelCaptured();
    return;
  }
  // Freeze both subsets before queue abort listeners or recovery writes can change claims.
  const queuedCapture = captureSessionControllerStop({ inputs: capture.queuedInputs });
  const activeCapture = captureSessionControllerStop({
    inputs: capture.activeInputs,
    operations: capture.operations,
  });
  const abortedQueuedTurns = cancelCaptured(queuedCapture).queuedCancelled;
  if (drainResult?.drained === false && abortedQueuedTurns > 0) {
    shutdownLog.warn(`aborted ${abortedQueuedTurns} queued turn(s) during restart shutdown`);
  }
  await markActiveRunsForRestartRecovery({
    ...params,
    capturedSources,
    capturedRecoveryCandidates,
    reason: "gateway restart shutdown",
  });
  const abortedRuns = cancelCaptured(activeCapture).activeCancelled;
  if (drainResult?.drained) {
    shutdownLog.info(`restart reply drain completed after ${drainResult.elapsedMs}ms`);
  } else if (drainResult && abortedRuns > 0) {
    shutdownLog.warn(`aborted ${abortedRuns} active run(s) during restart shutdown`);
  }
}

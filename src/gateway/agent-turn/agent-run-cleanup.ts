import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { repairMainSessionRecoveryMutation } from "../../agents/main-session-recovery/main-session-recovery-lifecycle.js";
import { scheduleMainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-owner-release.js";
import type { MainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import type { PreparedModelRuntimeLease } from "../../agents/prepared-model-runtime.js";
import { isSessionPendingInputSettlementUnknown } from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import { discardPreparedInboundMedia } from "../chat-attachments.js";
import type { retainGatewayOperatorRun } from "../operator-run-cancellation.js";
import { emitSessionsChanged } from "../server-methods/session-change-event.js";
import { formatForLog } from "../ws-log.js";
import type { PreparedAgentRunDispatch } from "./agent-run-admission-types.js";
import {
  settleUnstartedGatewayAgentTask,
  type RegisteredGatewayAgentTask,
} from "./agent-run-task-tracking.js";
import {
  releasePreparedAgentRunUserTurn,
  type PreparedAgentRunUserTurn,
} from "./agent-run-user-turn.js";
import type { AgentTurnContext } from "./types.js";

export function createAgentRunOwnerCleanup(
  cleanupAbortController: () => void | Promise<void>,
  releaseContext: () => void,
) {
  let runOwnerCleanup: Promise<void> | undefined;
  let runOwnerCleanupStarted = false;
  let runOwnerCleanupFailure: { error: unknown } | undefined;
  const cleanup = () => {
    if (runOwnerCleanupFailure) {
      throw runOwnerCleanupFailure.error;
    }
    if (runOwnerCleanupStarted) {
      return runOwnerCleanup;
    }
    runOwnerCleanupStarted = true;
    const finish = () => {
      releaseContext();
    };
    try {
      const joined = cleanupAbortController();
      if (joined) {
        runOwnerCleanup = joined.then(finish);
        void runOwnerCleanup.catch(() => {});
        return runOwnerCleanup;
      }
      finish();
      return undefined;
    } catch (error) {
      runOwnerCleanupFailure = { error };
      throw error;
    }
  };
  // Starting cleanup seals new terminal handoffs even while the original release is pending.
  return { cleanup, isStarted: () => runOwnerCleanupStarted };
}

export function createAgentRunPreacceptCleanup(params: {
  context: AgentTurnContext;
  runId: string;
  activeRunAbort: PreparedAgentRunDispatch["activeRunAbort"];
  activeGatewayWorkAdmission: PreparedAgentRunDispatch["activeGatewayWorkAdmission"];
  parentResume: boolean;
}) {
  const { activeRunAbort, activeGatewayWorkAdmission, parentResume } = params;
  const state: {
    preparedModelRuntimeLease?: PreparedModelRuntimeLease;
    capturedOperator?: Awaited<ReturnType<typeof retainGatewayOperatorRun>>;
    registeredFollowupTask?: RegisteredGatewayAgentTask;
    retainedInput?: PreparedAgentRunUserTurn;
    restoreAdmittedRestartRecoveryInterrupted?: () => Promise<
      MainSessionRecoveryPendingTarget | undefined
    >;
  } = {};
  const cleanupPreaccept = async (admissionReleased = false, failure?: string) => {
    if (state.retainedInput) {
      try {
        await releasePreparedAgentRunUserTurn(
          state.retainedInput,
          parentResume ? "cancelled" : "interrupted",
        );
      } catch (error) {
        if (isSessionPendingInputSettlementUnknown(error)) {
          throw error;
        }
        params.context.logGateway.warn(
          `failed to settle pending agent input: ${formatForLog(error)}`,
        );
      }
    }
    const lease = state.preparedModelRuntimeLease;
    state.preparedModelRuntimeLease = undefined;
    const task = state.registeredFollowupTask;
    state.registeredFollowupTask = undefined;
    let pendingRecovery: MainSessionRecoveryPendingTarget | undefined;
    try {
      if (task) {
        await settleUnstartedGatewayAgentTask({
          tracking: task,
          runId: params.runId,
          admittedRunEntry: activeRunAbort.entry,
          context: params.context,
          outcome: buildAgentRunTerminalOutcome({
            status: activeRunAbort.controller.signal.aborted ? "timeout" : "error",
            stopReason: activeRunAbort.controller.signal.aborted
              ? (activeRunAbort.entry?.abortStopReason ?? "rpc")
              : undefined,
            error: failure ?? "Follow-up admission ended before acceptance.",
          }),
        });
      }
    } finally {
      try {
        if (state.restoreAdmittedRestartRecoveryInterrupted) {
          pendingRecovery = await repairMainSessionRecoveryMutation({
            mutation: state.restoreAdmittedRestartRecoveryInterrupted,
            onDeferredSuccess: scheduleMainSessionRecoveryPendingTarget,
            onError: (error) =>
              params.context.logGateway.warn(
                `failed to restore unaccepted restart recovery: ${formatForLog(error)}`,
              ),
          });
        }
      } finally {
        try {
          await lease?.[Symbol.asyncDispose]();
        } finally {
          try {
            state.capturedOperator?.release();
            activeRunAbort.cleanup();
            if (!admissionReleased) {
              activeGatewayWorkAdmission.release();
            }
          } finally {
            scheduleMainSessionRecoveryPendingTarget(pendingRecovery);
          }
        }
      }
    }
  };
  return { state, cleanupPreaccept };
}

export function createAgentRunExecutionCleanup(params: {
  prepared: PreparedAgentRunDispatch;
  context: AgentTurnContext;
  resolvedSessionKey?: string;
  activeSessionAgentId: string;
  onInputSettlementError: (error: unknown) => void;
}) {
  const { prepared } = params;
  const state: {
    leaseActive: boolean;
    unpersistedOffloadedRefs: PreparedAgentRunDispatch["unpersistedOffloadedRefs"];
    inputSettlementUnknown: boolean;
    mediaCleanup?: Promise<void>;
  } = {
    leaseActive: true,
    unpersistedOffloadedRefs: prepared.unpersistedOffloadedRefs,
    inputSettlementUnknown: false,
  };
  let cleanupStarted = false;
  let cleanupSettlement: Promise<void> | undefined;
  let cleanupFailure: { error: unknown } | undefined;
  const cleanupAdmittedRun = (): void | Promise<void> => {
    if (cleanupFailure) {
      throw cleanupFailure.error;
    }
    if (cleanupStarted) {
      return cleanupSettlement;
    }
    cleanupStarted = true;
    const refsToDiscard = state.unpersistedOffloadedRefs;
    const release = () => {
      try {
        state.unpersistedOffloadedRefs = [];
        prepared.activeRunAbort.cleanup();
        prepared.activeGatewayWorkAdmission.release();
        state.leaseActive = false;
        state.mediaCleanup ??= discardPreparedInboundMedia(
          refsToDiscard,
          params.context.logGateway,
        );
        if (prepared.userTurn.recorder && params.resolvedSessionKey) {
          emitSessionsChanged(
            params.context,
            {
              sessionKey: params.resolvedSessionKey,
              agentId: params.activeSessionAgentId,
              reason: "agent.input.settled",
            },
            { accessChanged: false },
          );
        }
      } catch (error) {
        cleanupFailure = { error };
        throw error;
      }
    };
    const failed = (error: unknown) => {
      if (isSessionPendingInputSettlementUnknown(error)) {
        state.inputSettlementUnknown = true;
        cleanupFailure = { error };
        throw error;
      }
      params.onInputSettlementError(error);
      release();
    };
    let joined: void | Promise<void>;
    try {
      const stopReason = prepared.activeRunAbort.entry?.abortStopReason;
      const outcome = buildAgentRunTerminalOutcome({ status: "error", stopReason });
      const cancelled =
        prepared.activeRunAbort.controller.signal.aborted &&
        stopReason !== "restart" &&
        (!prepared.userTurn.privateCompletion || outcome.reason === "cancelled");
      joined = releasePreparedAgentRunUserTurn(
        prepared.userTurn,
        cancelled ? "cancelled" : "interrupted",
      );
    } catch (error) {
      return failed(error);
    }
    if (joined) {
      cleanupSettlement = joined.then(release, failed);
      void cleanupSettlement.catch(() => {});
      return cleanupSettlement;
    }
    release();
  };
  return { state, cleanupAdmittedRun };
}

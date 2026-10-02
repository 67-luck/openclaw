import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { killSubagentRunAdmin } from "../../agents/subagents/registry/subagent-control-kill.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../../agents/subagents/registry/subagent-control.types.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  isSubagentRunQueued,
} from "../../agents/subagents/registry/subagent-registry-read.js";
import type { SessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { captureSessionControllerSourceSettlement } from "../../sessions/session-controller.mailbox.js";
import {
  getRpcSource,
  getRpcSourceIdentity,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import {
  captureSessionControllerStop,
  stopSession,
  type SessionStopRequest,
  type SessionStopHookContext,
  type SessionStopExecution,
  type SessionStopSource,
} from "../../sessions/session-controller.stop.js";
import {
  waitForChatAbortAcknowledgment,
  waitForChatAbortTerminalPersistence,
} from "../chat-abort-lifecycle-internal.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import {
  abortChatRunById,
  captureChatRunAbortPresentation,
  type ChatAbortOps,
} from "../chat-abort.js";
import { errorShapeFromError } from "../error-shape.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import {
  captureWorkerInferenceCancellation,
  type WorkerInferenceCancellation,
} from "../worker-environments/inference-control-internal.js";
import {
  resolveAuthorizedRunsForSessionKeys,
  resolveAuthorizedQueuedTurnsForSession,
  type ChatAbortRequester,
} from "./chat-abort-authorization.js";
import { abortControlledSubagents } from "./chat-abort-descendants.js";
import {
  abortedPartialPersistenceError,
  captureAbortedPartial,
  deferAbortedPartialPersistence,
  withQueuedCollectorWarning,
  type QueuedCollectorAbortOutcome,
  type ChatAbortOrigin,
  type ChatAbortSessionSnapshot,
} from "./chat-aborted-partial.js";
import { persistAbortedPartials } from "./chat-transcript-persistence.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestContext } from "./types.js";

export { abortControlledSubagents, descendantAbortError } from "./chat-abort-descendants.js";

/** Stops an unstarted collector through its scheduler owner before controller cancellation. */
export function abortQueuedCollectorSession(
  params: Omit<ChatSessionAbortParams, "ops"> & { runId?: string },
): Promise<QueuedCollectorAbortOutcome> | undefined {
  const entry = getLatestLiveSubagentRunByChildSessionKey(params.sessionKey);
  if (!entry || !isSubagentRunQueued(entry) || (params.runId && entry.runId !== params.runId)) {
    return undefined;
  }
  return (async () => {
    let plan: ReturnType<typeof prepareChatSessionAbort> | undefined;
    let blocked: ErrorShape | undefined;
    let outcome: QueuedCollectorAbortOutcome = {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "Queued collector cancellation was not published."),
    };
    try {
      params.assertCurrent?.();
      const projection = getSessionRowProjection(params.context);
      if (projection) {
        do {
          await projection.ensureMaterialized();
        } while (projection.needsMaterialization);
      }
      const captured = params.agentId
        ? projection?.capture({ agentId: params.agentId, key: params.sessionKey })
        : undefined;
      await killSubagentRunAdmin(
        {
          cfg: params.session?.ok
            ? params.session.value.cfg
            : (params.context.getRuntimeConfig() ?? {}),
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          expectedRunId: entry.runId,
          expectedGeneration: entry.generation,
          expectedOwnerKey: entry.requesterSessionKey,
          onResult: (result) => {
            if (blocked) {
              outcome = { ok: false, error: blocked };
              return;
            }
            if (result.found && result.error) {
              outcome = { ok: false, error: errorShape(ErrorCodes.UNAVAILABLE, result.error) };
              return;
            }
            if (plan && !plan.canCascade) {
              outcome = {
                ok: false,
                error: errorShape(ErrorCodes.UNAVAILABLE, "Queued collector was not stopped."),
              };
              return;
            }
            const collectorAborted = Boolean(
              result.found &&
              result.killed &&
              result.targetState?.state === "terminal" &&
              result.targetState.task.status === "cancelled" &&
              result.targetState.task.error === SUBAGENT_KILL_TASK_ERROR,
            );
            if (collectorAborted) {
              emitSessionsChanged(
                params.context,
                {
                  sessionKey: params.sessionKey,
                  agentId: params.agentId,
                  sessionId: params.sessionId,
                  reason: "abort",
                },
                { preparedPublication: true },
              );
            }
            outcome = {
              ok: true,
              value: {
                aborted: collectorAborted || plan?.result.aborted === true,
                runIds: [
                  ...new Set([
                    ...(collectorAborted ? [entry.runId] : []),
                    ...(plan?.result.runIds ?? []),
                  ]),
                ],
              },
            };
          },
        },
        {
          assertCurrent: () => params.assertCurrent?.(),
          requiredSessionId: params.requiredSessionId,
          preparePublication: {
            needsPreparation: () => projection?.needsMaterialization === true,
            prepare: async () => {
              await projection?.ensureMaterialized();
              if (captured && !projection?.isCurrent(captured)) {
                throw new Error(
                  "Queued collector session changed before cancellation publication.",
                );
              }
            },
          },
          beforeSessionKill: () => {
            plan = prepareChatSessionAbort(
              {
                ...params,
                ops: createChatAbortOps(params.context),
                cascadeDescendants: true,
                includeProtectedRuns: params.runId ? true : params.includeProtectedRuns,
              },
              captureWorkerInferenceForSession({
                context: params.context,
                sessionId: params.sessionId,
              }),
              entry.runId,
            );
            if (params.runId && plan.hasOtherWork) {
              blocked = errorShape(
                ErrorCodes.UNAVAILABLE,
                "Other work is active in this child session; use a full-session Stop.",
              );
              return false;
            }
            plan.abort();
            return plan.canCascade;
          },
        },
      );
    } catch (error) {
      outcome = { ok: false, error: errorShapeFromError(ErrorCodes.INVALID_REQUEST, error) };
    }
    if (plan) {
      const warning = await plan.finish(plan.result);
      if (warning) {
        outcome = withQueuedCollectorWarning(outcome, warning);
      }
    }
    return outcome;
  })();
}

export function captureWorkerInferenceForSession(params: {
  context: GatewayRequestContext;
  sessionId?: string;
  runId?: string;
}): WorkerInferenceCancellation | undefined {
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionId) {
    return undefined;
  }
  return captureWorkerInferenceCancellation(
    params.context.workerEnvironmentService,
    sessionId,
    params.runId,
  );
}

export type ChatSessionAbortParams = {
  context: GatewayRequestContext;
  ops: ChatAbortOps;
  sessionKey: string;
  sessionKeyAliases?: string[];
  agentId?: string;
  sessionId?: string;
  /** Supplied only by narrow admission, from its original materialized target. */
  requiredSessionId?: string;
  session?: ChatAbortSessionSnapshot;
  defaultAgentId?: string;
  abortOrigin: ChatAbortOrigin;
  stopReason?: string;
  requester: ChatAbortRequester;
  stopSource: SessionStopSource;
  hookContext?: SessionStopHookContext;
  assertCurrent?: () => void;
  preserveSideRuns?: boolean;
  cascadeDescendants?: true;
  /** Exact lifecycle owners may include hidden and side runs for this one session. */
  includeProtectedRuns?: boolean;
  /** Captures exact registrations before cancellation can remove them. */
  onControllerTargets?: (targets: Array<{ runId: string; entry: RpcSourceRef }>) => void;
  /** Runs after authorized synchronous abort, before terminal/partial persistence can yield. */
  onCancellationStarted?: () => void;
  controllerTargets?: readonly SessionTarget[];
};

export type ChatSessionAbortResult = {
  aborted: boolean;
  runIds: string[];
  unauthorized: boolean;
  error?: ErrorShape;
  warning?: string;
  descendants?: Awaited<ReturnType<typeof abortControlledSubagents>>;
};

/** Resolve once at the cancellation boundary; persist captured partials only after Stop. */
export function prepareChatSessionAbort(
  params: ChatSessionAbortParams,
  workerCancellation: WorkerInferenceCancellation | undefined,
  selectedRunId?: string,
) {
  const sessionKeys = [params.sessionKey, ...(params.sessionKeyAliases ?? [])];
  const queuedPlan = resolveAuthorizedQueuedTurnsForSession({
    context: params.context,
    sessionKeys,
    sessionId: params.sessionId,
    requiredSessionId: params.requiredSessionId,
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: params.requester,
    preserveSideRuns: params.preserveSideRuns,
    includeProtectedRuns: params.includeProtectedRuns,
  });
  const {
    authorizedRuns,
    matchedRunIds: matchedActiveRunIds,
    hasUnauthorizedRuns: hasUnauthorizedActiveRuns,
    hasUnauthorizedProtectedRuns: hasUnauthorizedProtectedActiveRuns,
    hasProtectedRuns: hasProtectedActiveRuns,
  } = resolveAuthorizedRunsForSessionKeys({
    sessionKeys,
    sessionIds: [params.sessionId],
    requiredSessionId: params.requiredSessionId,
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: params.requester,
    preserveSideRuns: params.preserveSideRuns,
    includeProtectedRuns: params.includeProtectedRuns,
  });
  const hasAuthorizedGatewayRuns = authorizedRuns.length > 0 || queuedPlan.authorized.length > 0;
  const isLifecycleAbort = Boolean(params.cascadeDescendants);
  const hasWorkerRun = Boolean(
    (!hasAuthorizedGatewayRuns || isLifecycleAbort) && workerCancellation?.runIds.length,
  );
  // The worker manager admits at most one active inference per session, and a
  // worker-backed turn shares its controller's runId. One exact match therefore
  // represents the only worker owner instead of inventing a second owner.
  const hasControllerRepresentedWorkerRun =
    hasWorkerRun && matchedActiveRunIds.some((runId) => workerCancellation?.runIds.includes(runId));
  const hasUnauthorizedOwner =
    hasUnauthorizedActiveRuns ||
    queuedPlan.hasUnauthorizedRuns ||
    (hasWorkerRun && !hasControllerRepresentedWorkerRun && !params.requester.isAdmin);
  const hasProtectedLifecycleRuns = hasProtectedActiveRuns || queuedPlan.hasProtectedRuns;
  const hasUnauthorizedProtectedOwner =
    hasUnauthorizedProtectedActiveRuns || queuedPlan.hasUnauthorizedProtectedRuns;
  const hasUnauthorizedLifecycleOwner = isLifecycleAbort && hasUnauthorizedProtectedOwner;
  const canRunLifecycleCleanup = !hasUnauthorizedOwner && !hasProtectedLifecycleRuns;
  // Keep ordinary chat.abort's admin worker behavior; only the injected broad
  // lifecycle path must preserve hidden or explicitly preserved Gateway runs.
  const canCancelWorkerSession = !isLifecycleAbort || !hasProtectedLifecycleRuns;
  const snapshots = authorizedRuns.flatMap(({ runId, entry }) => {
    const text = params.context.chatRunState.resolveBuffer(runId, { final: true }).text;
    const identity = getRpcSourceIdentity(entry);
    return text?.trim()
      ? [
          captureAbortedPartial({
            runId,
            sessionKey: identity.sessionKey,
            sessionId: identity.sessionId,
            agentId: identity.agentId ?? params.agentId,
            text,
            abortOrigin: params.abortOrigin,
            resolveTerminalProducer: entry.adapter.resolveTerminalProducer,
            session: params.session,
          }),
        ]
      : [];
  });
  const capturedTargets = [...queuedPlan.authorized, ...authorizedRuns];
  const targetByInput = new Map(capturedTargets.map((target) => [target.entry.input, target]));
  const presentations = new Map(
    capturedTargets.map(({ runId, entry }) => [
      entry.input,
      captureChatRunAbortPresentation(params.ops, runId),
    ]),
  );
  const controllerStop = params.controllerTargets
    ? captureSessionControllerStop({ targets: params.controllerTargets })
    : undefined;
  const stopCapture = captureSessionControllerStop({
    inputs: [...targetByInput.keys(), ...(controllerStop?.inputs ?? [])],
    operations: controllerStop?.operations,
  });
  const sourceSettlements = new Map(
    stopCapture.inputs.map((input) => [input, captureSessionControllerSourceSettlement(input)]),
  );

  let workerCancellationPersistence: Promise<string[]> | undefined;
  let stopExecution: SessionStopExecution | undefined;
  // Reentrant cancellation can revoke the next effect. Keep committed outcomes
  // available to the partial-persistence owner even when abort() then throws.
  const result: ChatSessionAbortResult = { aborted: false, runIds: [], unauthorized: false };
  const recordRun = (runId: string) => {
    result.aborted = true;
    if (!result.runIds.includes(runId)) {
      result.runIds.push(runId);
    }
  };
  const cancelWorker = () => {
    workerCancellationPersistence = workerCancellation?.cancel({
      assertCurrent: params.assertCurrent,
      onCancelled: recordRun,
    });
    // The synchronous abort owner must return before persistence settles. Observe
    // rejection now, but finish() still joins the original operation and its cause.
    void workerCancellationPersistence?.catch(() => undefined);
    return workerCancellation?.runIds.length ? "aborted" : "unchanged";
  };
  const abortAuthorizedRuns = () => {
    params.assertCurrent?.();
    params.onControllerTargets?.([...queuedPlan.authorized, ...authorizedRuns]);
    if (!hasAuthorizedGatewayRuns) {
      // A persisted session id must not bypass a matching connection or protected run owner.
      if (hasUnauthorizedOwner || hasUnauthorizedLifecycleOwner) {
        result.unauthorized = true;
        return result;
      }
    }
    const onCancelled: NonNullable<SessionStopRequest["onCancelled"]> = (target) => {
      if ("instance" in target) {
        const source = targetByInput.get(target);
        if (source) {
          recordRun(source.runId);
        } else {
          result.aborted = true;
        }
      } else {
        result.aborted = true;
      }
    };
    const cancelInput: NonNullable<SessionStopRequest["cancelInput"]> = (input, cancel) => {
      const target = targetByInput.get(input);
      if (!target) {
        if (controllerStop?.inputs.includes(input)) {
          params.assertCurrent?.();
          return cancel();
        }
        return false;
      }
      const { runId, sessionKey, sessionId, agentId, entry } = target;
      const identity = getRpcSourceIdentity(entry);
      if (
        getRpcSource(runId) !== entry ||
        identity.sessionKey !== sessionKey ||
        identity.sessionId !== sessionId ||
        identity.agentId !== agentId
      ) {
        return false;
      }
      return abortChatRunById(params.ops, {
        runId,
        sessionKey,
        expectedEntry: entry,
        presentation: presentations.get(input),
        cancel,
        assertCurrent: params.assertCurrent,
        stopReason: params.stopReason,
        onAbortPrepared: () =>
          deferAbortedPartialPersistence(
            snapshots.find((snapshot) => snapshot.runId === runId),
            params.context,
          ),
        onAbortCommitted: () => recordRun(runId),
      }).aborted;
    };
    const afterParent = () => {
      if (!result.unauthorized && !result.error) {
        params.assertCurrent?.();
        cancelUnrepresentedWorker();
        params.onCancellationStarted?.();
      }
    };
    if (
      !params.hookContext &&
      ["channel-user", "client-session", "client-run"].includes(params.stopSource)
    ) {
      throw new Error(`Stop source ${params.stopSource} requires command hook context`);
    }
    const cancelUnrepresentedWorker = () => {
      if (
        !hasControllerRepresentedWorkerRun &&
        params.requester.isAdmin &&
        canCancelWorkerSession &&
        workerCancellation?.runIds.length
      ) {
        cancelWorker();
      }
    };
    const stopRequest = {
      capture: stopCapture,
      assertCurrent: params.assertCurrent,
      reason: params.stopReason,
      hookContext: params.hookContext,
      onCancelled,
      cancelInput,
      afterParent,
      stopChildren:
        canRunLifecycleCleanup &&
        ["channel-user", "client-session", "client-run"].includes(params.stopSource)
          ? async (applyParentStop) => {
              result.descendants = await abortControlledSubagents({
                cfg:
                  (params.session?.ok ? params.session.value.cfg : undefined) ??
                  params.context.getRuntimeConfig() ??
                  {},
                sessionKey: params.sessionKey,
                agentId: params.agentId,
                requesterTurnRunId: selectedRunId,
                beforeKill: applyParentStop,
              });
              return {
                stopped: result.descendants?.killed ?? 0,
                failed: result.descendants?.status === "error" ? result.descendants.failed : 0,
              };
            }
          : undefined,
    } satisfies Omit<SessionStopRequest, "source" | "mutation">;
    stopExecution =
      params.stopSource === "mutation"
        ? stopSession({
            ...stopRequest,
            source: params.stopSource,
            mutation: { cancelQueued: true, stopChildren: false },
          })
        : stopSession({ ...stopRequest, source: params.stopSource });
    return result;
  };
  const hasOtherWork =
    matchedActiveRunIds.some((runId) => runId !== selectedRunId) ||
    queuedPlan.matchedRunIds.some((runId) => runId !== selectedRunId) ||
    (hasWorkerRun && (!selectedRunId || !workerCancellation?.runIds.includes(selectedRunId)));
  return {
    canCascade: canRunLifecycleCleanup && !hasUnauthorizedLifecycleOwner,
    hasOtherWork,
    result,
    abort: abortAuthorizedRuns,
    async finish(outcome: Pick<ChatSessionAbortResult, "aborted" | "runIds">) {
      let stopFailure: unknown;
      try {
        await stopExecution?.completed;
      } catch (error) {
        // Cancellation can commit for an earlier exact target before authority
        // revocation blocks a later one. Preserve the committed target's output.
        stopFailure = error;
      }
      const abortedRunIds = new Set(outcome.runIds);
      const handedOffRunIds = new Set(
        snapshots
          .filter((snapshot) => snapshot.ok && snapshot.settlement.deferred)
          .map((snapshot) => snapshot.runId),
      );
      const [worker, partial, terminal] = await waitForChatAbortAcknowledgment(
        Promise.allSettled([
          workerCancellationPersistence,
          outcome.aborted && snapshots.length > 0
            ? persistAbortedPartials({
                context: params.context,
                snapshots: snapshots.filter((snapshot) => abortedRunIds.has(snapshot.runId)),
              })
            : undefined,
          Promise.all(
            [...queuedPlan.authorized, ...authorizedRuns]
              .filter(({ runId }) => abortedRunIds.has(runId))
              .flatMap(({ runId, entry }) => {
                const settlement = sourceSettlements.get(entry.input);
                const pending =
                  entry.adapter.kind === "agent"
                    ? []
                    : [waitForChatAbortTerminalPersistence(entry)];
                if (
                  entry.adapter.kind !== "agent" &&
                  settlement !== undefined &&
                  !handedOffRunIds.has(runId)
                ) {
                  pending.push(settlement);
                }
                return pending;
              }),
          ),
        ]),
      );
      // A captured session failure can also surface through partial persistence.
      const failures = new Set<unknown>();
      if (stopFailure !== undefined) {
        failures.add(stopFailure);
      }
      for (const settled of [worker, partial, terminal]) {
        if (settled.status === "rejected") {
          failures.add(settled.reason);
        }
      }
      if (params.session && !params.session.ok) {
        failures.add(params.session.error);
      }
      const warning = partial.status === "fulfilled" ? partial.value : undefined;
      if (failures.size > 0) {
        const errors = [...failures];
        throw abortedPartialPersistenceError(
          errors.length === 1
            ? errors[0]
            : new AggregateError(errors, "Chat cancellation persistence failed"),
          warning,
        );
      }
      return warning;
    },
  };
}

export async function abortChatRunsForSessionKeyWithPartials(
  params: ChatSessionAbortParams,
): Promise<ChatSessionAbortResult> {
  if (params.cascadeDescendants) {
    const queuedAbort = abortQueuedCollectorSession(params);
    if (queuedAbort) {
      const result = await queuedAbort;
      return result.ok
        ? { ...result.value, unauthorized: false }
        : { aborted: false, runIds: [], unauthorized: false, error: result.error };
    }
  }
  const plan = prepareChatSessionAbort(params, captureWorkerInferenceForSession(params));
  let result = plan.result;
  let failure: { error: unknown } | undefined;
  try {
    result = plan.abort();
  } catch (error) {
    failure = { error };
  }
  // Cancellation consumed these buffers before awaited descendant work could fail.
  let warning: string | undefined;
  try {
    warning = await plan.finish(result);
  } catch (error) {
    if (!failure) {
      throw error;
    }
    throw new AggregateError([failure.error, error], "Chat cancellation and persistence failed", {
      cause: error,
    });
  }
  if (failure) {
    throw abortedPartialPersistenceError(failure.error, warning);
  }
  return {
    ...result,
    aborted: result.aborted || Boolean(result.descendants?.killed),
    ...(warning ? { warning } : {}),
  };
}

import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsRecoverResult,
} from "../../packages/gateway-protocol/src/index.js";
import { isEmbeddedAgentRunActive } from "../agents/embedded-agent.js";
import { isMainSessionRecoveryReconciliationCandidate } from "../agents/main-session-recovery/main-session-recovery-state.js";
import { markOrphanedMainSessionForRecovery } from "../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { createAgentRunDirectAbortError } from "../agents/run-termination.js";
import { resumeSessionEntryFromRestartTombstone } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  closeSessionWorkAdmissions,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { normalizeSessionIdentities } from "../sessions/session-lifecycle-identity.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../shared/store-writer-queue.js";
import { authorizeGatewaySessionCreation } from "./operator-role-policy.js";
import type { GatewayOperatorRoleActor } from "./server-methods/shared-types.js";
import { resolvePluginSessionOwnershipError } from "./session-plugin-ownership.js";
import { invalidSessionRequest } from "./session-request-error.js";
import {
  loadGatewaySessionEntryReadOnly,
  resolveGatewaySessionStoreTarget,
} from "./session-utils.js";
import {
  prepareSessionWorkerPlacementMutationCheck,
  prepareSessionWorkerPlacementStop,
  type SessionWorkerPlacementContext,
} from "./worker-environments/session-placement-lifecycle.js";

export type SessionRecoveryContinuationOutcome = SessionsRecoverResult["continuation"];

const recoveryQueues = resolveGlobalMap<string, StoreWriterQueue>(
  Symbol.for("openclaw.sessionRecoveryQueues"),
);

type RecoverGatewaySessionResult =
  | {
      ok: true;
      agentId: string;
      sourceKey: string;
      successorEntry: InternalSessionEntry;
      successorKey: string;
      continuation: SessionRecoveryContinuationOutcome;
    }
  | { ok: false; error: ErrorShape };

function recoveryConflictError(reason: string): ErrorShape {
  const unavailable = reason === "successor-missing";
  return errorShape(
    unavailable ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
    unavailable
      ? "Session recovery state is incomplete."
      : "Session changed before recovery; refresh and retry.",
    { details: { reason } },
  );
}

/** Reconcile dead recovery ownership before a new send can replace its delivery claim. */
export async function reconcileOrphanedGatewaySessionRecovery(params: {
  cfg: OpenClawConfig;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  entry: InternalSessionEntry;
  authorizedPluginId?: string;
  commitGuard?: () => void;
  workerPlacementContext: SessionWorkerPlacementContext;
}): Promise<InternalSessionEntry | undefined> {
  const { entry: initialSource, target } = params;
  const identities = [...target.storeKeys, initialSource.sessionId];
  if (
    !isMainSessionRecoveryReconciliationCandidate(initialSource) ||
    isSessionWorkAdmissionActive(target.storePath, identities)
  ) {
    return undefined;
  }
  const readSource = () =>
    loadGatewaySessionEntryReadOnly(target.canonicalKey, { agentId: target.agentId }).entry;
  return await runExclusiveSessionLifecycleMutation({
    scope: target.storePath,
    identities,
    run: async () => {
      if (isSessionWorkAdmissionActive(target.storePath, identities)) {
        return undefined;
      }
      const assertPlacementCurrent = prepareSessionWorkerPlacementMutationCheck({
        context: params.workerPlacementContext,
        sessionId: initialSource.sessionId,
      });
      const assertCurrent = () => {
        params.commitGuard?.();
        assertPlacementCurrent();
        const current = readSource();
        const ownershipError = resolvePluginSessionOwnershipError({
          action: "recover",
          entry: current,
          key: target.canonicalKey,
          pluginOwnerId: params.authorizedPluginId,
        });
        if (ownershipError) {
          throw new Error(ownershipError.message);
        }
        if (
          current?.sessionId !== initialSource.sessionId ||
          current.status !== initialSource.status ||
          current.abortedLastRun !== initialSource.abortedLastRun ||
          current.lifecycleRevision !== initialSource.lifecycleRevision ||
          current.activeWriterRunId !== initialSource.activeWriterRunId ||
          current.mainRestartRecovery?.cycleId !== initialSource.mainRestartRecovery?.cycleId ||
          current.mainRestartRecovery?.revision !== initialSource.mainRestartRecovery?.revision ||
          isSessionWorkAdmissionActive(target.storePath, identities)
        ) {
          throw new Error("Session changed before recovery; refresh and retry.");
        }
      };
      const result = await markOrphanedMainSessionForRecovery({
        target: { ...target, sessionKey: target.canonicalKey },
        expectedSessionId: initialSource.sessionId,
        expectedLifecycleRevision: initialSource.lifecycleRevision,
        cfg: params.cfg,
        assertCommitAllowed: assertCurrent,
      });
      return result.marked > 0 ? readSource() : undefined;
    },
  });
}

/** Owns explicit restart recovery from authorization through continuation launch. */
export async function recoverGatewaySession(params: {
  agentId?: string;
  authorizedPluginId?: string;
  cfg: OpenClawConfig;
  commitGuard?: () => void;
  key: string;
  requestingOperatorProfileId?: string;
  operatorRoleActor?: GatewayOperatorRoleActor;
  workerPlacementContext: SessionWorkerPlacementContext;
  prepareContinuationAuthorization: (target: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }) => { ok: true; assertCurrent: () => void } | { ok: false; error: ErrorShape };
  launchContinuation: (params: {
    agentId: string;
    idempotencyKey: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }) => Promise<SessionRecoveryContinuationOutcome>;
}): Promise<RecoverGatewaySessionResult> {
  const sourceTarget = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.key,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  const readSource = () =>
    loadGatewaySessionEntryReadOnly(sourceTarget.canonicalKey, {
      agentId: sourceTarget.agentId,
    }).entry as InternalSessionEntry | undefined;
  const initialSource = readSource();
  if (!initialSource?.sessionId) {
    return invalidSessionRequest("Session recovery source was not found.");
  }
  params.commitGuard?.();
  const ownershipError = resolvePluginSessionOwnershipError({
    action: "recover",
    entry: initialSource,
    key: sourceTarget.canonicalKey,
    pluginOwnerId: params.authorizedPluginId,
  });
  if (ownershipError) {
    return { ok: false, error: ownershipError };
  }
  const continuationAuthority = initialSource.mainRestartRecovery?.tombstone?.recoveredSessionKey
    ? undefined
    : params.prepareContinuationAuthorization({
        agentId: sourceTarget.agentId,
        sessionId: initialSource.sessionId,
        sessionKey: sourceTarget.canonicalKey,
        storePath: sourceTarget.storePath,
      });
  if (continuationAuthority && !continuationAuthority.ok) {
    return { ok: false, error: continuationAuthority.error };
  }
  const assertContinuationCurrent = () => {
    params.commitGuard?.();
    if (continuationAuthority?.ok) {
      continuationAuthority.assertCurrent();
    }
  };
  if (isMainSessionRecoveryReconciliationCandidate(initialSource)) {
    const repaired = await reconcileOrphanedGatewaySessionRecovery({
      ...params,
      target: sourceTarget,
      entry: initialSource,
      commitGuard: assertContinuationCurrent,
    });
    if (!repaired) {
      return invalidSessionRequest(
        "Session recovery is unavailable while the source still has active work.",
      );
    }
    const continuation = await params.launchContinuation({
      agentId: sourceTarget.agentId,
      idempotencyKey: `restart-recovery-reconcile:${repaired.sessionId}:${repaired.mainRestartRecovery?.cycleId}`,
      sessionId: repaired.sessionId,
      sessionKey: sourceTarget.canonicalKey,
      storePath: sourceTarget.storePath,
    });
    return {
      ok: true,
      agentId: sourceTarget.agentId,
      sourceKey: sourceTarget.canonicalKey,
      successorEntry: repaired,
      successorKey: sourceTarget.canonicalKey,
      continuation,
    };
  }
  const recovery = initialSource.mainRestartRecovery;
  const linkedKey = recovery?.tombstone?.recoveredSessionKey;
  if (linkedKey) {
    // Already-published rollovers retain their exact destination; never fork them again.
    const linked = loadGatewaySessionEntryReadOnly(linkedKey, {
      agentId: sourceTarget.agentId,
    }).entry;
    if (!linked || linked.sessionId !== recovery?.tombstone?.recoveredSessionId) {
      return { ok: false, error: recoveryConflictError("successor-missing") };
    }
    const continuation = await params.launchContinuation({
      agentId: sourceTarget.agentId,
      idempotencyKey: `restart-recovery-rollover:${linked.sessionId}`,
      sessionId: linked.sessionId,
      sessionKey: linkedKey,
      storePath: sourceTarget.storePath,
    });
    return {
      ok: true,
      agentId: sourceTarget.agentId,
      sourceKey: sourceTarget.canonicalKey,
      successorKey: linkedKey,
      successorEntry: linked,
      continuation,
    };
  }
  if (recovery?.tombstone?.recoveredSessionId) {
    return { ok: false, error: recoveryConflictError("successor-missing") };
  }
  const resumeRunId = recovery?.tombstone
    ? `restart-recovery-resume:${initialSource.sessionId}:${recovery.cycleId}`
    : initialSource.restartRecoveryResumeRunId;
  if (!resumeRunId) {
    return invalidSessionRequest("Session recovery requires a restart-tombstoned session.");
  }

  const resolveCurrentSource = () => {
    params.commitGuard?.();
    const currentSource = readSource();
    const currentOwnershipError = resolvePluginSessionOwnershipError({
      action: "recover",
      entry: currentSource,
      key: sourceTarget.canonicalKey,
      pluginOwnerId: params.authorizedPluginId,
    });
    if (currentOwnershipError) {
      return { ok: false as const, error: currentOwnershipError };
    }
    if (
      !currentSource?.sessionId ||
      currentSource.sessionId !== initialSource.sessionId ||
      currentSource.lifecycleRevision !== initialSource.lifecycleRevision ||
      !(
        (recovery &&
          currentSource.mainRestartRecovery?.cycleId === recovery.cycleId &&
          currentSource.mainRestartRecovery.revision === recovery.revision) ||
        (!currentSource.mainRestartRecovery &&
          currentSource.restartRecoveryResumeRunId === resumeRunId)
      )
    ) {
      return { ok: false as const, error: recoveryConflictError("source-changed") };
    }
    if (continuationAuthority?.ok) {
      continuationAuthority.assertCurrent();
    }
    if (currentSource.archivedAt !== undefined) {
      return invalidSessionRequest("Session is archived. Restore it before resuming.");
    }
    if (currentSource.mainRestartRecovery?.tombstone) {
      const creationError = authorizeGatewaySessionCreation({
        cfg: params.cfg,
        agentId: sourceTarget.agentId,
        ...(params.operatorRoleActor
          ? { actor: params.operatorRoleActor }
          : { profileId: params.requestingOperatorProfileId }),
      });
      if (creationError) {
        return { ok: false as const, error: creationError };
      }
    }
    if (
      currentSource.mainRestartRecovery?.tombstone &&
      (isEmbeddedAgentRunActive(currentSource.sessionId) ||
        isSessionWorkAdmissionActive(sourceTarget.storePath, [
          sourceTarget.canonicalKey,
          currentSource.sessionId,
        ]))
    ) {
      return invalidSessionRequest(
        "Session recovery is unavailable while the source still has active work.",
      );
    }
    return { ok: true as const, source: currentSource };
  };
  const assertCurrent = () => {
    const current = resolveCurrentSource();
    if (!current.ok) {
      throw new Error(current.error.message);
    }
  };
  const sourceIdentities = [
    ...sourceTarget.storeKeys,
    sourceTarget.canonicalKey,
    initialSource.sessionId,
  ];
  const stopFailure = (error: unknown) =>
    errorShape(
      ErrorCodes.UNAVAILABLE,
      `Session recovery cannot safely stop/reclaim its cloud worker: ${formatErrorMessage(error)} Stop cloud worker or call sessions.reclaim, then retry recovery.`,
      { retryable: true },
    );
  const commitRecovery = async () => {
    let release = () => {};
    try {
      const prepared = await runExclusiveSessionLifecycleMutation({
        scope: sourceTarget.storePath,
        identities: sourceIdentities,
        run: async () => {
          const current = resolveCurrentSource();
          if (!current.ok) {
            return current;
          }
          if (!current.source.mainRestartRecovery?.tombstone) {
            return { ...current, stop: undefined };
          }
          let stop: (() => Promise<void>) | undefined;
          try {
            stop = prepareSessionWorkerPlacementStop({
              action: "recover",
              agentId: sourceTarget.agentId,
              authorize: assertCurrent,
              context: params.workerPlacementContext,
              sessionId: initialSource.sessionId,
              sessionKey: sourceTarget.canonicalKey,
            }).stop;
          } catch (error) {
            return { ok: false as const, error: stopFailure(error) };
          }
          // Reclaim may need both queues after this short exact-owner preflight.
          release = closeSessionWorkAdmissions({
            scope: sourceTarget.storePath,
            identities: sourceIdentities,
            reason: createAgentRunDirectAbortError(),
          });
          return { ...current, stop };
        },
      });
      if (!prepared.ok) {
        return prepared;
      }
      let assertPlacementCurrent: (() => void) | undefined;
      if (prepared.stop) {
        try {
          await prepared.stop();
          assertPlacementCurrent = prepareSessionWorkerPlacementMutationCheck({
            context: params.workerPlacementContext,
            sessionId: initialSource.sessionId,
          });
        } catch (error) {
          const current = resolveCurrentSource();
          return current.ok ? { ok: false as const, error: stopFailure(error) } : current;
        }
      }
      return await runExclusiveSessionLifecycleMutation({
        scope: sourceTarget.storePath,
        identities: sourceIdentities,
        prepare: async () => release(),
        run: async () => {
          const settled = resolveCurrentSource();
          if (!settled.ok) {
            return settled;
          }
          const currentSource = settled.source;
          const commitGuard = () => {
            assertCurrent();
            assertPlacementCurrent?.();
          };
          commitGuard();
          const entry = currentSource.mainRestartRecovery?.tombstone
            ? await resumeSessionEntryFromRestartTombstone({
                agentId: sourceTarget.agentId,
                sessionKey: sourceTarget.canonicalKey,
                storePath: sourceTarget.storePath,
                expected: currentSource,
                commitGuard,
              })
            : currentSource;
          return {
            ok: true as const,
            successorEntry: entry,
            successorKey: sourceTarget.canonicalKey,
          };
        },
      });
    } finally {
      release();
    }
  };
  // Only recovery takes this queue: Move/reclaim can acquire their lifecycle fences.
  // Publish the resume receipt before another recovery checks it; launch outside the queue.
  const committed = await runQueuedStoreWrite({
    queues: recoveryQueues,
    storePath: normalizeSessionIdentities(sourceTarget.storePath, [sourceTarget.canonicalKey])[0]!,
    label: "recoverGatewaySession",
    fn: commitRecovery,
  });
  if (!committed.ok) {
    return committed;
  }

  const continuation = await params.launchContinuation({
    agentId: sourceTarget.agentId,
    idempotencyKey: resumeRunId,
    sessionId: committed.successorEntry.sessionId,
    sessionKey: committed.successorKey,
    storePath: sourceTarget.storePath,
  });
  return {
    ok: true,
    agentId: sourceTarget.agentId,
    sourceKey: sourceTarget.canonicalKey,
    successorEntry: committed.successorEntry,
    successorKey: committed.successorKey,
    continuation,
  };
}

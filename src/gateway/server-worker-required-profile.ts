import { isDeepStrictEqual } from "node:util";
import type { LocalTurnPlacementClaim } from "../agents/session-placement-admission.js";
import {
  assertRequiredWorkerSelection,
  RequiredWorkerProfileError,
} from "../config/required-worker-profile.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { retainPreparedSessionEntryPredicate } from "../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import {
  prepareSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { captureSessionTranscriptTargetBinding } from "../config/sessions/transcript-target-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  prepareSessionRowPublicationScope,
  sessionChangeAffectsStoredRow,
} from "../sessions/session-row-facts.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  findOpenClawAgentDatabaseIdentity,
  isOpenClawAgentDatabasePathCurrent,
} from "../state/openclaw-agent-db-identity.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  loadWorkerPlacementSessionRuntimeModule,
  resolveWorkerPlacementSessionTarget,
} from "./server-worker-placement-session-target.js";
import { prepareSessionWorktree } from "./session-worktree-preparation.js";
import type { coordinateWorkerPlacementDispatch } from "./worker-environments/placement-dispatch-coordinator.js";
import { isCurrentActiveWorkerEnvironment } from "./worker-environments/placement-dispatch-failure.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { isFailedWorkerPlacementEnvironmentGone } from "./worker-environments/placement-target.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";

/** Uses the existing workspace lifecycle and dispatch coordinator, including unknown-outcome recovery. */
export function createRequiredWorkerSessionPreparation(options: {
  getConfig: () => OpenClawConfig;
  placements: WorkerSessionPlacementStore;
  environments: WorkerEnvironmentService;
  warn: (message: string) => void;
  redispatchPlacement: ReturnType<
    typeof import("./worker-environments/worker-placement-redispatch.js").createWorkerPlacementRedispatch
  >;
  onTransition?: Parameters<ReturnType<typeof coordinateWorkerPlacementDispatch>["dispatch"]>[1];
  dispatch: ReturnType<typeof coordinateWorkerPlacementDispatch>;
}) {
  return async (
    identity: Omit<LocalTurnPlacementClaim, "runId">,
    authorize?: () => void,
    callerSignal?: AbortSignal,
    preparation?: { waitForReady: false },
  ): Promise<void> => {
    const required = options.getConfig().cloudWorkers?.requiredProfile;
    if (!required) {
      return;
    }
    if (!identity.sessionKey?.trim() || !identity.agentId?.trim()) {
      throw new RequiredWorkerProfileError(
        "Required worker execution needs a real agent session; sessionless model helpers are unsupported.",
      );
    }
    const scope = {
      sessionId: identity.sessionId,
      sessionKey: identity.sessionKey,
      agentId: identity.agentId,
    };
    const runtime = await loadWorkerPlacementSessionRuntimeModule();
    const configuredStorePath = resolveSessionStorePathForScope(scope, options.getConfig());
    const originalBinding = captureSessionTranscriptTargetBinding({
      ...scope,
      storePath: configuredStorePath,
    });
    const databaseOptions = toDatabaseOptions(
      await prepareSqliteTranscriptReadScope(originalBinding, callerSignal),
    );
    const storePath = resolveOpenClawAgentSqlitePath(databaseOptions);
    const binding = { ...originalBinding, storePath };
    const source = { ...databaseOptions, path: storePath, env: binding.env };
    const retained = retainOpenClawAgentDatabaseReadOnly(source);
    if (!retained.found) {
      throw new RequiredWorkerProfileError("Required worker session source is unavailable.");
    }
    const publication = prepareSessionRowPublicationScope([configuredStorePath, storePath]);
    let sessionChanged = false;
    let acceptNextPublication = false;
    const stopPublication = sessionChanges.subscribeFacts((change) => {
      if (
        sessionChangeAffectsStoredRow(change, {
          ...publication,
          agentId: scope.agentId,
          sessionKeys: [scope.sessionKey],
          ignoreStoreTopology: true,
        })
      ) {
        if (acceptNextPublication) {
          acceptNextPublication = false;
        } else {
          sessionChanged = true;
        }
      }
    });
    const owned = await (async () => {
      try {
        const entry = await withSessionEntryReadOnlyInWorker(
          binding,
          () => {
            callerSignal?.throwIfAborted();
            authorize?.();
            if (
              !retained.claim.isCurrent() ||
              !isOpenClawAgentDatabasePathCurrent(retained.database)
            ) {
              throw new RequiredWorkerProfileError(
                "Required worker session source changed during admission.",
              );
            }
          },
          async (read) => {
            if (!read.ok) {
              throw read.error;
            }
            return read.value;
          },
        );
        if (!entry || entry.sessionId !== scope.sessionId) {
          throw new RequiredWorkerProfileError("Required worker session source is unavailable.");
        }
        return { entry, retained, source };
      } catch (error) {
        stopPublication();
        retained.claim.release();
        throw error;
      }
    })();
    const target = {
      ...scope,
      storePath: owned.source.path,
      canonicalKey: scope.sessionKey,
      storeKeys: [scope.sessionKey],
    };
    const original = owned.entry;
    if (original.archivedAt !== undefined) {
      stopPublication();
      owned.retained.claim.release();
      throw new RequiredWorkerProfileError("Required worker session source is unavailable.");
    }
    const databaseIdentity = findOpenClawAgentDatabaseIdentity(owned.retained.database)?.identity;
    if (databaseIdentity === undefined) {
      stopPublication();
      owned.retained.claim.release();
      throw new RequiredWorkerProfileError("Required worker session source is unavailable.");
    }
    publication.databaseIdentities.add(databaseIdentity);
    if (sessionChanged) {
      stopPublication();
      owned.retained.claim.release();
      throw new RequiredWorkerProfileError(
        "Session changed during required worker placement; retry.",
      );
    }
    const retainedEntry =
      typeof databaseIdentity === "string"
        ? retainPreparedSessionEntryPredicate({
            databaseIdentity: `file:${databaseIdentity}`,
            sessionKey: scope.sessionKey,
            entry: original,
            matches: (before, after) =>
              Boolean(
                before &&
                after &&
                before.sessionId === after.sessionId &&
                before.lifecycleRevision === after.lifecycleRevision &&
                after.archivedAt === undefined &&
                isDeepStrictEqual(before.agentRuntimeOverride, after.agentRuntimeOverride) &&
                isDeepStrictEqual(before.execNode, after.execNode),
              ),
          })
        : undefined;
    if (retainedEntry) {
      stopPublication();
    }
    let currentEntry = original;
    let released = false;
    let background: Promise<unknown> | undefined;
    const completion = createDeferredCore();
    const revoked = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, revoked.signal]) : revoked.signal;
    let unregister = () => {};
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      unregister();
      stopPublication();
      retainedEntry?.release();
      owned.retained.claim.release();
      completion.resolve();
    };
    const assertSourceCurrent = () => {
      signal?.throwIfAborted();
      authorize?.();
      const config = options.getConfig();
      if (
        released ||
        !owned.retained.claim.isCurrent() ||
        !isOpenClawAgentDatabasePathCurrent(owned.retained.database) ||
        resolveSessionStorePathForScope(scope, config) !== configuredStorePath ||
        config.cloudWorkers?.requiredProfile !== required
      ) {
        throw new RequiredWorkerProfileError(
          "Session source or required worker policy changed during placement; retry.",
        );
      }
    };
    const assertCurrent = () => {
      assertSourceCurrent();
      if (sessionChanged || retainedEntry?.isCurrent() === false) {
        throw new RequiredWorkerProfileError(
          "Session changed during required worker placement; retry.",
        );
      }
      assertRequiredWorkerSelection(options.getConfig(), {
        agentRuntime: currentEntry.agentRuntimeOverride,
        execNode: currentEntry.execNode,
      });
      return currentEntry;
    };
    try {
      unregister = registerOpenClawAgentDatabaseAsyncResource({
        agentId: owned.retained.database.agentId,
        path: owned.retained.database.path,
        revoke: () => revoked.abort(new Error("Required worker session source was revoked")),
        close: () => completion.promise,
      });
      assertCurrent();
      const validatePlacement = () => {
        assertCurrent();
        const placement = options.placements.get(scope.sessionId);
        if (!placement || placement.state === "local") {
          return placement;
        }
        if (
          placement.agentId !== scope.agentId ||
          placement.sessionKey !== scope.sessionKey ||
          placement.executionMode !== "worker-turn"
        ) {
          throw new RequiredWorkerProfileError(
            "The existing placement conflicts with required worker execution; repair its recorded owner before retrying.",
          );
        }
        if (placement.environmentId) {
          const environment = options.environments.get(placement.environmentId);
          // The environment owns profile identity; the placement records only its ID.
          // A missing failed allocation cannot prove affinity to the new policy.
          if (!environment && placement.state === "failed") {
            throw new RequiredWorkerProfileError(
              "The session's recorded worker profile is unavailable; repair its environment record before retrying. Its workspace will not be moved automatically.",
            );
          }
          if (environment && environment.profileId !== required) {
            throw new RequiredWorkerProfileError(
              "The session is bound to another worker profile; its workspace will not be moved automatically.",
            );
          }
        }
        return placement;
      };
      const assertReady = () => {
        const placement = validatePlacement();
        const environment = placement?.environmentId
          ? options.environments.get(placement.environmentId)
          : undefined;
        if (
          placement?.state !== "active" ||
          !isCurrentActiveWorkerEnvironment(placement, environment)
        ) {
          throw new RequiredWorkerProfileError(
            "Required worker placement is not ready; inspect its setup error or Stop the failed worker before retrying.",
          );
        }
      };
      const canDispatch = (placement: ReturnType<typeof validatePlacement>) =>
        !placement ||
        placement.state === "local" ||
        (placement.state === "failed" &&
          placement.activeOwnerEpoch === null &&
          isFailedWorkerPlacementEnvironmentGone({
            placement,
            environmentService: options.environments,
          }));
      let current = validatePlacement();
      if (
        current?.state === "reclaimed" ||
        (current?.state === "failed" && current.activeOwnerEpoch !== null)
      ) {
        await options.redispatchPlacement(current, { assertCurrent, signal });
        assertReady();
        return;
      }
      if (!canDispatch(current) && current) {
        if (
          preparation?.waitForReady !== false &&
          ["requested", "provisioning", "syncing", "starting"].includes(current.state)
        ) {
          await options.dispatch.waitForInitialPlacement(current, signal);
          validatePlacement();
        }
        // Recorded destinations are never rewritten by profile edits.
        if (preparation?.waitForReady !== false) {
          assertReady();
        }
        return;
      }
      const profile = options.getConfig().cloudWorkers?.profiles?.[required];
      if (!profile) {
        throw new RequiredWorkerProfileError(
          'Required worker profile "' + required + '" is not configured; configure it and retry.',
        );
      }
      const snapshot = structuredClone(profile);
      const assertDispatchCurrent = () => {
        assertCurrent();
        if (!isDeepStrictEqual(options.getConfig().cloudWorkers?.profiles?.[required], snapshot)) {
          throw new RequiredWorkerProfileError(
            "Required worker profile changed during setup; retry after its original operation settles.",
          );
        }
      };
      await runExclusiveSessionLifecycleMutation("placement-dispatch", {
        scope: target.storePath,
        identities: [scope.sessionId, scope.sessionKey, target.canonicalKey, ...target.storeKeys],
        signal,
        run: async () => {
          const entry = assertCurrent();
          current = validatePlacement();
          if (!canDispatch(current) && current) {
            return;
          }
          if (current?.turnClaim) {
            throw new RequiredWorkerProfileError(
              "A local turn is still active; stop it before required worker setup.",
            );
          }
          if (entry.worktree || entry.repositoryWorkspaceId) {
            await resolveWorkerPlacementSessionTarget({
              sessionRuntime: {
                ...runtime,
                resolveGatewaySessionStoreTargetWithStore: () => ({
                  ...target,
                  store: { [scope.sessionKey]: entry },
                }),
              },
              config: options.getConfig(),
              ...scope,
              errorMessage:
                "The session workspace owner is unavailable; repair it before retrying.",
            });
            return;
          }
          if (entry.pendingWorktree || entry.pendingProjectGitUrl) {
            throw new RequiredWorkerProfileError(
              "The session workspace must finish preparation before required worker setup.",
            );
          }
          if (entry.spawnedCwd || entry.projectId || entry.sessionRoot) {
            throw new RequiredWorkerProfileError(
              "Required worker execution needs a session-owned workspace; create a managed-workspace session rather than dropping the current workspace.",
            );
          }
          const prepared = await prepareSessionWorktree({
            cfg: options.getConfig(),
            target: {
              key: scope.sessionKey,
              agentId: scope.agentId,
              storePath: target.storePath,
              entry,
            },
            workspace: { kind: "empty" },
            runSetupScript: false,
            signal,
            commitGuard: assertDispatchCurrent,
          });
          if (!prepared.ok) {
            throw new RequiredWorkerProfileError(prepared.error.message);
          }
          try {
            const updated = await patchSessionEntryCore(
              { agentId: scope.agentId, sessionKey: scope.sessionKey, storePath: target.storePath },
              (saved) => {
                assertDispatchCurrent();
                if (
                  saved.sessionId !== scope.sessionId ||
                  saved.worktree ||
                  saved.repositoryWorkspaceId ||
                  saved.sessionRoot ||
                  saved.spawnedCwd ||
                  saved.pendingWorktree ||
                  saved.pendingProjectGitUrl
                ) {
                  throw new RequiredWorkerProfileError(
                    "Session workspace changed during required worker setup.",
                  );
                }
                return {
                  worktree: prepared.value.worktree,
                  sessionRoot: prepared.value.sessionRoot,
                  spawnedCwd: prepared.value.spawnedCwd,
                };
              },
              {
                assertCommitAllowed: assertDispatchCurrent,
                requireWriteSuccess: true,
                skipMaintenance: true,
                onCommitted: () => {
                  acceptNextPublication = true;
                },
              },
            );
            if (!updated) {
              throw new RequiredWorkerProfileError(
                "Session disappeared during required worker setup.",
              );
            }
            currentEntry = updated;
          } catch (error) {
            await prepared.value.rollback?.();
            throw error;
          }
        },
      });
      assertDispatchCurrent();
      current = validatePlacement();
      if (!canDispatch(current) && current) {
        if (
          preparation?.waitForReady !== false &&
          ["requested", "provisioning", "syncing", "starting"].includes(current.state)
        ) {
          await options.dispatch.waitForInitialPlacement(current, signal);
          validatePlacement();
        }
        if (preparation?.waitForReady !== false) {
          assertReady();
        }
        return;
      }
      const previousEnvironment =
        current?.state === "failed" && current.environmentId
          ? options.environments.get(current.environmentId)
          : undefined;
      const started = createDeferredCore();
      const operation = options.dispatch.dispatch(
        {
          ...scope,
          profileId: required,
          executionMode: "worker-turn",
          requiredProfile: required,
          runSetupScript: false,
          devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
          ...(previousEnvironment
            ? {
                inheritedProfile: {
                  providerId: previousEnvironment.providerId,
                  profileSnapshot: previousEnvironment.profileSnapshot,
                },
              }
            : {}),
        },
        (placement) => {
          started.resolve();
          options.onTransition?.(placement);
        },
        assertDispatchCurrent,
        signal,
      );
      if (preparation?.waitForReady === false) {
        background = operation;
        // Dispatch's existing coordinator owns settlement and Stop/recovery after
        // this RPC returns. Only its durable first transition acknowledges startup.
        void operation.catch((error: unknown) => {
          try {
            options.warn("Required worker setup failed: " + String(error));
          } catch {
            /* Reporting cannot replace durable setup failure. */
          }
        });
        await Promise.race([started.promise, operation.then(() => {})]);
      } else {
        await operation;
      }
      validatePlacement();
      if (preparation?.waitForReady !== false) {
        assertReady();
      }
    } finally {
      if (background) {
        void background.then(release, release);
      } else {
        release();
      }
    }
  };
}

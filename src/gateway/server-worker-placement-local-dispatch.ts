import { clearSessionQueues } from "../auto-reply/reply/queue/cleanup.js";
import { getRuntimeConfig } from "../config/config.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import {
  captureSessionTarget,
  interruptSessionControllerEffects,
  runSessionMutation,
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
} from "../sessions/session-controller.lifecycle.js";
import { captureSessionControllerStop } from "../sessions/session-controller.stop.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  loadWorkerPlacementSessionRuntimeModule,
  resolveWorkerPlacementSessionTarget,
  WorkerDispatchTargetChangedError,
} from "./server-worker-placement-session-target.js";
import type { createWorkerPlacementDispatchService } from "./worker-environments/placement-dispatch.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const loadWorkerWorkspacePreflight = createLazyRuntimeModule(async () => {
  const { preflightWorkerWorkspace } =
    await import("./worker-environments/workspace-sync-preflight.js");
  return preflightWorkerWorkspace;
});

export function createGatewayWorkerPlacementLocalDispatchBarrier(params: {
  placements: Pick<WorkerSessionPlacementStore, "waitForTurnClaimRelease">;
  awaitTurnClaimRelease: (sessionId: string, wait: () => Promise<void>) => Promise<void>;
  revokeSessionAuthority: (request: { sessionId: string; sessionKeys: readonly string[] }) => void;
}): Parameters<typeof createWorkerPlacementDispatchService>[0]["runLocalBarrier"] {
  return async ({
    sessionId,
    sessionKey,
    agentId,
    executionMode,
    authorize,
    signal,
    startDispatch,
  }) => {
    const sessionRuntime = await loadWorkerPlacementSessionRuntimeModule();
    const {
      resolveWorkerPlacementExecutionMode,
      resolveGatewaySessionStoreTargetWithStore,
      resolveWorkerPlacementSessionRuntime,
    } = sessionRuntime;
    const target = resolveGatewaySessionStoreTargetWithStore({
      cfg: getRuntimeConfig(),
      key: sessionKey,
      agentId,
      preserveQualifiedAddress: true,
      clone: false,
      exactRead: true,
    });
    const lifecycleIdentities = [sessionKey, target.canonicalKey, ...target.storeKeys, sessionId];
    const controllerTarget = captureSessionTarget({
      storeScope: target.storePath,
      sessionKey: target.canonicalKey,
      aliases: lifecycleIdentities,
      agentId,
      incarnation: sessionId,
    });
    let placement: Awaited<ReturnType<typeof startDispatch>> | undefined;
    return await runSessionMutation({
      scope: target.storePath,
      identities: lifecycleIdentities,
      signal,
      prepare: async () => {
        const {
          config: currentConfig,
          target: currentTarget,
          entry: currentEntry,
          workspace,
          assertCurrent,
        } = await resolveWorkerPlacementSessionTarget({
          sessionRuntime,
          config: getRuntimeConfig(),
          sessionId,
          sessionKey,
          agentId,
          expectedTarget: target,
          errorMessage: `Session ${sessionKey} changed before cloud worker dispatch. Retry.`,
        });
        assertCurrent(getRuntimeConfig());
        if (currentEntry.archivedAt !== undefined) {
          throw new WorkerDispatchTargetChangedError(
            `Session ${sessionKey} was archived before cloud worker dispatch. Retry.`,
          );
        }
        const currentRuntime = resolveWorkerPlacementSessionRuntime({
          cfg: currentConfig,
          entry: currentEntry,
          agentId: currentTarget.agentId,
          sessionKey: currentTarget.canonicalKey,
        });
        if (resolveWorkerPlacementExecutionMode(currentRuntime) !== executionMode) {
          throw new WorkerDispatchTargetChangedError(
            `Session ${sessionKey} runtime changed to ${currentRuntime} before cloud worker dispatch. Retry.`,
          );
        }
        if (workspace.kind === "local") {
          const preflightWorkerWorkspace = await loadWorkerWorkspacePreflight();
          await preflightWorkerWorkspace({ localPath: workspace.path, signal });
        }
        assertCurrent(getRuntimeConfig());
        authorize?.();
        const queuedInputs = captureSessionControllerStop({
          targets: [controllerTarget],
          includeActive: false,
        }).queuedInputs;
        placement = await startDispatch();
        clearSessionQueues(lifecycleIdentities, controllerTarget, queuedInputs);
        params.revokeSessionAuthority({
          sessionId,
          sessionKeys: lifecycleIdentities,
        });
        await params.awaitTurnClaimRelease(sessionId, async () => {
          const released = await interruptSessionControllerEffects({
            scope: target.storePath,
            identities: lifecycleIdentities,
            timeoutMs: SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
          });
          if (!released) {
            throw new Error(`Session ${sessionKey} is still active; dispatch stopped`);
          }
          await params.placements.waitForTurnClaimRelease(sessionId, {
            timeoutMs: SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
            signal,
          });
        });
        await runExclusiveSessionStoreWrite(target.storePath, async () => {}, {
          reentrant: true,
        });
      },
      run: async () => {
        if (!placement) {
          throw new Error(`Session ${sessionKey} dispatch barrier did not start`);
        }
        return placement;
      },
    });
  };
}

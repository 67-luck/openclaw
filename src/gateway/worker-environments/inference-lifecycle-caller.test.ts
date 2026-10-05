import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSessionLifecycleDrain } from "../server-methods/sessions-lifecycle-drain.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { registerWorkerInferenceSessionControl } from "./inference-control-internal.js";
import { REQUEST } from "./inference.test-support.js";
import type { WorkerEnvironmentServiceContract } from "./service-contract.js";

describe("worker inference lifecycle caller", () => {
  it.for(["start", "start-drain-release", "refusal", "after-start"] as const)(
    "retains accepted worker custody after the lifecycle caller reports %s failure",
    async (failureMode, { signal }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const entered = createDeferred();
        const drained = createDeferred();
        const startFailure = new Error("selected lifecycle boundary failed");
        const drainFailure = new Error("worker drain persistence failed");
        const releaseFailure = new Error("worker drain release failed");
        const refusal = new Error("worker drain acceptance refused");
        const unacceptedRelease = vi.fn();
        const cleanupFailures = new Set<unknown>();
        const cleanup = new AsyncWorkScope(cleanupFailures);
        const release = vi.fn(() => {
          if (failureMode === "start-drain-release") {
            throw releaseFailure;
          }
        });
        const start = vi.fn(() => {
          entered.resolve();
          if (failureMode !== "after-start") {
            throw startFailure;
          }
        });
        const unexpected = (): never => {
          throw new Error("Unexpected worker service operation during drain acquisition");
        };
        const workerService = {
          getDedicatedNodeLeaseSignal: unexpected,
          captureSessionAttachment: unexpected,
          getSessionAttachment: unexpected,
          findSessionAttachment: unexpected,
          getSessionAttachmentStatus: unexpected,
          assertSessionAttachment: unexpected,
          touchSessionAttachment: unexpected,
          execSessionAttachment: unexpected,
          createSessionAttachment: unexpected,
          destroySessionAttachment: unexpected,
          openNodePortal: unexpected,
          list: unexpected,
          readPreparedPoolSummary: unexpected,
          readReadyWorkerTarget: unexpected,
          get: () => undefined,
          inventoryVersion: unexpected,
          readMachineShape: unexpected,
          machineShapeVersion: unexpected,
          supportsExecutionMode: unexpected,
          readProviderDisplayId: unexpected,
          listMachineOptions: unexpected,
          listOperatingSystems: unexpected,
          prepare: unexpected,
          create: unexpected,
          destroy: unexpected,
          destroyUnattached: unexpected,
          observeDesktop: unexpected,
          launchDesktopApp: unexpected,
          startTunnel: unexpected,
          stopTunnel: unexpected,
        } satisfies WorkerEnvironmentServiceContract;
        registerWorkerInferenceSessionControl(workerService, {
          hasSession: () => true,
          reserveSessionDrain: () => ({
            assertReserved: () => {},
            release: unacceptedRelease,
            accept: () => {
              if (failureMode === "refusal") {
                entered.resolve();
                throw refusal;
              }
              return { drained: drained.promise, hasWork: () => true, start, release };
            },
          }),
          captureSessionCancellation: () => ({ runIds: [], cancel: async () => [] }),
          resolveSessionTargetForRunId: () => undefined,
        });
        const sessionKey = `agent:main:lifecycle-custody-${failureMode}`;
        const identities = [sessionKey, REQUEST.sessionId];
        const releaseRawDrain = () => drained.resolve();
        signal.addEventListener("abort", releaseRawDrain, { once: true });
        if (signal.aborted) {
          releaseRawDrain();
        }
        const preparing = prepareSessionLifecycleDrain({
          action: "delete",
          authorize: () => {
            if (failureMode === "after-start" && start.mock.calls.length > 0) {
              throw startFailure;
            }
          },
          context: createGatewayRequestContext(
            makeContextParams({
              workerEnvironmentService: workerService,
              connectionWork: { track: (run) => cleanup.track(run) },
            }),
          ),
          storePath: state.statePath("sessions.sqlite"),
          sessionKeys: [sessionKey],
          sessionId: REQUEST.sessionId,
          agentId: "main",
          sessionKey,
          lifecycleIdentities: identities,
        });
        const outcome = preparing.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        let successor: Promise<void> | undefined;
        try {
          await Promise.race([
            entered.promise,
            outcome.then(() => {
              throw new Error("Lifecycle caller returned before the selected worker boundary");
            }),
          ]);
          const result = await outcome;
          if (result.ok) {
            result.value.release();
            throw new Error("Lifecycle caller discarded its worker failure");
          }
          if (failureMode === "refusal") {
            expect(result.error).toBe(refusal);
            expect(unacceptedRelease).toHaveBeenCalledOnce();
            expect(start).not.toHaveBeenCalled();
            expect(release).not.toHaveBeenCalled();
          } else {
            // Caller failure is bounded; connection-owned raw cleanup still
            // holds admission until its accepted worker has really settled.
            expect(result.error).toBe(startFailure);
            expect(cleanup.hasPendingWork).toBe(true);
            expect(release).not.toHaveBeenCalled();
            let successorEntered = false;
            successor = withSessionTurn(
              {
                storePath: state.statePath("sessions.sqlite"),
                sessionKey,
                sessionId: REQUEST.sessionId,
              },
              async () => {
                successorEntered = true;
              },
            );
            await Promise.resolve();
            expect(successorEntered).toBe(false);
            if (failureMode === "start") {
              drained.resolve();
            } else {
              drained.reject(drainFailure);
            }
            await cleanup.drain();
            await successor;
            expect(successorEntered).toBe(true);
            expect(start).toHaveBeenCalledOnce();
            expect(unacceptedRelease).not.toHaveBeenCalled();
            expect(release).toHaveBeenCalledOnce();
            if (failureMode === "start") {
              expect(cleanupFailures).toEqual(new Set());
            } else {
              expect([...cleanupFailures]).toEqual([
                expect.objectContaining({
                  errors: [
                    startFailure,
                    drainFailure,
                    ...(failureMode === "start-drain-release" ? [releaseFailure] : []),
                  ],
                }),
              ]);
            }
          }
        } finally {
          releaseRawDrain();
          await outcome;
          await cleanup.drain();
          await successor;
          signal.removeEventListener("abort", releaseRawDrain);
        }
      });
    },
  );
});

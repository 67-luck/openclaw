import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  isEmbeddedAgentRunHandleActive,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunOwner,
} from "../../agents/embedded-agent-runner/runs.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { registerAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { getDiagnosticSessionActivitySnapshot } from "../../logging/diagnostic-run-activity.js";
import { recoverStuckDiagnosticSession } from "../../logging/diagnostic-stuck-session-recovery.runtime.js";
import {
  logSessionStateChange,
  startGatewayDiagnosticHeartbeat,
  stopGatewayDiagnosticHeartbeat,
} from "../../logging/diagnostic.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { isReplyRunEvidenceStale } from "../../sessions/session-controller.state.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { createWorkerLiveEventReceiver } from "./live-events.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import { getWorkerTurnExecutionIdentityCapability } from "./placement-turn-claim-events.js";
import {
  ENVIRONMENT_ID,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  credential,
  measureLaunchTurn,
  readLaunchToolNames,
  placements,
  seedActivePlacement,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";

describe("cloud worker run ownership", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it.each([
    { cancellation: "user", firstToolDelayMs: 0 },
    { cancellation: "deadline", firstToolDelayMs: 10 * 60_000 },
  ] as const)(
    "keeps a bounded remote tool alive until $cancellation cancellation after a $firstToolDelayMs ms tool-start delay",
    async ({ cancellation, firstToolDelayMs }) => {
      let now = Date.UTC(2026, 7, 29);
      const turnStartedAtMs = now;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      await seedActivePlacement();
      const launched = createDeferred();
      const finishLaunch = createDeferred();
      let workerSignal: AbortSignal | undefined;
      const environments: WorkerTurnEnvironmentService = {
        ...unusedEnvironments(),
        get: () => attachedEnvironment(),
        acquireTurnCredential: async () => credential(),
        acknowledgeCredentialDelivery: async () => true,
        startTunnel: async () => ({
          environmentId: ENVIRONMENT_ID,
          ownerEpoch: OWNER_EPOCH,
          runWorkspaceCommand: vi.fn(),
          quiesceWorkspace: vi.fn(),
          syncWorkspace: vi.fn(),
          reconcileWorkspace: vi.fn(),
          stop: vi.fn(),
          measureLaunchTurn,
          readLaunchToolNames,
          launchTurn: async (request) => {
            request.onDispatchReady?.();
            workerSignal = request.signal;
            launched.resolve();
            await Promise.race([
              finishLaunch.promise,
              new Promise<void>((resolve) => {
                request.signal?.addEventListener("abort", () => resolve(), { once: true });
              }),
            ]);
            throw new Error("worker turn cancelled");
          },
        }),
        stopTunnel: vi.fn(),
        destroy: vi.fn(async () => attachedEnvironment()),
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      const operation = createReplyOperation({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        resetTriggered: false,
      });
      operation.setPhase("running");
      const runId = "run-bounded-worker-tool";
      registerAgentRunContext(runId, {
        agentId: "main",
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
      });
      const input = {
        ...turn(runId),
        timeoutMs: 30 * 60_000,
        replyOperation: operation,
        abortSignal: operation.abortSignal,
      };
      const attempt = provider
        .executeTurn(
          { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId },
          input,
          vi.fn(),
        )
        .catch((error: unknown) => error);
      await launched.promise;
      const active = placements.get(SESSION_ID);
      if (!active) {
        throw new Error("expected active placement");
      }
      const turnClaim = projectWorkerSessionTurnClaim(active);
      if (!turnClaim) {
        throw new Error("expected admitted worker turn");
      }
      const turnCapability = getWorkerTurnExecutionIdentityCapability(placements, turnClaim);
      if (!turnCapability) {
        throw new Error("expected worker turn capability");
      }
      const identity: WorkerConnectionIdentity = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        sessionId: SESSION_ID,
        runId,
        turnClaim,
        credentialHash: "worker-test-credential-hash",
        bundleHash: "a".repeat(64),
        rpcSetVersion: 1,
        protocolFeatures: ["worker-live-event-v1"],
        credentialExpiresAtMs: Date.now() + input.timeoutMs,
      };
      const receiver = createWorkerLiveEventReceiver();
      now = turnStartedAtMs + firstToolDelayMs;
      const previousDiagnostics = areDiagnosticsEnabledForProcess();
      setDiagnosticsEnabledForProcess(true);
      logSessionStateChange({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        state: "processing",
      });
      startGatewayDiagnosticHeartbeat(
        createTestGatewayScheduler("fake-timers"),
        { diagnostics: { enabled: true } },
        {
          recoverStuckSession: recoverStuckDiagnosticSession,
          sampleLiveness: () => null,
        },
      );
      try {
        expect(
          await receiver.apply({
            readAckedSeq: () => 0,
            source: turnCapability,
            identity,
            request: {
              runEpoch: OWNER_EPOCH,
              lastAckedSeq: 0,
              seq: 1,
              runId,
              event: {
                kind: "tool",
                payload: {
                  phase: "start",
                  name: "sessions_spawn",
                  toolCallId: "child-provision",
                  args: {},
                },
              },
            },
          }),
        ).toEqual({ ok: true, result: { ackedSeq: 1 } });
        now = turnStartedAtMs + 20 * 60_000 + 1;

        expect(operation.abortSignal.aborted).toBe(false);
        expect(isReplyRunEvidenceStale(operation)).toBe(false);
        expect(workerSignal?.aborted).toBe(false);
        expect(placements.validateTurnClaim(turnClaim)).toBe(true);
        expect(getDiagnosticSessionActivitySnapshot({ sessionId: SESSION_ID })).toMatchObject({
          activeWorkKind: "tool_call",
          activeToolName: "sessions_spawn",
          hasActiveEmbeddedRun: true,
        });
        await expect(
          queueEmbeddedAgentMessageWithOutcomeAsync(SESSION_ID, "follow up"),
        ).resolves.toMatchObject({ queued: false, reason: "not_streaming" });
        if (cancellation === "user") {
          expect(resolveActiveEmbeddedRunOwner(SESSION_ID)?.abort()).toBe(true);
          expect(placements.validateTurnClaim(turnClaim)).toBe(true);
          await expect(turnCapability.run(async () => "late effect")).rejects.toThrow();
        } else {
          expect(
            await receiver.apply({
              readAckedSeq: () => 0,
              source: turnCapability,
              identity,
              request: {
                runEpoch: OWNER_EPOCH,
                lastAckedSeq: 1,
                seq: 2,
                runId,
                event: {
                  kind: "tool",
                  payload: {
                    phase: "update",
                    name: "sessions_spawn",
                    toolCallId: "child-provision",
                    partialResult: {},
                  },
                },
              },
            }),
          ).toEqual({ ok: true, result: { ackedSeq: 2 } });
          now = turnStartedAtMs + input.timeoutMs - 1;
          expect(isReplyRunEvidenceStale(operation)).toBe(false);
          now += 1;
          expect(isReplyRunEvidenceStale(operation)).toBe(true);
          await operation.watchdog.tick();
          expect(operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
        }
        expect(workerSignal?.aborted).toBe(true);
        await attempt;
        operation.complete();
        await operation.ownerSettlement;
        expect(isEmbeddedAgentRunHandleActive(SESSION_ID)).toBe(false);
        expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
        expect(
          getDiagnosticSessionActivitySnapshot({ sessionId: SESSION_ID }).activeWorkKind,
        ).toBeUndefined();
        expect(environments.destroy).not.toHaveBeenCalled();
      } finally {
        stopGatewayDiagnosticHeartbeat();
        setDiagnosticsEnabledForProcess(previousDiagnostics);
        finishLaunch.resolve();
        operation.abortByUser();
        await attempt;
        operation.complete();
        receiver.clear();
        clock.mockRestore();
      }
    },
  );

  it("uses accepted approval expiry and live custody without trusting worker events", async () => {
    const { captureWorkerTurnLiveEventOwner, createWorkerTurnRunOwner } =
      await import("./worker-turn-run-owner.js");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await seedActivePlacement();
    const runId = "worker-approval-wait";
    const claim = await placements.claimTurn({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      runId,
      claimId: "approval-wait-claim",
      owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
    });
    const operation = createReplyOperation({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      resetTriggered: false,
    });
    operation.setPhase("running");
    const worker = createWorkerTurnRunOwner({
      placements,
      claim,
      sessionKey: SESSION_KEY,
      turn: { ...turn(runId), timeoutMs: 30 * 60_000, replyOperation: operation },
    });
    const owner = captureWorkerTurnLiveEventOwner({ sessionId: SESSION_ID, turnClaim: claim });
    let pending = true;
    const expiresAtMs = now + 12 * 60_000;
    const wait = owner?.beginApprovalWait(expiresAtMs, () => pending);
    try {
      expect(wait).toBeDefined();
      clock.mockReturnValue(now + 7 * 60_000);
      expect(operation.watchdog.decide()).toMatchObject({
        action: "observe",
        reason: "approval",
        deadlineAtMs: expiresAtMs,
      });
      pending = false;
      expect(operation.watchdog.decide()).toMatchObject({
        action: "stop",
        reason: "semantic_stall",
      });
      pending = true;
      clock.mockReturnValue(expiresAtMs);
      expect(operation.watchdog.decide()).toMatchObject({
        action: "stop",
        reason: "semantic_stall",
      });
      wait?.close();
      expect(operation.watchdog.snapshot().waits).toEqual([]);
      await placements.releaseTurn(claim);
      owner?.beginApprovalWait(expiresAtMs + 60_000, () => true);
      expect(operation.watchdog.snapshot().waits).toEqual([]);
    } finally {
      wait?.close();
      worker.dispose();
      operation.complete();
      clock.mockRestore();
    }
  });

  it.each(["replacement", "claim-loss", "shutdown"] as const)(
    "fences retained event recorders after %s, including a reused run ID",
    async (closure) => {
      const { captureWorkerTurnLiveEventOwner, createWorkerTurnRunOwner } =
        await import("./worker-turn-run-owner.js");
      await seedActivePlacement();
      const runId = "reused-worker-run";
      const claimInput = {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        runId,
        owner: { kind: "worker" as const, environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
      };
      const firstClaim = await placements.claimTurn({ ...claimInput, claimId: "first-claim" });
      const operation = createReplyOperation({
        sessionKey: SESSION_KEY,
        sessionId: SESSION_ID,
        agentId: "main",
        resetTriggered: false,
      });
      const first = createWorkerTurnRunOwner({
        placements,
        claim: firstClaim,
        turn: { ...turn(runId), replyOperation: operation },
        sessionKey: SESSION_KEY,
      });
      const identity: WorkerConnectionIdentity = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        sessionId: SESSION_ID,
        runId,
        turnClaim: firstClaim,
        credentialHash: "test",
        bundleHash: "a".repeat(64),
        rpcSetVersion: 1,
        protocolFeatures: [],
        credentialExpiresAtMs: Date.now() + 60_000,
      };
      const eventOwner = captureWorkerTurnLiveEventOwner(identity);
      expect(eventOwner?.record).toBeTypeOf("function");
      const event = {
        kind: "tool" as const,
        payload: {
          phase: "start" as const,
          name: "sessions_spawn",
          toolCallId: "stale-tool",
          args: {},
        },
      };
      let replacement: ReturnType<typeof createWorkerTurnRunOwner> | undefined;
      let replacementOperation: ReturnType<typeof createReplyOperation> | undefined;
      try {
        if (closure === "shutdown") {
          rotateAgentEventLifecycleGeneration();
          expect(resolveActiveEmbeddedRunOwner(SESSION_ID)).toBeUndefined();
          expect(first.signal.aborted).toBe(true);
        } else {
          await placements.releaseTurn(firstClaim);
          if (closure === "replacement") {
            first.dispose();
            operation.complete();
            await operation.ownerSettlement;
            const nextClaim = await placements.claimTurn({
              ...claimInput,
              claimId: "replacement-claim",
            });
            replacementOperation = createReplyOperation({
              sessionKey: SESSION_KEY,
              sessionId: SESSION_ID,
              agentId: "main",
              resetTriggered: false,
            });
            replacement = createWorkerTurnRunOwner({
              placements,
              claim: nextClaim,
              turn: { ...turn(runId), replyOperation: replacementOperation },
              sessionKey: SESSION_KEY,
            });
            expect(captureWorkerTurnLiveEventOwner(identity)).toBeUndefined();
            const current = captureWorkerTurnLiveEventOwner({
              ...identity,
              turnClaim: nextClaim,
            });
            current?.record({
              ...event,
              payload: { ...event.payload, toolCallId: "current-tool", name: "exec" },
            });
          }
        }
        eventOwner?.record(event);
        expect(eventOwner?.isCancelled()).toBe(false);
        const activity = getDiagnosticSessionActivitySnapshot({ sessionId: SESSION_ID });
        expect(activity.activeToolCallId).toBe(
          closure === "replacement" ? "current-tool" : undefined,
        );
        first.dispose();
        expect(isEmbeddedAgentRunHandleActive(SESSION_ID)).toBe(closure === "replacement");
      } finally {
        first.dispose();
        replacement?.dispose();
        replacementOperation?.complete();
        operation.complete();
      }
    },
  );
});

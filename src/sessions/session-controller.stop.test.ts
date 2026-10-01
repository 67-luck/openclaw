import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  registerInternalHook,
  unregisterInternalHook,
  type InternalHookEvent,
} from "../hooks/internal-hooks.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withSessionTurn } from "./session-controller.admission.js";
import { captureSessionTarget } from "./session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
  retireSessionControllerSourceCancellation,
} from "./session-controller.mailbox.js";
import {
  captureSessionControllerStop,
  stopSession,
  type SessionStopSource,
} from "./session-controller.stop.js";

function fixture() {
  const sessionKey = "agent:main:stop-boundary";
  const sessionId = randomUUID();
  const target = captureSessionTarget({
    storeScope: "/synthetic/stop/" + sessionId,
    sessionKey,
    incarnation: sessionId,
    agentId: "main",
  });
  const reserve = (protocolRunId: string) =>
    reserveSessionControllerSource(sessionKey, {
      target,
      protocolRunId,
      policy: { mode: "followup" },
    });
  return { sessionKey, sessionId, target, reserve };
}

const policyCases = [
  ["channel-user", true, true, true, true],
  ["client-session", true, true, false, true],
  ["client-run", true, true, false, true],
  ["interrupt", false, false, false, false],
  ["restart", false, false, false, false],
  ["watchdog", false, false, false, false],
  ["operator-revocation", false, false, false, false],
  ["supersede", false, false, false, false],
] as const satisfies ReadonlyArray<
  readonly [SessionStopSource, boolean, boolean, boolean, boolean]
>;

describe("captured session Stop", () => {
  it.each(policyCases)(
    "applies the %s policy",
    async (source, cancelQueued, stopsChildren, recordsCutoff, firesHook) => {
      const f = fixture();
      const active = f.reserve("active");
      const running = createDeferredCore();
      const release = createDeferredCore();
      const execution = withSessionTurn(
        {
          sessionKey: f.sessionKey,
          sessionId: f.sessionId,
          storePath: f.target.storeScope,
          controllerInput: active,
        },
        async () => {
          running.resolve();
          await release.promise;
        },
      );
      await running.promise;
      const queued = f.reserve("queued");
      const hookEvents: InternalHookEvent[] = [];
      const hook = vi.fn((event: InternalHookEvent) => {
        hookEvents.push(event);
      });
      registerInternalHook("command:stop", hook);
      const stopChildren = vi.fn(async (applyParentStop: () => Promise<boolean>) => {
        await applyParentStop();
        return { stopped: 2, failed: 1 };
      });
      const recordAbortTarget = vi.fn(async (_options: { recordCutoff: boolean }) => {});

      try {
        const outcome = await stopSession({
          source,
          capture: captureSessionControllerStop({ inputs: [active, queued] }),
          messageIdentity: { messageId: "m1" },
          recordAbortTarget,
          hookContext: firesHook
            ? {
                sessionKey: f.sessionKey,
                sessionId: f.sessionId,
                commandSource: "test-client",
                senderId: "sender-1",
              }
            : undefined,
          stopChildren,
        }).completed;

        expect(outcome.aborted).toBe(true);
        expect(outcome.alreadyFinalizing).toBe(false);
        expect(outcome.activeCancelled).toBe(1);
        expect(outcome.queuedCancelled).toBe(cancelQueued ? 1 : 0);
        expect(queued.abortSignal.aborted).toBe(cancelQueued);
        expect(stopChildren).toHaveBeenCalledTimes(stopsChildren ? 1 : 0);
        expect(outcome.childrenStopped).toBe(stopsChildren ? 2 : 0);
        expect(outcome.childFailures).toBe(stopsChildren ? 1 : 0);
        expect(recordAbortTarget).toHaveBeenCalledOnce();
        expect(recordAbortTarget).toHaveBeenCalledWith({ recordCutoff: recordsCutoff });
        expect(hook).toHaveBeenCalledTimes(firesHook ? 1 : 0);
        if (firesHook) {
          expect(hookEvents[0]).toMatchObject({
            type: "command",
            action: "stop",
            sessionKey: f.sessionKey,
            context: {
              sessionId: f.sessionId,
              commandSource: "test-client",
              senderId: "sender-1",
            },
          });
        }
      } finally {
        unregisterInternalHook("command:stop", hook);
        if (!queued.abortSignal.aborted) {
          retireSessionControllerInput(queued);
        }
        release.resolve();
        await execution.catch(() => undefined);
      }
    },
  );

  it("keeps user cleanup and the hook when the active run is already finishing", async () => {
    const f = fixture();
    const active = f.reserve("active");
    const running = createDeferredCore();
    const release = createDeferredCore();
    const execution = withSessionTurn(
      {
        sessionKey: f.sessionKey,
        sessionId: f.sessionId,
        storePath: f.target.storeScope,
        controllerInput: active,
      },
      async () => {
        running.resolve();
        await release.promise;
      },
    );
    await running.promise;
    active.claim?.operation?.freezeAbort();
    const queued = f.reserve("queued");
    const hook = vi.fn();
    registerInternalHook("command:stop", hook);
    const stopChildren = vi.fn(async (applyParentStop: () => Promise<boolean>) => {
      await applyParentStop();
      return { stopped: 1, failed: 0 };
    });

    try {
      const outcome = await stopSession({
        source: "channel-user",
        capture: captureSessionControllerStop({ inputs: [active, queued] }),
        hookContext: { sessionKey: f.sessionKey },
        stopChildren,
      }).completed;

      expect(outcome).toMatchObject({
        aborted: false,
        alreadyFinalizing: true,
        queuedCancelled: 1,
        activeCancelled: 0,
        childrenStopped: 1,
      });
      expect(queued.abortSignal.aborted).toBe(true);
      expect(active.abortSignal.aborted).toBe(false);
      expect(stopChildren).toHaveBeenCalledOnce();
      expect(hook).toHaveBeenCalledOnce();
    } finally {
      unregisterInternalHook("command:stop", hook);
      release.resolve();
      await execution;
    }
  });

  it("withdraws queued sources before signaling the active producer without stopping a successor", async () => {
    const f = fixture();
    const active = f.reserve("active");
    const running = createDeferredCore();
    const release = createDeferredCore();
    const execution = withSessionTurn(
      {
        sessionKey: f.sessionKey,
        sessionId: f.sessionId,
        storePath: f.target.storeScope,
        controllerInput: active,
      },
      async () => {
        running.resolve();
        await release.promise;
      },
    );
    await running.promise;
    const queued = f.reserve("queued");
    const capture = captureSessionControllerStop({ targets: [f.target] });
    let successor: ReturnType<typeof f.reserve> | undefined;
    let observedQueue = false;
    active.abortSignal.addEventListener(
      "abort",
      () => {
        observedQueue = queued.abortSignal.aborted;
        successor = f.reserve("successor");
      },
      { once: true },
    );
    const result = await stopSession({
      source: "client-session",
      capture,
      hookContext: {
        sessionKey: f.sessionKey,
      },
    }).completed;
    expect(observedQueue).toBe(true);
    expect(result.queuedCancelled).toBe(1);
    expect(result.activeCancelled).toBe(1);
    expect(successor?.abortSignal.aborted).toBe(false);
    release.resolve();
    await execution.catch(() => undefined);
    await capture.settled;
    if (successor) {
      retireSessionControllerInput(successor);
    }
  });

  it("does not escalate a cancellation-retired source into an aggregate operation Stop", async () => {
    const f = fixture();
    const source = f.reserve("collected-sibling");
    const running = createDeferredCore();
    const release = createDeferredCore();
    const execution = withSessionTurn(
      {
        sessionKey: f.sessionKey,
        sessionId: f.sessionId,
        storePath: f.target.storeScope,
        controllerInput: source,
      },
      async () => {
        running.resolve();
        await release.promise;
      },
    );
    await running.promise;
    retireSessionControllerSourceCancellation(source);
    const result = await stopSession({
      source: "client-run",
      capture: captureSessionControllerStop({ inputs: [source] }),
      hookContext: { sessionKey: f.sessionKey },
    }).completed;
    expect(result.activeCancelled + result.queuedCancelled).toBe(0);
    expect(source.claim?.operation?.abortSignal.aborted).toBe(false);
    release.resolve();
    await execution;
  });

  it("lets a publication adapter invoke only its exact once-guarded primitive", async () => {
    const f = fixture();
    const source = f.reserve("run");
    let signals = 0;
    source.abortSignal.addEventListener("abort", () => signals++);
    const result = await stopSession({
      source: "client-run",
      capture: captureSessionControllerStop({ inputs: [source] }),
      hookContext: { sessionKey: f.sessionKey },
      cancelInput: (_source, cancel) => {
        expect(cancel()).toBe(true);
        expect(cancel()).toBe(true);
        return false;
      },
    }).completed;
    expect(signals).toBe(1);
    expect(result.queuedCancelled).toBe(1);
  });

  it("revalidates authority before each adapter-owned cancellation", async () => {
    const f = fixture();
    const first = f.reserve("first");
    const second = f.reserve("second");
    let current = true;
    first.abortSignal.addEventListener("abort", () => {
      current = false;
    });

    await expect(
      stopSession({
        source: "client-session",
        capture: captureSessionControllerStop({ inputs: [first, second] }),
        assertCurrent: () => {
          if (!current) {
            throw new Error("requester authority changed");
          }
        },
        hookContext: { sessionKey: f.sessionKey },
        cancelInput: (_input, cancel) => cancel(),
      }).completed,
    ).rejects.toThrow("requester authority changed");
    expect(first.abortSignal.aborted).toBe(true);
    expect(second.abortSignal.aborted).toBe(false);
    retireSessionControllerInput(second);
  });
});

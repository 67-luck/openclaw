import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { withSessionTurn } from "./session-controller.admission.js";
import { captureSessionTarget } from "./session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
  retireSessionControllerSourceCancellation,
} from "./session-controller.mailbox.js";
import { captureSessionControllerStop, stopSessionController } from "./session-controller.stop.js";

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

describe("captured session Stop", () => {
  it("withdraws queued sources before signaling the active producer and never stops a reentrant successor", async () => {
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
    const queued = f.reserve(" queued ");
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
    const result = stopSessionController(capture, { source: "gateway" });
    expect(observedQueue).toBe(true);
    expect(result.queuedCancelled).toBe(1);
    expect(result.activeCancelled).toBe(1);
    expect(successor?.abortSignal.aborted).toBe(false);
    let settled = false;
    void capture.settled.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    await execution;
    await capture.settled;
    expect(settled).toBe(true);
    if (successor) {
      retireSessionControllerInput(successor);
    }
  });

  it("revalidates each source effect without abandoning earlier committed cancellation", () => {
    const f = fixture();
    const first = f.reserve("a");
    const second = f.reserve("b");
    const capture = captureSessionControllerStop({ inputs: [first, second] });
    let current = true;
    first.abortSignal.addEventListener(
      "abort",
      () => {
        current = false;
      },
      { once: true },
    );
    const committed: unknown[] = [];
    expect(() =>
      stopSessionController(capture, {
        source: "gateway",
        assertCurrent: () => {
          if (!current) {
            throw new Error("requester revoked");
          }
        },
        onCancelled: (source) => committed.push(source),
      }),
    ).toThrow("requester revoked");
    expect(committed).toEqual([first]);
    expect(first.abortSignal.aborted).toBe(true);
    expect(second.abortSignal.aborted).toBe(false);
    retireSessionControllerInput(second);
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
    const result = stopSessionController(captureSessionControllerStop({ inputs: [source] }), {
      source: "gateway",
    });
    expect(result.activeCancelled + result.queuedCancelled).toBe(0);
    expect(source.claim?.operation?.abortSignal.aborted).toBe(false);
    release.resolve();
    await execution;
  });

  it("lets a publication adapter invoke only its exact once-guarded primitive", () => {
    const f = fixture();
    const source = f.reserve("run");
    let signals = 0;
    source.abortSignal.addEventListener("abort", () => signals++);
    const result = stopSessionController(captureSessionControllerStop({ inputs: [source] }), {
      source: "gateway",
      cancelInput: (_source, cancel) => {
        expect(cancel()).toBe(true);
        expect(cancel()).toBe(true);
        return false;
      },
    });
    expect(signals).toBe(1);
    expect(result.abortedInputs).toEqual([source]);
  });
});

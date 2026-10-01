import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { withSessionTurn } from "./session-controller.admission.js";
import {
  beginSessionEffect,
  bindSessionControllerTarget,
  captureSessionTarget,
  captureGatewaySessionControllerWork,
  isSessionMutationActive,
  runSessionMutation,
  startSessionControllerInterruption,
  withSessionControllerOwner,
} from "./session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
  claimSessionControllerTask,
  releaseSessionControllerClaim,
} from "./session-controller.mailbox.js";
import { createReplyOperation } from "./session-controller.operation.js";

it.each([
  ["wait", "operation"],
  ["preempt", "operation"],
  ["wait", "claim"],
  ["preempt", "claim"],
] as const)("%s mutation does not capture another incarnation's %s", async (policy, kind) => {
  vi.useFakeTimers();
  const target = captureSessionTarget({
    storeScope: "/synthetic/mutation-incarnation/sessions.json",
    sessionKey: `agent:main:mutation-${policy}-${kind}`,
    incarnation: "new",
  });
  const old = captureSessionTarget({
    storeScope: target.storeScope,
    sessionKey: target.sessionKey,
    incarnation: "old",
  });
  const operation =
    kind === "operation"
      ? createReplyOperation({
          sessionKey: target.sessionKey,
          sessionId: "new",
          target,
          resetTriggered: false,
        })
      : undefined;
  const input =
    kind === "claim"
      ? reserveSessionControllerSource(target.sessionKey, { target, policy: { mode: "followup" } })
      : undefined;
  const claim = input ? await claimSessionControllerTask(input, () => {}) : undefined;
  let ran = false;
  const mutation = runSessionMutation({
    target: old,
    requiredSessionId: "old",
    policy,
    run: async () => {
      ran = true;
    },
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(operation?.abortSignal.aborted ?? claim?.abortController.signal.aborted).toBe(false);
    expect(ran).toBe(true);
  } finally {
    operation?.complete();
    if (claim) {
      releaseSessionControllerClaim(claim);
      await claim.settlement.promise;
    }
    await mutation;
    vi.useRealTimers();
  }
});

it("captures unbound Gateway work by its source owner, not the stack that wakes it", async () => {
  const target = captureSessionTarget({
    storeScope: "gateway-claim.sqlite",
    sessionKey: "agent:main:gateway-claim",
    incarnation: "gateway-claim-id",
  });
  const gatewayA = () => {
    throw new Error("capture must not resolve a Gateway context");
  };
  const gatewayB = () => {
    throw new Error("capture must not resolve a Gateway context");
  };
  const firstStarted = createDeferred();
  const firstFinish = createDeferred();
  const secondStarted = createDeferred();
  const secondFinish = createDeferred();
  const cleanupStarted = createDeferred();
  const cleanupFinish = createDeferred();
  const first = withPluginRuntimeGatewayContextResolver(gatewayA, () =>
    withSessionTurn({ sessionKey: target.sessionKey, target }, async () => {
      firstStarted.resolve();
      await firstFinish.promise;
    }),
  );
  await firstStarted.promise;
  const input = withPluginRuntimeGatewayContextResolver(gatewayB, () =>
    reserveSessionControllerSource(target.sessionKey, {
      target,
      policy: { mode: "followup" },
      adapter: {
        onSettled: async () => {
          cleanupStarted.resolve();
          await cleanupFinish.promise;
        },
      },
    }),
  );
  // Gateway A's completion wakes B's selected source before any operation exists.
  const second = withSessionTurn(
    { sessionKey: target.sessionKey, target, controllerInput: input },
    async (operation) => {
      expect(operation).toBeUndefined();
      secondStarted.resolve();
      await secondFinish.promise;
    },
  );
  const query = {
    scope: target.storeScope,
    sessionKey: target.sessionKey,
    sessionId: "gateway-claim-id",
  };
  try {
    firstFinish.resolve();
    await first;
    await secondStarted.promise;
    const claim = input.claim;
    if (!claim) {
      throw new Error("selected source has no claim");
    }
    const captured = captureGatewaySessionControllerWork(gatewayB);
    expect(captured.targets.get(target.storeScope)).toContain(target.sessionKey);
    expect(captured.isActive(query)).toBe(true);
    expect(captureGatewaySessionControllerWork(gatewayA).isActive(query)).toBe(false);
    secondFinish.resolve();
    await second;
    await cleanupStarted.promise;
    expect(captured.isActive(query)).toBe(true);
    cleanupFinish.resolve();
    await claim.settlement.promise;
    expect(captured.isActive(query)).toBe(false);
    await withPluginRuntimeGatewayContextResolver(gatewayB, () =>
      withSessionTurn({ sessionKey: target.sessionKey, target }, async () => {
        expect(captured.isActive(query)).toBe(false);
        expect(captureGatewaySessionControllerWork(gatewayB).isActive(query)).toBe(true);
      }),
    );
  } finally {
    firstFinish.resolve();
    secondFinish.resolve();
    cleanupFinish.resolve();
    await Promise.all([first, second, input.settlement.promise]);
  }
});

it("retains a frozen controller owner through refused preemption until its actual settlement", async () => {
  const target = captureSessionTarget({
    storeScope: "frozen-owner.sqlite",
    sessionKey: "agent:main:frozen-owner",
    incarnation: "frozen-id",
  });
  const operation = createReplyOperation({
    sessionKey: target.sessionKey,
    sessionId: "frozen-id",
    resetTriggered: false,
  });
  bindSessionControllerTarget(operation, target);
  operation.freezeAbort();
  const prepared = createDeferred();
  let mutated = false;
  const mutation = runSessionMutation({
    target,
    policy: "preempt",
    prepare: async () => {
      prepared.resolve();
    },
    run: async () => {
      mutated = true;
    },
  });
  await prepared.promise;
  expect(operation.abortByUser()).toBe(false);
  expect(mutated).toBe(false);
  expect(isSessionMutationActive(target.storeScope, target.aliases)).toBe(true);
  let admitted = false;
  const effect = beginSessionEffect({
    target,
    assertAllowed: () => {
      admitted = true;
    },
  });
  await Promise.resolve();
  expect(admitted).toBe(false);
  operation.complete();
  await mutation;
  (await effect).release();
  expect(mutated).toBe(true);
  expect(admitted).toBe(true);
});

it("borrows the exact in-band owner without interrupting or awaiting its own stack", async () => {
  const target = captureSessionTarget({
    storeScope: "own-stack.sqlite",
    sessionKey: "agent:main:own-stack",
    incarnation: "own-id",
  });
  const operation = createReplyOperation({
    sessionKey: target.sessionKey,
    sessionId: "own-id",
    resetTriggered: false,
  });
  bindSessionControllerTarget(operation, target);
  try {
    await withSessionControllerOwner(operation, () =>
      runSessionMutation({
        target,
        policy: "preempt",
        run: async () => {
          const interruption = startSessionControllerInterruption({ target });
          await interruption.released;
          expect(operation.abortSignal.aborted).toBe(false);
        },
      }),
    );
  } finally {
    operation.complete();
  }
});

it("sharing can revoke a live turn while scoped effects remain subordinate to it", async () => {
  const target = captureSessionTarget({
    storeScope: "live-sharing.sqlite",
    sessionKey: "agent:main:live-sharing",
    incarnation: "sharing-id",
  });
  const operation = createReplyOperation({
    sessionKey: target.sessionKey,
    sessionId: "sharing-id",
    resetTriggered: false,
  });
  bindSessionControllerTarget(operation, target);
  const effect = await beginSessionEffect({ target, operation, assertAllowed: () => {} });
  let revoked = false;
  try {
    await runSessionMutation({
      target,
      policy: "allow-live",
      run: async () => {
        revoked = true;
      },
    });
    expect(revoked).toBe(true);
    expect(operation.abortSignal.aborted).toBe(false);
    expect(effect.isActive()).toBe(true);
  } finally {
    effect.release();
    operation.complete();
  }
});

it("release cannot manufacture completion while captured writer cleanup is still running", async () => {
  const target = captureSessionTarget({
    storeScope: "retained-effect.sqlite",
    sessionKey: "agent:main:retained-effect",
  });
  const effect = await beginSessionEffect({ target, assertAllowed: () => {} });
  const entered = createDeferred();
  const finish = createDeferred();
  const running = effect.run(async () => {
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  const interruption = startSessionControllerInterruption({ target });
  let settled = false;
  void interruption.released.then(() => {
    settled = true;
  });
  effect.release();
  await Promise.resolve();
  expect(effect.isActive()).toBe(false);
  expect(settled).toBe(false);
  finish.resolve();
  await running;
  await interruption.released;
  expect(settled).toBe(true);
});

it.each(["wait", "preempt"] as const)(
  "%s mutation joins unclaimed source cleanup without blocking a foreign store",
  async (policy) => {
    const target = captureSessionTarget({
      storeScope: "retiring-source.sqlite",
      sessionKey: "agent:main:retiring-source",
      incarnation: "retiring-source-id",
    });
    const cleanup = createDeferred();
    const input = reserveSessionControllerSource(target.sessionKey, {
      target,
      policy: { mode: "followup" },
      adapter: { onSettled: () => cleanup.promise },
    });
    retireSessionControllerInput(input);
    let ran = false;
    const mutation = runSessionMutation({
      target,
      policy,
      run: async () => {
        ran = true;
      },
    });
    try {
      // The same mutation path in another physical store proves the scheduler progressed.
      await runSessionMutation({
        target: captureSessionTarget({ ...target, storeScope: "foreign-source.sqlite" }),
        policy,
        run: async () => {},
      });
      expect(ran).toBe(false);
    } finally {
      cleanup.resolve();
      await input.settlement.promise;
      await mutation;
    }
    expect(ran).toBe(true);
  },
);

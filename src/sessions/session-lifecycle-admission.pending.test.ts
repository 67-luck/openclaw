import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createAgentRunDirectAbortError } from "../agents/run-termination.js";
import {
  beginSessionEffect,
  collectSessionControllerTargets,
  getSessionControllerWorkCount,
  captureSessionControllerSettlement,
  interruptSessionControllerEffects,
  isCompetingSessionControllerWorkActive,
  isSessionControllerWorkActive,
  captureGatewaySessionControllerWork,
  runSessionMutation,
  startSessionControllerInterruption,
} from "./session-controller.lifecycle.js";

it("rejects arrivals during awaited cleanup and its final microtask, then reopens only after release", async () => {
  const scope = "hostile-await.sqlite";
  const identities = ["agent:main:fence", "fence-session"];
  const entered = createDeferred();
  const release = createDeferred();
  const reason = createAgentRunDirectAbortError();
  let lateResult: unknown;
  const late = () =>
    beginSessionEffect({ scope, identities, assertAllowed: () => {} }).then(
      (lease) => {
        lease.release();
        return "incorrectly admitted";
      },
      (error: unknown) => error,
    );
  const stop = runSessionMutation({
    scope,
    identities,
    prepare: async (owner) => {
      owner.closeWorkAdmissions(reason);
      entered.resolve();
      await release.promise;
    },
    run: async () => {},
    finalize: async () => {
      await Promise.resolve();
      lateResult = await late();
    },
  });
  await entered.promise;
  try {
    const whileAwaiting = await late();
    expect(whileAwaiting).toBe(reason);
    const other = await beginSessionEffect({
      scope,
      identities: ["other-session"],
      assertAllowed: () => {},
    });
    other.release();
    release.resolve();
    await stop;
    expect(lateResult).toBe(reason);
    const fresh = await beginSessionEffect({ scope, identities, assertAllowed: () => {} });
    fresh.release();
  } finally {
    release.resolve();
    await stop;
  }
});

it("interrupts a preexisting non-chat pending attempt without classifying it as active work", async () => {
  const scope = "non-chat-pending.sqlite";
  const resolveGatewayContext = () => undefined;
  const identities = ["agent:main:pending", "pending-session"] as const;
  const entered = createDeferred();
  const release = createDeferred();
  const interrupted = vi.fn();
  let validated = false;
  const blocker = runSessionMutation({
    scope,
    identities,
    prepare: async () => {
      entered.resolve();
      await release.promise;
    },
    run: async () => {},
  });
  await entered.promise;
  const pending = beginSessionEffect({
    scope,
    identities,
    onInterrupt: interrupted,
    resolveGatewayContext,
    assertAllowed: () => {
      validated = true;
    },
  }).then(
    (lease) => {
      lease.release();
      return "incorrectly admitted";
    },
    (error: unknown) => error,
  );
  try {
    expect(isSessionControllerWorkActive(scope, identities)).toBe(false);
    expect(
      captureGatewaySessionControllerWork(resolveGatewayContext).isActive({
        scope,
        sessionKey: identities[0],
        sessionId: identities[1],
      }),
    ).toBe(false);
    expect(isCompetingSessionControllerWorkActive(scope, identities)).toBe(false);
    expect(captureSessionControllerSettlement({ scope, identities })).toBeUndefined();
    expect(collectSessionControllerTargets().get(scope)).toBeUndefined();
    expect(getSessionControllerWorkCount()).toBe(0);
    const reason = createAgentRunDirectAbortError();
    expect(
      await interruptSessionControllerEffects({ scope, identities, reason, timeoutMs: 1000 }),
    ).toBe(true);
    expect(await pending).toBe(reason);
    expect(interrupted).toHaveBeenCalledOnce();
    expect(interrupted).toHaveBeenCalledWith(reason);
    expect(validated).toBe(false);
  } finally {
    release.resolve();
    await blocker;
    await pending;
  }
});

it("ordinary compaction still queues work and acquired-release queries do not deadlock it", async () => {
  const scope = "compaction.sqlite";
  const identities = ["compaction-session"];
  const entered = createDeferred();
  const release = createDeferred();
  let validated = false;
  const compaction = runSessionMutation({
    scope,
    identities,
    kind: "compaction",
    prepare: async () => {
      entered.resolve();
      await release.promise;
      await captureSessionControllerSettlement({ scope, identities });
    },
    run: async () => {},
  });
  await entered.promise;
  const pending = beginSessionEffect({
    scope,
    identities,
    assertAllowed: () => {
      validated = true;
    },
  });
  try {
    expect(validated).toBe(false);
    release.resolve();
    await compaction;
    const lease = await pending;
    expect(validated).toBe(true);
    lease.release();
  } finally {
    release.resolve();
    await compaction;
    (await pending).release();
  }
});

it("single-use identity iterators still wait for the exact lifecycle fence", async () => {
  const scope = "generator.sqlite";
  const identities = ["generator-session"];
  const entered = createDeferred();
  const release = createDeferred();
  let validated = false;
  const mutation = runSessionMutation({
    scope,
    identities,
    prepare: async () => {
      entered.resolve();
      await release.promise;
    },
    run: async () => {},
  });
  await entered.promise;
  const admission = beginSessionEffect({
    scope,
    identities: (function* () {
      yield identities[0];
    })(),
    assertAllowed: () => {
      validated = true;
    },
  });
  try {
    const unrelated = await beginSessionEffect({
      scope,
      identities: ["unrelated-generator"],
      assertAllowed: () => {},
    });
    unrelated.release();
    expect(validated).toBe(false);
    release.resolve();
    await mutation;
    const lease = await admission;
    expect(validated).toBe(true);
    lease.release();
  } finally {
    release.resolve();
    await mutation;
    (await admission).release();
  }
});

it("an initial validator finishing after pending cancellation cannot enter the writer", async () => {
  const scope = "initial-validator.sqlite";
  const identities = ["initial-validator-session"];
  const entered = createDeferred();
  const release = createDeferred();
  const writer = vi.fn();
  const reason = createAgentRunDirectAbortError();
  const pending = beginSessionEffect({
    scope,
    identities,
    assertAllowed: async () => {
      entered.resolve();
      await release.promise;
    },
    revalidateAllowed: writer,
  }).then(
    (lease) => {
      lease.release();
      return "incorrectly admitted";
    },
    (error: unknown) => error,
  );
  await entered.promise;
  try {
    const interruption = startSessionControllerInterruption({ scope, identities, reason });
    let drained = false;
    void interruption.released.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release.resolve();
    expect(await pending).toBe(reason);
    await interruption.released;
    await runSessionMutation({ scope, identities, run: async () => {} });
    expect(writer).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await pending;
  }
});

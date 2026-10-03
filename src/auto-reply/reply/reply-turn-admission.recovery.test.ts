import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "../../agents/main-session-recovery/main-session-recovery-admission.js";
import * as recoveryLifecycle from "../../agents/main-session-recovery/main-session-recovery-lifecycle.js";
import * as recoveryOwnerRelease from "../../agents/main-session-recovery/main-session-recovery-owner-release.js";
import * as recoveryStore from "../../agents/main-session-recovery/main-session-recovery-store.js";
import * as restartRecovery from "../../agents/main-session-recovery/main-session-restart-recovery.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  createReplyOperation,
  getSessionControllerOperation,
} from "../../sessions/session-controller.js";
import {
  beginSessionEffect,
  consumeSessionEffectHandoff,
  captureSessionEffectOwnerSettlement,
  captureSessionControllerSettlement,
  isCompetingSessionControllerWorkActive,
  runSessionMutation,
  type SessionEffectRef,
} from "../../sessions/session-controller.lifecycle.js";
import * as sessionLifecycle from "../../sessions/session-controller.lifecycle.js";

import { testing } from "./reply-run-registry.test-support.js";
import { admitTestReplyTurn, createSessionStore } from "./reply-turn-admission.test-support.js";

type Admission = Awaited<ReturnType<typeof admitTestReplyTurn>>;
const sessionKey = "agent:main:main";
const sessionId = "interrupted-session";
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) {
    await dispose();
  }
  testing.resetReplyRunRegistry();
  vi.restoreAllMocks();
});
function createRecoveryGatewayContext() {
  const recoveryRuntime: GatewayRecoveryRuntime = {
    dispatchSessionMethod: vi.fn(),
    dispatchAgent: vi.fn(),
    waitForAgent: vi.fn(),
    sendRecoveryNotice: vi.fn(),
  };
  // The recovery boundary supplies execution; admission consumes these capabilities.
  return { getRuntimeConfig: () => ({}), recoveryRuntime } as GatewayRequestContext;
}

describe("reply turn recovery admission", () => {
  afterEach(() => {
    testing.resetReplyRunRegistry();
  });

  it("keeps deferred owner release retries from retaining a successor", async () => {
    const deferredReleases: Promise<void>[] = [];
    const schedule = recoveryLifecycle.scheduleMainSessionRecoveryMutation;
    const scheduled = vi
      .spyOn(recoveryLifecycle, "scheduleMainSessionRecoveryMutation")
      .mockImplementation((params) => {
        const settled = createDeferred();
        deferredReleases.push(settled.promise);
        schedule({
          ...params,
          onSuccess: async (result) => {
            await params.onSuccess(result);
            settled.resolve();
          },
        });
      });
    const pendingTarget = vi
      .spyOn(recoveryOwnerRelease, "scheduleMainSessionRecoveryPendingTarget")
      .mockImplementation(() => {});
    let restoreAccessor: (() => void) | undefined;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const sessionKey = "agent:main:telegram:topic:deferred-recovery-release";
      const sessionId = "interrupted-session";
      const storePath = createSessionStore({
        [sessionKey]: {
          sessionId,
          updatedAt: 100,
          status: "running",
          abortedLastRun: true,
          mainRestartRecovery: {
            cycleId: "cycle-1",
            revision: 1,
            chargedAttempts: 0,
          },
        },
      });
      const owner = await admitTestReplyTurn({
        sessionKey,
        sessionId,
        expectedSessionId: sessionId,
        storePath,
      });
      expect(owner.status).toBe("owned");
      if (owner.status !== "owned") {
        return;
      }
      const applySessionEntryReplacements = sessionAccessor.applySessionEntryReplacements;
      const failedWrites = Array.from({ length: 3 }, () => createDeferred());
      let failures = 0;
      const accessorSpy = vi
        .spyOn(sessionAccessor, "applySessionEntryReplacements")
        .mockImplementation(async (params) => {
          const failedWrite = failedWrites[failures];
          if (failedWrite) {
            failures += 1;
            failedWrite.resolve();
            throw new Error("SQLite session entry changed before replacement");
          }
          return await applySessionEntryReplacements(params);
        });

      restoreAccessor = () => accessorSpy.mockRestore();
      owner.operation.complete();
      const successor = admitTestReplyTurn({
        sessionKey,
        sessionId,
        expectedSessionId: sessionId,
        storePath,
      });
      let successorSettled = false;
      void successor.then(() => {
        successorSettled = true;
      });
      for (const [index, failedWrite] of failedWrites.entries()) {
        await failedWrite.promise;
        if (index < failedWrites.length - 1) {
          await vi.advanceTimersByTimeAsync(25 * 2 ** index);
        }
      }
      // Worker I/O settles on real turns, not fake-clock advancement. No later
      // retry timer is advanced while joining the successor admission.
      const admitted = await successor;
      expect(successorSettled).toBe(true);
      expect(deferredReleases).toHaveLength(1);
      accessorSpy.mockRestore();
      expect(admitted.status).toBe("owned");
      if (admitted.status === "owned") {
        const released = captureSessionControllerSettlement({
          scope: storePath,
          identities: [sessionKey, sessionId],
        });
        expect(released).toBeDefined();
        admitted.operation.complete();
        await released;
      }
    } finally {
      try {
        restoreAccessor?.();
        // Start the deferred repair without firing unrelated database lease deadlines.
        await vi.advanceTimersByTimeAsync(1_000);
        await Promise.all(deferredReleases);
      } finally {
        scheduled.mockRestore();
        pendingTarget.mockRestore();
        vi.useRealTimers();
      }
    }
  });

  it("settles a committed recovery claim without replay when preparation changes", async () => {
    const sessionKey = "agent:main:recovery-claim-preparation";
    const sessionId = "interrupted-session";
    const storePath = createSessionStore({
      [sessionKey]: {
        sessionId,
        updatedAt: 100,
        status: "running",
        abortedLastRun: true,
      },
    });
    const predecessor = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    const claimed = createDeferred();
    const release = createDeferred();
    const claim = recoveryStore.claimMainSessionRecoveryOwner;
    const claimSpy = vi
      .spyOn(recoveryStore, "claimMainSessionRecoveryOwner")
      .mockImplementation(async (params) => {
        const result = await claim(params);
        claimed.resolve();
        await release.promise;
        return result;
      });
    const pending = admitTestReplyTurn({ sessionKey, sessionId, storePath });
    try {
      await Promise.race([
        claimed.promise,
        pending.then(() => {
          throw new Error("Admission completed before recovery claimed ownership");
        }),
      ]);
      expect(loadSessionEntry({ storePath, sessionKey })?.mainRestartRecovery).toMatchObject({
        foregroundClaims: { tokens: [expect.any(String)] },
      });
      predecessor.complete();
      release.resolve();
      await expect(pending).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
      expect(claimSpy).toHaveBeenCalledOnce();
      expect(
        loadSessionEntry({ storePath, sessionKey })?.mainRestartRecovery?.foregroundClaims,
      ).toBeUndefined();
      expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
    } finally {
      release.resolve();
      predecessor.complete();
      const result = await pending.catch(() => undefined);
      if (result?.status === "owned") {
        result.operation.complete();
      }
      claimSpy.mockRestore();
    }
  });

  it("returns the foreground recovery claim and releases it when visible reply work clears", async () => {
    const sessionKey = "agent:main:telegram:topic:recovery-race:visible";
    const sessionId = "interrupted-session";
    const storePath = createSessionStore({
      [sessionKey]: {
        sessionId,
        updatedAt: 100,
        status: "running",
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 1,
          chargedAttempts: 2,
        },
      },
    });
    const admission = await admitTestReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
    });
    expect(admission.status).toBe("owned");
    if (admission.status !== "owned") {
      return;
    }

    const claimedEntry = loadSessionEntry({ storePath, sessionKey });
    admission.operation.complete();
    await vi.waitFor(() => {
      const entry = loadSessionEntry({ storePath, sessionKey });
      expect(entry?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
    });

    expect(claimedEntry?.mainRestartRecovery).toMatchObject({
      foregroundClaims: {
        tokens: [expect.any(String)],
      },
    });
    expect(admission.sessionEntry).toMatchObject({
      mainRestartRecovery: {
        foregroundClaims: claimedEntry?.mainRestartRecovery?.foregroundClaims,
      },
    });
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      sessionId,
      status: "running",
    });
  });

  it("keeps new input and followups behind a concurrent recovery winner", async () => {
    const sessionKey = "agent:main:main";
    const sessionId = "interrupted-channel-session";
    const entry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      status: "running",
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "old-channel-claim",
      restartRecoveryDeliverySourceRunId: "old-channel-source",
      restartRecoveryDeliveryContext: { channel: "discord", to: "synthetic-channel" },
      restartRecoverySourceIngress: "channel",
    };
    const storePath = createSessionStore({ [sessionKey]: entry });
    const context = createRecoveryGatewayContext();
    const resolveGatewayContext = () => ({ ...context });
    const root = await beginSessionEffect({
      scope: storePath,
      identities: [sessionKey, sessionId],
      resolveGatewayContext,
      assertAllowed: () => {},
    });
    let recoveryLease: SessionEffectRef | undefined;
    const retry = vi
      .spyOn(restartRecovery, "retryRestartAbortedMainSessionRecovery")
      .mockImplementationOnce(async (request) => {
        expect(request).toMatchObject({
          expectedSessionId: sessionId,
          expectedRecoveryRunId: "old-channel-claim",
          expectedRecoverySourceRunId: "old-channel-source",
          gatewayRuntime: context.recoveryRuntime,
        });
        expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
        expect(root.isActive()).toBe(true);
        const owner = await beginSessionEffect({
          scope: storePath,
          identities: [sessionKey, sessionId],
          owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
          resolveGatewayContext,
          assertAllowed: () => {},
        });
        recoveryLease = consumeSessionEffectHandoff({
          handoffId: owner.createHandoff(),
          scope: storePath,
          identities: [sessionKey, sessionId],
        });
        expect(recoveryLease).toBe(owner);
        await owner.run(() => {
          expect(isCompetingSessionControllerWorkActive(storePath, [sessionKey, sessionId])).toBe(
            false,
          );
          return runSessionMutation({
            scope: storePath,
            identities: [sessionKey, sessionId],
            run: () =>
              replaceSessionEntry(
                { storePath, sessionKey },
                {
                  ...entry,
                  abortedLastRun: false,
                  restartRecoveryRuns: [
                    {
                      runId: "old-channel-claim",
                      lifecycleGeneration: getAgentEventLifecycleGeneration(),
                    },
                  ],
                },
              ),
          });
        });
        return {
          started: 0,
          settled: 0,
          failed: 0,
          skipped: 1,
        };
      });
    let visible: Awaited<ReturnType<typeof admitTestReplyTurn>> | undefined;
    let followup: Awaited<ReturnType<typeof admitTestReplyTurn>> | undefined;
    let followupPromise: ReturnType<typeof admitTestReplyTurn> | undefined;
    const abort = new AbortController();
    try {
      visible = await root.run(() =>
        admitTestReplyTurn({
          sessionKey,
          sessionId,
          storePath,
          expectedSessionId: sessionId,
          resolveGatewayContext,
          waitForActive: false,
        }),
      );
      expect(visible.status).toBe("owned");
      expect(retry).toHaveBeenCalledOnce();
      expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
        restartRecoveryDeliveryRunId: "old-channel-claim",
        restartRecoveryDeliverySourceRunId: "old-channel-source",
      });
      expect(
        loadSessionEntry({ storePath, sessionKey })?.mainRestartRecovery?.foregroundClaims,
      ).toBeUndefined();
      expect(
        captureSessionEffectOwnerSettlement({
          scope: storePath,
          identities: [sessionKey, sessionId],
          owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
        }),
      ).toBeDefined();
      if (visible.status === "owned") {
        visible.operation.complete();
      }
      root.release();
      let followupSettled = false;
      followupPromise = admitTestReplyTurn({
        sessionKey,
        sessionId,
        storePath,
        expectedSessionId: sessionId,
        resolveGatewayContext,
        kind: "queued_followup",
        upstreamAbortSignal: abort.signal,
      });
      void followupPromise.then(() => {
        followupSettled = true;
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(followupSettled).toBe(false);
      await replaceSessionEntry(
        { storePath, sessionKey },
        { sessionId, updatedAt: Date.now(), status: "done" },
      );
      recoveryLease?.release();
      followup = await followupPromise;
      expect(followup.status).toBe("owned");
      expect(retry).toHaveBeenCalledOnce();
    } finally {
      abort.abort();
      recoveryLease?.release();
      root.release();
      if (visible?.status === "owned") {
        visible.operation.complete();
      }
      followup ??= await followupPromise;
      if (followup?.status === "owned") {
        followup.operation.complete();
      }
      retry.mockRestore();
    }
  });

  it.each([
    { kind: "visible", failed: false },
    { kind: "queued_followup", failed: false },
    { kind: "visible", failed: true },
  ] as const)(
    "settles or defers $kind input according to recovery failure: $failed",
    async ({ kind, failed }) => {
      const sessionKey = "agent:main:main";
      const sessionId = "pending-recovery-session";
      const entry: SessionEntry = {
        sessionId,
        updatedAt: Date.now(),
        status: "running",
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "interrupted-claim",
        restartRecoveryDeliverySourceRunId: "interrupted-source",
      };
      const storePath = createSessionStore({ [sessionKey]: entry });
      const context = createRecoveryGatewayContext();
      const retryEntered = createDeferred();
      const retry = vi
        .spyOn(restartRecovery, "retryRestartAbortedMainSessionRecovery")
        .mockImplementation(async () => {
          retryEntered.resolve();
          return {
            started: 0,
            settled: 0,
            failed: failed ? 1 : 0,
            skipped: failed ? 0 : 1,
          };
        });
      const abort = new AbortController();
      let outcome: Awaited<ReturnType<typeof admitTestReplyTurn>> | undefined;
      let failure: unknown;
      const admission = admitTestReplyTurn({
        sessionKey,
        sessionId,
        storePath,
        expectedSessionId: sessionId,
        resolveGatewayContext: () => context,
        kind,
        upstreamAbortSignal: abort.signal,
      }).then(
        (result) => {
          outcome = result;
        },
        (error: unknown) => {
          failure = error;
        },
      );
      try {
        await Promise.race([
          retryEntered.promise,
          admission.then(() => {
            throw new Error("Admission settled before recovery dispatch");
          }),
        ]);
        expect(retry).toHaveBeenCalledOnce();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject(entry);
        expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
        if (failed) {
          await admission;
          expect(failure).toMatchObject({
            message: expect.stringMatching(/restart recovery failed/i),
          });
          expect(outcome).toBeUndefined();
        } else if (kind === "queued_followup") {
          expect(failure).toBeUndefined();
          await admission;
          expect(outcome).toEqual({ status: "skipped", reason: "active-run" });
        } else {
          expect(failure).toBeUndefined();
          expect(outcome).toBeUndefined();
          await replaceSessionEntry(
            { storePath, sessionKey },
            { sessionId, updatedAt: Date.now(), status: "done" },
          );
          await admission;
          expect(outcome).toMatchObject({ status: "owned" });
        }
        expect(retry).toHaveBeenCalledOnce();
      } finally {
        abort.abort();
        await admission;
        if (outcome?.status === "owned") {
          outcome.operation.complete();
        }
        retry.mockRestore();
      }
    },
  );

  it.each(["started", "cancelled", "replaced"] as const)(
    "waits for reserved startup recovery before admitting visible input: %s",
    async (outcome) => {
      const sessionKey = "agent:main:startup-recovery";
      const sessionId = "startup-recovery-session";
      const entry: SessionEntry = {
        sessionId,
        updatedAt: Date.now(),
        status: "running",
        abortedLastRun: true,
      };
      const storePath = createSessionStore({ [sessionKey]: entry });
      const owner = await beginSessionEffect({
        scope: storePath,
        identities: [sessionKey, sessionId],
        owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
        assertAllowed: () => {},
      });
      const controller = new AbortController();
      let result: Awaited<ReturnType<typeof admitTestReplyTurn>> | undefined;
      let failure: unknown;
      const admission = admitTestReplyTurn({
        sessionKey,
        sessionId,
        expectedSessionId: sessionId,
        storePath,
        waitForActive: false,
        upstreamAbortSignal: controller.signal,
      }).then(
        (value) => {
          result = value;
        },
        (error: unknown) => {
          failure = error;
        },
      );
      try {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(failure).toBeUndefined();
        expect(result).toBeUndefined();
        expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
        if (outcome === "cancelled") {
          controller.abort();
        } else {
          await replaceSessionEntry(
            { storePath, sessionKey },
            {
              ...entry,
              sessionId: outcome === "replaced" ? "replacement-session" : sessionId,
              abortedLastRun: false,
            },
          );
        }
        await admission;
        if (outcome === "replaced") {
          expect(failure).toBeInstanceOf(Error);
          expect(failure).toMatchObject({
            message: expect.stringContaining("changed while starting work"),
          });
        } else {
          expect(failure).toBeUndefined();
          expect(result).toMatchObject(
            outcome === "started" ? { status: "owned" } : { status: "skipped", reason: "aborted" },
          );
        }
        // Starting recovery wakes visible input before the recovered turn completes.
        expect(owner.isActive()).toBe(true);
      } finally {
        controller.abort();
        owner.release();
        await admission;
        if (result?.status === "owned") {
          result.operation.complete();
        }
      }
    },
  );

  it("waits for the named recovery owner before admitting a queued followup", async () => {
    const sessionKey = "agent:main:queued-recovery-owner";
    const sessionId = "queued-recovery-owner";
    const storePath = createSessionStoreFor(sessionKey, sessionId);
    const owner = await beginSessionEffect({
      scope: storePath,
      identities: [sessionKey, sessionId],
      owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
      assertAllowed: () => {},
    });
    const waitEntered = createDeferred();
    const readOwnerRelease = sessionLifecycle.captureSessionEffectOwnerSettlement;
    const waitSpy = vi
      .spyOn(sessionLifecycle, "captureSessionEffectOwnerSettlement")
      .mockImplementation((params) => {
        const release = readOwnerRelease(params);
        if (
          release &&
          ("target" in params ? params.target.storeScope : params.scope) === storePath &&
          params.owner === MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER
        ) {
          waitEntered.resolve();
        }
        return release;
      });
    const controller = new AbortController();

    const admission = admitTestReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      ...request,
    });
    pending.push(admission);
    void admission.then(
      (result) => results.push(result),
      () => {},
    );
    return admission;
  };
  const begin = async (request: Partial<Parameters<typeof beginSessionWorkAdmission>[0]> = {}) => {
    const lease = await beginSessionWorkAdmission({
      ...scope,
      assertAllowed: () => {},
      ...request,
    });
    cleanup.push(async () => {
      lease.release();
      await lease.released;
    });
    return lease;
  };
  return {
    entry,
    storePath,
    scope,
    abort,
    cleanup,
    admit,
    begin,
    wait: (request: Parameters<typeof admit>[0]) =>
      observe(admit({ upstreamAbortSignal: abort.signal, ...request })),
    read: () => loadSessionEntry({ storePath, sessionKey }),
    write: (value: SessionEntry) => replaceSessionEntry({ storePath, sessionKey }, value),
  };
}

it("keeps deferred owner release retries from retaining a successor", async () => {
  const deferredReleases: Promise<void>[] = [];
  const schedule = recoveryLifecycle.scheduleMainSessionRecoveryMutation;
  const scheduled = vi
    .spyOn(recoveryLifecycle, "scheduleMainSessionRecoveryMutation")
    .mockImplementation((params) => {
      const settled = createDeferred();
      deferredReleases.push(settled.promise);
      schedule({
        ...params,
        onSuccess: async (result) => {
          await params.onSuccess(result);
          settled.resolve();
        },
      });
    });
  const pendingTarget = vi
    .spyOn(recoveryOwnerRelease, "scheduleMainSessionRecoveryPendingTarget")
    .mockImplementation(() => {});
  let restoreAccessor: (() => void) | undefined;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const f = recoveryFixture({
      mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
    });
    const owner = owned(await f.admit());
    const apply = sessionAccessor.applySessionEntryReplacements;
    const failedWrites = Array.from({ length: 3 }, () => createDeferred());
    let failures = 0;
    const accessorSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementation(async (params) => {
        const failedWrite = failedWrites[failures];
        if (failedWrite) {
          failures += 1;
          failedWrite.resolve();
          throw new Error("SQLite session entry changed before replacement");
        }
        return await apply(params);
      });
    restoreAccessor = () => accessorSpy.mockRestore();
    owner.operation.complete();
    const successor = f.admit();
    for (const [index, failedWrite] of failedWrites.entries()) {
      await failedWrite.promise;
      if (index < failedWrites.length - 1) {
        await vi.advanceTimersByTimeAsync(25 * 2 ** index);
      }
    }
    // Join real worker I/O without advancing later retry timers.
    const admitted = await successor;
    expect(deferredReleases).toHaveLength(1);
    accessorSpy.mockRestore();
    owned(admitted);
    const released = getSessionWorkAdmissionRelease(f.scope);
    expect(released).toBeDefined();
    complete(admitted);
    await released;
  } finally {
    try {
      restoreAccessor?.();
      // Start deferred repair without firing unrelated database lease deadlines.
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.all(deferredReleases);
    } finally {
      scheduled.mockRestore();
      pendingTarget.mockRestore();
      vi.useRealTimers();
    }
  }
});

it("settles a committed recovery claim without replay when preparation changes", async () => {
  const f = recoveryFixture();
  const predecessor = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  const claimed = createDeferred();
  const release = createDeferred();
  f.cleanup.push(() => {
    release.resolve();
    predecessor.complete();
  });
  const claim = recoveryStore.claimMainSessionRecoveryOwner;
  const claimSpy = vi
    .spyOn(recoveryStore, "claimMainSessionRecoveryOwner")
    .mockImplementation(async (params) => {
      const result = await claim(params);
      claimed.resolve();
      await release.promise;
      return result;
    });
  const pending = f.admit({ expectedSessionId: undefined });
  await Promise.race([
    claimed.promise,
    pending.then(() => {
      throw new Error("Admission completed before recovery claimed ownership");
    }),
  ]);
  expect(f.read()?.mainRestartRecovery).toMatchObject({
    foregroundClaims: { tokens: [expect.any(String)] },
  });
  predecessor.complete();
  release.resolve();
  await expect(pending).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
  expect(claimSpy).toHaveBeenCalledOnce();
  expect(f.read()?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
  expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
});

it("keeps new input and followups behind a concurrent recovery winner", async () => {
  const delivery = {
    restartRecoveryDeliveryRunId: "old-channel-claim",
    restartRecoveryDeliverySourceRunId: "old-channel-source",
  };
  const f = recoveryFixture({
    ...delivery,
    restartRecoveryDeliveryContext: { channel: "discord", to: "synthetic-channel" },
    restartRecoverySourceIngress: "channel",
  });
  const context = createRecoveryGatewayContext();
  const resolveGatewayContext = () => ({ ...context });
  const root = await f.begin({ resolveGatewayContext });
  let recoveryLease: SessionWorkAdmissionLease | undefined;
  const retry = vi
    .spyOn(restartRecovery, "retryRestartAbortedMainSessionRecovery")
    .mockImplementationOnce(async (request) => {
      expect(request).toMatchObject({
        expectedSessionId: sessionId,
        expectedRecoveryRunId: "old-channel-claim",
        expectedRecoverySourceRunId: "old-channel-source",
        gatewayRuntime: context.recoveryRuntime,
      });
      expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
      expect(root.isActive()).toBe(true);
      const owner = await f.begin({
        owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
        resolveGatewayContext,
      });
      recoveryLease = consumeSessionWorkAdmissionHandoff({
        handoffId: owner.createHandoff(),
        ...f.scope,
      });
      expect(recoveryLease).toBe(owner);
      await owner.run(() => {
        expect(isCompetingSessionWorkAdmissionActive(f.storePath, [sessionKey, sessionId])).toBe(
          false,
        );
        return runExclusiveSessionLifecycleMutation("recover", {
          ...f.scope,
          run: () =>
            f.write({
              ...f.entry,
              abortedLastRun: false,
              restartRecoveryRuns: [
                {
                  runId: "old-channel-claim",
                  lifecycleGeneration: getAgentEventLifecycleGeneration(),
                },
              ],
            }),
        });
      });
      return { started: 0, settled: 0, failed: 0, skipped: 1 };
    });
  const visible = await root.run(() => f.admit({ resolveGatewayContext, waitForActive: false }));
  expect(visible.status).toBe("owned");
  expect(retry).toHaveBeenCalledOnce();
  expect(f.read()).toMatchObject(delivery);
  expect(f.read()?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
  expect(
    getSessionWorkAdmissionOwnerRelease({
      ...f.scope,
      owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
    }),
  ).toBeDefined();
  complete(visible);
  root.release();
  let followupSettled = false;
  const followup = f.admit({
    resolveGatewayContext,
    kind: "queued_followup",
    upstreamAbortSignal: f.abort.signal,
  });
  void followup.then(() => {
    followupSettled = true;
  });
  await setImmediate();
  expect(followupSettled).toBe(false);
  await f.write({ sessionId, updatedAt: Date.now(), status: "done" });
  recoveryLease?.release();
  expect((await followup).status).toBe("owned");
  expect(retry).toHaveBeenCalledOnce();
});

it.each([
  { kind: "visible", failed: false },
  { kind: "queued_followup", failed: false },
  { kind: "visible", failed: true },
] as const)(
  "settles or defers $kind input according to recovery failure: $failed",
  async ({ kind, failed }) => {
    const f = recoveryFixture({
      restartRecoveryDeliveryRunId: "interrupted-claim",
      restartRecoveryDeliverySourceRunId: "interrupted-source",
    });
    const context = createRecoveryGatewayContext();
    const retryEntered = createDeferred();
    const retry = vi
      .spyOn(restartRecovery, "retryRestartAbortedMainSessionRecovery")
      .mockImplementation(async () => {
        retryEntered.resolve();
        return { started: 0, settled: 0, failed: failed ? 1 : 0, skipped: failed ? 0 : 1 };
      });
    const outcome = f.wait({ resolveGatewayContext: () => context, kind });
    await Promise.race([
      retryEntered.promise,
      outcome.settled.then(() => {
        throw new Error("Admission settled before recovery dispatch");
      }),
    ]);
    expect(retry).toHaveBeenCalledOnce();
    await setImmediate();
    expect(f.read()).toMatchObject(f.entry);
    expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
    if (failed) {
      await outcome.settled;
      expect(outcome.failure).toMatchObject({
        message: expect.stringMatching(/restart recovery failed/i),
      });
      expect(outcome.result).toBeUndefined();
    } else if (kind === "queued_followup") {
      expect(outcome.failure).toBeUndefined();
      await outcome.settled;
      expect(outcome.result).toEqual({ status: "skipped", reason: "active-run" });
    } else {
      expect(outcome.failure).toBeUndefined();
      expect(outcome.result).toBeUndefined();
      await f.write({ sessionId, updatedAt: Date.now(), status: "done" });
      await outcome.settled;
      expect(outcome.result).toMatchObject({ status: "owned" });
    }
    expect(retry).toHaveBeenCalledOnce();
  },
);

it.each(["started", "cancelled", "replaced"] as const)(
  "waits for reserved startup recovery before visible input: %s",
  async (outcome) => {
    const f = recoveryFixture();
    const owner = await f.begin({ owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER });
    const admission = f.wait({ waitForActive: false });
    await setImmediate();
    expect(admission.failure).toBeUndefined();
    expect(admission.result).toBeUndefined();
    expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
    if (outcome === "cancelled") {
      f.abort.abort();
    } else {
      await f.write({
        ...f.entry,
        sessionId: outcome === "replaced" ? "replacement-session" : sessionId,
        abortedLastRun: false,
      });
    }
    await admission.settled;
    if (outcome === "replaced") {
      expect(admission.failure).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
      expect(admission.result).toBeUndefined();
    } else {
      expect(admission.failure).toBeUndefined();
      expect(admission.result).toMatchObject(
        outcome === "started" ? { status: "owned" } : { status: "skipped", reason: "aborted" },
      );
    }
    // Starting recovery wakes visible input before the recovered turn completes.
    expect(owner.isActive()).toBe(true);
  },
);

it.each(["delivery-residue", "live-owner"] as const)(
  "preserves recovery authority when monitoring encounters %s",
  async (recovery) => {
    const f = recoveryFixture(
      recovery === "live-owner"
        ? { status: undefined, abortedLastRun: undefined }
        : {
            abortedLastRun: false,
            restartRecoveryDeliveryRunId: "completed-recovery",
            restartRecoveryRuns: [
              {
                runId: "completed-recovery",
                lifecycleGeneration: getAgentEventLifecycleGeneration(),
              },
            ],
          },
    );
    const owner =
      recovery === "live-owner"
        ? await f.begin({ owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER })
        : undefined;
    let released = false;
    void owner?.released.then(() => {
      released = true;
    });
    const result = await f.admit({ kind: "heartbeat" });
    if (owner) {
      expect(result).toMatchObject({ status: "skipped", reason: "active-run" });
      expect(released).toBe(false);
      expect(f.read()?.sessionId).toBe(sessionId);
      owner.release();
      await owner.released;
    } else {
      expect(result.status).toBe("owned");
      expect(f.read()).toMatchObject(f.entry);
      expect(f.read()?.mainRestartRecovery).toBeUndefined();
    }
  },
);

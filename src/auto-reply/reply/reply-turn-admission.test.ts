import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE } from "../../config/sessions/lifecycle.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import {
  resetDiagnosticRunActivityForTest,
  RUN_STALE_TAKEOVER_MS,
} from "../../logging/diagnostic-run-activity.js";
import {
  createReplyOperation,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  runAfterReplyOperationClear,
  getSessionControllerOperation,
} from "../../sessions/session-controller.js";
import {
  interruptSessionControllerEffects,
  runSessionMutation,
} from "../../sessions/session-controller.lifecycle.js";
import { SESSION_WATCHDOG_CLEANUP_MS } from "../../sessions/session-controller.watchdog-state.js";

import { testing } from "./reply-run-registry.test-support.js";
import { runWithReplyOperationLifecycleAdmission } from "./reply-turn-admission.js";
import { admitTestReplyTurn, createSessionStore } from "./reply-turn-admission.test-support.js";

const releaseMocks = vi.hoisted(() => ({
  beforeRelease: vi.fn(async () => {}),
  schedule: vi.fn(),
}));
vi.mock(
  "../../agents/main-session-recovery/main-session-recovery-store.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../agents/main-session-recovery/main-session-recovery-store.js")
      >();
    return {
      ...actual,
      releaseMainSessionRecoveryOwner: async (
        lease: Parameters<typeof actual.releaseMainSessionRecoveryOwner>[0],
      ) => {
        await releaseMocks.beforeRelease();
        return await actual.releaseMainSessionRecoveryOwner(lease);
      },
    };
  },
);
vi.mock(
  "../../agents/main-session-recovery/main-session-recovery-owner-release.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../agents/main-session-recovery/main-session-recovery-owner-release.js")
    >()),
    scheduleMainSessionRecoveryPendingTarget: releaseMocks.schedule,
  }),
);

const sessionKey = "agent:main:telegram:topic:admission";
const sessionId = "original-session";
const scope = { sessionKey, sessionId };
const sourceKey = "agent:main:telegram:slash:source";
function admit(overrides: Partial<Parameters<typeof admitTestReplyTurn>[0]> = {}) {
  return admitTestReplyTurn({ ...scope, ...overrides });
}
function operation(overrides: Partial<Parameters<typeof createReplyOperation>[0]> = {}) {
  return createReplyOperation({ ...scope, resetTriggered: false, ...overrides });
}

describe("reply turn admission", () => {
  afterEach(() => {
    testing.resetReplyRunRegistry();
    resetDiagnosticRunActivityForTest();
    recoveryOwnerReleaseMocks.beforeRelease.mockClear();
    recoveryOwnerReleaseMocks.schedulePendingTarget.mockClear();
  });

  it("binds the originating transcript leaf to the admitted operation", async () => {
    const admission = await admitTestReplyTurn({
      sessionKey: "agent:main:main",
      sessionId: "session-originating-leaf",
      originatingLeafEntryId: "leaf-before-run",
    });

    expect(admission.status).toBe("owned");
    if (admission.status === "owned") {
      expect(admission.operation.originatingLeafEntryId).toBe("leaf-before-run");
      admission.operation.complete();
    }
  });

  it("rejects a reply when an archive commits before admission", async () => {
    const sessionKey = "agent:main:telegram:topic:archived";
    const sessionId = "session-before-archive";
    const storePath = createSessionStoreFor(sessionKey, sessionId);
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runSessionMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        await replaceSessionEntry({ sessionKey, storePath }, {
          sessionId,
          updatedAt: Date.now(),
          archivedAt: Date.now(),
        } as SessionEntry);

      },
    },
  };
}
async function holdMutation(storePath: string, run: () => Promise<unknown> = async () => {}) {
  const started = createDeferred();
  const release = createDeferred();
  const mutation = runExclusiveSessionLifecycleMutation("patch", {
    scope: storePath,
    identities: [sessionKey, sessionId],
    run: async () => {
      started.resolve();
      await release.promise;
      await run();
    },
  });
  await started.promise;
  return async () => {
    release.resolve();
    await mutation;
  };
}
function holdRecoveryRelease() {
  const started = createDeferred();
  const release = createDeferred();
  releaseMocks.beforeRelease.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
  });
  return { started: started.promise, release: release.resolve };
}
async function expectRecoveryReleased(storePath: string, key = sessionKey) {
  await vi.waitFor(() =>
    expect(
      loadSessionEntry({ storePath, sessionKey: key })?.mainRestartRecovery?.foregroundClaims,
    ).toBeUndefined(),
  );
}
function interrupt(storePath: string, run: () => Promise<void>) {
  const target = { scope: storePath, identities: [sessionKey, sessionId] };
  return runExclusiveSessionLifecycleMutation("patch", {
    ...target,
    prepare: async () => {
      await interruptSessionWorkAdmissions(target);
    },
    run,
  });
}
afterEach(async () => {
  if (vi.isFakeTimers()) {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  }
  testing.resetReplyRunRegistry();
  resetDiagnosticRunActivityForTest();
  releaseMocks.beforeRelease.mockClear();
  releaseMocks.schedule.mockClear();
});

  it("rejects a reply when deletion commits before admission", async () => {
    const sessionKey = "agent:main:telegram:topic:deleted";
    const sessionId = "session-before-delete";
    const storePath = createSessionStoreFor(sessionKey, sessionId);
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runSessionMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        await deleteSessionEntryLifecycle({
          storePath,
          archiveTranscript: false,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        });
      },
    });
    await mutationStarted.promise;

    const admission = admitTestReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,

      storePath,
      archiveTranscript: false,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    }),
  );
  const admission = admit({ storePath, expectedSessionId: sessionId });
  await release();
  await expect(admission).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
});
it("waits for recovery release before admitting a queued successor", async () => {
  const storePath = store(interruptedEntry());
  const owner = owned(await admit({ storePath, expectedSessionId: sessionId }));
  const release = holdRecoveryRelease();
  owner.complete();
  await release.started;
  let settled = false;
  const successor = admit({
    storePath,
    expectedSessionId: sessionId,
    kind: "queued_followup",
  }).then((result) => {
    settled = true;
    return result;
  });

  it("uses the persisted session id when reset commits before admission", async () => {
    const sessionKey = "agent:main:telegram:topic:reset";
    const sessionId = "session-before-reset";
    const nextSessionId = "session-after-reset";
    const storePath = createSessionStoreFor(sessionKey, sessionId);
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runSessionMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        await replaceSessionEntry({ sessionKey, storePath }, {
          sessionId: nextSessionId,
          updatedAt: Date.now(),
        } as SessionEntry);
      },
    });
    await mutationStarted.promise;

    const admission = admitTestReplyTurn({
      sessionKey,
      sessionId,
      storePath,
    });
    releaseMutation.resolve();
    await mutation;
    const result = await admission;

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe(nextSessionId);
      result.operation.complete();
    }
  });

  it("rejects expected-session work when reset commits before admission", async () => {
    const sessionKey = "agent:main:telegram:topic:reset-expected";
    const sessionId = "session-before-reset";
    const nextSessionId = "session-after-reset";
    const storePath = createSessionStoreFor(sessionKey, sessionId);
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runSessionMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        await replaceSessionEntry({ sessionKey, storePath }, {
          sessionId: nextSessionId,
          updatedAt: Date.now(),
        } as SessionEntry);
      },
    });
    await mutationStarted.promise;

    const admission = admitTestReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
    });
    releaseMutation.resolve();
    await mutation;

    await expect(admission).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
  });

  it("drops queued work when reset cleanup cancels admission", async () => {
    const sessionKey = "agent:main:telegram:topic:queued-reset";
    const sessionId = "session-before-reset";
    const storePath = createSessionStoreFor(sessionKey, sessionId);
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const abortController = new AbortController();
    const mutation = runSessionMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        abortController.abort();
        await replaceSessionEntry({ sessionKey, storePath }, {
          sessionId: "session-after-reset",
          updatedAt: Date.now(),
        } as SessionEntry);
      },
    });
    await mutationStarted.promise;

    const admission = admitTestReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "queued_followup",
      upstreamAbortSignal: abortController.signal,
    });
    releaseMutation.resolve();
    await mutation;

    await expect(admission).resolves.toEqual({
      status: "skipped",
      reason: "aborted",
    });
  });

  it("drops queued work when the session is archived", async () => {
    const sessionKey = "agent:main:telegram:topic:queued-archive";
    const sessionId = "session-before-archive";
    const storePath = createSessionStore({
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        archivedAt: Date.now(),
      },
    });

    await expect(
      admitTestReplyTurn({
        sessionKey,
        sessionId,
        expectedSessionId: sessionId,
        storePath,
        kind: "queued_followup",
      }),
    ).resolves.toEqual({
      status: "skipped",
      reason: "lifecycle-invalidated",
    });
  });

  it("fences restart recovery from heartbeat admission until the operation clears", async () => {
    const kind = "heartbeat";
    const sessionKey = `agent:main:telegram:topic:recovery-race:${kind}`;
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
      kind,
    });
    expect(admission.status).toBe("owned");
    if (admission.status !== "owned") {
      return;
    }

    const claimedEntry = await readSessionEntry(storePath, sessionKey);
    admission.operation.complete();
    await vi.waitFor(async () => {
      const entry = await readSessionEntry(storePath, sessionKey);
      expect(entry?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
    });

    expect(claimedEntry?.mainRestartRecovery).toMatchObject({
      foregroundClaims: {
        tokens: [expect.any(String)],
      },
    });
    await expect(readSessionEntry(storePath, sessionKey)).resolves.toMatchObject({
      sessionId,
      status: "running",
    });
  });

  it.each(["visible", "queued_followup"] as const)(
    "waits for restart-recovery owner release before %s successor admission",
    async (kind) => {
      const sessionKey = `agent:main:telegram:topic:recovery-successor:${kind}`;
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

      const releaseStarted = createDeferred();
      const allowRelease = createDeferred();
      recoveryOwnerReleaseMocks.beforeRelease.mockImplementationOnce(async () => {
        releaseStarted.resolve();
        await allowRelease.promise;
      });
      owner.operation.complete();
      await releaseStarted.promise;

      const successor = admitTestReplyTurn({
        sessionKey,
        sessionId,
        expectedSessionId: sessionId,
        storePath,
        kind,
      });
      let successorSettled = false;
      void successor.then(() => {
        successorSettled = true;
      });
      await Promise.resolve();
      expect(successorSettled).toBe(false);
      await expect(
        admitTestReplyTurn({
          sessionKey,
          sessionId,
          expectedSessionId: sessionId,
          storePath,
          kind: "heartbeat",
        }),
      ).resolves.toEqual({ status: "skipped", reason: "active-run" });

      allowRelease.resolve();
      const admitted = await successor;
      expect(admitted.status).toBe("owned");
      if (admitted.status === "owned") {
        admitted.operation.complete();
      }
      await vi.waitFor(async () => {
        const entry = await readSessionEntry(storePath, sessionKey);
        expect(entry?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
      });

    },
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  release.release();
  const next = owned(await successor);
  expect(next.sessionId).toBe(sessionId);
  next.complete();
  await expectRecoveryReleased(storePath, sourceKey);
});
it("admits an explicit reset without reopening its restart tombstone", async () => {
  const archivedAt = Date.now() - 1000;
  const storePath = store({ ...tombstoneEntry(), archivedAt, status: "failed" });
  const admitted = owned(
    await admit({
      storePath,
      expectedSessionId: sessionId,
      resetTriggered: true,
      allowRestartTombstoneReset: true,
    });

    expect(admission.status).toBe("owned");
    expect(await readSessionEntry(storePath, sessionKey)).toMatchObject({
      sessionId,
      archivedAt,
      mainRestartRecovery: {
        tombstone: { recoveredSessionId: "dashboard-successor" },
      },
    });
    if (admission.status === "owned") {
      admission.operation.complete();
    }
  });

  it("does not treat resetTriggered alone as restart-tombstone authority", async () => {
    const sessionKey = "agent:main:matrix:channel:untrusted-reset-flag";
    const sessionId = "tombstoned-session";
    const storePath = createSessionStore({
      [sessionKey]: {
        sessionId,
        updatedAt: 100,
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 4,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
      },
    });

    await expect(
      admitTestReplyTurn({
        sessionKey,
        sessionId,
        expectedSessionId: sessionId,
        storePath,
        resetTriggered: true,
      }),
    ).rejects.toThrow(/ended during restart recovery/i);
  });

  it("admits a visible turn after clearing orphaned restart-recovery fences", async () => {
    const sessionKey = "agent:main:telegram:topic:orphaned-recovery-fence";
    const sessionId = "healthy-session";
    const storePath = createSessionStore({
      [sessionKey]: {
        sessionId,
        updatedAt: 100,
        status: "running",
        abortedLastRun: false,
        restartRecoveryRuns: [{ runId: "stale-run", lifecycleGeneration: "stale-generation" }],
      },
    });

    const admission = await admitTestReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
    });
    expect(admission.status).toBe("owned");
    const persisted = await readSessionEntry(storePath, sessionKey);
    expect(persisted?.restartRecoveryRuns).toBeUndefined();
    expect(persisted?.mainRestartRecovery).toBeUndefined();
    if (admission.status === "owned") {
      admission.operation.complete();
    }
  });

  it("drops a queued followup for an admitted recovery fence", async () => {
    const sessionKey = "agent:main:telegram:topic:admitted-recovery";
    const sessionId = "admitted-recovery-session";
    const storePath = createSessionStore({
      [sessionKey]: {
        sessionId,
        updatedAt: 100,
        status: "running",
        abortedLastRun: false,
        restartRecoveryRuns: [{ runId: "recovery-run", lifecycleGeneration: "generation-1" }],
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 3,
          chargedAttempts: 1,
        },
      },
    });

    await expect(
      admitTestReplyTurn({
        sessionKey,
        sessionId,
        expectedSessionId: sessionId,
        storePath,
        kind: "queued_followup",
      }),
    ).resolves.toEqual({ status: "skipped", reason: "lifecycle-invalidated" });
  });

  it("schedules released recovery only after retained admission exits", async () => {
    const sourceSessionKey = "agent:main:telegram:slash:recovery-adoption";
    const sessionKey = "agent:main:telegram:topic:recovery-adoption";
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
    const blocker = createTestReplyOperation({
      sessionKey,
      sessionId,
    });
    const reservation = createTestReplyOperation({
      sessionKey: sourceSessionKey,
      sessionId: "source-session",
    });

    const result = await admitTestReplyTurn({
      sessionKey,
      sessionId: reservation.sessionId,
      expectedSessionId: sessionId,
      storePath,
      waitForActive: false,
      retainLifecycleAdmissionOnActive: true,
      adoptOperation: reservation,
    });

    expect(result).toMatchObject({ status: "skipped", reason: "active-run" });
    expect(recoveryOwnerReleaseMocks.schedulePendingTarget).not.toHaveBeenCalled();
    await expect(readSessionEntry(storePath, sessionKey)).resolves.not.toHaveProperty(
      "mainRestartRecovery.foregroundClaims",
    );
    if (result.status === "skipped") {
      result.lifecycleAdmission?.release();
    }
    await vi.waitFor(() => {
      expect(recoveryOwnerReleaseMocks.schedulePendingTarget).toHaveBeenCalledWith({
        sessionId,
        sessionKey,
        storePath,
      });
    });

    blocker.complete();
    reservation.complete();
  });

  it("leaves interrupted subagent sessions to the subagent recovery owner", async () => {
    const sessionKey = "agent:main:subagent:child-1";
    const sessionId = "subagent-session";
    const storePath = createSessionStore({
      [sessionKey]: {
        sessionId,
        updatedAt: 100,
        status: "running",
        abortedLastRun: true,
        spawnDepth: 1,
      },
    });

    const admission = await admitTestReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
    });

    expect(admission.status).toBe("owned");
    if (admission.status === "owned") {
      admission.operation.complete();
    }
    await expect(readSessionEntry(storePath, sessionKey)).resolves.not.toHaveProperty(
      "mainRestartRecovery",
    );
  });

  it("holds interrupted queued reply work until its owner exits", async () => {
    const sessionKey = "agent:main:telegram:topic:queued-delete";
    const sessionId = "session-before-delete";
    const storePath = createSessionStoreFor(sessionKey, sessionId);
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

    let mutationRan = false;
    const mutation = runSessionMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      prepare: async () => {
        await interruptSessionControllerEffects({
          scope: storePath,
          identities: [sessionKey, sessionId],
        });
      },
      run: async () => {
        mutationRan = true;
      },
    });

    await vi.waitFor(() => {
      expect(admission.operation.abortSignal.aborted).toBe(true);
    });
    expect(admission.operation.result).toEqual({
      kind: "aborted",
      code: "aborted_for_restart",
    });
    expect(mutationRan).toBe(false);
    expect(getSessionControllerOperation(sessionKey)).toBe(admission.operation);

    admission.operation.complete();
    await mutation;
    expect(mutationRan).toBe(true);
    expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
  });

  it("excludes the initiating reply admission from an in-band lifecycle mutation", async () => {
    const sessionKey = "agent:main:telegram:topic:in-band-reset";
    const sessionId = "session-before-reset";
    const storePath = createSessionStoreFor(sessionKey, sessionId);
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

    await runWithReplyOperationLifecycleAdmission(admission.operation, async () => {
      await runSessionMutation({
        scope: storePath,
        identities: [sessionKey, sessionId],
        prepare: async () => {
          await interruptSessionControllerEffects({
            scope: storePath,
            identities: [sessionKey, sessionId],
          });
        },
        run: async () => undefined,
      });
    });

    expect(admission.operation.abortSignal.aborted).toBe(false);
    admission.operation.complete();
  });

  it("skips an aborted reply waiting behind a lifecycle mutation", async () => {
    const sessionKey = "agent:main:telegram:topic:aborted";
    const sessionId = "session-before-abort";
    const storePath = createSessionStoreFor(sessionKey, sessionId);
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runSessionMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
      },
    });
    await mutationStarted.promise;
    const controller = new AbortController();
    const admission = admitTestReplyTurn({
      sessionKey,
      sessionId,
      storePath,
      upstreamAbortSignal: controller.signal,
    });
    controller.abort();
    releaseMutation.resolve();
    await mutation;

    await expect(admission).resolves.toEqual({ status: "skipped", reason: "aborted" });
  });

  it("does not apply cleanup settle timeout to visible turn admission", async () => {
    vi.useFakeTimers();
    try {
      const active = createTestReplyOperation({
        sessionKey: "agent:main:discord:channel:42",
        sessionId: "active-session",
      });
      active.setPhase("running");

      const admitted = admitTestReplyTurn({
        sessionKey: "agent:main:discord:channel:42",
        sessionId: "waiting-session",
      });

      let settled = false;
      void admitted.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(15_000);
      expect(settled).toBe(false);

      active.complete();
      const result = await admitted;
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        result.operation.complete();
      }
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("keeps the cleanup settle timeout for queued follow-up retry", async () => {
    vi.useFakeTimers();
    try {
      const active = createTestReplyOperation({
        sessionKey: "agent:main:discord:channel:42",
        sessionId: "active-session",
      });
      active.setPhase("running");

      const admitted = admitTestReplyTurn({
        sessionKey: "agent:main:discord:channel:42",
        sessionId: "queued-session",
        kind: "queued_followup",
      });

      await vi.advanceTimersByTimeAsync(15_000);

      await expect(admitted).resolves.toMatchObject({
        status: "skipped",
        reason: "active-run",
        activeOperation: active,
      });
      active.complete();
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("keeps an already-waiting follow-up behind the delivery barrier", async () => {
    const active = createTestReplyOperation({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "active-session",
    });
    const { promise: barrier, resolve: releaseBarrier } = createDeferred();
    const admitted = admitTestReplyTurn({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "queued-session",
      kind: "queued_followup",
    });
    let settled = false;
    void admitted.then(() => {
      settled = true;
    });

    await Promise.resolve();
    active.completeWithAfterClearBarrier(barrier);
    await Promise.resolve();

    expect(settled).toBe(false);

    releaseBarrier();
    const result = await admitted;
    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      result.operation.complete();
    }
  });

  it("skips heartbeat turns while delivery settles", async () => {
    const active = createTestReplyOperation({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "active-session",
    });
    const { promise: barrier, resolve: releaseBarrier } = createDeferred();

    active.completeWithAfterClearBarrier(barrier);
    const result = await admitTestReplyTurn({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "heartbeat-session",
      kind: "heartbeat",
    });

    expect(result).toEqual({ status: "skipped", reason: "active-run" });
    releaseBarrier();
    await barrier;
  });

  it("passes a visible turn's rotated session to after-clear work", async () => {
    const active = createTestReplyOperation({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "active-session",
    });
    const { promise: barrier, resolve: releaseBarrier } = createDeferred();
    let admissionSessionId: string | undefined;
    runAfterReplyOperationClear(active, (sessionId) => {
      admissionSessionId = sessionId;
    });

    active.updateSessionId("rotated-session");
    active.completeWithAfterClearBarrier(barrier);
    expect(admissionSessionId).toBeUndefined();

    releaseBarrier();
    await barrier;
    await vi.waitFor(() => {
      expect(admissionSessionId).toBe("rotated-session");
    });
    const queuedResult = await admitTestReplyTurn({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: admissionSessionId ?? "queued-session",
      kind: "queued_followup",
    });
    expect(queuedResult.status).toBe("owned");
    if (queuedResult.status === "owned") {
      expect(queuedResult.operation.sessionId).toBe("rotated-session");
      queuedResult.operation.complete();
    }
  });

  it("uses the active run's final session id after waiting", async () => {
    const active = createTestReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "pre-compact-session",
    });
    active.setPhase("preflight_compacting");

    const admitted = admitTestReplyTurn({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "new-session",
    });

    await Promise.resolve();
    active.updateSessionId("post-compact-session");
    active.complete();
    const result = await admitted;

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe("post-compact-session");
      result.operation.complete();
    }
  });

  it("skips heartbeat turns while a visible turn owns the lane", async () => {
    const active = createTestReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "visible-session",
    });

    const result = await admitTestReplyTurn({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "heartbeat-session",
      kind: "heartbeat",
    });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "active-run",
      activeOperation: active,
    });
    active.complete();
  });

  it("lets visible turns reclaim a stale active operation", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const startedAt = Date.now();
      const active = createTestReplyOperation({
        sessionKey: "agent:main:telegram:topic:stale-visible",
        sessionId: "stale-session",
      });
      active.attachBackend({
        kind: "embedded",
        cancel: (reason) => {
          cancel(reason);
          active.complete();
        },
        isStreaming: () => true,
      });
      active.setPhase("running");
      vi.setSystemTime(startedAt + RUN_STALE_TAKEOVER_MS + 1);

      const result = await admitTestReplyTurn({
        sessionKey: "agent:main:telegram:topic:stale-visible",
        sessionId: "replacement-session",
      });

      expect(active.result).toEqual({ kind: "failed", code: "run_stalled" });
      expect(active.abortSignal.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledWith("superseded");
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        result.operation.complete();
      }
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("keeps visible turns waiting while an active operation is still fresh", async () => {
    vi.useFakeTimers();
    try {
      const active = createTestReplyOperation({
        sessionKey: "agent:main:telegram:topic:fresh-visible",
        sessionId: "fresh-session",
      });
      active.setPhase("running");
      active.recordActivity();
      const abortController = new AbortController();
      let settled = false;
      const result = admitTestReplyTurn({
        sessionKey: "agent:main:telegram:topic:fresh-visible",
        sessionId: "waiting-session",
        upstreamAbortSignal: abortController.signal,
      }).then((admission) => {
        settled = true;
        return admission;
      });

      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      expect(settled).toBe(false);
      expect(getSessionControllerOperation("agent:main:telegram:topic:fresh-visible")).toBe(active);

      abortController.abort();
      await expect(result).resolves.toMatchObject({
        status: "skipped",
        reason: "aborted",
        activeOperation: active,
      });
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("defers takeover to the blocked-tool floor while a quiet tool is active", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const startedAt = Date.now();
      const active = createTestReplyOperation({
        sessionKey: "agent:main:telegram:topic:quiet-tool",
        sessionId: "quiet-tool-session",
      });
      active.attachBackend({
        kind: "embedded",
        cancel: (reason) => {
          cancel(reason);
          active.complete();
        },
        isStreaming: () => true,
      });
      active.setPhase("running");
      const attempt = active.watchdog.attachAttempt({ assertCurrent: () => {} });
      attempt.beginTool({ toolName: "exec", toolCallId: "tool-quiet-1" });

      // 12 minutes of silence with an active tool: past the generic takeover
      // window but inside the blocked-tool floor — must NOT be reclaimed.
      vi.setSystemTime(startedAt + 12 * 60_000);
      const abortController = new AbortController();
      let settled = false;
      const waiting = admitTestReplyTurn({
        sessionKey: "agent:main:telegram:topic:quiet-tool",
        sessionId: "replacement-quiet-tool",
        upstreamAbortSignal: abortController.signal,
      }).then((admission) => {
        settled = true;
        return admission;
      });
      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      expect(settled).toBe(false);
      expect(cancel).not.toHaveBeenCalled();

      // Past the 15-minute floor the same waiting turn reclaims it.
      vi.setSystemTime(startedAt + 16 * 60_000);
      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      const result = await waiting;
      expect(active.result).toEqual({ kind: "failed", code: "run_stalled" });
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        result.operation.complete();
      }
      abortController.abort();
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it.each(["heartbeat", "queued_followup"] as const)(
    "does not let %s turns reclaim a stale active operation",
    async (kind) => {
      vi.useFakeTimers();
      try {
        const cancel = vi.fn();
        const startedAt = Date.now();
        const active = createTestReplyOperation({
          sessionKey: `agent:main:telegram:topic:stale-${kind}`,
          sessionId: `stale-${kind}-session`,
        });
        active.attachBackend({
          kind: "embedded",
          cancel,
          isStreaming: () => true,
        });
        active.setPhase("running");
        vi.setSystemTime(startedAt + RUN_STALE_TAKEOVER_MS + 1);

        const admission = admitTestReplyTurn({
          sessionKey: `agent:main:telegram:topic:stale-${kind}`,
          sessionId: `replacement-${kind}-session`,
          kind,
          waitTimeoutMs: 1,
        });
        if (kind === "queued_followup") {
          await Promise.resolve();
          await vi.advanceTimersByTimeAsync(100);
        }
        const result = await admission;

        expect(result).toMatchObject({
          status: "skipped",
          reason: "active-run",
          activeOperation: active,
        });
        expect(cancel).not.toHaveBeenCalled();
        expect(getSessionControllerOperation(`agent:main:telegram:topic:stale-${kind}`)).toBe(
          active,
        );
        active.complete();
      } finally {
        await vi.runOnlyPendingTimersAsync();
        vi.useRealTimers();
      }
    },
  );

  it("keeps terminal raw work owned after cleanup grace until its producer settles", async () => {
    vi.useFakeTimers();
    try {
      const active = createTestReplyOperation({
        sessionKey: "agent:main:telegram:topic:terminal-unreleased",
        sessionId: "terminal-unreleased-session",
      });
      active.setPhase("running");
      active.abortByUser();

      const admission = admitTestReplyTurn({
        sessionKey: "agent:main:telegram:topic:terminal-unreleased",
        sessionId: "replacement-terminal-session",
      });
      let admitted = false;
      void admission.then(() => {
        admitted = true;
      });
      await vi.advanceTimersByTimeAsync(SESSION_WATCHDOG_CLEANUP_MS);
      expect(admitted).toBe(false);
      expect(getSessionControllerOperation("agent:main:telegram:topic:terminal-unreleased")).toBe(
        active,
      );
      active.complete();
      const result = await admission;

      expect(active.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
      expect(
        getSessionControllerOperation("agent:main:telegram:topic:terminal-unreleased"),
      ).not.toBe(active);
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        result.operation.complete();
      }
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("stops waiting when the caller aborts", async () => {
    const active = createTestReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "active-session",
    });
    const abortController = new AbortController();
    const admitted = admitTestReplyTurn({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "waiting-session",
      kind: "queued_followup",
      upstreamAbortSignal: abortController.signal,
    });

    abortController.abort();

    await expect(admitted).resolves.toMatchObject({
      status: "skipped",
      reason: "aborted",
      activeOperation: active,
    });
    active.complete();
  });

  it("adopts a source-keyed command reservation into the target run slot", async () => {
    const sourceSessionKey = "agent:main:telegram:slash:adopt-user";
    const targetSessionKey = "agent:main:telegram:group:adopt-target";
    const targetSessionId = "target-session-adopt";
    const storePath = createSessionStore({
      [targetSessionKey]: { sessionId: targetSessionId, updatedAt: Date.now() },
    });
    const reservation = createTestReplyOperation({
      sessionKey: sourceSessionKey,
      sessionId: "source-reservation-adopt",
    });

    const admission = await admitTestReplyTurn({
      sessionKey: targetSessionKey,
      sessionId: reservation.sessionId,
      expectedSessionId: targetSessionId,
      storePath,
      waitForActive: false,
      adoptOperation: reservation,
    });

    expect(admission.status).toBe("owned");
    if (admission.status !== "owned") {
      return;
    }
    expect(admission.operation).toBe(reservation);
    expect(reservation.key).toBe(targetSessionKey);
    expect(getSessionControllerOperation(sourceSessionKey)).toBeUndefined();
    expect(getSessionControllerOperation(targetSessionKey)).toBe(reservation);

    // Target lifecycle interrupts must reach the adopted operation: reset or
    // delete on the target session interlocks with the continuation run.
    reservation.setPhase("running");
    let mutationRan = false;
    const mutation = runSessionMutation({
      scope: storePath,
      identities: [targetSessionKey, targetSessionId],
      prepare: async () => {
        await interruptSessionControllerEffects({
          scope: storePath,
          identities: [targetSessionKey, targetSessionId],
        });
      },
      run: async () => {
        mutationRan = true;
      },
    });
    await vi.waitFor(() => {
      expect(reservation.abortSignal.aborted).toBe(true);
    });
    expect(reservation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(mutationRan).toBe(false);

    reservation.complete();
    await mutation;
    expect(mutationRan).toBe(true);
  });

  it("skips adoption without waiting when the target run slot is owned", async () => {
    const sourceSessionKey = "agent:main:telegram:slash:busy-user";
    const targetSessionKey = "agent:main:telegram:group:busy-target";
    const targetSessionId = "target-session-busy";
    const storePath = createSessionStore({
      [targetSessionKey]: { sessionId: targetSessionId, updatedAt: Date.now() },
    });
    const blocker = createTestReplyOperation({
      sessionKey: targetSessionKey,
      sessionId: targetSessionId,
    });
    blocker.setPhase("running");
    const reservation = createTestReplyOperation({
      sessionKey: sourceSessionKey,
      sessionId: "source-reservation-busy",
    });

    const admission = await admitTestReplyTurn({
      sessionKey: targetSessionKey,
      sessionId: reservation.sessionId,
      expectedSessionId: targetSessionId,
      storePath,
      waitForActive: false,
      adoptOperation: reservation,
    });

    expect(admission).toMatchObject({
      status: "skipped",
      reason: "active-run",
      activeOperation: blocker,
    });
    // The reservation stays source-keyed so the command turn's own delivery
    // lifecycle is unaffected; queue policy handles the busy target.
    expect(reservation.key).toBe(sourceSessionKey);
    expect(getSessionControllerOperation(sourceSessionKey)).toBe(reservation);
    expect(getSessionControllerOperation(targetSessionKey)).toBe(blocker);
    expect(reservation.result).toBeNull();

    blocker.complete();
    reservation.complete();

  });
});
it("clears orphaned restart-recovery fences before visible admission", async () => {
  const storePath = store({
    status: "running",
    abortedLastRun: false,
    restartRecoveryRuns: [{ runId: "stale-run", lifecycleGeneration: "stale-generation" }],
  });
  const admitted = owned(await admit({ storePath, expectedSessionId: sessionId }));
  const entry = loadSessionEntry({ storePath, sessionKey });
  expect(entry?.restartRecoveryRuns).toBeUndefined();
  expect(entry?.mainRestartRecovery).toBeUndefined();
  admitted.complete();
});
it("schedules released recovery only after retained admission exits", async () => {
  const storePath = store(interruptedEntry());
  const blocker = operation();
  const reservation = operation({ sessionKey: sourceKey, sessionId: "source-session" });
  const result = await admit({
    storePath,
    sessionId: reservation.sessionId,
    expectedSessionId: sessionId,
    waitForActive: false,
    retainLifecycleAdmissionOnActive: true,
    adoptOperation: reservation,
  });
  expect(result).toMatchObject({ status: "skipped", reason: "active-run" });
  expect(releaseMocks.schedule).not.toHaveBeenCalled();
  expect(loadSessionEntry({ storePath, sessionKey })).not.toHaveProperty(
    "mainRestartRecovery.foregroundClaims",
  );
  if (result.status === "skipped") {
    result.lifecycleAdmission?.release();
  }
  await vi.waitFor(() =>
    expect(releaseMocks.schedule).toHaveBeenCalledWith({ ...scope, storePath }),
  );
  blocker.complete();
  reservation.complete();
});
it("excludes the initiating reply admission from an in-band lifecycle mutation", async () => {
  const storePath = store();
  const admitted = owned(await admit({ storePath, expectedSessionId: sessionId }));
  await runWithReplyOperationLifecycleAdmission(admitted, () =>
    interrupt(storePath, async () => {}),
  );
  expect(admitted.abortSignal.aborted).toBe(false);
  admitted.complete();
});
it("skips an aborted reply waiting behind a lifecycle mutation", async () => {
  const storePath = store();
  const release = await holdMutation(storePath);
  const controller = new AbortController();
  const admission = admit({ storePath, upstreamAbortSignal: controller.signal });
  controller.abort();
  await release();
  await expect(admission).resolves.toEqual({ status: "skipped", reason: "aborted" });
});
it("keeps an already-waiting follow-up behind the delivery barrier", async () => {
  vi.useFakeTimers();
  const active = operation();
  const barrier = createDeferred();
  let settled = false;
  const admission = admit({ sessionId: "queued-session", kind: "queued_followup" }).then(
    (result) => {
      settled = true;
      return result;
    },
  );
  try {
    await vi.advanceTimersByTimeAsync(0);
    active.completeWithAfterClearBarrier(barrier.promise);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
  } finally {
    active.complete();
    barrier.resolve();
    owned(await admission).complete();
  }
});
it("skips heartbeat turns while delivery settles", async () => {
  const active = operation();
  const barrier = createDeferred();
  active.completeWithAfterClearBarrier(barrier.promise);
  await expect(admit({ sessionId: "heartbeat-session", kind: "heartbeat" })).resolves.toEqual({
    status: "skipped",
    reason: "active-run",
  });
  barrier.resolve();
  await barrier.promise;
});
it("uses the active run's final session id after waiting", async () => {
  const active = operation();
  active.setPhase("preflight_compacting");
  const admission = admit({ sessionId: "new-session" });
  await Promise.resolve();
  active.updateSessionId("post-compact-session");
  active.complete();
  const result = owned(await admission);
  expect(result.sessionId).toBe("post-compact-session");
  result.complete();
});
it("keeps visible turns waiting while an active operation is still fresh", async () => {
  vi.useFakeTimers();
  const active = operation();
  active.setPhase("running");
  active.recordActivity();
  const controller = new AbortController();
  let settled = false;
  const admission = admit({
    sessionId: "waiting-session",
    upstreamAbortSignal: controller.signal,
  }).then((result) => {
    settled = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
  expect(settled).toBe(false);
  expect(replyRunRegistry.get(sessionKey)).toBe(active);
  controller.abort();
  await expect(admission).resolves.toMatchObject({
    status: "skipped",
    reason: "aborted",
    activeOperation: active,
  });
});
it("defers takeover to the blocked-tool floor while a quiet tool is active", async () => {
  vi.useFakeTimers();
  const startedAt = Date.now();
  const active = operation();
  const cancel = vi.fn(() => active.complete());
  active.attachBackend({ kind: "embedded", cancel, isStreaming: () => true });
  active.setPhase("running");
  markDiagnosticToolStartedForTest({ ...scope, toolName: "exec", toolCallId: "tool-quiet-1" });
  vi.setSystemTime(startedAt + 12 * 60_000);
  const controller = new AbortController();
  let settled = false;
  const admission = admit({
    sessionId: "replacement",
    upstreamAbortSignal: controller.signal,
  }).then((result) => {
    settled = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
  expect(settled).toBe(false);
  expect(cancel).not.toHaveBeenCalled();
  vi.setSystemTime(startedAt + 16 * 60_000);
  await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
  const result = owned(await admission);
  expect(active.result).toEqual({ kind: "failed", code: "run_stalled" });
  result.complete();
  controller.abort();
});
it.each(["heartbeat", "queued_followup"] as const)(
  "does not let %s turns reclaim a stale active operation",
  async (kind) => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const active = operation();
    const cancel = vi.fn();
    active.attachBackend({ kind: "embedded", cancel, isStreaming: () => true });
    active.setPhase("running");
    vi.setSystemTime(startedAt + RUN_STALE_TAKEOVER_MS + 1);
    const admission = admit({ sessionId: "replacement", kind, waitTimeoutMs: 1 });
    if (kind === "queued_followup") {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
    }
    await expect(admission).resolves.toMatchObject({
      status: "skipped",
      reason: "active-run",
      activeOperation: active,
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(replyRunRegistry.get(sessionKey)).toBe(active);
    active.complete();
  },
);
it("lets visible turns reclaim terminal operations after settle grace elapsed", async () => {
  vi.useFakeTimers();
  const active = operation();
  active.setPhase("running");
  active.abortByUser();
  const admission = admit({ sessionId: "replacement" });
  await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS);
  const result = owned(await admission);
  expect(active.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
  expect(replyRunRegistry.get(sessionKey)).not.toBe(active);
  result.complete();
});
it("adopts a source-keyed command reservation into the target run slot", async () => {
  const storePath = store();
  const reservation = operation({ sessionKey: sourceKey, sessionId: "source-session" });
  expect(
    owned(
      await admit({
        storePath,
        sessionId: reservation.sessionId,
        expectedSessionId: sessionId,
        waitForActive: false,
        adoptOperation: reservation,
      }),
    ),
  ).toBe(reservation);
  expect(reservation.key).toBe(sessionKey);
  expect(replyRunRegistry.get(sourceKey)).toBeUndefined();
  expect(replyRunRegistry.get(sessionKey)).toBe(reservation);
  reservation.setPhase("running");
  let mutationRan = false;
  const mutation = interrupt(storePath, async () => {
    mutationRan = true;
  });
  await vi.waitFor(() => expect(reservation.abortSignal.aborted).toBe(true));
  expect(reservation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
  expect(mutationRan).toBe(false);
  reservation.complete();
  await mutation;
  expect(mutationRan).toBe(true);
});
it("skips adoption without waiting when the target run slot is owned", async () => {
  const storePath = store();
  const blocker = operation();
  blocker.setPhase("running");
  const reservation = operation({ sessionKey: sourceKey, sessionId: "source-session" });
  const result = await admit({
    storePath,
    sessionId: reservation.sessionId,
    expectedSessionId: sessionId,
    waitForActive: false,
    adoptOperation: reservation,
  });
  expect(result).toMatchObject({
    status: "skipped",
    reason: "active-run",
    activeOperation: blocker,
  });
  expect(reservation.key).toBe(sourceKey);
  expect(replyRunRegistry.get(sourceKey)).toBe(reservation);
  expect(replyRunRegistry.get(sessionKey)).toBe(blocker);
  expect(reservation.result).toBeNull();
  blocker.complete();
  reservation.complete();
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRunRestartAbortError } from "../agents/run-termination.js";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import { reserveSteerCandidate, enqueueFollowupRun } from "../auto-reply/reply/queue/enqueue.js";
import { admitFollowupRunLifecycle } from "../auto-reply/reply/queue/lifecycle.js";
import { clearFollowupQueue } from "../auto-reply/reply/queue/state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { deferSessionControllerClaimBeforeExecution } from "./session-controller.mailbox-claim.js";
import {
  reserveSessionControllerSource,
  bindSessionControllerSource,
  claimSessionControllerInput,
  releaseSessionControllerClaim,
  retireSessionControllerInput,
  holdSessionControllerSourceWithdrawal,
  abortSessionControllerInput,
  getExistingSessionControllerMailbox,
  captureSessionControllerSourceSettlement,
  beginSessionControllerSourceInjection,
  claimSessionControllerTask,
  tryClaimSessionControllerTask,
} from "./session-controller.mailbox.js";
import { createReplyOperation } from "./session-controller.operation.js";
import { findSessionControllerEntry } from "./session-controller.state.js";
const key = "agent:mailbox:test";
afterEach(() => {
  findSessionControllerEntry(key)?.active?.complete();
  clearFollowupQueue(key);
  vi.useRealTimers();
});
function source(prompt: string) {
  const run = createQueueTestRun({ prompt });
  run.run.sessionKey = key;
  return run;
}

describe("controller mailbox scheduling", () => {
  it.each(["ready", "task"] as const)(
    "releases the consumed %s callback before a source retry",
    async (kind) => {
      const input = reserveSessionControllerSource(key, { policy: { mode: "followup" } });
      const run = source("retry after preflight refusal");
      bindSessionControllerSource(input, run);
      const request = () =>
        kind === "ready"
          ? claimSessionControllerInput(run)
          : claimSessionControllerTask(input, () => {});
      try {
        const first = await request();
        expect(deferSessionControllerClaimBeforeExecution(first)).toBe(true);
        releaseSessionControllerClaim(first);
        await first.settlement.promise;
        expect(input.mailbox.claim).toBeUndefined();
        const retried = await request();
        expect(retried).not.toBe(first);
        expect(retried.inputs).toContain(input);
        releaseSessionControllerClaim(retried);
        await retried.settlement.promise;
      } finally {
        const remaining = input.mailbox.claim;
        if (remaining) {
          releaseSessionControllerClaim(remaining);
          await remaining.settlement.promise;
        }
        retireSessionControllerInput(input);
        await input.settlement.promise;
      }
    },
  );
  it("retires a queued injection before releasing its receipt when live authority rejects", async () => {
    const active = createReplyOperation({
      sessionKey: key,
      sessionId: "active",
      resetTriggered: false,
    });
    let revoked = false;
    const input = reserveSessionControllerSource(key, {
      policy: { mode: "followup", debounceMs: 0 },
      adapter: {
        authority: {
          assertCurrent: () => {
            if (revoked) {
              active.complete();
              throw new Error("source authority revoked");
            }
          },
        },
      },
    });
    const run = source("must not execute");
    bindSessionControllerSource(input, run);
    const dispatch = vi.fn(async () => {});
    enqueueFollowupRun(key, run, { mode: "followup", debounceMs: 0 }, "none", dispatch);
    const injection = beginSessionControllerSourceInjection(input);
    revoked = true;
    await expect(injection.admit()).rejects.toThrow("source authority revoked");
    await captureSessionControllerSourceSettlement(input);
    expect(dispatch).not.toHaveBeenCalled();
    expect(findSessionControllerEntry(key)).toBeUndefined();
  });
  it("does not let pre-dispatch bypass an older preparing input or retain a failed claim request", async () => {
    const first = reserveSessionControllerSource(key, { policy: { mode: "followup" } });
    const second = reserveSessionControllerSource(key, { policy: { mode: "followup" } });
    expect(tryClaimSessionControllerTask(second)).toBeUndefined();
    const firstClaim = tryClaimSessionControllerTask(first);
    expect(firstClaim?.inputs).toEqual([first]);
    expect(tryClaimSessionControllerTask(second)).toBeUndefined();
    releaseSessionControllerClaim(firstClaim!);
    await firstClaim!.settlement.promise;
    const secondClaim = await claimSessionControllerTask(second, () => {});
    expect(secondClaim.inputs).toEqual([second]);
    releaseSessionControllerClaim(secondClaim);
    await secondClaim.settlement.promise;
    expect(findSessionControllerEntry(key)).toBeUndefined();
  });
  it("reserves interrupt D before A settles, then keeps B,C in original order", async () => {
    const a = createReplyOperation({ sessionKey: key, sessionId: "a", resetTriggered: false });
    const order: string[] = [];
    const drained = createDeferredCore();
    const dispatch = async (run: ReturnType<typeof source>) => {
      order.push(run.prompt);
      if (run.prompt === "C") {
        drained.resolve();
      }
    };
    enqueueFollowupRun(key, source("B"), { mode: "followup", debounceMs: 0 }, "none", dispatch);
    enqueueFollowupRun(key, source("C"), { mode: "followup", debounceMs: 0 }, "none", dispatch);
    const d = reserveSessionControllerSource(key, {
      protocolRunId: " D ",
      policy: { mode: "interrupt" },
    });
    a.complete();
    expect(order).toEqual([]);
    const run = source("D");
    bindSessionControllerSource(d, run);
    const claim = await claimSessionControllerInput(run);
    expect(claim.inputs).toEqual([d]);
    expect(order).toEqual([]);
    releaseSessionControllerClaim(claim);
    await drained.promise;
    expect(order).toEqual(["B", "C"]);
  });
  it("canceling an older priority never clears the newest interrupt reservation", async () => {
    const first = reserveSessionControllerSource(key, {
      protocolRunId: "old",
      policy: { mode: "interrupt" },
    });
    const newest = reserveSessionControllerSource(key, {
      protocolRunId: "new",
      policy: { mode: "interrupt" },
    });
    retireSessionControllerInput(first);
    expect(getExistingSessionControllerMailbox(key)?.priority).toBe(newest);
    const run = source("new");
    bindSessionControllerSource(newest, run);
    const claim = await claimSessionControllerInput(run);
    expect(claim.inputs).toEqual([newest]);
    releaseSessionControllerClaim(claim);
    await claim.settlement.promise;
    expect(Boolean(findSessionControllerEntry(key))).toBe(false);
  });
  it("preserves exact protocol identities and withdrawal custody before payload exists", () => {
    const cancel = vi.fn();
    const input = reserveSessionControllerSource(key, {
      protocolRunId: " id ",
      policy: { mode: "followup" },
      adapter: { cancel },
    });
    expect(input.protocolRunId).toBe(" id ");
    expect(getExistingSessionControllerMailbox(key)?.entries).toEqual([input]);
    const release = holdSessionControllerSourceWithdrawal(input);
    expect(abortSessionControllerInput(input)).toBe(false);
    release();
    release();
    expect(abortSessionControllerInput(input)).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(findSessionControllerEntry(key)).toBeUndefined();
  });
  it("does not replay a selected input when asynchronous source adoption fails", async () => {
    const run = source("do once");
    const settled = createDeferredCore();
    run.turnAdoptionLifecycle = { onAdopted: () => {}, onSettled: () => settled.resolve() };
    const dispatched = vi.fn(async () => {
      throw new Error("custody failed after side effects");
    });
    enqueueFollowupRun(key, run, { mode: "followup", debounceMs: 0 }, "none", dispatched);
    await settled.promise;
    await captureSessionControllerSourceSettlement(run.controllerInput!);
    await run.controllerInput!.claim?.settlement.promise;
    expect(findSessionControllerEntry(key)).toBeUndefined();
    expect(dispatched).toHaveBeenCalledOnce();
  });
});

it("clearFollowupQueue retains delayed native injection and source adoption until actual cleanup", async () => {
  const run = source("delayed native input");
  const adopted = createDeferredCore();
  const settled = vi.fn();
  run.turnAdoptionLifecycle = { onAdopted: () => adopted.promise, onSettled: settled };
  const reservation = reserveSteerCandidate(
    key,
    run,
    { mode: "steer", debounceMs: 0 },
    async () => {},
  );
  expect(reservation).toBeDefined();
  if (!reservation) {
    throw new Error("Missing injection reservation");
  }
  expect(await reservation.admit()).toBe("steer");
  const input = run.controllerInput;
  if (!input) {
    throw new Error("Missing source input");
  }
  const injection = input.injection;
  const adoption = admitFollowupRunLifecycle(run);
  clearFollowupQueue(key);
  expect(input.mailbox.entries).toContain(input);
  expect(input.injection).toBe(injection);
  expect(injection?.accepted).toBeUndefined();
  expect(settled).not.toHaveBeenCalled();
  reservation.accepted(true);
  reservation.consume("consumed");
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  expect(input.mailbox.entries).toContain(input);
  adopted.resolve();
  await adoption;
  await captureSessionControllerSourceSettlement(input);
  expect(settled).toHaveBeenCalledOnce();
  expect(input.mailbox.entries).not.toContain(input);
});

function earlySource(adapter?: Parameters<typeof reserveSessionControllerSource>[1]["adapter"]) {
  return reserveSessionControllerSource(key, {
    protocolRunId: " exact source ",
    policy: { mode: "followup" },
    adapter,
  });
}

describe("early source injection custody", () => {
  it("serializes exact attempts through outcome, without synthesizing FollowupRun", async () => {
    const first = earlySource();
    const second = earlySource();
    const a = beginSessionControllerSourceInjection(first);
    const b = beginSessionControllerSourceInjection(second);
    expect(await a.admit()).toBe(true);
    expect(first.source).toBeUndefined();
    expect(await a.admit()).toBe(false);
    expect(await beginSessionControllerSourceInjection(first).admit()).toBe(false);
    const admitted = vi.fn();
    const next = b.admit().then((value) => {
      admitted(value);
      return value;
    });
    a.accepted(true);
    a.accepted(false);
    await Promise.resolve();
    expect(admitted).not.toHaveBeenCalled();
    await expect(claimSessionControllerTask(first, () => {})).rejects.toThrow(/injection/);
    // Acceptance wins even if a late caller mistakes the outcome for rejection.
    a.finish(false);
    expect(await next).toBe(true);
    expect(first.phase).toBe("consumed");
    expect(second.phase).toBe("injecting");
    // Old callbacks must not consume a same-ID sibling.
    a.accepted(true);
    a.finish(true);
    expect(second.abortSignal.aborted).toBe(false);
    b.accepted(false);
    b.finish(false);
    const claim = await claimSessionControllerTask(second, () => {});
    expect(claim.inputs).toEqual([second]);
    releaseSessionControllerClaim(claim);
    await claim.settlement.promise;
  });

  it("keeps uncertain cancelled native work until finish and joins source cleanup", async () => {
    const cleanup = createDeferredCore();
    const cancel = vi.fn();
    const settled = vi.fn(() => cleanup.promise);
    const input = earlySource({ cancel, onSettled: settled });
    const injection = beginSessionControllerSourceInjection(input);
    expect(await injection.admit()).toBe(true);
    const reason = createAgentRunRestartAbortError();
    expect(abortSessionControllerInput(input, reason)).toBe(true);
    expect(abortSessionControllerInput(input, reason)).toBe(false);
    injection.accepted(false);
    expect(input.phase).toBe("injecting");
    expect(settled).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
    const receipt = captureSessionControllerSourceSettlement(input);
    const completed = vi.fn();
    void receipt.then(completed);
    injection.finish(true); // Native rejection is indeterminate, not safe replay.
    expect(settled).toHaveBeenCalledOnce();
    expect(input.mailbox.entries).toContain(input);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    cleanup.resolve();
    await receipt;
    expect(input.mailbox.entries).not.toContain(input);
    expect(await beginSessionControllerSourceInjection(input).admit()).toBe(false);
  });

  it("rejects held withdrawal and rechecks source authority after its predecessor", async () => {
    const first = earlySource();
    let current = true;
    const second = earlySource({
      authority: {
        assertCurrent() {
          if (!current) {
            throw new Error("source revoked");
          }
        },
      },
    });
    const hold = holdSessionControllerSourceWithdrawal(second);
    expect(await beginSessionControllerSourceInjection(second).admit()).toBe(false);
    expect(second.phase).toBe("preparing");
    hold.release();
    const a = beginSessionControllerSourceInjection(first);
    expect(await a.admit()).toBe(true);
    const b = beginSessionControllerSourceInjection(second);
    const pending = expect(b.admit()).rejects.toThrow("source revoked");
    current = false;
    a.finish(true);
    await pending;
    expect(second.injection).toBeUndefined();
    await captureSessionControllerSourceSettlement(second);
    expect(second.phase).toBe("consumed");
    expect(await beginSessionControllerSourceInjection(second).admit()).toBe(false);
  });

  it("cancels a not-yet-admitted attempt without releasing its predecessor", async () => {
    const first = earlySource();
    const second = earlySource();
    const a = beginSessionControllerSourceInjection(first);
    expect(await a.admit()).toBe(true);
    const b = beginSessionControllerSourceInjection(second);
    const pending = b.admit();
    abortSessionControllerInput(second, "stop");
    expect(await pending).toBe(false);
    await captureSessionControllerSourceSettlement(second);
    expect(first.phase).toBe("injecting");
    expect(first.abortSignal.aborted).toBe(false);
    a.finish(true);
  });
});

describe("committed source withdrawal", () => {
  it("commits after revocation and retirement without touching a same-ID successor", async () => {
    const authority = new AbortController();
    const cancel = vi.fn();
    const input = earlySource({
      authority: {
        signal: authority.signal,
        assertCurrent: () => authority.signal.throwIfAborted(),
      },
      cancel,
    });
    const hold = holdSessionControllerSourceWithdrawal(input);
    expect(() => holdSessionControllerSourceWithdrawal(input)).toThrow(/unavailable/);
    const selected = vi.fn();
    const queued = claimSessionControllerTask(input, selected);
    const revoked = new Error("execution authority revoked by committed publication");
    const rejected = expect(queued).rejects.toBe(revoked);
    // Publication of the successful DB discard may revoke admission authority
    // and remove protocol correlation before its await resumes.
    authority.abort(revoked);
    retireSessionControllerInput(input);
    const successor = earlySource();
    const discarded = new Error("committed discard");
    cancel.mockImplementation(() => {
      expect(hold.commit(discarded)).toBe(false);
      hold.release();
      expect(selected).not.toHaveBeenCalled();
    });
    expect(input.mailbox.entries).toContain(input);
    expect(hold.commit(discarded)).toBe(true);
    expect(hold.commit(discarded)).toBe(false);
    await rejected;
    await captureSessionControllerSourceSettlement(input);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(discarded);
    expect(input.withdrawalHolds).toBe(0);
    expect(selected).not.toHaveBeenCalled();
    expect(successor.phase).toBe("preparing");
    expect(successor.abortSignal.aborted).toBe(false);
    retireSessionControllerInput(successor);
  });

  it("releases a failed discard back to the same usable source", async () => {
    const input = earlySource();
    const hold = holdSessionControllerSourceWithdrawal(input);
    const selected = vi.fn();
    const pending = claimSessionControllerTask(input, selected);
    expect(selected).not.toHaveBeenCalled();
    expect(() =>
      hold.cancel(() => {
        throw new Error("DB precommit refused");
      }),
    ).toThrow(/refused/);
    hold();
    hold.release();
    const claim = await pending;
    expect(claim.inputs).toEqual([input]);
    expect(input.abortSignal.aborted).toBe(false);
    expect(hold.commit("late callback")).toBe(false);
    expect(selected).toHaveBeenCalledOnce();
    releaseSessionControllerClaim(claim);
    await claim.settlement.promise;
  });
});

describe("exact source cancellation authority", () => {
  it.each([
    ["restart", () => createAgentRunRestartAbortError()],
    ["timeout", () => new DOMException("execution deadline", "TimeoutError")],
    [
      "watchdog cause",
      () => new Error("stalled attempt", { cause: new Error("watchdog evidence") }),
    ],
    ["user", () => new Error("user stop")],
  ] as const)(
    "preserves %s and cancels operation/source exactly once under requester authority",
    async (_label, createReason) => {
      let current = true;
      const cancelSource = vi.fn();
      const input = earlySource({
        authority: {
          assertCurrent() {
            if (!current) {
              throw new Error("original operator revoked");
            }
          },
        },
        cancel: cancelSource,
      });
      const claim = await claimSessionControllerTask(input, () => {});
      const operation = createReplyOperation({
        sessionKey: key,
        sessionId: "causal-operation",
        resetTriggered: false,
        mailboxClaim: claim,
        upstreamAbortSignal: claim.abortController.signal,
      });
      operation.setPhase("running");
      const cancelBackend = vi.fn(() => {
        expect(abortSessionControllerInput(input, "reentrant")).toBe(false);
      });
      operation.attachBackend({ kind: "embedded", cancel: cancelBackend });
      current = false;
      const reason = createReason();
      expect(() =>
        abortSessionControllerInput(input, reason, () => {
          throw new Error("requester revoked");
        }),
      ).toThrow("requester revoked");
      expect(cancelBackend).not.toHaveBeenCalled();
      expect(abortSessionControllerInput(input, reason, () => {})).toBe(true);
      expect(operation.abortSignal.reason).toBe(reason);
      expect(input.abortSignal.reason).toBe(reason);
      expect(claim.abortController.signal.reason).toBe(reason);
      expect(cancelBackend).toHaveBeenCalledOnce();
      expect(cancelSource).toHaveBeenCalledExactlyOnceWith(reason);
      expect(abortSessionControllerInput(input, reason)).toBe(false);
      expect(input.mailbox.entries).toContain(input);
      operation.complete();
      releaseSessionControllerClaim(claim);
      await claim.settlement.promise;
    },
  );

  it("refuses new abort effects for frozen operation outcomes", async () => {
    const cancel = vi.fn();
    const input = earlySource({ cancel });
    const claim = await claimSessionControllerTask(input, () => {});
    const operation = createReplyOperation({
      sessionKey: key,
      sessionId: "finishing",
      resetTriggered: false,
      mailboxClaim: claim,
    });
    operation.freezeAbort();
    expect(abortSessionControllerInput(input, "stop")).toBe(false);
    expect(input.abortSignal.aborted).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    operation.complete();
    releaseSessionControllerClaim(claim);
    await claim.settlement.promise;
  });
});

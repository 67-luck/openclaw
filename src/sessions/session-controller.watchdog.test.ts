import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginReplyOperationFinalizationWork } from "../auto-reply/reply/reply-run-finalization-lease.js";
import { testing } from "../auto-reply/reply/reply-run-registry.test-support.js";
import {
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withSessionTurn } from "./session-controller.admission.js";
import { createReplyOperation } from "./session-controller.operation.js";
import { getSessionControllerOperation } from "./session-controller.state.js";
import {
  SESSION_WATCHDOG_CLEANUP_MS,
  SESSION_WATCHDOG_QUIET_TOOL_MS,
} from "./session-controller.watchdog-state.js";

const key = "agent:main:watchdog-boundary";
const sessionId = "watchdog-incarnation";
const abortMs = 6 * 60_000;
function begin() {
  const operation = createReplyOperation({ sessionKey: key, sessionId, resetTriggered: false });
  operation.setPhase("running");
  return operation;
}
function attach(
  operation: ReturnType<typeof begin>,
  cancel: () => void = vi.fn(() => operation.complete()),
) {
  operation.attachBackend({ kind: "embedded", runId: "watchdog-run", cancel });
  return cancel;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  setDiagnosticsEnabledForProcess(false);
});
afterEach(() => {
  testing.resetReplyRunRegistry();
  resetDiagnosticEventsForTest();
  vi.useRealTimers();
});

describe("operation-owned watchdog through controller admission", () => {
  it("stops a silent run without diagnostics, inbound traffic or a backlog", async () => {
    const operation = begin();
    const cancel = attach(operation);
    vi.setSystemTime(abortMs - 1);
    operation.recordActivity(); // A source arrival is not semantic progress.
    expect(operation.watchdog.decide().action).toBe("warn");
    vi.setSystemTime(abortMs);
    await operation.watchdog.tick();
    expect(cancel).toHaveBeenCalledOnce();
    expect(operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
    expect(getSessionControllerOperation(key)).toBeUndefined();
  });

  it("runs its timer with diagnostic logging disabled", async () => {
    const operation = begin();
    const cancel = attach(operation);
    await vi.advanceTimersByTimeAsync(abortMs + 1_000);
    expect(cancel).toHaveBeenCalledOnce();
    expect(operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
  });

  it.each(["global_capacity", "deferred_maintenance", "human_question", "runtime_owned"] as const)(
    "protects explicit live %s waits, not detached flags",
    async (kind) => {
      const operation = begin();
      const cancel = attach(operation);
      let live = true;
      operation.watchdog.beginWait({ kind, isCurrent: () => live });
      vi.setSystemTime(abortMs * 4);
      await operation.watchdog.tick();
      expect(cancel).not.toHaveBeenCalled();
      live = false;
      await operation.watchdog.tick();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("uses actual approval expiry and revocation, without a second timeout", async () => {
    const operation = begin();
    const cancel = attach(operation);
    const expiry = abortMs * 3;
    operation.watchdog.beginWait({ kind: "approval", deadlineAtMs: expiry, isCurrent: () => true });
    vi.setSystemTime(expiry - 1);
    await operation.watchdog.tick();
    expect(cancel).not.toHaveBeenCalled();
    vi.setSystemTime(expiry);
    await operation.watchdog.tick();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps one semantic clock across retry replacement and repeated transport requests", async () => {
    const operation = begin();
    const cancel = attach(operation);
    const first = operation.watchdog.attachAttempt({ assertCurrent() {} });
    first.beginRequest({ deadlineAtMs: 90_000 });
    vi.setSystemTime(abortMs - 1_000);
    const second = operation.watchdog.attachAttempt({ assertCurrent() {} });
    second.beginRequest({ deadlineAtMs: abortMs + 90_000 });
    second.progress("transport", "retry:bytes");
    operation.watchdog.progress("source_arrival");
    expect(first.progress("semantic")).toBe(false);
    vi.setSystemTime(abortMs);
    await operation.watchdog.tick();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("accepts exact meaningful progress and rejects an old callback after replacement", async () => {
    const operation = begin();
    const old = operation.watchdog.attachAttempt({ assertCurrent() {} });
    vi.setSystemTime(abortMs - 1);
    const current = operation.watchdog.attachAttempt({ assertCurrent() {} });
    expect(current.progress("semantic", "assistant:result")).toBe(true);
    expect(old.progress("semantic")).toBe(false);
    expect(operation.watchdog.decide().action).toBe("observe");
    operation.complete();
    const successor = begin();
    const cancel = attach(successor);
    await operation.watchdog.tick(abortMs * 10);
    expect(cancel).not.toHaveBeenCalled();
    expect(getSessionControllerOperation(key)).toBe(successor);
  });

  it("honors owned tool and execution deadlines on the exact attempt", async () => {
    const operation = begin();
    const cancel = attach(operation);
    const attempt = operation.watchdog.attachAttempt({ assertCurrent() {} });
    let enforcedDeadline = 120_000;
    attempt.beginTool({
      toolName: "exec",
      toolCallId: "command",
      get deadlineAtMs() {
        return enforcedDeadline;
      },
    });
    enforcedDeadline = 300_000;
    vi.setSystemTime(SESSION_WATCHDOG_QUIET_TOOL_MS + enforcedDeadline - 1);
    await operation.watchdog.tick();
    expect(cancel).not.toHaveBeenCalled();
    attempt.setExecutionDeadline(Date.now());
    await operation.watchdog.tick();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retains finishing custody after failed cleanup until the raw writer actually settles", async () => {
    const operation = begin();
    const cancel = attach(
      operation,
      vi.fn(() => {
        throw new Error("writer still live");
      }),
    );
    operation.freezeAbort();
    const releaseWork = beginReplyOperationFinalizationWork(
      operation,
      SESSION_WATCHDOG_CLEANUP_MS * 2,
    );
    let rawSettled = false;
    void operation.ownerSettlement.then(() => {
      rawSettled = true;
    });
    const successorStarted = createDeferredCore();
    const successor = withSessionTurn({ sessionKey: key, sessionId }, async () => {
      successorStarted.resolve();
    });
    let ranSuccessor = false;
    void successorStarted.promise.then(() => {
      ranSuccessor = true;
    });
    vi.setSystemTime(SESSION_WATCHDOG_CLEANUP_MS + 1);
    await operation.watchdog.tick();
    expect(cancel).not.toHaveBeenCalled();
    releaseWork();
    await operation.watchdog.tick();
    expect(cancel).toHaveBeenCalledOnce();
    expect(operation.result?.kind).not.toBe("aborted");
    expect(operation.result?.kind).not.toBe("failed");
    expect(rawSettled).toBe(false);
    expect(ranSuccessor).toBe(false);
    expect(getSessionControllerOperation(key)).toBe(operation);
    operation.complete();
    await operation.ownerSettlement;
    await successor;
    expect(rawSettled).toBe(true);
    expect(ranSuccessor).toBe(true);
    expect(operation.result).toEqual({ kind: "completed" });
  });
  it("keeps a committed result and raw after-clear writer behind cleanup expiry", async () => {
    const operation = begin();
    const writer = createDeferredCore();
    operation.freezeAbort();
    operation.completeWithAfterClearBarrier(writer.promise, 10);
    expect(operation.result).toEqual({ kind: "completed" });
    let rawSettled = false;
    void operation.ownerSettlement.then(() => {
      rawSettled = true;
    });
    const dispatch = vi.fn();
    const successor = withSessionTurn({ sessionKey: key, sessionId }, async () => {
      dispatch();
    });
    vi.setSystemTime(SESSION_WATCHDOG_CLEANUP_MS + 1);
    await operation.watchdog.tick();
    expect(operation.result).toEqual({ kind: "completed" });
    expect(rawSettled).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    writer.resolve();
    await operation.ownerSettlement;
    await successor;
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it("publishes running maintenance wait and resumes the same semantic owner", async () => {
    const operation = begin();
    const cancel = attach(operation);
    operation.markWaitingForDeferredMaintenance();
    vi.setSystemTime(abortMs * 2);
    await operation.watchdog.tick();
    expect(cancel).not.toHaveBeenCalled();
    expect(operation.phase).toBe("waiting_for_deferred_maintenance");
    operation.markDeferredMaintenanceWaitEnded();
    expect(operation.phase).toBe("running");
    expect(operation.watchdog.snapshot().semanticProgressAtMs).toBe(Date.now());
    operation.complete();
  });

  it.each(["backend-throw", "cleanup-throw", "attempt-close"] as const)(
    "retains the writer and requests every captured cleanup after %s",
    async (failure) => {
      const operation = begin();
      const attempt = operation.watchdog.attachAttempt({ assertCurrent() {} });
      attach(operation, () => {
        if (failure === "backend-throw") {
          throw new Error("backend cancellation failed");
        }
        if (failure === "attempt-close") {
          attempt.close();
        }
      });
      const firstCleanup = vi.fn(async () => {
        if (failure === "cleanup-throw") {
          throw new Error("placement retirement failed");
        }
      });
      const secondCleanup = vi.fn(async () => {});
      operation.registerExecutionCleanup(firstCleanup);
      operation.registerExecutionCleanup(secondCleanup);
      vi.setSystemTime(abortMs);
      await operation.watchdog.tick();
      expect(firstCleanup).toHaveBeenCalledOnce();
      expect(secondCleanup).toHaveBeenCalledOnce();
      expect(operation.watchdog.snapshot().recovery?.status).toBe("blocked");
      expect(operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
      expect(getSessionControllerOperation(key)).toBe(operation);
      operation.complete();
      await operation.ownerSettlement;
    },
  );

  it("keeps the rekeyed after-clear watchdog live until its actual completion barrier", async () => {
    const operation = createReplyOperation({ sessionKey: key, sessionId, resetTriggered: false });
    operation.updateSessionKey(key + ":adopted");
    const writer = createDeferredCore();
    operation.completeWithAfterClearBarrier(writer.promise, 1);
    vi.setSystemTime(SESSION_WATCHDOG_CLEANUP_MS + 1);
    expect(operation.watchdog.decide().action).toBe("expire_cleanup");
    writer.resolve();
    await operation.ownerSettlement;
    expect(operation.watchdog.snapshot().phase).toBe("settled");
  });
});

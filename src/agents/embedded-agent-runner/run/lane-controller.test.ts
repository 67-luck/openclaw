import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { testing } from "../../../auto-reply/reply/reply-run-registry.test-support.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import type { CommandQueueEnqueueFn } from "../../../process/command-queue.types.js";
import { getSessionControllerOperation } from "../../../sessions/session-controller.state.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import type { RunEmbeddedAgentParams } from "./params.js";

const key = "agent:main:controller-execution";
const globalLane = "test:controller-global";
function create(runId: string, enqueue?: CommandQueueEnqueueFn) {
  let params: RunEmbeddedAgentParams & { sessionFile: string } = {
    admittedRunContext: createTestAdmittedRunContext(runId),
    sessionKey: key,
    sessionId: "incarnation",
    runId,
    sessionFile: "controller-execution.jsonl",
    workspaceDir: "/tmp/controller-execution",
    prompt: "test",
    timeoutMs: 60_000,
    trigger: "user",
    enqueue,
  };
  let generation = getAgentEventLifecycleGeneration();
  const controller = createEmbeddedRunLaneController({
    getLifecycleGeneration: () => generation,
    getParams: () => params,
    globalLane,
    initialQueuedLifecycleGeneration: generation,
    setLifecycleGeneration: (next) => {
      generation = next;
    },
    setParams: (next) => {
      params = next;
    },
  });
  return { controller, getParams: () => params };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  testing.resetReplyRunRegistry();
  resetCommandQueueStateForTest();
  vi.useRealTimers();
});

describe("controller-owned execution guard", () => {
  it("starts the preflight deadline after mailbox admission, not before its queue wait", async () => {
    const first = create("deadline-predecessor");
    const firstEntered = createDeferred();
    const firstFinish = createDeferred();
    const predecessor = first.controller.enqueueSession(async () => {
      firstEntered.resolve();
      await firstFinish.promise;
    });
    await firstEntered.promise;
    const second = create("deadline-successor");
    const secondEntered = createDeferred();
    const secondFinish = createDeferred();
    const successor = second.controller.enqueueSession(
      async () => {
        secondEntered.resolve();
        await secondFinish.promise;
        second.controller.throwIfAborted();
      },
      { taskTimeoutMs: 25 },
    );
    const outcome = successor.catch((error: unknown) => error);
    try {
      vi.setSystemTime(2_000);
      firstFinish.resolve();
      await predecessor;
      await secondEntered.promise;
      const operation = second.getParams().replyOperation;
      if (!operation) {
        throw new Error("Successor did not own a controller operation");
      }
      await operation.watchdog.tick();
      expect(second.controller.abortSignal.aborted).toBe(false);
      vi.setSystemTime(2_025);
      await operation.watchdog.tick();
      expect(second.controller.abortSignal.aborted).toBe(true);
    } finally {
      firstFinish.resolve();
      secondFinish.resolve();
      await Promise.allSettled([predecessor, outcome]);
    }
  });

  it("uses injected queues only for global capacity, never session admission or timeout races", async () => {
    const enqueue = vi.fn<(opts: Parameters<CommandQueueEnqueueFn>[1]) => void>();
    const { controller, getParams } = create("direct", async (task, opts) => {
      enqueue(opts);
      return await task();
    });
    await controller.enqueueSession(async () => {
      expect(enqueue).not.toHaveBeenCalled();
      expect(getSessionControllerOperation(key)).toBe(getParams().replyOperation);
      return controller.enqueueGlobal(async () => ({ meta: { durationMs: 1 } }));
    });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      taskIdentity: { runId: "direct", taskKind: "turn", sessionKey: key },
    });
    expect(enqueue.mock.calls[0]?.[0]?.taskTimeoutMs).toBeUndefined();
  });

  it.each(["deadline", "release"] as const)(
    "retains successor custody after %s until the raw producer settles",
    async (cause) => {
      const first = create("first");
      const entered = createDeferred();
      const raw = createDeferred();
      const run = first.controller.enqueueSession(
        async () => {
          entered.resolve();
          await raw.promise;
          first.controller.throwIfAborted();
        },
        { taskTimeoutMs: 25 },
      );
      const failed = expect(run).rejects.toThrow();
      await entered.promise;
      const operation = first.getParams().replyOperation!;
      const dispatch = vi.fn(async () => "successor");
      const second = create("second").controller.enqueueSession(dispatch);
      if (cause === "release") {
        first.controller.laneTaskReleaseController.abort(new Error("provider unwind exhausted"));
      } else {
        vi.setSystemTime(1_025);
        await operation.watchdog.tick();
      }
      expect(first.controller.abortSignal.aborted).toBe(true);
      expect(dispatch).not.toHaveBeenCalled();
      expect(getSessionControllerOperation(key)).toBe(operation);
      let settled = false;
      void operation.ownerSettlement.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      raw.resolve();
      await failed;
      await expect(second).resolves.toBe("successor");
      expect(settled).toBe(true);
    },
  );

  it("fences late preflight resumption before global admission without claiming timeout settlement", async () => {
    const { controller, getParams } = create("late-preflight");
    const entered = createDeferred();
    const gate = createDeferred();
    const execute = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    const run = controller.enqueueSession(
      async () => {
        entered.resolve();
        await gate.promise;
        controller.throwIfAborted();
        return controller.enqueueGlobal(execute);
      },
      { taskTimeoutMs: 25 },
    );
    const failed = expect(run).rejects.toThrow();
    await entered.promise;
    vi.setSystemTime(1_025);
    await getParams().replyOperation!.watchdog.tick();
    expect(getCommandLaneSnapshot(globalLane).activeCount).toBe(0);
    gate.resolve();
    await failed;
    expect(execute).not.toHaveBeenCalled();
  });

  it("protects actual global capacity waits and resumes their semantic clock", async () => {
    const { controller, getParams } = create("capacity");
    const queued = createDeferred();
    setCommandLaneConcurrency(globalLane, 0);
    const run = controller.enqueueSession(
      () =>
        controller.enqueueGlobal(async () => ({ meta: { durationMs: 1 } }), {
          onQueued: () => queued.resolve(),
        }),
      { taskTimeoutMs: 25 },
    );
    // Observe the installed owner and actual queue through an explicit enqueue notification.
    await queued.promise;
    expect(getCommandLaneSnapshot(globalLane).queuedCount).toBe(1);
    vi.setSystemTime(3_600_000);
    await getParams().replyOperation!.watchdog.tick();
    expect(controller.abortSignal.aborted).toBe(false);
    setCommandLaneConcurrency(globalLane, 1);
    await run;
  });

  it("does not let another queued global task shield an active stalled producer or release its capacity", async () => {
    const { controller, getParams } = create("parallel-capacity");
    const entered = createDeferred();
    const raw = createDeferred();
    const secondTask = vi.fn(async () => ({ meta: { durationMs: 2 } }));
    const run = controller.enqueueSession(async () => {
      const first = controller.enqueueGlobal(
        async () => {
          entered.resolve();
          await raw.promise;
          controller.throwIfAborted();
          return { meta: { durationMs: 1 } };
        },
        { taskTimeoutMs: 25 },
      );
      const second = controller.enqueueGlobal(secondTask);
      return await Promise.allSettled([first, second]);
    });
    await entered.promise;
    vi.setSystemTime(1_025);
    await getParams().replyOperation!.watchdog.tick();
    expect(getCommandLaneSnapshot(globalLane).activeCount).toBe(1);
    expect(secondTask).not.toHaveBeenCalled();
    raw.resolve();
    const outcomes = await run;
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    expect(getCommandLaneSnapshot(globalLane).activeCount).toBe(0);
  });
});

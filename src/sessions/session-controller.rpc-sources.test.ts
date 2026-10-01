import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
} from "../agents/run-termination.js";
import { createQueueTestRun, createQueueSettings } from "../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../auto-reply/reply/queue/enqueue.js";
import {
  completeFollowupRunLifecycle,
  retireFollowupRunCancellation,
} from "../auto-reply/reply/queue/lifecycle.js";
import { testing as controllerTesting } from "../auto-reply/reply/reply-run-registry.test-support.js";
import {
  registerChatAbortController,
  removeChatAbortControllerEntry,
} from "../gateway/chat-abort.js";
import { withSessionTurn } from "./session-controller.admission.js";
import { captureSessionTarget } from "./session-controller.lifecycle.js";
import {
  bindSessionControllerSource,
  captureSessionControllerSourceSettlement,
  holdSessionControllerSourceWithdrawal,
} from "./session-controller.mailbox.js";
import {
  getRpcSourceSignal,
  getRpcSourceStartedAt,
  isRpcSourceActive,
  isRpcSourceQueued,
  listRpcSourcesForSession,
  requestRpcSourceCancellation,
  type RpcSourceRef,
} from "./session-controller.rpc-sources.js";
import { markReplyOperationExecutionStarted } from "./session-controller.state.js";

const storeScope = "/synthetic/rpc-source-contracts/sessions.db";
const sessionKey = "agent:main:rpc-sources";
const sessionId = "rpc-source-session";
afterEach(() => {
  controllerTesting.resetReplyRunRegistry();
  vi.useRealTimers();
});

function reserve(
  rpcSources: Map<string, RpcSourceRef>,
  runId: string,
  scope = { sessionKey, sessionId, agentId: "main" },
) {
  const registration = registerChatAbortController({
    rpcSources,
    runId,
    ...scope,
    timeoutMs: 1,
    target: captureSessionTarget({
      storeScope: scope.sessionKey === "global" ? storeScope + "/" + scope.agentId : storeScope,
      sessionKey: scope.sessionKey,
      incarnation: scope.sessionId,
      agentId: scope.agentId,
    }),
  });
  if (!registration.entry) {
    throw new Error("Expected fresh RPC source reservation");
  }
  return { ...registration, entry: registration.entry };
}

function runSource(ref: RpcSourceRef, run: Parameters<typeof withSessionTurn>[1]) {
  return withSessionTurn(
    {
      sessionKey: ref.adapter.sessionKey,
      sessionId: ref.adapter.sessionId,
      storePath: storeScope,
      controllerInput: ref.input,
    },
    async (operation, signal) => {
      if (!operation) {
        throw new Error("Fixture requires a materialized turn");
      }
      markReplyOperationExecutionStarted(operation);
      operation.setPhase("running");
      return await run(operation, signal);
    },
  );
}

describe("RPC source owner boundary", () => {
  it("reserves before async preparation, then executes the same input rather than a second turn", async () => {
    const sources = new Map<string, RpcSourceRef>();
    const first = reserve(sources, "first");
    const prepared = createDeferred();
    const second = reserve(sources, "second");
    const order: string[] = [];
    const follower = runSource(second.entry, async () => {
      order.push("second");
    });
    expect(isRpcSourceActive(first.entry)).toBe(false);
    expect(isRpcSourceActive(second.entry)).toBe(false);
    expect(isRpcSourceQueued(first.entry)).toBe(true);
    expect(order).toEqual([]);
    const leader = (async () => {
      await prepared.promise;
      await runSource(first.entry, async (operation) => {
        expect(first.entry.input.claim?.operation).toBe(operation);
        expect(first.entry.input.claim?.inputs).toEqual([first.entry.input]);
        expect(isRpcSourceActive(first.entry)).toBe(true);
        order.push("first");
      });
    })();
    prepared.resolve();
    await Promise.all([leader, follower]);
    expect(order).toEqual(["first", "second"]);
    first.cleanup();
    second.cleanup();
    expect(sources.size).toBe(0);
  });

  it("cancels the exact claimed operation but retains retry custody until its producer settles", async () => {
    const sources = new Map<string, RpcSourceRef>();
    const source = reserve(sources, "active-source");
    const started = createDeferred();
    const release = createDeferred();
    const task = runSource(source.entry, async (operation, signal) => {
      expect(source.entry.input.claim?.operation).toBe(operation);
      expect(signal.aborted).toBe(false);
      started.resolve();
      await release.promise;
      expect(signal.aborted).toBe(true);
    });
    await started.promise;
    expect(requestRpcSourceCancellation(source.entry)).toBe(true);
    expect(isRpcSourceActive(source.entry)).toBe(false);
    source.cleanup();
    expect(sources.get("active-source")).toBe(source.entry);
    release.resolve();
    await task;
    await captureSessionControllerSourceSettlement(source.entry.input);
    expect(sources.has("active-source")).toBe(false);
  });

  it("keeps byte-exact spaced protocol IDs distinct during cancellation and duplicate admission", () => {
    const sources = new Map<string, RpcSourceRef>();
    const spaced = reserve(sources, " run ");
    const plain = reserve(sources, "run");
    const duplicate = registerChatAbortController({
      rpcSources: sources,
      runId: " run ",
      sessionKey,
      sessionId,
      timeoutMs: 1,
    });
    expect(duplicate.registered).toBe(false);
    expect(requestRpcSourceCancellation(spaced.entry)).toBe(true);
    expect(getRpcSourceSignal(plain.entry).aborted).toBe(false);
    spaced.cleanup();
    expect([...sources.keys()]).toEqual(["run"]);
    plain.cleanup();
  });

  it.each([false, true])("preserves exact cancellation reason (restart: %s)", (restart) => {
    const sources = new Map<string, RpcSourceRef>();
    const source = reserve(sources, "reason");
    const reason = restart ? createAgentRunRestartAbortError() : new Error("private reason");
    expect(requestRpcSourceCancellation(source.entry, reason)).toBe(true);
    expect(getRpcSourceSignal(source.entry).reason).toBe(reason);
    expect(isAgentRunRestartAbortReason(getRpcSourceSignal(source.entry).reason)).toBe(restart);
    expect(requestRpcSourceCancellation(source.entry, reason)).toBe(false);
    source.cleanup();
  });

  it("holds selection through withdrawal and cancels before releasing the held selector", async () => {
    const sources = new Map<string, RpcSourceRef>();
    const source = reserve(sources, "withdrawn");
    const hold = holdSessionControllerSourceWithdrawal(source.entry.input);
    const execute = vi.fn(async () => {});
    const pending = runSource(source.entry, execute);
    const rejected = expect(pending).rejects.toThrow();
    expect(requestRpcSourceCancellation(source.entry)).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(hold.cancel(() => {}, "rpc")).toBe(true);
    hold();
    await rejected;
    await captureSessionControllerSourceSettlement(source.entry.input);
    expect(execute).not.toHaveBeenCalled();
    expect(getRpcSourceSignal(source.entry).aborted).toBe(true);
    source.cleanup();
  });

  it("releases a refused withdrawal without poisoning the input or losing its queued execution", async () => {
    const sources = new Map<string, RpcSourceRef>();
    const source = reserve(sources, "retry-withdrawal");
    const hold = holdSessionControllerSourceWithdrawal(source.entry.input);
    const execute = vi.fn(async () => {});
    const pending = runSource(source.entry, execute);
    expect(() =>
      hold.cancel(() => {
        throw new Error("commit refused");
      }, "rpc"),
    ).toThrow("commit refused");
    expect(getRpcSourceSignal(source.entry).aborted).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    hold();
    hold();
    await pending;
    expect(execute).toHaveBeenCalledOnce();
    source.cleanup();
  });

  it("stale cancellation and cleanup cannot erase or cancel a successor with a reused run ID", () => {
    const sources = new Map<string, RpcSourceRef>();
    const first = reserve(sources, "reused");
    first.cleanup();
    const successor = reserve(sources, "reused");
    first.controller.abort();
    first.cleanup();
    expect(removeChatAbortControllerEntry(sources, "reused", first.entry)).toBe(false);
    expect(sources.get("reused")).toBe(successor.entry);
    expect(getRpcSourceSignal(successor.entry).aborted).toBe(false);
    successor.cleanup();
  });

  it("publishes cancellation while the exact source is retained and preserves a synchronous replacement", () => {
    const sources = new Map<string, RpcSourceRef>();
    const first = reserve(sources, "reentrant");
    let successor: ReturnType<typeof reserve> | undefined;
    first.entry.adapter.cancel = () => {
      expect(sources.get("reentrant")).toBe(first.entry);
      first.cleanup();
      successor = reserve(sources, "reentrant");
    };
    expect(requestRpcSourceCancellation(first.entry, "rpc")).toBe(true);
    first.cleanup();
    expect(successor).toBeDefined();
    expect(sources.get("reentrant")).toBe(successor?.entry);
    expect(successor?.entry.input.abortSignal.aborted).toBe(false);
    successor?.cleanup();
  });

  it("retains collected siblings as retry identities after retiring cancellation until aggregate settlement", async () => {
    const sources = new Map<string, RpcSourceRef>();
    const originals = [reserve(sources, "collect-a"), reserve(sources, "collect-b")];
    const runs = originals.map((source) => {
      const run = createQueueTestRun({ prompt: source.entry.input.protocolRunId! });
      bindSessionControllerSource(source.entry.input, run);
      expect(
        enqueueFollowupRun(sessionKey, run, createQueueSettings(), "none", undefined, false),
      ).toBe(true);
      retireFollowupRunCancellation(run);
      source.cleanup();
      return run;
    });
    for (const source of originals) {
      expect(requestRpcSourceCancellation(source.entry)).toBe(false);
      expect(getRpcSourceSignal(source.entry).aborted).toBe(false);
      expect(isRpcSourceQueued(source.entry)).toBe(false);
      expect(sources.get(source.entry.input.protocolRunId!)).toBe(source.entry);
    }
    for (const run of runs) {
      completeFollowupRunLifecycle(run, "consumed");
    }
    await Promise.all(
      originals.map((source) => captureSessionControllerSourceSettlement(source.entry.input)),
    );
    expect(sources.size).toBe(0);
  });

  it("lists only the captured logical session and agent", () => {
    const sources = new Map<string, RpcSourceRef>();
    reserve(sources, "main", { sessionKey: "global", sessionId: "global-main", agentId: "main" });
    reserve(sources, "other", {
      sessionKey: "global",
      sessionId: "global-other",
      agentId: "other",
    });
    const matches = listRpcSourcesForSession({
      rpcSources: sources,
      sessionKeys: ["global"],
      agentId: "main",
      defaultAgentId: "main",
      requiredSessionId: "global-main",
      queuedOnly: true,
    });
    expect(matches.map(({ runId }) => runId)).toEqual(["main"]);
    expect(
      listRpcSourcesForSession({
        rpcSources: sources,
        sessionKeys: ["wrong-session"],
        requiredSessionId: "global-main",
        queuedOnly: true,
      }),
    ).toEqual([]);
    for (const [runId, entry] of sources) {
      removeChatAbortControllerEntry(sources, runId, entry);
    }
  });

  it("does not project a waiting source as active or start its execution clock while a predecessor prepares", async () => {
    vi.useFakeTimers();
    const sources = new Map<string, RpcSourceRef>();
    const predecessor = reserve(sources, "preparing");
    const waiting = reserve(sources, "waiting");
    const started = createDeferred();
    const release = createDeferred();
    const task = runSource(waiting.entry, async () => {
      started.resolve();
      await release.promise;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(isRpcSourceActive(waiting.entry)).toBe(false);
    expect(getRpcSourceStartedAt(waiting.entry)).toBeUndefined();
    expect(getRpcSourceSignal(waiting.entry).aborted).toBe(false);
    predecessor.cleanup();
    await started.promise;
    expect(isRpcSourceActive(waiting.entry)).toBe(true);
    expect(getRpcSourceStartedAt(waiting.entry)).toBe(Date.now());
    release.resolve();
    await task;
    waiting.cleanup();
  });
});

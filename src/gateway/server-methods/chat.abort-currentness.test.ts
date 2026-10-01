import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createGatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
} from "../../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { registerWorkerInferenceSessionControl } from "../worker-environments/inference-control-internal.js";
import { createWorkerInferenceCancellationService } from "../worker-environments/inference-control.test-helpers.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import * as abortRuntime from "./chat-abort-runtime.js";
import * as persistence from "./chat-transcript-persistence.js";
import {
  expectAbortPayload,
  invokeAbort,
  requireLastRespondCall,
} from "./chat.abort-authorization.test-helpers.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

vi.mock("../session-utils.js", async () => {
  return {
    ...(await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js")),
    loadSessionEntry: () => ({ entry: { sessionId: "main-session" } }),
  };
});

describe("chat.abort original authority and registration", () => {
  it("preserves exact-run descendant and partial persistence failures after parent Stop", async () => {
    const descendantFailure = new Error("descendant cancellation failed");
    const partialFailure = new Error("partial persistence failed");
    const context = createChatAbortContext();
    const run = createActiveRun("main", { sessionId: "main-session", agentId: "main" });
    context.rpcSources.set("parent-run", run);
    context.chatRunState.getOrCreate("parent-run").buffer = "captured parent output";
    const descendants = vi
      .spyOn(abortRuntime, "abortControlledSubagents")
      .mockImplementationOnce(async (params) => {
        await params.beforeKill?.();
        throw descendantFailure;
      });
    const persist = vi
      .spyOn(persistence, "persistAbortedPartials")
      .mockRejectedValueOnce(partialFailure);
    const respond = vi.fn();
    try {
      await expect(
        invokeChatAbortHandler({
          handler: handleChatAbortRequestWithLifecycle,
          context,
          request: { sessionKey: "main", runId: "parent-run" },
          client: { connect: { scopes: ["operator.admin"] } },
          respond,
        }),
      ).rejects.toMatchObject({ errors: [descendantFailure, partialFailure] });
      expect(run.input.abortSignal.aborted).toBe(true);
      expect(persist).toHaveBeenCalledOnce();
      expect(respond).not.toHaveBeenCalled();
    } finally {
      descendants.mockRestore();
      persist.mockRestore();
    }
  });

  it.each([undefined, "worker-run"])(
    "waits for worker cancellation persistence before responding to Stop with runId=%s",
    async (runId) => {
      const cancelled = createDeferred();
      const workerPersistence = createDeferred<string[]>();
      const service = {};
      registerWorkerInferenceSessionControl(service, {
        reserveDrain: () => {
          throw new Error("unexpected drain reservation");
        },
        resolveTarget: () => undefined,
        captureCancel: () => ({
          runIds: ["worker-run"],
          cancel: (control) => {
            control?.assertCurrent?.();
            control?.onCancelled?.("worker-run");
            cancelled.resolve();
            return workerPersistence.promise;
          },
        }),
      });
      const respond = vi.fn();
      const stopping = invokeChatAbortHandler({
        handler: handleChatAbortRequestWithLifecycle,
        context: createChatAbortContext({ workerEnvironmentService: service }),
        request: { sessionKey: "main", ...(runId ? { runId } : {}) },
        client: { connect: { scopes: ["operator.admin"] } },
        respond,
      });
      try {
        await cancelled.promise;
        expect(respond).not.toHaveBeenCalled();
      } finally {
        workerPersistence.resolve(["worker-run"]);
        await stopping;
      }
      expectAbortPayload(requireLastRespondCall(respond)[1], {
        aborted: true,
        runIds: ["worker-run"],
      });
    },
  );

  it("preserves worker cancellation and partial persistence failures after synchronous Stop", async () => {
    const cancelled = createDeferred();
    const workerPersistence = createDeferred<string[]>();
    const workerFailure = new Error("worker cancellation write failed");
    const partialFailure = new Error("partial output write failed");
    const service = {};
    registerWorkerInferenceSessionControl(service, {
      reserveDrain: () => {
        throw new Error("unexpected drain reservation");
      },
      resolveTarget: () => undefined,
      captureCancel: () => ({
        runIds: ["worker-run"],
        cancel: (control) => {
          control?.assertCurrent?.();
          control?.onCancelled?.("worker-run");
          cancelled.resolve();
          return workerPersistence.promise;
        },
      }),
    });
    const context = createChatAbortContext({ workerEnvironmentService: service });
    const run = createActiveRun("main", { sessionId: "main-session", agentId: "main" });
    context.rpcSources.set("worker-run", run);
    context.chatRunState.getOrCreate("worker-run").buffer = "captured output";
    const persist = vi
      .spyOn(persistence, "persistAbortedPartials")
      .mockRejectedValue(partialFailure);
    const respond = vi.fn();
    const stopping = invokeChatAbortHandler({
      handler: handleChatAbortRequestWithLifecycle,
      context,
      request: { sessionKey: "main" },
      client: { connect: { scopes: ["operator.admin"] } },
      respond,
    });
    const rejected = expect(stopping).rejects.toMatchObject({
      errors: [workerFailure, partialFailure],
    });
    try {
      await cancelled.promise;
      expect(run.input.abortSignal.aborted).toBe(true);
      expect(respond).not.toHaveBeenCalled();
      workerPersistence.reject(workerFailure);
      await rejected;
      expect(persist).toHaveBeenCalledOnce();
      expect(respond).not.toHaveBeenCalled();
    } finally {
      workerPersistence.resolve([]);
      await stopping.catch(() => undefined);
      persist.mockRestore();
    }
  });

  it.each(["queued", "active", "lifecycle"] as const)(
    "stops subsequent effects after a synchronous %s cancellation revokes authority",
    async (firstEffect) => {
      let current = true;
      const cancelInferenceForSession = vi.fn(() => ["worker"]);
      const context = createChatAbortContext({
        workerEnvironmentService: createWorkerInferenceCancellationService(
          "main-session",
          ["worker"],
          cancelInferenceForSession,
        ),
      });
      const first = createActiveRun("main", {
        sessionId: "main-session",
        agentId: "main",
        queued: firstEffect === "queued",
      });
      const second = createActiveRun("main", {
        sessionId: "main-session",
        agentId: "main",
        queued: firstEffect === "queued",
      });
      if (firstEffect === "queued") {
        context.rpcSources.set("first", first);
        context.rpcSources.set("second", second);
      } else {
        context.rpcSources.set("first", first);
        context.rpcSources.set("second", second);
        context.chatRunState.getOrCreate("first").buffer = "committed partial";
        context.chatRunState.getOrCreate("second").buffer = "untouched partial";
      }
      if (firstEffect !== "lifecycle") {
        first.input.abortSignal.addEventListener(
          "abort",
          () => {
            current = false;
          },
          { once: true },
        );
      }
      const lifecycle = vi.fn(() => {
        if (firstEffect === "lifecycle") {
          current = false;
        }
        return true;
      });
      for (const prefix of ["agent", "pending-chat"]) {
        context.dedupe.set(`${prefix}:pending`, {
          ts: 1,
          ok: true,
          payload: {
            runId: "pending",
            status: "accepted",
            sessionKey: "main",
            agentId: "main",
          },
        });
      }
      const pending = [...context.dedupe];
      const persist = vi.spyOn(persistence, "persistAbortedPartials").mockResolvedValue(undefined);
      try {
        await expect(
          invokeChatAbortHandler({
            handler: (options) =>
              handleChatAbortRequestWithLifecycle(
                {
                  ...options,
                  hasCurrentClientAuthority: () => current,
                },
                { onAuthorizedAfterQueuedAbort: lifecycle },
              ),
            context,
            request: { sessionKey: "main" },
            client: { connect: { scopes: ["operator.admin"] } },
          }),
        ).rejects.toThrow("requester authority changed");
        expect(first.input.abortSignal.aborted).toBe(firstEffect !== "lifecycle");
        expect(second.input.abortSignal.aborted).toBe(false);
        if (firstEffect === "queued") {
          expect([...context.dedupe]).toEqual(pending);
        } else {
          expect([...context.dedupe]).toEqual([
            [
              "agent:pending",
              expect.objectContaining({
                payload: expect.objectContaining({ runId: "pending", status: "timeout" }),
              }),
            ],
            [
              "chat:pending",
              expect.objectContaining({
                payload: expect.objectContaining({ runId: "pending", status: "timeout" }),
              }),
            ],
          ]);
        }
        expect(cancelInferenceForSession).not.toHaveBeenCalled();
        expect(lifecycle).toHaveBeenCalledTimes(firstEffect === "queued" ? 0 : 1);
        if (firstEffect === "active") {
          expect(persist).toHaveBeenCalledOnce();
          expect(persist.mock.calls[0]?.[0].snapshots.map((snapshot) => snapshot.runId)).toEqual([
            "first",
          ]);
          expect(context.chatRunState.resolveBuffer("second", { final: true }).text).toBe(
            "untouched partial",
          );
        } else {
          expect(persist.mock.calls.flatMap(([call]) => call.snapshots)).toEqual([]);
          if (firstEffect === "queued") {
            expect(persist).not.toHaveBeenCalled();
          } else {
            expect(context.chatRunState.resolveBuffer("first", { final: true }).text).toBe(
              "committed partial",
            );
            expect(context.chatRunState.resolveBuffer("second", { final: true }).text).toBe(
              "untouched partial",
            );
          }
        }
      } finally {
        persist.mockRestore();
      }
    },
  );

  it("does not adopt replacement active and pending registrations during a session-wide Stop", async () => {
    const context = createChatAbortContext();
    const first = createActiveRun("main", { sessionId: "main-session", agentId: "main" });
    const stale = createActiveRun("main", { sessionId: "main-session", agentId: "main" });
    const replacement = createActiveRun("main", { sessionId: "main-session", agentId: "main" });
    context.rpcSources.set("first", first);
    context.rpcSources.set("reused", stale);
    for (const prefix of ["agent", "pending-chat"]) {
      context.dedupe.set(`${prefix}:pending`, {
        ts: 1,
        ok: true,
        payload: {
          runId: "pending",
          status: "accepted",
          sessionKey: "main",
          agentId: "main",
          reservationId: "old",
          attemptId: "old",
        },
      });
    }
    let pending: Array<[string, unknown]> = [];
    first.input.abortSignal.addEventListener(
      "abort",
      () => {
        context.rpcSources.set("reused", replacement);
        for (const prefix of ["agent", "pending-chat"]) {
          context.dedupe.set(`${prefix}:pending`, {
            ts: 2,
            ok: true,
            payload: {
              runId: "pending",
              status: "accepted",
              sessionKey: "main",
              agentId: "main",
              reservationId: "new",
              attemptId: "new",
            },
          });
        }
        pending = [...context.dedupe];
      },
      { once: true },
    );
    const response = await invokeAbort({
      context,
      sessionKey: "main",
      connId: "owner",
      deviceId: "device",
      scopes: ["operator.admin"],
    });
    expectAbortPayload(requireLastRespondCall(response)[1], {
      aborted: true,
      runIds: ["pending", "first"],
    });
    expect(stale.input.abortSignal.aborted).toBe(false);
    expect(replacement.input.abortSignal.aborted).toBe(false);
    expect([...context.dedupe]).toEqual(pending);
  });

  it.each(["active", "queued", "pending-chat", "agent", "worker"] as const)(
    "retains the original source and target fence before explicit %s cancellation",
    async (kind) => {
      for (const changed of ["source", "target"] as const) {
        const cancelInferenceForSession = vi.fn(() => ["run-1"]);
        const run = createActiveRun("agent:main:main", {
          agentId: "main",
          queued: kind === "queued",
        });
        const context = createChatAbortContext({
          workerEnvironmentService: createWorkerInferenceCancellationService(
            "main-session",
            kind === "worker" ? ["run-1"] : [],
            cancelInferenceForSession,
          ),
        });
        if (kind === "active") {
          context.rpcSources.set("run-1", run);
        } else if (kind === "queued") {
          context.rpcSources.set("run-1", run);
        } else if (kind !== "worker") {
          context.dedupe.set(`${kind}:run-1`, {
            ts: Date.now(),
            ok: true,
            payload: {
              runId: "run-1",
              sessionKey: "agent:main:main",
              agentId: "main",
              status: "accepted",
            },
          });
        }
        const before = [...context.dedupe];
        await expect(
          invokeChatAbortHandler({
            handler: (options) =>
              handleChatAbortRequestWithLifecycle({
                ...options,
                hasCurrentClientAuthority: () => changed !== "source",
                sessionMutationAuthorization: {
                  assertCurrent: () => {
                    throw new Error("target changed");
                  },
                  assertTargetCurrent: () => {
                    throw new Error("target changed");
                  },
                },
              }),
            context,
            request: { sessionKey: "agent:main:main", runId: "run-1" },
            client: { connId: "owner", connect: { scopes: ["operator.admin"] } },
          }),
        ).rejects.toThrow(changed === "source" ? "requester authority changed" : "target changed");
        expect(run.input.abortSignal.aborted).toBe(false);
        expect(context.rpcSources.has("run-1")).toBe(kind === "active" || kind === "queued");
        expect([...context.dedupe]).toEqual(before);
        expect(cancelInferenceForSession).not.toHaveBeenCalled();
      }
    },
  );

  it("does not fall back to live worker queries without a registered capture owner", async () => {
    const cancelInferenceForSession = vi.fn(() => ["worker-run"]);
    const context = createChatAbortContext({
      workerEnvironmentService: {
        cancelInferenceForSession,
        hasInferenceForSession: () => true,
      },
    });
    for (const runId of [undefined, "worker-run"]) {
      const response = await invokeAbort({
        context,
        runId,
        connId: "admin",
        deviceId: "admin",
        scopes: ["operator.admin"],
      });
      expectAbortPayload(requireLastRespondCall(response)[1], { aborted: false, runIds: [] });
    }
    expect(cancelInferenceForSession).not.toHaveBeenCalled();
  });
});

it.each([undefined, "retained-run"])(
  "bounds Stop acknowledgment without releasing raw source custody for runId=%s",
  async (runId) => {
    vi.useFakeTimers();
    const raw = createDeferred();
    const cancelled = createDeferred();
    const source = createActiveRun("main", {
      sessionId: "main-session",
      agentId: "main",
      queued: true,
    });
    const claim = await claimSessionControllerTask(source.input, (selected) => {
      createReplyOperation({
        sessionKey: "main",
        sessionId: "main-session",
        agentId: "main",
        resetTriggered: false,
        mailboxClaim: selected,
      });
    });
    const producer = (async () => {
      try {
        await raw.promise;
      } finally {
        claim.operation?.complete();
        releaseSessionControllerClaim(claim);
      }
    })();
    source.input.abortSignal.addEventListener("abort", () => cancelled.resolve(), { once: true });
    const context = createChatAbortContext({ rpcSources: new Map([["retained-run", source]]) });
    let acknowledged = false;
    const stopping = invokeChatAbortHandler({
      handler: handleChatAbortRequestWithLifecycle,
      context,
      request: { sessionKey: "main", ...(runId ? { runId } : {}) },
      client: { connect: { scopes: ["operator.admin"] } },
    })
      .then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      )
      .finally(() => {
        acknowledged = true;
      });
    try {
      await cancelled.promise;
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(acknowledged).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(acknowledged).toBe(true);
      expect((await stopping).error).toMatchObject({
        message: expect.stringContaining("cleanup is still pending"),
      });
      expect(claim.released).toBe(false);
      expect(source.input.phase).toBe("claimed");
      const snapshot = createGatewayActiveWorkSnapshot({
        getChatRuns: () => 0,
        getQueuedTurns: () => 0,
        getTerminalPersistence: () => 0,
      });
      expect(snapshot.idle).toBe(false);
      expect(snapshot.counts.sessionAdmissions).toBe(1);
      expect(() =>
        createReplyOperation({
          sessionKey: "main",
          sessionId: "successor",
          resetTriggered: false,
          target: source.input.target,
        }),
      ).toThrow("already active");
    } finally {
      raw.resolve();
      await producer;
      await claim.settlement.promise;
      await stopping;
      vi.useRealTimers();
    }
  },
);

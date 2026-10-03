import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getRpcSource,
  getRpcSourceProjectSessionActive,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import {
  getAgentTestMocks,
  operatorWriteCliClient,
  makeContext,
  requireValue,
  expectRecordFields,
  mockCallArg,
  invokeAgent,
  prime,
} from "./agent.test-harness.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";

const mocks = getAgentTestMocks();

export function registerAgentAbortRunExecutionTest() {
  it("chat.abort by runId aborts the agent run's signal and removes the entry", async () => {
    prime();
    const finishRun = createDeferred();
    const context = makeContext();
    const runId = "idem-abort-run";
    let acceptedEntry: RpcSourceRef | undefined;
    let capturedSignal: AbortSignal | undefined;
    mocks.agentCommand.mockImplementationOnce(async (opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts.abortSignal;
      const entry = getRpcSource(runId);
      if (entry?.input.abortSignal === opts.abortSignal) {
        acceptedEntry = entry;
      }
      await finishRun.promise;
      return { payloads: [{ text: "late completion" }], meta: { durationMs: 1 } };
    });

    try {
      await invokeAgent(
        {
          message: "hi",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId },
      );

      const active = requireValue(acceptedEntry, "active run missing");
      expect(getRpcSource(runId)).toBe(active);
      expect(capturedSignal?.aborted).toBe(false);

      const abortRespond = vi.fn();
      await handleChatAbortRequest({
        params: { sessionKey: "agent:main:main", runId },
        respond: abortRespond as never,
        context,
        req: { type: "req", id: "abort-req", method: "chat.abort" },
        client: null,
        isWebchatConnect: () => false,
      });

      expect(mockCallArg(abortRespond)).toBe(true);
      expectRecordFields(mockCallArg(abortRespond, 0, 1), {
        aborted: true,
        runIds: [runId],
      });
      expect(capturedSignal?.aborted).toBe(true);
      expect(getRpcSourceProjectSessionActive(active)).toBe(false);
      expect(getRpcSource(runId)).toBe(active);
    } finally {
      finishRun.resolve();
      await acceptedEntry?.input.settlement.promise;
    }
    expect(getRpcSource(runId)).toBeUndefined();
  });
}

export function registerAgentAbortStaleKeyExecutionTest() {
  it("chat.abort by runId allows the owner connection to use a stale session key", async () => {
    prime();
    const finishRun = createDeferred();
    const context = makeContext();
    const runId = "idem-abort-stale-session-key";
    let acceptedEntry: RpcSourceRef | undefined;
    let capturedSignal: AbortSignal | undefined;
    mocks.agentCommand.mockImplementationOnce(async (opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts.abortSignal;
      const entry = getRpcSource(runId);
      if (entry?.input.abortSignal === opts.abortSignal) {
        acceptedEntry = entry;
      }
      await finishRun.promise;
      return { payloads: [{ text: "late completion" }], meta: { durationMs: 1 } };
    });

    try {
      await invokeAgent(
        {
          message: "hi",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        {
          context,
          reqId: runId,
          client: { ...operatorWriteCliClient(), connId: "owner-conn" },
        },
      );

      const active = requireValue(acceptedEntry, "active run missing");
      expect(getRpcSource(runId)).toBe(active);
      expect(active.input.target?.sessionKey).toBe("agent:main:main");
      const abortRespond = vi.fn();
      await handleChatAbortRequest({
        params: { sessionKey: "agent:main:stale-key", runId },
        respond: abortRespond as never,
        context,
        req: { type: "req", id: "abort-req", method: "chat.abort" },
        client: { ...operatorWriteCliClient(), connId: "owner-conn" },
        isWebchatConnect: () => false,
      });

      expect(mockCallArg(abortRespond)).toBe(true);
      expectRecordFields(mockCallArg(abortRespond, 0, 1), {
        aborted: true,
        runIds: [runId],
      });
      expect(capturedSignal?.aborted).toBe(true);
      expect(getRpcSourceProjectSessionActive(active)).toBe(false);
      expect(getRpcSource(runId)).toBe(active);
    } finally {
      finishRun.resolve();
      await acceptedEntry?.input.settlement.promise;
    }
    expect(getRpcSource(runId)).toBeUndefined();
  });
}

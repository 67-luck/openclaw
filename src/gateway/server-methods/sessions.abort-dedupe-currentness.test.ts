import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
  updateRpcSourceSessionId,
} from "../../sessions/session-controller.rpc-sources.js";
import { createAgentDedupeLifecycle } from "../agent-turn/agent-dedupe-lifecycle.js";
import * as agentJob from "../agent-turn/agent-job.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { claimRpcSourceForTest } from "../test-helpers.rpc-source.js";
import * as transcriptPersistence from "./chat-transcript-persistence.js";
import { captureRpcTargetForTest } from "./rpc-source-fixtures.test-support.js";
import { sessionAbortHandlers } from "./sessions-abort.js";
import type { RespondFn } from "./types.js";

useChatAbortRegistryFixture();

it.each(["unchanged", "absent", "successor", "successor from absent"] as const)(
  "sessions.abort preserves the %s receipt after committed partial persistence",
  async (mode) => {
    const scope = { agentId: "main", sessionKey: "agent:main:abort-receipt" };
    const sessionId = "abort-receipt-session";
    const runId = "abort-receipt-run";
    const key = `agent:${runId}`;
    const context = createDirectChatContext({ getRuntimeConfig });
    await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
    const reserve = () => {
      const lifecycle = createAgentDedupeLifecycle({
        cfg: getRuntimeConfig(),
        request: { message: "Continue durable input", idempotencyKey: runId },
        runId,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        agentDedupeKeys: [key],
        suppressVisibleSessionEffects: false,
        privateCompletion: true,
        context,
        io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
      });
      lifecycle.reserve(scope.sessionKey, scope.agentId);
      lifecycle.bindSessionTarget({ ...scope, sessionId });
      return lifecycle;
    };
    const original = mode === "unchanged" || mode === "successor" ? reserve() : undefined;
    const originalReceipt = context.dedupe.get(key);
    const removed = createDeferred();
    const registration = registerChatAbortController({
      ...scope,
      target: captureRpcTargetForTest({ ...scope, sessionId }),
      sessionId,
      runId,
      kind: "agent",
      timeoutMs: 60_000,
      onRemoved: () => removed.resolve(),
    });
    expect(registration.registered).toBe(true);
    const releaseExecution = await claimRpcSourceForTest(
      expectDefined(registration.entry, "registered RPC source"),
    );
    registration.controller.signal.addEventListener("abort", releaseExecution, { once: true });
    expect(registration.markExecutionStarted()).toBe(true);
    context.chatRunState.getOrCreate(runId).buffer = "Predecessor partial";
    const committed = createDeferred();
    const release = createDeferred();
    const persist = transcriptPersistence.persistAbortedPartials;
    const persistence = vi
      .spyOn(transcriptPersistence, "persistAbortedPartials")
      .mockImplementation(async (params) => {
        // Hold the return after the real COMMIT, never the SQLite writer or controller cleanup.
        await persist(params);
        committed.resolve();
        await release.promise;
      });
    const respond = vi.fn<RespondFn>();
    const request = Promise.resolve(
      sessionAbortHandlers["sessions.abort"]!({
        req: { type: "req", id: "abort-receipt", method: "sessions.abort" },
        params: { key: scope.sessionKey, runId },
        context,
        client: null,
        respond,
        isWebchatConnect: () => false,
      }),
    );
    let successor: ReturnType<typeof registerChatAbortController> | undefined;
    try {
      await expect(
        Promise.race([committed.promise.then(() => true), request.then(() => false)]),
      ).resolves.toBe(true);
      expect(registration.controller.signal.aborted).toBe(true);
      expect(rpcSourceTesting.has(runId)).toBe(false);
      await removed.promise;
      expect(respond).not.toHaveBeenCalled();
      expect(context.dedupe.get(key)).toBe(originalReceipt);
      const transcriptScope = { ...scope, sessionId };
      const committedTranscript = await loadTranscriptEvents(transcriptScope);
      expect(
        committedTranscript.filter((event) => asOptionalRecord(event)?.type === "message"),
      ).toEqual([
        expect.objectContaining({
          message: expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "Predecessor partial" }],
          }),
        }),
      ]);
      const replacesReceipt = mode === "successor" || mode === "successor from absent";
      let successorReceipt: typeof originalReceipt;
      if (replacesReceipt) {
        const reservation = reserve();
        successorReceipt = expectDefined(context.dedupe.get(key), "successor receipt");
        expect(successorReceipt).not.toBe(originalReceipt);
        expect(reservation.reservationId).not.toBe(original?.reservationId);
        expect(successorReceipt.payload).toMatchObject({
          runId,
          reservationId: reservation.reservationId,
          status: "accepted",
          sessionId,
          sessionKey: scope.sessionKey,
        });
        successor = registerChatAbortController({
          ...scope,
          target: captureRpcTargetForTest({ ...scope, sessionId }),
          sessionId,
          runId,
          kind: "agent",
          timeoutMs: 60_000,
        });
        expect(successor.registered).toBe(true);
        context.chatRunState.getOrCreate(runId).buffer = "Successor partial";
      }
      release.resolve();
      await request;
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        true,
        { ok: true, abortedRunId: runId, status: "aborted" },
        undefined,
        undefined,
      );
      expect(persistence).toHaveBeenCalledOnce();
      expect(await loadTranscriptEvents(transcriptScope)).toEqual(committedTranscript);
      if (replacesReceipt) {
        expect(context.dedupe.get(key)).toBe(successorReceipt);
        expect(rpcSourceTesting.get(runId)).toBe(successor?.entry);
        expect(successor?.controller.signal.aborted).toBe(false);
        expect(context.chatRunState.resolveBuffer(runId, { final: true }).text).toBe(
          "Successor partial",
        );
      } else {
        expect(context.dedupe.get(key)?.payload).toMatchObject({
          runId,
          status: "timeout",
          stopReason: "rpc",
        });
      }
    } finally {
      release.resolve();
      await request.catch(() => {});
      persistence.mockRestore();
      successor?.cleanup();
      registration.cleanup();
      context.chatRunState.clearRun(runId);
    }
  },
);

it("sessions.abort records the rotated RPC source identity on its terminal receipt", async () => {
  const scope = { agentId: "main", sessionKey: "agent:main:rotated-abort-receipt" };
  const initialSessionId = "initial-abort-receipt-session";
  const rotatedSessionId = "rotated-abort-receipt-session";
  const runId = "rotated-abort-receipt-run";
  const context = createDirectChatContext({ getRuntimeConfig });
  await replaceSessionEntry(scope, { sessionId: initialSessionId, updatedAt: 1 });
  const registration = registerChatAbortController({
    ...scope,
    target: captureRpcTargetForTest({ ...scope, sessionId: initialSessionId }),
    sessionId: initialSessionId,
    runId,
    kind: "chat-send",
    timeoutMs: 60_000,
  });
  const entry = expectDefined(registration.entry, "registered RPC source");
  const releaseExecution = await claimRpcSourceForTest(entry);
  registration.controller.signal.addEventListener("abort", releaseExecution, { once: true });
  expect(registration.markExecutionStarted()).toBe(true);
  await replaceSessionEntry(scope, { sessionId: rotatedSessionId, updatedAt: 2 });
  updateRpcSourceSessionId(entry, rotatedSessionId);
  context.chatRunState.getOrCreate(runId).buffer = "Rotated abort partial";
  const respond = vi.fn<RespondFn>();
  const setDedupeEntry = vi.spyOn(agentJob, "setGatewayDedupeEntry");

  try {
    await sessionAbortHandlers["sessions.abort"]!({
      req: { type: "req", id: "rotated-abort-receipt", method: "sessions.abort" },
      params: { key: scope.sessionKey, runId },
      context,
      client: null,
      respond,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledExactlyOnceWith(
      true,
      { ok: true, abortedRunId: runId, status: "aborted" },
      undefined,
      undefined,
    );
    const expectedSession = {
      ...getRpcSourceIdentity(entry),
      lifecycleGeneration: getRpcSourceLifecycleGeneration(entry),
    };
    expect(setDedupeEntry).toHaveBeenCalledWith(
      expect.objectContaining({ key: `chat:${runId}`, session: expectedSession }),
    );
    expect(agentJob.getAgentJobSession(runId, "chat")).toEqual(expectedSession);
  } finally {
    setDedupeEntry.mockRestore();
    releaseExecution();
    registration.cleanup();
    context.chatRunState.clearRun(runId);
  }
});

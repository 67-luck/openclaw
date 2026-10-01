// Imported by agent.test.ts to keep its mocked suite in one Vitest module graph.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerExecApprovalFollowupRuntimeHandoff } from "../../agents/bash-tools.exec-approval-followup-state.js";
import {
  isRpcSourceActive,
  isRpcSourceQueued,
} from "../../sessions/session-controller.rpc-sources.js";
import * as agentHandlerHelpers from "../agent-turn/agent-handler-helpers.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import type { GatewaySessionRow } from "../session-utils.js";
import { createRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { registerAgentAbortSubagentTests } from "./agent.abort-subagents.test-utils.js";
import { registerAgentPreDispatchFailureTests } from "./agent.pre-dispatch-failure.test-utils.js";
import {
  getAgentTestMocks,
  operatorWriteCliClient,
  makeContext,
  waitForAssertion,
  requireValue,
  expectRecordFields,
  mockCallArg,
  expectRespondError,
  flushScheduledDispatchStep,
  mockMainSessionEntry,
  buildExistingMainStoreEntry,
  backendGatewayClient,
  mockSessionResetSuccess,
  invokeAgent,
  describe1BeforeEach0,
  describe1AfterEach1,
  prime,
} from "./agent.test-harness.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = getAgentTestMocks();

function expectMainAlias(payload: unknown, runId: string, alias: string): void {
  expectRecordFields(payload, {
    runId,
    status: "accepted",
    sessionKey: "agent:main:main",
    sessionId: "existing-session-id",
    sessionKeyAliases: [alias],
  });
}

describe("gateway agent handler chat.abort integration", () => {
  beforeEach(describe1BeforeEach0);

  afterEach(describe1AfterEach1);

  it("registers an abort controller into rpcSources for an agent run", async () => {
    prime();
    const pending = new Promise(() => {});
    mocks.agentCommand.mockReturnValueOnce(pending);

    const context = makeContext();
    const runId = "idem-abort-register";
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
        client: { ...operatorWriteCliClient(), connId: "conn-1" },
      },
    );

    const entry = context.rpcSources.get(runId);
    const abortEntry = requireValue(entry, "chat abort entry missing");
    expect(abortEntry.adapter.sessionKey).toBe("agent:main:main");
    expect(abortEntry.adapter.sessionId).toBe("existing-session-id");
    expect(abortEntry.adapter.ownerConnId).toBe("conn-1");
    expect(abortEntry.input.abortSignal.aborted).toBe(false);
  });

  it("keeps selected-global goals on agent session change events", async () => {
    const goal = {
      schemaVersion: 1,
      id: "goal-work-global",
      objective: "Finish work global task",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
      tokenStart: 0,
      tokensUsed: 5,
      continuationTurns: 0,
    } satisfies NonNullable<GatewaySessionRow["goal"]>;
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("global");
    mocks.loadSessionEntry.mockReturnValue({
      cfg: { agents: { list: [{ id: "main" }, { id: "work" }] }, session: { scope: "global" } },
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    const sessionRow = {
      key: "global",
      sessionId: "global-session-id",
      kind: "global",
      updatedAt: Date.now(),
      goal,
    } satisfies GatewaySessionRow;
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockReturnValue(new Promise(() => {}));

    const context = makeContext({ agentId: "work", row: sessionRow });
    context.getSessionEventSubscriberConnIds = () => new Set(["conn-1"]);
    const runId = "idem-agent-global-goal-event";
    await invokeAgent(
      {
        message: "hi",
        agentId: "work",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    await waitForAssertion(() => {
      expect(context.addChatRun).toHaveBeenCalledWith(
        runId,
        expect.objectContaining({ sessionKey: "global", agentId: "work" }),
      );
      expect(context.rpcSources.get(runId)?.adapter.agentId).toBe("work");
      expect(context.broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({
          sessionKey: "global",
          agentId: "work",
          goal: expect.objectContaining({ id: "goal-work-global" }),
          session: expect.objectContaining({ key: "global", sessionId: "global-session-id", goal }),
        }),
        new Set(["conn-1"]),
        { agentId: "work", dropIfSlow: true, sessionKeys: ["global"] },
      );
    });
  });

  it("yields after the accepted ack before dispatching heavy agent work", async () => {
    prime();
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-yield-before-dispatch";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await pending;

    expect(mockCallArg(respond)).toBe(true);
    const acceptedPayload = expectRecordFields(mockCallArg(respond, 0, 1), {
      runId,
      status: "accepted",
    });
    expect(acceptedPayload).not.toHaveProperty("dedupeKeys");
    expect(acceptedPayload).not.toHaveProperty("ownerConnId");
    expect(acceptedPayload).not.toHaveProperty("ownerDeviceId");
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      status: "accepted",
      dedupeKeys: [`agent:${runId}`],
    });
    expect(mockCallArg(respond, 0, 2)).toBeUndefined();
    expect(mockCallArg(respond, 0, 3)).toEqual({ runId });
    expect(mocks.agentCommand).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalledTimes(1));

    expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when chat.abort lands during the accepted ack yield", async () => {
    prime();
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-abort-before-dispatch";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => {
      expect(respond).toHaveBeenCalled();
      expect(mocks.agentCommand).not.toHaveBeenCalled();
    });

    expectRecordFields(mockCallArg(respond, 0, 1), {
      runId,
      sessionKey: "agent:main:main",
      status: "accepted",
    });
    expect(context.rpcSources.has(runId)).toBe(true);

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "agent:main:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expect(context.rpcSources.has(runId)).toBe(false);
    await pending;

    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
      timeoutPhase: "queue",
      providerStarted: false,
    });
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
      timeoutPhase: "queue",
      providerStarted: false,
    });
  });

  it("preserves stop-command reason when /stop lands during the accepted ack yield", async () => {
    prime();
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-stop-before-dispatch";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    expectRecordFields(mockCallArg(respond, 0, 1), {
      runId,
      sessionKey: "agent:main:main",
      status: "accepted",
    });
    expect(context.rpcSources.has(runId)).toBe(true);

    const stopRespond = vi.fn();
    await handleDirectExternalChatSend({
      params: {
        sessionKey: "agent:main:main",
        message: "/stop",
        idempotencyKey: "idem-stop-command-before-dispatch",
      },
      respond: stopRespond as never,
      context,
      req: { type: "req", id: "stop-req", method: "chat.send" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(stopRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expect(context.rpcSources.has(runId)).toBe(false);

    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      status: "timeout",
      summary: "aborted",
      stopReason: "stop",
    });
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "stop",
    });
  });

  it("does not dispatch when chat.abort lands during pre-accept setup", async () => {
    prime();
    const requestedSessionKey = "agent:main:legacy-main";
    let releaseSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseSessionWrite = resolve;
        });
      }
      const store = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-abort-before-registration";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: requestedSessionKey,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));
    expect(isRpcSourceQueued(context.rpcSources.get(runId))).toBe(true);
    expectMainAlias(context.dedupe.get(`agent:${runId}`)?.payload, runId, requestedSessionKey);

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: requestedSessionKey, runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: requestedSessionKey,
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
    });

    releaseSessionWrite?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.rpcSources.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
  });

  it("keeps selected-global alias scope when aborting during pre-accept setup", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-work-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    const requestedSessionKey = "agent:work:main";
    let releaseSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseSessionWrite = resolve;
        });
      }
      const store = {
        global: {
          sessionId: "global-work-session-id",
          updatedAt: Date.now(),
        },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-selected-global-alias-abort-before-registration";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "work",
        sessionKey: requestedSessionKey,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));
    expect(isRpcSourceQueued(context.rpcSources.get(runId))).toBe(true);
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "global",
      agentId: "work",
      status: "accepted",
    });

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "global", agentId: "work", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-selected-global-alias-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "global",
      agentId: "work",
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
    });

    releaseSessionWrite?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.rpcSources.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
  });

  it("does not dispatch when a stop command lands during pre-accept setup", async () => {
    prime();
    const requestedSessionKey = "agent:main:legacy-main";
    let releaseSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseSessionWrite = resolve;
        });
      }
      const store = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-stop-before-registration";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: requestedSessionKey,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));
    expect(isRpcSourceQueued(context.rpcSources.get(runId))).toBe(true);
    expectMainAlias(context.dedupe.get(`agent:${runId}`)?.payload, runId, requestedSessionKey);

    const stopRespond = vi.fn();
    await handleDirectExternalChatSend({
      params: {
        sessionKey: requestedSessionKey,
        message: "/stop",
        idempotencyKey: "idem-stop-command-before-registration",
      },
      respond: stopRespond as never,
      context,
      req: { type: "req", id: "stop-req", method: "chat.send" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(stopRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:main",
      status: "timeout",
      summary: "aborted",
      stopReason: "stop",
    });

    releaseSessionWrite?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.rpcSources.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "stop",
    });
  });

  it("does not dispatch when session-level chat.abort lands during pre-accept setup", async () => {
    prime();
    let releaseSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseSessionWrite = resolve;
        });
      }
      const store = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-session-level-abort-before-registration";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));
    expect(isRpcSourceQueued(context.rpcSources.get(runId))).toBe(true);

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "agent:main:main" },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:main",
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
    });

    releaseSessionWrite?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.rpcSources.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
  });

  it("does not dispatch when chat.abort lands during slow attachment setup", async () => {
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      model: "vision-model",
      modelProvider: "test",
      providerOverride: "test",
      modelOverride: "vision-model",
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    let releaseCatalog: (() => void) | undefined;
    const context = {
      ...makeContext(),
      loadGatewayModelCatalog: vi.fn(
        async () =>
          await new Promise((resolve) => {
            releaseCatalog = () =>
              resolve([
                {
                  id: "vision-model",
                  name: "vision-model",
                  provider: "test",
                  input: ["image"],
                },
              ]);
          }),
      ),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn();
    const runId = "idem-abort-during-attachment-setup";
    const pending = invokeAgent(
      {
        message: "inspect this",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "pixel.png",
            content: Buffer.from("not really a png").toString("base64"),
          },
        ],
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    await waitForAssertion(() =>
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        sessionKey: "agent:main:main",
        status: "accepted",
      }),
    );
    expect(isRpcSourceQueued(context.rpcSources.get(runId))).toBe(true);

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "agent:main:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:main",
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
    });

    releaseCatalog?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.rpcSources.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
  });

  it("does not recreate a session deleted during slow attachment setup", async () => {
    const sessionKey = "agent:main:main";
    const persistedEntry = {
      sessionId: "existing-session-id",
      updatedAt: Date.now(),
      model: "vision-model",
      modelProvider: "test",
      providerOverride: "test",
      modelOverride: "vision-model",
    };
    let deleted = false;
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: deleted ? undefined : persistedEntry,
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockClear();
    mocks.agentCommand.mockClear();

    let releaseCatalog: (() => void) | undefined;
    const context = {
      ...makeContext(),
      loadGatewayModelCatalog: vi.fn(
        async () =>
          await new Promise((resolve) => {
            releaseCatalog = () =>
              resolve([
                {
                  id: "vision-model",
                  name: "vision-model",
                  provider: "test",
                  input: ["image"],
                },
              ]);
          }),
      ),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn();
    const runId = "idem-delete-during-attachment-setup";
    const pending = invokeAgent(
      {
        message: "inspect this",
        agentId: "main",
        sessionKey,
        idempotencyKey: runId,
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "pixel.png",
            content: Buffer.from("not really a png").toString("base64"),
          },
        ],
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    await waitForAssertion(() => expect(context.loadGatewayModelCatalog).toHaveBeenCalled());
    deleted = true;
    releaseCatalog?.();
    await pending;

    expectRespondError(respond, {
      message: `Session "${sessionKey}" was deleted while starting work. Retry.`,
    });
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("does not dispatch into a session reset during slow attachment setup", async () => {
    const sessionKey = "agent:main:main";
    const persistedEntry = {
      sessionId: "existing-session-id",
      updatedAt: Date.now(),
      model: "vision-model",
      modelProvider: "test",
      providerOverride: "test",
      modelOverride: "vision-model",
    };
    let currentEntry = persistedEntry;
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: currentEntry,
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockClear();
    mocks.agentCommand.mockClear();

    let releaseCatalog: (() => void) | undefined;
    const context = {
      ...makeContext(),
      loadGatewayModelCatalog: vi.fn(
        async () =>
          await new Promise((resolve) => {
            releaseCatalog = () =>
              resolve([
                {
                  id: "vision-model",
                  name: "vision-model",
                  provider: "test",
                  input: ["image"],
                },
              ]);
          }),
      ),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn();
    const runId = "idem-reset-during-attachment-setup";
    const pending = invokeAgent(
      {
        message: "inspect this",
        agentId: "main",
        sessionKey,
        idempotencyKey: runId,
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "pixel.png",
            content: Buffer.from("not really a png").toString("base64"),
          },
        ],
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    await waitForAssertion(() => expect(context.loadGatewayModelCatalog).toHaveBeenCalled());
    currentEntry = { ...persistedEntry, sessionId: "reset-session-id" };
    releaseCatalog?.();
    await pending;

    expectRespondError(respond, {
      message: `Session "${sessionKey}" changed while starting work. Retry.`,
    });
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("keeps selected-global agent scope while aborting during attachment setup", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      agentId: "work",
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "work-global-session-id",
        updatedAt: Date.now(),
        modelProvider: "test",
        model: "vision-model",
        providerOverride: "test",
        modelOverride: "vision-model",
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    let releaseCatalog: (() => void) | undefined;
    const context = {
      ...makeContext(),
      loadGatewayModelCatalog: vi.fn(
        async () =>
          await new Promise((resolve) => {
            releaseCatalog = () =>
              resolve([
                {
                  id: "vision-model",
                  name: "vision-model",
                  provider: "test",
                  input: ["image"],
                },
              ]);
          }),
      ),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn();
    const runId = "idem-selected-global-abort-during-attachment-setup";
    const pending = invokeAgent(
      {
        message: "inspect this",
        agentId: "work",
        sessionKey: "global",
        idempotencyKey: runId,
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "pixel.png",
            content: Buffer.from("not really a png").toString("base64"),
          },
        ],
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    await waitForAssertion(() =>
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        sessionKey: "global",
        agentId: "work",
        status: "accepted",
      }),
    );
    await waitForAssertion(() => expect(context.loadGatewayModelCatalog).toHaveBeenCalled());
    expect(context.loadGatewayModelCatalog).toHaveBeenCalledWith({
      agentId: "work",
      readOnly: true,
    });
    expect(isRpcSourceQueued(context.rpcSources.get(runId))).toBe(true);

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "global", agentId: "work", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-selected-global-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "global",
      agentId: "work",
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
    });

    releaseCatalog?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.rpcSources.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
  });

  it("does not dispatch when chat.abort lands before voice wake reroutes the session", async () => {
    let releaseRouting: (() => void) | undefined;
    mocks.loadVoiceWakeRoutingConfig.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          releaseRouting = () =>
            resolve({
              version: 1,
              defaultTarget: { mode: "current" },
              routes: [],
              updatedAtMs: 0,
            });
        }),
    );
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:main:voice" });
    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: sessionKey === "agent:main:voice" ? "voice-session-id" : "main-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: sessionKey === "agent:main:voice" ? "agent:main:voice" : "agent:main:main",
    }));
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-abort-before-voice-route";
    const pending = invokeAgent(
      {
        message: "wake up",
        sessionKey: "agent:main:main",
        voiceWakeTrigger: "robot wake",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    await waitForAssertion(() =>
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        sessionKey: "agent:main:main",
        status: "accepted",
      }),
    );
    expect(context.rpcSources.has(runId)).toBe(false);

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "agent:main:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:main",
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
    });

    releaseRouting?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.rpcSources.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
  });

  it("does not register or dispatch agent work prepared across a gateway restart", async () => {
    mocks.registerAgentRunContext.mockClear();
    let releaseRouting: (() => void) | undefined;
    mocks.loadVoiceWakeRoutingConfig.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          releaseRouting = () =>
            resolve({
              version: 1,
              defaultTarget: { mode: "current" },
              routes: [],
              updatedAtMs: 0,
            });
        }),
    );
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:main:voice" });
    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: sessionKey === "agent:main:voice" ? "voice-session-id" : "main-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: sessionKey === "agent:main:voice" ? "agent:main:voice" : "agent:main:main",
    }));
    mocks.updateSessionStore.mockResolvedValue(undefined);

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-restart-during-voice-route";
    const pending = invokeAgent(
      {
        message: "wake up",
        sessionKey: "agent:main:main",
        voiceWakeTrigger: "robot wake",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => expect(releaseRouting).toBeTypeOf("function"));

    mocks.lifecycleGeneration = "post-restart-generation";
    releaseRouting?.();
    await pending;

    expect(context.rpcSources.has(runId)).toBe(false);
    expect(mocks.registerAgentRunContext).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:voice",
      status: "timeout",
      stopReason: "restart",
      timeoutPhase: "queue",
      providerStarted: false,
    });
  });

  it("does not mutate a session after losing lifecycle ownership while waiting for its store", async () => {
    prime();
    let releaseSessionWrite: (() => void) | undefined;
    let updaterCompleted = false;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      await new Promise<void>((resolve) => {
        releaseSessionWrite = resolve;
      });
      const store = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      const result = await updater(store);
      updaterCompleted = true;
      return result;
    });

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-restart-during-session-write";
    const pending = invokeAgent(
      {
        message: "hi",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => expect(releaseSessionWrite).toBeTypeOf("function"));

    mocks.lifecycleGeneration = "post-restart-generation";
    releaseSessionWrite?.();
    await pending;

    expect(updaterCompleted).toBe(false);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:main",
      status: "timeout",
      stopReason: "restart",
    });
  });

  it("does not acknowledge a bare reset that loses lifecycle ownership", async () => {
    prime();
    let releaseReset: (() => void) | undefined;
    mocks.performGatewaySessionReset.mockImplementation(
      async (opts: { assertCurrent?: () => void }) => {
        await new Promise<void>((resolve) => {
          releaseReset = resolve;
        });
        opts.assertCurrent?.();
        return {
          ok: true,
          key: "agent:main:main",
          entry: { sessionId: "reset-session-id" },
        };
      },
    );

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-restart-during-bare-reset";
    const pending = invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      {
        context,
        respond,
        reqId: runId,
        client: operatorWriteCliClient(["operator.admin"]),
      },
    );
    await waitForAssertion(() => expect(releaseReset).toBeTypeOf("function"));

    mocks.lifecycleGeneration = "post-restart-generation";
    releaseReset?.();
    await pending;

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:main",
      status: "timeout",
      stopReason: "restart",
    });
    expect(
      respond.mock.calls.some(
        (call: unknown[]) => (call[1] as { result?: unknown } | undefined)?.result !== undefined,
      ),
    ).toBe(false);
  });

  it("acknowledges a committed reset when restart prevents its follow-up", async () => {
    prime();
    mocks.performGatewaySessionReset.mockImplementation(
      async (opts: { onCommitted?: (commit: { key: string; sessionId: string }) => void }) => {
        opts.onCommitted?.({
          key: "agent:main:main",
          sessionId: "reset-session-id",
        });
        mocks.lifecycleGeneration = "post-restart-generation";
        return {
          ok: true,
          key: "agent:main:main",
          entry: { sessionId: "reset-session-id" },
        };
      },
    );

    const context = makeContext();
    const respond = await invokeAgent(
      {
        message: "/reset check status",
        sessionKey: "agent:main:main",
        idempotencyKey: "idem-restart-after-reset-commit",
      },
      {
        context,
        reqId: "restart-after-reset-commit",
        client: operatorWriteCliClient(["operator.admin"]),
      },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {
      status: "ok",
      summary: "completed",
    }).result as { payloads?: Array<{ text?: string }> };
    expect(result.payloads?.[0]?.text).toContain("Session reset.");
    expect(result.payloads?.[0]?.text).toContain("send the follow-up message again");
    expectRecordFields(context.dedupe.get("agent:idem-restart-after-reset-commit")?.payload, {
      status: "ok",
      summary: "completed",
    });
  });

  it("acknowledges a committed bare reset after lifecycle rotation", async () => {
    prime();
    mocks.performGatewaySessionReset.mockImplementation(
      async (opts: { onCommitted?: (commit: { key: string; sessionId: string }) => void }) => {
        opts.onCommitted?.({
          key: "agent:main:main",
          sessionId: "reset-session-id",
        });
        mocks.lifecycleGeneration = "post-restart-generation";
        return {
          ok: true,
          key: "agent:main:main",
          entry: { sessionId: "reset-session-id" },
        };
      },
    );

    const context = makeContext();
    const respond = await invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        idempotencyKey: "idem-restart-after-bare-reset",
      },
      {
        context,
        reqId: "restart-after-bare-reset",
        client: operatorWriteCliClient(["operator.admin"]),
      },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {
      status: "ok",
      summary: "completed",
    }).result as { payloads?: Array<{ text?: string }> };
    expect(result.payloads?.[0]?.text).toBe("✅ Session reset.");
    expectRecordFields(context.dedupe.get("agent:idem-restart-after-bare-reset")?.payload, {
      status: "ok",
      summary: "completed",
    });
  });

  it("acknowledges a committed reset when post-commit work fails after rotation", async () => {
    prime();
    mocks.performGatewaySessionReset.mockImplementation(
      async (opts: { onCommitted?: (commit: { key: string; sessionId: string }) => void }) => {
        opts.onCommitted?.({
          key: "agent:main:main",
          sessionId: "reset-session-id",
        });
        mocks.lifecycleGeneration = "post-restart-generation";
        throw new Error("post-commit cleanup failed");
      },
    );

    const context = makeContext();
    const respond = await invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        idempotencyKey: "idem-post-commit-reset-failure",
      },
      {
        context,
        reqId: "post-commit-reset-failure",
        client: operatorWriteCliClient(["operator.admin"]),
      },
    );

    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {
      status: "ok",
      summary: "completed",
    }).result as { payloads?: Array<{ text?: string }> };
    expect(result.payloads?.[0]?.text).toBe("✅ Session reset.");
    expectRecordFields(context.dedupe.get("agent:idem-post-commit-reset-failure")?.payload, {
      status: "ok",
      summary: "completed",
    });
  });

  it("acknowledges a committed reset when restart wins during later session persistence", async () => {
    prime();
    mockSessionResetSuccess({ reason: "reset" });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      const result = await updater(store);
      mocks.lifecycleGeneration = "post-restart-generation";
      return result;
    });

    const context = makeContext();
    const respond = await invokeAgent(
      {
        message: "/reset check status",
        sessionKey: "agent:main:main",
        idempotencyKey: "idem-restart-after-reset-later",
      },
      {
        context,
        reqId: "restart-after-reset-later",
        client: operatorWriteCliClient(["operator.admin"]),
      },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {
      status: "ok",
      summary: "completed",
    }).result as { payloads?: Array<{ text?: string }> };
    expect(result.payloads?.[0]?.text).toContain("send the follow-up message again");
    expectRecordFields(context.dedupe.get("agent:idem-restart-after-reset-later")?.payload, {
      status: "ok",
      summary: "completed",
    });
  });

  it("rejects unauthorized chat.abort during pre-accept setup", async () => {
    prime();
    let releaseSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseSessionWrite = resolve;
        });
      }
      const store = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-abort-before-registration-unauthorized";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      {
        context,
        respond,
        reqId: runId,
        flushDispatch: false,
        client: { ...operatorWriteCliClient(), connId: "owner-conn" },
      },
    );
    await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));
    expect(isRpcSourceQueued(context.rpcSources.get(runId))).toBe(true);

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "agent:main:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: { ...operatorWriteCliClient(), connId: "other-conn" },
      isWebchatConnect: () => false,
    });

    expect(mockCallArg(abortRespond, 0, 0)).toBe(false);
    expectRecordFields(mockCallArg(abortRespond, 0, 2), {
      code: "INVALID_REQUEST",
      message: "unauthorized",
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:main",
      status: "accepted",
    });

    releaseSessionWrite?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
    expect(context.rpcSources.has(runId)).toBe(true);
  });

  it("updates exec approval followup aliases when chat.abort lands during pre-accept setup", async () => {
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };
    const firstRegistration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-preaccept-abort",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    const secondRegistration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-preaccept-abort",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    if (!firstRegistration || !secondRegistration) {
      throw new Error("expected runtime handoff ids");
    }
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "123",
    });
    let releaseSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseSessionWrite = resolve;
        });
      }
      const store = {
        "agent:main:main": buildExistingMainStoreEntry({
          lastChannel: "telegram",
          lastTo: "123",
        }),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockImplementation(() => new Promise(() => {}));
    const context = makeContext();
    const runId = firstRegistration.idempotencyKey;
    const aliasKey = "agent:exec-approval-followup:req-elevated-preaccept-abort";

    const pending = invokeAgent(
      {
        message: "exec followup",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: runId,
        internalRuntimeHandoffId: firstRegistration.handoffId,
      },
      {
        reqId: "exec-followup-preaccept-abort-1",
        client: backendGatewayClient(),
        context,
        flushDispatch: false,
      },
    );
    await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));
    expectMainAlias(context.dedupe.get(aliasKey)?.payload, runId, "agent:main:telegram:direct:123");

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "agent:main:telegram:direct:123", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: backendGatewayClient(),
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
    expectRecordFields(context.dedupe.get(aliasKey)?.payload, {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });

    releaseSessionWrite?.();
    await pending;

    const retryRespond = await invokeAgent(
      {
        message: "exec followup duplicate",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: secondRegistration.idempotencyKey,
        internalRuntimeHandoffId: secondRegistration.handoffId,
      },
      {
        reqId: "exec-followup-preaccept-abort-2",
        client: backendGatewayClient(),
        context,
        flushDispatch: false,
      },
    );

    expect(mockCallArg(retryRespond, 0, 1)).toMatchObject({
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("chat.abort retains the cancelled source until its producer settles", async () => {
    prime();
    const pending = createDeferred<{
      payloads: Array<{ text: string }>;
      meta: { durationMs: number };
    }>();
    let capturedSignal: AbortSignal | undefined;
    mocks.agentCommand.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts.abortSignal;
      return pending.promise;
    });

    const context = makeContext();
    const runId = "idem-abort-run";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    expect(context.rpcSources.has(runId)).toBe(true);
    const source = requireValue(context.rpcSources.get(runId), "retained agent source");
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
    expect(context.rpcSources.get(runId)).toBe(source);
    expect(isRpcSourceActive(source)).toBe(false);
    pending.resolve({ payloads: [{ text: "late completion" }], meta: { durationMs: 1 } });
    await waitForAssertion(() => expect(context.rpcSources.has(runId)).toBe(false));
  });

  registerAgentAbortSubagentTests();

  it("chat.abort by runId allows the owner connection to use a stale session key", async () => {
    prime();
    const pending = createDeferred<{
      payloads: Array<{ text: string }>;
      meta: { durationMs: number };
    }>();
    let capturedSignal: AbortSignal | undefined;
    mocks.agentCommand.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts.abortSignal;
      return pending.promise;
    });

    const context = makeContext();
    const runId = "idem-abort-stale-session-key";
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

    const active = requireValue(context.rpcSources.get(runId), "active run missing");
    active.adapter.sessionKey = "agent:main:canonical";

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "agent:main:main", runId },
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
    expect(context.rpcSources.get(runId)).toBe(active);
    expect(isRpcSourceActive(active)).toBe(false);
    pending.resolve({ payloads: [{ text: "late completion" }], meta: { durationMs: 1 } });
    await waitForAssertion(() => expect(context.rpcSources.has(runId)).toBe(false));
  });

  it("keeps the sessions.abort wait snapshot after late agent completion", async () => {
    prime();
    let capturedSignal: AbortSignal | undefined;
    let resolveRun:
      | ((value: { payloads: Array<{ text: string }>; meta: { durationMs: number } }) => void)
      | undefined;
    mocks.agentCommand.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts.abortSignal;
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    });

    const context = makeContext();
    const runId = "idem-abort-snapshot-wins";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "agent:main:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });
    expect(capturedSignal?.aborted).toBe(true);

    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: `agent:${runId}`,
      entry: {
        ts: 100,
        ok: true,
        payload: {
          runId,
          status: "timeout",
          stopReason: "rpc",
          endedAt: 100,
        },
      },
    });

    resolveRun?.({ payloads: [{ text: "late ok" }], meta: { durationMs: 1 } });

    await waitForAssertion(() => {
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        status: "timeout",
        stopReason: "rpc",
        endedAt: 100,
      });
    });
  });

  it("chat.abort without runId aborts the active agent run for the sessionKey", async () => {
    prime();
    let capturedSignal: AbortSignal | undefined;
    mocks.agentCommand.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts.abortSignal;
      return new Promise(() => {});
    });

    const context = makeContext();
    const runId = "idem-abort-session";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "agent:main:main" },
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
  });

  it("removes the rpcSources entry after the run completes successfully", async () => {
    prime();
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1 },
    });

    const context = makeContext();
    const runId = "idem-abort-cleanup-ok";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    await waitForAssertion(() => {
      expect(context.rpcSources.has(runId)).toBe(false);
    });
  });

  it("retains agent RPC registration until terminal persistence settles", async () => {
    prime();
    let resolveAgent: (value: {
      payloads: Array<{ text: string }>;
      meta: { durationMs: number };
    }) => void = () => undefined;
    const agentResult = new Promise<{
      payloads: Array<{ text: string }>;
      meta: { durationMs: number };
    }>((resolve) => {
      resolveAgent = resolve;
    });
    mocks.agentCommand.mockReturnValueOnce(agentResult);

    const context = makeContext();
    const runId = "idem-abort-cleanup-persisting";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    const entry = requireValue(context.rpcSources.get(runId), "chat abort entry missing");
    let resolvePersistence: () => void = () => undefined;
    entry.adapter.projectSessionTerminalPersistence = new Promise<void>((resolve) => {
      resolvePersistence = resolve;
    });
    resolveAgent({ payloads: [{ text: "ok" }], meta: { durationMs: 1 } });

    await waitForAssertion(() => {
      expect(context.rpcSources.has(runId)).toBe(true);
    });
    resolvePersistence();
    await waitForAssertion(() => {
      expect(context.rpcSources.has(runId)).toBe(false);
    });
  });

  it("removes the rpcSources entry after the run errors", async () => {
    prime();
    mocks.clearAgentRunContext.mockClear();
    mocks.agentCommand.mockRejectedValueOnce(new Error("boom"));

    const context = makeContext();
    const runId = "idem-abort-cleanup-err";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    await waitForAssertion(() => {
      expect(context.rpcSources.has(runId)).toBe(false);
      expect(mocks.clearAgentRunContext).toHaveBeenCalledWith(runId, "test-generation");
    });
  });

  registerAgentPreDispatchFailureTests();

  it("does not dispatch a duplicate agent run when dedupe was evicted but the run is active", async () => {
    prime();
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1 },
    });

    const context = makeContext();
    const runId = "idem-abort-collision";
    const preExisting = createRpcSourceForTest(
      {
        sessionId: "chat-send-session",
        sessionKey: "agent:main:main",
        ownerConnId: "chat-send-conn",
        ownerDeviceId: undefined,
      },
      { runId },
    );
    context.rpcSources.set(runId, preExisting);
    context.dedupe.delete(`agent:${runId}`);
    mocks.registerAgentRunContext.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId, respond },
    );

    expect(context.rpcSources.get(runId)).toBe(preExisting);
    expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
    expect(context.addChatRun).not.toHaveBeenCalled();
    expect(mocks.registerAgentRunContext).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { runId, status: "in_flight" }, undefined, {
      cached: true,
      runId,
    });
  });

  it("does not dispatch a duplicate sessionless run while its reservation is active", async () => {
    prime();
    let finishRun!: (result: {
      payloads: Array<{ text: string }>;
      meta: { durationMs: number };
    }) => void;
    mocks.agentCommand.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRun = resolve;
      }),
    );

    const context = makeContext();
    const runId = "idem-sessionless-active-collision";
    const request = {
      message: "hi",
      agentId: "main",
      sessionId: "sessionless-existing-session",
      idempotencyKey: runId,
    };
    await invokeAgent(request, { context, reqId: runId });
    expect(context.rpcSources.has(runId)).toBe(false);
    expect(mocks.agentCommand).toHaveBeenCalledTimes(1);

    const duplicateRespond = vi.fn();
    await invokeAgent(request, {
      context,
      reqId: `${runId}-duplicate`,
      respond: duplicateRespond,
    });

    expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
    expect(duplicateRespond).toHaveBeenCalledWith(
      true,
      { runId, status: "in_flight", agentId: "main" },
      undefined,
      {
        cached: true,
        runId,
      },
    );

    finishRun({ payloads: [{ text: "ok" }], meta: { durationMs: 1 } });
  });

  it("keeps a sessionless run from replacing an active projected run", async () => {
    prime();
    const context = makeContext();
    const runId = "idem-sessionless-projected-collision";
    const preExisting = createRpcSourceForTest(
      { sessionId: "chat-send-session", sessionKey: "agent:main:main" },
      { runId },
    );
    context.rpcSources.set(runId, preExisting);
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionId: "sessionless-existing-session",
        idempotencyKey: runId,
      },
      { context, reqId: runId, respond },
    );

    expect(context.rpcSources.get(runId)).toBe(preExisting);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { runId, status: "in_flight" }, undefined, {
      cached: true,
      runId,
    });
  });

  it("returns in_flight instead of replaying cached accepted agent replies", async () => {
    prime();
    const dispatchGate = createDeferred();
    const dispatchYield = vi
      .spyOn(agentHandlerHelpers, "yieldAfterAgentAcceptedAck")
      .mockReturnValue(dispatchGate.promise);
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1 },
    });
    const context = makeContext();
    const runId = "idem-cached-accepted";
    try {
      await invokeAgent(
        {
          message: "hi",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId, flushDispatch: false },
      );
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        status: "accepted",
        sessionKey: "agent:main:main",
      });
      const duplicateRespond = vi.fn();
      await invokeAgent(
        {
          message: "hi again",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: `${runId}-duplicate`, respond: duplicateRespond },
      );
      expect(mocks.agentCommand.mock.calls.length).toBe(0);
      expect(duplicateRespond).toHaveBeenCalledWith(
        true,
        { runId, status: "in_flight", sessionKey: "agent:main:main", agentId: "main" },
        undefined,
        { cached: true, runId },
      );
    } finally {
      dispatchGate.resolve();
      try {
        await waitForAssertion(() => expect(context.rpcSources.has(runId)).toBe(false));
      } finally {
        dispatchYield.mockRestore();
      }
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

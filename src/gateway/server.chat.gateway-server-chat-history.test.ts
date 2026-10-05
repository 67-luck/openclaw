// Gateway server chat tests cover WebSocket chat flow, history construction,
// NO_REPLY handling, agent events, and connected control-UI delivery.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { createSafeGatewayRestartPreflight } from "../infra/restart-coordinator.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { drainOpenClawAgentWriteQueuesForTest } from "../state/openclaw-agent-write-admission.test-support.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { installGatewayServerChatTestSuite } from "./server.chat.gateway-server-chat.test-support.js";
import {
  collectHistoryTextValues,
  createGatewayHistoryText,
} from "./session-history-fixtures.test-support.js";
import * as sessionLifecycleState from "./session-lifecycle-state.js";
import { removeChatTestDirectory as removeTempDir } from "./session-test-directories.test-support.js";
import {
  agentDiscoveryMock,
  connectOk,
  dispatchInboundMessageMock,
  onceMessage,
  rpcReq,
  testState,
  trackConnectChallengeNonce,
  writeSessionStore,
} from "./test-helpers.js";
import { agentCommandMock } from "./test-helpers.runtime-state.js";

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

let ws: WebSocket;
let port: number;

const gatewaySuite = installGatewayServerChatTestSuite((started) => {
  ws = started.ws;
  port = started.port;
});
const { expectRecordFields, settleGatewayFixture, waitForAgentRunDrained, withMainSessionStore } =
  gatewaySuite;

describe("gateway server chat", () => {
  const waitForChatEvent = (runId: string, state = "final") =>
    onceMessage(
      ws,
      (event) =>
        event.type === "event" &&
        event.event === "chat" &&
        event.payload?.state === state &&
        event.payload?.runId === runId,
      8_000,
    );

  const loadChatHistoryWithMessages = async (
    messages: Array<Record<string, unknown>>,
  ): Promise<unknown[]> => {
    return withMainSessionStore(async () => {
      await replaceMainTranscriptMessages(messages);

      const res = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
      });
      expect(res.ok).toBe(true);
      return res.payload?.messages ?? [];
    });
  };

  const replaceMainTranscriptMessages = async (
    messages: Record<string, unknown>[],
  ): Promise<void> => {
    const storePath = testState.sessionStorePath;
    if (!storePath) {
      throw new Error("session store path was not initialized");
    }
    const events = messages.map((message, index) => ({
      message,
      id: `message-${index}`,
      type: "message",
    }));
    await replaceTranscriptEvents(
      { agentId: "main", sessionId: "sess-main", sessionKey: "main", storePath },
      events,
    );
  };

  test("sanitizes inbound chat.send message text and rejects null bytes", async () => {
    const nullByteRes = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message: "hello\u0000world",
      idempotencyKey: "idem-null-byte-1",
    });
    expect(nullByteRes.ok).toBe(false);
    expect((nullByteRes.error as { message?: string } | undefined)?.message ?? "").toMatch(
      /null bytes/i,
    );

    const sanitizedRes = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message: "Cafe\u0301\u0007\tline",
      idempotencyKey: "idem-sanitized-1",
    });
    expect(sanitizedRes.ok).toBe(true);
    await waitForAgentRunDrained("idem-sanitized-1");
  });

  test("handles chat send and history flows", async () => {
    const tempDirs: string[] = [];
    let webchatWs: WebSocket | undefined;
    agentDiscoveryMock.enabled = true;
    agentDiscoveryMock.models = [
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        provider: "anthropic",
        input: ["text", "image"],
      },
    ];

    try {
      webchatWs = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { origin: `http://127.0.0.1:${port}` },
      });
      trackConnectChallengeNonce(webchatWs);
      await new Promise<void>((resolve) => {
        webchatWs?.once("open", resolve);
      });
      await connectOk(webchatWs, {
        client: {
          id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          version: "dev",
          platform: "web",
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        },
      });

      const webchatRes = await rpcReq(webchatWs, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-webchat-1",
      });
      expect(webchatRes.ok).toBe(true);
      await waitForAgentRunDrained("idem-webchat-1");

      webchatWs.close();
      webchatWs = undefined;

      testState.agentConfig = { timeoutSeconds: 123 };
      const timeoutRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-timeout-1",
      });
      expect(timeoutRes.ok).toBe(true);
      expect(timeoutRes.payload?.runId).toBe("idem-timeout-1");
      await waitForAgentRunDrained("idem-timeout-1");
      testState.agentConfig = undefined;

      const sessionRes = await rpcReq(ws, "chat.send", {
        sessionKey: "agent:main:subagent:abc",
        message: "hello",
        idempotencyKey: "idem-session-key-1",
      });
      expect(sessionRes.ok).toBe(true);
      expect(sessionRes.payload?.runId).toBe("idem-session-key-1");
      await waitForAgentRunDrained("idem-session-key-1");

      const sendPolicyDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      tempDirs.push(sendPolicyDir);
      testState.sessionStorePath = path.join(sendPolicyDir, "sessions.json");
      testState.sessionConfig = {
        sendPolicy: {
          default: "allow",
          rules: [
            {
              action: "deny",
              match: { channel: "discord", chatType: "group" },
            },
          ],
        },
      };

      await writeSessionStore({
        entries: {
          "discord:group:dev": {
            sessionId: "sess-discord",
            updatedAt: Date.now(),
            chatType: "group",
            channel: "discord",
          },
        },
      });

      const blockedRes = await rpcReq(ws, "chat.send", {
        sessionKey: "discord:group:dev",
        message: "hello",
        idempotencyKey: "idem-1",
      });
      expect(blockedRes.ok).toBe(false);
      expect((blockedRes.error as { message?: string } | undefined)?.message ?? "").toMatch(
        /send blocked/i,
      );

      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;

      const agentBlockedDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      tempDirs.push(agentBlockedDir);
      testState.sessionStorePath = path.join(agentBlockedDir, "sessions.json");
      testState.sessionConfig = {
        sendPolicy: {
          default: "allow",
          rules: [{ action: "deny", match: { keyPrefix: "cron:" } }],
        },
      };

      await writeSessionStore({
        entries: {
          "cron:job-1": {
            sessionId: "sess-cron",
            updatedAt: Date.now(),
          },
        },
      });

      vi.mocked(agentCommandMock).mockClear();
      const agentAllowedRes = await rpcReq(ws, "agent", {
        sessionKey: "cron:job-1",
        message: "hi",
        idempotencyKey: "idem-2",
      });
      expect(agentAllowedRes.ok).toBe(true);
      expect(agentAllowedRes.payload?.status).toBe("accepted");
      expect(agentAllowedRes.payload?.runId).toBe("idem-2");
      await gatewaySuite.requestExecution.waitForCompletion("idem-2");
      expect(agentCommandMock).toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      await drainOpenClawAgentWriteQueuesForTest();

      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;

      const pngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
      // The discovered model advertises image input, so the real capability
      // resolver must keep these attachments inline; offloading here would mean
      // the catalog lookup silently failed and returned false. Capability
      // resolution happens before dispatch, so capturing dispatch args observes
      // the real resolver's decision.
      const inlineDispatches: { runId?: string; images?: unknown[] }[] = [];
      const captureInlineDispatch = async (args: unknown) => {
        const replyOptions = (args as { replyOptions?: { runId?: string; images?: unknown[] } })
          .replyOptions;
        inlineDispatches.push({ runId: replyOptions?.runId, images: replyOptions?.images });
        return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
      };

      dispatchInboundMessageMock.mockImplementationOnce(captureInlineDispatch);
      const imgRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "see image",
        idempotencyKey: "idem-img",
        attachments: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: pngB64,
            },
          },
        ],
      });
      expect(imgRes.ok).toBe(true);
      expect(typeof imgRes.payload?.runId).toBe("string");
      await waitForAgentRunDrained("idem-img");
      expect(inlineDispatches).toEqual([{ runId: "idem-img", images: [expect.anything()] }]);
      dispatchInboundMessageMock.mockImplementationOnce(captureInlineDispatch);
      const imgOnlyRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "",
        idempotencyKey: "idem-img-only",
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "dot.png",
            content: `data:image/png;base64,${pngB64}`,
          },
        ],
      });
      expect(imgOnlyRes.ok).toBe(true);
      expect(typeof imgOnlyRes.payload?.runId).toBe("string");
      await waitForAgentRunDrained("idem-img-only");
      expect(inlineDispatches).toEqual([
        { runId: "idem-img", images: [expect.anything()] },
        { runId: "idem-img-only", images: [expect.anything()] },
      ]);

      const historyDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      tempDirs.push(historyDir);
      testState.sessionStorePath = path.join(historyDir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });

      await replaceMainTranscriptMessages(
        Array.from({ length: 201 }, (_, i) => ({
          role: "user",
          content: [{ type: "text", text: `m${i}` }],
          timestamp: Date.now() + i,
        })),
      );

      const defaultRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
      });
      expect(defaultRes.ok).toBe(true);
      const defaultMsgs = defaultRes.payload?.messages ?? [];
      expect(defaultMsgs.length).toBe(200);
      expect(extractFirstTextBlock(defaultMsgs[0])).toBe("m1");
    } finally {
      await settleGatewayFixture();
      Object.assign(agentDiscoveryMock, { enabled: false, models: [] });
      testState.agentConfig = undefined;
      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;
      if (webchatWs) {
        webchatWs.close();
      }
      await Promise.all(tempDirs.map((dir) => removeTempDir(dir)));
    }
  });

  test("chat.send accepts the backing session id returned by chat.history", async () => {
    await withMainSessionStore(async () => {
      const historyRes = await rpcReq<{ sessionId?: string }>(ws, "chat.history", {
        sessionKey: "main",
      });
      expect(historyRes.ok).toBe(true);
      const sessionId = historyRes.payload?.sessionId;
      expect(sessionId).toBe("sess-main");

      const runId = "idem-chat-send-history-session-id";
      const sendRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        sessionId,
        message: "/context list",
        idempotencyKey: runId,
      });
      expect(sendRes.ok).toBe(true);
      expect(sendRes.payload?.status).toBe("started");

      await waitForAgentRunDrained(runId);
    });
  });

  test("chat.history applies the reset kept-tail cut and preserves its marker", async () => {
    await withMainSessionStore(async () => {
      const storePath = testState.sessionStorePath;
      if (!storePath) {
        throw new Error("session store path was not initialized");
      }
      await replaceTranscriptEvents(
        { agentId: "main", sessionId: "sess-main", sessionKey: "main", storePath },
        [
          { type: "message", id: "old", parentId: null, message: { role: "user", content: "old" } },
          {
            type: "message",
            id: "kept-user",
            parentId: "old",
            message: { role: "user", content: "kept question" },
          },
          {
            type: "message",
            id: "kept-tool",
            parentId: "kept-user",
            message: { role: "toolResult", content: "hidden tool" },
          },
          {
            type: "message",
            id: "kept-assistant",
            parentId: "kept-tool",
            message: { role: "assistant", content: "kept answer" },
          },
          {
            type: "reset",
            id: "reset-boundary",
            parentId: "kept-assistant",
            timestamp: "2026-07-22T00:00:00.000Z",
            reason: "new",
            firstKeptEntryId: "kept-user",
          },
          {
            type: "message",
            id: "post-reset",
            parentId: "reset-boundary",
            message: { role: "user", content: "new turn" },
          },
        ],
      );

      const history = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
      });

      expect(history.ok).toBe(true);
      expect(collectHistoryTextValues(history.payload?.messages ?? [])).toEqual([
        "kept question",
        "kept answer",
        "Reset",
        "new turn",
      ]);
    });
  });

  test("marks a running webchat session failed when restart drain overlaps dispatch rejection", async () => {
    await withMainSessionStore(async (dir) => {
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            sessionFile: path.join(dir, "sess-main.jsonl"),
            updatedAt: 1_000,
            status: "running",
            startedAt: 900,
          },
        },
      });
      const subscribeRes = await rpcReq(ws, "sessions.subscribe", {});
      expect(subscribeRes.ok).toBe(true);
      const rejectDispatch = createDeferred();
      const releasePersistence = createDeferred();
      let dispatchStarted = false;
      const persistenceEntered = createDeferred();
      const persistLifecycleEvent = sessionLifecycleState.persistGatewaySessionLifecycleEvent;
      const persistSpy = vi
        .spyOn(sessionLifecycleState, "persistGatewaySessionLifecycleEvent")
        .mockImplementation(async (params) => {
          if (params.event.runId !== "idem-dispatch-error-1") {
            await persistLifecycleEvent(params);
            return;
          }
          persistenceEntered.resolve();
          await releasePersistence.promise;
          await persistLifecycleEvent(params);
        });
      const messagePromises: Promise<unknown>[] = [];
      const sessionChanged = await (async () => {
        try {
          dispatchInboundMessageMock.mockImplementationOnce(async () => {
            dispatchStarted = true;
            await rejectDispatch.promise;
            throw new Error("provider rejected request");
          });
          const errorPromise = waitForChatEvent("idem-dispatch-error-1", "error");
          messagePromises.push(errorPromise);
          const sessionChangedPromise = onceMessage(
            ws,
            (o) =>
              o.type === "event" &&
              o.event === "sessions.changed" &&
              o.payload?.sessionKey === "agent:main:main" &&
              o.payload?.status === "failed" &&
              o.payload?.lastRunId === "idem-dispatch-error-1" &&
              o.payload?.hasActiveRun === false,
            8_000,
          );
          messagePromises.push(sessionChangedPromise);
          const res = await rpcReq(ws, "chat.send", {
            sessionKey: "main",
            message: "run: pwd",
            idempotencyKey: "idem-dispatch-error-1",
          });
          expect(res.ok).toBe(true);
          await waitForFast(() => {
            expect(dispatchStarted).toBe(true);
          });
          markGatewayRestartDraining();
          rejectDispatch.resolve();
          await persistenceEntered.promise;
          const restartInspectors = {
            getQueueSize: () => 0,
            getPendingReplies: () => 0,
            getEmbeddedRuns: () => 0,
            getCronRuns: () => 0,
            getBackgroundExecSessions: () => 0,
            getAgentRuns: () => 0,
            getAcpRuns: () => 0,
            getMediaRuns: () => 0,
          };
          expect(createSafeGatewayRestartPreflight(restartInspectors)).toMatchObject({
            safe: false,
            counts: { rootRequests: 1 },
          });
          releasePersistence.resolve();
          await errorPromise;
          const changed = await sessionChangedPromise;
          await waitForFast(() => {
            expect(createSafeGatewayRestartPreflight(restartInspectors).safe).toBe(true);
          });
          return changed;
        } finally {
          rejectDispatch.resolve();
          releasePersistence.resolve();
          await Promise.allSettled(messagePromises);
          persistSpy.mockRestore();
          resetGatewayWorkAdmission();
        }
      })();
      expectRecordFields(sessionChanged.payload, {
        sessionId: "sess-main",
        status: "failed",
        lastRunId: "idem-dispatch-error-1",
        hasActiveRun: false,
      });

      const sessionsRes = await rpcReq<{ sessions?: unknown[] }>(ws, "sessions.list", {});
      expect(sessionsRes.ok).toBe(true);
      const session = sessionsRes.payload?.sessions?.find(
        (row) => isRecord(row) && row.key === "agent:main:main",
      );
      const actualSession = expectRecordFields(session, {
        status: "failed",
        lastRunId: "idem-dispatch-error-1",
        hasActiveRun: false,
      });
      expect(typeof actualSession.startedAt).toBe("number");
      expect(typeof actualSession.endedAt).toBe("number");
      expect(typeof actualSession.runtimeMs).toBe("number");
    });
  });

  const contextOverflowCopy =
    "This conversation is too long for the model. Try /compact, or start a new conversation with /new.";

  test.each([
    {
      name: "structured context-overflow code",
      fields: {
        errorCode: "context_overflow",
        errorMessage: "private upstream body: 203557 tokens sent",
      },
      expected: contextOverflowCopy,
    },

    {
      name: "token-per-minute rate limit",
      fields: {
        errorCode: "rate_limit_exceeded",
        errorMessage: "413 request too large: 203557 tokens per minute (TPM)",
      },
      expected: "⚠️ The AI service needs a short break. Please try again in a few minutes.",
    },
    {
      name: "private upstream failure",
      fields: { errorMessage: "private upstream at secret.internal.example failed" },
      expected: "The agent run failed before producing a reply.",
    },
  ])(
    "chat.history safely displays $name over authenticated WebSocket",
    async ({ fields, expected }) => {
      const historyMessages = await loadChatHistoryWithMessages([
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          ...fields,
          timestamp: 1,
        },
      ]);

      expect(collectHistoryTextValues(historyMessages)).toEqual([expected]);
      const wirePayload = JSON.stringify(historyMessages);
      expect(wirePayload).not.toContain("203557");
      expect(wirePayload).not.toContain("196607");
      expect(wirePayload).not.toContain("secret.internal.example");
      expect(historyMessages[0]).not.toHaveProperty("errorCode");
      expect(historyMessages[0]).not.toHaveProperty("errorType");
      expect(historyMessages[0]).not.toHaveProperty("errorMessage");
    },
  );

  test.each([
    {
      name: "hides assistant control replies in Responses output blocks",
      messages: [
        {
          role: "assistant",
          content: [{ type: "output_text", text: "NO_REPLY" }],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "output_text", text: "visible response" }],
          timestamp: 2,
        },
        {
          role: "assistant",
          content: [{ type: "input_text", text: "NO_REPLY" }],
          timestamp: 3,
        },
        {
          role: "assistant",
          content: [{ type: "input_text", text: "visible assistant input" }],
          timestamp: 4,
        },
      ],
      expected: ["assistant:visible response", "assistant:visible assistant input"],
    },
    {
      name: "hides commentary-only assistant entries",
      messages: [
        createGatewayHistoryText("user", "hello", 1),
        {
          role: "assistant",
          phase: "commentary",
          content: [{ type: "text", text: "thinking like caveman" }],
          timestamp: 2,
        },
        createGatewayHistoryText("assistant", "real reply", 3),
      ],
      expected: ["user:hello", "assistant:real reply"],
    },
    {
      name: "hides assistant announce/reply skip-only entries",
      messages: [
        createGatewayHistoryText("assistant", "ANNOUNCE_SKIP", 1),
        createGatewayHistoryText("assistant", "REPLY_SKIP", 2),
        {
          role: "assistant",
          text: "real text field reply",
          content: "ANNOUNCE_SKIP",
          timestamp: 3,
        },
        createGatewayHistoryText("assistant", "real reply", 4),
      ],
      expected: ["assistant:real text field reply", "assistant:real reply"],
    },
    {
      name: "hides assistant NO_REPLY-only entries and keeps mixed-content assistant entries",
      messages: [
        createGatewayHistoryText("user", "hello", 1),
        createGatewayHistoryText("assistant", "NO_REPLY", 2),
        createGatewayHistoryText("assistant", "real reply", 3),
        {
          role: "assistant",
          text: "real text field reply",
          content: "NO_REPLY",
          timestamp: 4,
        },
        createGatewayHistoryText("user", "NO_REPLY", 5),
        {
          role: "assistant",
          content: [
            { type: "text", text: "NO_REPLY" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
          ],
          timestamp: 6,
        },
      ],
      expected: [
        "user:hello",
        "assistant:real reply",
        "assistant:real text field reply",
        "user:NO_REPLY",
        "assistant:NO_REPLY",
      ],
    },
  ])("chat.history $name", async ({ messages, expected }) => {
    const historyMessages = await loadChatHistoryWithMessages(messages);
    const roleAndText = historyMessages.map((message) => {
      const entry = isRecord(message) ? message : {};
      const role = typeof entry.role === "string" ? entry.role : "unknown";
      const text =
        typeof entry.text === "string" ? entry.text : (extractFirstTextBlock(message) ?? "");
      return `${role}:${text}`;
    });

    expect(roleAndText).toEqual(expected);
  });
});

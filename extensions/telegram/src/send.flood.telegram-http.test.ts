import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Bot } from "grammy";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getOrCreateAccountThrottler, runReplaceableTelegramRequest } from "./account-throttler.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { resetTelegramAccountThrottlersForTest } from "./runtime.test-support.js";
import { sendMessageTelegram, resetTelegramClientOptionsCacheForTests } from "./send.js";

describe("Telegram flood authority through real HTTP clients", () => {
  let server: Server;
  const fixture = {
    cfg: { channels: { telegram: { botToken: "123456:telegram-flood-fixture", apiRoot: "" } } },
    requests: [] as Array<{ method: string; fields: Record<string, unknown> }>,
    rejections: [] as Array<{
      error_code: number;
      description: string;
      parameters: { retry_after: number };
    }>,
    requestHold: undefined as
      | {
          arrived: ReturnType<typeof createDeferred<void>>;
          release: ReturnType<typeof createDeferred<void>>;
        }
      | undefined,
  };
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        void (async () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const fields: Record<string, unknown> = req.headers["content-type"]?.includes(
            "application/json",
          )
            ? JSON.parse(body)
            : Object.fromEntries(new URLSearchParams(body));
          fixture.requests.push({ method: req.url?.split("/").at(-1) ?? "", fields });
          const held = fixture.requestHold;
          fixture.requestHold = undefined;
          if (held) {
            held.arrived.resolve();
            await held.release.promise;
          }
          const rejection = fixture.rejections.shift();
          res.setHeader("content-type", "application/json");
          res.setHeader("connection", "close");
          if (rejection) {
            res.writeHead(rejection.error_code).end(JSON.stringify({ ok: false, ...rejection }));
            return;
          }
          res.end(
            JSON.stringify({
              ok: true,
              result: {
                message_id: fixture.requests.length,
                date: 1,
                chat: {
                  id: Number(fields.chat_id),
                  type: Number(fields.chat_id) < 0 ? "supergroup" : "private",
                },
                ...(fields.message_thread_id
                  ? { message_thread_id: Number(fields.message_thread_id) }
                  : {}),
                text: fields.text,
              },
            }),
          );
        })().catch((error: unknown) => {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    fixture.cfg.channels.telegram.apiRoot =
      "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  });
  beforeEach(() => {
    fixture.requests.length = 0;
    fixture.rejections.length = 0;
    fixture.requestHold = undefined;
    resetTelegramAccountThrottlersForTest();
    resetTelegramClientOptionsCacheForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetTelegramAccountThrottlersForTest();
    resetTelegramClientOptionsCacheForTests();
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  it.each(["current", "retired"] as const)(
    "review: queued unfinished preview retains network authority (%s)",
    async (writer) => {
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
      const token = fixture.cfg.channels.telegram.botToken;
      const bot = new Bot(token, { client: { apiRoot: fixture.cfg.channels.telegram.apiRoot } });
      bot.api.config.use(getOrCreateAccountThrottler(token).transformer);
      const entered = createDeferred<void>();
      bot.api.config.use((prev, method, payload, signal) => {
        if (method === "editMessageText") {
          entered.resolve();
        }
        return prev(method, payload, signal);
      });
      let current = true;
      const stream = createTelegramDraftStream({
        api: bot.api,
        chatId: -1001,
        thread: { id: 2, scope: "forum" },
      });
      const authority = () => {
        if (!current) {
          throw new Error("preview writer retired");
        }
      };
      stream.update("seed preview", { assertPlatformSendAuthorized: authority });
      await stream.flush();
      const hold = { arrived: createDeferred<void>(), release: createDeferred<void>() };
      fixture.requestHold = hold;
      const blocker = runReplaceableTelegramRequest(() =>
        bot.api.sendMessage(-1001, "queue blocker", { message_thread_id: 1 }),
      );
      await hold.arrived.promise;
      stream.update("queued preview", { assertPlatformSendAuthorized: authority });
      const flushed = stream.flush();
      await entered.promise;
      current = writer === "current";
      hold.release.resolve();
      await blocker;
      await flushed;
      await stream.discard();
      expect(fixture.requests.filter(({ method }) => method === "editMessageText")).toHaveLength(
        writer === "current" ? 1 : 0,
      );
    },
  );

  it.each([
    { writer: "replaced", expectedSends: 1 },
    { writer: "current", expectedSends: 2 },
  ] as const)(
    "rechecks send authority after a flood wait on a turn-bound client ($writer writer)",
    async ({ writer, expectedSends }) => {
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
      const token = fixture.cfg.channels.telegram.botToken;
      // A turn-bound client carries only the account limiter, not send-context's authority hook.
      const bot = new Bot(token, { client: { apiRoot: fixture.cfg.channels.telegram.apiRoot } });
      bot.api.config.use(getOrCreateAccountThrottler(token).transformer);
      fixture.rejections.push({
        error_code: 429,
        description: "Too Many Requests: retry after 5",
        parameters: { retry_after: 5 },
      });
      let writerIsCurrent = true;
      const outcome = sendMessageTelegram("123", "Final after flood", {
        cfg: fixture.cfg,
        api: bot.api,
        assertPlatformSendAuthorized: () => {
          if (!writerIsCurrent) {
            throw new Error("session writer replaced");
          }
        },
      }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(1));
      writerIsCurrent = writer === "current";
      await vi.advanceTimersByTimeAsync(5_000);
      const settled = await outcome;

      expect(fixture.requests).toHaveLength(expectedSends);
      if (writer === "replaced") {
        expect(String((settled as { error?: unknown }).error)).toContain("session writer replaced");
      } else {
        expect(settled).toMatchObject({ result: { messageId: expect.any(String) } });
      }
    },
  );

  it.each([
    { writer: "current", topicTwoSends: 1 },
    { writer: "replaced", topicTwoSends: 0 },
  ] as const)(
    "admits a queued group topic send only after the flood wait and for the current writer ($writer)",
    async ({ writer, topicTwoSends }) => {
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
      const token = fixture.cfg.channels.telegram.botToken;
      const bot = new Bot(token, { client: { apiRoot: fixture.cfg.channels.telegram.apiRoot } });
      bot.api.config.use(getOrCreateAccountThrottler(token).transformer);
      // Installed last, so it runs first: marks topic 2 entering the account limiter.
      const topicTwoEntered = createDeferred<void>();
      bot.api.config.use((prev, method, payload, signal) => {
        if ((payload as { message_thread_id?: unknown }).message_thread_id === 2) {
          topicTwoEntered.resolve();
        }
        return prev(method, payload, signal);
      });
      const startedAt = Date.now();
      const held = { arrived: createDeferred<void>(), release: createDeferred<void>() };
      fixture.requestHold = held;
      fixture.rejections.push({
        error_code: 429,
        description: "Too Many Requests: retry after 5",
        parameters: { retry_after: 5 },
      });
      let writerIsCurrent = true;
      const sendTopic = (topic: number, authorized: boolean) =>
        sendMessageTelegram("-1001", `Topic ${topic} final`, {
          cfg: fixture.cfg,
          api: bot.api,
          messageThreadId: topic,
          ...(authorized
            ? {
                assertPlatformSendAuthorized: () => {
                  if (!writerIsCurrent) {
                    throw new Error("group session writer replaced");
                  }
                },
              }
            : {}),
        }).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      const topicOne = sendTopic(1, false);
      await held.arrived.promise;
      // Topic 2 passes the caller check and the gate, then queues behind topic 1.
      const topicTwo = sendTopic(2, true);
      await topicTwoEntered.promise;
      await vi.advanceTimersByTimeAsync(0);
      writerIsCurrent = writer !== "replaced";
      held.release.resolve();
      await vi.advanceTimersByTimeAsync(4_900);
      // Nothing reaches Telegram inside retry_after, including the queued topic.
      expect(fixture.requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10_000);
      const [one, two] = await Promise.all([topicOne, topicTwo]);
      const topicTwoRequests = fixture.requests.filter(
        ({ fields }) => fields.message_thread_id === 2,
      );

      expect(one).toMatchObject({ result: { messageId: expect.any(String) } });
      expect(topicTwoRequests).toHaveLength(topicTwoSends);
      if (writer === "replaced") {
        expect(String((two as { error?: unknown }).error)).toContain(
          "group session writer replaced",
        );
      } else {
        expect(two).toMatchObject({ result: { messageId: expect.any(String) } });
      }
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(5_000);
    },
  );
});

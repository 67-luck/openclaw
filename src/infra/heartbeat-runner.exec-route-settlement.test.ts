import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { heartbeatRunnerTelegramPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import { getReplySystemEventContext } from "../auto-reply/reply/system-event-session-key.js";
import type { ChannelMessagingAdapter } from "../channels/plugins/types.core.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { SESSION_CREATED_NOTICE_CONTEXT_PREFIX } from "../sessions/session-state-event-kinds.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { racePromiseWithAbortSignal } from "./abort-signal.js";
import { runHeartbeatOnce, startHeartbeatRunner } from "./heartbeat-runner.js";
import {
  heartbeatTestConfig,
  seedMainSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { requestHeartbeatAndWait, setHeartbeatWakeHandler } from "./heartbeat-wake.js";
import { enqueueSystemEvent, peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

const route = {
  channel: "telegram",
  to: "telegram:-1003774691294:topic:47",
  accountId: "work",
  threadId: 47,
};
beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "telegram", plugin: heartbeatRunnerTelegramPlugin, source: "test" },
    ]),
  );
  resetSystemEventsForTest();
});
afterEach(async () => {
  setHeartbeatWakeHandler(async () => ({ status: "ran", durationMs: 0 }));
  await requestHeartbeatAndWait({
    source: "manual",
    intent: "immediate",
    reason: "wake",
    coalesceMs: 0,
  });
  setHeartbeatWakeHandler(null);
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

it.each(["rejected-external", "valid-external", "internal", "captured-internal"] as const)(
  "keeps dashboard publication separate from %s exec custody",
  async (kind) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const cfg = heartbeatTestConfig(tmpDir, "last", "telegram", storePath);
      cfg.messages = { visibleReplies: "message_tool" };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        sessionId: "dashboard-custody",
        lifecycleRevision: "dashboard-generation",
        lastChannel: "webchat",
        lastProvider: "",
        lastTo: "",
        createdVia: "operator",
      });
      const marker = "EXEC_ROUTE_PUBLICATION_BOUNDARY";
      const external = kind.endsWith("external");
      if (kind === "rejected-external") {
        const messaging: ChannelMessagingAdapter = {
          ...heartbeatRunnerTelegramPlugin.messaging,
          resolveOutboundSessionRoute: async (params) => {
            await Promise.resolve();
            return {
              sessionKey,
              baseSessionKey: sessionKey,
              peer: { kind: "group", id: "-1003774691294" },
              chatType: "group",
              to: params.target,
              from: "telegram:group:-1003774691294",
              threadId: 99,
            };
          },
        };
        setActivePluginRegistry(
          createTestRegistry([
            {
              pluginId: "telegram",
              source: "test",
              plugin: { ...heartbeatRunnerTelegramPlugin, messaging },
            },
          ]),
        );
      }
      enqueueSystemEvent("Exec completed (publication-boundary, code 0) :: " + marker, {
        sessionKey,
        contextKey: "exec:publication-boundary",
        ...(external
          ? { deliveryContext: route }
          : kind === "captured-internal"
            ? { deliveryContext: { channel: "webchat", to: sessionKey } }
            : {}),
      });
      const telegram = vi
        .fn()
        .mockResolvedValue({ messageId: "external-delivery", chatId: "-1003774691294" });
      replySpy.mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: "done",
          notify: true,
          summary: "Diagnostic summary",
          notificationText: marker,
        }),
      );
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        deps: { getReplyFromConfig: replySpy, telegram },
      });
      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledOnce();
      const body = replySpy.mock.calls[0]?.[0].Body;
      if (kind === "rejected-external") {
        expect(body).not.toContain(marker);
        expect(telegram).not.toHaveBeenCalled();
      } else {
        expect(body).toContain(marker);
      }
      if (kind === "valid-external") {
        expect(telegram).toHaveBeenCalledExactlyOnceWith(
          route.to,
          marker,
          expect.objectContaining({ accountId: "work", messageThreadId: 47 }),
        );
      }
      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionKey,
        sessionId: "dashboard-custody",
        storePath,
      });
      const published = events.filter((event) => {
        const message = readTranscriptEventMessage(event);
        return message?.role === "assistant" && JSON.stringify(message.content).includes(marker);
      });
      expect(published).toHaveLength(external ? 0 : 1);
      if (!external) {
        expect(telegram).not.toHaveBeenCalled();
      }
    });
  },
);

it.each(["configured", "requested"] as const)(
  "automatically advances exec routes past excluded base notices without an interval (%s isolation)",
  async (kind) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = heartbeatTestConfig(tmpDir, "last", "telegram", storePath);
      cfg.agents!.defaults!.heartbeat = {
        every: "0m",
        target: "last",
        ...(kind === "configured" ? { isolatedSession: true } : {}),
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: route.to,
        lastAccountId: "work",
        lastThreadId: 47,
      });
      const a = "EXEC_ROUTE_A";
      const b = "EXEC_ROUTE_B";
      const notice = "PRIVATE_EXCLUDED_BASE_NOTICE";
      enqueueSystemEvent("Exec completed (route-a, code 0) :: " + a, {
        sessionKey,
        contextKey: "exec:route-a",
        deliveryContext: route,
      });
      enqueueSystemEvent(notice, {
        sessionKey,
        contextKey: "notice:base",
        deliveryContext: {
          ...route,
          to: "telegram:-1003774691294:topic:99",
          accountId: "personal",
          threadId: 99,
        },
      });
      enqueueSystemEvent("Exec completed (route-b, code 0) :: " + b, {
        sessionKey,
        contextKey: "exec:route-b",
        deliveryContext: {
          ...route,
          to: "telegram:-1003774691294:topic:99",
          accountId: "personal",
          threadId: 99,
        },
      });
      const telegram = vi.fn().mockResolvedValue({ messageId: "delivered" });
      const inputs: string[] = [];
      replySpy.mockImplementation(async (ctx, options) => {
        const events = getReplySystemEventContext(options);
        const formatted = await drainFormattedSystemEvents({
          cfg,
          agentId: "main",
          sessionKey: events?.sessionKey ?? ctx.SessionKey ?? sessionKey,
          isMainSession: false,
          isNewSession: false,
          events: events?.events ?? [],
          consume: events?.consumeEvents !== false,
        });
        const input = String(ctx.Body) + "\n" + (formatted ?? "");
        inputs.push(input);
        return { text: input.includes(notice) ? notice : input.includes(a) ? a : b };
      });
      const followup = createDeferred<Awaited<ReturnType<typeof runHeartbeatOnce>>>();
      const runner = startHeartbeatRunner({
        cfg,
        runOnce: (opts) => {
          const run = runHeartbeatOnce({
            ...opts,
            cfg,
            deps: { getReplyFromConfig: replySpy, telegram },
          });
          void run.then((result) => {
            if (telegram.mock.calls.length === 2) {
              followup.resolve(result);
            }
          }, followup.reject);
          return run;
        },
      });
      onTestFinished(() => runner.stop());
      try {
        const initial = {
          source: "exec-event" as const,
          intent: "event" as const,
          reason: "exec-event",
          agentId: "main",
          sessionKey,
        };
        const first =
          kind === "requested"
            ? await runHeartbeatOnce({
                ...initial,
                cfg,
                heartbeat: { isolatedSession: true },
                deps: { getReplyFromConfig: replySpy, telegram },
              })
            : await requestHeartbeatAndWait({ ...initial, coalesceMs: 0 });
        expect(first).toMatchObject({ status: "ran" });
        expect(replySpy).toHaveBeenCalledOnce();
        expect(telegram).toHaveBeenCalledOnce();
        expect(peekSystemEvents(sessionKey)).toEqual([
          notice,
          "Exec completed (route-b, code 0) :: " + b,
        ]);
        await expect(
          racePromiseWithAbortSignal(followup.promise, AbortSignal.timeout(45_000)),
        ).resolves.toMatchObject({
          status: "ran",
        });
        expect(replySpy).toHaveBeenCalledTimes(2);
        expect(inputs.every((input) => !input.includes(notice))).toBe(true);
        expect(telegram.mock.calls).toEqual([
          [route.to, a, expect.objectContaining({ accountId: "work", messageThreadId: 47 })],
          [
            "telegram:-1003774691294:topic:99",
            b,
            expect.objectContaining({ accountId: "personal", messageThreadId: 99 }),
          ],
        ]);
        expect(peekSystemEvents(sessionKey)).toEqual([notice]);
      } finally {
        runner.stop();
      }
    });
  },
);

it("settled scheduled work automatically releases a deferred captured exec route", async ({
  signal,
}) => {
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const cfg = heartbeatTestConfig(tmpDir, "telegram", "telegram", storePath);
    cfg.agents!.defaults!.heartbeat = {
      every: "5m",
      target: "telegram",
      to: "1234567890",
      accountId: "personal",
      isolatedSession: true,
    };
    const sessionKey = await seedMainSessionStore(storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: route.to,
      lastAccountId: "work",
      lastThreadId: 47,
    });
    const marker = "DEFERRED_AFTER_TASK";
    enqueueSystemEvent("Exec completed (after-task, code 0) :: " + marker, {
      sessionKey,
      contextKey: "exec:after-task",
      deliveryContext: route,
    });
    const telegram = vi.fn().mockResolvedValue({ messageId: "delivered" });
    replySpy.mockImplementation(async (ctx) => {
      if (ctx.InternalTurnSource === "exec") {
        return { text: marker };
      }
      expect(ctx.Body).not.toContain(marker);
      return { text: "SCHEDULED_TASK_DONE" };
    });
    const followup = createDeferred<Awaited<ReturnType<typeof runHeartbeatOnce>>>();
    const runner = startHeartbeatRunner({
      cfg,
      runOnce: (opts) => {
        const run = runHeartbeatOnce({
          ...opts,
          cfg,
          deps: { getReplyFromConfig: replySpy, telegram },
        });
        followup.resolve(run);
        return run;
      },
    });
    onTestFinished(() => runner.stop());
    try {
      const scheduled = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        source: "cron",
        intent: "task",
        reason: "cron:scheduled",
        tasks: [{ jobId: "scheduled", name: "Scheduled check", prompt: "Check status." }],
        deps: { getReplyFromConfig: replySpy, telegram },
      });
      expect(scheduled).toMatchObject({ status: "ran" });
      await expect(
        racePromiseWithAbortSignal(
          followup.promise,
          AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
        ),
      ).resolves.toMatchObject({ status: "ran" });
      expect(replySpy).toHaveBeenCalledTimes(2);
      expect(telegram.mock.calls).toEqual([
        ["1234567890", "SCHEDULED_TASK_DONE", expect.objectContaining({ accountId: "personal" })],
        [route.to, marker, expect.objectContaining({ accountId: "work", messageThreadId: 47 })],
      ]);
      expect(peekSystemEvents(sessionKey)).toEqual([]);
    } finally {
      runner.stop();
    }
  });
});

it.each([
  ["session-created", SESSION_CREATED_NOTICE_CONTEXT_PREFIX + "base", false],
  ["notice-other", "notice:base", false],
  ["notification-other", "notification:base", false],
  ["notice-same", "notice:base", true],
  ["notification-same", "notification:base", true],
] as const)(
  "an excluded %s base notice cannot enter an eligible tagged cron route",
  async (_label, contextKey, sameRoute) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = heartbeatTestConfig(tmpDir, "telegram", "telegram", storePath);
      cfg.agents!.defaults!.heartbeat = {
        every: "0m",
        target: "telegram",
        to: "1234567890",
        accountId: "personal",
        isolatedSession: true,
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: route.to,
        lastAccountId: "work",
        lastThreadId: 47,
      });
      const excluded = "EXCLUDED_SESSION_NOTICE";
      const reminder = "Reminder: ELIGIBLE_CRON_ROUTE_B";
      enqueueSystemEvent(excluded, {
        sessionKey,
        contextKey,
        deliveryContext: sameRoute
          ? { ...route, to: "telegram:-1003774691294:topic:99", threadId: 99 }
          : route,
      });
      enqueueSystemEvent(reminder, {
        sessionKey,
        contextKey: "cron:route-b",
        deliveryContext: { ...route, to: "telegram:-1003774691294:topic:99", threadId: 99 },
      });
      const telegram = vi.fn().mockResolvedValue({ messageId: "cron-delivered" });
      replySpy.mockResolvedValue({ text: "ELIGIBLE_CRON_NOTIFICATION" });
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        source: "cron",
        intent: "immediate",
        reason: "cron:route-b",
        deps: { getReplyFromConfig: replySpy, telegram },
      });
      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledOnce();
      expect(replySpy.mock.calls[0]?.[0].Body).toContain(reminder);
      expect(replySpy.mock.calls[0]?.[0].Body).not.toContain(excluded);
      expect(telegram).toHaveBeenCalledExactlyOnceWith(
        "1234567890",
        "ELIGIBLE_CRON_NOTIFICATION",
        expect.objectContaining({ accountId: "personal" }),
      );
      expect(peekSystemEvents(sessionKey)).toEqual([excluded]);
    });
  },
);

it.each(["explicit", "last", "keyless", "partial", "direct"] as const)(
  "retains %s cron destination overrides through automatic exec route follow-ups",
  async (kind) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = heartbeatTestConfig(tmpDir, "telegram", "telegram", storePath);
      cfg.agents!.defaults!.heartbeat = {
        every: "0m",
        target: "telegram",
        to: "1234567890",
        accountId: "personal",
        isolatedSession: true,
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: route.to,
        lastAccountId: "work",
        lastThreadId: 47,
      });
      const cronTo =
        kind === "last" || kind === "direct"
          ? route.to
          : kind === "partial"
            ? "1234567890"
            : "2234567890";
      const cronAccount = kind === "partial" ? "personal" : "work";
      const heartbeat =
        kind === "partial"
          ? { target: "telegram" }
          : kind === "last"
            ? { target: "last" }
            : kind === "direct"
              ? { target: "last", to: "2234567890", accountId: "personal" }
              : { target: "telegram", to: "2234567890", accountId: "work" };
      const markers = ["EXEC_BEFORE_CRON_A", "EXEC_BEFORE_CRON_B"];
      for (const [index, marker] of markers.entries()) {
        enqueueSystemEvent("Exec completed (before-cron-" + index + ", code 0) :: " + marker, {
          sessionKey,
          contextKey: "exec:before-cron-" + index,
          deliveryContext: {
            ...route,
            threadId: 47 + index,
            to: "telegram:-1003774691294:topic:" + (47 + index),
          },
        });
      }
      const reminder = "Reminder: OVERRIDDEN_CRON_DESTINATION";
      enqueueSystemEvent(reminder, {
        sessionKey,
        ...(kind === "keyless" ? {} : { contextKey: "cron:overridden-destination" }),
        deliveryContext: { channel: "telegram", to: "2234567890", accountId: "work" },
      });
      const telegram = vi.fn().mockResolvedValue({ messageId: "delivered" });
      replySpy.mockImplementation(async (ctx) => {
        const marker = markers.find((value) => ctx.Body?.includes(value));
        if (marker) {
          expect(ctx.Body).not.toContain(reminder);
          expect(ctx.Body).not.toContain(markers.find((value) => value !== marker));
          return { text: marker };
        }
        expect(ctx.Body).toContain(reminder);
        expect(ctx.Body).not.toContain(markers[0]);
        expect(ctx.Body).not.toContain(markers[1]);
        return { text: "CRON_NOTIFICATION" };
      });
      const completed = createDeferred<Awaited<ReturnType<typeof runHeartbeatOnce>>>();
      const runner = startHeartbeatRunner({
        cfg,
        runOnce: (opts) => {
          const run = runHeartbeatOnce({
            ...opts,
            cfg,
            deps: { getReplyFromConfig: replySpy, telegram },
          });
          void run.then((result) => {
            if (replySpy.mock.calls.length === 3) {
              completed.resolve(result);
            }
          }, completed.reject);
          return run;
        },
      });
      onTestFinished(() => runner.stop());
      try {
        const initial = {
          source: "cron" as const,
          intent: "immediate" as const,
          reason: "cron:overridden-destination",
          agentId: "main",
          sessionKey,
          heartbeat,
        };
        await expect(
          kind === "direct"
            ? runHeartbeatOnce({
                ...initial,
                cfg,
                deps: { getReplyFromConfig: replySpy, telegram },
              })
            : requestHeartbeatAndWait({ ...initial, coalesceMs: 0 }),
        ).resolves.toMatchObject({ status: "ran" });
        await expect(
          racePromiseWithAbortSignal(completed.promise, AbortSignal.timeout(45_000)),
        ).resolves.toMatchObject({ status: "ran" });
        expect(replySpy).toHaveBeenCalledTimes(3);
        expect(replySpy.mock.calls[2]?.[0]).toMatchObject({
          OriginatingTo: cronTo,
          AccountId: cronAccount,
        });
        expect(telegram.mock.calls).toEqual([
          [
            route.to,
            markers[0],
            expect.objectContaining({ accountId: "work", messageThreadId: 47 }),
          ],
          [
            "telegram:-1003774691294:topic:48",
            markers[1],
            expect.objectContaining({ accountId: "work", messageThreadId: 48 }),
          ],
          [cronTo, "CRON_NOTIFICATION", expect.objectContaining({ accountId: cronAccount })],
        ]);
        expect(peekSystemEvents(sessionKey)).toEqual([]);
      } finally {
        runner.stop();
      }
    });
  },
  90_000,
);

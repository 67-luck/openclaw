import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import { getReplySystemEventContext } from "../auto-reply/reply/system-event-session-key.js";
import type { OpenClawConfig } from "../config/config.js";
import { racePromiseWithAbortSignal } from "./abort-signal.js";
import { runHeartbeatOnce, startHeartbeatRunner } from "./heartbeat-runner.js";
import {
  type HeartbeatReplySpy,
  heartbeatTestConfig,
  mockCallAt,
  seedSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import * as heartbeatWake from "./heartbeat-wake.js";
import { requestHeartbeatAndWait, setHeartbeatWakeHandler } from "./heartbeat-wake.js";
import { enqueueSystemEvent, peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

const sessionKey = "agent:main:telegram:group:-1003774691294";

function formatQueuedEvents(
  cfg: OpenClawConfig,
  ctx: Parameters<HeartbeatReplySpy>[0],
  options: Parameters<HeartbeatReplySpy>[1],
) {
  const event = getReplySystemEventContext(options);
  return drainFormattedSystemEvents({
    cfg,
    agentId: "main",
    sessionKey: event?.sessionKey ?? ctx.SessionKey ?? sessionKey,
    isMainSession: false,
    isNewSession: false,
    events: event?.events ?? [],
    consume: event?.consumeEvents !== false,
  });
}

function withRouteFixture(
  fn: (fixture: {
    cfg: OpenClawConfig;
    storePath: string;
    replySpy: HeartbeatReplySpy;
    sendTelegram: ReturnType<typeof vi.fn>;
    run: (
      opts?: Omit<Parameters<typeof runHeartbeatOnce>[0], "cfg">,
    ) => ReturnType<typeof runHeartbeatOnce>;
  }) => Promise<void>,
) {
  return withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const cfg = heartbeatTestConfig(tmpDir, "last", "telegram", storePath);
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "sid",
      updatedAt: Date.now(),
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: "telegram:-1003774691294:topic:2175",
      lastAccountId: "personal",
      lastThreadId: 2175,
    });
    const sendTelegram = vi
      .fn()
      .mockResolvedValue({ messageId: "delivered", chatId: "-1003774691294" });
    const run = (opts: Omit<Parameters<typeof runHeartbeatOnce>[0], "cfg"> = {}) =>
      runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        ...opts,
        deps: { getReplyFromConfig: replySpy, telegram: sendTelegram, ...opts.deps },
      });
    await fn({ cfg, storePath, replySpy, sendTelegram, run });
  });
}

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
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

it("keeps routed generic events out of an exec turn and automatically drains their route", async ({
  signal,
}) => {
  await withRouteFixture(async ({ cfg, replySpy, sendTelegram, run }) => {
    cfg.agents!.defaults!.heartbeat = {
      ...cfg.agents!.defaults!.heartbeat,
      every: "0m",
    };
    const routeBMarker = "ROUTE_B_PRIVATE_MARKER";
    enqueueSystemEvent("Exec completed (work-report, code 0) :: work report is ready", {
      sessionKey,
      deliveryContext: {
        channel: "telegram",
        to: "telegram:-1003774691294:topic:47",
        accountId: "work",
        threadId: 47,
      },
    });
    enqueueSystemEvent(`Node connected: ${routeBMarker}`, {
      sessionKey,
      deliveryContext: {
        channel: "telegram",
        to: "telegram:-1003774691294:topic:99",
        accountId: "personal",
        threadId: 99,
      },
    });

    const projectedInputs: string[] = [];
    const queuedAtTurns: string[][] = [];
    replySpy.mockImplementation(async (ctx, options) => {
      const formatted = await formatQueuedEvents(cfg, ctx, options);
      projectedInputs.push(`${ctx.Body}\n${formatted ?? ""}`);
      queuedAtTurns.push(peekSystemEvents(sessionKey));
      return {
        text: projectedInputs.length === 1 ? "The work report is ready." : "The node connected.",
      };
    });

    const followup = createDeferred<Awaited<ReturnType<typeof runHeartbeatOnce>>>();
    let runCount = 0;
    const runner = startHeartbeatRunner({
      cfg,
      runOnce: (opts) => {
        const result = run(opts);
        runCount += 1;
        if (runCount === 2) {
          followup.resolve(result);
        }
        return result;
      },
    });
    onTestFinished(() => runner.stop());
    try {
      await requestHeartbeatAndWait({
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        agentId: "main",
        sessionKey,
        coalesceMs: 0,
      });
      await expect(racePromiseWithAbortSignal(followup.promise, signal)).resolves.toMatchObject({
        status: "ran",
      });

      expect(projectedInputs).toHaveLength(2);
      expect(projectedInputs[0]).not.toContain(routeBMarker);
      expect(projectedInputs[1]).toContain(routeBMarker);
      expect(projectedInputs.filter((input) => input.includes(routeBMarker))).toHaveLength(1);
      expect(queuedAtTurns[0]).toContain(`Node connected: ${routeBMarker}`);
      expect(queuedAtTurns[1]).toEqual([`Node connected: ${routeBMarker}`]);
      expect(runCount).toBe(2);
      expect(sendTelegram).toHaveBeenCalledTimes(2);
      expect(mockCallAt(sendTelegram, 0, "work Telegram send")).toMatchObject([
        "telegram:-1003774691294:topic:47",
        "The work report is ready.",
        { messageThreadId: 47, accountId: "work" },
      ]);
      expect(mockCallAt(sendTelegram, 1, "personal Telegram send")).toMatchObject([
        "telegram:-1003774691294:topic:99",
        "The node connected.",
        { messageThreadId: 99, accountId: "personal" },
      ]);
      expect(peekSystemEvents(sessionKey)).toEqual([]);
    } finally {
      runner.stop();
    }
  });
});

it("keeps route-owned generic events out of scheduled and ambient turns", async () => {
  await withRouteFixture(async ({ cfg, replySpy, run }) => {
    const marker = "ROUTE_B_SCHEDULED_MARKER";
    enqueueSystemEvent(`Node connected: ${marker}`, {
      sessionKey,
      deliveryContext: {
        channel: "telegram",
        to: "telegram:-1003774691294:topic:99",
        accountId: "personal",
        threadId: 99,
      },
    });
    const projected: string[] = [];
    replySpy.mockImplementation(async (ctx, options) => {
      projected.push(`${ctx.Body}\n${(await formatQueuedEvents(cfg, ctx, options)) ?? ""}`);
      return { text: "Scheduled maintenance completed." };
    });

    await run({
      source: "cron",
      intent: "task",
      reason: "cron:scheduled-maintenance",
      tasks: [
        {
          jobId: "scheduled-maintenance",
          name: "Scheduled maintenance",
          prompt: "Run the scheduled maintenance check.",
        },
      ],
    });
    await run({ source: "interval", intent: "scheduled", reason: "interval" });

    expect(projected.every((input) => !input.includes(marker))).toBe(true);
    expect(peekSystemEvents(sessionKey)).toEqual([`Node connected: ${marker}`]);
  });
});

it("retains route-owned generic events after a quiet acknowledgement", async () => {
  await withRouteFixture(async ({ replySpy, run }) => {
    const marker = "ROUTE_B_QUIET_MARKER";
    enqueueSystemEvent(`Node connected: ${marker}`, {
      sessionKey,
      deliveryContext: {
        channel: "telegram",
        to: "telegram:-1003774691294:topic:99",
        accountId: "personal",
        threadId: 99,
      },
    });
    replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

    await run({ source: "hook", intent: "immediate", reason: "hook:quiet-route" });

    expect(peekSystemEvents(sessionKey)).toEqual([`Node connected: ${marker}`]);
  });
});

it.each(["generic", "exec"])(
  "does not replay an unconfirmed %s occurrence on another route's wake",
  async (kind) => {
    await withRouteFixture(async ({ cfg, replySpy, sendTelegram, run }) => {
      const marker = "ROUTE_B_RETRY_MARKER";
      const attempted =
        kind === "exec"
          ? `Exec completed (held-command, code 0) :: ${marker}`
          : `Node connected: ${marker}`;
      enqueueSystemEvent(attempted, {
        sessionKey,
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-1003774691294:topic:99",
          accountId: "personal",
          threadId: 99,
        },
      });
      let projected = "";
      replySpy.mockImplementation(async (ctx, options) => {
        projected = `${ctx.Body}\n${(await formatQueuedEvents(cfg, ctx, options)) ?? ""}`;
        return { text: "The node connected." };
      });
      sendTelegram.mockRejectedValueOnce(new Error("delivery unconfirmed"));

      const result = await run({
        source: "hook",
        intent: "immediate",
        reason: "hook:route-retry",
      });

      expect(result.status).not.toBe("ran");
      expect(projected).toContain(marker);
      expect(peekSystemEvents(sessionKey)).toEqual([attempted]);
      enqueueSystemEvent("OTHER_ROUTE_NOTICE", {
        sessionKey,
        contextKey: "notification:other-route",
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-1003774691294:topic:47",
          accountId: "work",
          threadId: 47,
        },
      });
      await run({ source: "notifications-event", intent: "immediate", reason: "wake" });
      expect(projected).toContain("OTHER_ROUTE_NOTICE");
      expect(projected).not.toContain(marker);
      expect(peekSystemEvents(sessionKey)).toEqual([attempted]);
      expect(sendTelegram).toHaveBeenCalledTimes(2);
      expect(mockCallAt(sendTelegram, 1, "other route send")).toMatchObject([
        "telegram:-1003774691294:topic:47",
        "The node connected.",
        { messageThreadId: 47, accountId: "work" },
      ]);
    });
  },
);

it("does not schedule a route-followup that replays an unconfirmed cron group", async () => {
  await withRouteFixture(async ({ replySpy, sendTelegram, run }) => {
    enqueueSystemEvent("Reminder: route A report", {
      sessionKey,
      contextKey: "cron:route-a",
      deliveryContext: {
        channel: "telegram",
        to: "telegram:-1003774691294:topic:47",
        accountId: "work",
        threadId: 47,
      },
    });
    enqueueSystemEvent("ROUTE_B_DEFERRED", {
      sessionKey,
      deliveryContext: {
        channel: "telegram",
        to: "telegram:-1003774691294:topic:99",
        accountId: "personal",
        threadId: 99,
      },
    });
    const wake = vi.spyOn(heartbeatWake, "requestHeartbeat");
    replySpy.mockResolvedValue({ text: "The route A report is ready." });
    sendTelegram.mockRejectedValueOnce(new Error("unconfirmed cron delivery"));

    await run({ source: "cron", intent: "immediate", reason: "cron:route-a" });

    expect(sendTelegram).toHaveBeenCalledOnce();
    expect(wake.mock.calls.filter(([request]) => request.reason === "hook:pending-route")).toEqual(
      [],
    );
    expect(peekSystemEvents(sessionKey)).toEqual(["Reminder: route A report", "ROUTE_B_DEFERRED"]);
  });
});

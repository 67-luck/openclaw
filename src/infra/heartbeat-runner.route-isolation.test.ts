import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import {
  recordReplyOperationAgentTurn,
  resolveReplyOperationRunState,
} from "../auto-reply/reply/reply-operation-run-state.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
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
  setHeartbeatAgentTurnStatus,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import * as heartbeatWake from "./heartbeat-wake.js";
import {
  requestHeartbeat,
  requestHeartbeatAndWait,
  setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";
import {
  enqueueSystemEvent,
  peekSystemEvents,
  peekDeliverableSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

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

it.each([
  ["generic", false, false],
  ["exec", false, false],
  ["generic", true, false],
  ["exec", true, false],
  ["generic", true, true],
  ["exec", true, true],
] as const)(
  "does not replay %s with failedAgent=%s confirmedDelivery=%s on another route's wake",
  async (kind, failedAgent, confirmedDelivery) => {
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
        if (failedAgent && projected.includes(marker)) {
          setHeartbeatAgentTurnStatus(options, "failed");
        }
        return {
          text: "The node connected.",
          ...(failedAgent && projected.includes(marker) ? { isError: true } : {}),
        };
      });
      if (!confirmedDelivery) {
        sendTelegram.mockRejectedValueOnce(new Error("delivery unconfirmed"));
      }

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

it.each(["exec", "generic", "cron", "cron-mixed"] as const)(
  "settles an admitted %s occurrence after background handoff without replay or stranded routes",
  async (kind) => {
    await withRouteFixture(async ({ cfg, replySpy, sendTelegram, run }) => {
      cfg.agents!.defaults!.heartbeat!.every = "0m";
      const marker = "BACKGROUND_OWNED_OCCURRENCE";
      const text =
        kind === "exec"
          ? "Exec completed (background-handoff, code 0) :: " + marker
          : kind === "generic"
            ? "Node connected: " + marker
            : "Reminder: " + marker;
      const routeA = {
        channel: "telegram",
        to: "telegram:-1003774691294:topic:99",
        accountId: "personal",
        threadId: 99,
      };
      const routeB = {
        channel: "telegram",
        to: "telegram:-1003774691294:topic:47",
        accountId: "work",
        threadId: 47,
      };
      enqueueSystemEvent(text, {
        sessionKey,
        contextKey:
          kind === "exec"
            ? "exec:background-handoff"
            : kind === "generic"
              ? "notice:background-handoff"
              : "cron:background-handoff",
        deliveryContext: routeA,
      });
      const mixedGeneric = "GENERIC_ACCEPTED_ALONGSIDE_CRON";
      if (kind === "cron-mixed") {
        enqueueSystemEvent(mixedGeneric, {
          sessionKey,
          contextKey: "notice:background-cron-generic",
          deliveryContext: routeA,
        });
      }
      const retained = kind === "cron" ? [] : [kind === "cron-mixed" ? mixedGeneric : text];
      enqueueSystemEvent("Node connected: DEFERRED_BACKGROUND_ROUTE", {
        sessionKey,
        contextKey: "notice:after-background",
        deliveryContext: routeB,
      });
      const inputs: string[] = [];
      replySpy.mockImplementation(async (ctx, options) => {
        const input =
          String(ctx.Body) + "\n" + ((await formatQueuedEvents(cfg, ctx, options)) ?? "");
        inputs.push(input);
        if (input.includes(marker)) {
          const state = resolveReplyOperationRunState(options);
          if (!state) {
            throw new Error("Missing admitted reply operation");
          }
          const owner = createReplyOperation({
            sessionKey: "heartbeat-background-receipt",
            sessionId: "sid",
            turnKind: "heartbeat",
            resetTriggered: false,
          });
          recordReplyOperationAgentTurn([state], owner, {
            kind: "settled",
            status: "ok",
            result: { asyncWorkStarted: true },
          });
          owner.complete();
          return createHeartbeatToolResponsePayload({
            outcome: "done",
            notify: false,
            summary: "Background work accepted.",
          });
        }
        return {
          text: input.includes("DEFERRED_BACKGROUND_ROUTE")
            ? "DEFERRED_BACKGROUND_ROUTE"
            : "INDEPENDENT_BACKGROUND_ROUTE",
        };
      });
      const followed = createDeferred<Awaited<ReturnType<typeof runHeartbeatOnce>>>();
      const runner = startHeartbeatRunner({
        cfg,
        runOnce: (opts) => {
          const value = run(opts);
          void value.then((result) => {
            if (sendTelegram.mock.calls.length === 1) {
              followed.resolve(result);
            }
          }, followed.reject);
          return value;
        },
      });
      onTestFinished(() => runner.stop());
      try {
        await expect(
          requestHeartbeatAndWait({
            source: kind === "cron" || kind === "cron-mixed" ? "cron" : "hook",
            intent: "immediate",
            reason:
              kind === "cron" || kind === "cron-mixed"
                ? "cron:background-handoff"
                : "hook:background-handoff",
            agentId: "main",
            sessionKey,
            coalesceMs: 0,
          }),
        ).resolves.toMatchObject({ status: "ran" });
        expect(inputs).toHaveLength(1);
        expect(inputs[0]).toContain(marker);
        expect(sendTelegram).not.toHaveBeenCalled();
        expect(peekSystemEvents(sessionKey)).toEqual([
          ...retained,
          "Node connected: DEFERRED_BACKGROUND_ROUTE",
        ]);
        expect(
          peekDeliverableSystemEventEntries(sessionKey).map((event) => event.text),
        ).not.toContain(text);
        await expect(
          racePromiseWithAbortSignal(followed.promise, AbortSignal.timeout(45_000)),
        ).resolves.toMatchObject({ status: "ran" });
        enqueueSystemEvent("INDEPENDENT_BACKGROUND_ROUTE", {
          sessionKey,
          contextKey: "notice:independent-background",
          deliveryContext: routeB,
        });
        await expect(
          requestHeartbeatAndWait({
            source: "notifications-event",
            intent: "immediate",
            reason: "wake",
            agentId: "main",
            sessionKey,
            coalesceMs: 0,
          }),
        ).resolves.toMatchObject({ status: "ran" });
        expect(inputs).toHaveLength(3);
        expect(inputs.filter((input) => input.includes(marker))).toHaveLength(1);
        expect(sendTelegram.mock.calls).toEqual([
          [
            routeB.to,
            "DEFERRED_BACKGROUND_ROUTE",
            expect.objectContaining({ accountId: "work", messageThreadId: 47 }),
          ],
          [
            routeB.to,
            "INDEPENDENT_BACKGROUND_ROUTE",
            expect.objectContaining({ accountId: "work", messageThreadId: 47 }),
          ],
        ]);
        expect(peekSystemEvents(sessionKey)).toEqual(retained);
      } finally {
        runner.stop();
      }
    });
  },
  60_000,
);

it.each(["none", "last"] as const)(
  "does not let a route continuation overwrite a separately queued cron target:%s",
  async (target) => {
    await withRouteFixture(async ({ cfg, replySpy, sendTelegram, run }) => {
      cfg.agents!.defaults!.heartbeat = {
        every: "0m",
        target: "telegram",
        to: "1234567890",
        accountId: "work",
      };
      const routeA = {
        channel: "telegram",
        to: "telegram:-1003774691294:topic:47",
        accountId: "work",
        threadId: 47,
      };
      const routeB = {
        channel: "telegram",
        to: "telegram:-1003774691294:topic:99",
        accountId: "personal",
        threadId: 99,
      };
      const first = "INITIAL_EXEC_ROUTE";
      const late = "INDEPENDENT_SUPPRESSED_CRON";
      enqueueSystemEvent("Exec completed (before-optout, code 0) :: " + first, {
        sessionKey,
        contextKey: "exec:before-optout",
        deliveryContext: routeA,
      });
      enqueueSystemEvent("DEFERRED_GENERIC_ROUTE", {
        sessionKey,
        contextKey: "notice:before-optout",
        deliveryContext: routeB,
      });
      const inputs: string[] = [];
      replySpy.mockImplementation(async (ctx, options) => {
        const input =
          String(ctx.Body) + "\n" + ((await formatQueuedEvents(cfg, ctx, options)) ?? "");
        inputs.push(input);
        if (input.includes(first)) {
          enqueueSystemEvent("Reminder: " + late, {
            sessionKey,
            contextKey: "cron:independent-optout",
            deliveryContext: routeB,
          });
          requestHeartbeat({
            source: "cron",
            intent: "immediate",
            reason: "cron:independent-optout",
            agentId: "main",
            sessionKey,
            heartbeat: { target },
            coalesceMs: 0,
          });
          return { text: first };
        }
        return createHeartbeatToolResponsePayload({
          outcome: "done",
          notify: true,
          summary: "Reminder processed.",
          notificationText: late,
        });
      });
      const followed = createDeferred<Awaited<ReturnType<typeof runHeartbeatOnce>>>();
      let turns = 0;
      const runner = startHeartbeatRunner({
        cfg,
        runOnce: (opts) => {
          const value = run(opts);
          turns += 1;
          if (turns === 2) {
            followed.resolve(value);
          }
          return value;
        },
      });
      onTestFinished(() => runner.stop());
      try {
        await expect(
          requestHeartbeatAndWait({
            source: "exec-event",
            intent: "event",
            reason: "exec-event",
            agentId: "main",
            sessionKey,
            coalesceMs: 0,
          }),
        ).resolves.toMatchObject({ status: "ran" });
        await expect(
          racePromiseWithAbortSignal(followed.promise, AbortSignal.timeout(15_000)),
        ).resolves.toMatchObject({ status: "ran" });
        expect(inputs).toHaveLength(2);
        expect(inputs[1]).toContain(late);
        expect(inputs[1]).not.toContain(first);
        expect(sendTelegram.mock.calls[0]).toMatchObject([
          routeA.to,
          first,
          { accountId: "work", messageThreadId: 47 },
        ]);
        if (target === "none") {
          expect(sendTelegram).toHaveBeenCalledOnce();
        } else {
          expect(sendTelegram).toHaveBeenCalledTimes(2);
          expect(sendTelegram.mock.calls[1]).toMatchObject([
            routeB.to,
            late,
            { accountId: "personal", messageThreadId: 99 },
          ]);
        }
      } finally {
        runner.stop();
      }
    });
  },
);

it.each([
  { mode: "configured", enrolled: true, requested: false },
  { mode: "requested-enrolled", enrolled: true, requested: true },
  { mode: "requested-unenrolled", enrolled: false, requested: true },
] as const)(
  "honors a later configured target:none while an exec route continuation waits ($mode)",
  async ({ enrolled, requested }) => {
    await withRouteFixture(async ({ cfg, replySpy, sendTelegram, run }) => {
      cfg.agents!.defaults!.heartbeat = { every: "0m", target: "last" };
      if (!enrolled) {
        cfg.agents!.list = [
          { id: "main", default: true },
          { id: "other", heartbeat: { every: "0m", target: "none" } },
        ];
      }
      const a = "BEFORE_CONFIGURED_OPTOUT";
      const b = "AFTER_CONFIGURED_OPTOUT";
      const routeA = {
        channel: "telegram",
        to: "telegram:-1003774691294:topic:47",
        accountId: "work",
        threadId: 47,
      };
      enqueueSystemEvent("Exec completed (before-config-optout, code 0) :: " + a, {
        sessionKey,
        contextKey: "exec:config-optout-a",
        deliveryContext: routeA,
      });
      enqueueSystemEvent("Exec completed (after-config-optout, code 0) :: " + b, {
        sessionKey,
        contextKey: "exec:config-optout-b",
        deliveryContext: { ...routeA, to: "telegram:-1003774691294:topic:99", threadId: 99 },
      });
      const inputs: string[] = [];
      replySpy.mockImplementation(async (ctx) => {
        inputs.push(String(ctx.Body));
        return { text: inputs.length === 1 ? a : b };
      });
      const followed = createDeferred<Awaited<ReturnType<typeof runHeartbeatOnce>>>();
      let turns = 0;
      const runner = startHeartbeatRunner({
        cfg,
        runOnce: (opts) => {
          const value = run(opts);
          turns += 1;
          if (turns === 2) {
            followed.resolve(value);
          }
          return value;
        },
      });
      onTestFinished(() => runner.stop());
      try {
        await expect(
          requestHeartbeatAndWait({
            ...(requested ? { heartbeat: { target: "last" as const } } : {}),
            source: "exec-event",
            intent: "event",
            reason: "exec-event",
            agentId: "main",
            sessionKey,
            coalesceMs: 0,
          }),
        ).resolves.toMatchObject({ status: "ran" });
        cfg.agents!.defaults!.heartbeat!.target = "none";
        runner.updateConfig(cfg);
        await expect(
          racePromiseWithAbortSignal(followed.promise, AbortSignal.timeout(45_000)),
        ).resolves.toMatchObject({ status: "ran" });
        expect(inputs).toHaveLength(2);
        expect(inputs[1]).not.toContain(b);
        expect(sendTelegram).toHaveBeenCalledExactlyOnceWith(
          routeA.to,
          a,
          expect.objectContaining({ accountId: "work", messageThreadId: 47 }),
        );
      } finally {
        runner.stop();
      }
    });
  },
  60_000,
);

it.each(["token", "tool"] as const)(
  "settles quiet cron work separately from retained generic work (%s)",
  async (kind) => {
    await withRouteFixture(async ({ cfg, replySpy, sendTelegram, run }) => {
      cfg.agents!.defaults!.heartbeat!.every = "0m";
      const generic = "QUIET_GENERIC_OWNED_OCCURRENCE";
      const cron = "Reminder: QUIET_COMPLETED_CRON";
      const routeA = {
        channel: "telegram",
        to: "telegram:-1003774691294:topic:99",
        accountId: "personal",
        threadId: 99,
      };
      const routeB = {
        channel: "telegram",
        to: "telegram:-1003774691294:topic:47",
        accountId: "work",
        threadId: 47,
      };
      enqueueSystemEvent(generic, {
        sessionKey,
        contextKey: "notice:quiet-generic",
        deliveryContext: routeA,
      });
      enqueueSystemEvent(cron, {
        sessionKey,
        contextKey: "cron:quiet-completed",
        deliveryContext: routeA,
      });
      enqueueSystemEvent("DEFERRED_AFTER_QUIET", {
        sessionKey,
        contextKey: "notice:after-quiet",
        deliveryContext: routeB,
      });
      const inputs: string[] = [];
      replySpy.mockImplementation(async (ctx, options) => {
        const input =
          String(ctx.Body) + "\n" + ((await formatQueuedEvents(cfg, ctx, options)) ?? "");
        inputs.push(input);
        if (input.includes(generic)) {
          return kind === "token"
            ? { text: "HEARTBEAT_OK" }
            : createHeartbeatToolResponsePayload({
                outcome: "done",
                notify: false,
                summary: "Cron work completed quietly.",
              });
        }
        return { text: "DEFERRED_AFTER_QUIET" };
      });
      const followed = createDeferred<Awaited<ReturnType<typeof runHeartbeatOnce>>>();
      let turns = 0;
      const runner = startHeartbeatRunner({
        cfg,
        runOnce: (opts) => {
          const value = run(opts);
          turns += 1;
          if (turns === 2) {
            followed.resolve(value);
          }
          return value;
        },
      });
      onTestFinished(() => runner.stop());
      try {
        await expect(
          requestHeartbeatAndWait({
            source: "cron",
            intent: "immediate",
            reason: "cron:quiet-completed",
            agentId: "main",
            sessionKey,
            coalesceMs: 0,
          }),
        ).resolves.toMatchObject({ status: "ran" });
        expect(inputs[0]).toContain(generic);
        expect(inputs[0]).toContain(cron);
        expect(peekSystemEvents(sessionKey)).toEqual([generic, "DEFERRED_AFTER_QUIET"]);
        await expect(
          racePromiseWithAbortSignal(followed.promise, AbortSignal.timeout(15_000)),
        ).resolves.toMatchObject({ status: "ran" });
        expect(inputs).toHaveLength(2);
        expect(inputs[1]).not.toContain(generic);
        expect(inputs[1]).not.toContain(cron);
        expect(sendTelegram).toHaveBeenCalledExactlyOnceWith(
          routeB.to,
          "DEFERRED_AFTER_QUIET",
          expect.objectContaining({ accountId: "work", messageThreadId: 47 }),
        );
        expect(peekSystemEvents(sessionKey)).toEqual([generic]);
      } finally {
        runner.stop();
      }
    });
  },
);

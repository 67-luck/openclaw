import { afterEach, expect, it } from "vitest";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEvent,
  enqueueSystemEventEntry,
  holdSystemEventDelivery,
  peekDeliverableSystemEventEntries,
  peekSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "./system-events.js";

const sessionKey = "agent:main:telegram:group:-1003774691294";

afterEach(() => resetSystemEventsForTest());

it("filters foreground event projection by the actual delivery route", async () => {
  enqueueSystemEvent("routeless notice", { sessionKey });
  enqueueSystemEvent("route A notice", {
    sessionKey,
    deliveryContext: {
      channel: "telegram",
      to: "telegram:-1003774691294:topic:47",
      accountId: "work",
      threadId: 47,
    },
  });
  enqueueSystemEvent("route B notice", {
    sessionKey,
    deliveryContext: {
      channel: "telegram",
      to: "telegram:-1003774691294:topic:99",
      accountId: "personal",
      threadId: 99,
    },
  });

  const projected = await drainFormattedSystemEvents({
    cfg: {} as OpenClawConfig,
    agentId: "main",
    sessionKey,
    isMainSession: false,
    isNewSession: false,
    deliveryContext: {
      channel: "telegram",
      to: "telegram:-1003774691294:topic:47",
      accountId: "work",
      threadId: 47,
    },
  });

  expect(projected).toContain("routeless notice");
  expect(projected).toContain("route A notice");
  expect(projected).not.toContain("route B notice");
  expect(peekSystemEvents(sessionKey)).toEqual(["route B notice"]);
});

it("holds only an attempted occurrence and preserves explicit acknowledgment and replacement", () => {
  const attempted = enqueueSystemEventEntry("completion", { sessionKey, contextKey: "task:held" });
  if (!attempted) {
    throw new Error("attempted occurrence missing");
  }
  holdSystemEventDelivery(sessionKey, [attempted]);
  enqueueSystemEvent("other route work", { sessionKey });
  expect(peekDeliverableSystemEventEntries(sessionKey).map((event) => event.text)).toEqual([
    "other route work",
  ]);
  expect(peekSystemEventEntries(sessionKey)).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: attempted.id, deliveryHeld: true })]),
  );
  expect(consumeSelectedSystemEventEntries(sessionKey, [attempted])).toHaveLength(1);
  const replacement = enqueueSystemEventEntry("replacement", {
    sessionKey,
    contextKey: "task:held",
  });
  holdSystemEventDelivery(sessionKey, [attempted]);
  expect(peekDeliverableSystemEventEntries(sessionKey)).toContainEqual(replacement);
  expect(peekSystemEvents(sessionKey)).toEqual(["other route work", "replacement"]);
});

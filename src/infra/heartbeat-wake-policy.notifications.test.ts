import { expect, it } from "vitest";
import { resolveHeartbeatWakePayloadFlags } from "./heartbeat-wake-policy.js";

it("classifies notification event wakes as queue-bearing", () => {
  expect(
    resolveHeartbeatWakePayloadFlags({
      source: "notifications-event",
      reason: "wake",
    }),
  ).toMatchObject({ isWakePayload: true });
});

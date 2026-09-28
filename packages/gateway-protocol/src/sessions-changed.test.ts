import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { isSessionsChangedBundleEvent } from "./frame-guards.js";
import { SessionsChangedBundleEventSchema } from "./schema/sessions-changed.js";

describe("session change receipt bundle protocol", () => {
  it.each([
    [{ sessionKey: "agent:main:work", receipts: [{ payload: { activeRunIds: null } }] }, true],
    [{ sessionKey: "global", agentId: "main", receipts: [{ payload: null }] }, true],
    [{ sessionKey: "global", receipts: Array.from({ length: 32 }, () => ({ payload: {} })) }, true],
    [
      { sessionKey: "global", receipts: Array.from({ length: 33 }, () => ({ payload: {} })) },
      false,
    ],
    [{ sessionKey: "global", receipts: [] }, false],
    [{ sessionKey: "", receipts: [{ payload: {} }] }, false],
    [{ sessionKey: "global", agentId: "", receipts: [{ payload: {} }] }, false],
    [{ sessionKey: "global", receipts: [{}] }, false],
    [{ sessionKey: "global", receipts: [{ payload: {}, stateVersion: { health: 1 } }] }, false],
    [
      {
        sessionKey: "global",
        receipts: [{ payload: {}, stateVersion: { health: 1, presence: 0 } }],
      },
      true,
    ],
  ])("validates ordered receipt boundaries: %j", (payload, valid) => {
    expect(Value.Check(SessionsChangedBundleEventSchema, payload)).toBe(valid);
    expect(isSessionsChangedBundleEvent(payload)).toBe(valid);
  });
});

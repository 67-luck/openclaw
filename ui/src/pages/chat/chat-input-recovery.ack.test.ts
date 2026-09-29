/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadSettings } from "../../app/settings.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { requestCalls } from "./chat-host.test-support.ts";
import { recoveryFixture, savedInput } from "./chat-input-recovery.test-support.ts";

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { name: "missing ACK", ack: undefined, retained: true },
  { name: "missing status", ack: {}, retained: true },
  { name: "unknown status", ack: { status: "future-status" }, retained: true },
  { name: "malformed ACK", ack: "started", retained: true },
  { name: "in flight without receipt", ack: { status: "in_flight" }, retained: true },
  ...[0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1].map((messageSeq) => ({
    name: "invalid receipt " + messageSeq,
    ack: { status: "in_flight", messageSeq },
    retained: true,
  })),
  { name: "explicit started", ack: { status: "started" }, retained: false },
  { name: "explicit ok", ack: { status: "ok" }, retained: false },
  { name: "committed in flight", ack: { status: "in_flight", messageSeq: 1 }, retained: false },
  { name: "error", ack: { status: "error" }, retained: true },
  { name: "timeout", ack: { status: "timeout" }, retained: true },
  { name: "restart", ack: { status: "error", stopReason: "restart" }, retained: true },
])(
  "retires cross-tab recovery only with a qualified current ACK: $name",
  async ({ ack, retained }) => {
    const entered = createDeferred();
    const receipt = createDeferred<unknown>();
    const f = recoveryFixture({
      "chat.send": () => {
        entered.resolve();
        return receipt.promise;
      },
    });
    const sending = f.send();
    await entered.promise;
    expect(f.view()?.items ?? []).toEqual([]);
    await f.send();
    // A fresh tab does not inherit sessionStorage custody or the per-client guard.
    vi.stubGlobal("sessionStorage", createStorageMock());
    expect(recoveryFixture().view()?.items).toHaveLength(1);
    receipt.resolve(ack);
    await sending;
    expect(requestCalls(f.host.request, "chat.send")).toHaveLength(1);
    expect(f.host.chatMessage).toBe("Keep my draft");
    expect(recoveryFixture().view()?.items.length ?? 0).toBe(retained ? 1 : 0);
    expect(Boolean(loadSettings("ws://recovery.test").chatInputRecoveryDismissed?.length)).toBe(
      !retained,
    );
  },
);

it("shares duplicate admission guards between same-client panes", async () => {
  const read = createDeferred<unknown>();
  const first = recoveryFixture({ "chat.message.get": () => read.promise });
  const second = recoveryFixture();
  second.host.client = first.host.client;
  second.publish([savedInput]);
  const sending = first.send();
  expect(second.view()?.actions?.busyIds.has(savedInput.id)).toBe(true);
  await second.send();
  read.resolve({ ok: false });
  await sending;
  expect(requestCalls(first.host.request, "chat.message.get")).toHaveLength(1);
  expect(requestCalls(second.host.request, "chat.message.get")).toHaveLength(0);
  expect(first.view()?.actions?.busyIds.size).toBe(0);
});

it("keeps fresh Send authority across an unchanged accepted-source projection refresh", async () => {
  const read = createDeferred<unknown>();
  const f = recoveryFixture({ "chat.message.get": () => read.promise });
  const pending = f.send();
  f.publish([structuredClone(savedInput)]);
  read.resolve({
    ok: true,
    message: {
      role: "user",
      content: "Fresh complete payload",
      __openclaw: { id: "pending:saved" },
    },
  });
  await pending;
  expect(requestCalls(f.host.request, "chat.send")).toHaveLength(1);
  expect(loadSettings("ws://recovery.test").chatInputRecoveryDismissed).toHaveLength(1);
});

it("persists a qualified ACK across source re-projection and cosmetic profile refresh", async () => {
  const entered = createDeferred();
  const receipt = createDeferred<unknown>();
  const f = recoveryFixture({
    "chat.send": () => {
      entered.resolve();
      return receipt.promise;
    },
  });
  const pending = f.send();
  await entered.promise;
  f.host.selfUser = {
    ...f.host.selfUser!,
    name: "Updated display name",
    avatarUrl: "https://example.test/avatar.png",
  };
  f.publish([structuredClone(savedInput)]);
  receipt.resolve({ status: "started" });
  await pending;
  expect(loadSettings("ws://recovery.test").chatInputRecoveryDismissed).toHaveLength(1);
});

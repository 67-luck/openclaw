/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import { loadSettings, saveSettings } from "../../app/settings.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { findChatSendPayload, requestCalls, requireRecord } from "./chat-host.test-support.ts";
import { fullInput, recoveryFixture, savedInput } from "./chat-input-recovery.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { getChatPendingInputs } from "./chat-pending-inputs.ts";
import { admitQueuedMessageForSession, removeQueuedMessage } from "./chat-queue.ts";
import { flushChatQueueForEvent, retryQueuedChatMessage } from "./chat-send-actions.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["idle", "queue", "steer", "interrupt", "gateway default"] as const)(
  "uses normal %s policy, current user, and preserves the composer",
  async (mode) => {
    const f = recoveryFixture();
    if (mode !== "idle") {
      f.host.chatRunId = "busy-run";
      f.host.chatStream = "Working";
    }
    if (mode !== "idle" && mode !== "gateway default") {
      f.host.chatFollowUpMode = mode;
    }
    const { chatAttachments, chatReplyTarget } = f.host;
    const source = getChatPendingInputs(f.host)?.page;
    await f.send();
    expect(f.host.chatQueue).toHaveLength(1);
    expect(f.host.chatQueue[0]).toMatchObject({
      text: fullInput.message.content,
      sender: { id: "viewer" },
    });
    expect(f.host.chatQueue[0]!.sendRunId).not.toBe(savedInput.runId);
    expect(f.host.chatQueue[0]!.attachments?.length ?? 0).toBe(0);
    expect(f.host.chatQueue[0]!.replyToId).toBeUndefined();
    expect(f.host.chatMessage).toBe("Keep my draft");
    expect(f.host.chatAttachments).toBe(chatAttachments);
    expect(f.host.chatReplyTarget).toBe(chatReplyTarget);
    expect(getChatPendingInputs(f.host)?.page).toBe(source);
    expect(requestCalls(f.host.request, "chat.abort")).toEqual([]);
    if (mode === "queue") {
      expect(requestCalls(f.host.request, "chat.send")).toEqual([]);
      expect(f.host.chatQueue[0]!.sendState).toBe("waiting-idle");
    } else {
      const wire = findChatSendPayload(f.host);
      expect(wire.message).toBe(fullInput.message.content);
      expect(wire.queueMode).toBe(mode === "steer" || mode === "interrupt" ? mode : undefined);
      expect(wire.replyToId).toBeUndefined();
      expect(wire.mentions).toBeUndefined();
      expect(wire.attachments).toBeUndefined();
    }
  },
);

it("keeps FIFO and leaves cross-tab recovery available after a later queue drain", async () => {
  const f = recoveryFixture({
    "chat.history": {
      sessionId: "recovery-physical",
      sessionInfo: {
        key: "agent:main:recovery",
        sessionId: "recovery-physical",
        status: "done",
        hasActiveRun: false,
      },
      messages: [],
      pendingInputs: { items: [savedInput], total: 1 },
    },
    "chat.send": { status: "started", messageSeq: 1 },
  });
  f.host.chatRunId = "busy-run";
  f.host.chatStream = "Working";
  f.host.chatFollowUpMode = "queue";
  for (const [id, createdAt] of [
    ["first", 1],
    ["second", 2],
  ] as const) {
    expect(
      admitQueuedMessageForSession(f.host, captureChatOutboxAdmission(f.host, f.host.sessionKey), {
        id,
        text: id,
        createdAt,
        sessionKey: f.host.sessionKey,
        sendState: "waiting-idle",
      }),
    ).toBe(true);
  }
  await f.send();
  expect(f.host.chatQueue.map((row) => row.text)).toEqual([
    "first",
    "second",
    fullInput.message.content,
  ]);
  expect(requestCalls(f.host.request, "chat.send")).toEqual([]);
  f.host.chatRunId = null;
  f.host.chatStream = null;
  // Drain real queued sends one turn at a time. Only initial delivery carries the ACK callback.
  for (let i = 0; i < 3; i++) {
    await flushChatQueueForEvent(f.host);
    f.host.chatRunId = null;
    f.host.chatStream = null;
  }
  expect(
    requestCalls(f.host.request, "chat.send").map(
      ([, params]) => requireRecord(params, "chat.send").message,
    ),
  ).toEqual(["first", "second", fullInput.message.content]);
  expect(f.host.chatQueue).toEqual([]);
  expect(loadSettings("ws://recovery.test").chatInputRecoveryDismissed).toBeUndefined();
  vi.stubGlobal("sessionStorage", createStorageMock());
  expect(recoveryFixture().view()?.items).toHaveLength(1);
});

it.each(["held", "failed"] as const)(
  "keeps native %s Retry ownership local across rotation/removal",
  async (sendState) => {
    const f = recoveryFixture({
      "chat.history": {
        sessionId: "recovery-physical",
        sessionInfo: {
          key: "agent:main:recovery",
          sessionId: "recovery-physical",
          status: "done",
          hasActiveRun: false,
        },
        messages: [],
        pendingInputs: { items: [savedInput], total: 1 },
      },
      "chat.send": { status: "started", messageSeq: 1 },
    });
    expect(
      admitQueuedMessageForSession(f.host, captureChatOutboxAdmission(f.host, f.host.sessionKey), {
        id: "native",
        text: "Native retained prompt",
        createdAt: 1,
        sessionKey: f.host.sessionKey,
        sessionId: f.host.currentSessionId!,
        sendState,
        sendRunId: savedInput.runId,
      }),
    ).toBe(true);
    expect(f.view()?.items ?? []).toEqual([]);
    await f.send();
    expect(requestCalls(f.host.request, "chat.message.get")).toEqual([]);
    await retryQueuedChatMessage(f.host, "native");
    expect(findChatSendPayload(f.host).message).toBe("Native retained prompt");
    if (sendState === "failed") {
      expect(findChatSendPayload(f.host).idempotencyKey).not.toBe(savedInput.runId);
    }
    removeQueuedMessage(f.host, "native");
    expect(f.view()?.items ?? []).toEqual([]);
    expect(loadSettings("ws://recovery.test").chatInputRecoveryDismissed).toBeUndefined();
    vi.stubGlobal("sessionStorage", createStorageMock());
    expect(recoveryFixture().view()?.items).toHaveLength(1);
    f.host.currentSessionId = "other-physical";
    f.publish([savedInput]);
    expect(f.view()?.items).toHaveLength(1);
  },
);

it.each(["logical", "physical"] as const)(
  "does not carry native presentation suppression across a %s context change",
  (change) => {
    const f = recoveryFixture();
    expect(
      admitQueuedMessageForSession(f.host, captureChatOutboxAdmission(f.host, f.host.sessionKey), {
        id: "native",
        text: "Original context",
        createdAt: 1,
        sessionKey: f.host.sessionKey,
        sessionId: f.host.currentSessionId!,
        sendRunId: savedInput.runId,
        sendState: "held",
      }),
    ).toBe(true);
    expect(f.view()?.items ?? []).toEqual([]);
    // Use the real scoped queue producer instead of injecting another session's row.
    if (change === "logical") {
      f.host.sessionKey = "agent:main:other";
    }
    f.host.currentSessionId = "other-physical";
    chatOutboxOwner(f.host).syncHost(f.host);
    const newInput = {
      ...savedInput,
      id: "new-physical-input",
      message: {
        role: "user",
        content: "New physical conversation input",
        __openclaw: { id: "pending:new-physical-input" },
      },
    };
    f.publish([newInput]);
    expect(f.host.chatQueue).toHaveLength(change === "logical" ? 0 : 1);
    expect(f.view()?.items.map((input) => input.id)).toEqual([newInput.id]);
  },
);

it.each(["discard", "send"] as const)(
  "incognito %s writes no persistent recovery keys",
  async (action) => {
    const f = recoveryFixture();
    f.host.selectedChatSessionIncognito = true;
    const writes = vi.spyOn(localStorage, "setItem");
    if (action === "send") {
      await f.send();
    } else {
      f.view()!.actions!.onDiscard(savedInput);
    }
    expect(f.view()?.items ?? []).toEqual([]);
    expect(writes).not.toHaveBeenCalled();
    expect(loadSettings("ws://recovery.test").chatInputRecoveryDismissed).toBeUndefined();
    expect(recoveryFixture().view()?.items).toHaveLength(1);
  },
);

it.each(["quota", "denied"])(
  "keeps a local discard after %s without render-time write retries",
  (failure) => {
    const f = recoveryFixture();
    const before = structuredClone(listStoredChatOutboxes(f.host));
    const writes = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException(failure, failure === "quota" ? "QuotaExceededError" : "SecurityError");
    });
    f.view()!.actions!.onDiscard(savedInput);
    const count = writes.mock.calls.length;
    for (let i = 0; i < 3; i++) {
      expect(f.view()?.items).toEqual([]);
    }
    expect(writes).toHaveBeenCalledTimes(count);
    expect(f.view()?.error).toBeTruthy();
    expect(listStoredChatOutboxes(f.host)).toEqual(before);
    expect(f.host.request).not.toHaveBeenCalled();
    writes.mockRestore();
    saveSettings({ ...loadSettings("ws://recovery.test"), chatInputRecoveryDismissed: undefined });
  },
);

it("discard merges current preferences and survives a fresh pane without deleting Gateway data", () => {
  const f = recoveryFixture();
  saveSettings({
    ...loadSettings("ws://recovery.test"),
    themeMode: "light",
    chatFollowUpMode: "queue",
  });
  const source = getChatPendingInputs(f.host)?.page;
  f.view()!.actions!.onDiscard(savedInput);
  expect(loadSettings("ws://recovery.test")).toMatchObject({
    themeMode: "light",
    chatFollowUpMode: "queue",
  });
  expect(getChatPendingInputs(f.host)?.page).toBe(source);
  expect(f.host.request).not.toHaveBeenCalled();
  expect(recoveryFixture().view()).toBeUndefined();
});

it.each(["transport", "terminal"])(
  "keeps a volatile %s failure recoverable in a fresh tab",
  async (failure) => {
    const f = recoveryFixture({
      "chat.send": () => {
        if (failure === "terminal") {
          return { status: "error" };
        }
        throw new GatewayRequestError({ code: "INVALID_REQUEST", message: "Rejected" });
      },
    });
    vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("Unavailable");
    });
    await f.send();
    await f.send();
    expect(requestCalls(f.host.request, "chat.send")).toHaveLength(1);
    expect(f.view()?.items ?? []).toEqual([]);
    vi.stubGlobal("sessionStorage", createStorageMock());
    expect(recoveryFixture().view()?.items).toHaveLength(1);
  },
);

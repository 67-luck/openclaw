/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadSettings } from "../../app/settings.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { findChatSendPayload, requestCalls } from "./chat-host.test-support.ts";
import { fullInput, recoveryFixture, savedInput } from "./chat-input-recovery.test-support.ts";
import { createSidebarFullMessageLoader } from "./chat-pane-sidebar-layout.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
type Fixture = ReturnType<typeof recoveryFixture>;
const changes: [string, (f: Fixture) => void][] = [
  [
    "session",
    (f) => {
      f.host.sessionKey = "agent:main:other";
    },
  ],
  [
    "physical session",
    (f) => {
      f.host.currentSessionId = "other";
    },
  ],
  [
    "agent",
    (f) => {
      f.host.assistantAgentId = "other";
      f.host.sessionKey = "global";
    },
  ],
  [
    "client",
    (f) => {
      f.host.client = createTestGatewayClient(f.host.request);
    },
  ],
  [
    "connection epoch",
    (f) => {
      f.host.connectionEpoch++;
    },
  ],
  [
    "disconnect",
    (f) => {
      f.host.connected = false;
    },
  ],
  [
    "viewer",
    (f) => {
      f.host.selfUser = { id: "other" };
    },
  ],
  [
    "Gateway query",
    (f) => {
      f.host.settings.gatewayUrl = "ws://recovery.test?account=other";
    },
  ],
  [
    "incognito",
    (f) => {
      f.host.selectedChatSessionIncognito = true;
    },
  ],
  [
    "recovery admission",
    (f) => {
      Object.defineProperty(f.host.client, "recoveryScopeReady", {
        configurable: true,
        value: false,
      });
    },
  ],
  [
    "credential owner",
    (f) => {
      Object.defineProperty(f.host.client, "recoveryScope", { configurable: true, value: "other" });
    },
  ],
  [
    "pane lifetime",
    (f) => {
      f.abort.abort();
    },
  ],
  [
    "composer owner",
    (f) => {
      f.host.canRestoreComposer = () => false;
    },
  ],
  [
    "source",
    (f) => {
      f.publish([
        {
          ...savedInput,
          id: "replacement-source",
          message: { role: "user", content: "New source" },
        },
      ]);
    },
  ],
  [
    "source run",
    (f) => {
      f.publish([{ ...savedInput, runId: "other" }]);
    },
  ],
  [
    "live custody",
    (f) => {
      f.publish([{ ...savedInput, state: "queued", queued: true }]);
    },
  ],
  [
    "permission",
    (f) => {
      f.props.canSend = false;
      f.view();
    },
  ],
];
it.each(changes)("fences %s before the read and after its completion", async (_name, change) => {
  for (const phase of ["before", "during"]) {
    const read = createDeferred<unknown>();
    const f = recoveryFixture({ "chat.message.get": () => read.promise });
    const actions = f.view()!.actions!;
    if (phase === "before") {
      change(f);
    }
    const pending = actions.onSend(savedInput);
    if (phase === "during") {
      change(f);
    }
    read.resolve(fullInput);
    await pending;
    expect(requestCalls(f.host.request, "chat.message.get")).toHaveLength(
      phase === "before" ? 0 : 1,
    );
    expect(requestCalls(f.host.request, "chat.send")).toEqual([]);
    expect(f.host.chatQueue).toEqual([]);
    expect(loadSettings("ws://recovery.test").chatInputRecoveryDismissed).toBeUndefined();
  }
});
it.each(changes)(
  "does not persist retirement after %s changes while ACK is pending",
  async (_name, change) => {
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
    change(f);
    receipt.resolve({ status: "started" });
    await pending;
    expect(requestCalls(f.host.request, "chat.send")).toHaveLength(1);
    expect(loadSettings("ws://recovery.test").chatInputRecoveryDismissed).toBeUndefined();
  },
);

it.each(["held", "failed", "sending"] as const)(
  "does not race a native %s owner appearing during the full read",
  async (sendState) => {
    const read = createDeferred<unknown>();
    const f = recoveryFixture({ "chat.message.get": () => read.promise });
    const pending = f.send();
    f.host.chatQueue = [
      {
        id: "native",
        text: "Native payload",
        createdAt: 1,
        sessionKey: f.host.sessionKey,
        sessionId: f.host.currentSessionId!,
        sendRunId: savedInput.runId,
        sendState,
      },
    ];
    read.resolve(fullInput);
    await pending;
    expect(requestCalls(f.host.request, "chat.send")).toEqual([]);
    expect(f.host.chatQueue.map((item) => item.id)).toEqual(["native"]);
    expect(loadSettings("ws://recovery.test").chatInputRecoveryDismissed).toBeUndefined();
  },
);

it.each(["preview", "full"])(
  "rejects system, forwarded, assistant, unknown and malformed %s provenance at the real action",
  async (phase) => {
    const sources = [
      { role: "assistant" },
      { role: "system" },
      ...["internal_system", "inter_session", "unknown"].map((kind) => ({
        role: "user",
        provenance: { kind },
      })),
      { role: "user", provenance: "external_user" },
    ];
    for (const source of sources) {
      const message = { ...fullInput.message, ...source };
      const f = recoveryFixture({
        "chat.message.get": { ok: true, message: phase === "full" ? message : fullInput.message },
      });
      const input = phase === "preview" ? { ...savedInput, message } : savedInput;
      f.publish([input]);
      await f.view()!.actions!.onSend(input);
      expect(requestCalls(f.host.request, "chat.message.get")).toHaveLength(
        phase === "preview" ? 0 : 1,
      );
      expect(requestCalls(f.host.request, "chat.send")).toEqual([]);
      expect(f.view()?.items).toHaveLength(1);
    }
  },
);
it.each(["media", "attachments", "replyToId", "mentions", "workContext"])(
  "rejects preview %s metadata even if the full display omits it",
  async (key) => {
    const f = recoveryFixture();
    const input = { ...savedInput, message: { ...fullInput.message, [key]: {} } };
    f.publish([input]);
    await f.view()!.actions!.onSend(input);
    expect(f.host.request).not.toHaveBeenCalled();
    expect(f.view()?.items).toHaveLength(1);
  },
);

it("refreshes a capped external-user preview instead of sending the cached inspection", async () => {
  let reads = 0;
  const f = recoveryFixture({
    "chat.message.get": () => ({
      ...fullInput,
      message: {
        ...fullInput.message,
        content: ++reads === 1 ? "Inspection only" : fullInput.message.content,
        provenance: { kind: "external_user" },
      },
    }),
  });
  f.props.loadFullAssistantMessage = createSidebarFullMessageLoader(f.host, false);
  const input = {
    ...savedInput,
    message: {
      role: "user",
      content: "Capped preview",
      provenance: { kind: "external_user" },
      __openclaw: { id: "pending:saved", truncated: true },
    },
  };
  f.publish([input]);
  await f.view()!.onToggle(input, true);
  expect(f.view()?.inspections.get(input.id)?.state?.status).toBe("loaded");
  await f.view()!.actions!.onSend(input);
  expect(findChatSendPayload(f.host).message).toBe(fullInput.message.content);
  expect(requestCalls(f.host.request, "chat.message.get")).toHaveLength(2);
  expect(requestCalls(f.host.request, "chat.send")).toHaveLength(1);
});

it.each([
  { ok: false },
  { ok: true, message: { ...fullInput.message, __openclaw: { id: "pending:other" } } },
  {
    ok: true,
    message: { ...fullInput.message, __openclaw: { id: "pending:saved", reason: "display-cap" } },
  },
  { ok: true, message: { ...fullInput.message, workContext: { workspace: "/old" } } },
  { ok: true, message: { ...fullInput.message, content: "/stop" } },
  { ok: true, message: { ...fullInput.message, content: [{ type: "image", omitted: true }] } },
])("rejects unusable refreshed payload at the real action: %j", async (result) => {
  const f = recoveryFixture({ "chat.message.get": result });
  await f.send();
  expect(requestCalls(f.host.request, "chat.send")).toEqual([]);
  expect(f.view()?.items).toHaveLength(1);
  expect(f.view()?.error).toBeTruthy();
});

it.each(["id", "run"] as const)(
  "live custody by %s blocks Send before/during reads while a stale saved page remains",
  async (correlation) => {
    for (const waiting of [false, true]) {
      for (const phase of ["before", "during"]) {
        const read = createDeferred<unknown>();
        const f = recoveryFixture({ "chat.message.get": () => read.promise });
        const actions = f.view()!.actions!;
        const active = {
          ...savedInput,
          id: correlation === "id" ? savedInput.id : "active-copy",
          state: "queued",
          ...(waiting ? { queued: true as const } : {}),
        };
        const publish = () =>
          applyChatPendingInputs(f.host, {
            items: [savedInput],
            total: 1,
            queue: { items: [active] },
          });
        if (phase === "before") {
          publish();
        }
        const pending = actions.onSend(savedInput);
        if (phase === "during") {
          publish();
        }
        expect(f.view()?.items ?? []).toEqual([]);
        read.resolve(fullInput);
        await pending;
        expect(requestCalls(f.host.request, "chat.message.get")).toHaveLength(
          phase === "before" ? 0 : 1,
        );
        expect(requestCalls(f.host.request, "chat.send")).toEqual([]);
        expect(f.host.chatQueue).toEqual([]);
      }
    }
  },
);

it.each([
  { provenance: { kind: "inter_session" } },
  { attachments: [{}] },
  { __openclaw: { workContext: { workspace: "old" } } },
])("revalidates current preview eligibility after the full read: %j", async (patch) => {
  const read = createDeferred<unknown>();
  const f = recoveryFixture({ "chat.message.get": () => read.promise });
  const pending = f.send();
  f.publish([{ ...savedInput, message: { ...fullInput.message, ...patch } }]);
  read.resolve(fullInput);
  await pending;
  expect(requestCalls(f.host.request, "chat.send")).toEqual([]);
  expect(f.view()?.items).toHaveLength(1);
});

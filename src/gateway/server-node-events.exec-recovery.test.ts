import "./server-node-events.test-support.js";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ChannelMessagingAdapter } from "../channels/plugins/types.core.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import type { NodeEvent } from "./server-node-events-types.js";
import { handleNodeEvent } from "./server-node-events.js";

const {
  buildSessionLookup,
  runtimeMocks,
  buildExecRecoveryNodeEventContext: buildCtx,
} = await import("./server-node-events.test-support.js");
const { resolveSessionConversation, resolveSessionTarget } = await loadBundledPluginFacade<{
  resolveSessionConversation: NonNullable<ChannelMessagingAdapter["resolveSessionConversation"]>;
  resolveSessionTarget: NonNullable<ChannelMessagingAdapter["resolveSessionTarget"]>;
}>({ pluginId: "telegram", artifactBasename: "session-key-api.ts" });
const enqueueSystemEventMock = runtimeMocks.enqueueSystemEvent;
const requestHeartbeatMock = runtimeMocks.requestHeartbeat;
const loadSessionEntryMock = runtimeMocks.loadSessionEntry;

function nodeEvent(event: string, payload: unknown): NodeEvent {
  return { event, payloadJSON: JSON.stringify(payload) };
}

const execEventHeartbeatOptions = (sessionKey: string) => ({
  source: "exec-event",
  intent: "event",
  reason: "exec-event",
  coalesceMs: 0,
  sessionKey,
});

describe("result-first node exec completion", () => {
  beforeEach(() => {
    const snapshot = captureActivePluginRegistrySnapshot();
    onTestFinished(() => restoreActivePluginRegistrySnapshot(snapshot));
    // Loaded plugins own their grammar. The shared default stub intentionally omits
    // it; install the real lightweight public grammar, not a competing test parser.
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram" }),
            messaging: { resolveSessionConversation, resolveSessionTarget },
          },
        },
      ]),
    );
    enqueueSystemEventMock.mockReset().mockReturnValue(true);
    requestHeartbeatMock.mockClear();
    loadSessionEntryMock
      .mockReset()
      .mockImplementation((sessionKey: string) => buildSessionLookup(sessionKey));
  });

  it("recovers in the originating topic when the invoke reply is missing", async () => {
    const sessionKey = "agent:main:telegram:group:-100155462274:topic:42";
    const runId = "run-result-first-recovery";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo: "-100155462274",
        lastAccountId: "work",
        lastThreadId: 42,
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false, turnSourceAccountId: "work" })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId,
        exitCode: 0,
        output: "recovered output",
        suppressNotifyOnExit: true,
        invokeResultSentFirst: true,
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).toHaveBeenCalledExactlyOnceWith(
      `Exec finished (node=node-1 id=${runId}, code 0)\nrecovered output`,
      {
        sessionKey,
        contextKey: `exec:${runId}`,
        deliveryContext: {
          channel: "telegram",
          to: "-100155462274",
          accountId: "work",
          threadId: 42,
        },
      },
    );
    expect(requestHeartbeatMock).toHaveBeenCalledExactlyOnceWith(
      execEventHeartbeatOptions(sessionKey),
    );
  });

  it.each([
    ["tg:-100155462274:topic:42", false],
    ["tg:-100155462274:42", false],
    ["telegram:group:-100155462274:topic:42", false],
    ["tg:-100155462274:topic:42", true],
    ["tg:-100155462274:42", true],
    ["telegram:group:-100155462274:topic:42", true],
  ] as const)("keeps supported target %s for result-first=%s", async (to, recovery) => {
    const sessionKey = "agent:main:telegram:group:-100155462274:topic:42";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo: to,
        lastAccountId: "work",
        lastThreadId: 42,
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false, turnSourceAccountId: "work" })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId: `alias-${to}-${recovery}`,
        exitCode: 0,
        output: "alias recovery output",
        ...(recovery ? { suppressNotifyOnExit: true, invokeResultSentFirst: true } : {}),
      }),
      { connId: "conn-1" },
    );
    expect(enqueueSystemEventMock).toHaveBeenCalledOnce();
    expect(enqueueSystemEventMock.mock.calls[0]?.[1]).toMatchObject({
      sessionKey,
      deliveryContext: {
        channel: "telegram",
        to: "-100155462274:topic:42",
        accountId: "work",
        threadId: 42,
      },
    });
    expect(requestHeartbeatMock).toHaveBeenCalledExactlyOnceWith(
      execEventHeartbeatOptions(sessionKey),
    );
  });

  it.each([
    ["missing hook", false],
    ["missing hook", true],
    ["empty serializer", false],
    ["empty serializer", true],
  ] as const)(
    "withholds a verified route when canonical serialization fails (%s, recovery=%s)",
    async (failure, recovery) => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: "telegram" }),
              messaging: {
                resolveSessionConversation,
                ...(failure === "empty serializer"
                  ? { resolveSessionTarget: () => undefined }
                  : {}),
              },
            },
          },
        ]),
      );
      const sessionKey = "agent:main:telegram:work:direct:123456789:thread:42";
      loadSessionEntryMock.mockReturnValue(
        buildSessionLookup(sessionKey, {
          lastChannel: "telegram",
          lastTo: "123456789:topic:42",
          lastThreadId: 42,
          lastAccountId: "work",
        }),
      );
      const logWarn = vi.fn();
      await handleNodeEvent(
        buildCtx(() => ({ invokeResultReceived: false, turnSourceAccountId: "work" }), logWarn),
        "node-1",
        nodeEvent("exec.finished", {
          sessionKey,
          runId: `route-capture-unavailable-${failure}-${recovery}`,
          exitCode: 0,
          output: "private captured output",
          ...(recovery ? { suppressNotifyOnExit: true, invokeResultSentFirst: true } : {}),
        }),
        { connId: "conn-1" },
      );
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
      expect(requestHeartbeatMock).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledExactlyOnceWith(
        "node exec completion withheld: Telegram route normalization is unavailable; check the active channel plugin",
      );
    },
  );

  it.each(["missing hook", "empty serializer"])(
    "retains ordinary legacy routing without captured identity (%s)",
    async (failure) => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: "telegram" }),
              messaging: {
                resolveSessionConversation,
                ...(failure === "empty serializer"
                  ? { resolveSessionTarget: () => undefined }
                  : {}),
              },
            },
          },
        ]),
      );
      const sessionKey = "agent:main:telegram:group:-100155462274:topic:42";
      loadSessionEntryMock.mockReturnValue(
        buildSessionLookup(sessionKey, {
          lastChannel: "telegram",
          lastTo: "-100155462274:topic:42",
          lastThreadId: 42,
          lastAccountId: "work",
        }),
      );
      const logWarn = vi.fn();
      await handleNodeEvent(
        buildCtx(() => ({ invokeResultReceived: false }), logWarn),
        "node-1",
        nodeEvent("exec.finished", {
          sessionKey,
          runId: "legacy-capture-unavailable-" + failure,
          exitCode: 0,
          output: "ordinary legacy output",
        }),
        { connId: "conn-1" },
      );
      expect(enqueueSystemEventMock).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
        sessionKey,
        contextKey: "exec:legacy-capture-unavailable-" + failure,
      });
      expect(requestHeartbeatMock).toHaveBeenCalledExactlyOnceWith(
        execEventHeartbeatOptions(sessionKey),
      );
      expect(logWarn).not.toHaveBeenCalled();
    },
  );

  it("preserves the per-agent notification opt-out when the invoke reply is missing", async () => {
    const logWarn = vi.fn();
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false }), logWarn),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey: "agent:main:telegram:group:-100155462274:topic:42",
        runId: "run-result-first-opt-out",
        exitCode: 0,
        output: "do not notify",
        notifyOnExit: false,
        invokeResultSentFirst: true,
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("suppresses recovery when the originating delivery context is unavailable", async () => {
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey: "agent:main:telegram:group:-100155462274:topic:42",
        runId: "run-result-first-no-route",
        exitCode: 0,
        output: "do not reroute",
        suppressNotifyOnExit: true,
        invokeResultSentFirst: true,
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("preserves an ordinary route-less Telegram completion", async () => {
    const sessionKey = "agent:main:telegram:direct:123456789";
    const runId = "run-ordinary-route-less";
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId,
        exitCode: 0,
        output: "ordinary output",
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).toHaveBeenCalledExactlyOnceWith(
      `Exec finished (node=node-1 id=${runId}, code 0)\nordinary output`,
      {
        sessionKey,
        contextKey: `exec:${runId}`,
      },
    );
    expect(requestHeartbeatMock).toHaveBeenCalledExactlyOnceWith(
      execEventHeartbeatOptions(sessionKey),
    );
  });

  it.each([
    {
      sessionKey: "agent:main:whatsapp:direct:+15555550111",
      channel: "whatsapp",
      to: "+15555550222",
    },
    { sessionKey: "agent:main:slack:channel:c111", channel: "slack", to: "channel:c222" },
    { sessionKey: "agent:main:main", channel: "telegram", to: "-100222222222:topic:99" },
  ])(
    "does not promote terminal-time $channel history into exec authority",
    async ({ sessionKey, channel, to }) => {
      loadSessionEntryMock.mockReturnValue(
        buildSessionLookup(sessionKey, {
          lastChannel: channel,
          lastTo: to,
          lastAccountId: "personal",
          lastThreadId: 99,
        }),
      );
      await handleNodeEvent(
        buildCtx(() => ({ invokeResultReceived: false, turnSourceAccountId: "work" })),
        "node-1",
        nodeEvent("exec.finished", {
          sessionKey,
          runId: "terminal-history-drift",
          exitCode: 0,
          output: "private command result",
        }),
        { connId: "conn-1" },
      );
      expect(enqueueSystemEventMock).toHaveBeenCalledExactlyOnceWith(
        "Exec finished (node=node-1 id=terminal-history-drift, code 0)\nprivate command result",
        { sessionKey, contextKey: "exec:terminal-history-drift" },
      );
      expect(requestHeartbeatMock).toHaveBeenCalledExactlyOnceWith(
        execEventHeartbeatOptions(sessionKey),
      );
    },
  );

  it.each([false, true])(
    "does not manufacture invocation custody from a terminal canonical alias (recovery=%s)",
    async (recovery) => {
      const invocationSessionKey = "agent:main:main";
      const runId = "canonical-history-" + recovery;
      const canonicalKey = "agent:main:telegram:group:-100155462274:topic:42";
      loadSessionEntryMock.mockReturnValue(
        buildSessionLookup(canonicalKey, {
          lastChannel: "telegram",
          lastTo: "-100155462274",
          lastAccountId: "work",
          lastThreadId: 42,
        }),
      );
      await handleNodeEvent(
        buildCtx(() => ({ invokeResultReceived: false, turnSourceAccountId: "work" })),
        "node-1",
        nodeEvent("exec.finished", {
          sessionKey: invocationSessionKey,
          runId,
          exitCode: 0,
          output: "canonical alias notice",
          ...(recovery ? { suppressNotifyOnExit: true, invokeResultSentFirst: true } : {}),
        }),
        { connId: "conn-1" },
      );
      if (recovery) {
        expect(enqueueSystemEventMock).not.toHaveBeenCalled();
        expect(requestHeartbeatMock).not.toHaveBeenCalled();
        return;
      }
      expect(enqueueSystemEventMock).toHaveBeenCalledExactlyOnceWith(
        "Exec finished (node=node-1 id=" + runId + ", code 0)\ncanonical alias notice",
        { sessionKey: canonicalKey, contextKey: "exec:" + runId },
      );
      expect(requestHeartbeatMock).toHaveBeenCalledExactlyOnceWith(
        execEventHeartbeatOptions(canonicalKey),
      );
    },
  );

  it("does not grant route custody to a sessionless invocation", async () => {
    const sessionKey = "agent:main:telegram:work:direct:123456789";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo: "123456789",
        lastAccountId: "work",
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false, invocationSessionKey: undefined })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId: "sessionless-invocation",
        exitCode: 0,
        output: "ordinary sessionless notice",
      }),
      { connId: "conn-1" },
    );
    expect(enqueueSystemEventMock).toHaveBeenCalledExactlyOnceWith(
      "Exec finished (node=node-1 id=sessionless-invocation, code 0)\nordinary sessionless notice",
      { sessionKey, contextKey: "exec:sessionless-invocation" },
    );
  });

  it.each([false, true])(
    "preserves a non-Telegram terminal fallback with invokeResultReceived=%s",
    async (invokeResultReceived) => {
      const sessionKey = "agent:main:webchat:node-proof";
      const runId = invokeResultReceived
        ? "run-webchat-result-received"
        : "run-webchat-result-lost";
      await handleNodeEvent(
        buildCtx(() => ({ invokeResultReceived })),
        "node-1",
        nodeEvent("exec.finished", {
          sessionKey,
          runId,
          exitCode: 0,
          output: "webchat fallback",
          suppressNotifyOnExit: false,
          invokeResultSentFirst: true,
        }),
        { connId: "conn-1" },
      );

      expect(enqueueSystemEventMock).toHaveBeenCalledExactlyOnceWith(
        `Exec finished (node=node-1 id=${runId}, code 0)\nwebchat fallback`,
        { sessionKey, contextKey: `exec:${runId}` },
      );
      expect(requestHeartbeatMock).toHaveBeenCalledExactlyOnceWith(
        execEventHeartbeatOptions(sessionKey),
      );
    },
  );

  it.each([
    ["matching recovery", true, "work", "work", true],
    ["route replaced by another account", true, "work", "personal", false],
    ["missing invocation account", true, undefined, "work", false],
    ["default-account recovery", true, "default", undefined, true],
    ["ordinary account mismatch", false, "work", "personal", false],
    ["ordinary legacy accountless authority", false, undefined, "personal", true],
  ])(
    "binds an accountless forum session for %s",
    async (_label, recovery, turnSourceAccountId, lastAccountId, allowed) => {
      const sessionKey = "agent:main:telegram:group:-100155462274:topic:42";
      loadSessionEntryMock.mockReturnValue(
        buildSessionLookup(sessionKey, {
          lastChannel: "telegram",
          lastTo: "-100155462274",
          lastThreadId: 42,
          lastAccountId,
        }),
      );
      await handleNodeEvent(
        buildCtx(() => ({ invokeResultReceived: false, turnSourceAccountId })),
        "node-1",
        nodeEvent("exec.finished", {
          sessionKey,
          runId: `run-forum-account-${_label}`,
          exitCode: 0,
          output: "forum account output",
          ...(recovery ? { suppressNotifyOnExit: true, invokeResultSentFirst: true } : {}),
        }),
        { connId: "conn-1" },
      );

      if (allowed) {
        expect(enqueueSystemEventMock).toHaveBeenCalledOnce();
        expect(requestHeartbeatMock).toHaveBeenCalledOnce();
      } else {
        expect(enqueueSystemEventMock).not.toHaveBeenCalled();
        expect(requestHeartbeatMock).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps a legacy no-marker forum completion suppressed", async () => {
    const sessionKey = "agent:main:telegram:group:-100155462274:topic:42";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo: "-100155462274",
        lastThreadId: 42,
        lastAccountId: "work",
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false, turnSourceAccountId: "work" })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId: "run-forum-account-legacy",
        exitCode: 0,
        output: "legacy output",
        suppressNotifyOnExit: true,
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("diagnoses a legacy completion withheld after its Telegram account route changes", async () => {
    const sessionKey = "agent:main:telegram:work:direct:123456789";
    const logWarn = vi.fn();
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo: "123456789",
        lastAccountId: "personal",
      }),
    );

    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false }), logWarn),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId: "run-legacy-upgrade-route-mismatch",
        exitCode: 0,
      }),
      { connId: "conn-1" },
    );

    expect(logWarn).toHaveBeenCalledExactlyOnceWith(
      "node exec completion withheld: saved Telegram route does not match the invoking session",
    );
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("keeps a reasonless denial with a changed Telegram route quiet", async () => {
    const sessionKey = "agent:main:telegram:work:direct:123456789";
    const logWarn = vi.fn();
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo: "123456789",
        lastAccountId: "personal",
      }),
    );

    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false }), logWarn),
      "node-1",
      nodeEvent("exec.denied", {
        sessionKey,
        runId: "run-reasonless-denial-route-mismatch",
      }),
      { connId: "conn-1" },
    );

    expect(logWarn).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it.each([
    ["ordinary matching", false, undefined, "work", true],
    ["ordinary different", false, undefined, "personal", false],
    ["ordinary missing", false, undefined, undefined, false],
    ["recovery matching", true, "work", "work", true],
    ["recovery different", true, "work", "personal", false],
    ["recovery missing route account", true, "work", undefined, false],
    ["recovery stored session account", true, undefined, "work", true],
    ["recovery conflicting invocation account", true, "personal", "work", false],
  ])(
    "handles an account-qualified Telegram route for %s",
    async (_label, recovery, turnSourceAccountId, lastAccountId, allowed) => {
      const sessionKey = "agent:main:telegram:work:direct:123456789";
      loadSessionEntryMock.mockReturnValue(
        buildSessionLookup(sessionKey, {
          lastChannel: "telegram",
          lastTo: "123456789",
          lastAccountId,
        }),
      );
      await handleNodeEvent(
        buildCtx(() => ({ invokeResultReceived: false, turnSourceAccountId })),
        "node-1",
        nodeEvent("exec.finished", {
          sessionKey,
          runId: `run-account-${_label}`,
          exitCode: 0,
          output: "account-bound output",
          ...(recovery ? { suppressNotifyOnExit: true, invokeResultSentFirst: true } : {}),
        }),
        { connId: "conn-1" },
      );

      if (allowed) {
        expect(enqueueSystemEventMock).toHaveBeenCalledExactlyOnceWith(
          expect.any(String),
          expect.objectContaining({
            deliveryContext: expect.objectContaining({ accountId: "work" }),
          }),
        );
        expect(requestHeartbeatMock).toHaveBeenCalledOnce();
      } else {
        expect(enqueueSystemEventMock).not.toHaveBeenCalled();
        expect(requestHeartbeatMock).not.toHaveBeenCalled();
      }
    },
  );

  it("preserves an omitted default account for a default-account session", async () => {
    const sessionKey = "agent:main:telegram:default:direct:123456789";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo: "123456789",
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId: "run-default-account-omitted",
        exitCode: 0,
        output: "default account output",
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).toHaveBeenCalledOnce();
    expect(requestHeartbeatMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["result-first recovery", true],
    ["ordinary completion", undefined],
  ])("suppresses %s when the saved route points outside the topic", async (_label, suppress) => {
    const sessionKey = "agent:main:telegram:group:-100155462274:topic:42";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo: "123456789",
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId: "run-result-first-wrong-route",
        exitCode: 0,
        output: "do not reroute",
        ...(suppress === undefined ? {} : { suppressNotifyOnExit: suppress }),
        invokeResultSentFirst: true,
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("suppresses a threaded direct completion when the saved chat differs", async () => {
    const sessionKey = "agent:main:telegram:direct:123456789:thread:42";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo: "987654321",
        lastThreadId: 42,
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId: "run-threaded-direct-wrong-chat",
        exitCode: 0,
        output: "do not reroute",
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("pins the verified default account instead of leaving later bot selection implicit", async () => {
    const sessionKey = "agent:main:telegram:direct:123456789:thread:42";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo: "123456789:topic:42",
        lastThreadId: 42,
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false, turnSourceAccountId: "default" })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId: "verified-default-pin",
        exitCode: 0,
        output: "verified account result",
        suppressNotifyOnExit: true,
        invokeResultSentFirst: true,
      }),
      { connId: "conn-1" },
    );
    expect(enqueueSystemEventMock).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.objectContaining({
        deliveryContext: expect.objectContaining({ accountId: "default" }),
      }),
    );
  });

  it.each([
    ["native ordinary", false, "123456789:42", "123456789", 42, true],
    ["encoded ordinary", false, "123456789:42", "123456789:topic:42", undefined, true],
    ["native recovery", true, "123456789:42", "123456789", 42, true],
    ["encoded recovery", true, "123456789:42", "123456789:topic:42", undefined, true],
    ["scoped saved native ordinary", false, "123456789:42", "123456789", "123456789:42", true],
    [
      "scoped saved encoded ordinary",
      false,
      "123456789:42",
      "123456789:topic:42",
      "123456789:42",
      true,
    ],
    ["scoped saved native recovery", true, "123456789:42", "123456789", "123456789:42", true],
    [
      "scoped saved encoded recovery",
      true,
      "123456789:42",
      "123456789:topic:42",
      "123456789:42",
      true,
    ],
    ["cross saved scoped chat", true, "123456789:42", "123456789", "987654321:42", false],
    ["cross saved scoped topic", true, "123456789:42", "123456789:topic:42", "123456789:99", false],
    [
      "cross saved scoped channel-DM",
      true,
      "123456789:42",
      "123456789:topic:42",
      "123456789:direct-topic:42",
      false,
    ],
    ["cross canonical chat", true, "987654321:42", "123456789", 42, false],
    ["cross saved chat", true, "123456789:42", "987654321", 42, false],
    ["cross topic", true, "123456789:42", "123456789", 99, false],
  ] as const)(
    "verifies a canonical private-topic invocation for %s",
    async (_label, recovery, thread, lastTo, lastThreadId, allowed) => {
      const sessionKey = "agent:main:telegram:work:direct:123456789:thread:" + thread;
      loadSessionEntryMock.mockReturnValue(
        buildSessionLookup(sessionKey, {
          lastChannel: "telegram",
          lastTo,
          lastThreadId,
          lastAccountId: "work",
        }),
      );
      await handleNodeEvent(
        buildCtx(() => ({ invokeResultReceived: false, turnSourceAccountId: "work" })),
        "node-1",
        nodeEvent("exec.finished", {
          sessionKey,
          runId: "canonical-private-" + _label,
          exitCode: 0,
          output: "canonical topic result",
          ...(recovery ? { suppressNotifyOnExit: true, invokeResultSentFirst: true } : {}),
        }),
        { connId: "conn-1" },
      );
      if (allowed) {
        expect(enqueueSystemEventMock).toHaveBeenCalledOnce();
        expect(requestHeartbeatMock).toHaveBeenCalledOnce();
      } else {
        expect(enqueueSystemEventMock).not.toHaveBeenCalled();
        expect(requestHeartbeatMock).not.toHaveBeenCalled();
      }
    },
  );
  it("accepts a matching direct route whose thread is encoded in the target", async () => {
    const sessionKey = "agent:main:telegram:direct:123456789:thread:42";
    const runId = "run-threaded-direct-matching-target";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo: "123456789:thread:42",
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false, turnSourceAccountId: "default" })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId,
        exitCode: 0,
        output: "matching direct thread",
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).toHaveBeenCalledExactlyOnceWith(
      `Exec finished (node=node-1 id=${runId}, code 0)\nmatching direct thread`,
      {
        sessionKey,
        contextKey: `exec:${runId}`,
        deliveryContext: { channel: "telegram", to: "123456789:topic:42", accountId: "default" },
      },
    );
    expect(requestHeartbeatMock).toHaveBeenCalledExactlyOnceWith(
      execEventHeartbeatOptions(sessionKey),
    );
  });

  it.each([
    ["matching", "-100155462274:direct-topic:42", undefined, true],
    ["case-insensitive matching", "-100155462274:DIRECT-TOPIC:42", undefined, true],
    ["cross-chat", "-100999999999:direct-topic:42", undefined, false],
    ["forum-topic scope", "-100155462274:topic:42", undefined, false],
    ["ambiguous explicit thread", "-100155462274", 42, false],
    ["verified scoped explicit", "-100155462274", "-100155462274:direct-topic:42", true],
    ["cross-chat scoped explicit", "-100155462274", "-100999999999:direct-topic:42", false],
    ["forum scoped explicit", "-100155462274", "-100155462274:42", false],
  ])(
    "handles a %s Telegram Direct Messages topic route",
    async (_label, lastTo, lastThreadId, allowed) => {
      const sessionKey = "agent:main:telegram:group:-100155462274:direct-topic:42";
      const runId = `run-direct-topic-${_label}`;
      loadSessionEntryMock.mockReturnValue(
        buildSessionLookup(sessionKey, {
          lastChannel: "telegram",
          lastTo,
          lastThreadId,
        }),
      );
      await handleNodeEvent(
        buildCtx(() => ({ invokeResultReceived: false, turnSourceAccountId: "default" })),
        "node-1",
        nodeEvent("exec.finished", {
          sessionKey,
          runId,
          exitCode: 0,
          output: "direct topic output",
          suppressNotifyOnExit: true,
          invokeResultSentFirst: true,
        }),
        { connId: "conn-1" },
      );

      if (allowed) {
        expect(enqueueSystemEventMock).toHaveBeenCalledOnce();
        expect(requestHeartbeatMock).toHaveBeenCalledOnce();
      } else {
        expect(enqueueSystemEventMock).not.toHaveBeenCalled();
        expect(requestHeartbeatMock).not.toHaveBeenCalled();
      }
    },
  );

  it("accepts a forum topic route encoded with a thread suffix", async () => {
    const sessionKey = "agent:main:telegram:group:-100155462274:topic:42";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo: "-100155462274:thread:42",
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId: "run-forum-thread-suffix",
        exitCode: 0,
        output: "forum topic output",
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).toHaveBeenCalledOnce();
    expect(requestHeartbeatMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["matching", "123456789", true],
    ["cross-chat", "987654321", false],
    ["unexpected thread", "123456789:topic:42", false],
  ])("handles a %s unthreaded Telegram DM route", async (_label, lastTo, allowed) => {
    const sessionKey = "agent:main:telegram:direct:123456789";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo,
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId: `run-unthreaded-dm-${_label}`,
        exitCode: 0,
        output: "dm output",
      }),
      { connId: "conn-1" },
    );

    if (allowed) {
      expect(enqueueSystemEventMock).toHaveBeenCalledOnce();
      expect(requestHeartbeatMock).toHaveBeenCalledOnce();
    } else {
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
      expect(requestHeartbeatMock).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["ordinary completion", false, true],
    ["result-first recovery", true, false],
  ])("preserves %s behavior for a non-Telegram route", async (_label, recovery, allowed) => {
    const sessionKey = "agent:main:slack:channel:C123:thread:42";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "slack",
        lastTo: "C123",
        lastThreadId: "42",
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId: `run-slack-${_label}`,
        exitCode: 0,
        output: "slack output",
        ...(recovery ? { suppressNotifyOnExit: true, invokeResultSentFirst: true } : {}),
      }),
      { connId: "conn-1" },
    );

    if (allowed) {
      expect(enqueueSystemEventMock).toHaveBeenCalledOnce();
      expect(requestHeartbeatMock).toHaveBeenCalledOnce();
    } else {
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
      expect(requestHeartbeatMock).not.toHaveBeenCalled();
    }
  });

  it("suppresses a topic completion when saved route topic fields conflict", async () => {
    const sessionKey = "agent:main:telegram:group:-100155462274:topic:42";
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo: "-100155462274:topic:99",
        lastThreadId: 42,
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: false })),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId: "run-conflicting-topic-fields",
        exitCode: 0,
        output: "do not reroute",
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("suppresses a completion after the invoke reply arrives", async () => {
    const sessionKey = "agent:main:telegram:group:-100155462274:topic:42";
    const logWarn = vi.fn();
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup(sessionKey, {
        lastChannel: "telegram",
        lastTo: "-100999999999",
        lastAccountId: "work",
        lastThreadId: 42,
      }),
    );
    await handleNodeEvent(
      buildCtx(() => ({ invokeResultReceived: true, turnSourceAccountId: "work" }), logWarn),
      "node-1",
      nodeEvent("exec.finished", {
        sessionKey,
        runId: "run-result-first-delivered",
        exitCode: 0,
        output: "already delivered",
        suppressNotifyOnExit: true,
        invokeResultSentFirst: true,
      }),
      { connId: "conn-1" },
    );

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });
});

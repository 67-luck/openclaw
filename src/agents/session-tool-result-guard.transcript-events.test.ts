import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../test/helpers/text-tool-result.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { MessageInjectionAuthorityError } from "../auto-reply/reply/message-injection-authority.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  loadSessionEntry,
  listSessionPendingInputs,
  persistCompactionBoundaryWithSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { applyAssistantDeliveryDirectives } from "../config/sessions/transcript-assistant-delivery.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type {
  PluginHookBeforeMessageWriteEvent,
  PluginHookBeforeMessageWriteResult,
} from "../plugins/types.js";
import {
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import {
  attachRuntimeUserTurnTranscriptContext,
  attachRuntimeUserTurnTranscriptRecorder,
} from "../sessions/user-turn-transcript-runtime-context.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { createAssistantErrorTranscript } from "./assistant-error-transcript.js";
import { runAgentHarnessBeforeMessageWriteHook } from "./harness/hook-helpers.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { createTranscriptEventFixture } from "./session-tool-result-guard.transcript.test-support.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";
import {
  prepareCodeModeSourceAppend,
  takeCodeModeResponseSource,
  wrapStreamFnCodeModeSource,
} from "./transcript-code-mode-source.js";

const assistantText = (text: string) =>
  makeAgentAssistantMessage({ content: [{ type: "text", text }] });
const model = makeProviderModelFixture({
  id: "test-model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid",
});
const codeCall = (id: string) => ({
  type: "toolCall" as const,
  id,
  name: "exec",
  arguments: { code: "const API_TOKEN = computeToken(); return API_TOKEN;" },
});
async function withSource(message: ReturnType<typeof makeAgentAssistantMessage>) {
  const stream = createAssistantMessageEventStream();
  if (message.stopReason === "error") {
    stream.push({ type: "error", reason: "error", error: message });
  } else {
    stream.push({ type: "done", reason: "toolUse", message });
  }
  return await (
    await wrapStreamFnCodeModeSource(() => stream, new Set(["exec"]))(model, { messages: [] })
  ).result();
}

function installWriteHook(
  handler: (
    event: PluginHookBeforeMessageWriteEvent,
  ) => PluginHookBeforeMessageWriteResult | undefined,
) {
  const registry = createEmptyPluginRegistry();
  registry.typedHooks.push({
    pluginId: "write-fixture",
    hookName: "before_message_write",
    source: "test",
    handler,
  });
  initializeGlobalHookRunner(registry);
}
const listeners: Array<() => void> = [];
const { openPersistedSessionManager } = createTranscriptEventFixture();

function collectUpdates() {
  const updates: InternalSessionTranscriptUpdate[] = [];
  listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));
  return updates;
}

afterEach(async () => {
  resetGlobalHookRunner();
  while (listeners.length > 0) {
    listeners.pop()?.();
  }
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
});

describe("guardSessionManager transcript updates", () => {
  it("preserves prepared source and redaction when a concurrent append forces a retry", async () => {
    const { sessionManager: manager, target } = await openPersistedSessionManager();
    const baseId = manager.appendMessage(makeUserMessage("Compute a value", 1));
    installSessionToolResultGuard(manager, {
      config: { logging: { redactPatterns: [String.raw`/opaque\(([^)]+)\)/g`] } },
    });
    const toolCall = codeCall("retry-source");
    const emitted = await withSource(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "opaque(abcdefghijklmnopqrst)" }, toolCall],
        stopReason: "toolUse",
      }),
    );
    const { db } = openOpenClawAgentDatabase({ agentId: target.agentId, path: target.storePath });
    const exec = db.exec.bind(db);
    let injected = false;
    const execSpy = vi.spyOn(db, "exec").mockImplementation((statement) => {
      if (statement === "BEGIN IMMEDIATE" && !injected) {
        injected = true;
        // Commit after validation but before the writer acquires its snapshot.
        const concurrent = appendTranscriptMessageSync(target, {
          eventId: "concurrent-assistant",
          message: assistantText("Concurrent"),
        });
        expect(concurrent.ok).toBe(true);
      }
      return exec(statement);
    });
    let entryId: string;
    try {
      entryId = manager.appendMessage(
        emitted,
        prepareCodeModeSourceAppend({}, emitted, takeCodeModeResponseSource(emitted)),
      );
      expect(execSpy).toHaveBeenCalledWith("ROLLBACK");
    } finally {
      execSpy.mockRestore();
    }
    closeOpenClawAgentDatabasesForTest();
    const entries = SessionManager.open(target).getBranch();
    expect(entries.map(({ id, parentId }) => ({ id, parentId }))).toEqual([
      { id: baseId, parentId: null },
      { id: "concurrent-assistant", parentId: baseId },
      { id: entryId, parentId: "concurrent-assistant" },
    ]);
    expect(entries.at(-1)).toMatchObject({
      message: { content: [{ type: "text", text: "opaque(abcdef…qrst)" }, toolCall] },
    });
  });

  it("persists compaction item identity under each current run across reload", async () => {
    const { sessionManager, root, target } = await openPersistedSessionManager();
    for (const runId of ["run-first", "run-second"]) {
      const guarded = guardSessionManager(sessionManager, {
        runId,
        withCompactionPersistence: (prepared) =>
          persistCompactionBoundaryWithSessionEntrySync(target, {
            prepared,
            transcriptByteCompactionLatch: {
              activeBytes: 2048,
              sessionId: target.sessionId,
              maxBytes: 1024,
            },
          }),
      });
      const keptId = guarded.appendMessage({ role: "user", content: runId, timestamp: 1 });
      guarded.appendCompaction("summary", keptId, 100, { source: "hook" }, true, {
        itemId: `compaction-${runId}`,
      });
    }
    const compactions = SessionManager.open(target, root)
      .getBranch()
      .filter((entry) => entry.type === "compaction");
    expect(compactions).toMatchObject([
      {
        __openclaw: { runId: "run-first", itemId: "compaction-run-first" },
      },
      {
        __openclaw: { runId: "run-second", itemId: "compaction-run-second" },
      },
    ]);
    expect(loadSessionEntry(target)?.compactionCount).toBe(2);
  });

  it("consumes a steered source under its own custody and does not repeat its approval hook", async () => {
    const { root, target, sessionEntry } = await openPersistedSessionManager();
    const recorderTarget = { ...target, sessionEntry };
    const ambient = createUserTurnTranscriptRecorder({
      input: { text: "Active turn", timestamp: 1, idempotencyKey: "active:user" },
      target: recorderTarget,
    });
    const source = createUserTurnTranscriptRecorder({
      input: { text: "Steered source", timestamp: 2, idempotencyKey: "steered:user" },
      target: recorderTarget,
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    });
    try {
      await ambient.stageApproved!({ runId: "active", assertCurrent: () => {} });
      await ambient.persistApproved();
      const approvalHook = vi.fn(({ message }: PluginHookBeforeMessageWriteEvent) => {
        if (message.role !== "user") {
          return undefined;
        }
        return {
          message: {
            ...message,
            content: `[approved] ${typeof message.content === "string" ? message.content : ""}`,
          },
        };
      });
      installWriteHook(approvalHook);
      expect(await source.stageApproved!({ runId: "steered", assertCurrent: () => {} })).toBe(true);
      const approved = await source.resolveMessage();
      if (!approved) {
        throw new Error("Expected approved steering input");
      }
      const pending = listSessionPendingInputs(target);
      expect(pending.total).toBe(1);
      const guarded = guardSessionManager(SessionManager.open(target, root), {
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        preparedUserTurnMessage: await ambient.resolveMessage(),
        preparedUserTurnTranscriptRecorder: ambient,
        suppressNextUserMessagePersistence: true,
      });
      const runtimeMessage = attachRuntimeUserTurnTranscriptContext(
        { role: "user", content: "Rendered steering prompt", timestamp: 2 },
        { message: approved, recorder: source },
      );

      expect(source.getAdmissionReceipt()).toBeUndefined();
      // The already-running turn's async context is not the steered input's custody.
      const freshCallback = vi.fn();
      const entryId = ambient.withPendingInput!(() =>
        guarded.appendMessage(runtimeMessage, { beforeFreshMessageCommit: freshCallback }),
      );

      expect(entryId).toBe(pending.items[0]?.id);
      expect(guarded.getEntry(entryId)).toMatchObject({ message: approved });
      expect(source.getAdmissionReceipt()).toMatchObject({ entryId });
      expect(source.getPersistedMessage?.()).toEqual(approved);
      expect(listSessionPendingInputs(target)).toEqual({ items: [], total: 0 });
      expect(approvalHook).toHaveBeenCalledOnce();
      expect(freshCallback).not.toHaveBeenCalled();

      const unstagedId = guarded.appendMessage(makeUserMessage("Unstaged source", 3));
      expect(approvalHook).toHaveBeenCalledTimes(2);
      expect(guarded.getEntry(unstagedId)).toMatchObject({
        message: { role: "user", content: "[approved] Unstaged source" },
      });
    } finally {
      source.finishPendingInput?.("interrupted");
      ambient.finishPendingInput?.("interrupted");
    }
  });

  it("combines explicit redaction with one fresh SQLite admission across replay", async () => {
    const { root, target, sessionEntry, sessionManager } = await openPersistedSessionManager();
    const message = {
      role: "user" as const,
      content: "private-note=fixture-only-redaction-value",
      idempotencyKey: "redacted-admission:user",
      timestamp: 1,
    };
    const assertOriginalInputCommit = vi.fn(() => {
      expect(beforeFresh).toHaveBeenCalledOnce();
      expect(
        SessionManager.open(target, root)
          .getBranch()
          .filter((entry) => entry.type === "message"),
      ).toHaveLength(0);
    });
    const recorder = createUserTurnTranscriptRecorder({
      message,
      target: { ...target, sessionEntry },
      assertOriginalInputCommit,
    });
    const admitted = vi.fn();
    assert(recorder.setAdmissionHandler);
    recorder.setAdmissionHandler(admitted);
    const guarded = guardSessionManager(sessionManager, {
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      config: { logging: { redactPatterns: [String.raw`private-note=([^\s]+)`] } },
      preparedUserTurnMessage: message,
      preparedUserTurnTranscriptRecorder: recorder,
    });

    const beforeFresh = vi.fn();
    const options = { beforeFreshMessageCommit: beforeFresh };
    const entryId = guarded.appendMessage({ ...message }, options);
    expect(guarded.appendMessage({ ...message }, options)).toBe(entryId);
    expect(beforeFresh).toHaveBeenCalledOnce();
    expect(assertOriginalInputCommit).toHaveBeenCalledOnce();
    expect(admitted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ entryId, idempotencyKey: message.idempotencyKey }),
    );
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const persisted = SessionManager.open(target, root)
      .getBranch()
      .filter((entry) => entry.type === "message");
    expect(persisted).toMatchObject([
      { id: entryId, message: { role: "user", content: "private-note=***" } },
    ]);
    expect(JSON.stringify(persisted)).not.toContain(message.content);
  });

  it("keeps a guarded native caller failure exact after lazy header initialization and before recorder admission", async () => {
    const { root, target, sessionEntry, sessionManager } = await openPersistedSessionManager();
    const message = makeUserMessage("rejected fresh input", 1);
    const failure = new Error("caller rejected fresh input");
    const beforeFresh = vi.fn(() => {
      throw failure;
    });
    const assertOriginalInputCommit = vi.fn();
    const recorder = createUserTurnTranscriptRecorder({
      message,
      target: { ...target, sessionEntry },
      assertOriginalInputCommit,
    });
    const observed = vi.fn();
    const guarded = guardSessionManager(sessionManager, {
      preparedUserTurnMessage: message,
      preparedUserTurnTranscriptRecorder: recorder,
      onMessagePersisted: observed,
    });
    const before = sessionManager.getEntries();
    const header = sessionManager.getHeader();
    expect(
      SessionManager.readSessionContext(target, (_messages, storedHeader) => storedHeader),
    ).toBeUndefined();
    let caught: unknown;
    try {
      guarded.appendMessage(message, { beforeFreshMessageCommit: beforeFresh });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(beforeFresh).toHaveBeenCalledOnce();
    expect(assertOriginalInputCommit).not.toHaveBeenCalled();
    expect(observed).not.toHaveBeenCalled();
    expect(sessionManager.getEntries()).toEqual(before);
    expect(sessionManager.getHeader()).toEqual(header);
    expect(SessionManager.open(target, root).getEntries()).toEqual(before);
    expect(
      SessionManager.readSessionContext(target, (_messages, storedHeader) => storedHeader),
    ).toEqual(header);
  });

  it("runs guarded native fresh hooks for real candidates only and rechecks recorder authority after the caller", async () => {
    const { sessionManager: manager, target, sessionEntry } = await openPersistedSessionManager();
    const persisted: string[] = [];
    installSessionToolResultGuard(manager, {
      beforeMessageWriteHook: ({ message }) =>
        message.role === "user" && message.content === "blocked" ? { block: true } : undefined,
      onMessagePersisted: (message) => {
        persisted.push(message.role);
      },
    });
    manager.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "real", name: "read", arguments: {} }],
        stopReason: "toolUse",
      }),
    );
    const realHook = vi.fn();
    manager.appendMessage(makeTextToolResult("real", "read", "real result", false, 1), {
      beforeFreshMessageCommit: realHook,
    });
    expect(realHook).toHaveBeenCalledOnce();
    manager.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "repair", name: "read", arguments: {} }],
        stopReason: "toolUse",
      }),
    );
    const blockedHook = vi.fn();
    manager.appendMessage(makeUserMessage("blocked", 2), { beforeFreshMessageCommit: blockedHook });
    expect(blockedHook).not.toHaveBeenCalled();
    expect(persisted).toEqual(["assistant", "toolResult", "assistant", "toolResult"]);

    let current = true;
    const failure = new Error("recorder revoked by caller");
    const assertOriginalInputCommit = vi.fn(() => {
      if (!current) {
        throw failure;
      }
    });
    const message = makeUserMessage("must not persist", 3);
    const recorder = createUserTurnTranscriptRecorder({
      message,
      target: { ...target, sessionEntry },
      assertOriginalInputCommit,
    });
    const before = manager.getEntries();
    const caller = vi.fn(() => {
      current = false;
    });
    let caught: unknown;
    try {
      manager.appendMessage(attachRuntimeUserTurnTranscriptRecorder(message, recorder), {
        beforeFreshMessageCommit: caller,
      });
    } catch (error) {
      caught = error;
    }
    assert(caught instanceof MessageInjectionAuthorityError);
    expect(caught.cause).toBe(failure);
    expect(caller).toHaveBeenCalledOnce();
    expect(assertOriginalInputCommit).toHaveBeenCalledOnce();
    expect(manager.getEntries()).toEqual(before);
    expect(SessionManager.open(target).getEntries()).toEqual(before);
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "records replay admission without a fresh append (excluded: %s; stale manager: %s)",
    async (excludeFromContext, staleManager) => {
      const { root, target, sessionManager } = await openPersistedSessionManager();
      if (staleManager) {
        // The SDK persists model/thinking setup before prompt submission. Keep the user
        // projection stale without creating a competing lazy header initializer.
        await sessionManager.appendModelChange("openai", "gpt-5.6-sol");
        await sessionManager.appendThinkingLevelChange("off");
      }
      const openedBeforeIngress = staleManager
        ? SessionManager.openBounded(target, { cwd: root, maxBytes: 100_000, maxEvents: 100 })
        : undefined;
      const message = {
        role: "user" as const,
        content: "canonical prompt",
        idempotencyKey: "canonical-run:user",
        ...(excludeFromContext ? { excludeFromContext: true as const } : {}),
        timestamp: Date.now(),
      };
      await appendTranscriptMessage(target, {
        cwd: root,
        eventId: "ingress-persisted-user",
        message,
        now: message.timestamp,
      });
      const recorder = createUserTurnTranscriptRecorder({
        message,
        target: {
          ...target,
          sessionEntry: { sessionId: target.sessionId, updatedAt: message.timestamp },
        },
      });
      const markRuntimePersisted = vi.spyOn(recorder, "markRuntimePersisted");
      const updates: InternalSessionTranscriptUpdate[] = [];
      listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));
      const guarded = guardSessionManager(
        openedBeforeIngress ??
          SessionManager.openBounded(target, { cwd: root, maxBytes: 100_000, maxEvents: 100 }),
        {
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          preparedUserTurnMessage: message,
          preparedUserTurnTranscriptRecorder: recorder,
        },
      );

      expect(recorder.getAdmissionReceipt()).toBeUndefined();
      guarded.appendMessage({ ...message });

      expect(recorder.hasPersisted()).toBe(true);
      expect(markRuntimePersisted).toHaveBeenCalledWith(
        message,
        expect.objectContaining({ entryId: "ingress-persisted-user" }),
        { appended: false },
      );
      expect(updates).toEqual([]);
      expect(recorder.getAdmissionReceipt()).toMatchObject({
        agentId: target.agentId,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
        entryId: "ingress-persisted-user",
        idempotencyKey: message.idempotencyKey,
        role: "user",
      });
    },
  );

  it("reuses an in-memory user behind setup metadata without changing the selected side view", async () => {
    const sm = SessionManager.inMemory();
    const message = { ...makeUserMessage("canonical", 1), idempotencyKey: "run:user" };
    const expected = structuredClone(message);
    const userId = sm.appendMessage(message);
    const setupModel = { modelApi: "openai-responses", modelId: "test-model", provider: "openai" };
    await sm.appendModelChange(setupModel.provider, setupModel.modelId);
    await sm.appendThinkingLevelChange("off");
    const metadata = sm.appendCustomEntry("model-snapshot", setupModel);
    const leaf = sm.appendMessage(assistantText("visible"));
    sm.appendLeafControl({ targetId: leaf, appendParentId: metadata, appendMode: "side" });
    const ids = sm.getEntries().map((entry) => entry.id);
    const onUserMessagePersisted = vi.fn();
    guardSessionManager(sm, { preparedUserTurnMessage: message, onUserMessagePersisted });
    const runtime = makeUserMessage("canonical", 1);
    expect(sm.appendMessage(runtime)).toBe(userId);
    expect(sm.getAppendParentId()).toBe(metadata);
    expect(sm.getLeafId()).toBe(leaf);
    expect(sm.getEntries().map((entry) => entry.id)).toEqual(ids);
    expect(sm.getEntry(userId)).toMatchObject({ message: expected });
    expect(onUserMessagePersisted).toHaveBeenCalledExactlyOnceWith(expected, runtime);
  });

  it("drops selected mentions when a write hook mutates their text in place", async () => {
    const { target, sessionManager } = await openPersistedSessionManager();
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Hi @Taylor" }],
      timestamp: 1,
      __openclaw: { humanMentions: [{ profileId: "profile-taylor", start: 3, end: 10 }] },
    };
    installWriteHook(({ message: runtimeMessage }) => {
      if (runtimeMessage.role === "user" && Array.isArray(runtimeMessage.content)) {
        Object.assign(runtimeMessage.content[0]!, { text: "Hi @Morgan" });
      }
      return { message: runtimeMessage };
    });
    const guarded = guardSessionManager(sessionManager, {
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      preparedUserTurnMessage: message,
    });
    const entryId = guarded.appendMessage(message);
    expect(guarded.getEntry(entryId)).toMatchObject({
      message: { role: "user", content: [{ type: "text", text: "Hi @Morgan" }] },
    });
    expect(guarded.getEntry(entryId)).not.toHaveProperty("message.__openclaw.humanMentions");
  });

  it("broadcasts the committed SQLite owner when a callback rebinds the manager", async () => {
    const updates = collectUpdates();
    const { sessionManager: sm, target } = await openPersistedSessionManager("original-lifecycle");
    const replacement = await openPersistedSessionManager("replacement-lifecycle");
    const guarded = guardSessionManager(sm, {
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      onMessagePersisted: () => {
        sm.setSessionTarget(replacement.target);
      },
    });
    const message = assistantText("hello from subagent");
    guarded.appendMessage(message);
    expect(updates).toStrictEqual([
      {
        agentId: "main",
        lifecycleRevision: "original-lifecycle",
        message,
        messageId: expect.any(String),
        messageSeq: 1,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        target,
      },
    ]);
    expect(updates[0]?.messageId).not.toBe("");
  });

  it("caches real tool result sequence before final assistant messages", async () => {
    const updates = collectUpdates();
    const { sessionManager: sm, target } = await openPersistedSessionManager();
    const promptEntryId = sm.appendMessage(makeUserMessage("existing prompt", 1));
    const spy = vi.spyOn(sm, "getBranch");
    const guarded = guardSessionManager(sm, {
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      runId: "run-owning-final",
    });
    guarded.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      }),
    );
    expect(spy.mock.calls).toEqual([[promptEntryId]]);
    guarded.appendMessage(makeTextToolResult("call_1", "read", "tool output", false, 2));
    expect(spy.mock.calls).toEqual([[promptEntryId], []]);
    guarded.appendMessage(assistantText("final answer"));
    expect(
      sm.getEntries().flatMap((entry) =>
        entry.type === "message"
          ? [
              {
                role: entry.message.role,
                runId: asNullableRecord(asNullableRecord(entry.message)?.["__openclaw"])?.runId,
              },
            ]
          : [],
      ),
    ).toEqual([
      { role: "user", runId: undefined },
      { role: "assistant", runId: "run-owning-final" },
      { role: "toolResult", runId: "run-owning-final" },
      { role: "assistant", runId: "run-owning-final" },
    ]);
    expect(spy.mock.calls).toEqual([[promptEntryId], []]);
    expect(updates.map((update) => update.messageSeq)).toEqual([2, 4]);
    expect(
      updates.map(
        ({ message }) => asNullableRecord(asNullableRecord(message)?.["__openclaw"])?.runId,
      ),
    ).toEqual(["run-owning-final", "run-owning-final"]);
    expect(updates.map(({ runId }) => runId)).toEqual([undefined, "run-owning-final"]);
    spy.mockRestore();
  });

  it("refreshes run ownership and delivery preparation across reused managers", async () => {
    const updates = collectUpdates();
    const { sessionManager: sm, target } = await openPersistedSessionManager();
    const firstRun = guardSessionManager(sm, {
      skipBeforeMessageWriteHooks: true,
      agentId: target.agentId,
      runId: "run-first",
      sessionKey: target.sessionKey,
      prepareAssistantTranscriptMessage: (message) =>
        applyAssistantDeliveryDirectives(message, { managedMediaUrls: ["./first.json"] }),
    });
    firstRun.appendMessage(assistantText("first reply\nMEDIA:./first.json"));
    guardSessionManager(sm, {
      agentId: target.agentId,
      runId: "run-second",
      sessionKey: target.sessionKey,
    }).appendMessage({ ...assistantText("second reply"), stopReason: "error" });
    guardSessionManager(sm).appendMessage(assistantText("unowned reply"));
    expect(updates[0]?.message).toMatchObject({
      content: [{ type: "text", text: "first reply\nMEDIA:./first.json" }],
      openclawDelivery: { mediaUrls: ["./first.json"] },
    });
    expect(updates[1]?.message).toMatchObject({ stopReason: "error" });
    expect(
      updates.slice(1).some(({ message }) => Reflect.has(message as object, "openclawDelivery")),
    ).toBe(false);
    expect(
      updates.map(({ messageId, messageSeq, runId }) => ({ messageId, messageSeq, runId })),
    ).toEqual([
      { messageId: expect.any(String), messageSeq: 1, runId: "run-first" },
      { messageId: expect.any(String), messageSeq: 2, runId: "run-second" },
      { messageId: expect.any(String), messageSeq: 3, runId: undefined },
    ]);
  });
});

describe("deferred assistant error transcript", () => {
  async function setup() {
    const { sessionManager: manager, target } = await openPersistedSessionManager();
    const owner = createAssistantErrorTranscript({ runId: "run-test" });
    installSessionToolResultGuard(manager, { assistantErrorTranscript: owner });
    return { target, owner, manager };
  }

  it("preserves failed-attempt tool calls before their persisted results through recovery and replay", async () => {
    const { target, owner, manager } = await setup();
    const toolCall = codeCall("call-exec");
    const failed = makeAgentAssistantMessage({
      content: [{ type: "text", text: "I" }, toolCall],
      stopReason: "error",
      errorMessage: "provider rate limit",
    });
    const emitted = await withSource(failed);
    manager.appendMessage(
      emitted,
      prepareCodeModeSourceAppend({}, emitted, takeCodeModeResponseSource(emitted)),
    );
    manager.appendMessage({
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: "Persisted result" }],
      isError: false,
      timestamp: 1,
    });
    owner.clear();
    manager.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Recovered" }],
        timestamp: 2,
      }),
    );
    await owner.settle(false);
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const messages = SessionManager.open(target).buildSessionContext().messages;
    expect(messages).toMatchObject([
      { role: "assistant", content: [toolCall], stopReason: "toolUse" },
      {
        role: "toolResult",
        toolCallId: toolCall.id,
        content: [{ type: "text", text: "Persisted result" }],
      },
      { role: "assistant", content: [{ type: "text", text: "Recovered" }] },
    ]);
    expect(messages[0]).not.toHaveProperty("errorMessage");
    const normalized = normalizeAssistantReplayContent(messages);
    const replay = transformMessages(
      normalized.filter(
        (message) =>
          message.role === "assistant" || message.role === "user" || message.role === "toolResult",
      ),
      model,
    );
    expect(replay).toEqual(normalized);
  });

  it("preserves canonical media without partial text when recovery succeeds", async () => {
    const { target, owner, manager } = await setup();
    const facts = {
      __openclaw: {
        media: [{ url: "https://example.invalid/report.pdf", contentType: "application/pdf" }],
      },
    };
    manager.appendMessage({
      ...makeAgentAssistantMessage({
        content: [{ type: "text", text: "Here" }],
        stopReason: "error",
        errorMessage: "retry",
      }),
      ...facts,
    });
    owner.clear();
    manager.appendMessage(assistantText("Recovered"));
    await owner.settle(false);
    expect(SessionManager.open(target).buildSessionContext().messages).toMatchObject([
      { role: "assistant", content: [], stopReason: "stop", ...facts },
      { role: "assistant", content: [{ type: "text", text: "Recovered" }] },
    ]);
  });

  it("keeps terminal partial text and its error without duplicating tool facts or usage", async () => {
    const { target, owner, manager } = await setup();
    const displayText = { type: "text", text: "Displayed partial answer" };
    const attachment = { type: "attachment", url: "https://example.invalid/report.pdf" };
    const failed = {
      ...makeAgentAssistantMessage({
        content: [
          { type: "text", text: "Partial answer" },
          { type: "toolCall", id: "call-terminal", name: "read", arguments: {} },
        ],
        stopReason: "error",
        errorMessage: "terminal failure",
      }),
      openclawDisplayContent: [displayText, attachment],
    };
    failed.usage = { ...failed.usage, output: 7, totalTokens: 7 };
    manager.appendMessage(failed);
    manager.appendMessage(makeTextToolResult("call-terminal", "read", "Result", false, 1));
    await owner.settle(true);
    await owner.settle(true);
    const messages = SessionManager.open(target).buildSessionContext().messages;
    expect(messages).toMatchObject([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-terminal" }],
        openclawDisplayContent: [attachment],
        usage: { output: 7 },
      },
      { role: "toolResult", toolCallId: "call-terminal" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Partial answer" }],
        openclawDisplayContent: [displayText],
        stopReason: "error",
        errorMessage: "terminal failure",
        usage: { output: 0 },
      },
    ]);
  });

  it("revalidates the captured writer before committing a terminal failure", async () => {
    const { target, owner, manager } = await setup();
    let active = true;
    await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: target,
        assertCommitAllowed: () => {
          if (!active) {
            throw new Error("writer retired");
          }
        },
        withTranscriptWrite: async (operation) => await operation(),
      },
      async () => {
        manager.appendMessage(makeAgentAssistantMessage({ content: [], stopReason: "error" }));
      },
    );
    active = false;
    await expect(owner.settle(true)).rejects.toThrow("writer retired");
    expect(SessionManager.open(target).getBranch()).toHaveLength(0);
  });
});

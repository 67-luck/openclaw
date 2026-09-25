// Verifies guarded session managers emit transcript update events with stable sequence ids.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
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
import type { PluginHookBeforeMessageWriteEvent } from "../plugins/types.js";
import {
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import {
  attachRuntimeUserTurnTranscriptContext,
  attachRuntimeUserTurnTranscriptRecorder,
} from "../sessions/user-turn-transcript-runtime-context.js";
import {
  createUserTurnTranscriptRecorder,
  type UserTurnTranscriptRecorder,
} from "../sessions/user-turn-transcript.js";
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
const listeners: Array<() => void> = [];
const { openPersistedSessionManager } = createTranscriptEventFixture();

afterEach(async () => {
  // Remove all transcript listeners between tests to avoid duplicate broadcasts.
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
    const code = "const API_TOKEN = computeToken(); return API_TOKEN;";
    const toolCall = {
      type: "toolCall" as const,
      id: "retry-source",
      name: "exec",
      arguments: { code },
    };
    const message = makeAgentAssistantMessage({
      content: [{ type: "text", text: "opaque(abcdefghijklmnopqrst)" }, toolCall],
      stopReason: "toolUse",
    });
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "toolUse", message });
    const response = await wrapStreamFnCodeModeSource(() => stream, new Set(["exec"]))(
      makeProviderModelFixture({
        id: "test-model",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://example.invalid",
      }),
      { messages: [] },
    );
    const emitted = await response.result();
    const { db } = openOpenClawAgentDatabase({ agentId: target.agentId, path: target.storePath });
    const exec = db.exec.bind(db);
    let injected = false;
    const execSpy = vi.spyOn(db, "exec").mockImplementation((statement) => {
      if (statement === "BEGIN IMMEDIATE" && !injected) {
        injected = true;
        // Commit after validation but before the writer acquires its snapshot.
        const concurrent = appendTranscriptMessageSync(target, {
          eventId: "concurrent-assistant",
          message: makeAgentAssistantMessage({ content: [{ type: "text", text: "Concurrent" }] }),
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

  it("refreshes the deferred error owner when a session manager serves a new run", async () => {
    const { sessionManager, target } = await openPersistedSessionManager();
    const first = createAssistantErrorTranscript({ runId: "run-first" });
    const second = createAssistantErrorTranscript({ runId: "run-second" });
    guardSessionManager(sessionManager, { runId: "run-first", assistantErrorTranscript: first });
    sessionManager.appendMessage(makeAgentAssistantMessage({ content: [], stopReason: "error" }));
    await first.settle(false);
    guardSessionManager(sessionManager, { runId: "run-second", assistantErrorTranscript: second });
    sessionManager.appendMessage(makeAgentAssistantMessage({ content: [], stopReason: "error" }));
    await second.settle(true);
    await first.settle(true);
    const messages = SessionManager.open(target)
      .getBranch()
      .filter((entry) => entry.type === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toMatchObject({
      stopReason: "error",
      __openclaw: { runId: "run-second" },
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
        details: { source: "hook" },
        fromHook: true,
      },
      {
        __openclaw: { runId: "run-second", itemId: "compaction-run-second" },
        details: { source: "hook" },
        fromHook: true,
      },
    ]);
    expect(loadSessionEntry(target)?.compactionCount).toBe(2);
  });

  it("leaves the session manager unchanged when atomic compaction persistence rejects the boundary", async () => {
    const { sessionManager, root, target } = await openPersistedSessionManager();
    const keptId = sessionManager.appendMessage(makeUserMessage("keep", 1));
    const guarded = guardSessionManager(sessionManager, {
      withCompactionPersistence: (prepared) =>
        persistCompactionBoundaryWithSessionEntrySync(target, {
          prepared: { ...prepared, event: { ...prepared.event, id: keptId } },
          transcriptByteCompactionLatch: {
            activeBytes: 2048,
            sessionId: target.sessionId,
            maxBytes: 1024,
          },
        }),
    });

    expect(() => guarded.appendCompaction("summary", keptId, 100)).toThrow(
      `Session transcript entry was not persisted: ${keptId}: transcript-event-not-appended`,
    );
    expect(sessionManager.getLeafId()).toBe(keptId);
    expect(sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toEqual([]);
    expect(
      SessionManager.open(target, root)
        .getBranch()
        .filter((entry) => entry.type === "compaction"),
    ).toEqual([]);
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
    const markRuntimePersisted = vi.spyOn(source, "markRuntimePersisted");
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
      const registry = createEmptyPluginRegistry();
      registry.typedHooks.push({
        pluginId: "steered-input-approval",
        hookName: "before_message_write",
        source: "test",
        handler: approvalHook,
      });
      initializeGlobalHookRunner(registry);
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

      // The already-running turn's async context is not the steered input's custody.
      const freshCallback = vi.fn();
      const entryId = ambient.withPendingInput!(() =>
        guarded.appendMessage(runtimeMessage, { beforeFreshMessageCommit: freshCallback }),
      );

      expect(entryId).toBe(pending.items[0]?.id);
      expect(guarded.getEntry(entryId)).toMatchObject({ message: approved });
      expect(source.getAdmissionReceipt()).toMatchObject({ entryId });
      expect(markRuntimePersisted).toHaveBeenCalledWith(
        approved,
        expect.objectContaining({ entryId }),
        { appended: true },
      );
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
      resetGlobalHookRunner();
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

  it.each(["active", "side", "setup-metadata"] as const)(
    "adopts an ingress-persisted %s-branch user without broadcasting a duplicate",
    async (branch) => {
      const updates: InternalSessionTranscriptUpdate[] = [];
      listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));

      const sm = SessionManager.inMemory();
      const preparedUserTurnMessage = {
        role: "user" as const,
        content: "canonical prompt",
        idempotencyKey: "canonical-run:user",
        timestamp: Date.now(),
      };
      const existingId = sm.appendMessage(preparedUserTurnMessage);
      if (branch === "side") {
        const visibleLeafId = sm.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: "visible branch" }],
          timestamp: Date.now(),
        } as Parameters<typeof sm.appendMessage>[0]);
        sm.appendLeafControl({
          targetId: visibleLeafId,
          appendParentId: existingId,
          appendMode: "side",
        });
      } else if (branch === "setup-metadata") {
        await sm.appendModelChange("openai", "gpt-5.5");
        await sm.appendThinkingLevelChange("off");
        sm.appendCustomEntry("model-snapshot", {
          modelApi: "openai-responses",
          modelId: "gpt-5.5",
          provider: "openai",
        });
      }
      const appendParentId = sm.getAppendParentId();
      const markRuntimePersisted = vi.fn();
      const recorder = {
        markBlocked: vi.fn(),
        markRuntimePersisted,
      } as unknown as UserTurnTranscriptRecorder;
      const guarded = guardSessionManager(sm, {
        agentId: "main",
        sessionKey: "agent:main:canonical",
        preparedUserTurnMessage,
        preparedUserTurnTranscriptRecorder: recorder,
      });

      const runtimeId = guarded.appendMessage({
        role: "user",
        content: "canonical prompt",
        timestamp: preparedUserTurnMessage.timestamp,
      });

      expect(runtimeId).toBe(existingId);
      expect(sm.getAppendParentId()).toBe(appendParentId);
      expect(
        sm
          .getEntries()
          .filter((entry) => entry.type === "message" && entry.message.role === "user"),
      ).toHaveLength(1);
      expect(updates).toEqual([]);
      expect(markRuntimePersisted).toHaveBeenCalledTimes(1);
      expect(markRuntimePersisted.mock.calls[0]?.[0]).toMatchObject({
        idempotencyKey: "canonical-run:user",
      });
      expect(markRuntimePersisted.mock.calls[0]?.[2]).toEqual({ appended: false });
    },
  );

  it("drops selected mentions when a write hook mutates their text in place", async () => {
    const { target, sessionManager } = await openPersistedSessionManager();
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Hi @Taylor" }],
      timestamp: 1,
      __openclaw: {
        humanMentions: [{ profileId: "profile-taylor", start: 3, end: 10 }],
      },
    };
    const registry = createEmptyPluginRegistry();
    registry.typedHooks.push({
      pluginId: "rewrite-user-selection",
      hookName: "before_message_write",
      source: "test",
      handler: ({ message: runtimeMessage }: PluginHookBeforeMessageWriteEvent) => {
        if (runtimeMessage.role === "user" && Array.isArray(runtimeMessage.content)) {
          Object.assign(runtimeMessage.content[0]!, { text: "Hi @Morgan" });
        }
        return { message: runtimeMessage };
      },
    });
    initializeGlobalHookRunner(registry);
    try {
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
    } finally {
      resetGlobalHookRunner();
    }
  });

  it.each([
    { name: "legacy", lifecycleRevision: undefined, rebind: false },
    { name: "owned", lifecycleRevision: "original-lifecycle", rebind: false },
    { name: "rebound callback", lifecycleRevision: "original-lifecycle", rebind: true },
  ])(
    "broadcasts the committed SQLite owner for $name messages",
    async ({ lifecycleRevision, rebind }) => {
      const updates: InternalSessionTranscriptUpdate[] = [];
      listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));

      const { sessionManager: sm, target } = await openPersistedSessionManager(lifecycleRevision);
      const replacement = rebind
        ? await openPersistedSessionManager("replacement-lifecycle")
        : undefined;

      const guarded = guardSessionManager(sm, {
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        onMessagePersisted: () => {
          if (replacement) {
            sm.setSessionTarget(replacement.target);
          }
        },
      });
      const timestamp = Date.now();
      const message = makeAgentAssistantMessage({
        content: [{ type: "text", text: "hello from subagent" }],
        timestamp,
      });
      guarded.appendMessage(message);

      expect(updates).toStrictEqual([
        {
          agentId: "main",
          ...(lifecycleRevision ? { lifecycleRevision } : {}),
          message,
          messageId: expect.any(String),
          messageSeq: 1,
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
          target,
        },
      ]);
      expect(updates[0]?.messageId).not.toBe("");
    },
  );

  it("does not resolve transcript sequence for an in-memory session", () => {
    const sm = SessionManager.inMemory();
    const getBranchSpy = vi.spyOn(sm, "getBranch");

    const guarded = guardSessionManager(sm, {
      agentId: "main",
      sessionKey: "agent:main:worker",
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    } as AgentMessage);

    expect(getBranchSpy).not.toHaveBeenCalled();
    getBranchSpy.mockRestore();
  });

  it("reuses cached transcript sequence for consecutive appended messages", async () => {
    const updates: InternalSessionTranscriptUpdate[] = [];
    listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));

    const { sessionManager: sm, target } = await openPersistedSessionManager();
    sm.appendMessage({
      role: "user",
      content: "existing prompt",
      timestamp: Date.now(),
    } as Parameters<typeof sm.appendMessage>[0]);
    const getBranchSpy = vi.spyOn(sm, "getBranch");
    const guarded = guardSessionManager(sm, {
      agentId: target.agentId,
      sessionKey: target.sessionKey,
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "first" }],
      timestamp: Date.now(),
    } as AgentMessage);
    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "second" }],
      timestamp: Date.now(),
    } as AgentMessage);

    expect(getBranchSpy).toHaveBeenCalledTimes(1);
    expect(updates.map((update) => update.messageSeq)).toEqual([2, 3]);
    getBranchSpy.mockRestore();
  });

  it("caches real tool result sequence before final assistant messages", async () => {
    // Tool results are persisted but not broadcast, so later visible messages must skip their seq.
    const updates: InternalSessionTranscriptUpdate[] = [];
    listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));

    const { sessionManager: sm, target } = await openPersistedSessionManager();
    const promptEntryId = sm.appendMessage({
      role: "user",
      content: "existing prompt",
      timestamp: Date.now(),
    } as Parameters<typeof sm.appendMessage>[0]);
    const getBranchSpy = vi.spyOn(sm, "getBranch");
    const guarded = guardSessionManager(sm, {
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      runId: "run-owning-final",
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      timestamp: Date.now(),
    } as AgentMessage);
    expect(getBranchSpy.mock.calls).toEqual([[promptEntryId]]);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "tool output" }],
      isError: false,
      timestamp: Date.now(),
    } as AgentMessage);
    expect(getBranchSpy.mock.calls).toEqual([[promptEntryId], []]);
    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "final answer" }],
      timestamp: Date.now(),
    } as AgentMessage);

    expect(
      sm
        .getEntries()
        .filter((entry) => entry.type === "message")
        .map((entry) => ({
          role: entry.message.role,
          runId: asNullableRecord(asNullableRecord(entry.message)?.["__openclaw"])?.runId,
        })),
    ).toEqual([
      { role: "user", runId: undefined },
      { role: "assistant", runId: "run-owning-final" },
      { role: "toolResult", runId: "run-owning-final" },
      { role: "assistant", runId: "run-owning-final" },
    ]);
    expect(getBranchSpy.mock.calls).toEqual([[promptEntryId], []]);
    expect(updates.map((update) => update.messageSeq)).toEqual([2, 4]);
    expect(
      updates.map(
        (update) => asNullableRecord(asNullableRecord(update.message)?.["__openclaw"])?.runId,
      ),
    ).toEqual(["run-owning-final", "run-owning-final"]);
    expect(updates.map((update) => update.runId)).toEqual([undefined, "run-owning-final"]);
    getBranchSpy.mockRestore();
  });

  it.each([false, true])(
    "refreshes terminal run ownership with hooks skipped=%s",
    async (skipBeforeMessageWriteHooks) => {
      const updates: InternalSessionTranscriptUpdate[] = [];
      listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));
      const { sessionManager, target } = await openPersistedSessionManager();

      const firstRun = guardSessionManager(sessionManager, {
        skipBeforeMessageWriteHooks,
        agentId: target.agentId,
        runId: "run-first",
        sessionKey: target.sessionKey,
        prepareAssistantTranscriptMessage: (message) =>
          applyAssistantDeliveryDirectives(message, { managedMediaUrls: ["./first.json"] }),
      });
      firstRun.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "first reply\nMEDIA:./first.json" }],
        timestamp: Date.now(),
      } as Parameters<typeof firstRun.appendMessage>[0]);

      const secondRun = guardSessionManager(sessionManager, {
        agentId: target.agentId,
        runId: "run-second",
        sessionKey: target.sessionKey,
      });
      secondRun.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "second reply" }],
        timestamp: Date.now(),
      } as Parameters<typeof secondRun.appendMessage>[0]);

      const unknownRun = guardSessionManager(sessionManager);
      unknownRun.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "unowned reply" }],
        timestamp: Date.now(),
      } as Parameters<typeof unknownRun.appendMessage>[0]);

      expect(secondRun).toBe(firstRun);
      expect(unknownRun).toBe(firstRun);
      expect(updates[0]?.message).toMatchObject({
        content: [{ type: "text", text: "first reply\nMEDIA:./first.json" }],
        openclawDelivery: { mediaUrls: ["./first.json"] },
      });
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
    },
  );
});

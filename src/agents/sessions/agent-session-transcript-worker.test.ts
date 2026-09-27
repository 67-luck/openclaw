import path from "node:path";
import { serialize } from "node:v8";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentEvent } from "../runtime/index.js";
import { installSessionToolResultGuard } from "../session-tool-result-guard.js";
import {
  getCodeModeSourceAppend,
  prepareCodeModeSourceAppend,
  readCodeModeSourceFields,
  takeCodeModeResponseSource,
  wrapStreamFnCodeModeSource,
  type CodeModeSourceAppend,
} from "../transcript-code-mode-source.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import * as metadataRuntime from "./session-manager-metadata-runtime.js";
import { SessionManager } from "./session-manager.js";

registerAgentSessionLoopTestLifecycle();

it.each([false, true])(
  "retains one-shot source custody across the async guarded append (reject=%s)",
  async (reject) => {
    await withOpenClawTestState({ label: "session-async-source" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "async-source",
        sessionKey: "agent:main:async-source",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const manager = SessionManager.open(target, state.workspaceDir);
      manager.appendMessage({ role: "user", content: "current turn", timestamp: 1 });
      const before = loadTranscriptEventsSync(target);
      const entered = createDeferred();
      const resume = createDeferred();
      const original = manager.appendMessageWithTranscriptAnchorAsync.bind(manager);
      let source: CodeModeSourceAppend | undefined;
      let captured: Parameters<typeof original> | undefined;
      const code = "const API_TOKEN = computeToken(); return API_TOKEN;";
      const failure = new Error("Fixture append rejected after its async wait");
      const append = vi
        .spyOn(manager, "appendMessageWithTranscriptAnchorAsync")
        .mockImplementation(async (...args) => {
          captured = args;
          source = getCodeModeSourceAppend(args[1]);
          entered.resolve();
          await resume.promise;
          expect(source).toBeDefined();
          expect(getCodeModeSourceAppend(args[1])).toBe(source);
          expect([...readCodeModeSourceFields(args[0], source).values()]).toEqual([
            new Map([["code", code]]),
          ]);
          if (reject) {
            throw failure;
          }
          return await original(...args);
        });
      const beforeWrite = vi.fn(() => undefined);
      const persisted = vi.fn();
      installSessionToolResultGuard(manager, {
        beforeMessageWriteHook: beforeWrite,
        onMessagePersisted: persisted,
      });
      const message = createAssistant(
        testModel,
        [{ type: "toolCall", id: "async-source-call", name: "exec", arguments: { code } }],
        "toolUse",
      );
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "toolUse", message });
      const response = await wrapStreamFnCodeModeSource(() => stream, new Set(["exec"]))(
        testModel,
        {
          messages: [],
        },
      );
      const emitted = await response.result();
      const options = prepareCodeModeSourceAppend({}, emitted, takeCodeModeResponseSource(emitted));
      const operation = manager.appendMessageAsync(emitted, options).then(
        (entryId) => ({ ok: true as const, entryId }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await Promise.race([entered.promise, operation]);
        expect(append).toHaveBeenCalledOnce();
        expect(beforeWrite).toHaveBeenCalledOnce();
        expect(persisted).not.toHaveBeenCalled();
        expect(captured).toBeDefined();
        expect(getCodeModeSourceAppend(captured?.[1])).toBe(source);
        expect(loadTranscriptEventsSync(target)).toEqual(before);
        resume.resolve();
        const result = await operation;
        expect(result.ok).toBe(!reject);
        if (!result.ok) {
          expect(result.error).toBe(failure);
          expect(loadTranscriptEventsSync(target)).toEqual(before);
          expect(persisted).not.toHaveBeenCalled();
        } else {
          expect(manager.getEntry(result.entryId!)).toMatchObject({
            message: { content: [{ arguments: { code } }] },
          });
          expect(persisted).toHaveBeenCalledOnce();
          expect(loadTranscriptEventsSync(target)).toEqual(manager.getPersistedEntries());
        }
        expect(getCodeModeSourceAppend(captured?.[1])).toBeUndefined();
        expect(readCodeModeSourceFields(emitted, source).size).toBe(0);
        expect(takeCodeModeResponseSource(emitted)).toBeUndefined();
        expect(beforeWrite).toHaveBeenCalledOnce();
      } finally {
        resume.resolve();
        await operation;
        append.mockRestore();
      }
    });
  },
);

it("commits streamed messages off the host thread before adopting guard state and rebases only within the turn", async () => {
  await withOpenClawTestState({ label: "session-stream-worker" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "stream-worker",
      sessionKey: "agent:main:stream-worker",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(target, state.workspaceDir);
    manager.appendMessage({ role: "user", content: "current turn", timestamp: 1 });
    const committed: string[] = [];
    const guard = installSessionToolResultGuard(manager, {
      onMessagePersisted(message) {
        expect(manager.getLeafEntry()).toMatchObject({ type: "message", message });
        committed.push(message.role);
      },
    });
    const { session } = await createTestSession({ sessionManager: manager });
    const handleEvent = Reflect.get(session, "handleAgentEvent") as (
      event: AgentEvent,
    ) => Promise<void>;
    const database = openOpenClawAgentDatabase({ agentId: "main", path: target.storePath });
    const hostExec = vi.spyOn(database.db, "exec");
    const withWorker = metadataRuntime.withSessionMetadataWorker;
    const commandBytes: number[] = [];
    const workerSpy = vi
      .spyOn(metadataRuntime, "withSessionMetadataWorker")
      .mockImplementation((options, db, assertCurrent, operation) =>
        withWorker(options, db, assertCurrent, (worker) =>
          operation({
            execute: (command, commandOptions) => {
              if (command.type === "session.metadata.append") {
                commandBytes.push(serialize(command).byteLength);
              }
              return worker.execute(command, commandOptions);
            },
          }),
        ),
      );
    const payload = "const value = 42;\n".repeat(1280);
    const assertWorkerCommit = async (
      message: Extract<AgentEvent, { type: "message_end" }>["message"],
    ) => {
      hostExec.mockClear();
      await handleEvent({ type: "message_end", message });
      expect(hostExec.mock.calls.filter(([sql]) => /^BEGIN\b/iu.test(sql))).toEqual([]);
    };
    try {
      await assertWorkerCommit(
        createAssistant(
          testModel,
          [{ type: "toolCall", id: "read-1", name: "read", arguments: { code: payload } }],
          "toolUse",
        ),
      );
      expect(guard.getPendingIds()).toEqual(["read-1"]);
      await assertWorkerCommit({
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: payload }],
        timestamp: 2,
      });
      expect(guard.getPendingIds()).toEqual([]);
      // The wire needs canonical JSON and one parsed message, plus a small control envelope.
      expect(commandBytes).toHaveLength(2);
      expect(Math.max(...commandBytes)).toBeLessThan(2 * Buffer.byteLength(payload) + 4096);

      const concurrent = SessionManager.open(target);
      const descendantId = concurrent.appendMessage(
        createAssistant(testModel, [{ type: "text", text: "concurrent reply" }]),
      );
      await assertWorkerCommit(createAssistant(testModel, [{ type: "text", text: "final reply" }]));
      expect(manager.getLeafEntry()?.parentId).toBe(descendantId);
      expect(manager.getBranch().some((entry) => entry.id === descendantId)).toBe(true);
      expect(loadTranscriptEventsSync(target)).toEqual(manager.getPersistedEntries());
      expect(committed).toEqual(["assistant", "toolResult", "assistant"]);

      SessionManager.open(target).appendMessage({
        role: "user",
        content: "new turn",
        timestamp: 3,
      });
      const before = loadTranscriptEventsSync(target);
      await expect(
        handleEvent({
          type: "message_end",
          message: createAssistant(testModel, [{ type: "text", text: "stale reply" }]),
        }),
      ).rejects.toThrow("SQLite transcript changed");
      expect(loadTranscriptEventsSync(target)).toEqual(before);
      expect(committed).toEqual(["assistant", "toolResult", "assistant"]);
    } finally {
      workerSpy.mockRestore();
      hostExec.mockRestore();
      session.dispose();
    }
  });
});

it("preserves a newer native view and tool-result state when a worker receipt arrives late", async () => {
  await withOpenClawTestState({ label: "session-delayed-receipt" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "delayed-receipt",
      sessionKey: "agent:main:delayed-receipt",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(target, state.workspaceDir);
    const userId = manager.appendMessage({ role: "user", content: "current turn", timestamp: 1 });
    const notifications: string[] = [];
    const guard = installSessionToolResultGuard(manager, {
      onMessagePersisted: (message) => {
        notifications.push(message.role);
      },
    });
    const text = (value: string) => createAssistant(testModel, [{ type: "text", text: value }]);
    const call = (ids: string[], name = "read") =>
      createAssistant(
        testModel,
        ids.map((id) => ({ type: "toolCall", id, name, arguments: {} })),
        "toolUse",
      );
    const toolResult = (id: string) => ({
      role: "toolResult" as const,
      toolCallId: id,
      toolName: "read",
      isError: false,
      content: [{ type: "text" as const, text: "completed" }],
      timestamp: 2,
    });
    const appendDelayed = async (message: ReturnType<typeof text>, newerWrite: () => void) => {
      const original = metadataRuntime.withSessionMetadataWorker;
      const delayed: typeof original = async (options, database, assertCurrent, operation) => {
        const receipt = await original(options, database, assertCurrent, operation);
        newerWrite();
        return receipt;
      };
      const spy = vi
        .spyOn(metadataRuntime, "withSessionMetadataWorker")
        .mockImplementation(delayed);
      try {
        return await manager.appendMessageAsync(message);
      } finally {
        spy.mockRestore();
      }
    };
    let newerId: string | undefined;
    const delayedId = await appendDelayed(text("worker reply"), () => {
      newerId = manager.appendMessage(text("newer native reply"));
    });
    expect(manager.getLeafId()).toBe(newerId);
    expect(manager.getBranch().map((entry) => entry.id)).toEqual([userId, delayedId, newerId]);
    expect(manager.getPersistedEntries()).toEqual(loadTranscriptEventsSync(target));

    await appendDelayed(call(["finished", "reused", "cleared"]), () => {
      manager.appendMessage(toolResult("finished"));
      manager.appendMessage(text("native boundary clears old calls"));
      manager.appendMessage(call(["reused"]));
      manager.appendMessage(toolResult("reused"));
      newerId = manager.appendMessage(call(["reused"], "write"));
    });
    expect(manager.getLeafId()).toBe(newerId);
    expect(guard.getPendingIds()).toEqual(["reused"]);
    const beforeFlush = manager.getEntries().length;
    guard.flushPendingToolResults();
    expect(manager.getEntries()).toHaveLength(beforeFlush + 1);
    expect(manager.getLeafEntry()).toMatchObject({
      message: {
        role: "toolResult",
        toolCallId: "reused",
        toolName: "write",
        isError: true,
      },
    });
    expect(guard.getPendingIds()).toEqual([]);
    const tailId = await manager.appendMessageAsync(text("normal append after receipt"));
    expect(manager.getLeafId()).toBe(tailId);
    expect(manager.getPersistedEntries()).toEqual(loadTranscriptEventsSync(target));
    expect(new Set(manager.getEntries().map((entry) => entry.id)).size).toBe(
      manager.getEntries().length,
    );
    expect(notifications).toHaveLength(
      manager.getEntries().filter((entry) => entry.type === "message").length - 1,
    );

    await appendDelayed(call(["omitted"]), () => {
      manager.appendMessage(text("newer selected view"));
      manager.branch(userId);
    });
    expect(manager.getLeafId()).toBe(userId);
    expect(guard.getPendingIds()).toEqual([]);
    const beforeOmittedFlush = loadTranscriptEventsSync(target);
    guard.flushPendingToolResults();
    expect(loadTranscriptEventsSync(target)).toEqual(beforeOmittedFlush);
  });
});

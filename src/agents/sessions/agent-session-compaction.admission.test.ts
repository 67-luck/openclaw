import { realpathSync } from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { isRecordedModelFallbackStop } from "../model-fallback-stop.js";
import { agentSessionSetContextReplacementHook } from "./agent-session-compaction.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { agentSessionSetPromptPreparation } from "./agent-session-prompting.js";
import type { ExtensionEvent } from "./extensions/types.js";
import { sessionManagerPrepareHistoryRead } from "./session-manager-history.js";
import * as metadataRuntime from "./session-manager-metadata-runtime.js";
import * as sessionWriteAdmission from "./session-manager-write-admission.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
});
registerAgentSessionLoopTestLifecycle();

type BeforeCompactionEvent = Extract<ExtensionEvent, { type: "session_before_compact" }>;

function seedHistory(manager: SessionManager, oldestPrompt = "old prompt"): string {
  const firstUser = manager.appendMessage(makeUserMessage(oldestPrompt, 1));
  manager.appendMessage(createAssistant(testModel, [{ type: "text", text: "old answer" }]));
  manager.appendMessage(makeUserMessage("recent prompt", 3));
  manager.appendMessage(createAssistant(testModel, [{ type: "text", text: "recent answer" }]));
  return firstUser;
}

function compactionResult(event: BeforeCompactionEvent) {
  return {
    compaction: {
      summary: "condensed history",
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    },
  };
}

const settings = () =>
  SettingsManager.inMemory({
    compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 1 },
    retry: { enabled: false },
  });

describe("context replacement after write admission", () => {
  it("navigates a detached user target through its logical parent instead of its raw append cursor", async () => {
    const manager = SessionManager.inMemory();
    const retained = makeUserMessage("retained branch", 1);
    const retainedId = manager.appendMessage(retained);
    const abandonedId = manager.appendMessage(
      createAssistant(testModel, [{ type: "text", text: "abandoned answer" }]),
    );
    manager.appendLeafControl({ targetId: retainedId, appendParentId: abandonedId });
    const editedId = manager.appendMessage(makeUserMessage("edit this request", 3));
    manager.appendMessage(createAssistant(testModel, [{ type: "text", text: "current answer" }]));
    expect(manager.getPersistedEntries()).toContainEqual(
      expect.objectContaining({ id: editedId, parentId: abandonedId }),
    );
    expect(manager.getEntry(editedId)).toMatchObject({ parentId: retainedId });
    const { session } = await createTestSession({
      sessionManager: manager,
      settingsManager: settings(),
    });

    await expect(session.navigateTree(editedId)).resolves.toMatchObject({
      cancelled: false,
      editorText: "edit this request",
    });

    expect(manager.getLeafId()).toBe(retainedId);
    expect(session.messages).toEqual([retained]);
    expect(manager.getEntry(abandonedId)).toMatchObject({
      message: { content: [{ type: "text", text: "abandoned answer" }] },
    });
  });

  it.each(
    (["detached", "persisted"] as const).flatMap((storage) =>
      [false, true].map((label) => ({ storage, label })),
    ),
  )(
    "settles refused $storage navigation without mismatched prompts (label=$label)",
    async ({ storage, label }) => {
      const root = realpathSync(tempDirs.make("openclaw-tree-context-refusal-"));
      const target = {
        agentId: "main",
        sessionId: "tree-context-refusal",
        sessionKey: "agent:main:tree-context-refusal",
        storePath: path.join(root, "sessions.json"),
      };
      if (storage === "persisted") {
        await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      }
      const manager =
        storage === "persisted" ? SessionManager.open(target, root) : SessionManager.inMemory();
      const first = manager.appendMessage(makeUserMessage("shared root", 1));
      manager.appendMessage(
        createAssistant(testModel, [{ type: "text", text: "x".repeat(5 * 1024 * 1024) }]),
      );
      const selected = manager.appendMessage(
        createAssistant(testModel, [{ type: "text", text: "small target" }]),
      );
      manager.branch(first);
      manager.appendMessage(createAssistant(testModel, [{ type: "text", text: "current branch" }]));
      const { session } = await createTestSession({
        sessionManager: manager,
        settingsManager: settings(),
      });
      const originalLeaf = manager.getLeafId();
      const originalBranch = manager.getBranch();
      const originalMessages = session.agent.state.messages;

      const originalEntryCount = manager.getPersistedEntries().length;
      const failure: unknown = await session
        .navigateTree(selected, label ? { label: "selected bookmark" } : {})
        .catch((error: unknown) => error);
      assert(failure instanceof Error, "Target acquisition must refuse the oversized ancestry");
      if (label) {
        expect(failure).toMatchObject({
          message: expect.stringContaining("navigation committed"),
          cause: new RangeError("Session history entry exceeds the acquisition byte limit"),
        });
        expect(isRecordedModelFallbackStop(failure)).toBe(true);
        const committedLeaf = manager.getLeafId();
        assert(committedLeaf, "The committed label must remain in canonical history");
        expect(manager.getEntry(committedLeaf)).toMatchObject({
          type: "label",
          targetId: selected,
          label: "selected bookmark",
        });
        expect(manager.getPersistedEntries().length).toBe(originalEntryCount + 1);
        expect(session.agent.state.messages).toBe(originalMessages);
        streamMocks.streamSimple.mockImplementation(() =>
          createAssistantResultStream(
            createAssistant(testModel, [{ type: "text", text: "recovered" }]),
          ),
        );
        for (const blocked of [
          () => session.prompt("blocked user"),
          () => session.agent.prompt(makeUserMessage("blocked direct user", 2)),
          () => {
            session.agent.followUp(makeUserMessage("blocked continuation", 2));
            return session.agent.continue();
          },
          () =>
            session.sendCustomMessage(
              { customType: "blocked", content: "blocked", display: false },
              { triggerTurn: true },
            ),
          () =>
            session.sendCustomMessage({
              customType: "blocked",
              content: "blocked",
              display: false,
            }),
        ]) {
          await expect(blocked()).rejects.toBe(failure);
        }
        expect(() => session.getContextUsage()).toThrow(failure);
        expect(() => session.getLastAssistantText()).toThrow(failure);
        expect(streamMocks.streamSimple).not.toHaveBeenCalled();
        expect(manager.getLeafId()).toBe(committedLeaf);
        expect(manager.getPersistedEntries().length).toBe(originalEntryCount + 1);
        if (storage === "persisted") {
          expect((await loadTranscriptEvents(target)).length).toBe(originalEntryCount + 1);
        }
        session.clearQueue();
        session.agent.state.messages = manager.buildSessionContext().messages;
        await session.prompt("continue recovered context");
        expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
        expect(
          manager
            .getEntries()
            .findLast((entry) => entry.type === "message" && entry.message.role === "user"),
        ).toMatchObject({ parentId: committedLeaf });
        return;
      }
      expect(failure.message).toBe("Session history entry exceeds the acquisition byte limit");
      expect(manager.getPersistedEntries().length).toBe(originalEntryCount);
      expect(manager.getLeafId()).toBe(originalLeaf);
      expect(manager.getAppendParentId()).toBe(originalLeaf);
      expect(manager.getBranch()).toEqual(originalBranch);
      expect(session.agent.state.messages).toBe(originalMessages);
      const next = await manager.appendMessageAsync(makeUserMessage("continue original branch", 2));
      assert(next, "The continuation must append to the original branch");
      expect(manager.getEntry(next)?.parentId).toBe(originalLeaf);
    },
  );

  it.each(["root", "branch"] as const)(
    "rejects a later synchronous reset in the bare %s navigation receipt gap",
    async (selection) => {
      const root = realpathSync(tempDirs.make("openclaw-tree-navigation-receipt-"));
      const target = {
        agentId: "main",
        sessionId: "tree-navigation-receipt",
        sessionKey: "agent:main:tree-navigation-receipt",
        storePath: path.join(root, "sessions.json"),
      };
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      const source = SessionManager.open(target, root);
      const firstUser = seedHistory(source);
      const assistantId = source.getEntries()[1]!.id;
      const manager = await SessionManager.openAsync(target, root, {
        maxBytes: 4096,
        maxEvents: 4,
      });
      const { session } = await createTestSession({
        sessionManager: manager,
        settingsManager: settings(),
      });
      const originalMessages = session.agent.state.messages;
      const originalEvents = await loadTranscriptEvents(target);
      const write = sessionWriteAdmission.withSessionManagerWrite;
      let resetAfterNavigation = false;
      const intercepted = vi
        .spyOn(sessionWriteAdmission, "withSessionManagerWrite")
        .mockImplementation(async (...args) => {
          const result = await write(...args);
          if (!resetAfterNavigation) {
            expect(manager.getLeafId()).toBe(selection === "root" ? null : assistantId);
            resetAfterNavigation = true;
            queueMicrotask(() => manager.resetLeaf());
          }
          return result;
        });
      try {
        await expect(
          session.navigateTree(selection === "root" ? firstUser : assistantId),
        ).rejects.toThrow("Session transcript navigation changed before publication");
      } finally {
        intercepted.mockRestore();
      }
      expect(resetAfterNavigation).toBe(true);
      expect(manager.getLeafId()).toBeNull();
      expect(manager.getAppendParentId()).toBeNull();
      expect(session.agent.state.messages).toBe(originalMessages);
      expect(await loadTranscriptEvents(target)).toEqual(originalEvents);
    },
  );

  it.each([
    ["compaction", "navigation"],
    ["tree", "navigation"],
    ["compaction", "message replacement"],
    ["tree", "message append"],
    ["compaction", "message append"],
    ["compaction", "navigation after commit"],
    ["compaction", "transcript append"],
    ["tree", "transcript append"],
    ["compaction", "transcript append and messages"],
    ["tree", "transcript append and messages"],
    ["compaction", "transcript append and replacement"],
    ["tree", "transcript append and replacement"],
    ["tree", "reader failure"],
    ["compaction", "aborted publication"],
    ["preflight", "reader failure"],
    ["admission", "reader failure"],
  ] as const)(
    "protects session views when %s context publication fails (%s)",
    async (operation, change) => {
      const root = realpathSync(tempDirs.make("openclaw-context-publication-"));
      const target = {
        agentId: "main",
        sessionId: "context-publication",
        sessionKey: "agent:main:context-publication",
        storePath: path.join(root, "sessions.json"),
      };
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      const source = SessionManager.open(target, root);
      seedHistory(source);
      const persistedUserIdempotencyKey = "compaction-preflight-replay";
      if (operation === "preflight") {
        source.appendMessage(
          createAssistant(testModel, [{ type: "text", text: "high usage answer" }], "stop", 32_768),
        );
        const pending: PersistedUserTurnMessage = {
          ...makeUserMessage("persisted follow-up", 5),
          idempotencyKey: persistedUserIdempotencyKey,
        };
        source.appendMessage(pending);
        streamMocks.streamSimple.mockImplementation(() =>
          createAssistantResultStream(
            createAssistant(testModel, [{ type: "text", text: "must not request a response" }]),
          ),
        );
      }
      const selectedId = source.getEntries()[1]!.id;
      const manager = await SessionManager.openAsync(target, root, {
        maxBytes: 4096,
        maxEvents: 3,
      });
      const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
        [
          "session_before_compact",
          [async (event) => compactionResult(event as BeforeCompactionEvent)],
        ],
        ["session_before_tree", [async () => ({ summary: { summary: "abandoned branch" } })]],
      ]);
      const { session } = await createTestSession({
        sessionManager: manager,
        settingsManager:
          operation === "preflight"
            ? SettingsManager.inMemory({
                compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
                retry: { enabled: false },
              })
            : settings(),
        resourceLoader: createResourceLoader(handlers),
      });
      const messagesBefore = session.agent.state.messages;
      if (operation === "preflight") {
        expect(messagesBefore.at(-1)).toMatchObject({
          role: "user",
          idempotencyKey: persistedUserIdempotencyKey,
        });
      }
      const rowsBefore =
        operation === "preflight" || operation === "admission"
          ? await loadTranscriptEvents(target)
          : undefined;
      const newerMessage = makeUserMessage("newer active message", 99);
      const transcriptAppend = change.startsWith("transcript append");
      let appendedDuringRead: string | undefined;
      let currentMessages = messagesBefore;
      const accounted = vi.fn();
      session[agentSessionSetContextReplacementHook](accounted);
      const prepare = manager[sessionManagerPrepareHistoryRead].bind(manager);
      let changedBeforePublication = false;
      const readerFailure = new Error("Committed context reader is unavailable");
      const supersede = () => {
        if (change === "aborted publication") {
          session.abortCompaction();
          changedBeforePublication = true;
          return;
        }
        if (change === "navigation" || change === "navigation after commit") {
          manager.resetLeaf();
        } else if (change === "message replacement") {
          session.agent.state.messages = [newerMessage];
        } else {
          session.agent.state.messages.push(newerMessage);
        }
        currentMessages = session.agent.state.messages;
        changedBeforePublication = true;
      };
      const intercepted = vi
        .spyOn(manager, sessionManagerPrepareHistoryRead)
        .mockImplementation((signal) => {
          const history = prepare(signal);
          return {
            ...history,
            readContext: async () => {
              const pending = history.readContext();
              if (transcriptAppend) {
                appendedDuringRead = manager.appendMessage(newerMessage);
                if (change === "transcript append and messages") {
                  session.agent.state.messages.push(newerMessage);
                } else if (change === "transcript append and replacement") {
                  session.agent.state.messages = [newerMessage];
                }
                currentMessages = session.agent.state.messages;
                changedBeforePublication = true;
                return pending;
              }
              const context = await pending;
              if (change === "reader failure") {
                changedBeforePublication = true;
                throw readerFailure;
              }
              if (change !== "navigation after commit") {
                queueMicrotask(supersede);
              }
              return context;
            },
          };
        });
      const append = manager.appendCompactionAsync.bind(manager);
      const interceptedAppend =
        change === "navigation after commit"
          ? vi.spyOn(manager, "appendCompactionAsync").mockImplementation(async (...args) => {
              const id = await append(...args);
              queueMicrotask(supersede);
              return id;
            })
          : undefined;
      let promptMessageStarted = false;
      if (operation === "admission") {
        session.subscribe((event) => {
          promptMessageStarted ||= event.type === "message_start";
        });
        session[agentSessionSetPromptPreparation](async () => async (start) => {
          await session.compact().catch(() => undefined);
          start();
        });
      }
      let failure: unknown;
      try {
        await (operation === "compaction"
          ? session.compact()
          : operation === "preflight" || operation === "admission"
            ? session.prompt(
                "continue after context publication",
                operation === "preflight" ? { persistedUserIdempotencyKey } : undefined,
              )
            : session.navigateTree(selectedId, { summarize: true }));
      } catch (error) {
        failure = error;
      } finally {
        intercepted.mockRestore();
        interceptedAppend?.mockRestore();
      }
      expect(changedBeforePublication).toBe(true);
      assert(failure instanceof Error, "Context publication must report its failure");
      expect(isRecordedModelFallbackStop(failure)).toBe(true);
      expect(session.agent.state.messages).toBe(currentMessages);
      const assertUnavailable = async (error: Error, rows: unknown[]) => {
        expect(() => session.messages).toThrow(error);
        await expect(session.prompt("blocked after context publication failure")).rejects.toBe(
          error,
        );
        expect(await loadTranscriptEvents(target)).toEqual(rows);
        expect(streamMocks.streamSimple).not.toHaveBeenCalled();
      };
      if (transcriptAppend) {
        assert(appendedDuringRead, "Synchronous SDK append must commit while the read is pending");
        expect((await loadTranscriptEvents(target)).at(-1)).toMatchObject({
          id: appendedDuringRead,
        });
      }
      if (change === "reader failure" || change === "aborted publication") {
        expect(failure).toMatchObject({
          message: expect.stringContaining("committed, but context publication failed"),
          cause:
            change === "reader failure"
              ? readerFailure
              : expect.objectContaining({ name: "AbortError" }),
        });
        expect(manager.getLeafId()).not.toBeNull();
        const rowsBeforePrompt = await loadTranscriptEvents(target);
        if (rowsBefore) {
          expect(rowsBeforePrompt.slice(0, rowsBefore.length)).toEqual(rowsBefore);
          expect(rowsBeforePrompt.slice(rowsBefore.length)).toMatchObject([{ type: "compaction" }]);
        }
        await assertUnavailable(failure, rowsBeforePrompt);
        expect(promptMessageStarted).toBe(false);
        expect(accounted).not.toHaveBeenCalled();
        return;
      }
      expect(failure).toMatchObject({
        message: expect.stringContaining("committed, but context publication failed"),
        cause: transcriptAppend
          ? expect.objectContaining({ message: expect.stringContaining("changed") })
          : new Error(
              change === "navigation" || change === "navigation after commit"
                ? "Session transcript navigation changed before publication"
                : "Active session messages changed before publication",
            ),
      });
      if (change === "navigation" || change === "navigation after commit") {
        expect(manager.getLeafId()).toBeNull();
        expect(manager.getBranch()).toEqual([]);
      } else if (change !== "transcript append") {
        expect(session.agent.state.messages.at(-1)).toBe(newerMessage);
      }
      if (!change.endsWith("replacement")) {
        await assertUnavailable(failure, await loadTranscriptEvents(target));
      } else {
        expect(session.messages).toBe(currentMessages);
      }
      expect(accounted).not.toHaveBeenCalled();
      const committedType = operation === "compaction" ? "compaction" : "branch_summary";
      const reopened = await SessionManager.openAsync(target, root);
      expect(reopened.getEntries().filter((entry) => entry.type === committedType)).toHaveLength(1);
    },
  );

  it.each([
    ...(["label", "summary", "compaction"] as const).flatMap((entry) =>
      [false, true].map((committed) => ({ entry, committed, superseded: false })),
    ),
    { entry: "label" as const, committed: true, superseded: true },
  ])(
    "settles $entry context acquisition failure with committed=$committed, superseded=$superseded",
    async ({ entry, committed, superseded }) => {
      const root = realpathSync(tempDirs.make("openclaw-tree-append-publication-"));
      const target = {
        agentId: "main",
        sessionId: "tree-append-publication",
        sessionKey: "agent:main:tree-append-publication",
        storePath: path.join(root, "sessions.json"),
      };
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      const source = SessionManager.open(target, root);
      seedHistory(source);
      if (entry === "compaction") {
        source.appendMessage(makeUserMessage("pending request after an interrupted run", 5));
      }
      const selectedId = source.getEntries()[1]!.id;
      const manager = await SessionManager.openAsync(target, root, {
        maxBytes: 4096,
        maxEvents: 3,
      });
      const { session } = await createTestSession({
        sessionManager: manager,
        settingsManager: settings(),
        resourceLoader: createResourceLoader(
          new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
            ["session_before_tree", [async () => ({ summary: { summary: "saved branch" } })]],
            [
              "session_before_compact",
              [async (event) => compactionResult(event as BeforeCompactionEvent)],
            ],
          ]),
        ),
      });
      const messagesBefore = session.agent.state.messages;
      const leafBefore = manager.getLeafId();
      const rowsBefore = await loadTranscriptEvents(target);
      const readFailure = new Error("Selected context reader failed");
      const withWorker = metadataRuntime.withSessionMetadataWorker;
      const workerFailure =
        entry === "compaction"
          ? vi
              .spyOn(metadataRuntime, "withSessionMetadataWorker")
              .mockImplementation(async (...args) => {
                if (!committed) {
                  throw readFailure;
                }
                const receipt = await withWorker(...args);
                assert(
                  isRecord(receipt) && "committedVersion" in receipt,
                  "The real compaction worker must return its committed receipt",
                );
                return Object.assign(receipt, { viewFailure: readFailure });
              })
          : undefined;
      const prepare = manager[sessionManagerPrepareHistoryRead].bind(manager);
      let selectedReads = 0;
      const intercepted = vi
        .spyOn(manager, sessionManagerPrepareHistoryRead)
        .mockImplementation((signal) => {
          const history = prepare(signal);
          return {
            ...history,
            readSelectedContext: async (...args) => {
              const selected = await history.readSelectedContext(...args);
              if (++selectedReads === (committed ? 2 : 1)) {
                if (superseded) {
                  manager.resetLeaf();
                }
                throw readFailure;
              }
              return selected;
            },
          };
        });
      let failure: unknown;
      let workerCallCount: number | undefined;
      try {
        if (entry === "compaction") {
          await session.compact();
        } else {
          await session.navigateTree(
            selectedId,
            entry === "label" ? { label: "saved label" } : { summarize: true },
          );
        }
      } catch (error) {
        failure = error;
      } finally {
        workerCallCount = workerFailure?.mock.calls.length;
        intercepted.mockRestore();
        workerFailure?.mockRestore();
      }
      expect(selectedReads).toBe(entry === "compaction" ? 0 : committed ? 2 : 1);
      if (workerFailure) {
        expect(workerCallCount).toBe(1);
      }
      assert(failure instanceof Error, "Selected context acquisition must fail");
      expect(session.agent.state.messages).toBe(messagesBefore);
      const rows = await loadTranscriptEvents(target);
      expect(rows.slice(0, rowsBefore.length)).toEqual(rowsBefore);
      if (committed) {
        expect(rows.slice(rowsBefore.length)).toMatchObject([
          { type: entry === "summary" ? "branch_summary" : entry },
        ]);
        expect(failure.message).toContain("committed");
        expect(isRecordedModelFallbackStop(failure)).toBe(true);
        if (superseded) {
          expect(manager.getLeafId()).toBeNull();
          expect(manager.getBranch()).toEqual([]);
          expect(() => session.messages).toThrow(failure);
          const next = await manager.appendMessageWithTranscriptAnchorAsync(
            makeUserMessage("continue newer selection", 9),
          );
          expect((await loadTranscriptEvents(target)).at(-1)).toMatchObject({
            id: next.entryId,
            parentId: null,
          });
          session.agent.state.messages = manager.buildSessionContext().messages;
          expect(session.messages).toEqual([makeUserMessage("continue newer selection", 9)]);
          return;
        }
        expect(() => manager.getBranch()).toThrow("Session entry committed");
        expect(() => session.messages).toThrow(failure);
        await expect(session.prompt("must not reuse rejected context")).rejects.toBe(failure);
        if (entry === "compaction") {
          expect(session.agent.state.messages.at(-1)?.role).toBe("user");
          await expect(session.agent.continue()).rejects.toBe(failure);
        }
        await expect(
          session.agent.prompt(makeUserMessage("direct rejected prompt", 9)),
        ).rejects.toBe(failure);
        expect(await loadTranscriptEvents(target)).toEqual(rows);
        expect(streamMocks.streamSimple).not.toHaveBeenCalled();
      } else {
        expect(failure).toBe(readFailure);
        expect(isRecordedModelFallbackStop(failure)).toBe(false);
        expect(rows).toEqual(rowsBefore);
        expect(manager.getLeafId()).toBe(leafBefore);
        expect(session.messages).toBe(messagesBefore);
        streamMocks.streamSimple.mockImplementation(() =>
          createAssistantResultStream(
            createAssistant(testModel, [{ type: "text", text: "still usable" }]),
          ),
        );
        await session.prompt("continue unchanged context");
        expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([false, true])(
    "navigates to an evicted branch with summary=%s without installing raw history",
    async (summarize) => {
      const root = realpathSync(tempDirs.make("openclaw-tree-evicted-"));
      const target = {
        agentId: "main",
        sessionId: "tree-evicted",
        sessionKey: "agent:main:tree-evicted",
        storePath: path.join(root, "sessions.json"),
      };
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      const source = SessionManager.open(target, root);
      // A shared prefix larger than one acquisition page must stay in the worker.
      seedHistory(source, summarize ? "x".repeat(4 * 1024 * 1024 + 1) : "old prompt");
      const selectedId = source.getEntries()[1]!.id;
      const abandonedIds = source
        .getEntries()
        .slice(2)
        .map((entry) => entry.id);
      const manager = await SessionManager.openAsync(target, root, {
        maxBytes: 4096,
        maxEvents: 2,
      });
      expect(manager.getEntry(selectedId)).toBeUndefined();
      let preparedIds: string[] | undefined;
      const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
        [
          "session_before_tree",
          [
            async (event) => {
              const preparation = (
                event as Extract<ExtensionEvent, { type: "session_before_tree" }>
              ).preparation;
              expect(preparation.commonAncestorId).toBe(selectedId);
              preparedIds = preparation.entriesToSummarize.map((entry) => entry.id);
              return summarize ? { summary: { summary: "abandoned branch summary" } } : undefined;
            },
          ],
        ],
      ]);
      const { session } = await createTestSession({
        sessionManager: manager,
        settingsManager: settings(),
        resourceLoader: createResourceLoader(handlers),
      });
      // SDK restoration appends the missing thinking metadata to the abandoned branch.
      const initializedThinkingId = manager.getLeafId();
      expect(manager.getLeafEntry()).toMatchObject({
        type: "thinking_level_change",
        parentId: abandonedIds.at(-1),
      });

      const result = await session.navigateTree(selectedId, {
        summarize,
        label: "selected branch",
      });

      expect(result.cancelled).toBe(false);
      expect(preparedIds).toEqual([...abandonedIds, initializedThinkingId]);
      expect(JSON.stringify(session.messages)).toContain("old answer");
      expect(JSON.stringify(session.messages)).not.toContain("recent answer");
      expect(manager.getLabel(result.summaryEntry?.id ?? selectedId)).toBe("selected branch");
      expect(
        manager.getEntries().filter((entry) => entry.type === "message").length,
      ).toBeLessThanOrEqual(2);
      for (const id of abandonedIds) {
        expect(manager.getEntry(id)).toBeUndefined();
      }
      const reopened = await SessionManager.openAsync(target, root);
      expect(reopened.getBranch().some((entry) => abandonedIds.includes(entry.id))).toBe(false);
      if (summarize) {
        expect(JSON.stringify(session.messages)).toContain("abandoned branch summary");
        expect(reopened.getEntry(result.summaryEntry!.id)).toMatchObject({ parentId: selectedId });
      }
    },
  );

  it("compacts evicted 5 MiB tool history and publishes its retained bytes after commit", async () => {
    const root = realpathSync(tempDirs.make("openclaw-compaction-oversized-tool-"));
    const target = {
      agentId: "main",
      sessionId: "compaction-oversized-tool",
      sessionKey: "agent:main:compaction-oversized-tool",
      storePath: path.join(root, "sessions.json"),
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const source = SessionManager.open(target, root);
    seedHistory(source);
    const manager = await SessionManager.openAsync(target, root, { maxBytes: 4096, maxEvents: 3 });
    const retainedId = (
      await manager.appendMessageWithTranscriptAnchorAsync(
        makeUserMessage("retained tool request", 5),
      )
    ).entryId;
    await manager.appendMessageAsync(
      createAssistant(
        testModel,
        [{ type: "toolCall", id: "large-result", name: "read", arguments: {} }],
        "toolUse",
      ),
    );
    const toolResult = {
      role: "toolResult" as const,
      toolCallId: "large-result",
      toolName: "read",
      content: [{ type: "text" as const, text: "retained tool output" }],
      details: { bytes: "x".repeat(5 * 1024 * 1024) },
      isError: false,
      timestamp: 6,
    };
    const toolId = (await manager.appendMessageWithTranscriptAnchorAsync(toolResult)).entryId;
    await manager.appendMessageAsync(
      createAssistant(testModel, [{ type: "text", text: "retained answer" }]),
    );
    expect(manager.getEntry(toolId)).toBeUndefined();
    const summarize = vi.fn(async (_event: unknown) => ({
      compaction: {
        summary: "condensed earlier turns",
        firstKeptEntryId: retainedId,
        tokensBefore: 1024,
      },
    }));
    const { session } = await createTestSession({
      sessionManager: manager,
      settingsManager: settings(),
      resourceLoader: createResourceLoader(new Map([["session_before_compact", [summarize]]])),
    });
    const before = await loadTranscriptEvents(target);

    await expect(session.compact()).resolves.toMatchObject({ firstKeptEntryId: retainedId });

    expect(summarize).toHaveBeenCalledOnce();
    expect(summarize.mock.calls[0]?.[0]).toMatchObject({
      branchEntries: expect.arrayContaining([
        expect.objectContaining({ id: toolId, message: toolResult }),
      ]),
    });
    expect(session.messages).toContainEqual(toolResult);
    const after = await loadTranscriptEvents(target);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toMatchObject([
      { type: "compaction", firstKeptEntryId: retainedId },
    ]);
    const reopened = await SessionManager.openAsync(target, root);
    expect(reopened.getEntry(toolId)).toMatchObject({ message: toolResult });
    expect(reopened.buildSessionContext().messages).toContainEqual(toolResult);
  });

  it("does not append when a compaction extension rejects the finalized summary", async () => {
    const dir = tempDirs.make("openclaw-rejected-compaction-");
    const target = {
      agentId: "main",
      sessionId: "rejected-compaction-reopen",
      sessionKey: "agent:main:rejected-compaction-reopen",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(target, {
      sessionId: target.sessionId,
      updatedAt: 1,
    });
    await appendTranscriptMessage(target, {
      cwd: dir,
      message: { role: "user", content: "authoritative question", timestamp: 1 },
    });
    const sessionManager = SessionManager.open(target, dir);
    sessionManager.appendMessage(
      createAssistant(testModel, [{ type: "text", text: "authoritative answer" }]),
    );
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      ["session_before_compact", [async () => ({ cancel: true })]],
    ]);
    const { session } = await createTestSession({
      sessionManager,
      resourceLoader: createResourceLoader(handlers),
    });
    const persistedBefore = await loadTranscriptEvents(target);
    const contextBefore = sessionManager.buildSessionContext();

    await expect(session.compact()).rejects.toThrow("Compaction cancelled");

    sessionManager.flushPendingPersistence();
    const persistedAfterRejection = await loadTranscriptEvents(target);
    expect(JSON.stringify(persistedAfterRejection)).toBe(JSON.stringify(persistedBefore));
    expect(
      persistedAfterRejection.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "type" in entry &&
          entry.type === "compaction",
      ),
    ).toBe(false);

    const databasePath = resolveSqliteTargetFromSessionStorePath(target.storePath).path;
    expect(await closeOpenClawAgentDatabaseByPathAsync(databasePath)).toBe(true);
    const reopened = SessionManager.open(target, dir);
    try {
      expect(reopened.getBranch()).toEqual(persistedBefore.slice(1));
      expect(reopened.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
      expect(reopened.buildSessionContext()).toEqual(contextBefore);
    } finally {
      await closeOpenClawAgentDatabaseByPathAsync(databasePath);
    }
  });

  it.each(["compaction", "tree"] as const)(
    "does not publish a cancelled %s while waiting for the writer",
    async (operation) => {
      const root = realpathSync(tempDirs.make("openclaw-context-admission-"));
      const target = {
        agentId: "main",
        sessionId: "context-admission",
        sessionKey: "agent:main:context-admission",
        storePath: path.join(root, "sessions.json"),
      };
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      const manager = SessionManager.open(target, root);
      const firstUser = seedHistory(manager);
      const summaryReady = createDeferred();
      const published: string[] = [];
      const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
        [
          "session_before_compact",
          [
            async (event) => {
              summaryReady.resolve();
              return compactionResult(event as BeforeCompactionEvent);
            },
          ],
        ],
        [
          "session_before_tree",
          [
            async () => {
              summaryReady.resolve();
              return { summary: { summary: "abandoned branch" } };
            },
          ],
        ],
        [
          "session_compact",
          [
            async () => {
              published.push("compaction");
            },
          ],
        ],
        [
          "session_tree",
          [
            async () => {
              published.push("tree");
            },
          ],
        ],
      ]);
      const { session } = await createTestSession({
        sessionManager: manager,
        settingsManager: settings(),
        resourceLoader: createResourceLoader(handlers),
      });
      const before = await loadTranscriptEvents(target);
      const messagesBefore = [...session.messages];
      const release = createDeferred();
      const entered = createDeferred();
      const reservation = runOpenClawAgentWriteAdmission(
        toDatabaseOptions(resolveSqliteReadScope(target)),
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      await entered.promise;
      const work =
        operation === "compaction"
          ? session.compact()
          : session.navigateTree(firstUser, { summarize: true, label: "cancelled branch" });
      const outcome = work.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      try {
        await summaryReady.promise;
        // The summary continuations reach the held writer before cancellation.
        await nextTurn();
        if (operation === "compaction") {
          session.abortCompaction();
        } else {
          session.abortBranchSummary();
        }
        release.resolve();
        const result = await outcome;
        if (operation === "compaction") {
          expect(result).toMatchObject({
            status: "rejected",
            error: new Error("Compaction cancelled"),
          });
        } else {
          expect(result).toMatchObject({
            status: "fulfilled",
            value: { cancelled: true, aborted: true },
          });
        }
        expect(await loadTranscriptEvents(target)).toEqual(before);
        expect(session.messages).toEqual(messagesBefore);
        expect(published).toEqual([]);
      } finally {
        release.resolve();
        await Promise.allSettled([reservation, work]);
      }
    },
  );

  it("does not adopt a successor's context authority after in-memory summarization", async () => {
    const manager = SessionManager.inMemory();
    seedHistory(manager);
    const summaryReady = createDeferred();
    const release = createDeferred();
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      [
        "session_before_compact",
        [
          async (event) => {
            summaryReady.resolve();
            await release.promise;
            return compactionResult(event as BeforeCompactionEvent);
          },
        ],
      ],
    ]);
    const { session } = await createTestSession({
      sessionManager: manager,
      settingsManager: settings(),
      resourceLoader: createResourceLoader(handlers),
    });
    const before = manager.getEntries();
    const messagesBefore = [...session.messages];
    const accounted: string[] = [];
    session[agentSessionSetContextReplacementHook](
      () => accounted.push("original"),
      () => {},
    );
    const work = session.compact();
    const settled = work.catch((error: unknown) => error);
    try {
      await summaryReady.promise;
      session[agentSessionSetContextReplacementHook](
        () => accounted.push("successor"),
        () => {},
      );
      release.resolve();
      expect(await settled).toEqual(new Error("Compaction cancelled"));
      expect(manager.getEntries()).toEqual(before);
      expect(session.messages).toEqual(messagesBefore);
      expect(accounted).toEqual([]);
    } finally {
      release.resolve();
      await settled;
    }
  });
});

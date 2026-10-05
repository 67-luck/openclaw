import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { seedUnindexedTranscriptForTest } from "../../config/sessions/session-accessor.sqlite-import.test-support.js";
import { replaceTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { MAX_VISIBLE_MESSAGE_MAX_BYTES } from "../../config/sessions/session-accessor.sqlite-visible-cursor.js";
import { resolveSessionTranscriptDatabasePath } from "../../config/sessions/session-accessor.transcript-target.js";
import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import { loadTranscriptEvents } from "../../config/sessions/session-transcript-events.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import type { ToolResultMessage } from "../../llm/types.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { isRecordedModelFallbackStop } from "../model-fallback-stop.js";
import type { AgentMessage } from "../runtime/index.js";
import { sessionManagerPrepareHistoryRead } from "../sessions/session-manager-history.js";
import { sessionManagerRewriteTranscript } from "../sessions/session-manager-rewrite.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { createToolResultPromptProjectionState } from "./session-prompt-state.js";
import {
  getBranchMessages,
  useTranscriptRewriteFixtures,
} from "./transcript-rewrite.test-support.js";

const { createPersistedRewriteTarget } = useTranscriptRewriteFixtures(afterEach);
let rewriteTranscriptEntriesInSessionManager: typeof import("./transcript-rewrite.js").rewriteTranscriptEntriesInSessionManager;
let repairRejectedThinkingReplayInSessionManager: typeof import("./thinking-replay-repair.js").repairRejectedThinkingReplayInSessionManager;
let repairRejectedCompactionReplayInSessionManager: typeof import("./thinking-replay-repair.js").repairRejectedCompactionReplayInSessionManager;
let rewindRejectedFinalizationEntry: typeof import("./run/attempt-transcript-helpers.js").rewindRejectedFinalizationEntry;
let normalizeCompactionRecoveryTranscriptTail: typeof import("./run/attempt-transcript-helpers.js").normalizeCompactionRecoveryTranscriptTail;
let handleEmbeddedAttemptMidTurnPrecheck: typeof import("./run/attempt-prompt-preflight.js").handleEmbeddedAttemptMidTurnPrecheck;
let truncateOversizedToolResultsInSessionManager: typeof import("./tool-result-recovery.js").truncateOversizedToolResultsInSessionManager;

beforeAll(async () => {
  ({ rewriteTranscriptEntriesInSessionManager } = await import("./transcript-rewrite.js"));
  ({
    repairRejectedThinkingReplayInSessionManager,
    repairRejectedCompactionReplayInSessionManager,
  } = await import("./thinking-replay-repair.js"));
  ({ rewindRejectedFinalizationEntry, normalizeCompactionRecoveryTranscriptTail } =
    await import("./run/attempt-transcript-helpers.js"));
  ({ handleEmbeddedAttemptMidTurnPrecheck } = await import("./run/attempt-prompt-preflight.js"));
  ({ truncateOversizedToolResultsInSessionManager } = await import("./tool-result-recovery.js"));
});

describe("bounded transcript rewrites", () => {
  it("admits a complete oversized legacy result by its final duplicate kind before rewriting", async () => {
    const { directory, target } = await createPersistedRewriteTarget("oversized-last-kind");
    const replacement: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "oversized-last-kind",
      toolName: "read",
      content: [{ type: "text", text: "Recovered result" }],
      isError: false,
      timestamp: 2,
    };
    const oversizedJson =
      '{"type":"custom",' +
      JSON.stringify({
        type: "message",
        id: "oversized",
        parentId: "user",
        timestamp: new Date(2).toISOString(),
        message: {
          ...replacement,
          content: [{ type: "text", text: "x".repeat(MAX_VISIBLE_MESSAGE_MAX_BYTES) }],
        },
      }).slice(1);
    expect(Buffer.byteLength(oversizedJson)).toBeGreaterThan(MAX_VISIBLE_MESSAGE_MAX_BYTES);
    const events = [
      JSON.stringify({ type: "session", id: target.sessionId, version: 3, cwd: directory }),
      JSON.stringify({
        type: "message",
        id: "user",
        parentId: null,
        message: { role: "user", content: "read", timestamp: 1 },
      }),
      oversizedJson,
    ];
    await seedUnindexedTranscriptForTest({
      ...target,
      entry: { sessionId: target.sessionId, updatedAt: 1 },
      events: events.map((event_json, seq) => ({
        session_id: target.sessionId,
        seq,
        event_json,
        created_at: seq,
      })),
    });
    const manager = await SessionManager.openBoundedAsync(target, { maxBytes: 4096, maxEvents: 1 });
    expect(manager.getEntry("oversized")).toBeUndefined();
    await expect(
      rewriteTranscriptEntriesInSessionManager({
        sessionManager: manager,
        replacements: [{ entryId: "oversized", message: replacement }],
      }),
    ).resolves.toMatchObject({ changed: true, rewrittenEntries: 1 });
    expect(manager.getLeafEntry()).toMatchObject({ type: "message", message: replacement });
    const database = openOpenClawAgentDatabase({
      agentId: target.agentId,
      path: resolveSessionTranscriptDatabasePath(target),
    });
    const unchanged = database.db.prepare(
      "SELECT event_json = ? AS unchanged FROM transcript_events WHERE session_id = ? AND seq = ?",
    );
    for (const [seq, event] of events.entries()) {
      expect(unchanged.get(event, target.sessionId, seq)).toEqual({ unchanged: 1 });
    }
  });

  it.each([false, true])(
    "preserves parentless canonical ancestry in a tail rewrite (unchanged root requested=%s)",
    async (includeUnchangedRoot) => {
      const { target } = await createPersistedRewriteTarget("parentless-rewrite");
      const source = await SessionManager.openAsync(target);
      const messages = ["root", "legacy parent", "tail"].map((content, timestamp) => ({
        role: "user" as const,
        content,
        timestamp,
      }));
      const entries = messages.map((message, index) => ({
        type: "message",
        id: `legacy-${index}`,
        ...(index === 1 ? {} : { parentId: index === 0 ? null : "legacy-1" }),
        timestamp: new Date(index).toISOString(),
        message,
      }));
      expect(replaceTranscriptEventsSync(target, [source.getHeader(), ...entries])).toBe(true);
      const original = await loadTranscriptEvents(target);
      const bounded = await SessionManager.openBoundedAsync(target, {
        maxBytes: 4096,
        maxEvents: 1,
      });
      const replacement = { ...messages[2]!, content: "repaired" };
      await expect(
        rewriteTranscriptEntriesInSessionManager({
          sessionManager: bounded,
          replacements: [
            ...(includeUnchangedRoot ? [{ entryId: "legacy-0", message: messages[0]! }] : []),
            { entryId: "legacy-2", message: replacement },
          ],
        }),
      ).resolves.toMatchObject({ changed: true, rewrittenEntries: 1 });
      expect((await loadTranscriptEvents(target)).slice(0, original.length)).toEqual(original);
      const reopened = await SessionManager.openAsync(target);
      messages[2] = replacement;
      expect(getBranchMessages(reopened)).toEqual(messages);
    },
  );

  it.each(["rewrite-return", "context-read-return"] as const)(
    "reports committed truncation when a newer selection supersedes projection publication at %s",
    async (boundary) => {
      const { target } = await createPersistedRewriteTarget("truncation-publication");
      const manager = await SessionManager.openBoundedAsync(target, {
        maxBytes: 4096,
        maxEvents: 3,
      });
      await manager.appendMessageAsync({ role: "user", content: "run tool", timestamp: 1 });
      await manager.appendMessageAsync({
        role: "toolResult",
        toolCallId: "truncation-call",
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(16_384) }],
        isError: false,
        timestamp: 2,
      });
      await manager.appendMessageAsync(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "finished" }] }),
      );
      const projectionState = createToolResultPromptProjectionState();
      const supersede = () => {
        manager.resetLeaf();
        projectionState.sourceHashByKey.set("newer-selection", "synthetic-source-hash");
        changedBeforePublication = true;
      };
      let changedBeforePublication = false;
      const prepare = manager[sessionManagerPrepareHistoryRead].bind(manager);
      const intercepted =
        boundary === "context-read-return"
          ? vi.spyOn(manager, sessionManagerPrepareHistoryRead).mockImplementation((signal) => {
              const history = prepare(signal);
              return {
                ...history,
                readContext: async () => {
                  const context = await history.readContext();
                  queueMicrotask(supersede);
                  return context;
                },
              };
            })
          : undefined;
      const rewrite = manager[sessionManagerRewriteTranscript].bind(manager);
      const interceptedRewrite =
        boundary === "rewrite-return"
          ? vi.spyOn(manager, sessionManagerRewriteTranscript).mockImplementation(async (input) => {
              const result = await rewrite(input);
              supersede();
              return result;
            })
          : undefined;
      let failure: unknown;
      try {
        await truncateOversizedToolResultsInSessionManager({
          sessionManager: manager,
          contextWindowTokens: 128_000,
          maxCharsOverride: 1024,
          aggregateMaxCharsOverride: 4096,
          projectionState,
        });
      } catch (error) {
        failure = error;
      } finally {
        intercepted?.mockRestore();
        interceptedRewrite?.mockRestore();
      }
      expect(changedBeforePublication).toBe(true);
      expect(failure).toMatchObject({ message: expect.stringContaining("truncation committed") });
      expect(isRecordedModelFallbackStop(failure)).toBe(true);
      expect(manager.getLeafId()).toBeNull();
      expect(projectionState.sourceHashByKey.get("newer-selection")).toBe("synthetic-source-hash");
      const reopened = await SessionManager.openAsync(target);
      const result = reopened
        .getBranch()
        .find((entry) => entry.type === "message" && entry.message.role === "toolResult");
      expect(result).toBeDefined();
      expect(JSON.stringify(result)).toContain("truncated");
      expect(JSON.stringify(result).length).toBeLessThan(4096);
    },
  );

  it("keeps an oversized latest user readable across rewrite and suffix cleanup", async () => {
    const { target } = await createPersistedRewriteTarget("oversized-user-rewrite");
    const manager = SessionManager.openBounded(target, { maxBytes: 4096, maxEvents: 8 });
    const first = await manager.appendMessageWithTranscriptAnchorAsync({
      role: "user",
      content: "initial request",
      timestamp: 1,
    });
    const latestUser = { role: "user" as const, content: "x".repeat(8192), timestamp: 2 };
    const originalTail = await manager.appendMessageWithTranscriptAnchorAsync(latestUser);
    expect(manager.getEntry(originalTail.entryId)).toMatchObject({ message: latestUser });
    const originalRows = await loadTranscriptEvents(target);
    const replacement = {
      role: "user" as const,
      content: "repaired initial request",
      timestamp: 1,
    };

    await expect(
      rewriteTranscriptEntriesInSessionManager({
        sessionManager: manager,
        replacements: [{ entryId: first.entryId, message: replacement }],
      }),
    ).resolves.toMatchObject({ changed: true, rewrittenEntries: 1 });

    const rows = await loadTranscriptEvents(target);
    expect(rows.slice(0, originalRows.length)).toEqual(originalRows);
    const rewrittenTail = rows
      .filter(isIndexedSessionEntry)
      .findLast(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          entry.message.content === latestUser.content,
      );
    if (!rewrittenTail) {
      throw new Error("missing committed oversized user rewrite");
    }
    expect(rewrittenTail.id).not.toBe(originalTail.entryId);
    expect(manager.getEntry(rewrittenTail.id)).toMatchObject({ message: latestUser });
    expect(
      manager
        .getEntries()
        .findLast((entry) => entry.type === "message" && entry.message.role === "user"),
    ).toMatchObject({ id: rewrittenTail.id, message: latestUser });
    expect((await manager[sessionManagerPrepareHistoryRead]().readContext()).messages).toEqual([
      replacement,
      latestUser,
    ]);

    const assistant = await manager.appendMessageWithTranscriptAnchorAsync(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "aborted answer" }],
        stopReason: "aborted",
        timestamp: 3,
      }),
    );
    expect(manager.getEntry(rewrittenTail.id)).toMatchObject({ message: latestUser });
    await expect(
      manager.removeTrailingEntriesAsync((entry) => entry.id === assistant.entryId),
    ).resolves.toBe(1);
    expect(manager.getLeafEntry()).toMatchObject({ id: rewrittenTail.id, message: latestUser });
    expect((await manager[sessionManagerPrepareHistoryRead]().readContext()).messages).toEqual([
      replacement,
      latestUser,
    ]);
  });

  it.each(["compaction", "reset"] as const)(
    "remaps an opaque %s keep marker to its rewritten retained ancestor",
    async (boundaryKind) => {
      const { directory, target } = await createPersistedRewriteTarget(
        `opaque-${boundaryKind}-rewrite`,
      );
      const manager = SessionManager.open(target, directory);
      const firstKept = manager.appendMessage({
        role: "user",
        content: "original kept request",
        timestamp: 1,
      });
      manager.appendMessage({ role: "user", content: "retained tail", timestamp: 2 });
      replaceTranscriptEventsSync(target, [
        ...(await loadTranscriptEvents(target)),
        {
          type: "future-metadata",
          id: "opaque-keep",
          parentId: firstKept,
          data: { preserved: true },
        },
      ]);
      await manager.reloadPersistedTranscriptAsync();
      if (boundaryKind === "compaction") {
        await manager.appendCompactionAsync("kept summary", "opaque-keep", 100);
      } else {
        await manager.appendResetBoundaryAsync("new", "opaque-keep");
      }
      await manager.appendMessageAsync({ role: "user", content: "current request", timestamp: 3 });
      await waitForSessionTranscriptProjection(target);
      const originalRows = await loadTranscriptEvents(target);

      await expect(
        rewriteTranscriptEntriesInSessionManager({
          sessionManager: manager,
          replacements: [
            {
              entryId: firstKept,
              message: { role: "user", content: "repaired kept request", timestamp: 1 },
            },
          ],
        }),
      ).resolves.toMatchObject({ changed: true, rewrittenEntries: 1 });

      const rows = await loadTranscriptEvents(target);
      expect(rows.slice(0, originalRows.length)).toEqual(originalRows);
      const entries = rows.filter(isIndexedSessionEntry);
      const rewrittenKept = entries.findLast(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          entry.message.content === "repaired kept request",
      );
      expect(rewrittenKept).toBeDefined();
      expect(rewrittenKept?.id).not.toBe(firstKept);
      expect(entries.findLast((entry) => entry.type === boundaryKind)).toMatchObject({
        firstKeptEntryId: rewrittenKept?.id,
      });
      const reopened = await SessionManager.openAsync(target);
      expect(
        (await reopened[sessionManagerPrepareHistoryRead]().readContext()).messages,
      ).toMatchObject([
        ...(boundaryKind === "compaction"
          ? [{ role: "compactionSummary", summary: "kept summary" }]
          : []),
        { role: "user", content: "repaired kept request" },
        { role: "user", content: "retained tail" },
        { role: "user", content: "current request" },
      ]);
    },
  );

  it.each([1, 2])(
    "selects a custom-only branch within its %i-event context window",
    async (maxEvents) => {
      const { target } = await createPersistedRewriteTarget("custom-only-navigation");
      const manager = SessionManager.openBounded(target, { maxBytes: 4096, maxEvents });
      const firstId = await manager.appendCustomMessageEntryAsync("navigation", "first", false);
      const selectedId = await manager.appendCustomMessageEntryAsync("navigation", "second", false);
      await manager.appendMessageAsync({ role: "user", content: "later branch", timestamp: 1 });

      await manager.branchAsync(selectedId);

      expect(
        (await manager[sessionManagerPrepareHistoryRead]().readContext()).messages,
      ).toMatchObject(
        ["first", "second"].slice(-maxEvents).map((content) => ({
          role: "custom",
          customType: "navigation",
          content,
        })),
      );
      expect(manager.getEntry(firstId)).toMatchObject({ type: "custom_message", content: "first" });
    },
  );

  it("keeps a root branch summary visible after its committed bounded reload", async () => {
    const { target } = await createPersistedRewriteTarget("root-summary-navigation");
    const manager = SessionManager.openBounded(target, { maxBytes: 4096, maxEvents: 2 });
    await manager.appendMessageAsync({ role: "user", content: "old branch", timestamp: 1 });

    await manager.branchWithSummaryAsync(null, "Selected root summary");

    expect(
      (await manager[sessionManagerPrepareHistoryRead]().readContext()).messages,
    ).toMatchObject([{ role: "branchSummary", summary: "Selected root summary", fromId: "root" }]);
  });

  it.each([
    { storage: "persisted", predecessor: "user" },
    { storage: "persisted", predecessor: "toolResult" },
    { storage: "detached", predecessor: "toolResult" },
  ] as const)(
    "publishes $storage recovery and cleanup across a $predecessor boundary with an unchanged 5 MiB result",
    async ({ storage, predecessor }) => {
      const fixture =
        storage === "persisted"
          ? await createPersistedRewriteTarget("oversized-recovery")
          : undefined;
      const manager = fixture
        ? SessionManager.openBounded(fixture.target, { maxBytes: 4096, maxEvents: 16 })
        : SessionManager.inMemory();
      await manager.appendMessageAsync({ role: "user", content: "run tool", timestamp: 1 });
      const original = {
        role: "toolResult",
        toolCallId: "oversized_call",
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(5 * 1024 * 1024) }],
        isError: false,
        timestamp: 2,
      } satisfies ToolResultMessage;
      const sourceId = await manager.appendMessageAsync(original);
      if (!sourceId) {
        throw new Error("missing canonical tool result");
      }
      const unchanged = {
        ...original,
        toolCallId: "retained_call",
        content: [{ type: "text", text: "complete tool metadata" }],
        details: { bytes: "y".repeat(5 * 1024 * 1024) },
        timestamp: 3,
      } satisfies ToolResultMessage;
      await manager.appendMessageAsync(unchanged);
      const continuation =
        predecessor === "user"
          ? { role: "user" as const, content: "Continue from those results", timestamp: 4 }
          : undefined;
      if (continuation) {
        await manager.appendMessageAsync(continuation);
      }
      await manager.appendMessageAsync(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "finished" }], timestamp: 5 }),
      );
      if (fixture) {
        expect(manager.getEntry(sourceId)).toBeUndefined();
      }

      const activeSession = { agent: { state: { messages: [] as AgentMessage[] } } };
      const result = await handleEmbeddedAttemptMidTurnPrecheck({
        attempt: {
          provider: "openai",
          modelId: "test-model",
          sessionId: "oversized-recovery",
          sessionFile: "",
          contextTokenBudget: 128_000,
        },
        request: {
          route: "truncate_tool_results_only",
          estimatedPromptTokens: 2_000_000,
          promptBudgetBeforeReserve: 128_000,
          overflowTokens: 1_872_000,
          toolResultReducibleChars: 5 * 1024 * 1024,
          effectiveReserveTokens: 0,
        },
        sessionAgentId: "main",
        sessionManager: manager,
        toolResultPromptProjectionState: createToolResultPromptProjectionState(),
        prePromptMessageCount: continuation ? 5 : 4,
        replaceSessionMessages: (messages) => {
          activeSession.agent.state.messages = messages;
        },
      });

      expect(result).toMatchObject({ preflightRecovery: { handled: true, truncatedCount: 1 } });
      expect(result.promptError).toBeUndefined();
      expect(activeSession.agent.state.messages).toContainEqual(unchanged);
      const recovered = activeSession.agent.state.messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === original.toolCallId,
      );
      if (recovered?.role !== "toolResult") {
        throw new Error("missing recovered tool result");
      }
      const text = recovered.content.find((block) => block.type === "text")?.text;
      expect(text).toContain("truncated");
      expect(text?.length).toBeLessThanOrEqual(32_000);
      await expect(
        normalizeCompactionRecoveryTranscriptTail({ activeSession, sessionManager: manager }),
      ).resolves.toBe(1);
      expect(activeSession.agent.state.messages.at(-1)).toEqual(continuation ?? unchanged);
      expect(activeSession.agent.state.messages).toContainEqual(unchanged);
      expect(activeSession.agent.state.messages).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ role: "assistant" })]),
      );
      const source = fixture
        ? (await loadTranscriptEvents(fixture.target))
            .filter(isIndexedSessionEntry)
            .find((entry) => entry.id === sourceId)
        : manager.getEntry(sourceId);
      expect(source?.type === "message" ? source.message : undefined).toEqual(original);
    },
  );

  it.each([
    { mode: "bounded", opaque: false, reset: false },
    { mode: "bounded", opaque: true, reset: false },
    { mode: "unbounded", opaque: true, reset: false },
    { mode: "detached", opaque: true, reset: false },
    { mode: "bounded", opaque: true, reset: true },
    { mode: "unbounded", opaque: true, reset: true },
  ] as const)(
    "rewinds a rejected draft to its canonical result ($mode, opaque=$opaque, reset=$reset)",
    async ({ mode, opaque, reset }) => {
      const { directory, target } = await createPersistedRewriteTarget("finalization-rewind");
      const source = SessionManager.open(target, directory);
      if (reset) {
        source.appendMessage({ role: "user", content: "prior session", timestamp: 0 });
        source.appendResetBoundary("new");
      }
      const user = { role: "user" as const, content: "Read the result", timestamp: 1 };
      source.appendMessage(user);
      const toolCall = makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "retained-call", name: "read", arguments: {} }],
        stopReason: "toolUse",
        timestamp: 2,
      });
      source.appendMessage(toolCall);
      const limits = { maxBytes: 4096, maxEvents: 2 };
      let manager = await SessionManager.openBoundedAsync(target, limits);
      const result = {
        role: "toolResult" as const,
        toolCallId: "retained-call",
        toolName: "read",
        content: [{ type: "text" as const, text: "x".repeat(8192) }],
        isError: false,
        timestamp: 3,
      };
      const resultId = await manager.appendMessageAsync(result);
      const rejectedMessage = makeAgentAssistantMessage({
        content: [{ type: "text", text: "Rejected draft" }],
        timestamp: 4,
      });
      const rejectedId = await manager.appendMessageAsync(rejectedMessage);
      if (resultId === undefined || rejectedId === undefined) {
        throw new Error("Expected both transcript messages to commit");
      }
      if (opaque) {
        const entries = await loadTranscriptEvents(target);
        const rejected = entries.find(
          (entry) => isIndexedSessionEntry(entry) && entry.id === rejectedId,
        );
        if (!isIndexedSessionEntry(rejected) || rejected.type !== "message") {
          throw new Error("Missing persisted rejected draft");
        }
        expect(
          replaceTranscriptEventsSync(target, [
            ...entries.filter((entry) => !isIndexedSessionEntry(entry) || entry.id !== rejectedId),
            {
              type: "future-metadata",
              id: "opaque-result",
              parentId: resultId,
              data: "exact bytes",
            },
            { ...rejected, parentId: "opaque-result", appendMode: "side" },
            { type: "leaf", id: "selected-rejected", parentId: rejectedId, targetId: rejectedId },
          ]),
        ).toBe(true);
        await waitForSessionTranscriptProjection(target);
      }
      if (mode === "bounded") {
        if (opaque) manager = await SessionManager.openBoundedAsync(target, limits);
        expect(manager.getEntry(resultId)).toBeUndefined();
        expect(manager.getEntry(rejectedId)?.parentId).not.toBe(resultId);
      } else if (mode === "unbounded") {
        manager = await SessionManager.openAsync(target);
      } else {
        manager = SessionManager.fromEntries(await loadTranscriptEvents(target), directory);
      }
      const reopenedBounded = mode === "bounded" && opaque;
      if (reopenedBounded) {
        // Reopening admits only the draft; it does not inherit the earlier user's context start.
        expect(manager.buildSessionContext().messages).toEqual([rejectedMessage]);
        expect((await manager[sessionManagerPrepareHistoryRead]().readContext()).messages).toEqual([
          rejectedMessage,
        ]);
      }
      const before = await loadTranscriptEvents(target);
      const retainedBefore = mode === "detached" ? manager.getPersistedEntries() : [];
      const assertRewindCurrent = await rewindRejectedFinalizationEntry(manager, rejectedId);
      expect(assertRewindCurrent).not.toThrow();
      expect(manager.getLeafId()).toBe(resultId);
      expect(manager.getAppendParentId()).toBe(resultId);
      expect((await manager[sessionManagerPrepareHistoryRead]().readContext()).messages).toEqual(
        reopenedBounded ? [result] : [user, toolCall, result],
      );
      if (mode === "detached") {
        expect(manager.getPersistedEntries().slice(0, retainedBefore.length)).toEqual(
          retainedBefore,
        );
        expect(manager.getPersistedEntries().at(-1)).toMatchObject({
          type: "leaf",
          targetId: resultId,
        });
        expect(await loadTranscriptEvents(target)).toEqual(before);
      } else {
        const reopened = await SessionManager.openAsync(target);
        expect(reopened.getLeafId()).toBe(resultId);
        expect(reopened.getAppendParentId()).toBe(resultId);
        const after = await loadTranscriptEvents(target);
        expect(after.slice(0, before.length)).toEqual(before);
        expect(after.slice(before.length)).toEqual([
          expect.objectContaining({ type: "leaf", targetId: resultId }),
        ]);
      }
    },
  );

  it.each(["thinking", "compaction"] as const)(
    "repairs rejected %s replay past an evicted 5 MiB tool result",
    async (kind) => {
      const { directory, target } = await createPersistedRewriteTarget("omitted-replay-repair");
      const source = SessionManager.open(target, directory);
      source.appendMessage({ role: "user", content: "first", timestamp: 1 });
      const toolCall = {
        type: "toolCall" as const,
        id: "replay-call",
        name: "read",
        arguments: {},
      };
      const checkpoint = { data: "rejected-ciphertext", id: "cmp_rejected" };
      const rejectedId = source.appendMessage(
        makeAgentAssistantMessage({
          content: [
            ...(kind === "thinking"
              ? [{ type: "thinking" as const, thinking: "private", thinkingSignature: "sig_bad" }]
              : []),
            { type: "text", text: "visible answer" },
            toolCall,
          ],
          providerReplay:
            kind === "compaction"
              ? {
                  v: 1,
                  type: "openai-responses-compaction",
                  ...checkpoint,
                  replayIndex: 0,
                  provider: "openai",
                  api: "openai-responses",
                  model: "test-model",
                  baseUrlHash: "0123456789abcdef",
                }
              : undefined,
          stopReason: "toolUse",
          timestamp: 2,
        }),
      );
      const manager = await SessionManager.openBoundedAsync(target, {
        maxBytes: 4096,
        maxEvents: 2,
      });
      const original = {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(5 * 1024 * 1024) }],
        isError: false,
        timestamp: 3,
      } satisfies ToolResultMessage;
      const { entryId: resultId } = await manager.appendMessageWithTranscriptAnchorAsync(original);
      await manager.appendMessageAsync({ role: "user", content: "next", timestamp: 4 });
      await manager.appendMessageAsync(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "latest answer" }],
          timestamp: 5,
        }),
      );
      expect(manager.getEntry(resultId)).toBeUndefined();
      if (kind === "thinking") {
        expect(manager.getEntry(rejectedId)).toBeUndefined();
      }
      const before = await loadTranscriptEvents(target);
      if (kind === "compaction") {
        expect(
          before.filter(isIndexedSessionEntry).find((entry) => entry.id === rejectedId),
        ).toMatchObject({
          message: { providerReplay: { type: "openai-responses-compaction", ...checkpoint } },
        });
      }

      await expect(
        kind === "thinking"
          ? repairRejectedThinkingReplayInSessionManager({ sessionManager: manager })
          : repairRejectedCompactionReplayInSessionManager({ sessionManager: manager, checkpoint }),
      ).resolves.toMatchObject({ repaired: true, repairedCount: 1 });

      const messages = getBranchMessages(await SessionManager.openAsync(target));
      const assistants = messages.filter((message) => message.role === "assistant");
      expect(assistants.map((message) => message.content)).toEqual([
        [{ type: "text", text: "visible answer" }, toolCall],
        [{ type: "text", text: "latest answer" }],
      ]);
      expect(assistants.map((message) => message.providerReplay)).toEqual([undefined, undefined]);
      expect(messages.filter((message) => message.role === "toolResult")).toEqual([original]);
      expect((await loadTranscriptEvents(target)).slice(0, before.length)).toEqual(before);
      expect(manager.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
    },
  );

  it.each([
    { maxEvents: undefined, opaque: false, unchanged: false },
    { maxEvents: 3, opaque: false, unchanged: false },
    { maxEvents: 1, opaque: false, unchanged: false },
    { maxEvents: 1, opaque: true, unchanged: false },
    { maxEvents: 1, opaque: true, unchanged: true },
  ])(
    "preserves the selected logical parent across a rewrite ($maxEvents, opaque=$opaque, unchanged=$unchanged)",
    async ({ maxEvents, opaque, unchanged }) => {
      const { directory, target } = await createPersistedRewriteTarget("logical-rewrite");
      let manager = SessionManager.open(target, directory);
      const first = manager.appendMessage({ role: "user", content: "selected", timestamp: 1 });
      const firstEntry = manager.getEntry(first);
      if (firstEntry?.type !== "message") {
        throw new Error("missing logical-parent fixture message");
      }
      const abandoned = manager.appendMessage({ role: "user", content: "abandoned", timestamp: 2 });
      manager.appendLeafControl({ targetId: first, appendParentId: abandoned, appendMode: "side" });
      let current: string;
      if (opaque) {
        current = "opaque-current";
        replaceTranscriptEventsSync(target, [
          ...(await loadTranscriptEvents(target)),
          {
            type: "future-metadata",
            id: "opaque-parent",
            parentId: first,
            data: { retained: true },
          },
          {
            type: "message",
            id: current,
            parentId: "opaque-parent",
            appendMode: "side",
            timestamp: new Date(3).toISOString(),
            message: { role: "user", content: "current", timestamp: 3 },
          },
          {
            type: "leaf",
            id: "select-opaque-current",
            parentId: current,
            targetId: current,
            timestamp: new Date(3).toISOString(),
          },
        ]);
      } else {
        current = manager.appendMessage({ role: "user", content: "current", timestamp: 3 });
      }
      await waitForSessionTranscriptProjection(target);
      if (maxEvents !== undefined) {
        manager = SessionManager.openBounded(target, { maxBytes: 4096, maxEvents });
      }
      expect(getBranchMessages(manager)).toMatchObject(
        (maxEvents === 1 ? ["current"] : ["selected", "current"]).map((content) => ({
          role: "user",
          content,
        })),
      );
      const originalRows = await loadTranscriptEvents(target);
      const result = await rewriteTranscriptEntriesInSessionManager({
        sessionManager: manager,
        replacements: [
          ...(unchanged
            ? [
                {
                  entryId: first,
                  message: firstEntry.message,
                },
              ]
            : []),
          { entryId: current, message: { role: "user", content: "rewritten", timestamp: 3 } },
        ],
      });
      expect(result).toMatchObject({ changed: true, rewrittenEntries: 1 });
      const rewrittenRows = await loadTranscriptEvents(target);
      expect(rewrittenRows.slice(0, originalRows.length)).toEqual(originalRows);
      expect(
        rewrittenRows.findLast(
          (entry) =>
            isRecord(entry) &&
            entry.type === "message" &&
            isRecord(entry.message) &&
            entry.message.content === "rewritten",
        ),
      ).toMatchObject({ parentId: opaque ? "opaque-parent" : first });
      expect(getBranchMessages(SessionManager.open(target, directory))).toMatchObject([
        { role: "user", content: "selected" },
        { role: "user", content: "rewritten" },
      ]);
    },
  );

  it.each([false, true])(
    "rewrites an omitted target within the resident message budget (custom metadata=%s)",
    async (withCustomMetadata) => {
      const { directory, target } = await createPersistedRewriteTarget("omitted-rewrite");
      const seed = SessionManager.open(target, directory);
      const ids = Array.from({ length: 6 }, (_, index) =>
        seed.appendMessage({ role: "user", content: `turn ${index}`, timestamp: index }),
      );
      const bounded = SessionManager.openBounded(target, { maxEvents: 2, maxBytes: 4096 });
      bounded.appendLabelChange(ids[4]!, "kept entry");
      const customId = withCustomMetadata
        ? bounded.appendCustomEntry("rewrite-state", { value: "x".repeat(8192) })
        : undefined;
      const custom = customId ? bounded.getEntry(customId) : undefined;
      const originalRows = await loadTranscriptEvents(target);
      expect(bounded.getEntry(ids[1]!)).toBeUndefined();

      const result = await rewriteTranscriptEntriesInSessionManager({
        sessionManager: bounded,
        replacements: [
          { entryId: ids[1]!, message: { role: "user", content: "repaired turn", timestamp: 1 } },
        ],
      });

      expect(result).toMatchObject({ changed: true, rewrittenEntries: 1 });
      // The old labeled target remains a synchronous SDK pin beside the two-message window.
      expect(bounded.getEntries().filter((entry) => entry.type === "message")).toHaveLength(3);
      expect(bounded.getLabel(ids[4]!)).toBe("kept entry");
      const rewrittenLabelTarget = bounded
        .getBranch()
        .find(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "user" &&
            entry.message.content === "turn 4",
        );
      expect(rewrittenLabelTarget).toBeDefined();
      expect(bounded.getLabel(rewrittenLabelTarget!.id)).toBe("kept entry");
      if (custom?.type === "custom") {
        const metadata = bounded.getEntries().filter((entry) => entry.type === "custom");
        expect(metadata).toHaveLength(2);
        for (const entry of metadata) {
          expect(entry.data).toBe(custom.data);
        }
      }
      expect(
        (await bounded[sessionManagerPrepareHistoryRead]().readContext()).messages,
      ).toMatchObject([
        { role: "user", content: "turn 4" },
        { role: "user", content: "turn 5" },
      ]);
      const reopened = SessionManager.open(target, directory);
      expect(getBranchMessages(reopened)).toMatchObject(
        ["turn 0", "repaired turn", "turn 2", "turn 3", "turn 4", "turn 5"].map((content) => ({
          role: "user",
          content,
        })),
      );
      expect((await loadTranscriptEvents(target)).slice(0, originalRows.length)).toEqual(
        originalRows,
      );
    },
  );

  it.each([0, 2])(
    "keeps an unhydrated prefix when rewriting bounded entry %i",
    async (replacementIndex) => {
      const { directory, target } = await createPersistedRewriteTarget("bounded-rewrite");
      const full = SessionManager.open(target, directory);
      for (let index = 0; index < 24; index++) {
        full.appendMessage({
          role: "user",
          content: `Archived ${index}: ${"x".repeat(16_384)}`,
          timestamp: index,
        });
      }
      for (const content of ["first retained", "second retained", "last retained"]) {
        full.appendMessage({ role: "user", content, timestamp: 30 });
      }
      const expected = getBranchMessages(full);
      const bounded = SessionManager.openBounded(target, { maxEvents: 3, maxBytes: 2048 });
      expect(bounded.getEntries()).toHaveLength(3);
      const entry = bounded.getBranch()[replacementIndex];
      if (entry?.type !== "message" || entry.message.role !== "user") {
        throw new Error("missing bounded rewrite target");
      }
      const replacement = { ...entry.message, content: "bounded replacement" };
      await rewriteTranscriptEntriesInSessionManager({
        sessionManager: bounded,
        replacements: [{ entryId: entry.id, message: replacement }],
      });
      expected[24 + replacementIndex] = replacement;
      expect(bounded.getEntries().length).toBeLessThanOrEqual(6);
      expect(getBranchMessages(SessionManager.open(target, directory))).toEqual(expected);
      bounded.appendMessage({ role: "user", content: "next turn", timestamp: 31 });
      expect(getBranchMessages(SessionManager.open(target, directory))).toEqual([
        ...expected,
        { role: "user", content: "next turn", timestamp: 31 },
      ]);
    },
  );
});

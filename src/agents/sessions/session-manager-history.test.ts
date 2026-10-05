import { assert, expect, it } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { seedUnindexedTranscriptForTest } from "../../config/sessions/session-accessor.sqlite-import.test-support.js";
import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";
import type { SessionTranscriptMaintenanceRead } from "../../config/sessions/session-transcript-hydration.types.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { readSessionTranscriptResidentContext } from "../../config/sessions/session-transcript-resident-context.worker.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { sessionManagerPrepareHistoryRead } from "./session-manager-history.js";
import { canonicalTarget } from "./session-manager-hydration.test-support.js";
import { SessionManager } from "./session-manager.js";

it.each(["sync", "async", "selected-cleanup"] as const)(
  "preserves canonical ordinals through a %s bounded handoff",
  async (mode) => {
    await withOpenClawTestState({ label: "strict-bounded-ordinal" }, async (state) => {
      const target = canonicalTarget(state, "strict-bounded-ordinal");
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      await persistSessionTranscriptTurn(target, {
        messages: Array.from({ length: 100 }, (_, index) => ({
          eventId: `message-${index}`,
          parentId: index === 0 ? null : `message-${index - 1}`,
          message: makeUserMessage(`message ${index}`, index),
        })),
        touchSessionEntry: false,
      });
      await waitForSessionTranscriptProjection(target);
      const limits = { maxBytes: 4096, maxEvents: 1 };
      const manager =
        mode === "sync"
          ? SessionManager.openBounded(target, limits)
          : await SessionManager.openBoundedAsync(target, limits);
      expect(manager.getEntries().map((entry) => entry.id)).toEqual(["message-99"]);
      expect(manager.buildSessionContext().messages).toEqual([makeUserMessage("message 99", 99)]);
      if (mode === "selected-cleanup") {
        await manager.branchAsync("message-99");
        expect(manager.getEntry("message-98")).toBeUndefined();
        expect(await manager.removeTrailingEntriesAsync((entry) => entry.id === "message-99")).toBe(
          1,
        );
      }
      const updates: Array<{ messageId?: string; messageSeq?: number }> = [];
      const stop = onInternalSessionTranscriptUpdate((update) => updates.push(update));
      try {
        const guarded = guardSessionManager(manager);
        const message = makeAgentAssistantMessage({
          content: [{ type: "text", text: "continued" }],
        });
        const appended =
          mode === "sync"
            ? guarded.appendMessage(message)
            : await guarded.appendMessageAsync(message);
        assert(appended);
        expect(updates.filter((update) => update.messageId === appended)).toMatchObject([
          { messageId: appended, messageSeq: mode === "selected-cleanup" ? 100 : 101 },
        ]);
        if (mode === "selected-cleanup") {
          const reopened = await SessionManager.openAsync(target);
          expect(reopened.getBranch()).toHaveLength(100);
          expect(reopened.getBranch().at(-1)).toMatchObject({
            id: appended,
            parentId: "message-98",
          });
          expect(reopened.getEntry("message-99")).toBeUndefined();
        }
      } finally {
        stop();
      }
    });
  },
);

it("retains only referenced canonical ordinals after eviction and synchronous suffix removal", async () => {
  await withOpenClawTestState({ label: "evicted-suffix-ordinal" }, async (state) => {
    const target = canonicalTarget(state, "evicted-suffix-ordinal");
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openBoundedAsync(target, { maxBytes: 4096, maxEvents: 1 });
    const firstMessage = makeUserMessage("retained ancestor", 1);
    const first = await manager.appendMessageAsync(firstMessage);
    const boundaryMessage = makeUserMessage("resident cleanup boundary", 2);
    const boundary = await manager.appendMessageAsync(boundaryMessage);
    const removed = await manager.appendMessageAsync(
      makeAgentAssistantMessage({ content: [{ type: "text", text: "removed tail" }] }),
    );
    assert(first && boundary && removed);
    expect(manager.getEntry(first)).toBeUndefined();
    expect(manager.getEntry(boundary)).toMatchObject({ message: boundaryMessage });
    expect(manager.removeTrailingEntries((entry) => entry.id === removed)).toBe(1);
    expect(await loadTranscriptEvents(target)).not.toContainEqual(
      expect.objectContaining({ id: removed }),
    );
    const ordinals: Array<number | undefined> = [];
    const stop = onInternalSessionTranscriptUpdate((update) => {
      if (update.sessionId === target.sessionId && update.messageId) {
        ordinals.push(update.messageSeq);
      }
    });
    const messages = [firstMessage, boundaryMessage];
    const continuedIds: string[] = [];
    try {
      const guarded = guardSessionManager(manager);
      for (let index = 0; index < 3; index++) {
        const message = makeUserMessage(`continued ${index}`, index + 4);
        messages.push(message);
        const appended = await guarded.appendMessageAsync(message);
        assert(appended);
        continuedIds.push(appended);
        expect(ordinals.at(-1)).toBe(index + 3);
        expect(manager.getEntries()).toHaveLength(1);
        const cached: unknown = Reflect.get(manager, "transcriptSeqByEntryId");
        assert(cached instanceof Map, "canonical ordinal facts must share the resident view");
        // One payload, its omitted predecessor, and the cleanup leaf control's ancestor.
        expect(cached.size).toBeLessThanOrEqual(3);
        if (index > 1) {
          expect(cached.has(continuedIds[0])).toBe(false);
        }
      }
      expect(ordinals).toEqual([3, 4, 5]);
      await manager.reloadPersistedTranscriptAsync();
      const refreshed: unknown = Reflect.get(manager, "transcriptSeqByEntryId");
      assert(refreshed instanceof Map, "reload must replace the resident ordinal facts");
      expect(refreshed.size).toBeLessThanOrEqual(2);
      expect(refreshed.has(first)).toBe(false);
      const reopened = await SessionManager.openAsync(target);
      expect(reopened.buildSessionContext().messages).toEqual(messages);
      expect(reopened.getBranch().map((entry) => entry.id)).not.toContain(removed);
    } finally {
      stop();
    }
  });
});

it.each([1, 3])(
  "reconstructs canonical ordinals through %s uncached preserved metadata rows",
  async (metadataCount) => {
    await withOpenClawTestState({ label: "preserved-metadata-ordinal" }, async (state) => {
      const target = canonicalTarget(state, "preserved-metadata-ordinal");
      const ids = ["user", "ancestor", "removed"];
      const messages = ids.map((id, index) => ({
        type: "message",
        id,
        parentId: ids[index - 1] ?? null,
        message: makeUserMessage(id, index),
      }));
      const metadata = Array.from({ length: metadataCount }, (_, index) => ({
        type: "custom",
        id: `metadata-${index}`,
        parentId: index === 0 ? "removed" : `metadata-${index - 1}`,
        customType: "retained-state",
        data: { index },
      }));
      const events = [
        { type: "session", version: 3, id: target.sessionId, cwd: state.workspaceDir },
        ...messages,
        ...metadata,
      ];
      await seedUnindexedTranscriptForTest({
        ...target,
        entry: { sessionId: target.sessionId, updatedAt: 1 },
        events: events.map((event, seq) => ({
          session_id: target.sessionId,
          seq,
          event_json: JSON.stringify(event),
          created_at: seq,
        })),
      });
      await waitForSessionTranscriptProjection(target);
      const manager = await SessionManager.openBoundedAsync(target, {
        maxEvents: metadataCount + 2,
        maxBytes: 4096,
      });
      expect(manager.getEntry("user")).toBeUndefined();
      expect(manager.getEntries().map(({ id }) => id)).toEqual([
        "ancestor",
        "removed",
        ...metadata.map(({ id }) => id),
      ]);
      expect(
        manager.removeTrailingEntries((entry) => entry.id === "removed", {
          preserveTrailing: (entry) => entry.type === "custom",
        }),
      ).toBe(1);
      manager.branch(metadata.at(-1)!.id);
      const ordinals: Array<number | undefined> = [];
      const stop = onInternalSessionTranscriptUpdate((update) => {
        if (update.sessionId === target.sessionId && update.messageId) {
          ordinals.push(update.messageSeq);
        }
      });
      try {
        const continuedMessage = makeUserMessage("continued", 4);
        const continued = await guardSessionManager(manager).appendMessageAsync(continuedMessage);
        assert(continued);
        expect(ordinals).toEqual([3]);
        const reopened = await SessionManager.openAsync(target);
        expect(reopened.getBranch().map(({ id }) => id)).toEqual([
          "user",
          "ancestor",
          ...metadata.map(({ id }) => id),
          continued,
        ]);
        expect(reopened.buildSessionContext().messages).toEqual([
          messages[0]!.message,
          messages[1]!.message,
          continuedMessage,
        ]);
      } finally {
        stop();
      }
    });
  },
);

it.each(["sync", "async"])(
  "preserves canonical prefix ordinals across successive bounded legacy rewrites (%s)",
  async (mode) => {
    await withOpenClawTestState({ label: "legacy-prefix-ordinal" }, async (state) => {
      const target = canonicalTarget(state, `legacy-prefix-ordinal-${mode}`);
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      await persistSessionTranscriptTurn(target, {
        cwd: state.workspaceDir,
        expectedSessionId: target.sessionId,
        messages: [
          ...Array.from({ length: 100 }, (_, index) => ({
            eventId: `user-${index}`,
            parentId: index ? `user-${index - 1}` : null,
            message: makeUserMessage(`user ${index}`, index),
          })),
          {
            eventId: "original-assistant",
            parentId: "user-99",
            message: makeAgentAssistantMessage({
              content: [{ type: "text", text: "original answer" }],
            }),
          },
        ],
        touchSessionEntry: false,
        updateMode: "none",
      });
      const manager = await SessionManager.openBoundedAsync(target, {
        maxBytes: 4096,
        maxEvents: 2,
      });
      expect(manager.getBranch().map(({ id }) => id)).toEqual(["user-99", "original-assistant"]);
      const prepare = () =>
        mode === "sync"
          ? manager.prepareTranscriptRewrite()
          : manager.prepareTranscriptRewriteAsync();
      const first = await prepare();
      await (mode === "sync"
        ? first.sessionManager.branch("user-99")
        : first.sessionManager.branchAsync("user-99"));
      const replacementAssistant = await first.sessionManager.appendMessageAsync(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "rewritten answer" }] }),
      );
      assert(replacementAssistant);
      await first.commit(new Map([["original-assistant", replacementAssistant]]));

      const second = await prepare();
      await (mode === "sync"
        ? second.sessionManager.resetLeaf()
        : second.sessionManager.resetLeafAsync());
      const replacementUser = await second.sessionManager.appendMessageAsync(
        makeUserMessage("rewritten retained user", 100),
      );
      assert(replacementUser);
      await second.commit(new Map([["user-99", replacementUser]]));

      const guarded = guardSessionManager(manager);
      const ordinals: Array<number | undefined> = [];
      const unsubscribe = onInternalSessionTranscriptUpdate((update) => {
        if (update.sessionId === target.sessionId && update.messageId) {
          ordinals.push(update.messageSeq);
        }
      });
      try {
        const continuation = await guarded.appendMessageAsync(
          makeAgentAssistantMessage({ content: [{ type: "text", text: "continuation" }] }),
        );
        expect(ordinals).toEqual([101]);
        expect(manager.getBranch().map(({ id }) => id)).toEqual([replacementUser, continuation]);
        const reopened = await SessionManager.openAsync(target);
        expect(reopened.getBranch()).toHaveLength(101);
        expect(reopened.getBranch().at(-2)).toMatchObject({
          id: replacementUser,
          parentId: "user-98",
        });
      } finally {
        unsubscribe();
      }
    });
  },
);

it.each([
  { selection: "branch", kind: "custom" },
  { selection: "leaf-control", kind: "custom" },
  { selection: "side-cursor", kind: "custom" },
  { selection: "visible-cursor", kind: "custom" },
  { selection: "branch", kind: "assistant" },
  { selection: "side-cursor", kind: "assistant" },
] as const)(
  "admits an excluded $kind selected leaf through $selection without retaining its payload",
  async ({ selection, kind }) => {
    await withOpenClawTestState({ label: "excluded-selected-leaf" }, async (state) => {
      const target = canonicalTarget(state, "excluded-selected-leaf");
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const source = SessionManager.open(target);
      const visible = source.appendMessage(makeUserMessage("visible user", 1));
      const excludedModel = { provider: "raw-tip-provider", modelId: "raw-tip-model" };
      const excludedMessage = {
        ...(kind === "assistant"
          ? makeAgentAssistantMessage({
              provider: excludedModel.provider,
              model: excludedModel.modelId,
              content: [{ type: "text", text: "display-only response".repeat(512) }],
              timestamp: 2,
            })
          : {
              role: "custom" as const,
              customType: "display-only",
              content: "display-only response".repeat(512),
              display: false,
              timestamp: 2,
            }),
        excludeFromContext: true,
      };
      const excluded = source.appendMessage(excludedMessage);
      await waitForSessionTranscriptProjection(target);
      const limits = { maxBytes: 4096, maxEvents: 1 };

      const snapshot = readSessionTranscriptResidentContext(target, {
        ...limits,
        selectedLeafEntryId: excluded,
      });

      expect(snapshot.activeLeafEntryId).toBe(excluded);
      expect(snapshot.events.filter(isIndexedSessionEntry).map((entry) => entry.id)).toEqual([
        visible,
      ]);
      expect(snapshot.entryTranscriptSeqs.get(excluded)).toBe(2);
      expect(() =>
        readSessionTranscriptResidentContext(target, { ...limits, selectedLeafEntryId: "missing" }),
      ).toThrow("Selected branch leaf is no longer available");

      const later = source.appendMessage(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "later branch" }] }),
      );
      const manager = await SessionManager.openBoundedAsync(target, limits);
      const appendParent =
        selection === "side-cursor" ? later : selection === "visible-cursor" ? visible : excluded;
      if (selection === "branch") {
        await manager.branchAsync(excluded);
      } else {
        await manager.appendLeafControlAsync({
          targetId: excluded,
          appendParentId: appendParent,
          appendMode:
            selection === "side-cursor" || selection === "visible-cursor" ? "side" : undefined,
        });
      }
      expect(manager.getEntry(excluded)).toBeUndefined();
      expect(manager.getLeafId()).toBe(visible);
      expect(manager.getAppendParentId()).toBe(appendParent);
      expect(manager.getEntries().map((entry) => entry.id)).toEqual([visible]);
      expect(manager.getBranch().map((entry) => entry.id)).toEqual([visible]);
      expect(manager.buildSessionContext().messages).toEqual([makeUserMessage("visible user", 1)]);
      const context = await manager[sessionManagerPrepareHistoryRead]().readContext();
      expect(context.messages).toEqual([makeUserMessage("visible user", 1)]);
      expect(context.model).toEqual(kind === "assistant" ? excludedModel : null);
      expect(context.thinkingLevel).toBe("off");
      const reopenedSelection = await SessionManager.openAsync(target);
      if (selection === "branch") {
        await reopenedSelection.branchAsync(excluded);
      }
      expect(reopenedSelection.buildSessionContext()).toEqual(context);

      expect(manager.getPersistedEntries().at(-1)).toMatchObject({
        type: "leaf",
        targetId: excluded,
      });
      if (selection !== "branch") {
        const rewrite = await manager.prepareTranscriptRewriteAsync();
        await rewrite.commit(new Map());
        expect(manager.getLeafId()).toBe(visible);
        expect(manager.getAppendParentId()).toBe(appendParent);
      }
      const beforeCleanup = await loadTranscriptEvents(target);
      if (selection === "side-cursor" || selection === "visible-cursor") {
        const complete = await SessionManager.openAsync(target);
        expect(complete.getBranch().at(-1)?.id).toBe(excluded);
        expect(complete.getAppendParentId()).toBe(appendParent);
        expect(complete.removeTrailingEntries((entry) => entry.id === visible)).toBe(0);
      }
      const inspected: string[] = [];
      let syncFailure: unknown;
      try {
        manager.removeTrailingEntries((entry) => {
          inspected.push(entry.id);
          return entry.id === visible;
        });
      } catch (error) {
        syncFailure = error;
      }
      expect({ inspected, events: await loadTranscriptEvents(target) }).toEqual({
        inspected: [],
        events: beforeCleanup,
      });
      expect(syncFailure).toBeInstanceOf(RangeError);
      expect(syncFailure).toHaveProperty(
        "message",
        "Bounded transcript cleanup cannot cross the hydrated removal window",
      );
      expect(await manager.removeTrailingEntriesAsync((entry) => entry.id === visible)).toBe(0);
      expect(await loadTranscriptEvents(target)).toEqual(beforeCleanup);
      expect(
        (
          await manager[sessionManagerPrepareHistoryRead]().readBranch({
            selection: "branch",
            direction: "reverse",
          })
        ).map((entry) => entry.id),
      ).toEqual([excluded, visible]);

      const updates: Array<{ messageId?: string; messageSeq?: number }> = [];
      const stop = onInternalSessionTranscriptUpdate((update) => updates.push(update));
      try {
        const continued = await guardSessionManager(manager).appendMessageAsync(
          makeAgentAssistantMessage({ content: [{ type: "text", text: "continued" }] }),
        );
        assert(continued);
        expect(await loadTranscriptEvents(target)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: continued, parentId: appendParent }),
          ]),
        );
        expect(updates.filter((update) => update.messageId === continued)).toMatchObject([
          { messageId: continued, messageSeq: 3 },
        ]);
        const reopened = await SessionManager.openAsync(target);
        expect(reopened.getLeafId()).toBe(continued);
        expect(reopened.buildSessionContext().messages).toEqual(
          (await manager[sessionManagerPrepareHistoryRead]().readContext()).messages,
        );
        await manager.branchAsync(excluded);
        expect(await manager.removeTrailingEntriesAsync((entry) => entry.id === excluded)).toBe(1);
        expect(await loadTranscriptEvents(target)).not.toContainEqual(
          expect.objectContaining({ id: excluded }),
        );
        expect(manager.buildSessionContext().messages).toEqual([
          makeUserMessage("visible user", 1),
        ]);
      } finally {
        stop();
      }
    });
  },
);

it("admits only one largest complete tool result beyond the collection byte budget", async () => {
  await withOpenClawTestState({ label: "session-history-oversized-budget" }, async (state) => {
    const target = canonicalTarget(state, "history-oversized-budget");
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const source = SessionManager.open(target);
    const ids = [512, 1024].map((size, index) =>
      source.appendMessage({
        role: "toolResult",
        toolCallId: `call-${index}`,
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(size) }],
        isError: false,
        timestamp: index,
      }),
    );
    const reader = prepareSessionTranscriptHydration(target);
    const { snapshot } = await reader.read();
    const request: SessionTranscriptMaintenanceRead = {
      operation: "history-page",
      version: snapshot.version,
      appendParentId: source.getAppendParentId(),
      leafId: source.getLeafId(),
      selection: "branch",
      direction: "forward",
      offset: 0,
      maxBytes: 128,
      maxEvents: 1,
      oversizedToolResults: "complete",
      retainedCustomDataIds: [],
      collectionBudget: { remainingBytes: 0, largestOversizedBytes: 0 },
    };
    const first = await reader.readMaintenance(request);
    expect(first.events).toEqual([source.getEntry(ids[0]!)]);
    expect(first.oversizedBytes).toBe(first.serializedBytes);
    expect(first.nextOffset).toBe(1);
    if (first.oversizedBytes === undefined) {
      throw new Error("missing oversized acquisition measurement");
    }
    await expect(
      reader.readMaintenance({
        ...request,
        offset: 1,
        collectionBudget: {
          remainingBytes: 0,
          largestOversizedBytes: first.oversizedBytes,
        },
      }),
    ).rejects.toThrow("operation acquisition limit");
  });
});

it("keeps an oversized selected leaf in context without acquiring its omitted prefix", async () => {
  await withOpenClawTestState({ label: "session-history-oversized-leaf" }, async (state) => {
    const target = canonicalTarget(state, "history-oversized-leaf");
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const source = SessionManager.open(target);
    const prefixId = source.appendMessage(makeUserMessage("omitted prefix", 1));
    const selected = makeUserMessage("x".repeat(8192), 2);
    const selectedId = source.appendMessage(selected);
    source.appendMessage(makeUserMessage("current tail", 3));
    await waitForSessionTranscriptProjection(target);
    const manager = await SessionManager.openBoundedAsync(target, {
      maxBytes: 4096,
      maxEvents: 2,
    });
    expect(manager.getEntry(selectedId)).toBeUndefined();

    await manager.branchAsync(selectedId);

    expect((await manager[sessionManagerPrepareHistoryRead]().readContext()).messages).toEqual([
      selected,
    ]);
    expect(manager.getEntry(prefixId)).toBeUndefined();
    expect(manager.getBranch().map((entry) => entry.id)).toEqual([selectedId]);
  });
});

it.each(["file", "incognito"])(
  "acquires omitted history in bounded pages without expanding the %s manager",
  async (storage) => {
    await withOpenClawTestState({ label: "session-history-pages" }, async (state) => {
      const target = canonicalTarget(
        state,
        "history-pages",
        storage === "incognito"
          ? "agent:main:dashboard:incognito-history-pages"
          : "agent:main:history-pages",
      );
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        updatedAt: 1,
        ...(storage === "incognito" ? { incognito: true } : {}),
      });
      const source = SessionManager.open(target);
      const ids = Array.from({ length: 6 }, (_, index) =>
        source.appendMessage(makeUserMessage(`message ${index}`, index)),
      );
      await waitForSessionTranscriptProjection(target);
      const manager = await SessionManager.openBoundedAsync(target, {
        maxBytes: 4096,
        maxEvents: 2,
      });
      expect(manager.getEntry(ids[0]!)).toBeUndefined();
      const resident = manager.getEntries();
      const hydration = prepareSessionTranscriptHydration(target);
      const { snapshot } = await hydration.read();
      const { anchor } = await hydration.readCurrentTurnEntry({
        entryId: ids[4]!,
        version: snapshot.version,
        includeEntry: false,
      });
      if (!anchor) {
        throw new Error("Expected the admitted user entry");
      }
      const history = runWithSessionTranscriptReadFence(
        { ...anchor, logicalTurnId: "history-read", role: "user" },
        () => manager[sessionManagerPrepareHistoryRead](),
      );
      const acquired: string[] = [];
      for await (const page of history.pages({
        selection: "branch",
        maxBytes: 4096,
        maxEvents: 2,
      })) {
        expect(page.entries.length).toBeLessThanOrEqual(2);
        acquired.push(...page.entries.map((entry) => entry.id));
      }
      expect(acquired).toEqual(ids);
      expect((await history.readBranch()).map((entry) => entry.id)).toEqual(ids.slice(-2));
      expect(manager.getEntries()).toEqual(resident);
      expect(
        (
          await history.readBranch({ leafId: ids[1], selection: "branch", direction: "reverse" })
        ).map((entry) => entry.id),
      ).toEqual([ids[1], ids[0]]);
      await expect(history.readBranch({ maxBytes: 1 })).rejects.toThrow("acquisition byte limit");

      // A refused worker request retires its owner; the next operation captures a fresh one.
      const pages = manager[sessionManagerPrepareHistoryRead]().pages({
        selection: "branch",
        maxEvents: 1,
      });
      expect((await pages.next()).value?.entries[0]?.id).toBe(ids[0]);
      source.appendMessage(makeUserMessage("concurrent writer", 7));
      await expect(pages.next()).rejects.toThrow("changed during history acquisition");
      expect(manager.getEntries()).toEqual(resident);
    });
  },
);

it("keeps the latest off-branch metadata in physical order during bounded navigation", async () => {
  await withOpenClawTestState({ label: "duplicate-retained-metadata" }, async (state) => {
    const target = canonicalTarget(state, "duplicate-retained-metadata");
    const selected = {
      type: "message",
      id: "selected",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: makeUserMessage("selected branch", 1),
    };
    const labeled = { ...selected, id: "labeled", message: makeUserMessage("old branch", 2) };
    const label = {
      type: "label",
      id: "bookmark",
      parentId: labeled.id,
      targetId: labeled.id,
      timestamp: selected.timestamp,
      label: "superseded label",
    };
    const intervening = { ...label, id: "intervening", label: "also cleared" };
    const cleared = { ...label, parentId: intervening.id, label: "" };
    const events = [
      { type: "session", id: target.sessionId, version: 3, cwd: state.workspaceDir },
      selected,
      labeled,
      label,
      intervening,
      cleared,
      { ...selected, id: "current", parentId: cleared.id, message: makeUserMessage("current", 3) },
    ];
    await seedUnindexedTranscriptForTest({
      ...target,
      entry: { sessionId: target.sessionId, updatedAt: 1 },
      events: events.map((event, seq) => ({
        session_id: target.sessionId,
        seq,
        event_json: JSON.stringify(event),
        created_at: seq,
      })),
    });
    const limits = { maxBytes: 4096, maxEvents: 20 };
    const manager = await SessionManager.openBoundedAsync(target, limits);
    const history = manager[sessionManagerPrepareHistoryRead]();
    const version = history.version;
    assert(version, "Bounded navigation must retain its committed transcript version");
    expect(manager.getEntry(selected.id)).toBeUndefined();
    expect(manager.getLabel(labeled.id)).toBeUndefined();

    const prepared = await history.readSelectedContext(selected.id, limits);
    assert(prepared.kind === "bounded", "Navigation must prepare a bounded snapshot");
    expect(prepared.snapshot.version).toEqual(version);
    expect(prepared.snapshot.activeLeafEntryId).toBe(selected.id);
    expect(prepared.snapshot.events).toEqual([events[0], selected, intervening, cleared]);

    await manager.branchAsync(selected.id);

    expect(manager.getLabel(labeled.id)).toBeUndefined();
    expect(manager.getEntry(labeled.id)).toBeUndefined();
    expect(manager.getEntries().map((entry) => entry.id)).toEqual([
      selected.id,
      intervening.id,
      cleared.id,
    ]);
    expect(manager.getEntry(cleared.id)).toMatchObject({
      type: "label",
      targetId: labeled.id,
      label: "",
    });
    expect(manager.getLeafId()).toBe(selected.id);
    expect(manager.getBranch()).toEqual([selected]);
    expect(manager.buildSessionContext().messages).toEqual([selected.message]);
    expect(manager[sessionManagerPrepareHistoryRead]().version).toEqual(version);
    expect(await loadTranscriptEvents(target)).toEqual(events);
  });
});

it.each([
  { name: "a message ancestor", parentId: "current" },
  { name: "an empty root", parentId: null },
])("reads a detached opaque selected branch with $name", async ({ parentId }) => {
  const destination = {
    type: "message",
    id: "destination",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: makeUserMessage("destination branch", 1),
  };
  const current = { ...destination, id: "current", message: makeUserMessage("current branch", 2) };
  const entries = [
    { type: "session", version: 3, id: "detached-opaque", cwd: "/fixture" },
    destination,
    current,
    { type: "future-metadata", id: "opaque-root", parentId },
    { type: "future-metadata", id: "opaque-tail", parentId: "opaque-root" },
    { type: "leaf", id: "selected", parentId: "opaque-tail", targetId: "opaque-tail" },
    { type: "leaf", id: "invalid", parentId: destination.id, targetId: "missing" },
    { type: "leaf", id: "invalid-target", parentId: "opaque-tail", targetId: "invalid" },
  ];
  const manager = SessionManager.fromEntries(entries);
  const history = manager[sessionManagerPrepareHistoryRead]();
  const expectedBranch = parentId === null ? [] : [current];
  expect(manager.getEntry("opaque-tail")).toBeUndefined();
  expect(manager.getLeafId()).toBe(parentId);
  expect(manager.getAppendParentId()).toBe("opaque-tail");

  expect(await history.readBranch({ selection: "branch" })).toEqual(expectedBranch);
  expect(await history.readBranch({ selection: "branch", leafId: "opaque-tail" })).toEqual(
    expectedBranch,
  );
  expect(await history.readBranch({ selection: "branch", leafId: "invalid" })).toEqual([
    destination,
  ]);
  expect(await history.readBranch({ selection: "branch", leafId: null })).toEqual([]);
  await expect(history.readBranch({ selection: "branch", leafId: "missing" })).rejects.toThrow(
    "Entry missing not found",
  );
  expect(await history.readNavigation(destination.id)).toEqual({
    targetEntry: destination,
    entriesToSummarize: expectedBranch,
    commonAncestorId: null,
  });
  await expect(history.readNavigation("opaque-tail")).rejects.toThrow(
    "Entry opaque-tail not found",
  );
  expect((await history.readContext()).messages).toEqual(
    expectedBranch.map((entry) => entry.message),
  );
  const inspected: string[] = [];
  expect(
    manager.removeTrailingEntries((entry) => {
      inspected.push(entry.id);
      return false;
    }),
  ).toBe(0);
  expect(inspected).toEqual(expectedBranch.map((entry) => entry.id));
  expect(manager.getPersistedEntries()).toEqual(entries);
  manager.resetLeaf();
  expect(
    manager.removeTrailingEntries((entry) => {
      inspected.push(entry.id);
      return true;
    }),
  ).toBe(0);
  expect(inspected).toEqual(expectedBranch.map((entry) => entry.id));
});

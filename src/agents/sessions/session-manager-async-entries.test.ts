import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import {
  loadTranscriptEvents,
  replaceTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import * as hostTranscriptWriter from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { SessionManager } from "../../plugin-sdk/agent-sessions.js";
import { readGlobalSingleton } from "../../shared/global-singleton.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { isRecordedModelFallbackStop } from "../model-fallback-stop.js";
import { openAsyncSessionFixture } from "./session-manager-async.test-support.js";
import { parseOpaqueLeafEntry } from "./session-manager-codec.js";
import { sessionManagerPrepareHistoryRead } from "./session-manager-history.js";
import * as metadataRuntime from "./session-manager-metadata-runtime.js";
import { sessionManagerResolveTranscriptSeq } from "./session-manager-transcript-seq.js";
import type { SessionEntry } from "./session-manager-types.js";
import * as sessionWriteAdmission from "./session-manager-write-admission.js";

afterEach(() => vi.restoreAllMocks());

function residentOrdinalCount(manager: SessionManager): number {
  const ordinals: unknown = Reflect.get(manager, "transcriptSeqByEntryId");
  if (!(ordinals instanceof Map)) {
    throw new Error("Expected the resident transcript ordinal index");
  }
  return ordinals.size;
}

it("bounds opaque parent indexes when excluded and visible appends alternate", async () => {
  await withOpenClawTestState({ label: "async-opaque-parent-budget" }, async (state) => {
    const { target } = await openAsyncSessionFixture(state, "opaque-parent-budget");
    const manager = await SessionManager.openAsync(target, state.workspaceDir, {
      maxBytes: 4096,
      maxEvents: 2,
    });
    const messages = [{ role: "user" as const, content: "seed", timestamp: 0 }];
    await manager.appendMessageAsync(messages[0]!);
    const parentIndex = (): Map<unknown, unknown> => {
      const index: unknown = Reflect.get(manager, "opaqueParentsById");
      if (!(index instanceof Map)) {
        throw new Error("Expected the manager's resident opaque-parent index");
      }
      return index;
    };
    const displayIds: string[] = [];
    let afterDisplayPeak = 0;
    let afterVisiblePeak = 0;
    for (let index = 0; index < 16; index++) {
      const display = await manager.appendMessageWithTranscriptAnchorAsync({
        role: "custom",
        customType: "display-only",
        content: `excluded ${index}`,
        display: true,
        excludeFromContext: true,
        timestamp: index * 2 + 1,
      });
      displayIds.push(display.entryId);
      expect(manager.getAppendParentId()).toBe(display.entryId);
      expect(parentIndex().has(display.entryId)).toBe(true);
      afterDisplayPeak = Math.max(afterDisplayPeak, parentIndex().size);
      expect(residentOrdinalCount(manager)).toBeLessThanOrEqual(
        manager.getEntries().length + parentIndex().size,
      );
      const message = {
        role: "user" as const,
        content: `visible ${index}`,
        timestamp: index * 2 + 2,
      };
      messages.push(message);
      await manager.appendMessageAsync(message);
      afterVisiblePeak = Math.max(afterVisiblePeak, parentIndex().size);
      expect(residentOrdinalCount(manager)).toBeLessThanOrEqual(
        manager.getEntries().length + parentIndex().size,
      );
    }
    // Two resident raw parents plus the current excluded cursor between visible appends.
    expect(afterVisiblePeak).toBeLessThanOrEqual(2);
    expect(afterDisplayPeak).toBeLessThanOrEqual(3);
    expect(parentIndex().has(displayIds[0])).toBe(false);
    expect(manager.getEntries()).toHaveLength(2);
    expect(manager.buildSessionContext().messages).toEqual(messages.slice(-2));
    expect((await manager[sessionManagerPrepareHistoryRead]().readContext()).messages).toEqual(
      messages,
    );
    const persisted = await loadTranscriptEvents(target);
    expect(persisted).toHaveLength(34);
    expect(persisted).toEqual(
      expect.arrayContaining(displayIds.map((id) => expect.objectContaining({ id }))),
    );
  });
});

it("retires excluded cursors after reset without requiring a resident message eviction", async () => {
  await withOpenClawTestState({ label: "async-reset-opaque-parent-budget" }, async (state) => {
    const { target } = await openAsyncSessionFixture(state, "reset-opaque-parent-budget");
    const manager = await SessionManager.openAsync(target, state.workspaceDir, {
      maxBytes: 4096,
      maxEvents: 2,
    });
    let previousCursor: string | undefined;
    for (let index = 0; index < 16; index++) {
      manager.resetLeaf();
      const current = await manager.appendMessageWithTranscriptAnchorAsync({
        role: "custom",
        customType: "display-only",
        content: `excluded ${index}`,
        display: true,
        excludeFromContext: true,
        timestamp: index,
      });
      expect(manager.getEntries()).toEqual([]);
      expect(manager.getLeafId()).toBeNull();
      expect(manager.getAppendParentId()).toBe(current.entryId);
      const parents: unknown = Reflect.get(manager, "opaqueParentsById");
      if (!(parents instanceof Map)) {
        throw new Error("Expected the manager's resident opaque-parent index");
      }
      expect(parents.size).toBe(1);
      expect(residentOrdinalCount(manager)).toBeLessThanOrEqual(1);
      expect(parents.has(current.entryId)).toBe(true);
      if (previousCursor) {
        expect(parents.has(previousCursor)).toBe(false);
      }
      previousCursor = current.entryId;
    }
    const visible = { role: "user" as const, content: "continue after reset", timestamp: 16 };
    const appended = await manager.appendMessageWithTranscriptAnchorAsync(visible);
    expect(manager.getLeafId()).toBe(appended.entryId);
    expect(manager.buildSessionContext().messages).toEqual([visible]);
    const persisted = await loadTranscriptEvents(target);
    expect(persisted).toHaveLength(18);
    expect(persisted.at(-1)).toMatchObject({ id: appended.entryId, parentId: previousCursor });
  });
});

it.each([
  ...[
    { operation: "branch", afterRead: 1 },
    { operation: "summary", afterRead: 1 },
    { operation: "summary", afterRead: 2 },
  ].flatMap(({ operation, afterRead }) =>
    ["branch", "reset"].map((navigation) => ({
      operation,
      afterRead,
      navigation,
      boundary: `selected-context read ${afterRead}`,
    })),
  ),
  { operation: "summary", afterRead: 0, navigation: "branch", boundary: "append receipt" },
  { operation: "root-summary", afterRead: 0, navigation: "reset", boundary: "append receipt" },
])(
  "fences a newer synchronous $navigation after $operation $boundary",
  async ({ operation, afterRead, navigation }) => {
    await withOpenClawTestState({ label: "async-navigation-publication" }, async (state) => {
      const { target, manager: source } = await openAsyncSessionFixture(
        state,
        "navigation-publication",
      );
      const ids = Array.from({ length: 3 }, (_, index) =>
        source.appendMessage({ role: "user", content: `branch ${index}`, timestamp: index }),
      );
      const manager = await SessionManager.openAsync(target, state.workspaceDir, {
        maxBytes: 4096,
        maxEvents: 4,
      });
      const before = await loadTranscriptEvents(target);
      const prepareHistory = manager[sessionManagerPrepareHistoryRead].bind(manager);
      let reads = 0;
      const selectNewer = () =>
        navigation === "reset" ? manager.resetLeaf() : manager.branch(ids[1]!);
      vi.spyOn(manager, sessionManagerPrepareHistoryRead).mockImplementation((signal) => {
        const history = prepareHistory(signal);
        return {
          ...history,
          readSelectedContext: async (...args) => {
            const selected = await history.readSelectedContext(...args);
            if (++reads === afterRead) {
              queueMicrotask(selectNewer);
            }
            return selected;
          },
        };
      });
      if (afterRead === 0) {
        const write = sessionWriteAdmission.withSessionManagerWrite;
        vi.spyOn(sessionWriteAdmission, "withSessionManagerWrite").mockImplementation(
          async (...args) => {
            const result = await write(...args);
            if (
              isRecord(result) &&
              isRecord(result.entry) &&
              result.entry.type === "branch_summary"
            ) {
              queueMicrotask(selectNewer);
            }
            return result;
          },
        );
      }
      const pending =
        operation === "branch"
          ? manager.branchAsync(ids[0]!)
          : manager.branchWithSummaryAsync(
              operation === "root-summary" ? null : ids[0]!,
              "selected summary",
            );
      if (afterRead === 0 || afterRead === 2) {
        const failure = await pending.catch((error: unknown) => error);
        expect(failure).toMatchObject({
          name: "SessionEntryCommittedError",
          cause: { message: "Session transcript navigation changed before publication" },
        });
        expect(isRecordedModelFallbackStop(failure)).toBe(true);
        const events = await loadTranscriptEvents(target);
        expect(events).toHaveLength(before.length + 1);
        expect(events.at(-1)).toMatchObject({
          type: "branch_summary",
          parentId: operation === "root-summary" ? null : ids[0],
          summary: "selected summary",
        });
      } else {
        await expect(pending).rejects.toThrow(
          "Session transcript navigation changed before publication",
        );
        expect(await loadTranscriptEvents(target)).toEqual(before);
      }
      expect(manager.getLeafId()).toBe(navigation === "reset" ? null : ids[1]);
      expect(manager.getAppendParentId()).toBe(navigation === "reset" ? null : ids[1]);
    });
  },
);

it.each(["reset", "branch"] as const)(
  "preserves a synchronous %s after a worker leaf-control commit",
  async (navigation) => {
    await withOpenClawTestState({ label: "leaf-control-publication" }, async (state) => {
      const { target, manager: source } = await openAsyncSessionFixture(
        state,
        "leaf-control-publication",
      );
      const messages = Array.from({ length: 3 }, (_, timestamp) => ({
        role: "user" as const,
        content: `branch ${timestamp}`,
        timestamp,
      }));
      const ids = messages.map((message) => source.appendMessage(message));
      const manager = await SessionManager.openAsync(target, state.workspaceDir, {
        maxBytes: 4096,
        maxEvents: 4,
      });
      const before = await loadTranscriptEvents(target);
      const withWorker = metadataRuntime.withSessionMetadataWorker;
      const interception = vi
        .spyOn(metadataRuntime, "withSessionMetadataWorker")
        .mockImplementation(async (...args) => {
          const receipt = await withWorker(...args);
          if (navigation === "reset") {
            manager.resetLeaf();
          } else {
            manager.branch(ids[1]!);
          }
          return receipt;
        });
      let failure: unknown;
      try {
        await manager.appendLeafControlAsync({ targetId: ids[0]!, appendParentId: ids[0]! });
      } catch (error) {
        failure = error;
      } finally {
        interception.mockRestore();
      }
      expect(failure).toMatchObject({
        message:
          "Session leaf committed, but its view could not be adopted; do not replay the write",
        cause: { message: "Session transcript navigation changed before publication" },
      });
      expect(isRecordedModelFallbackStop(failure)).toBe(true);
      const committed = await loadTranscriptEvents(target);
      expect(committed.slice(0, before.length)).toEqual(before);
      expect(committed.slice(before.length)).toMatchObject([
        { type: "leaf", parentId: ids[2], targetId: ids[0] },
      ]);
      const selectedId = navigation === "reset" ? null : ids[1]!;
      expect(manager.getLeafId()).toBe(selectedId);
      expect(manager.getAppendParentId()).toBe(selectedId);
      expect(manager.buildSessionContext().messages).toEqual(
        navigation === "reset" ? [] : messages.slice(0, 2),
      );
      const next = { role: "user" as const, content: "after refused publication", timestamp: 3 };
      const nextId = await manager.appendMessageAsync(next);
      expect(manager.getLeafId()).toBe(nextId);
      expect(manager.buildSessionContext().messages).toEqual(
        navigation === "reset" ? [next] : [...messages.slice(0, 2), next],
      );
      const after = await loadTranscriptEvents(target);
      expect(after.slice(0, committed.length)).toEqual(committed);
      expect(after.slice(committed.length)).toMatchObject([
        { id: nextId, type: "message", parentId: selectedId, message: next },
      ]);
    });
  },
);

it.each(["visible", "excluded", "side"] as const)(
  "preserves a newer %s append when a branch-summary receipt returns",
  async (kind) => {
    await withOpenClawTestState({ label: "summary-append-return" }, async (state) => {
      const { target, manager: source } = await openAsyncSessionFixture(
        state,
        "summary-append-return",
      );
      const selectedId = source.appendMessage({ role: "user", content: "selected", timestamp: 1 });
      source.appendMessage({ role: "user", content: "abandoned", timestamp: 2 });
      const manager = await SessionManager.openAsync(target, state.workspaceDir, {
        maxBytes: 4096,
        maxEvents: 2,
      });
      let newerId: string | undefined;
      const write = sessionWriteAdmission.withSessionManagerWrite;
      const intercepted = vi
        .spyOn(sessionWriteAdmission, "withSessionManagerWrite")
        .mockImplementation(async (...args) => {
          const result = await write(...args);
          if (
            isRecord(result) &&
            isRecord(result.entry) &&
            result.entry.type === "branch_summary"
          ) {
            const summaryLeaf = manager.getLeafId();
            newerId = manager.appendMessage(
              kind === "excluded"
                ? {
                    role: "custom",
                    customType: "display-only",
                    content: "newer excluded append",
                    display: true,
                    excludeFromContext: true,
                    timestamp: 3,
                  }
                : { role: "user", content: "newer append", timestamp: 3 },
            );
            if (kind === "side") {
              manager.appendLeafControl({
                targetId: summaryLeaf,
                appendParentId: newerId,
                appendMode: "side",
              });
            }
          }
          return result;
        });
      const summaryId = await manager.branchWithSummaryAsync(selectedId, "selected summary");
      intercepted.mockRestore();
      const appendedId = expectDefined(newerId, "concurrent append must have committed");
      const expectedLeaf = kind === "visible" ? appendedId : summaryId;
      expect(manager.getLeafId()).toBe(expectedLeaf);
      expect(manager.getAppendParentId()).toBe(appendedId);
      expect(manager.getAppendMode()).toBe(kind === "side" ? "side" : undefined);
      const reopened = await SessionManager.openAsync(target);
      expect(reopened.getLeafId()).toBe(kind === "side" ? summaryId : appendedId);
      expect(reopened.getAppendParentId()).toBe(appendedId);
      const before = await loadTranscriptEvents(target);
      expect(before).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: summaryId, type: "branch_summary", parentId: selectedId }),
          expect.objectContaining({ id: appendedId, type: "message", parentId: summaryId }),
        ]),
      );
      await manager.appendMessageAsync({ role: "user", content: "continuation", timestamp: 4 });
      const after = await loadTranscriptEvents(target);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.at(-1)).toMatchObject({ type: "message", parentId: appendedId });
    });
  },
);

it.each(
  [
    { excludedAncestor: false, cursor: "opaque" },
    { excludedAncestor: true, cursor: "opaque" },
    { excludedAncestor: true, cursor: "excluded" },
  ].flatMap((fixture) => [false, true].map((incognito) => ({ ...fixture, incognito }))),
)(
  "resolves opaque leaf targets while preserving their raw append cursor (incognito=$incognito, excluded=$excludedAncestor, cursor=$cursor)",
  async ({ incognito, excludedAncestor, cursor }) => {
    await withOpenClawTestState({ label: "async-opaque-leaf" }, async (state) => {
      const { target, manager: source } = await openAsyncSessionFixture(
        state,
        "opaque-leaf",
        incognito,
      );
      const message = { role: "user" as const, content: "retained question", timestamp: 1 };
      const canonicalParent = excludedAncestor ? "excluded" : "user";
      const original = [
        expectDefined(source.getHeader(), "initialized transcript header"),
        {
          type: "message",
          id: "user",
          parentId: null,
          timestamp: new Date(1).toISOString(),
          message,
        },
        ...(excludedAncestor
          ? [
              {
                type: "message",
                id: "excluded",
                parentId: "user",
                timestamp: new Date(2).toISOString(),
                message: {
                  role: "user",
                  content: "excluded history",
                  timestamp: 2,
                  excludeFromContext: true,
                },
              },
            ]
          : []),
        {
          type: "future-metadata",
          id: "opaque",
          parentId: canonicalParent,
          data: "retained opaque bytes",
        },
        // An explicit older opaque parent remains canonical; an immediate raw cursor collapses.
        { type: "future-metadata", id: "other-opaque", parentId: "user" },
        {
          type: "message",
          id: "rejected",
          parentId: "opaque",
          timestamp: new Date(2).toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "rejected draft" }],
            timestamp: 2,
          },
        },
      ];
      await replaceTranscriptEvents(target, original);
      await waitForSessionTranscriptProjection(target);
      const manager = await SessionManager.openAsync(target, state.workspaceDir, {
        maxBytes: 4096,
        maxEvents: 2,
      });
      const history = manager[sessionManagerPrepareHistoryRead]();
      expect(await history.readEntryNavigation("rejected")).toMatchObject({
        type: "message",
        messageRole: "assistant",
        parentId: "opaque",
      });
      expect(await history.readEntryNavigation("opaque")).toEqual({
        id: "opaque",
        rawSeq: excludedAncestor ? 3 : 2,
        type: "opaque",
        parentId: canonicalParent,
        canonicalParentId: canonicalParent,
      });
      await expect(
        manager.appendLabelChangeAsync("opaque", "not a canonical label target"),
      ).rejects.toThrow("Entry opaque not found");

      const side = await manager.appendLeafControlAsync({
        targetId: "opaque",
        appendParentId: "rejected",
        appendMode: "side",
      });

      expect(side).toMatchObject({
        targetId: "opaque",
        appendParentId: "rejected",
        appendMode: "side",
      });
      expect(manager.getLeafId()).toBe("user");
      expect(manager.getAppendParentId()).toBe("rejected");
      const sideReopened = await SessionManager.openAsync(target, state.workspaceDir);
      expect(sideReopened.getLeafId()).toBe(canonicalParent);
      expect(sideReopened.getAppendParentId()).toBe("rejected");
      expect(sideReopened.getAppendMode()).toBe("side");

      const selectedTarget = excludedAncestor ? "opaque" : "user";
      const rewind = await manager.appendLeafControlAsync({
        targetId: selectedTarget,
        appendParentId: cursor,
      });

      expect(rewind).toMatchObject({
        targetId: selectedTarget,
        ...(selectedTarget !== cursor ? { appendParentId: cursor } : {}),
      });
      expect(manager.getLeafId()).toBe("user");
      expect(manager.getAppendParentId()).toBe(cursor);
      expect((await manager[sessionManagerPrepareHistoryRead]().readContext()).messages).toEqual([
        message,
      ]);
      const reopened = await SessionManager.openAsync(target, state.workspaceDir);
      expect(reopened.getLeafId()).toBe(canonicalParent);
      expect(reopened.getAppendParentId()).toBe(cursor);
      expect(await loadTranscriptEvents(target)).toEqual([...original, side, rewind]);
      if (excludedAncestor) {
        expect(manager.getEntry("excluded")).toBeUndefined();
      }

      const next = await manager.appendMessageWithTranscriptAnchorAsync({
        role: "user",
        content: "continue",
        timestamp: 3,
      });
      expect((await loadTranscriptEvents(target)).at(-1)).toMatchObject({
        id: next.entryId,
        parentId: cursor,
      });
      const appendedSeq = manager[sessionManagerResolveTranscriptSeq](next.entryId);
      const reopenedAfterAppend = await SessionManager.openAsync(target, state.workspaceDir);
      const reopenedSeq = reopenedAfterAppend[sessionManagerResolveTranscriptSeq](next.entryId);
      const paged = excludedAncestor && cursor === "opaque";
      if (paged) {
        for (let index = 0; index < 2; index++) {
          await manager.appendMessageAsync({
            role: "user",
            content: `preserved ${index}`,
            timestamp: index + 4,
          });
        }
        expect(manager.getEntry(next.entryId)).toBeUndefined();
      }
      let inspectedParent: string | null | undefined;
      const removed = await manager.removeTrailingEntriesAsync(
        (entry) => {
          if (entry.id !== next.entryId) {
            return false;
          }
          inspectedParent = entry.parentId;
          return entry.parentId === canonicalParent;
        },
        { preserveTrailing: (entry) => paged && entry.id !== next.entryId },
      );
      expect({ removed, parentId: inspectedParent }).toEqual({
        removed: 1,
        parentId: canonicalParent,
      });
      const persisted = await loadTranscriptEvents(target);
      expect(persisted).not.toContainEqual(expect.objectContaining({ id: next.entryId }));
      expect(manager.getAppendParentId()).toBe(selectedTarget);
      expect(parseOpaqueLeafEntry(persisted.at(-1))).toMatchObject({ targetId: selectedTarget });
      expect(appendedSeq).toBe(excludedAncestor ? 3 : 2);
      expect(reopenedSeq).toBe(appendedSeq);
      const resumed = await manager.appendMessageWithTranscriptAnchorAsync({
        role: "user",
        content: "resume after cleanup",
        timestamp: 6,
      });
      expect((await loadTranscriptEvents(target)).at(-1)).toMatchObject({
        id: resumed.entryId,
        parentId: selectedTarget,
      });
    });
  },
);

function refuseHostWrites() {
  const refuse = () => {
    throw new Error("Transcript persistence ran on the host");
  };
  vi.spyOn(hostTranscriptWriter, "appendTranscriptEventSnapshotSync").mockImplementation(refuse);
  vi.spyOn(hostTranscriptWriter, "appendTranscriptMessageSnapshotSync").mockImplementation(refuse);
}

function entryCases(manager: SessionManager, seed: string) {
  return [
    { type: "custom", append: () => manager.appendCustomEntryAsync("plugin-state", { count: 1 }) },
    { type: "session_info", append: () => manager.appendSessionInfoAsync("  Name\ncontinued  ") },
    {
      type: "custom_message",
      append: () =>
        manager.appendCustomMessageEntryAsync("notice", "Visible custom entry", true, {
          source: "fixture",
        }),
    },
    { type: "reset", append: () => manager.appendResetBoundaryAsync("reset", seed) },
    {
      type: "compaction",
      append: () =>
        manager.appendCompactionAsync(
          "Summary",
          seed,
          120,
          { source: "fixture" },
          true,
          undefined,
          20,
        ),
    },
    { type: "label", append: () => manager.appendLabelChangeAsync(seed, "bookmark") },
  ];
}

it("commits every awaited entry family in call order with stable ids, ancestry, and reopened state", async () => {
  await withOpenClawTestState({ label: "async-entry-family" }, async (state) => {
    const { target, manager } = await openAsyncSessionFixture(state, "family");
    refuseHostWrites();
    const seed = expectDefined(
      await manager.appendMessageAsync({ role: "user", content: "Seed", timestamp: 1 }),
      "committed seed entry id",
    );
    const cases = entryCases(manager, seed);
    const settled: string[] = [];
    const ids = await Promise.all(
      cases.map(({ type, append }) =>
        append().then((id) => {
          expect(manager.getEntry(id)).toMatchObject({ id, type });
          settled.push(type);
          return id;
        }),
      ),
    );
    expect(settled).toEqual(cases.map(({ type }) => type));
    expect(new Set(ids).size).toBe(cases.length);
    expect(manager.getEntries().map(({ id, parentId, type }) => ({ id, parentId, type }))).toEqual([
      { id: seed, parentId: null, type: "message" },
      ...ids.map((id, index) => ({
        id,
        parentId: index === 0 ? seed : ids[index - 1],
        type: cases[index]!.type,
      })),
    ]);
    expect(manager.getLeafId()).toBe(ids.at(-1));
    expect(manager.getAppendParentId()).toBe(ids.at(-1));
    expect(manager.getSessionName()).toBe("Name continued");
    expect(manager.getLabel(seed)).toBe("bookmark");
    expect(manager.getBoundaryCount()).toBe(2);
    const reopened = await SessionManager.openAsync(target, state.workspaceDir);
    expect(reopened.getEntries()).toEqual(manager.getEntries());
    expect(reopened.getLeafId()).toBe(manager.getLeafId());
    expect(reopened.getLabel(seed)).toBe("bookmark");
  });
});

it.each([
  ["persistent", "empty"],
  ["persistent", "before-reset"],
  ["persistent", "after-reset"],
  ["incognito", "empty"],
  ["incognito", "before-reset"],
  ["incognito", "after-reset"],
] as const)(
  "keeps the committed reset selection after a %s %s leaf control",
  async (storage, selection) => {
    await withOpenClawTestState({ label: "async-leaf-reset-selection" }, async (state) => {
      const { target, manager: source } = await openAsyncSessionFixture(
        state,
        `leaf-reset-${selection}`,
        storage === "incognito",
      );
      const old = await source.appendMessageWithTranscriptAnchorAsync({
        role: "user",
        content: "before reset",
        timestamp: 1,
      });
      await source.appendResetBoundaryAsync("new");
      const first = await source.appendMessageWithTranscriptAnchorAsync({
        role: "user",
        content: "after reset",
        timestamp: 2,
      });
      const latest = await source.appendMessageWithTranscriptAnchorAsync({
        role: "user",
        content: "latest turn",
        timestamp: 3,
      });
      const manager = await SessionManager.openBoundedAsync(target, {
        cwd: state.workspaceDir,
        maxBytes: 4096,
        maxEvents: 2,
      });
      expect(manager.getEntry(old.entryId)).toBeUndefined();
      const requested =
        selection === "empty" ? null : selection === "before-reset" ? old.entryId : first.entryId;
      const control = await manager.appendLeafControlAsync({
        targetId: requested,
        appendParentId: requested,
        appendMode: selection === "after-reset" ? undefined : "side",
      });
      const expectedLeaf = selection === "after-reset" ? first.entryId : latest.entryId;
      const expectedMessages =
        selection === "after-reset" ? ["after reset"] : ["after reset", "latest turn"];
      expect(control.targetId).toBe(requested);
      expect((await loadTranscriptEvents(target)).at(-1)).toEqual(control);
      expect(manager.getLeafId()).toBe(expectedLeaf);
      expect(manager.getAppendParentId()).toBe(expectedLeaf);
      expect(manager.getAppendMode()).toBeUndefined();
      expect(manager.buildSessionContext().messages.map((message) => message.content)).toEqual(
        expectedMessages,
      );
      expect(
        (await manager[sessionManagerPrepareHistoryRead]().readContext()).messages.map(
          (message) => message.content,
        ),
      ).toEqual(expectedMessages);
      const reopened = await SessionManager.openAsync(target, state.workspaceDir);
      expect(reopened.getLeafId()).toBe(expectedLeaf);
      expect(reopened.getAppendParentId()).toBe(expectedLeaf);
      expect(reopened.getAppendMode()).toBe(manager.getAppendMode());
      expect(reopened.buildSessionContext().messages.map((message) => message.content)).toEqual(
        expectedMessages,
      );
      const continued = await manager.appendMessageWithTranscriptAnchorAsync({
        role: "user",
        content: "continued",
        timestamp: 4,
      });
      expect((await loadTranscriptEvents(target)).at(-1)).toMatchObject({
        id: continued.entryId,
        parentId: expectedLeaf,
      });
      expect(
        (await manager[sessionManagerPrepareHistoryRead]().readContext()).messages.map(
          (message) => message.content,
        ),
      ).toEqual([...expectedMessages, "continued"]);
    });
  },
);

it("awaits leaf, branch, raw persistence, and static transcript operations without host writes", async () => {
  await withOpenClawTestState({ label: "async-entry-navigation" }, async (state) => {
    const { target, manager } = await openAsyncSessionFixture(state, "navigation");
    refuseHostWrites();
    const seed = expectDefined(
      await manager.appendMessageAsync({ role: "user", content: "Seed", timestamp: 1 }),
      "committed seed entry id",
    );
    const tail = await manager.appendCustomEntryAsync("tail", { retained: true });
    const leaf = await manager.appendLeafControlAsync({
      targetId: seed,
      appendParentId: tail,
      appendMode: "side",
    });
    expect(leaf).toMatchObject({
      type: "leaf",
      targetId: seed,
      appendParentId: tail,
      appendMode: "side",
    });
    const leafReopened = await SessionManager.openAsync(target, state.workspaceDir);
    expect(leafReopened.getLeafId()).toBe(seed);
    expect(leafReopened.getAppendParentId()).toBe(tail);
    expect(leafReopened.getAppendMode()).toBe("side");

    const newerUser = expectDefined(
      await leafReopened.appendMessageAsync({ role: "user", content: "Newer turn", timestamp: 2 }),
      "committed newer user id",
    );
    const beforeStaleLeaf = await loadTranscriptEvents(target);
    await expect(
      manager.appendLeafControlAsync({ targetId: seed, appendParentId: tail, appendMode: "side" }),
    ).rejects.toThrow("SQLite transcript changed");
    expect(manager.getLeafId()).toBe(seed);
    expect(manager.getAppendParentId()).toBe(tail);
    expect(await loadTranscriptEvents(target)).toEqual(beforeStaleLeaf);
    await manager.reloadPersistedTranscriptAsync();
    expect(manager.getLeafId()).toBe(newerUser);

    for (const branchTarget of [seed, null]) {
      const directSummary = await manager.branchWithSummaryAsync(branchTarget, "Explicit branch");
      expect(manager.getEntry(directSummary)).toMatchObject({
        type: "branch_summary",
        parentId: branchTarget,
        fromId: branchTarget ?? "root",
      });
      expect(manager.getBranch().map((entry) => entry.id)).toEqual(
        branchTarget === null ? [directSummary] : [seed, directSummary],
      );
      const directReopened = await SessionManager.openAsync(target, state.workspaceDir);
      expect(directReopened.getBranch()).toEqual(manager.getBranch());
    }

    await manager.branchAsync(seed);
    const summary = await manager.branchWithSummaryAsync(
      seed,
      "Selected branch",
      { source: "fixture" },
      true,
    );
    expect(manager.getEntry(summary)).toMatchObject({
      type: "branch_summary",
      parentId: seed,
      fromId: seed,
    });
    expect(manager.getLeafId()).toBe(summary);
    await manager.resetLeafAsync();
    const root = await manager.appendCustomEntryAsync("new-root");
    expect(manager.getEntry(root)?.parentId).toBeNull();

    const raw: SessionEntry = {
      type: "custom",
      customType: "raw-entry",
      data: 7,
      id: "raw-entry-id",
      parentId: root,
      timestamp: new Date(0).toISOString(),
    };
    expect(await manager.persistAsync(raw)).toBeUndefined();
    // Low-level persist retains its legacy contract: reload installs the recorded entry.
    await manager.reloadPersistedTranscriptAsync();
    expect(manager.getEntry(raw.id)).toEqual(raw);
    const staticId = await SessionManager.appendMessageToTranscriptAsync(target, {
      role: "custom",
      customType: "static-note",
      content: "Committed static note",
      display: true,
      timestamp: 2,
    });
    const reopened = await SessionManager.openAsync(target, state.workspaceDir);
    expect(reopened.getEntry(staticId)).toMatchObject({
      id: staticId,
      parentId: raw.id,
      type: "message",
      message: { content: "Committed static note" },
    });
    expect(reopened.getLeafId()).toBe(staticId);
  });
});

it("propagates queued write revocation and user/custom commit failures without publishing or falling back", async () => {
  await withOpenClawTestState({ label: "async-entry-failure" }, async (state) => {
    const { target, manager } = await openAsyncSessionFixture(state, "failure");
    refuseHostWrites();
    const seed = expectDefined(
      await manager.appendMessageAsync({ role: "user", content: "Seed", timestamp: 1 }),
      "committed seed entry id",
    );
    const before = await loadTranscriptEvents(target);
    const entries = manager.getEntries();
    const appenders: Array<() => Promise<unknown>> = [
      ...entryCases(manager, seed).map(({ append }) => append),
      () => manager.appendLeafControlAsync({ targetId: seed, appendParentId: seed }),
      () => manager.branchWithSummaryAsync(seed, "Refused branch"),
      () =>
        manager.persistAsync({
          type: "custom",
          customType: "refused-raw",
          id: "refused-raw",
          parentId: seed,
          timestamp: new Date(0).toISOString(),
        }),
    ];
    for (const append of appenders) {
      let active = true;
      const pending = withSessionTranscriptWriteAssertion(
        target,
        () => {
          if (!active) {
            throw new Error("write owner revoked");
          }
        },
        append,
      );
      active = false;
      await expect(pending).rejects.toThrow("write owner revoked");
    }
    for (const message of [
      { role: "user" as const, content: "Refused user", timestamp: 2 },
      {
        role: "custom" as const,
        customType: "refused-note",
        content: "Refused custom",
        display: true,
        timestamp: 3,
      },
    ]) {
      const commit = vi.fn(() => {
        throw new Error("fresh commit refused");
      });
      await expect(
        manager.appendMessageAsync(message, { beforeFreshMessageCommit: commit }),
      ).rejects.toThrow("fresh commit refused");
      expect(commit).toHaveBeenCalledOnce();
    }
    await expect(
      manager.persistAsync(
        {
          type: "custom",
          customType: "stale-write",
          id: "stale-write",
          parentId: seed,
          timestamp: new Date(0).toISOString(),
        },
        { expectedMutationAt: null },
      ),
    ).rejects.toThrow();
    expect(manager.getEntries()).toEqual(entries);
    expect(await loadTranscriptEvents(target)).toEqual(before);
    const recovered = await manager.appendCustomEntryAsync("after-failure");
    expect(manager.getEntry(recovered)?.parentId).toBe(seed);
  });
});

it("warns once per synchronous method across manager instances while preserving compatibility results", () => {
  const methods = [
    ["appendCustomEntry", "appendCustomEntryAsync"],
    ["appendSessionInfo", "appendSessionInfoAsync"],
  ] as const;
  const warned = readGlobalSingleton(Symbol.for("openclaw.sessionPersistenceDeprecations"));
  if (!(warned instanceof Set)) {
    throw new Error("Expected the process-wide session persistence warning registry");
  }
  // Shared Vitest workers retain earlier files' process-wide warning budgets.
  const priorWarnings = methods.map(([method]) => {
    const key = `SessionManager.${method}`;
    return { key, existed: warned.delete(key) };
  });
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  try {
    for (let index = 0; index < 2; index++) {
      const manager = SessionManager.inMemory();
      const id = manager.appendCustomEntry("legacy", { index });
      expect(manager.getEntry(id)).toMatchObject({ id, customType: "legacy", data: { index } });
      const info = manager.appendSessionInfo("Legacy name");
      expect(manager.getEntry(info)).toMatchObject({ id: info, type: "session_info" });
    }
    for (const [method, replacement] of methods) {
      const calls = warning.mock.calls.filter(([message]) =>
        String(message).startsWith(`SessionManager.${method} is deprecated;`),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toContain(replacement);
      expect(calls[0]?.[1]).toMatchObject({
        code: "DEP_SESSION_PERSISTENCE",
        type: "DeprecationWarning",
      });
    }
  } finally {
    warning.mockRestore();
    for (const { key, existed } of priorWarnings) {
      if (existed) {
        warned.add(key);
      } else {
        warned.delete(key);
      }
    }
  }
});

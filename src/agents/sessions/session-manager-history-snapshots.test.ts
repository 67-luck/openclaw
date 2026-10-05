import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  loadTranscriptEvents,
  replaceTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { readSessionTranscriptResidentContext } from "../../config/sessions/session-transcript-resident-context.worker.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { canonicalTarget } from "./session-manager-hydration.test-support.js";
import { SessionManager } from "./session-manager.js";

it("keeps the current user through append eviction after a forward-parent import", async () => {
  await withOpenClawTestState({ label: "bounded-forward-parent" }, async (state) => {
    const target = canonicalTarget(state, "bounded-forward-parent");
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const user = {
      type: "message",
      id: "current-user",
      parentId: null,
      message: makeUserMessage("current request", 1),
    };
    const omitted = {
      type: "message",
      id: "omitted-answer",
      parentId: user.id,
      message: makeAgentAssistantMessage({ content: [{ type: "text", text: "omitted answer" }] }),
    };
    const current = {
      type: "message",
      id: "current-answer",
      parentId: omitted.id,
      message: makeAgentAssistantMessage({ content: [{ type: "text", text: "current answer" }] }),
    };
    const events = [
      { type: "session", version: 3, id: target.sessionId, cwd: state.workspaceDir },
      omitted,
      current,
      user,
      { type: "leaf", id: "selected-leaf", parentId: user.id, targetId: current.id },
    ];
    expect(replaceTranscriptEventsSync(target, events)).toBe(true);
    const manager = await SessionManager.openBoundedAsync(target, {
      maxEvents: 1,
      maxBytes: 4096,
    });
    await manager.reloadPersistedTranscriptAsync();
    expect(manager.getEntry(omitted.id)).toBeUndefined();
    expect(manager.getEntry(user.id)).toEqual(user);
    expect(manager.buildSessionContext().messages).toEqual([current.message]);
    expect(await loadTranscriptEvents(target)).toEqual(events);

    const appended = await manager.appendMessageAsync(
      makeAgentAssistantMessage({ content: [{ type: "text", text: "continued answer" }] }),
    );
    expect(manager.getEntry(user.id)).toEqual(user);
    expect(manager.getEntry(current.id)).toBeUndefined();
    expect(manager.getBranch().map(({ id }) => id)).toEqual([user.id, appended]);
    expect((await loadTranscriptEvents(target)).slice(0, events.length)).toEqual(events);
  });
});

it.each(["selected", "receipt", "unreadable-prefix", "unreadable-parent"] as const)(
  "preserves off-branch metadata ancestry and ordinals through a %s handoff",
  async (handoff) => {
    await withOpenClawTestState({ label: "off-branch-metadata-facts" }, async (state) => {
      const target = canonicalTarget(state, "off-branch-metadata-facts");
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const manager = await SessionManager.openBoundedAsync(target, {
        maxBytes: 4096,
        maxEvents: 1,
      });
      const ancestorMessage = makeUserMessage("metadata branch", 1);
      const ancestor = await manager.appendMessageAsync(ancestorMessage);
      const metadata = await manager.appendCustomEntryAsync("retained-state", { exact: true });
      manager.resetLeaf();
      const unreadable =
        handoff === "unreadable-prefix"
          ? await manager.appendMessageAsync(makeUserMessage("unrelated omitted root", 2))
          : undefined;
      if (unreadable) {
        manager.resetLeaf();
      }
      const sibling = await manager.appendMessageAsync(makeUserMessage("sibling root", 3));
      assert(ancestor && sibling);
      await manager.branchAsync(sibling);
      if (handoff === "receipt") {
        const temporary = await manager.appendMessageAsync(makeUserMessage("temporary sibling", 3));
        expect(await manager.removeTrailingEntriesAsync((entry) => entry.id === temporary)).toBe(1);
      }
      if (handoff === "unreadable-prefix" || handoff === "unreadable-parent") {
        let expected = await loadTranscriptEvents(target);
        const sideId = "unreadable-side-ancestor";
        if (handoff === "unreadable-parent") {
          const metadataIndex = expected.findIndex(
            (entry) => isRecord(entry) && entry.id === metadata,
          );
          const entry = expected[metadataIndex];
          assert(isRecord(entry));
          expected = [
            ...expected.slice(0, metadataIndex),
            {
              type: "message",
              id: sideId,
              parentId: ancestor,
              appendMode: "side",
              timestamp: new Date(2).toISOString(),
              message: makeUserMessage("side cursor", 2),
            },
            { ...entry, parentId: sideId },
            ...expected.slice(metadataIndex + 1),
          ];
        }
        expect(replaceTranscriptEventsSync(target, expected)).toBe(true);
        const read = () =>
          readSessionTranscriptResidentContext(target, {
            maxBytes: 4096,
            maxEvents: 1,
            retainedEntryIds: [metadata],
          });
        expect(read().parents.get(metadata)).toEqual({
          rawParentId: ancestor,
          canonicalParentId: ancestor,
        });
        const corruptId = handoff === "unreadable-prefix" ? unreadable : sideId;
        assert(corruptId);
        const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        const payload = database.db
          .prepare(
            "SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = (SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?)",
          )
          .get(target.sessionId, target.sessionId, corruptId);
        assert(typeof payload?.event_json === "string");
        const replace = database.db.prepare(
          "UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = (SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?)",
        );
        replace.run("{", target.sessionId, target.sessionId, corruptId);
        try {
          if (handoff === "unreadable-parent") {
            expect(read).toThrow(SyntaxError);
          } else {
            const snapshot = read();
            expect(snapshot.parents.get(metadata)).toEqual({
              rawParentId: ancestor,
              canonicalParentId: ancestor,
            });
            expect(snapshot.entryTranscriptSeqs.get(ancestor)).toBe(1);
            expect(snapshot.entryTranscriptSeqs.get(metadata)).toBe(1);
            expect(snapshot.entryTranscriptSeqs.get(sibling)).toBe(1);
          }
        } finally {
          replace.run(payload.event_json, target.sessionId, target.sessionId, corruptId);
        }
        expect(await loadTranscriptEvents(target)).toEqual(expected);
        return;
      }
      expect(manager.getEntry(ancestor)).toBeUndefined();
      expect(manager.getEntry(metadata)).toMatchObject({ type: "custom", data: { exact: true } });
      manager.branch(metadata);
      const ordinals: Array<number | undefined> = [];
      const stop = onInternalSessionTranscriptUpdate((update) => {
        if (update.sessionId === target.sessionId && update.messageId) {
          ordinals.push(update.messageSeq);
        }
      });
      try {
        const continuedMessage = makeUserMessage("continued metadata branch", 4);
        const continued = await guardSessionManager(manager).appendMessageAsync(continuedMessage);
        assert(continued);
        expect(ordinals).toEqual([2]);
        const reopened = await SessionManager.openAsync(target);
        expect(reopened.getBranch().map(({ id }) => id)).toEqual([ancestor, metadata, continued]);
        expect(reopened.buildSessionContext().messages).toEqual([
          ancestorMessage,
          continuedMessage,
        ]);
        expect(
          await manager.removeTrailingEntriesAsync(
            (entry) =>
              entry.id === continued || (entry.id === metadata && entry.parentId === ancestor),
          ),
        ).toBe(2);
        expect(await loadTranscriptEvents(target)).not.toContainEqual(
          expect.objectContaining({ id: metadata }),
        );
      } finally {
        stop();
      }
    });
  },
);

it.each(["before", "inside"] as const)(
  "keeps active compaction cuts with retained off-branch metadata %s the retention range",
  async (position) => {
    await withOpenClawTestState({ label: "active-retention-cut" }, async (state) => {
      const target = canonicalTarget(state, "active-retention-cut");
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const manager = await SessionManager.openBoundedAsync(target, {
        maxBytes: 4096,
        maxEvents: 1,
      });
      const data = { retained: "plugin state" };
      let metadata: string;
      let first: string | undefined;
      if (position === "before") {
        metadata = await manager.appendCustomEntryAsync("plugin-state", data);
        manager.resetLeaf();
        first = await manager.appendMessageAsync(makeUserMessage("omitted first-kept message", 1));
      } else {
        first = await manager.appendMessageAsync(makeUserMessage("omitted first-kept message", 1));
        assert(first);
        metadata = await manager.appendCustomEntryAsync("plugin-state", data);
        await manager.branchAsync(first);
      }
      assert(first);
      const retainedMessage = makeUserMessage("retained active message", 2);
      const retained = await manager.appendMessageAsync(retainedMessage);
      assert(retained);
      const boundary = await manager.appendCompactionAsync("earlier summary", first, 100);
      const temporary = await manager.appendMessageAsync(makeUserMessage("temporary tail", 3));
      assert(temporary);
      expect(await manager.removeTrailingEntriesAsync((entry) => entry.id === temporary)).toBe(1);

      expect(manager.getEntry(first)).toBeUndefined();
      expect(manager.getEntry(metadata)).toMatchObject({ type: "custom", data });
      expect(manager.getBranch().map(({ id }) => id)).not.toContain(metadata);
      expect(manager.buildSessionContext().messages).toContainEqual(retainedMessage);
      expect(manager.getEntry(boundary)).toMatchObject({ firstKeptEntryId: retained });
      expect(await loadTranscriptEvents(target)).toContainEqual(
        expect.objectContaining({ id: boundary, firstKeptEntryId: first }),
      );
    });
  },
);

import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  loadTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  importSqliteSessionRows,
  seedUnindexedTranscriptForTest,
} from "../../config/sessions/session-accessor.sqlite-import.test-support.js";
import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import { readSessionTranscriptHistoryPage } from "../../config/sessions/session-transcript-history-read.js";
import { readSessionTranscriptResidentContext } from "../../config/sessions/session-transcript-resident-context.worker.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { SessionManager } from "./session-manager.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const stateDir of dirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    cleanup();
  }),
);
async function fixture(data: unknown, prefixEntries = 0, maxEvents = 20) {
  const dir = dirs.make("retained-transcript-data-");
  const scope = {
    agentId: "main",
    sessionId: "retained",
    sessionKey: "agent:main:retained",
    storePath: path.join(dir, "sessions.json"),
  };
  const entry = {
    sessionId: scope.sessionId,
    updatedAt: 1,
    activeWriterRunId: "writer",
    lifecycleRevision: "lifecycle",
  };
  await upsertSessionEntryCore(scope, entry);
  const seed = SessionManager.open(scope, dir);
  const userId = seed.appendMessage({ role: "user", content: "retained user", timestamp: 1 });
  const manager = SessionManager.openBounded(scope, { cwd: dir, maxEvents, maxBytes: 4096 });
  for (let index = 0; index < prefixEntries; index += 1) {
    manager.appendCustomEntry("prefix", { index });
  }
  const assistantId = manager.appendMessage({
    role: "assistant",
    content: [],
    api: "messages",
    provider: "anthropic",
    model: "test-model",
    usage: createZeroUsageFixture(),
    stopReason: "aborted",
    timestamp: 2,
  });
  const metadataId = manager.appendCustomEntry("plugin-state", data);
  const remove = () =>
    manager.removeTrailingEntries((e) => e.id === assistantId, {
      preserveTrailing: (e) => e.type === "custom",
    });
  const database = openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  return { scope, entry, dir, userId, manager, assistantId, metadataId, remove, database };
}

describe("bounded cleanup retaining opaque custom data", () => {
  it.each([
    ["active", false],
    ["inactive", false],
    ["active", true],
    ["inactive", true],
  ] as const)(
    "removes evicted unindexed legacy assistants from a selected %s branch (incognito=%s)",
    async (selection, incognito) => {
      const dir = dirs.make("retained-legacy-cleanup-");
      const scope = {
        agentId: "main",
        sessionId: "legacy-cleanup",
        sessionKey: incognito
          ? "agent:main:dashboard:incognito-legacy-cleanup"
          : "agent:main:legacy-cleanup",
        storePath: path.join(dir, "sessions.json"),
        env: { OPENCLAW_STATE_DIR: dir },
      };
      const user = {
        type: "message",
        id: "user",
        parentId: null,
        message: { role: "user", content: "retained user", timestamp: 1 },
      };
      const sibling = { ...user, id: "sibling", parentId: user.id };
      const events = [
        { type: "session", id: scope.sessionId, version: 3, cwd: dir },
        user,
        ...["first", "second"].map((id, index) => ({
          type: "message",
          id,
          parentId: index === 0 ? user.id : "first",
          message: {
            role: "assistant",
            content: [{ type: "text", text: id }],
            usage: createZeroUsageFixture(),
            stopReason: "aborted",
            timestamp: index + 2,
          },
        })),
        ...(selection === "inactive" ? [sibling] : []),
      ].map((event, index) => {
        const encoded = JSON.stringify(event);
        return index === 1 ? '{"id":"ignored",' + encoded.slice(1) : encoded;
      });
      await seedUnindexedTranscriptForTest({
        ...scope,
        entry: {
          sessionId: scope.sessionId,
          updatedAt: 1,
          ...(incognito ? { incognito: true } : {}),
        },
        events: events.map((event_json, seq) => ({
          session_id: scope.sessionId,
          seq,
          event_json,
          created_at: seq,
        })),
      });
      const database = openOpenClawAgentDatabase({
        agentId: scope.agentId,
        env: scope.env,
        path: resolveSessionTranscriptDatabasePath(scope),
      });
      const manager = await SessionManager.openBoundedAsync(scope, {
        maxBytes: 4096,
        maxEvents: 1,
      });
      if (selection === "inactive") {
        await manager.branchAsync("second");
      }
      expect(manager.getLeafId()).toBe("second");
      expect(manager.getEntry("first")).toBeUndefined();
      expect(
        database.db
          .prepare("SELECT count(*) AS count FROM transcript_event_identities WHERE session_id = ?")
          .get(scope.sessionId),
      ).toEqual({ count: 0 });

      await expect(
        manager.removeTrailingEntriesAsync(
          (entry) => entry.type === "message" && entry.message.role === "assistant",
        ),
      ).resolves.toBe(2);

      expect(manager.getLeafId()).toBe(user.id);
      const reopened = await SessionManager.openAsync(scope);
      expect(reopened.getBranch().map((entry) => entry.id)).toEqual([user.id]);
      expect(reopened.getEntry("first")).toBeUndefined();
      expect(reopened.getEntry("second")).toBeUndefined();
      if (selection === "inactive") {
        expect(reopened.getEntry(sibling.id)).toMatchObject(sibling);
        expect(
          database.db
            .prepare("SELECT event_json FROM transcript_events WHERE session_id = ?")
            .all(scope.sessionId),
        ).toContainEqual({ event_json: events.at(-1) });
      }
      expect(
        database.db
          .prepare(
            "SELECT event_json FROM transcript_events WHERE session_id = ? AND seq < 2 ORDER BY seq",
          )
          .all(scope.sessionId),
      ).toEqual(events.slice(0, 2).map((event_json) => ({ event_json })));
    },
  );

  it.each(["selected", "omitted"] as const)(
    "preserves navigation through an over-depth legacy message when %s",
    async (selection) => {
      const dir = dirs.make("retained-deep-navigation-");
      const scope = {
        agentId: "main",
        sessionId: "deep-navigation",
        sessionKey: "agent:main:deep-navigation",
        storePath: path.join(dir, "sessions.json"),
      };
      const details: unknown = JSON.parse("[".repeat(1_100) + "0" + "]".repeat(1_100));
      const deep = {
        type: "message",
        id: "deep",
        parentId: "compaction",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "deep legacy response" }],
          details,
          usage: { ...createZeroUsageFixture(), input: 99, totalTokens: 99 },
          stopReason: "stop",
          timestamp: 2,
        },
      };
      const tail = {
        type: "message",
        id: "tail",
        parentId: deep.id,
        message: { role: "user", content: "current user", timestamp: 3 },
      };
      const deepJson = '{"id":"ignored",' + JSON.stringify(deep).slice(1);
      const events = [
        JSON.stringify({ type: "session", id: scope.sessionId, version: 3, cwd: dir }),
        JSON.stringify({
          type: "message",
          id: "user",
          parentId: null,
          message: { role: "user", content: "original user", timestamp: 1 },
        }),
        JSON.stringify({
          type: "compaction",
          id: "compaction",
          parentId: "user",
          summary: "summary",
          firstKeptEntryId: "user",
          tokensBefore: 100,
        }),
        deepJson,
        ...(selection === "omitted" ? [JSON.stringify(tail)] : []),
      ];
      await seedUnindexedTranscriptForTest({
        ...scope,
        entry: { sessionId: scope.sessionId, updatedAt: 1 },
        events: events.map((event_json, seq) => ({
          session_id: scope.sessionId,
          seq,
          event_json,
          created_at: seq,
        })),
      });
      const database = openOpenClawAgentDatabase({
        agentId: scope.agentId,
        path: resolveSessionTranscriptDatabasePath(scope),
      });
      expect(database.db.prepare("SELECT json_valid(?) AS valid").get(deepJson)).toEqual({
        valid: 0,
      });

      const resident = readSessionTranscriptResidentContext(scope, {
        maxBytes: 4096,
        maxEvents: 1,
        ...(selection === "selected" ? { selectedLeafEntryId: deep.id } : {}),
      });
      const { selectedContext } = readSessionTranscriptHistoryPage(database, scope, {
        operation: "history-page",
        version: resident.version,
        appendParentId: resident.activeLeafEntryId,
        leafId: resident.activeLeafEntryId,
        selection: "window",
        direction: "forward",
        offset: 0,
        maxBytes: 4096,
        maxEvents: 1,
        retainedEntryIds: [],
        retainedCustomDataIds: [],
      });
      if (!selectedContext) {
        throw new Error("History reader returned no selected context");
      }

      for (const snapshot of [resident, selectedContext]) {
        const retainedDeep = snapshot.events.find(
          (event) => isIndexedSessionEntry(event) && event.id === deep.id,
        );
        if (selection === "selected") {
          const canonicalDeep: unknown = JSON.parse(deepJson);
          expect(JSON.stringify(retainedDeep)).toBe(JSON.stringify(canonicalDeep));
          expect(snapshot.entryTranscriptSeqs.get(deep.id)).toBe(3);
        } else {
          expect(retainedDeep).toBeUndefined();
          expect(snapshot.events).toContainEqual(tail);
          expect(snapshot.entryTranscriptSeqs.get(tail.id)).toBe(4);
        }
        expect(snapshot.entryTranscriptSeqs.has("ignored")).toBe(false);
      }
      expect(
        database.db
          .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = 3")
          .get(scope.sessionId),
      ).toEqual({ event_json: deepJson });
    },
  );

  it.each(["target", "label"] as const)(
    "retains a labeled legacy handoff target when only its %s has indexed ownership",
    async (indexed) => {
      const dir = dirs.make("retained-legacy-label-");
      const scope = {
        agentId: "main",
        sessionId: "legacy-label",
        sessionKey: "agent:main:legacy-label",
        storePath: path.join(dir, "sessions.json"),
      };
      const entry = { sessionId: scope.sessionId, updatedAt: 1 };
      const target = {
        type: "message",
        id: "labeled",
        parentId: null,
        message: { role: "user", content: "legacy target", timestamp: 1 },
      };
      const label = {
        type: "label",
        id: "bookmark",
        parentId: target.id,
        targetId: target.id,
        label: "keep this entry",
      };
      const legacy = [
        JSON.stringify({ type: "session", id: scope.sessionId, version: 3, cwd: dir }),
        JSON.stringify({ ...target, id: "unlabeled" }),
        JSON.stringify({ ...target, message: { ...target.message, content: "superseded target" } }),
        // Exact handoffs preserve duplicate root members; the navigation parser owns last-key semantics.
        '{"id":"ignored",' + JSON.stringify(target).slice(1),
        ...(indexed === "target"
          ? ['{"targetId":"unlabeled",' + JSON.stringify(label).slice(1)]
          : []),
      ];
      await seedUnindexedTranscriptForTest({
        ...scope,
        entry,
        events: legacy.map((event_json, seq) => ({
          session_id: scope.sessionId,
          seq,
          event_json,
          created_at: seq,
        })),
      });
      const indexedTarget = {
        ...target,
        message: { ...target.message, content: "indexed target" },
      };
      await importSqliteSessionRows({
        ...scope,
        entry,
        readTranscriptEvents: (append) => {
          append(indexed === "target" ? indexedTarget : label);
          append({
            ...target,
            id: "latest-user",
            parentId: indexed === "target" ? target.id : label.id,
            message: { role: "user", content: "current user", timestamp: 2 },
          });
          append({
            type: "message",
            id: "latest-assistant",
            parentId: "latest-user",
            message: {
              role: "assistant",
              content: [],
              api: "messages",
              provider: "anthropic",
              model: "test-model",
              usage: createZeroUsageFixture(),
              stopReason: "stop",
              timestamp: 3,
            },
          });
        },
      });
      const database = openOpenClawAgentDatabase({
        agentId: scope.agentId,
        path: resolveSessionTranscriptDatabasePath(scope),
      });
      const identityIds = () =>
        database.db
          .prepare(
            "SELECT event_id FROM transcript_event_identities WHERE session_id = ? AND event_id IN ('labeled', 'bookmark') ORDER BY event_id",
          )
          .all(scope.sessionId);
      expect(identityIds()).toEqual([{ event_id: indexed === "target" ? target.id : label.id }]);

      const snapshot = readSessionTranscriptResidentContext(scope, {
        maxBytes: 4096,
        maxEvents: 1,
        retainedEntryIds: [label.id],
      });

      expect(
        snapshot.events.filter((event) => isIndexedSessionEntry(event) && event.id === target.id),
      ).toEqual([indexed === "target" ? indexedTarget : target]);
      expect(snapshot.events).toContainEqual(label);
      expect(snapshot.events).not.toContainEqual(expect.objectContaining({ id: "unlabeled" }));
      expect(identityIds()).toEqual([{ event_id: indexed === "target" ? target.id : label.id }]);
    },
  );

  it("rejects an unreadable indexed label dependency despite its earlier legacy ID", async () => {
    const dir = dirs.make("retained-unreadable-label-dependency-");
    const scope = {
      agentId: "main",
      sessionId: "unreadable-label-dependency",
      sessionKey: "agent:main:unreadable-label-dependency",
      storePath: path.join(dir, "sessions.json"),
    };
    const entry = { sessionId: scope.sessionId, updatedAt: 1 };
    const target = {
      type: "message",
      id: "target",
      parentId: null,
      message: { role: "assistant", content: [{ type: "text", text: "saved answer" }] },
    };
    const user = {
      type: "message",
      id: "user",
      parentId: target.id,
      message: { role: "user", content: "newer question", timestamp: 2 },
    };
    const legacy = [
      { type: "session", id: scope.sessionId, version: 3, cwd: dir },
      target,
      user,
      { type: "custom", id: "inner", parentId: user.id, customType: "legacy-state" },
    ];
    await seedUnindexedTranscriptForTest({
      ...scope,
      entry,
      events: legacy.map((event, seq) => ({
        session_id: scope.sessionId,
        seq,
        event_json: JSON.stringify(event),
        created_at: seq,
      })),
    });
    const inner = {
      type: "label",
      id: "inner",
      parentId: user.id,
      targetId: target.id,
      label: "saved answer",
    };
    const outer = {
      type: "label",
      id: "outer",
      parentId: user.id,
      targetId: inner.id,
      label: "saved label",
    };
    await importSqliteSessionRows({
      ...scope,
      entry,
      readTranscriptEvents: (append) => {
        append(inner);
        append(outer);
      },
    });
    const read = () =>
      readSessionTranscriptResidentContext(scope, { maxBytes: 4096, maxEvents: 1 });
    const before = read();
    expect(before.events).toContainEqual(inner);
    expect(before.events).toContainEqual(target);
    expect(before.events).toContainEqual(outer);
    const database = openOpenClawAgentDatabase({
      agentId: scope.agentId,
      path: resolveSessionTranscriptDatabasePath(scope),
    });
    // Keep indexed identity and the active branch intact; only the required off-branch bytes break.
    database.db
      .prepare(
        `UPDATE transcript_events SET event_json = '{', event_zstd = NULL,
         event_utf8_bytes = 1, navigation_json = NULL
         WHERE session_id = ? AND seq = (
           SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?
         )`,
      )
      .run(scope.sessionId, scope.sessionId, inner.id);

    expect(read).toThrow(SyntaxError);
  });

  it.each([
    { maxEvents: 1, gap: true },
    { maxEvents: 4, gap: false },
  ])(
    "checks the logical predecessor behind a resident side cursor (gap=$gap)",
    async ({ maxEvents, gap }) => {
      const data = { retained: "side metadata" };
      const f = await fixture(data, 0, maxEvents);
      f.manager.appendLeafControl({
        targetId: f.assistantId,
        appendParentId: f.metadataId,
        appendMode: "side",
      });
      const lastAssistant = f.manager.appendMessage({
        role: "assistant",
        content: [],
        api: "messages",
        provider: "anthropic",
        model: "test-model",
        usage: createZeroUsageFixture(),
        stopReason: "aborted",
        timestamp: 3,
      });
      const before = loadTranscriptEventsSync(f.scope);
      const liveBefore = f.manager.getEntries();
      expect(before.at(-1)).toMatchObject({ id: lastAssistant, parentId: f.metadataId });
      expect(f.manager.getBranch().map((entry) => entry.id)).toEqual(
        gap ? [f.userId, lastAssistant] : [f.userId, f.assistantId, lastAssistant],
      );
      expect(f.manager.getEntry(f.metadataId)).toMatchObject({ type: "custom", data });
      let removed: number | undefined;
      let failure: unknown;
      try {
        removed = f.manager.removeTrailingEntries(
          (entry) => entry.type === "message" && entry.message.role === "assistant",
        );
      } catch (error) {
        failure = error;
      }
      const events = loadTranscriptEventsSync(f.scope);
      if (gap) {
        expect({ removed, failure, events }).toEqual({
          removed: undefined,
          failure: new RangeError(
            "Bounded transcript cleanup cannot cross the hydrated removal window",
          ),
          events: before,
        });
        expect(f.manager.getEntries()).toEqual(liveBefore);
        expect(f.manager.getLeafId()).toBe(lastAssistant);
        expect(f.manager.getAppendParentId()).toBe(lastAssistant);
      } else {
        expect(failure).toBeUndefined();
        expect(removed).toBe(2);
        expect(f.manager.getEntry(f.assistantId)).toBeUndefined();
        expect(f.manager.getEntry(lastAssistant)).toBeUndefined();
        expect(f.manager.getEntry(f.metadataId)).toMatchObject({ type: "custom", data });
        expect(f.manager.getLeafId()).toBe(f.userId);
        for (const id of [f.assistantId, lastAssistant]) {
          expect(events).not.toContainEqual(expect.objectContaining({ id }));
        }
      }
    },
  );

  it.each([
    { label: "null", data: null },
    { label: "boolean", data: true },
    { label: "3 MiB", data: { value: "x".repeat(3 * 1024 * 1024) } },
    { label: "5 MiB", data: { value: "x".repeat(5 * 1024 * 1024) } },
  ])("preserves $label data and repaired parent without staged rows escaping", async ({ data }) => {
    const f = await fixture(data);
    const before = loadTranscriptEventsSync(f.scope);
    expect(f.remove()).toBe(1);
    const rows = loadTranscriptEventsSync(f.scope) as Array<{
      id?: string;
      type?: string;
      data?: unknown;
      parentId?: string;
    }>;
    expect(rows.filter((row) => row.id === f.assistantId)).toHaveLength(0);
    const metadata = rows.find((row) => row.id === f.metadataId);
    expect(metadata?.parentId).toBe(f.userId);
    expect(isDeepStrictEqual(metadata?.data, data)).toBe(true);
    expect(isDeepStrictEqual(f.manager.getEntry(f.metadataId), metadata)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(before.length);
    const integrity = f.database.db.prepare("PRAGMA foreign_key_check").all();
    expect(integrity).toEqual([]);
    const sequences = f.database.db
      .prepare("SELECT seq FROM transcript_events WHERE session_id = ? ORDER BY seq")
      .all(f.scope.sessionId) as Array<{ seq: number }>;
    expect(sequences.map((row) => row.seq)).toEqual(
      Array.from({ length: rows.length }, (_, index) => index),
    );
  });

  it.each(["sqlite", "identity", "writer", "lifecycle", "append"])(
    "keeps durable and live history intact after %s rejection",
    async (failure) => {
      const f = await fixture({ value: "x".repeat(3 * 1024 * 1024) });
      const liveIds = f.manager.getEntries().map((e) => e.id);
      const parent = f.manager.getAppendParentId();
      if (failure === "sqlite") {
        // The staging insert succeeds; fail the final compacted metadata insertion after deletion.
        f.database.db.exec(
          "CREATE TRIGGER reject_final_suffix BEFORE INSERT ON transcript_events WHEN NEW.seq = 2 BEGIN SELECT RAISE(ABORT, 'reject final suffix'); END;",
        );
      } else if (failure === "append") {
        await appendTranscriptMessage(f.scope, {
          cwd: f.dir,
          eventId: "concurrent",
          message: { role: "user", content: "concurrent", timestamp: 3 },
        });
      } else {
        await updateSessionEntry(f.scope, () =>
          failure === "identity"
            ? { sessionId: "replacement" }
            : failure === "writer"
              ? { activeWriterRunId: "replacement" }
              : { lifecycleRevision: "replacement" },
        );
      }
      const before = JSON.stringify(loadTranscriptEventsSync(f.scope));
      await expect(
        withOwnedSessionTranscriptWrites(
          {
            ...(failure === "writer" || failure === "lifecycle"
              ? {
                  sessionTarget: {
                    ...f.scope,
                    expectedWriterRunId: "writer",
                    expectedLifecycleRevision: "lifecycle",
                  },
                }
              : {}),
            withTranscriptWrite: async (run) => await run(),
          },
          async () => f.remove(),
        ),
      ).rejects.toThrow();
      expect(JSON.stringify(loadTranscriptEventsSync(f.scope)) === before).toBe(true);
      expect(f.manager.getEntries().map((e) => e.id)).toEqual(liveIds);
      expect(f.manager.getAppendParentId()).toBe(parent);
      if (failure === "sqlite") {
        f.database.db.exec("DROP TRIGGER reject_final_suffix");
        expect(f.remove()).toBe(1);
      }
    },
  );
  it("adopts retained data only when the outer transaction commits", async () => {
    const f = await fixture({ value: "x".repeat(3 * 1024 * 1024) });
    const options = {
      agentId: f.scope.agentId,
      path: resolveSessionTranscriptDatabasePath(f.scope),
    };
    const before = JSON.stringify(loadTranscriptEventsSync(f.scope));
    const liveIds = f.manager.getEntries().map((entry) => entry.id);
    expect(() =>
      runOpenClawAgentWriteTransaction(() => {
        expect(f.remove()).toBe(1);
        expect(f.manager.getEntries().map((entry) => entry.id)).toEqual(liveIds);
        throw new Error("outer rollback");
      }, options),
    ).toThrow("outer rollback");
    expect(JSON.stringify(loadTranscriptEventsSync(f.scope)) === before).toBe(true);
    expect(f.manager.getEntries().map((entry) => entry.id)).toEqual(liveIds);
    runOpenClawAgentWriteTransaction(() => {
      expect(f.remove()).toBe(1);
    }, options);
    expect(f.manager.getEntry(f.assistantId)).toBeUndefined();
    expect(f.database.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("keeps unchanged-prefix IDs out of a tiny suffix query", async () => {
    const f = await fixture({ retained: true }, 40);
    const prepare = f.database.db.prepare.bind(f.database.db);
    let maxParameters = 0;
    const spy = vi.spyOn(f.database.db, "prepare").mockImplementation((query) => {
      maxParameters = Math.max(maxParameters, query.match(/\?/g)?.length ?? 0);
      return prepare(query);
    });
    try {
      expect(f.remove()).toBe(1);
      expect(maxParameters).toBeGreaterThan(0);
      expect(maxParameters).toBeLessThan(20);
    } finally {
      spy.mockRestore();
    }
  });

  it("recovers retained metadata after reopening an existing bounded session", async () => {
    const data = { value: "x".repeat(3 * 1024 * 1024) };
    const f = await fixture(data);
    const reopened = SessionManager.openBounded(f.scope, {
      cwd: f.dir,
      maxEvents: 20,
      maxBytes: 8 * 1024 * 1024,
    });
    expect(
      reopened.removeTrailingEntries((entry) => entry.id === f.assistantId, {
        preserveTrailing: (entry) => entry.type === "custom",
      }),
    ).toBe(1);
    const rows = loadTranscriptEventsSync(f.scope) as Array<{ id?: string; data?: unknown }>;
    expect(isDeepStrictEqual(rows.find((row) => row.id === f.metadataId)?.data, data)).toBe(true);
  });

  it("preserves deep custom JSON that SQLite cannot project", async () => {
    let data: unknown = "leaf";
    for (let index = 0; index < 1_100; index += 1) {
      data = { nested: data };
    }
    const f = await fixture(data);
    expect(f.remove()).toBe(1);
    const rows = loadTranscriptEventsSync(f.scope) as Array<{ id?: string; data?: unknown }>;
    expect(JSON.stringify(rows.find((row) => row.id === f.metadataId)?.data)).toBe(
      JSON.stringify(data),
    );
  });
});

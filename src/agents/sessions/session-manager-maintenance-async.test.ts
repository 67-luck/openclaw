import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import * as transcriptHydration from "../../config/sessions/session-transcript-hydration.js";
import { markSessionTranscriptIndexDirtyInTransaction } from "../../config/sessions/session-transcript-index.js";
import {
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-transcript-reconcile.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { rewriteTranscriptEntriesInSessionManager } from "../embedded-agent-runner/transcript-rewrite.js";
import { isRecordedModelFallbackStop } from "../model-fallback-stop.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { sessionManagerPrepareHistoryRead } from "./session-manager-history.js";
import * as metadataRuntime from "./session-manager-metadata-runtime.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
    }
    cleanup();
  }),
);

async function openSession(lifecycleRevision?: string, incognito = false) {
  const root = tempDirs.make("session-maintenance-");
  const scope = {
    agentId: "main",
    sessionId: "maintenance",
    sessionKey: incognito ? "agent:main:dashboard:incognito-maintenance" : "agent:main:maintenance",
    storePath: path.join(root, "sessions.json"),
    env: { OPENCLAW_STATE_DIR: root },
    ...(lifecycleRevision ? { expectedLifecycleRevision: lifecycleRevision } : {}),
  };
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    lifecycleRevision,
    ...(incognito ? { incognito: true } : {}),
  });
  return { scope, manager: await SessionManager.openAsync(scope) };
}

async function appendUser(manager: SessionManager, text: string): Promise<string> {
  return (await manager.appendMessageWithTranscriptAnchorAsync(makeUserMessage(text, 1))).entryId;
}

it("refuses an oversized raw rewrite suffix even when its model context is small", async () => {
  const { scope, manager: source } = await openSession(undefined, true);
  const first = await appendUser(source, "rewrite this request");
  const content = "x".repeat(4 * 1024 * 1024);
  for (let index = 0; index < 17; index++) {
    await source.appendMessageAsync({
      role: "custom",
      customType: "excluded-rewrite-source",
      content,
      display: false,
      timestamp: index + 2,
      excludeFromContext: true,
    });
  }
  const tail = await appendUser(source, "current request");
  const limits = { maxBytes: 4096, maxEvents: 1 };
  const manager = await SessionManager.openBoundedAsync(scope, limits);
  const history = manager[sessionManagerPrepareHistoryRead]();
  expect((await history.readContext()).messages).toEqual([makeUserMessage("current request", 1)]);
  const version = history.version;

  await expect(
    rewriteTranscriptEntriesInSessionManager({
      sessionManager: manager,
      replacements: [{ entryId: first, message: makeUserMessage("repaired request", 1) }],
    }),
  ).rejects.toThrow("Session history exceeds the operation acquisition limit");

  expect(manager.getLeafId()).toBe(tail);
  const reopened = await SessionManager.openBoundedAsync(scope, limits);
  expect(reopened[sessionManagerPrepareHistoryRead]().version).toEqual(version);
  expect(reopened.getLeafId()).toBe(tail);
});

it("rewrites many requested IDs with bounded bindings and preserves canonical source bytes", async () => {
  const { scope, manager: source } = await openSession(undefined, true);
  const originals = Array.from({ length: 40 }, (_, timestamp) => ({
    role: "user" as const,
    content: `original ${timestamp}`,
    timestamp,
  }));
  const replacements = originals.map((message) => ({
    entryId: source.appendMessage(message),
    message: { ...message, content: `repaired ${message.timestamp}` },
  }));
  await waitForSessionTranscriptProjection(scope);
  const manager = await SessionManager.openBoundedAsync(scope, { maxBytes: 4096, maxEvents: 3 });
  const before = await loadTranscriptEvents(scope);
  const database = openOpenClawAgentDatabase(
    toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
  );
  const prepare = database.db.prepare.bind(database.db);
  let maxReplacementParameters = 0;
  const spy = vi.spyOn(database.db, "prepare").mockImplementation((query) => {
    if (query.includes('"event_id" in (')) {
      maxReplacementParameters = Math.max(
        maxReplacementParameters,
        query.match(/\?/g)?.length ?? 0,
      );
    }
    return prepare(query);
  });
  try {
    await expect(
      rewriteTranscriptEntriesInSessionManager({ sessionManager: manager, replacements }),
    ).resolves.toMatchObject({ changed: true, rewrittenEntries: 40 });
    expect(maxReplacementParameters).toBeGreaterThan(0);
    expect(maxReplacementParameters).toBeLessThan(20);
  } finally {
    spy.mockRestore();
  }
  expect((await loadTranscriptEvents(scope)).slice(0, before.length)).toEqual(before);
  const reopened = await SessionManager.openAsync(scope);
  expect((await reopened[sessionManagerPrepareHistoryRead]().readContext()).messages).toEqual(
    replacements.map(({ message }) => message),
  );
  expect((await manager[sessionManagerPrepareHistoryRead]().readContext()).messages).toEqual(
    replacements.slice(-3).map(({ message }) => message),
  );
});

it("publishes retained metadata with bounded payload and parent query bindings", async () => {
  const { scope, manager: source } = await openSession(undefined, true);
  await appendUser(source, "retained user");
  const manager = await SessionManager.openBoundedAsync(scope, { maxBytes: 4096, maxEvents: 2 });
  const retainedIds = Array.from({ length: 40 }, (_, index) =>
    manager.appendCustomEntry("retained", { index }),
  );
  const removed = await appendUser(manager, "temporary tail");
  const database = openOpenClawAgentDatabase(
    toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
  );
  const prepare = database.db.prepare.bind(database.db);
  let maxSequenceParameters = 0;
  const spy = vi.spyOn(database.db, "prepare").mockImplementation((query) => {
    if (/"(?:seq|event_seq)" in \(/.test(query)) {
      maxSequenceParameters = Math.max(maxSequenceParameters, query.match(/\?/g)?.length ?? 0);
    }
    return prepare(query);
  });
  try {
    expect(await manager.removeTrailingEntriesAsync((entry) => entry.id === removed)).toBe(1);
    expect(maxSequenceParameters).toBeGreaterThan(0);
    expect(maxSequenceParameters).toBeLessThan(20);
  } finally {
    spy.mockRestore();
  }
  const metadata = manager.getEntries().filter((entry) => entry.type === "custom");
  expect(metadata.map((entry) => entry.id)).toEqual(retainedIds);
  expect(metadata.map((entry) => entry.data)).toEqual(
    Array.from({ length: 40 }, (_, index) => ({ index })),
  );
  expect(manager.getEntry(removed)).toBeUndefined();
});

it("keeps the omitted source parent for legacy rewrites after append eviction", async () => {
  const { scope } = await openSession();
  const manager = await SessionManager.openBoundedAsync(scope, {
    maxEvents: 2,
    maxBytes: 4096,
  });
  const parent = await appendUser(manager, "omitted parent");
  const first = await appendUser(manager, "first retained");
  const last = await appendUser(manager, "last retained");
  expect(manager.getEntry(parent)).toBeUndefined();
  const rewrite = await manager.prepareTranscriptRewriteAsync();
  await rewrite.sessionManager.resetLeafAsync();
  const nextFirst = await appendUser(rewrite.sessionManager, "rewritten first");
  const nextLast = await appendUser(rewrite.sessionManager, "last retained");
  await rewrite.commit(
    new Map([
      [first, nextFirst],
      [last, nextLast],
    ]),
  );
  expect(await loadTranscriptEvents(scope)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: parent }),
      expect.objectContaining({ id: first, parentId: parent }),
      expect.objectContaining({ id: nextFirst, parentId: parent }),
      expect.objectContaining({ id: nextLast, parentId: nextFirst }),
    ]),
  );
});

it("settles queued suffix removals in order and rebuilds the pending branch projection", async () => {
  const { scope, manager } = await openSession();
  const retained = await appendUser(manager, "keep");
  const removed = await manager.appendCustomEntryAsync("temporary", { bytes: "exact" });
  runOpenClawAgentWriteTransaction(
    (database) => markSessionTranscriptIndexDirtyInTransaction(database.db, scope.sessionId),
    { agentId: scope.agentId, path: resolveSessionTranscriptDatabasePath(scope) },
  );
  vi.spyOn(manager, "removeTrailingEntries").mockImplementation(() => {
    throw new Error("sync compatibility adapter used");
  });
  const first = manager.removeTrailingEntriesAsync((entry) => entry.id === removed);
  const second = manager.removeTrailingEntriesAsync((entry) => entry.id === removed);
  expect(await Promise.all([first, second])).toEqual([1, 0]);
  expect(manager.getLeafId()).toBe(retained);
  await waitForSessionTranscriptProjection(scope);
  expect(
    SessionManager.openBounded(scope, { maxEvents: 10, maxBytes: 64_000 }).buildSessionContext(),
  ).toEqual(manager.buildSessionContext());
  const reopened = await SessionManager.openAsync(scope);
  expect(reopened.getBranch()).toEqual(manager.getBranch());
  expect(reopened.getLeafId()).toBe(retained);
});

it.each(["a bounded reload", "append eviction"] as const)(
  "rejects projected message gaps in synchronous cleanup after %s",
  async (boundary) => {
    const { scope, manager: source } = await openSession();
    const userId = await appendUser(source, "retained user");
    const first = await source.appendMessageWithTranscriptAnchorAsync(
      makeAgentAssistantMessage({ content: [{ type: "text", text: "first reply" }] }),
    );
    const lastReply = makeAgentAssistantMessage({
      content: [{ type: "text", text: "last reply" }],
    });
    if (boundary === "a bounded reload") {
      await source.appendMessageAsync(lastReply);
    }
    const manager = await SessionManager.openBoundedAsync(scope, { maxEvents: 1, maxBytes: 4096 });
    if (boundary === "a bounded reload") {
      await manager.reloadPersistedTranscriptAsync();
      expect(manager.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
      expect(manager.getEntry(userId)).toBeDefined();
    } else {
      expect(manager.getEntry(first.entryId)).toBeDefined();
      const last = await manager.appendMessageWithTranscriptAnchorAsync(lastReply);
      expect(manager.getEntry(first.entryId)).toBeUndefined();
      expect(manager.getEntry(last.entryId)).toBeDefined();
    }
    const predicate = (entry: ReturnType<SessionManager["getBranch"]>[number]) =>
      entry.type === "message" && entry.message.role === "assistant";
    const before = await loadTranscriptEvents(scope);

    expect(manager.removeTrailingEntries((entry) => entry.type === "custom")).toBe(0);
    expect(() => manager.removeTrailingEntries(predicate)).toThrow(
      "Bounded transcript cleanup cannot cross the hydrated removal window",
    );
    expect(await loadTranscriptEvents(scope)).toEqual(before);
    expect(await manager.removeTrailingEntriesAsync(predicate)).toBe(2);
    expect((await SessionManager.openAsync(scope)).getBranch().map((entry) => entry.id)).toEqual([
      userId,
    ]);
  },
);

it.each([false, true])(
  "removes evicted suffix entries once while retaining custom bytes (incognito=%s)",
  async (incognito) => {
    const { scope, manager: source } = await openSession(undefined, incognito);
    const labeled = await appendUser(source, "older retained user");
    await appendUser(source, "retained second user");
    const manager = await SessionManager.openBoundedAsync(scope, {
      maxEvents: 2,
      maxBytes: 4096,
    });
    await manager.appendLabelChangeAsync(labeled, "saved user");
    const retained = await appendUser(manager, "retained boundary");
    const first = await appendUser(manager, "remove first");
    const last = await appendUser(manager, "remove last");
    const customId = await manager.appendCustomEntryAsync("retained-data", {
      bytes: "x".repeat(5 * 1024 * 1024),
    });
    const custom = manager.getEntry(customId);
    if (custom?.type !== "custom") {
      throw new Error("Missing retained custom fixture");
    }
    expect(manager.getEntry(first)).toBeUndefined();
    expect(() =>
      manager.removeTrailingEntries((entry) => entry.id === first || entry.id === last, {
        preserveTrailing: (entry) => entry.type === "custom",
      }),
    ).toThrow("Bounded transcript cleanup cannot cross the hydrated removal window");
    const inspected: string[] = [];
    const removed = await manager.removeTrailingEntriesAsync(
      (entry) => {
        inspected.push(`remove:${entry.id}`);
        if (entry.id === last) {
          expect(entry.parentId).toBe(first);
        }
        return entry.id === first || entry.id === last;
      },
      {
        preserveTrailing: (entry) => {
          inspected.push(`preserve:${entry.id}`);
          return entry.type === "custom";
        },
      },
    );
    expect(removed).toBe(2);
    expect(inspected).toEqual([
      `preserve:${customId}`,
      `preserve:${last}`,
      `remove:${last}`,
      `remove:${first}`,
      `remove:${retained}`,
    ]);
    expect(manager.getLeafId()).toBe(retained);
    expect(manager.buildSessionContext().messages.at(-1)).toMatchObject({
      content: "retained boundary",
    });
    expect(
      (await manager[sessionManagerPrepareHistoryRead]().readContext()).messages,
    ).toMatchObject([
      { content: "older retained user" },
      { content: "retained second user" },
      { content: "retained boundary" },
    ]);
    expect(manager.getLabel(labeled)).toBe("saved user");
    expect(manager.getEntry(labeled)).toMatchObject({
      message: { content: "older retained user" },
    });
    const reloadedCustom = manager.getEntry(customId);
    expect(reloadedCustom?.type === "custom" && reloadedCustom.data).toBe(custom.data);
    const persisted = await loadTranscriptEvents(scope);
    for (const id of [first, last]) {
      expect(persisted).not.toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
    }
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: customId, parentId: retained, data: custom.data }),
      ]),
    );
  },
);

it.each(["removed", "preserved"] as const)(
  "retires a %s context anchor while keeping preserved suffix messages inactive",
  async (anchor) => {
    const { scope, manager: source } = await openSession();
    const predecessor = await appendUser(source, "outside original context");
    const removable = await appendUser(source, "temporary current context");
    const limits = { maxEvents: 1, maxBytes: 4096 };
    const appendManager =
      anchor === "removed" ? await SessionManager.openBoundedAsync(scope, limits) : source;
    const preserved = await appendManager.appendCustomMessageEntryAsync(
      "kept",
      "preserved content",
      true,
    );
    const manager =
      anchor === "removed" ? appendManager : await SessionManager.openBoundedAsync(scope, limits);
    expect(
      (await manager[sessionManagerPrepareHistoryRead]().readContext()).messages,
    ).toMatchObject([
      ...(anchor === "removed" ? [{ content: "temporary current context" }] : []),
      { content: "preserved content" },
    ]);

    expect(
      await manager.removeTrailingEntriesAsync((entry) => entry.id === removable, {
        preserveTrailing: (entry) => entry.type === "custom_message",
      }),
    ).toBe(1);

    const reopened = await SessionManager.openAsync(scope);
    expect(reopened.getEntry(preserved)).toMatchObject({
      parentId: predecessor,
      content: "preserved content",
    });
    expect(reopened.getLeafId()).toBe(predecessor);
    expect(reopened.getBranch().map((entry) => entry.id)).toEqual([predecessor]);
    expect((await manager[sessionManagerPrepareHistoryRead]().readContext()).messages).toEqual([]);
  },
);

it.each([
  { boundary: "read", mutation: "branch" },
  { boundary: "receipt", mutation: "reset" },
  { boundary: "receipt", mutation: "append" },
  { boundary: "publication", mutation: "reset" },
] as const)(
  "rejects stale suffix work after synchronous $mutation during a $boundary wait",
  async ({ boundary, mutation }) => {
    const { scope, manager: source } = await openSession();
    const seed = await appendUser(source, "keep");
    const removed = await appendUser(source, "temporary");
    if (boundary !== "publication") {
      await source.appendLeafControlAsync({
        targetId: removed,
        appendParentId: seed,
        appendMode: "side",
      });
    }
    if (boundary === "publication") {
      await waitForSessionTranscriptIndexReconcile({
        agentId: scope.agentId,
        path: resolveSessionTranscriptDatabasePath(scope),
      });
    }
    const manager =
      boundary === "publication"
        ? await SessionManager.openBoundedAsync(scope, { maxEvents: 4, maxBytes: 4096 })
        : source;
    expect(manager.getBranch().at(-1)?.id).toBe(removed);
    const before = await loadTranscriptEvents(scope);
    const prepareHydration = transcriptHydration.prepareSessionTranscriptHydration;
    const withWorker = metadataRuntime.withSessionMetadataWorker;
    let replacementCommits = 0;
    let newerId: string | null = null;
    const supersede = () => {
      if (mutation === "append") {
        newerId = manager.appendMessage(makeUserMessage("newer", 2));
      } else {
        manager.resetLeaf();
      }
    };
    const delayedReceipt: typeof withWorker = (
      options,
      database,
      assertCurrent,
      operation,
      controls,
    ) =>
      withWorker(
        options,
        database,
        assertCurrent,
        (worker) =>
          operation({
            execute: async (command, commandOptions) => {
              const result = await worker.execute(command, commandOptions);
              if (command.type === "session.transcript.replaceSuffix") {
                expect(result).toMatchObject({ replaced: true });
                replacementCommits++;
                if (boundary === "publication") {
                  // Let the replace wrapper resume before revoking the generator's adoption.
                  queueMicrotask(() => queueMicrotask(supersede));
                } else {
                  supersede();
                }
              }
              return result;
            },
          }),
        controls,
      );
    const interception =
      boundary === "read"
        ? vi
            .spyOn(transcriptHydration, "prepareSessionTranscriptHydration")
            .mockImplementation((...args) => {
              const prepared = prepareHydration(...args);
              return {
                ...prepared,
                readMaintenance: async (request) => {
                  const facts = await prepared.readMaintenance(request);
                  manager.branch(seed);
                  return facts;
                },
              };
            })
        : vi.spyOn(metadataRuntime, "withSessionMetadataWorker").mockImplementation(delayedReceipt);
    let failure: unknown;
    try {
      await manager.removeTrailingEntriesAsync((entry) => entry.id === removed);
    } catch (error) {
      failure = error;
    } finally {
      interception.mockRestore();
    }
    if (boundary === "read") {
      expect(failure).toMatchObject({
        message: "Session transcript navigation changed before publication",
      });
      expect(manager.getLeafId()).toBe(seed);
      expect(manager.getAppendParentId()).toBe(seed);
      expect(manager.getAppendMode()).toBeUndefined();
      expect(await loadTranscriptEvents(scope)).toEqual(before);
      const next = await manager.appendCustomEntryAsync("after-navigation-race");
      expect(manager.getEntry(next)?.parentId).toBe(seed);
    } else {
      expect(replacementCommits).toBe(1);
      expect(failure).toMatchObject({ name: "SessionSuffixCommittedError" });
      expect(isRecordedModelFallbackStop(failure)).toBe(true);
      const reopened = await SessionManager.openAsync(scope);
      expect(reopened.getLeafId()).toBe(newerId ?? seed);
      expect(reopened.getEntry(removed)).toBeUndefined();
      if (newerId) {
        // The side cursor names the retained seed, so this append does not revive the removed row.
        expect(manager.getLeafId()).toBe(newerId);
        expect(manager.getEntry(removed)).toBeUndefined();
        expect(() => manager.branch(removed)).toThrow(`Entry ${removed} not found`);
        expect(manager.buildSessionContext().messages).toEqual([
          makeUserMessage("keep", 1),
          makeUserMessage("newer", 2),
        ]);
        expect(reopened.getEntry(newerId)?.parentId).toBe(seed);
        expect(reopened.getBranch()).toEqual(manager.getBranch());
      } else {
        expect(() => manager.getEntry(removed)).toThrow("suffix committed");
        expect(() => manager.branch(removed)).toThrow("suffix committed");
        expect(() => manager.buildSessionContext()).toThrow("suffix committed");
      }
      const continuation = newerId ? manager : reopened;
      const next = await appendUser(continuation, "after committed removal");
      expect(continuation.getEntry(next)?.parentId).toBe(newerId ?? seed);
      expect(await loadTranscriptEvents(scope)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: removed })]),
      );
    }
  },
);

it("commits an awaited rewrite and refuses a stale prepared rewrite without publishing it", async () => {
  const { scope, manager } = await openSession();
  const sourceId = await appendUser(manager, "original");
  vi.spyOn(manager, "prepareTranscriptRewrite").mockImplementation(() => {
    throw new Error("sync compatibility adapter used");
  });
  const rewrite = await manager.prepareTranscriptRewriteAsync();
  await rewrite.sessionManager.resetLeafAsync();
  const replacementId = await appendUser(rewrite.sessionManager, "replacement");
  await rewrite.commit(new Map([[sourceId, replacementId]]));
  expect(manager.getLeafId()).toBe(replacementId);
  expect((await SessionManager.openAsync(scope)).getBranch()).toEqual(manager.getBranch());

  const stale = await manager.prepareTranscriptRewriteAsync();
  await stale.sessionManager.resetLeafAsync();
  const staleId = await appendUser(stale.sessionManager, "stale");
  const laterId = await manager.appendCustomEntryAsync("later", {});
  await expect(stale.commit(new Map([[replacementId, staleId]]))).rejects.toThrow(
    "changed before rewrite publication",
  );
  expect(manager.getLeafId()).toBe(laterId);
  const reopened = await SessionManager.openAsync(scope);
  expect(reopened.getEntry(staleId)).toBeUndefined();
  expect(reopened.getBranch()).toEqual(manager.getBranch());
});

it.each([
  { owner: "runtime", mutation: "append" },
  { owner: "runtime", mutation: "reset" },
  { owner: "legacy", mutation: "append" },
  { owner: "legacy", mutation: "reset" },
] as const)(
  "preserves a synchronous $mutation after a $owner worker rewrite commits without replaying it",
  async ({ owner, mutation }) => {
    const { scope, manager } = await openSession();
    const sourceId = await appendUser(manager, "original");
    const replacement = makeUserMessage("rewritten", 1);
    const newer = makeUserMessage("newer append", 2);
    const withWorker = metadataRuntime.withSessionMetadataWorker;
    const interception = vi
      .spyOn(metadataRuntime, "withSessionMetadataWorker")
      .mockImplementation(async (...args) => {
        const result = await withWorker(...args);
        if (mutation === "append") {
          manager.appendMessage(newer);
        } else {
          manager.resetLeaf();
        }
        return result;
      });
    let failure: unknown;
    try {
      if (owner === "runtime") {
        await rewriteTranscriptEntriesInSessionManager({
          sessionManager: manager,
          replacements: [{ entryId: sourceId, message: replacement }],
        });
      } else {
        const rewrite = await manager.prepareTranscriptRewriteAsync();
        await rewrite.sessionManager.resetLeafAsync();
        const replacementId = await appendUser(rewrite.sessionManager, "rewritten");
        await rewrite.commit(new Map([[sourceId, replacementId]]));
      }
    } catch (error) {
      failure = error;
    } finally {
      interception.mockRestore();
    }
    expect(failure).toMatchObject({
      message: "Session transcript rewrite committed but view publication failed",
    });
    expect(isRecordedModelFallbackStop(failure)).toBe(true);
    // The concurrent append keeps its original parent; the rewritten row is a sibling branch.
    expect(manager.buildSessionContext().messages).toEqual(
      mutation === "append" ? [makeUserMessage("original", 1), newer] : [],
    );
    const reopened = await SessionManager.openAsync(scope);
    expect(reopened.buildSessionContext().messages).toEqual(
      mutation === "append" ? [makeUserMessage("original", 1), newer] : [replacement],
    );
    const nextId = await appendUser(manager, "after refusal");
    expect(manager.getLeafId()).toBe(nextId);
    expect(manager.buildSessionContext().messages.at(-1)).toEqual(
      makeUserMessage("after refusal", 1),
    );
    const events = await loadTranscriptEvents(scope);
    expect(
      events.filter(
        (entry) =>
          isIndexedSessionEntry(entry) &&
          entry.type === "message" &&
          entry.message.role === "user" &&
          entry.message.content === "rewritten",
      ),
    ).toHaveLength(1);
  },
);

it("adopts only the submitted rewrite snapshot when the prepared manager changes during its receipt", async () => {
  const { scope, manager } = await openSession();
  const sourceId = await appendUser(manager, "original");
  await manager.appendLabelChangeAsync(sourceId, "retained label");
  const rewrite = await manager.prepareTranscriptRewriteAsync();
  await rewrite.sessionManager.resetLeafAsync();
  const replacementId = await appendUser(rewrite.sessionManager, "replacement");
  const withWorker = metadataRuntime.withSessionMetadataWorker;
  let laterPreparedId: string | undefined;
  const mutateAfterCommit: typeof withWorker = (
    options,
    database,
    assertCurrent,
    operation,
    controls,
  ) =>
    withWorker(
      options,
      database,
      assertCurrent,
      (worker) =>
        operation({
          execute: async (command, commandOptions) => {
            const result = await worker.execute(command, commandOptions);
            if (command.type === "session.transcript.rewrite") {
              laterPreparedId = await appendUser(rewrite.sessionManager, "uncommitted later edit");
            }
            return result;
          },
        }),
      controls,
    );
  const observer = vi
    .spyOn(metadataRuntime, "withSessionMetadataWorker")
    .mockImplementation(mutateAfterCommit);
  try {
    await rewrite.commit(new Map([[sourceId, replacementId]]));
  } finally {
    observer.mockRestore();
  }
  expect(laterPreparedId).toEqual(expect.any(String));
  expect(rewrite.sessionManager.getLeafId()).toBe(laterPreparedId);
  expect(manager.getLeafId()).toBe(replacementId);
  expect(manager.getEntries().map((entry) => entry.id)).not.toContain(laterPreparedId);
  expect(manager.getLabel(sourceId)).toBe("retained label");
  const reopened = await SessionManager.openAsync(scope);
  expect(reopened.getPersistedEntries()).toEqual(manager.getPersistedEntries());
  expect(reopened.getLeafId()).toBe(replacementId);
});

it.each(["append", "identity", "label", "leaf"] as const)(
  "preserves an intervening detached %s mutation when rewrite commit is stale",
  async (mutation) => {
    const manager = SessionManager.inMemory();
    const sourceId = await appendUser(manager, "original");
    const rewrite = await manager.prepareTranscriptRewriteAsync();
    const rewrittenIds = new Map<string, string>();
    if (mutation !== "identity") {
      await rewrite.sessionManager.resetLeafAsync();
      rewrittenIds.set(sourceId, await appendUser(rewrite.sessionManager, "replacement"));
    }
    if (mutation === "append") {
      await appendUser(manager, "intervening message");
    } else if (mutation === "identity") {
      manager.newSession({ id: "replacement-session" });
    } else if (mutation === "label") {
      await manager.appendLabelChangeAsync(sourceId, "new label");
    } else {
      await manager.appendLeafControlAsync({ targetId: sourceId, appendParentId: sourceId });
    }
    const expectedEntries = structuredClone(manager.getPersistedEntries());
    const expectedSessionId = manager.getSessionId();
    await expect(rewrite.commit(rewrittenIds)).rejects.toThrow(
      "Session transcript changed before rewrite publication",
    );
    expect(manager.getSessionId()).toBe(expectedSessionId);
    expect(manager.getPersistedEntries()).toEqual(expectedEntries);
  },
);

it("branches a large selected path and rebuilds its new session projection", async () => {
  const { manager } = await openSession("branch-source-v1");
  await appendUser(manager, "selected");
  // Exceed inline projection rebuilding without thousands of fixture writes.
  const selected = await manager.appendCustomEntryAsync("retained", {
    bytes: "x".repeat(4 * 1024 * 1024),
  });
  const omitted = await manager.appendCustomEntryAsync("omit", {});
  const previousSessionId = manager.getSessionId();
  const sessionId = await manager.createBranchedSession(selected);
  expect(sessionId).toBe(manager.getSessionId());
  expect(sessionId).not.toBe(previousSessionId);
  expect(manager.getEntry(omitted)).toBeUndefined();
  const target = manager.getSessionTarget();
  expect(target).toBeDefined();
  await waitForSessionTranscriptProjection(target!);
  expect(
    SessionManager.openBounded(target!, {
      maxEvents: 10,
      maxBytes: 8 * 1024 * 1024,
    }).buildSessionContext(),
  ).toEqual(manager.buildSessionContext());
  const reopened = await SessionManager.openAsync(target!);
  expect(reopened.getHeader()?.parentSession).toBe(previousSessionId);
  expect(reopened.getBranch()).toEqual(manager.getBranch());
  expect(reopened.getLeafId()).toBe(selected);
});

it("retains a committed branch identity and invalidates the view after target rebinding", async () => {
  const { scope, manager } = await openSession();
  const selected = await appendUser(manager, "selected");
  const replacementScope = {
    ...scope,
    sessionId: "replacement",
    sessionKey: "agent:main:replacement",
  };
  await upsertSessionEntryCore(replacementScope, {
    sessionId: replacementScope.sessionId,
    updatedAt: 1,
  });
  const original = metadataRuntime.withSessionMetadataWorker;
  const rebindAfterCommit: typeof original = async (
    options,
    database,
    assertCurrent,
    operation,
    controls,
  ) => {
    const result = await original(options, database, assertCurrent, operation, controls);
    await manager.setSessionTargetAsync(replacementScope);
    return result;
  };
  const observer = vi
    .spyOn(metadataRuntime, "withSessionMetadataWorker")
    .mockImplementation(rebindAfterCommit);
  const publishedSessionIds: Array<string | undefined> = [];
  const unsubscribe = onSessionIdentityMutation((mutation) => {
    if (mutation.kind !== "delete" && mutation.current.sessionKeys.includes(scope.sessionKey)) {
      publishedSessionIds.push(mutation.current.sessionId);
    }
  });
  let failure: unknown;
  try {
    await manager.createBranchedSession(selected);
  } catch (error) {
    failure = error;
  } finally {
    observer.mockRestore();
    unsubscribe();
  }
  const committed = loadSessionEntry(scope);
  expect(committed?.sessionId).not.toBe(scope.sessionId);
  expect(failure).toMatchObject({
    name: "SessionBranchCommittedError",
    committedSessionId: committed?.sessionId,
    cause: { message: "Session transcript changed during branch preparation" },
  });
  expect(isRecordedModelFallbackStop(failure)).toBe(true);
  expect(() => manager.getBranch()).toThrow("Session branch committed");
  expect(committed).toBeDefined();
  expect(publishedSessionIds).toContain(committed?.sessionId);
  const reopened = await SessionManager.openAsync({ ...scope, sessionId: committed!.sessionId });
  expect(reopened.getLeafId()).toBe(selected);
});

it("preserves the host's once-redacted rewrite bytes through the worker commit", async () => {
  const { scope, manager } = await openSession();
  const sourceId = await appendUser(manager, "original");
  const rewrite = await manager.prepareTranscriptRewriteAsync();
  await rewrite.sessionManager.resetLeafAsync();
  const replacementId = await appendUser(
    rewrite.sessionManager,
    "pass: opaque-pass-secret-1234567890",
  );
  await rewrite.commit(new Map([[sourceId, replacementId]]));
  expect(manager.getEntry(replacementId)).toMatchObject({
    message: { content: "pass: opaque…7890" },
  });
  const reopened = await SessionManager.openAsync(scope);
  expect(reopened.getEntry(replacementId)).toEqual(manager.getEntry(replacementId));
});

// Branch replacement keeps the live manager and durable identity on the same commit edge.
import path from "node:path";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  onSessionIdentityMutation,
  replaceTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as transcriptHydration from "../../config/sessions/session-transcript-hydration.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawAgentDatabaseByPath,
  listOpenIncognitoAgentDatabases,
} from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { textAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import { sessionManagerPrepareHistoryRead } from "./session-manager-history.js";
import * as sessionMaintenance from "./session-manager-maintenance.worker.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    cleanup();
  }),
);
afterEach(() => vi.restoreAllMocks());

describe("SessionManager branch replacement", () => {
  it.each(["sqlite", "detached"] as const)(
    "pages the navigation target and abandoned history within one byte budget (%s)",
    async (storage) => {
      const dir = tempDirs.make("openclaw-navigation-page-budget-");
      const target = {
        agentId: "main",
        sessionId: "navigation-page-budget",
        sessionKey: "agent:main:navigation-page-budget",
        storePath: path.join(dir, "sessions.json"),
      };
      if (storage === "sqlite") {
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      }
      const source =
        storage === "sqlite" ? SessionManager.open(target, dir) : SessionManager.inMemory(dir);
      const selectedId = source.appendMessage({
        role: "user",
        content: "t".repeat(3 * 1024 * 1024),
        timestamp: 1,
      });
      const abandonedId = source.appendMessage({
        role: "user",
        content: "a".repeat(3 * 1024 * 1024),
        timestamp: 2,
      });
      if (storage === "sqlite") {
        await waitForSessionTranscriptProjection(target);
      }
      const maxBytes = 4 * 1024 * 1024;
      const manager =
        storage === "sqlite"
          ? await SessionManager.openBoundedAsync(target, { maxBytes, maxEvents: 1 })
          : source;
      const residentIds = manager.getEntries().map((entry) => entry.id);
      const prepare = transcriptHydration.prepareSessionTranscriptHydration;
      const pagePayloadBytes: number[] = [];
      let targetTransfers = 0;
      if (storage === "sqlite") {
        vi.spyOn(transcriptHydration, "prepareSessionTranscriptHydration").mockImplementation(
          (...args) => {
            const reader = prepare(...args);
            return {
              ...reader,
              readMaintenance: async (request) => {
                const result = await reader.readMaintenance(request);
                if (request.operation === "history-page" && request.selection === "abandoned") {
                  const transferred = [...(result.events ?? [])];
                  if (result.targetEntry !== undefined) {
                    targetTransfers++;
                    transferred.push(result.targetEntry);
                  }
                  pagePayloadBytes.push(
                    transferred.reduce<number>(
                      (bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry)),
                      0,
                    ),
                  );
                }
                return result;
              },
            };
          },
        );
      } else {
        const targetBytes = Buffer.byteLength(JSON.stringify(source.getEntry(selectedId)));
        let pageCount = 0;
        for await (const { entries } of manager[sessionManagerPrepareHistoryRead]().pages({
          selection: "abandoned",
          targetLeafId: selectedId,
          maxBytes,
        })) {
          const bytes = entries.reduce(
            (total, entry) => total + Buffer.byteLength(JSON.stringify(entry)),
            0,
          );
          expect(bytes + (pageCount === 0 ? targetBytes : 0)).toBeLessThanOrEqual(maxBytes);
          expect(entries.map((entry) => entry.id)).toEqual(pageCount === 0 ? [] : [abandonedId]);
          pageCount++;
        }
        expect(pageCount).toBe(2);
      }

      const navigation =
        await manager[sessionManagerPrepareHistoryRead]().readNavigation(selectedId);

      if (storage === "sqlite") {
        for (const bytes of pagePayloadBytes) {
          expect(bytes).toBeLessThanOrEqual(maxBytes);
        }
        expect(pagePayloadBytes).toHaveLength(2);
        expect(targetTransfers).toBe(1);
      }
      expect(navigation.commonAncestorId).toBe(selectedId);
      expect(navigation.entriesToSummarize.map((entry) => entry.id)).toEqual([abandonedId]);
      expect(
        JSON.stringify(navigation.targetEntry) === JSON.stringify(source.getEntry(selectedId)),
      ).toBe(true);
      expect(
        JSON.stringify(navigation.entriesToSummarize[0]) ===
          JSON.stringify(source.getEntry(abandonedId)),
      ).toBe(true);
      expect(manager.getEntries().map((entry) => entry.id)).toEqual(residentIds);
    },
  );

  it("rejects a detached non-tool navigation target above the page byte limit", async () => {
    const manager = SessionManager.inMemory();
    const selectedId = manager.appendMessage({
      role: "user",
      content: "t".repeat(5 * 1024 * 1024),
      timestamp: 1,
    });
    manager.appendMessage({ role: "user", content: "abandoned", timestamp: 2 });

    const outcome = await manager[sessionManagerPrepareHistoryRead]()
      .readNavigation(selectedId)
      .then(
        () => "accepted",
        (error: unknown) => error,
      );

    expect(outcome).toBeInstanceOf(RangeError);
    expect(outcome).toMatchObject({
      message: "Session navigation target exceeds the acquisition byte limit",
    });
  });

  it.each(
    [1, 2].flatMap((maxEvents) =>
      (["persistent", "detached current", "detached earlier"] as const).map((mode) => ({
        maxEvents,
        mode,
      })),
    ),
  )(
    "retains a labeled target through a $mode fork with a $maxEvents-message window",
    async ({ maxEvents, mode }) => {
      const dir = tempDirs.make("openclaw-bounded-fork-label-context-");
      const scope = {
        agentId: "main",
        sessionId: "labeled-fork-source",
        sessionKey: "agent:main:labeled-fork-source",
        storePath: path.join(dir, "sessions.json"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = await SessionManager.openAsync(scope, dir, { maxBytes: 4096, maxEvents });
      const older = { role: "user" as const, content: "older labeled question", timestamp: 1 };
      const latest = { role: "user" as const, content: "latest question", timestamp: 2 };
      const { entryId: olderId } = await source.appendMessageWithTranscriptAnchorAsync(older);
      const { entryId: latestId } = await source.appendMessageWithTranscriptAnchorAsync(latest);
      await source.appendLabelChangeAsync(olderId, "bookmark");
      const originalMessages = maxEvents === 1 ? [latest] : [older, latest];
      expect(source.buildSessionContext().messages).toEqual(originalMessages);
      const originalRows = await loadTranscriptEvents(scope);
      const manager =
        mode === "persistent"
          ? source
          : (await source.prepareTranscriptRewriteAsync()).sessionManager;
      const selected =
        mode === "detached current"
          ? manager.getLeafId()
          : mode === "detached earlier"
            ? olderId
            : latestId;
      if (!selected) throw new Error("Missing labeled fork selection");
      const forkId = await manager.createBranchedSession(selected);
      const messages = mode === "detached earlier" ? [older] : originalMessages;
      expect(manager.getSessionId()).not.toBe(scope.sessionId);
      expect(manager.getEntry(olderId)).toMatchObject({ type: "message", message: older });
      expect(manager.getLabel(olderId)).toBe("bookmark");
      expect(manager.buildSessionContext().messages).toEqual(messages);
      expect((await manager[sessionManagerPrepareHistoryRead]().readContext()).messages).toEqual(
        messages,
      );
      if (mode === "persistent") {
        expect(forkId).toBe(manager.getSessionId());
        expect(manager.getEntry(latestId)).toMatchObject({ type: "message", message: latest });
        const reopened = await SessionManager.openAsync(
          { ...scope, sessionId: manager.getSessionId() },
          dir,
        );
        expect(reopened.buildSessionContext().messages).toEqual([older, latest]);
      } else {
        expect(forkId).toBeUndefined();
        expect(manager.getSessionTarget()).toBeUndefined();
        if (mode === "detached earlier") expect(manager.getEntry(latestId)).toBeUndefined();
        expect(source.buildSessionContext().messages).toEqual(originalMessages);
        expect(await loadTranscriptEvents(scope)).toEqual(originalRows);
      }
    },
  );

  it("retains a newly selected label target outside the one-entry model window", async () => {
    const dir = tempDirs.make("openclaw-selected-label-target-");
    const scope = {
      agentId: "main",
      sessionId: "selected-label-target",
      sessionKey: "agent:main:selected-label-target",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const older = {
      type: "message",
      id: "older",
      parentId: null,
      message: textAssistant("older answer"),
    };
    const newer = {
      type: "message",
      id: "newer",
      parentId: older.id,
      message: { role: "user", content: "newer question", timestamp: 2 },
    };
    const label = {
      type: "label",
      id: "bookmark",
      parentId: newer.id,
      targetId: older.id,
      label: "older answer",
    };
    const tail = { ...newer, id: "tail", parentId: label.id };
    expect(
      replaceTranscriptEventsSync(scope, [
        { type: "session", version: 3, id: scope.sessionId, cwd: dir },
        older,
        newer,
        label,
        tail,
      ]),
    ).toBe(true);
    await waitForSessionTranscriptProjection(scope);
    const manager = await SessionManager.openBoundedAsync(scope, {
      cwd: dir,
      maxBytes: 4096,
      maxEvents: 1,
    });
    expect(manager.getEntry(label.id)).toBeUndefined();
    expect(manager.getEntry(older.id)).toBeUndefined();

    await manager.branchAsync(label.id);

    expect(manager.getEntry(older.id)).toMatchObject(older);
    expect(manager.getEntry(label.id)).toMatchObject(label);
    expect(manager.getLabel(older.id)).toBe(label.label);
    expect(manager.getLeafId()).toBe(label.id);
    expect(manager.buildSessionContext().messages).toEqual([]);
    expect((await manager[sessionManagerPrepareHistoryRead]().readContext()).messages).toEqual([]);
  });

  it.each(["custom-only", "oversized-user", "compaction", "reset"] as const)(
    "publishes the selected model context in a bounded %s fork",
    async (kind) => {
      const dir = tempDirs.make("openclaw-bounded-fork-context-");
      const scope = {
        agentId: "main",
        sessionId: "bounded-fork-source",
        sessionKey: "agent:main:bounded-fork-source",
        storePath: path.join(dir, "sessions.json"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const manager = await SessionManager.openAsync(scope, dir, { maxBytes: 4096, maxEvents: 4 });
      const content = "x".repeat(8192);
      let selectedId: string;
      let retainedId: string | undefined;
      let expectedMessages: unknown[];
      let expectedFullMessages: unknown[] | undefined;
      if (kind === "custom-only") {
        const customId = await manager.appendCustomMessageEntryAsync(
          "notice",
          "custom context",
          true,
        );
        selectedId = await manager.branchWithSummaryAsync(customId, "selected branch summary");
        expectedMessages = [
          { role: "custom", customType: "notice", content: "custom context" },
          { role: "branchSummary", summary: "selected branch summary", fromId: customId },
        ];
      } else {
        selectedId = (
          await manager.appendMessageWithTranscriptAnchorAsync({
            role: "user",
            content,
            timestamp: 1,
          })
        ).entryId;
        expectedMessages = [{ role: "user", content, timestamp: 1 }];
        if (kind === "compaction" || kind === "reset") {
          retainedId = selectedId;
          expectedFullMessages = expectedMessages;
          selectedId =
            kind === "compaction"
              ? await manager.appendCompactionAsync("selected summary", retainedId, 2048)
              : await manager.appendResetBoundaryAsync("reset", retainedId);
          expectedMessages =
            kind === "compaction"
              ? [{ role: "compactionSummary", summary: "selected summary" }]
              : [];
          expectedFullMessages = [...expectedMessages, ...expectedFullMessages];
        }
      }
      const abandonedId = (
        await manager.appendMessageWithTranscriptAnchorAsync({
          role: "user",
          content: "abandoned",
          timestamp: 2,
        })
      ).entryId;
      const original = await loadTranscriptEvents(scope);

      const forkId = await manager.createBranchedSession(selectedId);

      expect(forkId).toBe(manager.getSessionId());
      expect(forkId).not.toBe(scope.sessionId);
      expect(manager.getLeafId()).toBe(selectedId);
      expect(manager.getEntry(selectedId)).toMatchObject({ id: selectedId });
      expect(manager.getEntry(abandonedId)).toBeUndefined();
      const context = await manager[sessionManagerPrepareHistoryRead]().readContext();
      expect(context.messages).toHaveLength(expectedMessages.length);
      expect(context.messages).toMatchObject(expectedMessages);
      const forkTarget = { ...scope, sessionId: forkId! };
      const reopened = await SessionManager.openAsync(forkTarget, dir);
      expect(reopened.buildSessionContext().messages).toMatchObject(
        expectedFullMessages ?? expectedMessages,
      );
      if (retainedId) {
        expect(reopened.getEntry(retainedId)).toMatchObject({
          message: { role: "user", content, timestamp: 1 },
        });
        expect(reopened.getEntry(selectedId)?.type).toBe(kind);
        const bounded = await SessionManager.openBoundedAsync(forkTarget, {
          cwd: dir,
          maxBytes: 4096,
          maxEvents: 4,
        });
        expect((await bounded[sessionManagerPrepareHistoryRead]().readContext()).messages).toEqual(
          context.messages,
        );
      }
      expect(await loadTranscriptEvents(scope)).toEqual(original);
    },
  );

  it.each(["before commit", "after commit"] as const)(
    "does not reopen or publish a discarded incognito fork %s",
    async (stage) => {
      const dir = tempDirs.make("openclaw-incognito-fork-owner-");
      const scope = {
        agentId: "main",
        sessionId: "private-fork-source",
        sessionKey: "agent:main:dashboard:incognito-fork-owner",
        storePath: path.join(dir, "sessions.json"),
      };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        incognito: true,
      });
      const manager = SessionManager.open(scope, dir);
      const leafId = manager.appendMessage({
        role: "user",
        content: "private source",
        timestamp: 1,
      });
      const before = manager.getEntries();
      const databasePath = resolveSessionTranscriptDatabasePath(scope);
      expect(listOpenIncognitoAgentDatabases()).toContainEqual({
        agentId: scope.agentId,
        storePath: databasePath,
      });
      let committedId: string | undefined;
      if (stage === "before commit") {
        const prepare = transcriptHydration.prepareSessionTranscriptHydration;
        vi.spyOn(transcriptHydration, "prepareSessionTranscriptHydration").mockImplementation(
          (...args) => {
            const reader = prepare(...args);
            let queued = false;
            return {
              ...reader,
              assertCurrent: () => {
                reader.assertCurrent();
                if (!queued) {
                  queued = true;
                  queueMicrotask(() => closeOpenClawAgentDatabaseByPath(databasePath));
                }
              },
            };
          },
        );
      } else {
        const execute = sessionMaintenance.executeSessionMaintenance;
        vi.spyOn(sessionMaintenance, "executeSessionMaintenance").mockImplementation((...args) => {
          const result = execute(...args);
          committedId = loadSessionEntry(scope)?.sessionId;
          closeOpenClawAgentDatabaseByPath(databasePath);
          return result;
        });
      }
      const replacements: unknown[] = [];
      const stop = onSessionIdentityMutation((mutation) => {
        if (
          mutation.kind === "replace" &&
          mutation.previous.sessionKeys.includes(scope.sessionKey)
        ) {
          replacements.push(mutation);
        }
      });
      try {
        const pending = manager.createBranchedSession(leafId);
        if (stage === "before commit") {
          await expect(pending).rejects.toThrow("incognito database owner is no longer current");
          expect(manager.getEntries()).toEqual(before);
        } else {
          await expect(pending).rejects.toMatchObject({
            name: "SessionBranchCommittedError",
            committedSessionId: expect.any(String),
          });
          expect(committedId).toBeDefined();
          expect(committedId).not.toBe(scope.sessionId);
          expect(() => manager.getEntries()).toThrow("Session branch committed");
        }
      } finally {
        stop();
      }
      expect(manager.getSessionId()).toBe(scope.sessionId);
      expect(replacements).toEqual([]);
      expect(listOpenIncognitoAgentDatabases()).not.toContainEqual({
        agentId: scope.agentId,
        storePath: databasePath,
      });
    },
  );

  it.each(["memory", "sqlite"].flatMap((mode) => [3, 4].map((version) => ({ mode, version }))))(
    "preserves projection version $version, opaque parents, and labels in a $mode branch",
    async ({ mode, version }) => {
      const dir = tempDirs.make("openclaw-session-manager-branch-");
      const scope = {
        agentId: "main",
        sessionId: "source-session",
        sessionKey: "agent:main:branch-labels",
        storePath: path.join(dir, "sessions.json"),
      };
      const entries = [
        { type: "session", version, id: scope.sessionId, cwd: dir },
        {
          type: "message",
          id: "user",
          parentId: null,
          message: { role: "user", content: "question" },
        },
        { type: "future-metadata", id: "opaque", parentId: "user", details: { value: "retained" } },
        {
          type: "message",
          id: "reply",
          parentId: "opaque",
          message: { role: "user", content: "reply" },
        },
        {
          type: "label",
          id: "label",
          parentId: "reply",
          targetId: "user",
          label: "named",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          type: "message",
          id: "abandoned",
          parentId: "label",
          message: { role: "user", content: "excluded" },
        },
      ];
      if (mode === "sqlite") {
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        replaceTranscriptEventsSync(scope, entries);
      }
      const manager =
        mode === "sqlite" ? SessionManager.open(scope, dir) : SessionManager.fromEntries(entries);

      const branchId = await manager.createBranchedSession("reply");
      const expected = [
        expect.objectContaining({ id: manager.getSessionId(), type: "session", version }),
        entries[1],
        entries[2],
        entries[3],
        expect.objectContaining({ ...entries[4], id: expect.any(String) }),
      ];
      expect(manager.getSessionId()).not.toBe(scope.sessionId);
      expect(manager.getPersistedEntries()).toEqual(expected);
      expect(manager.getLabel("user")).toBe("named");
      expect(manager.getEntry("abandoned")).toBeUndefined();
      if (mode === "sqlite") {
        expect(branchId).toBe(manager.getSessionId());
        expect(await loadTranscriptEvents(scope)).toEqual(entries);
        expect(
          SessionManager.open({ ...scope, sessionId: branchId! }).getPersistedEntries(),
        ).toEqual(expected);
      } else {
        expect(branchId).toBeUndefined();
        expect(manager.getSessionTarget()).toBeUndefined();
      }
      manager.appendCompaction("summary", "user", 1);
      manager.appendResetBoundary("reset", "reply");
      const reopened =
        mode === "sqlite"
          ? SessionManager.openBounded(
              { ...scope, sessionId: manager.getSessionId() },
              { maxBytes: 4096, maxEvents: 2 },
            )
          : SessionManager.fromEntries(manager.getPersistedEntries());
      expect(reopened.getHeader()?.version).toBe(version);
    },
  );

  it("creates SQLite-backed branch sessions without rewriting the source transcript", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-branch-source";
    const sessionKey = "agent:main:dashboard:sqlite-branch-source";
    const marker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      {
        delivery: { kind: "internal" },
        sessionFile: marker,
        sessionId,
        updatedAt: 10,
      },
    );
    const user = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "user-message",
      message: { role: "user", content: "question before branch" },
    });
    const assistant = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "assistant-message",
      message: { role: "assistant", content: [{ type: "text", text: "answer before branch" }] },
      parentId: user.messageId,
    });

    const sessionManager = SessionManager.open(scope, dir);
    const sourceTarget = sessionManager.getSessionTarget();
    expect(sourceTarget).toMatchObject(scope);
    const observedBranches: unknown[] = [];
    const stop = onSessionIdentityMutation((mutation) => {
      if (mutation.kind !== "replace" || !mutation.current.sessionKeys.includes(sessionKey)) {
        return;
      }
      observedBranches.push({
        sessionId: sessionManager.getSessionId(),
        target: sessionManager.getSessionTarget(),
        durableEntries: SessionManager.open({
          ...scope,
          sessionId: mutation.current.sessionId!,
        }).getEntries(),
      });
    });
    let branchedMarker: string | undefined;
    try {
      branchedMarker = await sessionManager.createBranchedSession(assistant.messageId);
    } finally {
      stop();
    }
    const branchedSessionId = sessionManager.getSessionId();

    expect(branchedMarker).toBe(branchedSessionId);
    expect(branchedSessionId).not.toBe(sessionId);
    expect(observedBranches).toEqual([
      {
        sessionId: branchedSessionId,
        target: { ...sourceTarget, sessionId: branchedSessionId },
        durableEntries: sessionManager.getEntries(),
      },
    ]);
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
      delivery: { kind: "internal" },
      sessionId: branchedSessionId,
    });
    await expect(loadTranscriptEvents({ agentId: "main", sessionId, storePath })).resolves.toEqual([
      expect.objectContaining({ id: sessionId, type: "session" }),
      expect.objectContaining({ id: user.messageId, type: "message" }),
      expect.objectContaining({ id: assistant.messageId, type: "message" }),
    ]);
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        sessionId: branchedSessionId,
        sessionKey,
        storePath,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: branchedSessionId,
        parentSession: sessionId,
        type: "session",
      }),
      expect.objectContaining({ id: user.messageId, type: "message" }),
      expect.objectContaining({ id: assistant.messageId, type: "message" }),
    ]);
    expect(() => sessionManager.prepareTranscriptRewrite()).not.toThrow();
    expect(sessionManager.removeTrailingEntries((entry) => entry.id === assistant.messageId)).toBe(
      1,
    );
    expect(() => sessionManager.prepareTranscriptRewrite()).not.toThrow();
    await expect(loadTranscriptEvents({ ...scope, sessionId: branchedSessionId })).resolves.toEqual(
      [
        expect.objectContaining({ id: branchedSessionId, type: "session" }),
        expect.objectContaining({ id: user.messageId, type: "message" }),
      ],
    );
  });

  it("does not publish a branch identity when transcript persistence fails", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const scope = {
      agentId: "main",
      sessionId: "branch-write-failure",
      sessionKey: "agent:main:branch-write-failure",
      storePath: path.join(dir, "sessions.json"),
    };
    const manager = SessionManager.open(scope, dir);
    const leafId = manager.appendMessage({ role: "user", content: "source", timestamp: 1 });
    const beforeEntry = loadSessionEntry(scope);
    const beforeEvents = await loadTranscriptEvents(scope);
    const beforeEntries = manager.getEntries();
    const beforeTarget = manager.getSessionTarget();
    expect(beforeTarget).toMatchObject(scope);
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    const admission = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit") {
            throw new Error("branch transcript write failed");
          }
          admit(request, grant);
        }, attachment),
      );
    const replacements: unknown[] = [];
    const stop = onSessionIdentityMutation((mutation) => {
      if (mutation.previous.sessionKeys.includes(scope.sessionKey)) {
        replacements.push(mutation);
      }
    });
    try {
      await expect(manager.createBranchedSession(leafId)).rejects.toThrow(
        "branch transcript write failed",
      );
    } finally {
      stop();
      admission.mockRestore();
    }

    expect(loadSessionEntry(scope)).toEqual(beforeEntry);
    expect(await loadTranscriptEvents(scope)).toEqual(beforeEvents);
    expect(manager.getSessionId()).toBe(scope.sessionId);
    expect(manager.getSessionTarget()).toEqual(beforeTarget);
    expect(manager.getEntries()).toEqual(beforeEntries);
    expect(manager.getLeafId()).toBe(leafId);
    expect(replacements).toEqual([]);
  });

  it.each(["lifecycle", "writer", "metadata", "guarded-target", "successor-writer"])(
    "revalidates queued %s changes before branching",
    async (change) => {
      const dir = tempDirs.make("openclaw-session-manager-");
      const storePath = path.join(dir, "sessions.json");
      const sessionId = "sqlite-branch-race-source";
      const sessionKey = "agent:main:dashboard:sqlite-branch-race-source";
      const marker = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
      const scope = { agentId: "main", sessionId, sessionKey, storePath };
      await upsertSessionEntryCore(scope, {
        activeWriterRunId: "branch-original-writer",
        lifecycleRevision: "branch-original-revision",
        sessionFile: marker,
        sessionId,
        updatedAt: 10,
      });
      const user = await appendTranscriptMessage(scope, {
        cwd: dir,
        eventId: "branch-race-user",
        message: { role: "user", content: "question before raced branch" },
      });
      const assistant = await appendTranscriptMessage(scope, {
        cwd: dir,
        eventId: "branch-race-assistant",
        message: textAssistant("answer before raced branch"),
        parentId: user.messageId,
      });
      const sessionManager = SessionManager.open(scope, dir);
      const runAsWriter = <T>(run: () => Promise<T>) =>
        withOwnedSessionTranscriptWrites(
          {
            sessionTarget: {
              ...scope,
              expectedLifecycleRevision: "branch-original-revision",
              expectedWriterRunId: "branch-original-writer",
            },
            ...(change === "guarded-target" ? { assertCommitAllowed: () => {} } : {}),
            withTranscriptWrite: async (operation) => await operation(),
          },
          run,
        );
      if (change === "successor-writer") {
        await runAsWriter(() => sessionManager.createBranchedSession(assistant.messageId));
      }
      const branchSourceId = sessionManager.getSessionId();
      const readManagerState = () => ({
        entries: sessionManager.getEntries(),
        sessionId: sessionManager.getSessionId(),
        target: sessionManager.getSessionTarget(),
        leafId: sessionManager.getLeafId(),
        appendParentId: sessionManager.getAppendParentId(),
      });
      const beforeBranch = readManagerState();
      const writerChanged = change === "writer" || change === "successor-writer";
      let releaseOwnerChange = () => {};
      const ownerChangeGate = new Promise<void>((resolve) => {
        releaseOwnerChange = resolve;
      });
      let markOwnerChangeStarted = () => {};
      const ownerChangeStarted = new Promise<void>((resolve) => {
        markOwnerChangeStarted = resolve;
      });
      const ownerChange = updateSessionEntry(scope, async () => {
        markOwnerChangeStarted();
        await ownerChangeGate;
        return change === "lifecycle"
          ? { lifecycleRevision: "branch-replacement-revision" }
          : writerChanged
            ? { activeWriterRunId: "branch-replacement-writer" }
            : { label: "updated while branch queued" };
      });
      await ownerChangeStarted;

      const queuedAt = Date.now() - 1_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(queuedAt);
      const branch = runAsWriter(() => sessionManager.createBranchedSession(assistant.messageId));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const whileQueued = readManagerState();
      clock.mockRestore();
      const commitStartedAt = Date.now();
      releaseOwnerChange();

      await ownerChange;
      if (change === "lifecycle") {
        await expect(branch).rejects.toMatchObject({
          cause: {
            code: "session-rebound",
            expectedSessionIdHash: redactIdentifier(sessionId),
            sessionKeyHash: redactIdentifier(sessionKey),
          },
        });
        expect(loadSessionEntry(scope)).toMatchObject({
          lifecycleRevision: "branch-replacement-revision",
          sessionId,
        });
        expect(sessionManager.getSessionId()).toBe(sessionId);
      } else if (writerChanged || change === "guarded-target") {
        await expect(branch).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
        expect(loadSessionEntry(scope)).toMatchObject({
          sessionId: branchSourceId,
          lifecycleRevision: "branch-original-revision",
          activeWriterRunId: writerChanged ? "branch-replacement-writer" : "branch-original-writer",
        });
        if (change === "successor-writer") {
          expect(() =>
            sessionManager.appendMessage({
              role: "user",
              content: "stale successor append",
              timestamp: commitStartedAt,
            }),
          ).toThrow(SessionTranscriptWriterClaimReboundError);
        }
        expect(readManagerState()).toEqual(beforeBranch);
      } else {
        const branchId = await branch;
        expect(loadSessionEntry(scope)).toMatchObject({
          label: "updated while branch queued",
          sessionId: branchId,
          activeWriterRunId: "branch-original-writer",
        });
        const updatedAt = loadSessionEntry(scope)?.updatedAt;
        expect(updatedAt).toBeGreaterThanOrEqual(commitStartedAt);
        expect(updatedAt).toBeLessThanOrEqual(Date.now());
        expect(sessionManager.getSessionId()).toBe(branchId);
      }
      expect(whileQueued).toEqual(beforeBranch);
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        expect.objectContaining({ id: sessionId, type: "session" }),
        expect.objectContaining({ id: user.messageId, type: "message" }),
        expect.objectContaining({ id: assistant.messageId, type: "message" }),
      ]);
    },
  );
});

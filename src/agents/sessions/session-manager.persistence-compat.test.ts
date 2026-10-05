import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import { openFileBackedSessionManagerForTest } from "../../../test/helpers/session-manager-file-fixture.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  loadTranscriptEventsSync,
  readSessionTranscriptWatermark,
  replaceTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { seedUnindexedTranscriptForTest } from "../../config/sessions/session-accessor.sqlite-import.test-support.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../internal-runtime-context.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { parseOpaqueLeafEntry } from "./session-manager-codec.js";
import { sessionManagerPrepareHistoryRead } from "./session-manager-history.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";

const tempDirs = createTempDirTracker();
afterEach(async () => {
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  tempDirs.cleanup();
});

function buildAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "messages" as const,
    provider: "anthropic" as const,
    model: "sonnet-4.6" as const,
    usage: createZeroUsageFixture(),
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function createScope(sessionId: string) {
  const dir = tempDirs.make("openclaw-session-manager-compat-");
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(dir, "openclaw-agent.sqlite"),
  };
  const persist = (eventId: string, message: unknown) =>
    appendTranscriptMessage(scope, { cwd: dir, eventId, message });
  const seed = async (events: unknown[]) => {
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    expect(replaceTranscriptEventsSync(scope, events)).toBe(true);
    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId, path: scope.storePath });
  };
  return { dir, scope, persist, seed };
}

function header(id: string, cwd: string, version = CURRENT_SESSION_VERSION) {
  return { type: "session", version, id, timestamp: new Date(0).toISOString(), cwd };
}

function row(type: string, id: string, parent: string | null, fields: Record<string, unknown>) {
  return { type, id, parentId: parent, timestamp: new Date(1).toISOString(), ...fields };
}

describe("SessionManager persistence compatibility", () => {
  it("persists canonical delivery facts and keeps the live assistant bytes identical", async () => {
    const { dir, scope } = createScope("directive-session");
    const manager = SessionManager.open(scope, dir);
    const tagged = buildAssistantMessage(
      [
        "[[reply_to_current]]",
        "[[reply_to:message-7]]",
        "[[audio_as_voice]]",
        "[[tts:provider=mock voiceId=voice-7]]",
        "Final answer [[tts:text]]Spoken answer[[/tts:text]]",
      ].join("\n"),
    );
    const cases = [
      {
        input:
          "Use `[[reply_to_current]]` literally.\nUse `[[tts:text]]spoken[[/tts:text]]` literally.\n```text\n[[audio_as_voice]]\n[[tts:provider=mock voiceId=voice-7]]\n```",
      },
      { input: "    [[reply_to_current]]\n    [[audio_as_voice]]" },
      { input: "[[reply_to_current]\nVisible reply", expected: "Visible reply" },
      { input: "Visible reply\n[[reply_to_current] literally" },
      { input: "Generated image\nMEDIA:./render.png" },
      {
        input:
          "  Leading  spaces\r\n\r\n\r\n    indented code\r\n```ts\r\nconst value = 1;\r\n```\r\n",
      },
    ];
    manager.appendMessage(tagged);
    expect(tagged.content).toEqual([{ type: "text", text: "Final answer" }]);
    expect(tagged).toMatchObject({
      openclawDelivery: {
        audioAsVoice: true,
        replyToId: "message-7",
        tts: {
          tagged: true,
          text: "Spoken answer",
          directives: [{ provider: "mock", values: { voiceid: "voice-7" } }],
        },
      },
    });
    const messages = [
      tagged,
      ...cases.map(({ input, expected }) => {
        const message = buildAssistantMessage(input);
        manager.appendMessage(message);
        expect(message.content).toEqual([{ type: "text", text: expected ?? input }]);
        expect(message).not.toHaveProperty("openclawDelivery");
        return message;
      }),
    ];
    const persisted = (await loadTranscriptEvents(scope)).flatMap((event) =>
      isRecord(event) && event.type === "message" ? [event.message] : [],
    );
    expect(persisted).toEqual(messages);
    expect(SessionManager.open(scope, dir).buildSessionContext().messages).toEqual(messages);
  });

  it("removes an active tail followed by a later inactive raw row", async () => {
    const { dir, scope, seed } = createScope("later-inactive-row-session");
    await seed([
      header(scope.sessionId, dir, 3),
      row("message", "root", null, { message: { role: "user", content: "root" } }),
      row("message", "active", "root", { message: buildAssistantMessage("active") }),
      row("message", "inactive", "root", {
        appendMode: "side",
        message: buildAssistantMessage("inactive"),
      }),
      row("leaf", "active-leaf", "inactive", { targetId: "active", appendParentId: "active" }),
    ]);

    const manager = SessionManager.open(scope, dir);
    expect(manager.removeTrailingEntries((entry) => entry.id === "active")).toBe(1);

    const events = await loadTranscriptEvents(scope);
    expect(events).not.toContainEqual(expect.objectContaining({ id: "active" }));
    expect(events).toContainEqual(
      expect.objectContaining({ id: "inactive", parentId: "root", appendMode: "side" }),
    );
  });

  it("refuses synchronous cleanup across a parent stored after its child", async () => {
    const { dir, scope, seed } = createScope("logical-gap");
    const events = [
      header(scope.sessionId, dir),
      row("message", "u", "a", { message: makeUserMessage("tail", 2) }),
      row("message", "a", null, { message: makeUserMessage("ancestor", 1) }),
      row("leaf", "selection", "a", { targetId: "u" }),
    ];
    await seed(events);
    const manager = SessionManager.open(scope, dir, { maxEvents: 1, maxBytes: 4096 });
    expect(manager.getBranch().map((entry) => entry.id)).toEqual(["u"]);
    expect(manager.removeTrailingEntries(() => false)).toBe(0);
    expect(() => manager.removeTrailingEntries((entry) => entry.type === "message")).toThrow(
      "Bounded transcript cleanup cannot cross the hydrated removal window",
    );
    expect(await loadTranscriptEvents(scope)).toEqual(events);
  });

  it.each(
    (["bounded", "resident", "detached"] as const).flatMap((mode) =>
      [false, true].map((selected) => ({ mode, selected })),
    ),
  )(
    "keeps canonical callbacks and raw opaque cleanup parents ($mode, selected=$selected)",
    async ({ mode, selected }) => {
      const { dir, scope, seed } = createScope("opaque-suffix-leaf");
      const ancestor = row("message", "ancestor", null, {
        message: makeUserMessage("retained question", 1),
      });
      const events = [
        header(scope.sessionId, dir),
        ancestor,
        row("future-metadata", "opaque", "ancestor", { exact: "retained opaque bytes" }),
        row("future-metadata", "intervening", "ancestor", {}),
        ...(selected
          ? [
              row("leaf", "selection", "intervening", {
                targetId: "opaque",
                appendParentId: "intervening",
              }),
            ]
          : []),
        row("message", "temporary", selected ? "intervening" : "opaque", {
          message: buildAssistantMessage("temporary reply"),
        }),
      ];
      if (mode !== "detached") {
        await seed(events);
      }
      const limits = mode === "bounded" ? { maxEvents: 10, maxBytes: 8192 } : undefined;
      const manager =
        mode === "detached"
          ? SessionManager.fromEntries(events)
          : SessionManager.open(scope, dir, limits);
      const read = async () =>
        mode === "detached" ? manager.getPersistedEntries() : loadTranscriptEvents(scope);
      expect(
        manager.removeTrailingEntries(
          (entry) => entry.id === "temporary" && entry.parentId === "ancestor",
        ),
      ).toBe(1);
      const persisted = await read();
      expect(persisted.slice(0, events.length - 1)).toEqual(events.slice(0, -1));
      expect(persisted).not.toContainEqual(expect.objectContaining({ id: "temporary" }));
      expect(parseOpaqueLeafEntry(persisted.at(-1))).toMatchObject({ targetId: "opaque" });
      const reopened =
        mode === "detached"
          ? SessionManager.fromEntries(persisted)
          : await SessionManager.openAsync(scope, dir);
      for (const current of [manager, reopened]) {
        expect(current.getLeafId()).toBe("ancestor");
        expect(current.getLeafEntry()).toEqual(ancestor);
        expect(current.getAppendParentId()).toBe("opaque");
      }
      const continued = await manager.appendMessageAsync(makeUserMessage("continue", 3));
      expect(manager.getLeafId()).toBe(continued);
      expect(await read()).toContainEqual(
        expect.objectContaining({ id: continued, parentId: "opaque" }),
      );
      expect(manager.getBranch().map((entry) => entry.id)).toEqual(["ancestor", continued]);
    },
  );

  it.each([
    { mode: "detached", bounded: false, predecessor: "selected" },
    { mode: "detached", bounded: false, predecessor: null },
    { mode: "sync", bounded: false, predecessor: "selected" },
    { mode: "async", bounded: false, predecessor: "selected" },
    { mode: "sync", bounded: true, predecessor: "selected" },
    { mode: "async", bounded: true, predecessor: "selected" },
    { mode: "sync", bounded: true, predecessor: null },
  ] as const)(
    "keeps the logical predecessor after $mode cleanup (bounded=$bounded, predecessor=$predecessor)",
    async ({ mode, bounded, predecessor }) => {
      const { dir, scope, seed } = createScope("logical-suffix-parent");
      const selected = row("message", "selected", null, {
        message: makeUserMessage("selected history", 1),
      });
      const cursor = row("message", "cursor", "selected", {
        message: makeUserMessage("inactive cursor history", 2),
      });
      const retained = row("custom", "retained", "temporary", {
        customType: "plugin-state",
        data: { retained: true },
      });
      const events = [
        header(scope.sessionId, dir),
        selected,
        cursor,
        row("leaf", "selection", "cursor", {
          targetId: predecessor,
          appendParentId: "cursor",
          appendMode: "side",
        }),
        row("message", "temporary", "cursor", {
          message: buildAssistantMessage("temporary selected reply"),
        }),
        retained,
      ];
      if (mode !== "detached") {
        await seed(events);
      }
      const limits = bounded ? { maxEvents: 2, maxBytes: 4096 } : undefined;
      const manager =
        mode === "detached"
          ? SessionManager.fromEntries(events)
          : mode === "sync"
            ? SessionManager.open(scope, dir, limits)
            : await SessionManager.openAsync(scope, dir, limits);
      expect(manager.getBranch().map((entry) => entry.id)).toEqual([
        ...(!bounded && predecessor ? [predecessor] : []),
        "temporary",
        "retained",
      ]);
      if (bounded) {
        expect(manager.getEntry("selected")).toBeUndefined();
      }
      const predicate = (entry: ReturnType<SessionManager["getBranch"]>[number]) =>
        entry.id === "temporary";
      const options = {
        preserveTrailing: (entry: ReturnType<SessionManager["getBranch"]>[number]) =>
          entry.type === "custom",
      };

      if (mode === "sync" && bounded && predecessor) {
        expect(() => manager.removeTrailingEntries(predicate, options)).toThrow(
          "Bounded transcript cleanup cannot cross the hydrated removal window",
        );
        expect(await loadTranscriptEvents(scope)).toEqual(events);
      }
      expect(
        mode === "async" || (bounded && predecessor)
          ? await manager.removeTrailingEntriesAsync(predicate, options)
          : manager.removeTrailingEntries(predicate, options),
      ).toBe(1);

      const persisted =
        mode === "detached" ? manager.getPersistedEntries() : await loadTranscriptEvents(scope);
      expect(persisted.slice(0, 4)).toEqual(events.slice(0, 4));
      expect(persisted).not.toContainEqual(expect.objectContaining({ id: "temporary" }));
      expect(persisted).toContainEqual({ ...retained, parentId: predecessor });
      expect(manager.getLeafId()).toBe(predecessor);
      expect(manager.getAppendParentId()).toBe(predecessor);
      const reopened =
        mode === "detached"
          ? SessionManager.fromEntries(persisted)
          : await SessionManager.openAsync(scope, dir);
      expect(reopened.getBranch().map((entry) => entry.id)).toEqual(
        predecessor ? [predecessor] : [],
      );
      expect(reopened.getLeafId()).toBe(predecessor);
      expect(reopened.getAppendParentId()).toBe(predecessor);

      manager.branch("retained");
      const inspectedParents: Array<string | null> = [];
      expect(
        await manager.removeTrailingEntriesAsync((entry) => {
          if (entry.id !== "retained") {
            return false;
          }
          inspectedParents.push(entry.parentId);
          return entry.parentId === predecessor;
        }),
      ).toBe(1);
      expect(inspectedParents).toEqual([predecessor]);
      const afterRemoval =
        mode === "detached" ? manager.getPersistedEntries() : await loadTranscriptEvents(scope);
      expect(afterRemoval).not.toContainEqual(expect.objectContaining({ id: "retained" }));
    },
  );

  it.each(["resident", "bounded", "selected"] as const)(
    "keeps canonical async cleanup parents across opaque history (%s)",
    async (mode) => {
      const { dir, scope, seed } = createScope("opaque-callback-parent");
      const events = [
        header(scope.sessionId, dir),
        row("message", "ancestor", null, {
          message: makeUserMessage("older question " + "x".repeat(8192), 1),
        }),
        row("future-metadata", "opaque", "ancestor", { bytes: "exact opaque bytes" }),
        row("future-metadata", "intervening", "ancestor", {}),
        row("custom", "callback", "opaque", { customType: "plugin-state", data: { exact: true } }),
        row("message", "tail", "callback", { message: makeUserMessage("current question", 2) }),
      ];
      await seed(events);
      const manager = await SessionManager.openBoundedAsync(scope, {
        maxEvents: mode === "resident" ? 4 : 2,
        maxBytes: mode === "resident" ? 16_384 : 4096,
      });
      if (mode === "selected") {
        await manager.branchAsync("tail");
      }
      expect(Boolean(manager.getEntry("ancestor"))).toBe(mode === "resident");
      const history = manager[sessionManagerPrepareHistoryRead]();
      expect(await history.readEntryNavigation("callback")).toMatchObject({ parentId: "opaque" });
      expect(await history.readBranch({ selection: "branch", maxEvents: 1 })).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "callback", parentId: "ancestor" })]),
      );
      for (let iteration = 0; iteration < 3; iteration++) {
        const seen: string[] = [];
        expect(
          await manager.removeTrailingEntriesAsync(
            (entry) => {
              expect(entry.id).toBe("callback");
              expect(entry.parentId).toBe("ancestor");
              seen.push("predicate");
              return false;
            },
            {
              preserveTrailing: (entry) => {
                if (entry.id !== "callback") {
                  return true;
                }
                expect(entry.parentId).toBe("ancestor");
                seen.push("preserve");
                return false;
              },
            },
          ),
        ).toBe(0);
        expect(seen).toEqual(["preserve", "predicate"]);
        await manager.appendMessageAsync(
          makeUserMessage(`next question ${iteration}`, iteration + 3),
        );
      }
      expect((await loadTranscriptEvents(scope)).slice(0, events.length)).toEqual(events);
    },
  );

  it("keeps the raw opaque source anchor in a bounded legacy rewrite", async () => {
    const { dir, scope, seed } = createScope("opaque-rewrite-anchor");
    const events = [
      header(scope.sessionId, dir),
      row("message", "ancestor", null, { message: makeUserMessage("older question", 1) }),
      row("future-metadata", "opaque", "ancestor", { exact: "opaque bytes" }),
      row("future-metadata", "intervening", "ancestor", {}),
      row("message", "first", "opaque", { message: makeUserMessage("first retained", 2) }),
      row("message", "last", "first", { message: makeUserMessage("last retained", 3) }),
    ];
    await seed(events);
    const manager = await SessionManager.openBoundedAsync(scope, { maxEvents: 2, maxBytes: 4096 });
    expect(manager.getEntry("ancestor")).toBeUndefined();
    const rewrite = await manager.prepareTranscriptRewriteAsync();
    await rewrite.sessionManager.resetLeafAsync();
    const first = await rewrite.sessionManager.appendMessageAsync(
      makeUserMessage("rewritten first", 4),
    );
    const last = await rewrite.sessionManager.appendMessageAsync(
      makeUserMessage("last retained", 3),
    );
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    await rewrite.commit(
      new Map([
        ["first", first!],
        ["last", last!],
      ]),
    );
    const persisted = await loadTranscriptEvents(scope);
    expect(persisted.slice(0, events.length)).toEqual(events);
    expect(persisted).toContainEqual(expect.objectContaining({ id: first, parentId: "opaque" }));
  });

  it.each(["canonical", "opaque", "selected-opaque"] as const)(
    "keeps an excluded append cursor's canonical parent in async cleanup callbacks (%s)",
    async (mode) => {
      const { dir, scope, seed } = createScope("excluded-callback-parent");
      const events = [
        header(scope.sessionId, dir),
        row("message", "visible", null, { message: makeUserMessage("visible", 1) }),
        row("message", "excluded", "visible", {
          message: { ...makeUserMessage("excluded", 2), excludeFromContext: true },
        }),
      ];
      if (mode !== "canonical") {
        events.push(
          row("future-metadata", "opaque-cursor", "excluded", { exact: "cursor bytes" }),
          row("leaf", "selected-cursor", "opaque-cursor", { targetId: "opaque-cursor" }),
        );
      }
      await seed(events);
      const manager = await SessionManager.openBoundedAsync(scope, {
        maxEvents: 2,
        maxBytes: 4096,
      });
      if (mode === "selected-opaque") {
        await manager.branchAsync("opaque-cursor");
      }
      expect(manager.getAppendParentId()).toBe(mode === "canonical" ? "excluded" : "opaque-cursor");
      expect(manager.getEntry("excluded")).toBeUndefined();
      const appended = await manager.appendMessageAsync(makeUserMessage("new question", 3));
      let inspected = false;
      expect(
        await manager.removeTrailingEntriesAsync((entry) => {
          expect(entry.id).toBe(appended);
          expect(entry.parentId).toBe("excluded");
          inspected = true;
          return false;
        }),
      ).toBe(0);
      expect(inspected).toBe(true);
      expect((await loadTranscriptEvents(scope)).slice(0, events.length)).toEqual(events);
    },
  );

  it("preserves and rebases trailing metadata, labels, and leaf controls", async () => {
    const { dir, scope, seed } = createScope("sqlite-remove-controls-session");
    const events = [
      header(scope.sessionId, dir),
      row("message", "user", null, { message: { role: "user", content: "question" } }),
      row("message", "temporary", "user", { message: buildAssistantMessage("temporary") }),
      row("label", "temporary-label", "temporary", { targetId: "temporary", label: "retry" }),
      row("label", "nested-temporary-label", "temporary-label", {
        targetId: "temporary-label",
        label: "nested retry",
      }),
      row("custom", "plugin-state", "nested-temporary-label", {
        customType: "plugin-state",
        data: { enabled: true },
      }),
      row("session_info", "session-info", "plugin-state", { name: "kept session" }),
      row("leaf", "leaf-control", "session-info", {
        targetId: "temporary",
        appendParentId: "temporary",
      }),
    ];
    await seed(events);
    const generationBefore = readSessionTranscriptWatermark(scope).generation;
    const manager = SessionManager.open(scope, dir);

    expect(
      manager.removeTrailingEntries((entry) => entry.id === "temporary", {
        preserveTrailing: (entry) =>
          entry.type === "custom" || entry.type === "label" || entry.type === "session_info",
      }),
    ).toBe(1);

    expect(readSessionTranscriptWatermark(scope).generation).not.toBe(generationBefore);
    expect(await loadTranscriptEvents(scope)).toMatchObject([
      { type: "session" },
      { id: "user", parentId: null, type: "message" },
      { id: "plugin-state", parentId: "user", type: "custom" },
      { id: "session-info", parentId: "plugin-state", type: "session_info" },
      {
        id: "leaf-control",
        parentId: "session-info",
        targetId: "user",
        appendParentId: "user",
        type: "leaf",
      },
    ]);
  });

  it.each(["sync", "bounded", "bounded-preserved"] as const)(
    "allows stale suffix cleanup to remain a no-op when its target is absent (%s)",
    async (mode) => {
      const { dir, scope, persist } = createScope("sqlite-remove-concurrent-noop-session");
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await persist("older", { role: "user", content: "older question" });
      await persist("base", { role: "user", content: "question" });
      const customId =
        mode === "bounded-preserved"
          ? SessionManager.open(scope, dir).appendCustomEntry("kept", { retained: true })
          : undefined;
      const manager =
        mode === "sync"
          ? SessionManager.open(scope, dir)
          : await SessionManager.openBoundedAsync(scope, {
              maxEvents: mode === "bounded-preserved" ? 2 : 1,
              maxBytes: 4096,
            });
      if (mode !== "sync") {
        expect(manager.getEntry("older")).toBeUndefined();
        expect(manager.getEntry("base")).toBeDefined();
      }
      const beforeContext = manager.buildSessionContext();
      await persist("concurrent", { role: "user", content: "concurrent" });
      const inspected: string[] = [];
      const predicate = (entry: ReturnType<SessionManager["getBranch"]>[number]) => {
        inspected.push(`remove:${entry.id}`);
        expect(entry.parentId).toBe("older");
        return entry.type === "message" && entry.message.role === "assistant";
      };
      const options = {
        preserveTrailing: (entry: ReturnType<SessionManager["getBranch"]>[number]) => {
          inspected.push(`preserve:${entry.id}`);
          return entry.type === "custom";
        },
      };

      expect(
        mode === "sync"
          ? manager.removeTrailingEntries(predicate, options)
          : await manager.removeTrailingEntriesAsync(predicate, options),
      ).toBe(0);
      expect(inspected).toEqual([
        ...(customId ? [`preserve:${customId}`] : []),
        "preserve:base",
        "remove:base",
      ]);
      expect(manager.buildSessionContext()).toEqual(beforeContext);
      expect(
        (await loadTranscriptEvents(scope)).map((event) => isRecord(event) && event.id),
      ).toEqual([scope.sessionId, "older", "base", ...(customId ? [customId] : []), "concurrent"]);
    },
  );

  it.each([
    "sync",
    "bounded",
    "bounded-preserved",
    "bounded-preserved-only",
    "bounded-side-cursor",
  ] as const)(
    "rejects stale suffix cleanup requiring history without deleting concurrent entries (%s)",
    async (mode) => {
      const { dir, scope, persist } = createScope("sqlite-remove-concurrent-session");
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await persist("older", { role: "user", content: "older question" });
      await persist("base", { role: "user", content: "question" });
      await persist("temporary", buildAssistantMessage("temporary"));
      if (mode === "bounded-preserved") {
        SessionManager.open(scope, dir).appendCustomEntry("kept", { retained: true });
      }
      const manager =
        mode === "sync"
          ? SessionManager.open(scope, dir)
          : await SessionManager.openBoundedAsync(scope, {
              maxEvents: mode === "bounded-preserved" ? 2 : 1,
              maxBytes: 4096,
            });
      if (mode === "bounded-side-cursor") {
        await manager.appendLeafControlAsync({
          targetId: "base",
          appendParentId: "temporary",
          appendMode: "side",
        });
        expect(manager.getLeafId()).toBe("base");
        expect(manager.getAppendParentId()).toBe("temporary");
      }
      const beforeContext = manager.buildSessionContext();
      await persist("concurrent", { role: "user", content: "concurrent" });
      const concurrentEvents = await loadTranscriptEvents(scope);
      const predicate = (entry: ReturnType<SessionManager["getBranch"]>[number]) =>
        entry.type === "message" && entry.message.role === "assistant";
      const options = {
        preserveTrailing: (entry: ReturnType<SessionManager["getBranch"]>[number]) =>
          mode === "bounded-preserved-only" || entry.type === "custom",
      };

      if (mode === "sync") {
        expect(() => manager.removeTrailingEntries(predicate, options)).toThrow(
          "SQLite transcript changed while preparing suffix removal",
        );
      } else {
        await expect(manager.removeTrailingEntriesAsync(predicate, options)).rejects.toThrow(
          "Session transcript changed during history acquisition",
        );
      }
      expect(manager.buildSessionContext()).toEqual(beforeContext);
      expect(await loadTranscriptEvents(scope)).toEqual(concurrentEvents);
    },
  );

  it("retains the append transaction fence when another write starts after commit", async () => {
    const { dir, scope, persist } = createScope("sqlite-append-fence-session");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await persist("base", { role: "user", content: "question" });
    const manager = SessionManager.open(scope, dir);
    const temporaryId = manager.appendMessage(buildAssistantMessage("temporary"));
    const afterAppend = await loadTranscriptEvents(scope);
    const base = afterAppend[1];
    if (!base || typeof base !== "object") {
      throw new Error("Expected persisted base transcript event");
    }
    expect(
      replaceTranscriptEventsSync(scope, [
        afterAppend[0],
        { ...base, message: { role: "user", content: "rewritten question" } },
        afterAppend[2],
      ]),
    ).toBe(true);

    expect(() => manager.removeTrailingEntries((entry) => entry.id === temporaryId)).toThrow(
      "SQLite transcript changed while preparing suffix removal",
    );
    expect(await loadTranscriptEvents(scope)).toMatchObject([
      { type: "session" },
      { id: "base", message: { role: "user", content: "rewritten question" } },
      { id: temporaryId },
    ]);
  });

  it.each(["bounded-sqlite", "identity", "writer", "lifecycle"])(
    "keeps the live tree unchanged after a rejected %s tail rewrite",
    async (failure) => {
      const { dir, scope } = createScope("tail-rewrite");
      const initialEntry = {
        sessionId: scope.sessionId,
        updatedAt: 1,
        activeWriterRunId: "original-writer",
        lifecycleRevision: "original-lifecycle",
      };
      await upsertSessionEntryCore(scope, initialEntry);
      const seed = SessionManager.open(scope, dir);
      const earlierId = seed.appendMessage(makeUserMessage("earlier history", 1));
      const questionId = seed.appendMessage({ role: "user", content: "question", timestamp: 2 });
      const temporaryId = seed.appendMessage(buildAssistantMessage("temporary error"));
      const metadataId = seed.appendCustomEntry("preserved-state", { retained: true });
      const labelId = seed.appendLabelChange(temporaryId, "temporary label");
      const originalEvents = loadTranscriptEventsSync(scope);
      const limits = failure === "bounded-sqlite" ? { maxEvents: 4, maxBytes: 4096 } : undefined;
      const manager = SessionManager.open(scope, dir, limits);
      const database = openOpenClawAgentDatabase({
        agentId: scope.agentId,
        path: resolveSessionTranscriptDatabasePath(scope),
      });
      const readRows = () =>
        database.db
          .prepare(
            "SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
          )
          .all(scope.sessionId);
      const readManager = () => ({
        entries: manager.getEntries(),
        leafId: manager.getLeafId(),
        appendParentId: manager.getAppendParentId(),
        label: manager.getLabel(temporaryId),
        target: manager.getSessionTarget(),
        context: manager.buildSessionContext(),
      });
      const beforeRows = readRows();
      const beforeManager = structuredClone(readManager());
      if (failure.endsWith("sqlite")) {
        expect(manager.getEntry(earlierId)).toBeUndefined();
        expect(manager.getEntry(questionId)).toBeDefined();
        database.db.exec(`CREATE TRIGGER reject_tail_rewrite BEFORE INSERT ON transcript_events
          BEGIN SELECT RAISE(ABORT, 'tail rewrite failed'); END;`);
      } else {
        await updateSessionEntry(scope, () =>
          failure === "identity"
            ? { sessionId: "replacement-session" }
            : failure === "writer"
              ? { activeWriterRunId: "replacement-writer" }
              : { lifecycleRevision: "replacement-lifecycle" },
        );
      }
      const remove = () =>
        manager.removeTrailingEntries((entry) => entry.id === temporaryId, {
          preserveTrailing: (entry) => entry.type === "custom" || entry.type === "label",
        });
      const rewrite = () =>
        withOwnedSessionTranscriptWrites(
          {
            ...(failure === "writer" || failure === "lifecycle"
              ? {
                  sessionTarget: {
                    ...scope,
                    expectedWriterRunId: initialEntry.activeWriterRunId,
                    expectedLifecycleRevision: initialEntry.lifecycleRevision,
                  },
                }
              : {}),
            withTranscriptWrite: async (run) => await run(),
          },
          async () => remove(),
        );

      await expect(rewrite()).rejects.toThrow(
        failure.endsWith("sqlite") ? "tail rewrite failed" : undefined,
      );
      expect(readRows()).toEqual(beforeRows);
      expect(readManager()).toEqual(beforeManager);

      if (failure.endsWith("sqlite")) {
        database.db.exec("DROP TRIGGER reject_tail_rewrite");
      } else {
        await upsertSessionEntryCore(scope, initialEntry);
      }
      await expect(rewrite()).resolves.toBe(1);
      expect(manager.getEntry(temporaryId)).toBeUndefined();
      expect(manager.getLabel(temporaryId)).toBeUndefined();
      // The next reader must work immediately, without waiting for a projection rebuild.
      const reopened = SessionManager.open(scope, dir, limits);
      if (failure === "bounded-sqlite") {
        const expectedRetained = structuredClone(
          originalEvents.filter(
            (event) => !isRecord(event) || (event.id !== temporaryId && event.id !== labelId),
          ),
        );
        for (const event of expectedRetained) {
          if (isRecord(event) && event.id === metadataId) {
            event.parentId = questionId;
          }
        }
        const durable = loadTranscriptEventsSync(scope);
        const controls = durable.filter((event) => parseOpaqueLeafEntry(event));
        expect(controls).toHaveLength(1);
        const control = parseOpaqueLeafEntry(controls[0]);
        expect(control).toMatchObject({ parentId: metadataId, targetId: questionId });
        expect(control?.appendParentId ?? control?.targetId).toBe(questionId);
        expect(durable.filter((event) => !parseOpaqueLeafEntry(event))).toEqual(expectedRetained);
        const full = SessionManager.open(scope, dir);
        expect(full.getBranch().map((entry) => entry.id)).toEqual([earlierId, questionId]);
        expect(reopened.getBranch()).toEqual(full.getBranch());
        expect(reopened.buildSessionContext()).toEqual(full.buildSessionContext());
        // The bounded public view normalizes an omitted parent; storage must retain its real ID.
        expect(manager.getEntries()).toEqual(
          expectedRetained
            .filter(isRecord)
            .filter(({ id }) => id === questionId || id === metadataId)
            .map((event) => ({ ...event, parentId: event.id === questionId ? null : questionId })),
        );
        expect(
          manager
            .getPersistedEntries()
            .filter((event) => isRecord(event) && event.id === metadataId),
        ).toEqual(expectedRetained.filter((event) => isRecord(event) && event.id === metadataId));
        expect(manager.getLeafId()).toBe(questionId);
        expect(manager.getAppendParentId()).toBe(questionId);
      } else {
        expect(reopened.getPersistedEntries()).toEqual(manager.getPersistedEntries());
      }
    },
  );
});

it.each([
  { mode: "sync", metadataOnly: false },
  { mode: "async", metadataOnly: false },
  { mode: "bounded", metadataOnly: false },
  { mode: "sync", metadataOnly: true },
  { mode: "async", metadataOnly: true },
  { mode: "bounded", metadataOnly: true },
] as const)(
  "removes and counts duplicate physical suffix rows (mode=$mode, metadataOnly=$metadataOnly)",
  async ({ mode, metadataOnly }) => {
    const { dir, scope } = createScope("duplicate-suffix");
    const entry = { sessionId: scope.sessionId, updatedAt: 1 };
    await upsertSessionEntryCore(scope, entry);
    const sessionHeader = header(scope.sessionId, dir);
    const user = row("message", "user", null, { message: makeUserMessage("question", 1) });
    const assistant = row("message", "assistant", "user", {
      message: buildAssistantMessage("temporary"),
    });
    const custom = row("custom", "metadata", "assistant", {
      customType: "plugin-state",
      data: { revision: 1 },
    });
    const entries = [sessionHeader, user, assistant, custom, { ...custom, data: { revision: 2 } }];
    await seedUnindexedTranscriptForTest({
      ...scope,
      entry,
      events: entries.map((event, seq) => ({
        session_id: scope.sessionId,
        seq,
        event_json: JSON.stringify(event),
        created_at: seq,
      })),
    });
    expect(await loadTranscriptEvents(scope)).toEqual(entries);
    const manager =
      mode === "sync"
        ? SessionManager.open(scope, dir)
        : mode === "async"
          ? await SessionManager.openAsync(scope, dir)
          : await SessionManager.openBoundedAsync(scope, {
              cwd: dir,
              maxBytes: 4096,
              maxEvents: 4,
            });
    expect(manager.getBranch().map((entry) => entry.id)).toEqual(["user", "assistant", "metadata"]);
    expect(manager.getEntry("metadata")).toMatchObject({ data: { revision: 2 } });

    if (mode === "bounded") {
      expect(
        await manager[sessionManagerPrepareHistoryRead]().readEntryNavigation("metadata"),
      ).toMatchObject({ rawSeq: 4, type: "custom", parentId: "assistant" });
    }
    const operation = mode === "sync" ? "removeTrailingEntries" : "removeTrailingEntriesAsync";
    const removed = await manager[operation]((entry) =>
      metadataOnly ? entry.id === "metadata" : entry.id !== "user",
    );
    const retained = metadataOnly ? [user, assistant] : [user];
    const retainedLeaf = metadataOnly ? "assistant" : "user";
    const persisted = await loadTranscriptEvents(scope);
    expect(removed).toBe(metadataOnly ? 2 : 3);
    expect(persisted.filter((event) => !parseOpaqueLeafEntry(event))).toEqual([
      sessionHeader,
      ...retained,
    ]);
    const controls = persisted.flatMap((event) => parseOpaqueLeafEntry(event) ?? []);
    expect(controls).toHaveLength(mode === "bounded" ? 1 : 0);
    if (mode === "bounded") {
      expect(controls[0]?.targetId).toBe(retainedLeaf);
      expect(
        controls[0]?.appendParentId === undefined
          ? controls[0]?.targetId
          : controls[0]?.appendParentId,
      ).toBe(retainedLeaf);
      expect(parseOpaqueLeafEntry(persisted.at(-1))).toEqual(controls[0]);
    }
    expect(manager.getEntries()).toEqual(retained);
    expect(manager.getEntry("metadata")).toBeUndefined();
    expect(manager.getLeafId()).toBe(retainedLeaf);
    expect(manager.getAppendParentId()).toBe(retainedLeaf);
    const reopened = await SessionManager.openAsync(scope, dir);
    expect(reopened.getPersistedEntries()).toEqual(persisted);
    expect(reopened.getEntry("metadata")).toBeUndefined();
    expect(reopened.getBranch()).toEqual(retained);
    expect(reopened.getLeafId()).toBe(retainedLeaf);
    expect(reopened.getAppendParentId()).toBe(retainedLeaf);
  },
);

it("keeps file fixture appends and rewrites readable after an unterminated record", async () => {
  const dir = tempDirs.make("openclaw-session-manager-compat-");
  const file = path.join(dir, "unterminated.jsonl");
  await fs.writeFile(file, JSON.stringify(header("unterminated", dir)));
  const manager = openFileBackedSessionManagerForTest(file, dir);
  manager.appendMessage(makeUserMessage("appended", 1));
  expect(openFileBackedSessionManagerForTest(file, dir).buildSessionContext().messages).toEqual([
    expect.objectContaining({ content: "appended", role: "user" }),
  ]);
  expect(manager.removeTrailingEntries((entry) => entry.type === "message")).toBe(1);
  expect(openFileBackedSessionManagerForTest(file, dir).buildSessionContext().messages).toEqual([]);
});

async function userSession() {
  const { dir, scope } = createScope("user-replay");
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const user = { ...makeUserMessage("question", 1), idempotencyKey: "run:user" };
  const persist = (eventId: string, message: unknown, parentId?: string) =>
    appendTranscriptMessage(scope, { cwd: dir, eventId, message, now: 1, parentId });
  return { dir, scope, user, persist };
}

function expectSingleUser(events: unknown[], key: string) {
  expect(
    events.filter(
      (event) =>
        isRecord(event) &&
        isRecord(event.message) &&
        event.message.role === "user" &&
        event.message.idempotencyKey === key,
    ),
  ).toHaveLength(1);
}

describe("SessionManager user idempotency", () => {
  it("preserves distinct keyed user turns with the same visible text", () => {
    const manager = SessionManager.inMemory();
    const message = { ...makeUserMessage("same question", 1), idempotencyKey: "first:user" };
    const first = manager.appendMessage(message);
    const second = { ...message, idempotencyKey: "second-run:user", timestamp: 2 };
    expect(manager.appendMessage(second)).not.toBe(first);
    expect(manager.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
  });

  it("allows an explicitly caller-checked keyed user append", () => {
    const manager = SessionManager.inMemory();
    const message = {
      ...makeUserMessage("caller-owned user", 1),
      idempotencyKey: "caller-checked:user",
    };
    const first = manager.appendMessage(message);
    expect(manager.appendMessage(message, { idempotencyLookup: "caller-checked" })).not.toBe(first);
  });

  it("rejects a keyed user collision behind an excluded assistant", async () => {
    const { dir, scope, user, persist } = await userSession();
    const excluded = { ...user, excludeFromContext: true };
    await persist("pre-persisted-user", excluded);
    await persist(
      "persisted-assistant",
      { ...buildAssistantMessage("answer"), excludeFromContext: true },
      "pre-persisted-user",
    );
    const manager = SessionManager.openBounded(scope, {
      cwd: dir,
      maxBytes: 100_000,
      maxEvents: 100,
    });
    expect(() => manager.appendMessage(excluded)).toThrow(
      "Session transcript keyed user is outside the current turn",
    );
    expect(manager.getAppendParentId()).toBe("persisted-assistant");
    expect(manager.resolveCurrentTurnEntryId(() => true)).toBe("persisted-assistant");
    expectSingleUser(await loadTranscriptEvents(scope), user.idempotencyKey);
  });

  it("adopts a keyed user persisted after the manager loaded", async () => {
    const { dir, scope, user, persist } = await userSession();
    await persist("existing-assistant", buildAssistantMessage("previous answer"));
    const manager = SessionManager.open(scope, dir);
    await persist("ingress-persisted-user", user, "existing-assistant");
    const modelId = await manager.appendModelChange("openai", "gpt-5.5");
    const thinkingId = await manager.appendThinkingLevelChange("off");
    const metadataId = manager.appendCustomEntry("model-snapshot", {
      modelApi: "openai-responses",
      modelId: "gpt-5.5",
      provider: "openai",
    });
    expect(manager.appendMessage(user)).toBe("ingress-persisted-user");
    expect(manager.getAppendParentId()).toBe(metadataId);
    const assistantId = manager.appendMessage(buildAssistantMessage("answer"));
    const events = await loadTranscriptEvents(scope);
    expect(events).toMatchObject([
      { type: "session" },
      { id: "existing-assistant" },
      { id: "ingress-persisted-user" },
      { id: modelId, parentId: "ingress-persisted-user" },
      { id: thinkingId, parentId: modelId },
      { id: metadataId, parentId: thinkingId },
      { id: assistantId, parentId: metadataId },
    ]);
    expectSingleUser(events, user.idempotencyKey);
  });

  it("adopts an excluded persisted user across session setup metadata", async () => {
    const { dir, scope, user, persist } = await userSession();
    const excluded = { ...user, excludeFromContext: true };
    await persist("pre-persisted-user", excluded);
    const manager = SessionManager.openBounded(scope, {
      cwd: dir,
      maxBytes: 100_000,
      maxEvents: 100,
    });
    await manager.appendModelChange("openai", "gpt-5.5");
    await manager.appendThinkingLevelChange("off");
    const metadataId = manager.appendCustomEntry("model-snapshot", {
      modelApi: "openai-responses",
      modelId: "gpt-5.5",
      provider: "openai",
    });
    expect(manager.appendMessageWithTranscriptAnchor({ ...excluded, timestamp: 2 })).toMatchObject({
      entryId: "pre-persisted-user",
      message: excluded,
      anchor: { entryId: "pre-persisted-user", idempotencyKey: user.idempotencyKey },
    });
    expect(manager.getAppendParentId()).toBe(metadataId);
    const id = manager.appendMessage(buildAssistantMessage("answer"));
    const events = await loadTranscriptEvents(scope);
    expect(events).toContainEqual(expect.objectContaining({ id, parentId: metadataId }));
    expectSingleUser(events, user.idempotencyKey);
  });

  it("adopts the current keyed user across runtime context and compaction", async () => {
    const { dir, scope, user, persist } = await userSession();
    await persist("requester-final", buildAssistantMessage("Earlier requester turn is complete"));
    await persist("pre-persisted-user", user);
    const manager = SessionManager.open(scope, dir);
    manager.appendCustomMessageEntry(
      OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
      "Child completed; summarize its result.",
      false,
    );
    const compactionId = manager.appendCompaction("Compacted history", "pre-persisted-user", 100);
    expect(manager.appendMessage(user)).toBe("pre-persisted-user");
    expect(manager.getAppendParentId()).toBe(compactionId);
    const id = manager.appendMessage(buildAssistantMessage("answer"));
    const events = await loadTranscriptEvents(scope);
    expect(events).toContainEqual(expect.objectContaining({ id, parentId: compactionId }));
    expectSingleUser(events, user.idempotencyKey);
  });
});

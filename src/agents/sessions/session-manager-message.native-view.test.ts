import path from "node:path";
import { expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { loadTranscriptReadSnapshotSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import { SqliteTranscriptMutationConflictError } from "../../config/sessions/session-accessor.sqlite-transcript-write-snapshot.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { installSessionToolResultGuard } from "../session-tool-result-guard.js";
import { SessionToolResultPendingConflictError } from "../session-tool-result-pending-facts.js";
import { sessionToolResultPending } from "../session-tool-result-pending.js";
import {
  assistant,
  assertPendingDiscardNavigation,
  assertPendingNavigation,
  result,
} from "./session-manager-message.worker.test-support.js";
import { SessionManager } from "./session-manager.js";

const observation = vi.hoisted(() => ({
  control: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 8),
  path: new SharedArrayBuffer(4096),
}));
vi.mock("../../infra/worker-cpu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/worker-cpu.js")>();
  const { createMessageWorkerMock } =
    await import("./session-manager-message.worker-observation.test-support.js");
  return createMessageWorkerMock(actual, observation);
});

function nativeView(manager: SessionManager) {
  return structuredClone({
    header: manager.getHeader(),
    entries: manager.getEntries(),
    persisted: manager.getPersistedEntries(),
    tree: manager.getTree(),
    branch: manager.getBranch(),
    context: manager.buildSessionContext(),
    leaf: manager.getLeafId(),
    parent: manager.getAppendParentId(),
    mode: manager.getAppendMode(),
    boundaries: manager.getBoundaryCount(),
    target: manager.getSessionTarget(),
  });
}

const nativeCalls = (...ids: string[]) => ({
  ...assistant(),
  content: ids.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: {} })),
});

async function withNativeMessages(
  run: (fixture: {
    manager: SessionManager;
    target: Parameters<typeof SessionManager.open>[0];
    database: ReturnType<typeof openOpenClawAgentDatabase>;
  }) => void,
) {
  await withOpenClawTestState({ label: "native-message-continuation" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "native-message-continuation",
      sessionKey: "agent:main:native-message-continuation",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      env: state.env,
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(target);
    manager.appendMessage({ role: "user", content: "opening", timestamp: 1 });
    run({
      manager,
      target,
      database: openOpenClawAgentDatabase({
        agentId: target.agentId,
        path: target.storePath,
        env: state.env,
      }),
    });
  });
}

it.each(
  (["branch", "resetLeaf"] as const).flatMap((navigation) =>
    (["detached", "native"] as const).map((mode) => ({ navigation, mode })),
  ),
)("projects original pending custody after $navigation on $mode", async ({ navigation, mode }) => {
  if (mode === "detached") {
    const observed = assertPendingNavigation(SessionManager.inMemory(), navigation);
    expect(observed.mock.calls.map(([message]) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "toolResult",
      "toolResult",
    ]);
  } else {
    await withNativeMessages(({ manager, target }) => {
      const observed = assertPendingNavigation(manager, navigation);
      expect(observed.mock.calls.map(([message]) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "toolResult",
        "toolResult",
      ]);
      expect(SessionManager.open(target).getEntries()).toEqual(manager.getEntries());
      expect(loadTranscriptReadSnapshotSync(target).events).toEqual(manager.getPersistedEntries());
    });
  }
});

it.each(
  (["branch", "resetLeaf"] as const).flatMap((navigation) =>
    (["detached", "native"] as const).flatMap((mode) =>
      (["user", "flush"] as const).map((boundary) => ({ navigation, mode, boundary })),
    ),
  ),
)(
  "retains inactive pending custody with disabled synthesis after $navigation/$boundary on $mode",
  async ({ navigation, mode, boundary }) => {
    if (mode === "detached") {
      assertPendingDiscardNavigation(SessionManager.inMemory(), navigation, boundary);
      return;
    }
    await withNativeMessages(({ manager, target }) => {
      assertPendingDiscardNavigation(manager, navigation, boundary);
      expect(SessionManager.open(target).getEntries()).toEqual(manager.getEntries());
      expect(loadTranscriptReadSnapshotSync(target).events).toEqual(manager.getPersistedEntries());
    });
  },
);

it.each([
  { navigation: "branch", outcome: "commit" },
  { navigation: "resetLeaf", outcome: "commit" },
  { navigation: "resetLeaf", outcome: "rollback" },
  { navigation: "branch", outcome: "cohort-conflict" },
] as const)(
  "joins native pending retirement with disabled synthesis to $outcome after $navigation",
  async ({ navigation, outcome }) => {
    await withNativeMessages(({ manager, target, database }) => {
      const observed = vi.fn();
      const guard = installSessionToolResultGuard(manager, {
        allowSyntheticToolResults: false,
        onMessagePersisted: observed,
      });
      const root = manager.getLeafId()!;
      const originalEntry = manager.appendMessage(nativeCalls("first", "second"));
      const { pending, owner } = manager[sessionToolResultPending];
      const original = pending.calls(owner);
      if (navigation === "branch") {
        manager.branch(root);
      } else {
        manager.resetLeaf();
      }
      const before = { view: nativeView(manager), sql: loadTranscriptReadSnapshotSync(target) };
      observed.mockClear();
      const failure = new Error("rollback policy-only retirement");
      let childId: string | undefined;
      let reached = false;
      let caught: unknown;
      try {
        manager.appendMessage(
          { role: "user", content: "parent boundary", timestamp: 2 },
          {
            beforeFreshMessageCommit: () => {
              expect(database.db.isTransaction).toBe(true);
              if (outcome === "cohort-conflict") {
                manager.branch(originalEntry);
                guard.flushPendingToolResults();
                expect(pending.calls(owner)).toEqual([]);
                reached = true;
                return;
              }
              childId = manager.appendMessage(nativeCalls("tentative"));
              guard.flushPendingToolResults();
              expect(pending.calls(owner)).toEqual(original);
              original.forEach((call, index) => expect(pending.calls(owner)[index]).toBe(call));
              expect(observed).not.toHaveBeenCalled();
              reached = true;
              if (outcome === "rollback") {
                throw failure;
              }
            },
          },
        );
      } catch (error) {
        caught = error;
      }
      if (outcome === "cohort-conflict") {
        expect(caught).toBeInstanceOf(SessionToolResultPendingConflictError);
      } else {
        expect(caught).toBe(outcome === "rollback" ? failure : undefined);
      }
      expect(reached).toBe(true);
      if (outcome !== "commit") {
        expect(nativeView(manager)).toEqual(before.view);
        expect(loadTranscriptReadSnapshotSync(target)).toEqual(before.sql);
        expect(pending.calls(owner)).toEqual(original);
        original.forEach((call, index) => expect(pending.calls(owner)[index]).toBe(call));
        if (childId) {
          expect(manager.getEntry(childId)).toBeUndefined();
        }
        expect(observed).not.toHaveBeenCalled();
      } else {
        expect(pending.calls(owner)).toEqual(original);
        original.forEach((call, index) => expect(pending.calls(owner)[index]).toBe(call));
        expect(manager.getEntry(childId!)).toMatchObject({ type: "message" });
        expect(observed.mock.calls.map(([message]) => message.role)).toEqual(["assistant", "user"]);
      }
      expect(
        manager
          .getEntries()
          .filter((entry) => entry.type === "message" && entry.message.role === "toolResult"),
      ).toEqual([]);
      expect(SessionManager.open(target).getEntries()).toEqual(manager.getEntries());
    });
  },
);

it("preserves pending tool growth from a native fresh-message callback", async () => {
  await withOpenClawTestState({ label: "native-pending-growth" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "native-pending-growth",
      sessionKey: "agent:main:native-pending-growth",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      env: state.env,
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(target);
    const observed = vi.fn();
    const guard = installSessionToolResultGuard(manager, { onMessagePersisted: observed });
    const opening = { role: "user" as const, content: "opening", timestamp: 1 };
    const parent = { role: "user" as const, content: "parent", timestamp: 2 };
    const child = assistant();
    manager.appendMessage(opening);
    observed.mockClear();
    const database = openOpenClawAgentDatabase({
      agentId: target.agentId,
      path: target.storePath,
      env: state.env,
    });
    expect(database.db.isTransaction).toBe(false);
    const { pending, owner } = manager[sessionToolResultPending];
    let childId: string | undefined;
    const fresh = vi.fn(() => {
      expect(database.db.isTransaction).toBe(true);
      childId = manager.appendMessage(child);
      expect(guard.getPendingIds()).toEqual(["shared"]);
      expect(observed).not.toHaveBeenCalled();
    });
    const parentId = manager.appendMessage(parent, { beforeFreshMessageCommit: fresh });
    expect(database.db.isTransaction).toBe(false);
    expect(fresh).toHaveBeenCalledOnce();
    expect(observed.mock.calls.map(([message]) => message)).toEqual([child, parent]);
    expect(pending.capture(owner).facts).toEqual([
      { token: 0, originId: childId, callIndex: 0, id: "shared", name: "read", responseIds: [] },
    ]);
    expect(manager.getEntry(parentId)).toMatchObject({ message: parent });
    expect(SessionManager.open(target).getEntries()).toEqual(manager.getEntries());
    expect(loadTranscriptReadSnapshotSync(target).events).toEqual(
      expect.arrayContaining(
        [opening, child, parent].map((message) => expect.objectContaining({ message })),
      ),
    );
    const reply = result();
    manager.appendMessage(reply);
    expect(guard.getPendingIds()).toEqual([]);
    expect(observed.mock.calls.map(([message]) => message)).toEqual([child, parent, reply]);
    expect(SessionManager.open(target).getEntries()).toEqual(manager.getEntries());
  });
});

it("restores the native manager view when a fresh-message child rolls back with its parent", async () => {
  await withNativeMessages(({ manager, target, database }) => {
    const observed = vi.fn();
    const guard = installSessionToolResultGuard(manager, { onMessagePersisted: observed });
    manager.appendMessage(nativeCalls("first", "second"));
    observed.mockClear();
    const { pending, owner } = manager[sessionToolResultPending];
    const original = pending.calls(owner);
    const before = { view: nativeView(manager), sql: loadTranscriptReadSnapshotSync(target) };
    const failure = new Error("abort the original native parent");
    let childId: string | undefined;
    let witness:
      | {
          transaction: boolean;
          calls: ReturnType<typeof pending.calls>;
          view: ReturnType<typeof nativeView>;
        }
      | undefined;
    let reset: ReturnType<typeof nativeView> | undefined;
    let sentinelReached = false;
    let caught: unknown;
    try {
      manager.appendMessage(nativeCalls("parent"), {
        beforeFreshMessageCommit: () => {
          const transaction = database.db.isTransaction;
          childId = manager.appendMessage(nativeCalls("child"));
          witness = { transaction, calls: pending.calls(owner), view: nativeView(manager) };
          manager.resetLeaf();
          expect(guard.getPendingIds()).toEqual([]);
          reset = nativeView(manager);
          sentinelReached = true;
          throw failure;
        },
      });
    } catch (error) {
      caught = error;
    }
    const after = {
      view: nativeView(manager),
      sql: loadTranscriptReadSnapshotSync(target),
      calls: pending.calls(owner),
    };
    expect(caught).toBe(failure);
    expect(sentinelReached).toBe(true);
    expect(witness?.transaction).toBe(true);
    expect(witness?.view.entries.some((entry) => entry.id === childId)).toBe(true);
    expect(witness?.calls.map((call) => call.id)).toEqual(["first", "second", "child"]);
    expect(reset).toMatchObject({ leaf: null, parent: null });
    expect(after.view).toEqual(before.view);
    expect(after.sql).toEqual(before.sql);
    expect(after.calls).toHaveLength(original.length);
    after.calls.forEach((call, index) => expect(call).toBe(original[index]));
    expect(guard.getPendingIds()).toEqual(["first", "second"]);
    expect(manager.getEntry(childId!)).toBeUndefined();
    expect(manager).toMatchObject({
      transcriptVersion: before.sql.version,
      transcriptMutationAt: before.sql.version.updatedAt,
    });
    expect(observed).not.toHaveBeenCalled();
    expect(database.db.isTransaction).toBe(false);
    expect(() => manager.prepareTranscriptRewrite()).not.toThrow();
    manager.appendMessage({ ...result(), toolCallId: "first" });
    expect(guard.getPendingIds()).toEqual(["second"]);
    expect(pending.calls(owner)[0]).toBe(original[1]);
    expect(SessionManager.open(target).getEntries()).toEqual(manager.getEntries());
  });
});

it("keeps the native parent writable after a caught child view rollback", async () => {
  await withNativeMessages(({ manager, target, database }) => {
    const observed = vi.fn();
    const guard = installSessionToolResultGuard(manager, { onMessagePersisted: observed });
    const failure = new Error("caught child failure");
    const before = nativeView(manager);
    let childId: string | undefined;
    let caught: unknown;
    let restored: ReturnType<typeof nativeView> | undefined;
    let parentStillInTransaction = false;
    const parent = { role: "user" as const, content: "surviving parent", timestamp: 2 };
    const parentId = manager.appendMessage(parent, {
      beforeFreshMessageCommit: () => {
        try {
          manager.appendMessage(nativeCalls("failed-parent"), {
            beforeFreshMessageCommit: () => {
              childId = manager.appendMessage(nativeCalls("failed-child"));
              manager.resetLeaf();
              throw failure;
            },
          });
        } catch (error) {
          caught = error;
        }
        restored = nativeView(manager);
        parentStillInTransaction = database.db.isTransaction;
      },
    });
    expect(caught).toBe(failure);
    expect(parentStillInTransaction).toBe(true);
    expect(restored).toEqual(before);
    expect(manager.getEntry(childId!)).toBeUndefined();
    expect(manager.getEntry(parentId)).toMatchObject({ message: parent });
    expect(guard.getPendingIds()).toEqual([]);
    expect(observed.mock.calls.map(([message]) => message)).toEqual([parent]);
    expect(loadTranscriptReadSnapshotSync(target).events).toEqual(manager.getPersistedEntries());
    expect(SessionManager.open(target).getEntries()).toEqual(manager.getEntries());
    expect(() => manager.prepareTranscriptRewrite()).not.toThrow();
  });
});

it.each(["same", "different"] as const)(
  "preserves a public %s-target replacement when native adoption is refused",
  async (kind) => {
    await withNativeMessages(({ manager, target, database }) => {
      const replacement =
        kind === "same"
          ? target
          : { ...target, sessionId: "replacement", sessionKey: "agent:main:replacement" };
      const other = SessionManager.open(replacement);
      if (kind === "same") {
        other.appendMessage({
          ...assistant(),
          content: [{ type: "text", text: "newer committed row" }],
        });
      } else {
        other.appendMessage({ role: "user", content: "replacement view", timestamp: 2 });
      }
      const before = loadTranscriptReadSnapshotSync(target);
      const committedReplacement = nativeView(other);
      const observed = vi.fn();
      installSessionToolResultGuard(manager, { onMessagePersisted: observed });
      const pending = manager[sessionToolResultPending].pending;
      const originalCalls = pending.calls(manager[sessionToolResultPending].owner);
      let childId: string | undefined;
      let replacementView: ReturnType<typeof nativeView> | undefined;
      let entered = false;
      let caught: unknown;
      try {
        manager.appendMessage(
          { role: "user", content: "refused parent", timestamp: 3 },
          {
            beforeFreshMessageCommit: () => {
              entered = database.db.isTransaction;
              childId = manager.appendMessage(nativeCalls("refused-child"));
              manager.setSessionTarget(replacement);
              replacementView = nativeView(manager);
            },
          },
        );
      } catch (error) {
        caught = error;
      }
      expect(entered).toBe(true);
      expect(caught).toMatchObject({ name: "SessionTranscriptWriterClaimReboundError" });
      expect(replacementView?.entries.some((entry) => entry.id === childId)).toBe(kind === "same");
      expect(nativeView(manager)).toEqual(committedReplacement);
      expect(manager.getEntry(childId!)).toBeUndefined();
      expect(loadTranscriptReadSnapshotSync(target)).toEqual(before);
      expect(pending.calls(manager[sessionToolResultPending].owner)).toEqual(originalCalls);
      expect(observed).not.toHaveBeenCalled();
      expect(database.db.isTransaction).toBe(false);
      expect(SessionManager.open(replacement).getEntries()).toEqual(manager.getEntries());
      expect(() => manager.prepareTranscriptRewrite()).not.toThrow();
      manager.appendMessage({ role: "user", content: "following replacement", timestamp: 4 });
      expect(SessionManager.open(replacement).getEntries()).toEqual(manager.getEntries());
    });
  },
);

it("preserves canonical public hydration after a same-version local branch aborts", async () => {
  await withNativeMessages(({ manager, target }) => {
    const branch = manager.getLeafId()!;
    manager.appendMessage({ ...assistant(), content: [{ type: "text", text: "committed tail" }] });
    const canonical = nativeView(manager);
    const sql = loadTranscriptReadSnapshotSync(target);
    manager.branch(branch);
    expect(manager.getLeafId()).toBe(branch);
    expect(() =>
      manager.appendMessage(nativeCalls("refused"), {
        beforeFreshMessageCommit: () => manager.setSessionTarget(target),
      }),
    ).toThrow(expect.objectContaining({ name: "SessionTranscriptWriterClaimReboundError" }));
    expect(nativeView(manager)).toEqual(canonical);
    expect(loadTranscriptReadSnapshotSync(target)).toEqual(sql);
    expect(() => manager.prepareTranscriptRewrite()).not.toThrow();
  });
});

it("restores the independent replacement after returning to a tentative native target", async () => {
  await withNativeMessages(({ manager, target, database }) => {
    const replacement = {
      ...target,
      sessionId: "independent",
      sessionKey: "agent:main:independent",
    };
    const other = SessionManager.open(replacement);
    other.appendMessage({ role: "user", content: "independent committed view", timestamp: 2 });
    const before = {
      source: loadTranscriptReadSnapshotSync(target),
      replacement: nativeView(other),
    };
    const observed = vi.fn();
    installSessionToolResultGuard(manager, { onMessagePersisted: observed });
    let child: string | undefined;
    let returnedView: ReturnType<typeof nativeView> | undefined;
    expect(() =>
      manager.appendMessage(
        { role: "user", content: "refused", timestamp: 3 },
        {
          beforeFreshMessageCommit: () => {
            child = manager.appendMessage(nativeCalls("child"));
            manager.setSessionTarget(replacement);
            manager.setSessionTarget(target);
            returnedView = nativeView(manager);
          },
        },
      ),
    ).toThrow(expect.objectContaining({ name: "SessionTranscriptWriterClaimReboundError" }));
    expect(returnedView?.entries.some((entry) => entry.id === child)).toBe(true);
    expect(nativeView(manager)).toEqual(before.replacement);
    expect(loadTranscriptReadSnapshotSync(target)).toEqual(before.source);
    expect(manager[sessionToolResultPending].pending.ids()).toEqual([]);
    expect(observed).not.toHaveBeenCalled();
    expect(database.db.isTransaction).toBe(false);
    expect(() => manager.prepareTranscriptRewrite()).not.toThrow();
    manager.appendMessage({ role: "user", content: "following independent", timestamp: 4 });
    expect(SessionManager.open(replacement).getEntries()).toEqual(manager.getEntries());
  });
});

it.each([false, true])(
  "restores a lazy replacement target after native rollback (caught child failure: %s)",
  async (failChild) => {
    await withNativeMessages(({ manager, target, database }) => {
      const replacement = { ...target, sessionId: "lazy", sessionKey: "agent:main:lazy" };
      const beforeSource = loadTranscriptReadSnapshotSync(target);
      const beforeReplacement = loadTranscriptReadSnapshotSync(replacement);
      const observed = vi.fn();
      installSessionToolResultGuard(manager, { onMessagePersisted: observed });
      let beforeChild: ReturnType<typeof nativeView> | undefined;
      let hydrated: ReturnType<typeof nativeView> | undefined;
      let child: string | undefined;
      const failure = new Error("caught replacement message failure after initialization");
      let childError: unknown;
      let released:
        | {
            transaction: boolean;
            sql: ReturnType<typeof loadTranscriptReadSnapshotSync>;
            view: ReturnType<typeof nativeView>;
          }
        | undefined;
      let afterChild:
        | {
            sql: ReturnType<typeof loadTranscriptReadSnapshotSync>;
            view: ReturnType<typeof nativeView>;
          }
        | undefined;
      expect(() =>
        manager.appendMessage(
          { role: "user", content: "refused", timestamp: 3 },
          {
            beforeFreshMessageCommit: () => {
              manager.setSessionTarget(replacement);
              beforeChild = nativeView(manager);
              try {
                child = manager.appendMessage(
                  nativeCalls("replacement-child"),
                  failChild
                    ? {
                        beforeFreshMessageCommit: () => {
                          released = {
                            transaction: database.db.isTransaction,
                            sql: loadTranscriptReadSnapshotSync(replacement),
                            view: nativeView(manager),
                          };
                          throw failure;
                        },
                      }
                    : undefined,
                );
              } catch (error) {
                childError = error;
              }
              afterChild = {
                sql: loadTranscriptReadSnapshotSync(replacement),
                view: nativeView(manager),
              };
              manager.setSessionTarget(replacement);
              hydrated = nativeView(manager);
            },
          },
        ),
      ).toThrow(expect.objectContaining({ name: "SessionTranscriptWriterClaimReboundError" }));
      const after = {
        view: nativeView(manager),
        source: loadTranscriptReadSnapshotSync(target),
        replacement: loadTranscriptReadSnapshotSync(replacement),
      };
      if (failChild) {
        expect(childError).toBe(failure);
        expect(released?.transaction).toBe(true);
        expect(released?.sql.events).toEqual([beforeChild?.header]);
        expect(afterChild?.sql).toEqual(released?.sql);
        expect(afterChild?.view).toEqual(released?.view);
        expect(hydrated?.entries).toEqual([]);
      } else {
        expect(childError).toBeUndefined();
        expect(hydrated?.entries.some((entry) => entry.id === child)).toBe(true);
      }
      expect(beforeChild?.entries).toEqual([]);
      expect(after.view).toEqual(beforeChild);
      expect(after.source).toEqual(beforeSource);
      expect(after.replacement).toEqual(beforeReplacement);
      expect(manager[sessionToolResultPending].pending.ids()).toEqual([]);
      expect(observed).not.toHaveBeenCalled();
      expect(database.db.isTransaction).toBe(false);
      expect(() => manager.prepareTranscriptRewrite()).not.toThrow();
      manager.appendMessage({
        role: "user",
        content: "initial committed replacement",
        timestamp: 4,
      });
      expect(SessionManager.open(replacement).getEntries()).toEqual(manager.getEntries());
    });
  },
);

it("keeps a retained native before-image immutable after caught hydration refusal", async () => {
  await withNativeMessages(({ manager, target, database }) => {
    const replacement = { ...target, sessionId: "retained", sessionKey: "agent:main:retained" };
    const other = SessionManager.open(replacement);
    other.appendMessage({ role: "user", content: "committed replacement", timestamp: 2 });
    const before = {
      source: loadTranscriptReadSnapshotSync(target),
      replacement: loadTranscriptReadSnapshotSync(replacement),
      view: nativeView(other),
    };
    const observed = vi.fn();
    installSessionToolResultGuard(manager, { onMessagePersisted: observed });
    let childError: unknown;
    let parentError: unknown;
    let restored: ReturnType<typeof nativeView> | undefined;
    let laterId: string | undefined;
    let adopted:
      | {
          transaction: boolean;
          view: ReturnType<typeof nativeView>;
          sql: ReturnType<typeof loadTranscriptReadSnapshotSync>;
          pending: string[];
        }
      | undefined;
    try {
      manager.appendMessage(
        { role: "user", content: "refused original parent", timestamp: 3 },
        {
          beforeFreshMessageCommit: () => {
            manager.setSessionTarget(replacement);
            try {
              manager.appendMessage(nativeCalls("refused-child"), {
                beforeFreshMessageCommit: () => manager.setSessionTarget(replacement),
              });
            } catch (error) {
              childError = error;
            }
            restored = nativeView(manager);
            laterId = manager.appendMessage(nativeCalls("later-child"));
            adopted = {
              transaction: database.db.isTransaction,
              view: nativeView(manager),
              sql: loadTranscriptReadSnapshotSync(replacement),
              pending: manager[sessionToolResultPending].pending.ids(),
            };
          },
        },
      );
    } catch (error) {
      parentError = error;
    }
    const after = {
      source: loadTranscriptReadSnapshotSync(target),
      replacement: loadTranscriptReadSnapshotSync(replacement),
      view: nativeView(manager),
    };
    expect(childError).toMatchObject({ name: "SessionTranscriptWriterClaimReboundError" });
    expect(parentError).toMatchObject({ name: "SessionTranscriptWriterClaimReboundError" });
    expect(parentError).not.toBe(childError);
    expect(restored).toEqual(before.view);
    expect(laterId).toBeDefined();
    expect(adopted?.transaction).toBe(true);
    expect(adopted?.view.entries.some((entry) => entry.id === laterId)).toBe(true);
    expect(adopted?.sql.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: laterId })]),
    );
    expect(adopted?.pending).toEqual(["later-child"]);
    expect(after).toEqual(before);
    expect(manager.getEntry(laterId!)).toBeUndefined();
    expect(manager[sessionToolResultPending].pending.ids()).toEqual([]);
    expect(observed).not.toHaveBeenCalled();
    expect(database.db.isTransaction).toBe(false);
    expect(() => manager.prepareTranscriptRewrite()).not.toThrow();
    manager.appendMessage({ role: "user", content: "following replacement", timestamp: 4 });
    expect(SessionManager.open(replacement).getEntries()).toEqual(manager.getEntries());
  });
});

it("keeps a native parent current through a descendant canonical reload", async () => {
  await withNativeMessages(({ manager, target, database }) => {
    const observed: unknown[] = [];
    installSessionToolResultGuard(manager, {
      onMessagePersisted: (message) => {
        observed.push(message);
      },
    });
    const child = nativeCalls("child");
    const grandchild = nativeCalls("grandchild");
    const parent = { role: "user" as const, content: "parent", timestamp: 2 };
    let childId: string | undefined;
    let grandchildId: string | undefined;
    let inside: ReturnType<typeof nativeView> | undefined;
    const childFresh = vi.fn(() => {
      grandchildId = manager.appendMessage(grandchild);
    });
    const parentFresh = vi.fn(() => {
      childId = manager.appendMessage(child, { beforeFreshMessageCommit: childFresh });
      inside = nativeView(manager);
      expect(database.db.isTransaction).toBe(true);
      expect(observed).toEqual([]);
    });
    const parentId = manager.appendMessage(parent, { beforeFreshMessageCommit: parentFresh });
    expect(parentFresh).toHaveBeenCalledOnce();
    expect(childFresh).toHaveBeenCalledOnce();
    expect(inside?.entries.find((entry) => entry.id === childId)?.parentId).toBe(grandchildId);
    expect(manager.getEntry(parentId)).toMatchObject({ message: parent });
    expect(observed).toEqual([grandchild, child, parent]);
    expect(manager[sessionToolResultPending].pending.ids()).toEqual(["grandchild", "child"]);
    expect(SessionManager.open(target).getEntries()).toEqual(manager.getEntries());
    expect(loadTranscriptReadSnapshotSync(target).events).toEqual(manager.getPersistedEntries());
  });
});

it("does not retry a native message after a real fixed COMMIT owner throws a conflict", async () => {
  await withNativeMessages(({ manager, target, database }) => {
    const failure = new SqliteTranscriptMutationConflictError(target.sessionId);
    const observed = vi.fn();
    installSessionToolResultGuard(manager, { onMessagePersisted: observed });
    const fixed = {
      stage: vi.fn(),
      commit: vi.fn(() => {
        throw failure;
      }),
      rollback: vi.fn(),
    };
    const fresh = vi.fn(() => {
      expect(stageSqliteTransactionState(database.db, fixed)).toBe(true);
    });
    const message = nativeCalls("committed");
    expect(() => manager.appendMessage(message, { beforeFreshMessageCommit: fresh })).toThrow(
      failure,
    );
    expect(fresh).toHaveBeenCalledOnce();
    expect(fixed.commit).toHaveBeenCalledOnce();
    expect(fixed.rollback).not.toHaveBeenCalled();
    expect(database.db.isTransaction).toBe(false);
    expect(
      manager
        .getEntries()
        .filter(
          (entry) =>
            entry.type === "message" && JSON.stringify(entry.message) === JSON.stringify(message),
        ),
    ).toHaveLength(1);
    expect(manager[sessionToolResultPending].pending.ids()).toEqual(["committed"]);
    expect(observed).not.toHaveBeenCalled();
    expect(SessionManager.open(target).getEntries()).toEqual(manager.getEntries());
    expect(loadTranscriptReadSnapshotSync(target).events).toEqual(manager.getPersistedEntries());
  });
});

it.each(["Error", "undefined", "mutation conflict"] as const)(
  "publishes native child observers after adoption without replay (%s)",
  async (kind) => {
    await withNativeMessages(({ manager, target, database }) => {
      const failure =
        kind === "Error"
          ? new Error("native child observer failed")
          : kind === "mutation conflict"
            ? new SqliteTranscriptMutationConflictError(target.sessionId)
            : undefined;
      const child = nativeCalls("child");
      const parent = { role: "user" as const, content: "committed parent", timestamp: 2 };
      const observed: unknown[] = [];
      let atObserver:
        | {
            transaction: boolean;
            view: ReturnType<typeof nativeView>;
            sql: ReturnType<typeof loadTranscriptReadSnapshotSync>;
          }
        | undefined;
      const guard = installSessionToolResultGuard(manager, {
        onMessagePersisted(message) {
          observed.push(message);
          atObserver = {
            transaction: database.db.isTransaction,
            view: nativeView(manager),
            sql: loadTranscriptReadSnapshotSync(target),
          };
          // oxlint-disable-next-line typescript/only-throw-error -- The post-adoption observer deliberately throws its original Error or raw undefined.
          throw failure;
        },
      });
      let childId: string | undefined;
      let insideObserved: number | undefined;
      const fresh = vi.fn(() => {
        childId = manager.appendMessage(child);
        insideObserved = observed.length;
      });
      let caught: { error: unknown } | undefined;
      try {
        manager.appendMessage(parent, { beforeFreshMessageCommit: fresh });
      } catch (error) {
        caught = { error };
      }
      expect(caught).toBeDefined();
      expect(caught?.error).toBe(failure);
      expect(fresh).toHaveBeenCalledOnce();
      expect(insideObserved).toBe(0);
      expect(observed).toEqual([child]);
      expect(atObserver?.transaction).toBe(false);
      expect(atObserver?.view).toEqual(nativeView(manager));
      expect(atObserver?.sql).toEqual(loadTranscriptReadSnapshotSync(target));
      for (const message of [child, parent]) {
        expect(
          manager
            .getEntries()
            .filter(
              (entry) =>
                entry.type === "message" &&
                JSON.stringify(entry.message) === JSON.stringify(message),
            ),
        ).toHaveLength(1);
      }
      expect(guard.getPendingIds()).toEqual(["child"]);
      expect(
        manager[sessionToolResultPending].pending.calls(manager[sessionToolResultPending].owner)[0],
      ).toMatchObject({ originId: childId });
      expect(SessionManager.open(target).getEntries()).toEqual(manager.getEntries());
      expect(observed).toEqual([child]);
    });
  },
);

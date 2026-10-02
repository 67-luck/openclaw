import { afterEach, assert, expect, it, vi } from "vitest";
import { installSessionToolResultGuard } from "../../agents/session-tool-result-guard.js";
import { createSessionToolResultPending } from "../../agents/session-tool-result-pending.js";
import { createSessionManagerMessageRuntime } from "../../agents/sessions/session-manager-message-runtime.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { createSessionMembershipProjection } from "../../gateway/session-membership-projection.js";
import { openSqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import type { FixtureOperations } from "../../infra/sqlite-worker-store.test-support.js";
import { patchSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import {
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import {
  captureOpenClawAgentHostExecution,
  runOpenClawAgentWriteAdmission,
} from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readCommittedSessionEntryCache,
  readSessionEntryCache,
  retainPreparedSessionSharingFacts,
  retainSessionEntryWorkerPublication,
  projectSessionSharingEntry,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { readCommittedIncognitoSessionSharing } from "./session-accessor.sqlite-incognito-sharing.js";
import {
  applySessionEntryCanonicalReplacements,
  applySessionEntryExactReplacements,
} from "./session-accessor.sqlite-replacement-projection.js";
import { withMixedSessionOwners } from "./session-accessor.sqlite-replacement-publication.test-support.js";
import { prepareSessionDeliveryGeneration } from "./session-delivery-generation.js";
import { captureSessionEntryCurrentRead } from "./session-entry-current-runtime.js";
import { withSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import { addSessionMember } from "./session-sharing-store.native.js";
import type { InternalSessionEntry } from "./types.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 1,
}));

// The canonical executor still owns real SQL, admission, and settlement; only reply delivery changes.
const delivery = vi.hoisted(() => ({
  afterResult: undefined as (() => void | Promise<void>) | undefined,
  releaseFailure: undefined as Error | undefined,
}));
vi.mock("../../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-execution.js")>();
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ): ReturnType<typeof actual.captureOpenClawAgentDatabaseExecution> => {
      const owned = actual.captureOpenClawAgentDatabaseExecution(...args);
      return {
        ...owned,
        runExisting: (source, operation, options) => {
          return owned.runExisting(
            source,
            (scope) =>
              operation({
                execute: async (command, commandOptions) => {
                  const result = await scope.execute(command, commandOptions);
                  if (command.type === "session.entries.replace") {
                    await delivery.afterResult?.();
                  }
                  return result;
                },
              }),
            options,
          );
        },
        release: async () => {
          await owned.release();
          if (delivery.releaseFailure) {
            throw delivery.releaseFailure;
          }
        },
      };
    },
  };
});

afterEach(() => {
  delivery.afterResult = undefined;
  delivery.releaseFailure = undefined;
});

it("fences a delivery generation during native writes and restores it only on rollback", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const options = { agentId: "main", path: database.path };
    const sessionKey = "agent:main:native-generation-publication";
    const original = {
      sessionId: "native-generation",
      lifecycleRevision: "original-generation",
      updatedAt: 1,
    };
    writeSessionEntry(database, sessionKey, original);
    const originalRow = readExactSessionEntryRow(database, sessionKey);
    expect(originalRow).toBeDefined();
    const generation = await prepareSessionDeliveryGeneration({
      agentId: options.agentId,
      storePath: database.path,
      sessionKey,
      sessionId: original.sessionId,
      lifecycleRevision: original.lifecycleRevision,
    });
    const rollback = new Error("roll back staged generation");
    try {
      generation.assertCurrent();
      expect(() =>
        runOpenClawAgentWriteTransaction((writer) => {
          writeSessionEntry(writer, sessionKey, {
            ...original,
            lifecycleRevision: "uncommitted-generation",
            updatedAt: 2,
          });
          expect(writer.db.isTransaction).toBe(true);
          expect(readExactSessionEntryRow(writer, sessionKey)?.entry.lifecycleRevision).toBe(
            "uncommitted-generation",
          );
          expect(generation.assertCurrent).toThrow(
            expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
          );
          throw rollback;
        }, options),
      ).toThrow(rollback);
      expect(database.db.isTransaction).toBe(false);
      expect(readExactSessionEntryRow(database, sessionKey)).toEqual(originalRow);
      generation.assertCurrent();

      runOpenClawAgentWriteTransaction((writer) => {
        writeSessionEntry(writer, sessionKey, {
          ...original,
          lifecycleRevision: "committed-replacement",
          updatedAt: 3,
        });
      }, options);
      expect(readExactSessionEntryRow(database, sessionKey)?.entry.lifecycleRevision).toBe(
        "committed-replacement",
      );
      // Restoring the old values cannot restore a generation already replaced at COMMIT.
      runOpenClawAgentWriteTransaction((writer) => {
        writeSessionEntry(writer, sessionKey, original);
      }, options);
      expect(generation.assertCurrent).toThrow(
        expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_REVOKED" }),
      );
    } finally {
      generation.release();
    }
  });
});

const nodeIt = process.versions.bun ? it.skip : it;

nodeIt.each(["durable", "Gateway", "completed updater"] as const)(
  "keeps native SDK reads and durable message receipt ordering with %s first at minimum capacity",
  async (first) => {
    await withMixedSessionOwners(
      first,
      async ({ durable, manager, target, scope, hostPosts, nativePosts, readEntry }) => {
        const before = manager.getEntries();
        const leaf = manager.getLeafId();
        const events: string[] = [];
        const queuedPath = `${scope.storePath}.queued.sqlite`;
        const queuedStore = await openSqliteWorkerStore<FixtureOperations>({
          moduleUrl: new URL("../../infra/sqlite-worker-store.test-support.ts", import.meta.url),
          databasePath: queuedPath,
          input: undefined,
        });
        let follower: Promise<unknown> | undefined;
        let queuedActor: number | undefined;
        let receiptAtNs: bigint | undefined;
        let execution: ReturnType<typeof captureOpenClawAgentDatabaseExecution> | undefined;
        let runtime: ReturnType<typeof createSessionManagerMessageRuntime> | undefined;
        const followerPosts = () =>
          hostPosts.filter((post) => post.actor === queuedActor && post.type === "execute");
        const committed = vi.fn(() => {
          receiptAtNs = process.hrtime.bigint();
          events.push("A receipt");
        });
        const read = vi.fn(() =>
          SessionManager.readSessionContext(target, (messages) => {
            events.push("B callback");
            const cursor = messages[Symbol.iterator]();
            expect(cursor.next()).toMatchObject({ done: false, value: { content: "only B" } });
            expect(cursor.next()).toEqual({ done: true, value: undefined });
            expect(events).toEqual(["A callback", "B callback"]);
            expect(followerPosts()).toEqual([]);
            return "B-only result";
          }),
        );
        const predicate = vi.fn(() => {
          events.push("A callback");
          follower = queuedStore.execute({ type: "read", input: undefined }).then((value) => {
            events.push("queued follower");
            expect(value).toEqual([]);
          });
          expect(read()).toBe("B-only result");
          events.push("B returned");
        });
        try {
          const opens = hostPosts.filter(
            (post) => post.type === "open" && post.databasePath === queuedPath,
          );
          expect(opens).toHaveLength(1);
          queuedActor = opens[0]!.actor;
          const sdkRead = vi.fn(() =>
            SessionManager.readSessionContext(target, (messages) => [...messages]),
          );
          const sdkPredicate = vi.fn(() => {
            expect(sdkRead()).toMatchObject([{ content: "only B" }]);
          });
          // Durable SDK patches keep their native owner. The separate message
          // runtime below owns the worker receipt and queued-follower ordering.
          await expect(
            patchSessionEntry({
              ...scope,
              skipMaintenance: true,
              update: () => ({ label: "patched through public SDK" }),
              assertCommitAllowed: sdkPredicate,
            }),
          ).resolves.toMatchObject({ label: "patched through public SDK" });
          expect(sdkPredicate).toHaveBeenCalledOnce();
          expect(sdkRead).toHaveBeenCalledOnce();
          expect(readEntry()?.entry.label).toBe("patched through public SDK");
          expect(manager.getEntries()).toEqual(before);
          expect(manager.getLeafId()).toBe(leaf);
          const appendScope = {
            ...scope,
            sessionId: durable.getSessionId(),
            env: target.env,
          };
          const options = {
            agentId: scope.agentId,
            path: scope.storePath,
            env: target.env,
          };
          const pending = createSessionToolResultPending();
          const adopt = vi.fn();
          const publish = vi.fn();
          const publishCommit = vi.fn();
          const outcome = await runOpenClawAgentWriteAdmission(options, async () => {
            const retained = captureOpenClawAgentDatabaseExecution(options);
            execution = retained;
            const assertCurrent = () => retained.assertCurrent();
            runtime = createSessionManagerMessageRuntime({
              execution: retained,
              scope: appendScope,
              pending,
              assertCurrent,
              commit: committed,
              publishCommit,
            });
            return runtime.append(
              {
                cwd: durable.getCwd(),
                message: { role: "user", content: "A ordered append", timestamp: 3 },
              },
              { beforeFreshMessageCommit: predicate },
              { adopt, publish, assertCurrent, host: captureOpenClawAgentHostExecution(options) },
            );
          });
          expect(outcome).toMatchObject({ kind: "committed", failures: [] });
          await follower;
          expect(committed).toHaveBeenCalledOnce();
          expect(adopt).toHaveBeenCalledOnce();
          expect(publish).toHaveBeenCalledOnce();
          expect(publishCommit).toHaveBeenCalledOnce();
          expect(pending.size).toBe(0);
          expect(receiptAtNs).toBeTypeOf("bigint");
          const requested = followerPosts();
          expect(requested).toHaveLength(1);
          const request = requested[0]!;
          const dispatched = nativePosts.filter(
            (post) => post.id === request.id && post.actor === request.actor,
          );
          expect(dispatched).toHaveLength(1);
          // The service's native-post timestamp cannot be hidden by deferred Promise observers.
          expect(request.atNs).toBeGreaterThanOrEqual(receiptAtNs!);
          expect(dispatched[0]!.atNs).toBeGreaterThanOrEqual(request.atNs);
          expect(events).toEqual([
            "A callback",
            "B callback",
            "B returned",
            "A receipt",
            "queued follower",
          ]);
          expect(predicate).toHaveBeenCalledOnce();
          expect(read).toHaveBeenCalledOnce();
          expect(readEntry()?.entry.label).toBe("patched through public SDK");
          expect(
            SessionManager.readSessionContext(appendScope, (messages) => [...messages]),
          ).toContainEqual(expect.objectContaining({ content: "A ordered append" }));
          expect(manager.getEntries()).toEqual(before);
          expect(manager.getLeafId()).toBe(leaf);
          assert(outcome.kind === "committed");
          const committedUserId = outcome.facts.receipt.messageId;
          expect(durable.getLeafId()).not.toBe(committedUserId);
          // The independent runtime committed a new user turn without adopting this view.
          // Reload before preparing the retained manager's next assistant for that turn.
          await durable.reloadPersistedTranscriptAsync();
          expect(durable.getLeafId()).toBe(committedUserId);
          await durable.appendMessageAsync(
            makeAgentAssistantMessage({
              content: [{ type: "text", text: "same retained durable manager" }],
            }),
          );
          expect(
            SessionManager.readSessionContext(target, (messages) => [...messages]),
          ).toMatchObject([{ content: "only B" }]);
        } finally {
          try {
            if (runtime) {
              await runtime.close();
            } else {
              await execution?.release();
            }
          } finally {
            try {
              await follower;
            } finally {
              await queuedStore.close();
            }
          }
        }
      },
    );
  },
);

nodeIt.each(["outer rollback", "child rollback", "committed observer failure"] as const)(
  "keeps independent incognito SQL and host-view ownership through %s in a durable predicate",
  async (boundary) => {
    await withMixedSessionOwners("Gateway", async ({ manager, target, scope, readEntry }) => {
      const beforeA = readEntry()!.entry;
      const beforeB = manager.getEntries();
      const firstLeaf = manager.getLeafId()!;
      const outerFailure = new Error("durable caller aborts after independent B");
      const childFailure = new Error("B callback aborts its own native transaction");
      const observerFailure = new Error("B committed observer failed");
      const nestedMessage = makeAgentAssistantMessage({
        content: [{ type: "text", text: "nested B observer" }],
      });
      const parentMessage = {
        role: "user" as const,
        content: boundary === "child rollback" ? "aborted B" : "committed B",
        timestamp: 3,
      };
      const committedMessages =
        boundary === "committed observer failure"
          ? [nestedMessage]
          : [nestedMessage, parentMessage];
      let freshReturned = false;
      const observed = vi.fn((message: { role: string }) => {
        expect(freshReturned).toBe(true);
        if (message.role === "assistant" && boundary === "committed observer failure") {
          throw observerFailure;
        }
      });
      installSessionToolResultGuard(manager, { onMessagePersisted: observed });
      let nestedId: string | undefined;
      let customId: string | undefined;
      let committedView: ReturnType<SessionManager["getEntries"]> | undefined;
      let committedLeaf: string | null | undefined;
      const fresh = vi.fn(() => {
        nestedId = manager.appendMessage(nestedMessage);
        expect(manager.getEntry(nestedId)).toMatchObject({
          type: "message",
          message: nestedMessage,
        });
        expect(observed).not.toHaveBeenCalled();
        customId = manager.appendCustomEntry("independent-child", {
          kept: boundary !== "child rollback",
        });
        manager.resetLeaf();
        expect(observed).not.toHaveBeenCalled();
        if (boundary === "child rollback") {
          throw childFailure;
        }
        freshReturned = true;
      });
      const predicate = vi.fn(() => {
        if (boundary === "child rollback") {
          expect(() =>
            manager.appendMessage(parentMessage, { beforeFreshMessageCommit: fresh }),
          ).toThrow(childFailure);
          expect(manager.getEntries()).toEqual(beforeB);
          expect(manager.getLeafId()).toBe(firstLeaf);
          expect(SessionManager.open(target).getEntries()).toEqual(beforeB);
          return;
        }
        let thrown: unknown;
        try {
          manager.appendMessage(parentMessage, { beforeFreshMessageCommit: fresh });
        } catch (error) {
          thrown = error;
        }
        if (boundary === "committed observer failure") {
          expect(thrown).toBe(observerFailure);
        } else {
          expect(thrown).toBeUndefined();
        }
        manager.appendLeafControl({ targetId: firstLeaf, appendParentId: firstLeaf });
        committedView = manager.getEntries();
        committedLeaf = manager.getLeafId();
        expect(committedView).toContainEqual(
          expect.objectContaining({ type: "message", message: parentMessage }),
        );
        expect(SessionManager.open(target).getEntries()).toEqual(committedView);
        expect(observed.mock.calls.map(([message]) => message)).toEqual(committedMessages);
        throw boundary === "committed observer failure" ? observerFailure : outerFailure;
      });
      const operation = patchSessionEntry({
        ...scope,
        skipMaintenance: true,
        update: () => ({ label: "A attempted change" }),
        assertCommitAllowed: predicate,
      });
      if (boundary === "child rollback") {
        await expect(operation).resolves.toMatchObject({ label: "A attempted change" });
        expect(observed).not.toHaveBeenCalled();
        expect(manager.getEntry(nestedId!)).toBeUndefined();
        expect(manager.getEntry(customId!)).toBeUndefined();
      } else {
        await expect(operation).rejects.toBe(
          boundary === "committed observer failure" ? observerFailure : outerFailure,
        );
        expect(readEntry()!.entry).toEqual(beforeA);
        expect(manager.getEntries()).toEqual(committedView);
        expect(manager.getLeafId()).toBe(committedLeaf);
        expect(manager.getEntry(nestedId!)).toMatchObject({
          type: "message",
          message: nestedMessage,
        });
        expect(manager.getEntry(customId!)).toMatchObject({ customType: "independent-child" });
        const reopened = SessionManager.open(target);
        expect(reopened.getEntries()).toEqual(committedView);
        expect(reopened.getLeafId()).toBe(committedLeaf);
        expect(observed.mock.calls.map(([message]) => message)).toEqual(committedMessages);
      }
      expect(predicate).toHaveBeenCalledOnce();
      expect(fresh).toHaveBeenCalledOnce();
    });
  },
);
it("uses incognito transaction postimages for currency while delivery retains committed facts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "main";
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: state.env });
    const options = { agentId, path: storePath, env: state.env };
    const scope = {
      agentId,
      storePath,
      env: state.env,
      sessionKey: "agent:main:subagent:incognito-currency",
    };
    const originalCurrency = {
      sessionId: "incognito-currency-session",
      lifecycleRevision: "incognito-currency-lifecycle",
      lifecycleRunId: "original-run",
      activeWriterRunId: "original-writer",
      subagentRecovery: { lastRunId: "original-hidden-run" },
    };
    const original = {
      ...originalCurrency,
      incognito: true,
      updatedAt: 1,
    } satisfies InternalSessionEntry;
    const database = openOpenClawAgentDatabase(options);
    runOpenClawAgentWriteTransaction(
      (writer) => writeSessionEntry(writer, scope.sessionKey, original),
      options,
    );
    const reader = await withSessionEntryReadOnlyInWorker(
      scope,
      () => {},
      async (read, owner) => {
        expect(read.ok).toBe(true);
        return captureSessionEntryCurrentRead(scope, owner);
      },
    );
    if (reader.source) {
      throw new Error("Expected a process-held incognito currency reader");
    }
    const generation = await prepareSessionDeliveryGeneration({
      agentId,
      storePath,
      sessionKey: scope.sessionKey,
      sessionId: original.sessionId,
      lifecycleRevision: original.lifecycleRevision,
    });
    const rollback = new Error("roll back incognito currency postimage");
    try {
      expect(reader.readCurrent()).toMatchObject(originalCurrency);
      expect(() =>
        runOpenClawAgentWriteTransaction((writer) => {
          writeSessionEntry(writer, scope.sessionKey, {
            ...original,
            lifecycleRunId: "pending-run",
            activeWriterRunId: "pending-writer",
            subagentRecovery: { lastRunId: "pending-hidden-run" },
            updatedAt: 2,
          });
          // A later field publication must retain the staged entry's currency fields.
          addSessionMember(scope, { identityId: "member", addedBy: "operator" });
          expect(reader.readCurrent()).toMatchObject({
            lifecycleRunId: "pending-run",
            activeWriterRunId: "pending-writer",
            subagentRecovery: { lastRunId: "pending-hidden-run" },
          });
          expect(() => readCommittedIncognitoSessionSharing(writer.db, scope.sessionKey)).toThrow(
            "publication is pending",
          );
          expect(generation.assertCurrent).toThrow(
            expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
          );
          throw rollback;
        }, options),
      ).toThrow(rollback);
      expect(database.db.isTransaction).toBe(false);
      expect(reader.readCurrent()).toMatchObject(originalCurrency);
      generation.assertCurrent();
      runOpenClawAgentWriteTransaction(
        (writer) =>
          writeSessionEntry(writer, scope.sessionKey, {
            ...original,
            lifecycleRunId: "committed-run",
            subagentRecovery: { lastRunId: "committed-hidden-run" },
            updatedAt: 3,
          }),
        options,
      );
      expect(reader.readCurrent()).toMatchObject({
        lifecycleRunId: "committed-run",
        subagentRecovery: { lastRunId: "committed-hidden-run" },
      });
      // Delivery owns session/lifecycle identity, not recovery's execution predicate.
      generation.assertCurrent();
    } finally {
      generation.release();
    }
  });
});

it.each([
  "lost result",
  "release failure",
  "newer native write",
  "newer native write after reset",
  "late writer",
] as const)("preserves replacement publication through %s", async (boundary) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const options = { agentId: "main", path: database.path };
    const sessionKey = "agent:main:replacement-settlement";
    const reset = boundary === "newer native write after reset";
    const newerNative = boundary === "newer native write" || reset;
    const original = {
      sessionId: "settlement",
      lifecycleRevision: "initial-lifecycle",
      updatedAt: 1,
      visibility: "shared" as const,
      label: "before",
      category: "before",
    };
    writeSessionEntry(database, sessionKey, original);
    const identity = readOpenClawAgentDatabaseIdentity(database).identity;
    if (typeof identity !== "string") {
      throw new Error("Expected durable fixture");
    }
    const sharing = retainPreparedSessionSharingFacts({
      databaseIdentity: `file:${identity}`,
      sessionKey,
      entry: projectSessionSharingEntry(original),
      membership: new Set(["member"]),
    });
    const generation = await prepareSessionDeliveryGeneration({
      agentId: "main",
      storePath: database.path,
      sessionKey,
      sessionId: original.sessionId,
      lifecycleRevision: original.lifecycleRevision,
    });
    generation.assertCurrent();
    const projection = createSessionMembershipProjection();
    projection.updateTargets([
      { ...options, storePath: database.path, ...readOpenClawAgentDatabaseIdentity(database) },
    ]);
    const stopFacts = sessionChanges.subscribeFacts(projection.invalidate);
    await projection.prepare();
    expect([...projection.groupTargets().keys()]).toEqual(["before"]);
    let writer = database;
    if (boundary === "late writer") {
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
    } else {
      readSessionEntryCache(writer, { cache: true });
    }
    const observed: Array<string | undefined> = [];
    const caches: unknown[] = [];
    const mutations: SessionIdentityMutation[] = [];
    const stopIdentity = onSessionIdentityMutation((mutation) => mutations.push(mutation));
    const stop = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === sessionKey) {
        observed.push(sharing.readCurrent()?.entry?.visibility);
        caches.push(readCommittedSessionEntryCache(writer.db)?.get(sessionKey)?.label);
      }
    });
    let executions = 0;
    let whileWaiting: ReturnType<typeof sharing.readCurrent>;
    const failure = new Error(`synthetic ${boundary}`);
    delivery.afterResult = () => {
      executions++;
      whileWaiting = sharing.readCurrent();
      expect(generation.assertCurrent).toThrow(
        expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
      );
      if (boundary === "lost result") {
        throw failure;
      }
      if (newerNative) {
        replaceSessionEntrySync(
          { agentId: "main", storePath: database.path, sessionKey },
          {
            ...readExactSessionEntryRow(database, sessionKey)!.entry,
            updatedAt: 3,
            visibility: "draft",
            label: "newer",
            category: "newer",
          },
        );
      }
    };
    if (boundary === "release failure") {
      delivery.releaseFailure = failure;
    }
    try {
      const operation = applySessionEntryExactReplacements({
        storePath: database.path,
        sessionKeys: [sessionKey],
        update: ([row]) => {
          if (boundary === "late writer") {
            writer = openOpenClawAgentDatabase(options);
            readSessionEntryCache(writer, { cache: true });
          }
          return {
            result: undefined,
            replacements: [
              {
                sessionKey,
                entry: {
                  ...row!.entry,
                  visibility: "read-only",
                  label: "worker",
                  category: "worker",
                  ...(reset ? { lifecycleRevision: "next-lifecycle" } : {}),
                },
              },
            ],
          };
        },
      });
      if (boundary === "lost result" || boundary === "release failure") {
        await expect(operation).rejects.toBe(failure);
      } else {
        await operation;
      }
      expect(executions).toBe(1);
      if (boundary !== "late writer") {
        expect(whileWaiting).toBeUndefined();
      }
      if (reset) {
        expect(sharing.readCurrent()).toBeUndefined();
      } else {
        expect(sharing.readCurrent()).toMatchObject({
          entry: { visibility: newerNative ? "draft" : "read-only" },
          membership: new Set(["member"]),
        });
      }
      if (reset) {
        expect(generation.assertCurrent).toThrow(
          expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_REVOKED" }),
        );
      } else if (boundary === "late writer") {
        expect(generation.assertCurrent).toThrow(
          expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
        );
      } else {
        generation.assertCurrent();
      }
      expect(mutations).toEqual(
        reset
          ? [
              {
                agentId: "main",
                databaseIdentity: identity,
                kind: "reset",
                previous: { sessionId: "settlement", sessionKeys: [sessionKey] },
                current: { sessionId: "settlement", sessionKeys: [sessionKey] },
              },
            ]
          : [],
      );
      expect(readExactSessionEntryRow(writer, sessionKey)?.entry.label).toBe(
        newerNative ? "newer" : "worker",
      );
      await projection.prepare();
      expect([...projection.groupTargets()]).toEqual([
        [newerNative ? "newer" : "worker", [{ sessionKey, agentId: "main" }]],
      ]);
      expect(observed).toEqual([reset ? undefined : newerNative ? "draft" : "read-only"]);
      if (boundary === "late writer") {
        expect(caches).toEqual([undefined]);
      }
    } finally {
      delivery.afterResult = undefined;
      delivery.releaseFailure = undefined;
      stop();
      stopIdentity();
      stopFacts();
      projection.dispose();
      sharing.release();
      generation.release();
    }
  });
});

it("keeps uncertain alias membership unavailable after newer native metadata settles", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const sessionKey = "agent:main:replacement-unknown-membership";
    const entry = {
      sessionId: "unknown-membership",
      lifecycleRevision: "unchanged-lifecycle",
      updatedAt: 1,
      visibility: "shared" as const,
    };
    writeSessionEntry(database, sessionKey, entry);
    const identity = readOpenClawAgentDatabaseIdentity(database).identity;
    if (typeof identity !== "string") {
      throw new Error("Expected durable fixture");
    }
    const sharing = retainPreparedSessionSharingFacts({
      databaseIdentity: `file:${identity}`,
      sessionKey,
      entry: projectSessionSharingEntry(entry),
      membership: new Set(["previous-member"]),
    });
    const publication = retainSessionEntryWorkerPublication({
      agentId: "main",
      storePath: database.path,
      databaseIdentity: identity,
    });
    const invalidations: Array<{ sessionKey: string; scope: string | undefined }> = [];
    const stop = sessionChanges.subscribeFacts((change) => {
      if ("sessionKey" in change && change.sessionKey === sessionKey && change.factsInvalidated) {
        invalidations.push({ sessionKey: change.sessionKey, scope: change.scope });
      }
    });
    try {
      publication.begin([sessionKey], [sessionKey]);
      replaceSessionEntrySync(
        { agentId: "main", storePath: database.path, sessionKey },
        { ...entry, updatedAt: 2, visibility: "draft" },
      );
      expect(sharing.readCurrent()).toBeUndefined();
      expect(invalidations).toEqual([]);
      const settled = publication.settle(undefined, true);
      expect(sharing.readCurrent()).toBeUndefined();
      expect(invalidations).toEqual([]);
      settled?.publish();
      expect(invalidations).toEqual([{ sessionKey, scope: undefined }]);
      expect(readExactSessionEntryRow(database, sessionKey)?.entry.visibility).toBe("draft");
    } finally {
      publication.settle(undefined, false);
      stop();
      sharing.release();
    }
  });
});

it.each([false, true])(
  "invalidates rehomed membership while preserving newer native metadata (%s)",
  async (newerNative) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const sessionKey = "agent:main:replacement-member-target";
      const aliasKey = "agent:main:replacement-member-alias";
      const entry = {
        sessionId: "member-target",
        lifecycleRevision: "unchanged-lifecycle",
        updatedAt: 2,
        visibility: "shared" as const,
      };
      writeSessionEntry(database, sessionKey, entry);
      writeSessionEntry(database, aliasKey, { sessionId: "member-alias", updatedAt: 1 });
      for (const [key, identityId] of [
        [sessionKey, "target-member"],
        [aliasKey, "alias-member"],
      ] as const) {
        addSessionMember(
          { agentId: "main", storePath: database.path, sessionKey: key },
          { identityId, addedBy: "owner", addedAt: 1 },
        );
      }
      const identity = readOpenClawAgentDatabaseIdentity(database).identity;
      if (typeof identity !== "string") {
        throw new Error("Expected durable fixture");
      }
      const sharing = retainPreparedSessionSharingFacts({
        databaseIdentity: `file:${identity}`,
        sessionKey,
        entry: projectSessionSharingEntry(entry),
        membership: new Set(
          listSessionMembersInDatabase(database, sessionKey).map((member) => member.identityId),
        ),
      });
      expect(sharing.readCurrent()?.membership).toEqual(new Set(["target-member"]));
      delivery.afterResult = () => {
        if (newerNative) {
          replaceSessionEntrySync(
            { agentId: "main", storePath: database.path, sessionKey },
            { ...entry, updatedAt: 3, visibility: "draft" },
          );
          expect(sharing.readCurrent()).toBeUndefined();
        }
      };
      try {
        await applySessionEntryCanonicalReplacements({
          storePath: database.path,
          sessionKeys: [sessionKey, aliasKey],
          update: () => ({
            result: undefined,
            replacements: [{ sessionKey, previousSessionKeys: [aliasKey], entry }],
          }),
        });
        expect(readExactSessionEntryRow(database, aliasKey)).toBeUndefined();
        expect(readExactSessionEntryRow(database, sessionKey)?.entry.visibility).toBe(
          newerNative ? "draft" : "shared",
        );
        expect(
          listSessionMembersInDatabase(database, sessionKey).map((member) => member.identityId),
        ).toEqual(["alias-member", "target-member"]);
        expect(sharing.readCurrent()).toBeUndefined();
      } finally {
        delivery.afterResult = undefined;
        sharing.release();
      }
    });
  },
);

it("fences inline maintenance rows and preserves a newer native publication for them", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { resetConfigRuntimeState, setRuntimeConfigSnapshot } = await import("../config.js");
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const activeKey = "agent:main:replacement-maintenance-active";
    const siblingKey = "agent:main:replacement-maintenance-sibling";
    const archivedKey = "agent:main:replacement-maintenance-old";
    writeSessionEntry(database, activeKey, { sessionId: "active", updatedAt: Date.now() });
    writeSessionEntry(database, siblingKey, { sessionId: "sibling", updatedAt: Date.now() });
    const original = { sessionId: "maintenance-old", updatedAt: 1, visibility: "shared" as const };
    writeSessionEntry(database, archivedKey, original);
    const identity = readOpenClawAgentDatabaseIdentity(database).identity;
    if (typeof identity !== "string") {
      throw new Error("Expected durable fixture");
    }
    const sharing = retainPreparedSessionSharingFacts({
      databaseIdentity: `file:${identity}`,
      sessionKey: archivedKey,
      entry: projectSessionSharingEntry(original),
      membership: new Set(["member"]),
    });
    const config = {
      session: { maintenance: { mode: "enforce" as const, maxEntries: 1, pruneAfter: "1000000d" } },
    };
    setRuntimeConfigSnapshot(config, config);
    const replacementKeys = [activeKey, siblingKey];
    const factKeys = new Set<string>();
    const observerFacts: string[][] = [];
    const stopFacts = sessionChanges.subscribeFacts((change) => {
      if ("sessionKey" in change && replacementKeys.includes(change.sessionKey)) {
        factKeys.add(change.sessionKey);
      }
    });
    const stopObserver = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && replacementKeys.includes(change.sessionKey)) {
        observerFacts.push([...factKeys].toSorted());
      }
    });
    let whileWaiting: ReturnType<typeof sharing.readCurrent>;
    delivery.afterResult = () => {
      expect(readExactSessionEntryRow(database, archivedKey)?.entry.archivedAt).toEqual(
        expect.any(Number),
      );
      whileWaiting = sharing.readCurrent();
      replaceSessionEntrySync(
        { agentId: "main", storePath: database.path, sessionKey: archivedKey },
        { ...original, updatedAt: Date.now(), visibility: "draft", label: "newer maintenance row" },
      );
    };
    try {
      await applySessionEntryExactReplacements({
        storePath: database.path,
        activeSessionKey: activeKey,
        sessionKeys: replacementKeys,
        skipMaintenance: false,
        update: (rows) => ({
          result: undefined,
          replacements: rows.map(({ sessionKey, entry }) => ({
            sessionKey,
            entry: { ...entry, label: "updated" },
          })),
        }),
      });
      expect(observerFacts).toEqual([replacementKeys.toSorted(), replacementKeys.toSorted()]);
      expect(whileWaiting).toBeUndefined();
      expect(sharing.readCurrent()).toMatchObject({
        entry: { visibility: "draft" },
        membership: new Set(["member"]),
      });
      expect(readExactSessionEntryRow(database, archivedKey)?.entry.label).toBe(
        "newer maintenance row",
      );
    } finally {
      delivery.afterResult = undefined;
      resetConfigRuntimeState();
      stopObserver();
      stopFacts();
      sharing.release();
    }
  });
});

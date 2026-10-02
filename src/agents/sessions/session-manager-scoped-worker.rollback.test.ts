import { getEnvironmentData, type Worker } from "node:worker_threads";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import { MessageInjectionAuthorityError } from "../../auto-reply/reply/message-injection-authority.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withSessionTranscriptWriteAssertion,
} from "../../config/sessions/transcript-write-context.js";
import { captureGatewayDeviceRevocation } from "../../gateway/device-revocation.js";
import { createExpectedProfileBinding } from "../../gateway/expected-profile.js";
import { createChatSendWorkAdmission } from "../../gateway/server-methods/chat-send-work-lifetime.js";
import {
  bindGatewayRequestHandlerMutationAuthority,
  bindWebSocketRequestMutationAuthority,
  captureGatewayFreshInputWorkerAuthority,
} from "../../gateway/server-methods/session-mutation-guards.js";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../gateway/server-methods/types.js";
import { SharedGatewaySessionGenerationState } from "../../gateway/server-shared-auth-generation.js";
import type { GatewayWsClient } from "../../gateway/server/ws-types.js";
import { sharingPolicyClient } from "../../gateway/session-sharing.test-utils.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import { retainUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { installSessionToolResultGuard } from "../session-tool-result-guard.js";
import { SessionToolResultPendingConflictError } from "../session-tool-result-pending-facts.js";
import { sessionToolResultPending } from "../session-tool-result-pending.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  assertPendingDiscardNavigation,
  assertPendingNavigation,
} from "./session-manager-message.worker.test-support.js";
import * as metadataRuntime from "./session-manager-metadata-runtime.js";
import { isSqliteTranscriptMutationConflict } from "./session-manager-persistence-contract.js";
import {
  createScopedWorkerFixture,
  assistant,
} from "./session-manager-scoped-worker.test-support.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";
import { SessionManager } from "./session-manager.js";
import * as appendReceipt from "./session-message-append-receipt.js";
const nativeFault = vi.hoisted(() => ({
  control: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3),
}));
const nativeFaultKey = "openclaw.test.sessionScopedNativeFault";
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 1,
}));
vi.mock("../../infra/worker-cpu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/worker-cpu.js")>();
  // The data worker exits at the real receipt boundary. The service remains the
  // native parent and reports actual exit. Consume the arm before stopping so
  // the original owner's cleanup carrier cannot fire the same fault again.
  const preload = `
    import { getEnvironmentData, MessagePort } from "node:worker_threads";
    const control = new Int32Array(getEnvironmentData("openclaw.test.sessionScopedNativeFault"));
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function(message, ...rest) {
      const mode = message?.kind === "native-commit" ? 1 :
        message?.kind === "native-settlement" ? 2 : 0;
      if (mode && Atomics.compareExchange(control, 0, mode, 0) === mode) {
        Atomics.add(control, mode, 1);
        process.exit(19);
      }
      return post.call(this, message, ...rest);
    };
  `;
  return {
    ...actual,
    createCpuTrackedWorker(
      filename: string | URL,
      options: ConstructorParameters<typeof Worker>[1],
    ) {
      if (
        !options?.workerData?.carrierUrl ||
        getEnvironmentData(nativeFaultKey) !== nativeFault.control
      ) {
        return actual.createCpuTrackedWorker(filename, options);
      }
      return actual.createCpuTrackedWorker(filename, {
        ...options,
        workerData: {
          ...options.workerData,
          execArgv: [
            ...options.workerData.execArgv,
            "--import",
            `data:text/javascript,${encodeURIComponent(preload)}`,
          ],
        },
      });
    },
  };
});

afterEach(() => vi.restoreAllMocks());
const { withReadyManager } = createScopedWorkerFixture(nativeFault, nativeFaultKey);

it.each(["branch", "resetLeaf"] as const)(
  "projects original pending custody after %s on enrolled-ready",
  async (navigation) => {
    await withReadyManager(async ({ manager, target, read }) => {
      let observed: ReturnType<typeof assertPendingNavigation> | undefined;
      SessionManager.readSessionContext(target, () => {
        observed = assertPendingNavigation(manager, navigation);
        expect(observed).not.toHaveBeenCalled();
        expect(read().at(-1)).toMatchObject({
          role: "toolResult",
          toolName: "original",
          isError: true,
        });
      });
      expect(observed?.mock.calls.map(([message]) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "toolResult",
        "toolResult",
      ]);
      expect(SessionManager.open(target).getEntries()).toEqual(manager.getEntries());
    });
  },
);

it.each(
  (["branch", "resetLeaf"] as const).flatMap((navigation) =>
    (["user", "flush"] as const).map((boundary) => ({ navigation, boundary })),
  ),
)(
  "retains inactive pending custody with disabled synthesis after $navigation/$boundary on enrolled-ready",
  async ({ navigation, boundary }) => {
    await withReadyManager(async ({ manager, target, read }) => {
      let observed: ReturnType<typeof assertPendingDiscardNavigation> | undefined;
      SessionManager.readSessionContext(target, () => {
        observed = assertPendingDiscardNavigation(manager, navigation, boundary);
        expect(observed).not.toHaveBeenCalled();
      });
      expect(observed?.mock.calls.at(-1)?.[0]).toMatchObject({
        role: "toolResult",
        toolName: "original",
        isError: false,
      });
      expect(read().filter((message) => message.role === "toolResult")).toHaveLength(1);
      expect(SessionManager.open(target).getEntries()).toEqual(manager.getEntries());
    });
  },
);

it.each([
  { navigation: "branch", outcome: "commit" },
  { navigation: "resetLeaf", outcome: "commit" },
  { navigation: "resetLeaf", outcome: "rollback" },
  { navigation: "branch", outcome: "cohort-conflict" },
] as const)(
  "joins enrolled pending retirement with disabled synthesis to $outcome after $navigation",
  async ({ navigation, outcome }) => {
    await withReadyManager(async ({ manager, target, read }) => {
      const observed = vi.fn();
      const guard = installSessionToolResultGuard(manager, {
        allowSyntheticToolResults: false,
        onMessagePersisted: observed,
      });
      const root = manager.getLeafId()!;
      const originalEntry = manager.appendMessage(assistant("original"));
      const { pending, owner } = manager[sessionToolResultPending];
      const original = pending.calls(owner);
      if (navigation === "branch") {
        manager.branch(root);
      } else {
        manager.resetLeaf();
      }
      const before = { entries: manager.getEntries(), leaf: manager.getLeafId(), rows: read() };
      observed.mockClear();
      const failure = new Error("rollback policy-only retirement");
      let childId: string | undefined;
      let reached = false;
      let caught: unknown;
      const admissions: operationAdmission.SqliteWorkerOperationAdmission[] = [];
      const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
      const admissionObserver =
        outcome === "cohort-conflict"
          ? vi
              .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
              .mockImplementation((...args) => {
                const admission = createAdmission(...args);
                admissions.push(admission);
                return admission;
              })
          : undefined;
      try {
        SessionManager.readSessionContext(target, () => {
          manager.appendMessage(
            { role: "user", content: "parent boundary", timestamp: 2 },
            {
              beforeFreshMessageCommit: () => {
                if (outcome === "cohort-conflict") {
                  manager.branch(originalEntry);
                  guard.flushPendingToolResults();
                  expect(pending.calls(owner)).toEqual([]);
                  reached = true;
                  return;
                }
                childId = manager.appendMessage(assistant("tentative"));
                guard.flushPendingToolResults();
                expect(pending.calls(owner)).toEqual(original);
                original.forEach((call, index) => expect(pending.calls(owner)[index]).toBe(call));
                expect(observed).not.toHaveBeenCalled();
                reached = true;
              },
            },
          );
          expect(observed).not.toHaveBeenCalled();
          if (outcome === "rollback") {
            throw failure;
          }
        });
      } catch (error) {
        caught = error;
      } finally {
        admissionObserver?.mockRestore();
      }
      if (outcome === "cohort-conflict") {
        expect(caught).toBeInstanceOf(Error);
        expect(caught).toMatchObject({
          name: "SqliteWorkerError",
          code: "closed",
          message: "SQLite transaction admission was refused",
        });
        expect(
          admissions.some(
            (admission) => admission.failure instanceof SessionToolResultPendingConflictError,
          ),
        ).toBe(true);
      } else {
        expect(caught).toBe(outcome === "rollback" ? failure : undefined);
      }
      expect(reached).toBe(true);
      if (outcome !== "commit") {
        expect(manager.getEntries()).toEqual(before.entries);
        expect(manager.getLeafId()).toBe(before.leaf);
        expect(read()).toEqual(before.rows);
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
      expect(read().filter((message) => message.role === "toolResult")).toEqual([]);
      expect(SessionManager.open(target).getEntries()).toEqual(manager.getEntries());
    });
  },
);

it("forces the original outer rollback after caught private tentative adoption fails", async () => {
  await withReadyManager(async ({ manager, target, read }) => {
    const observed = vi.fn();
    const guard = installSessionToolResultGuard(manager, { onMessagePersisted: observed });
    const before = manager.getEntries();
    const failure = new Error("tentative custody adoption failed");
    const createSettlement = appendReceipt.createSessionMessageAppendSettlement;
    let staged = 0;
    const observer = vi
      .spyOn(appendReceipt, "createSessionMessageAppendSettlement")
      .mockImplementation((...args) => {
        const retained = createSettlement(...args);
        const stage = retained.stage;
        retained.stage = () => {
          stage();
          staged += 1;
          throw failure;
        };
        return retained;
      });
    try {
      let caught: unknown;
      try {
        SessionManager.readSessionContext(target, () => {
          expect(() => manager.appendMessage(assistant("failed-stage"))).toThrow(failure);
          expect(() =>
            manager.appendMessage({ role: "user", content: "must not dispatch", timestamp: 3 }),
          ).toThrow(failure);
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(staged).toBe(1);
      expect(manager.getEntries()).toEqual(before);
      expect(guard.getPendingIds()).toEqual([]);
      expect(observed).not.toHaveBeenCalled();
      expect(read()).toMatchObject([{ content: "opening turn" }]);
    } finally {
      observer.mockRestore();
    }
  });
});

it("keeps cursor return separate from snapshot finish and rolls back only the failed child", async () => {
  await withReadyManager(async ({ manager, target, read }) => {
    const observed: AgentMessage[] = [];
    const guard = installSessionToolResultGuard(manager, {
      onMessagePersisted: (message) => {
        observed.push(message);
      },
    });
    const rejected = new Error("fresh child rejected after its nested append");
    let committedId: string | undefined;
    let precedingId: string | undefined;
    const beforeFresh = vi.fn(() => {
      manager.appendMessage(assistant("rolled-back-call"));
      expect(guard.getPendingIds()).toEqual(["rolled-back-call"]);
      expect(observed).toEqual([]);
      manager.resetLeaf();
      expect(manager.getLeafId()).toBeNull();
      throw rejected;
    });
    SessionManager.readSessionContext(target, (messages) => {
      precedingId = manager.appendCustomEntry("before-failed-child", { kept: true });
      const beforeFailure = manager.getEntries();
      const ancestor = messages[Symbol.iterator]();
      expect(ancestor.next()).toMatchObject({ done: false, value: { content: "opening turn" } });
      expect(() =>
        manager.appendMessage(
          { role: "user", content: "must roll back", timestamp: 2 },
          {
            beforeFreshMessageCommit: beforeFresh,
          },
        ),
      ).toThrow(rejected);
      expect(beforeFresh).toHaveBeenCalledOnce();
      expect(manager.getEntries()).toEqual(beforeFailure);
      expect(manager.getEntry(precedingId)).toMatchObject({ customType: "before-failed-child" });
      expect(guard.getPendingIds()).toEqual([]);
      expect(read()).toMatchObject([{ content: "opening turn" }]);
      committedId = manager.appendMessage(assistant("committed-call"));
      expect(guard.getPendingIds()).toEqual(["committed-call"]);
      SessionManager.readSessionContext(target, (inner) => {
        expect([...inner].map((message) => message.role)).toEqual(["user", "assistant"]);
        // The ancestor cursor is still the opening snapshot while its child is active.
        expect(ancestor.next()).toEqual({ done: true, value: undefined });
      });
      ancestor.return?.();
      expect(observed).toEqual([]);
      expect(manager.getLeafId()).toBe(committedId);
      expect(read()).toHaveLength(2);
    });
    expect(observed).toEqual([assistant("committed-call")]);
    expect(guard.getPendingIds()).toEqual(["committed-call"]);
    expect(manager.getLeafId()).toBe(committedId);
    expect(SessionManager.open(target).getEntry(precedingId!)).toMatchObject({
      customType: "before-failed-child",
    });
    expect(read()).toHaveLength(2);
  });
});

it.each(["branch", "resetLeaf"] as const)(
  "restores tentative pending and manager state after %s when the outer caller throws",
  async (navigation) => {
    await withReadyManager(async ({ manager, target, read }) => {
      const observed = vi.fn();
      const guard = installSessionToolResultGuard(manager, { onMessagePersisted: observed });
      const before = manager.getEntries();
      const originalLeaf = manager.getLeafId()!;
      const failure = new Error("original caller failed");
      let caught: unknown;
      let tentativeId: string | undefined;
      let laterId: string | undefined;
      try {
        SessionManager.readSessionContext(target, () => {
          manager.appendMessage(assistant("outer-rollback-call"));
          tentativeId = manager.appendCustomEntry("tentative", { kept: false });
          expect(manager.getEntries()).toHaveLength(before.length + 2);
          expect(guard.getPendingIds()).toEqual(["outer-rollback-call"]);
          const { pending, owner } = manager[sessionToolResultPending];
          const original = pending.calls(owner)[0];
          expect(read()).toHaveLength(2);
          expect(observed).not.toHaveBeenCalled();
          if (navigation === "branch") {
            manager.branch(originalLeaf);
          } else {
            manager.resetLeaf();
          }
          expect(manager.getLeafId()).toBe(navigation === "branch" ? originalLeaf : null);
          expect(guard.getPendingIds()).toEqual([]);
          expect(pending.calls(owner)[0]).toBe(original);
          expect(manager.getEntry(tentativeId)).toMatchObject({ customType: "tentative" });
          laterId = manager.appendMessage(assistant("later-rollback-call"));
          expect(guard.getPendingIds()).toEqual(["later-rollback-call"]);
          expect(pending.calls(owner)[0]).toBe(original);
          expect(manager.getLeafId()).toBe(laterId);
          expect(manager.getEntry(laterId)).toMatchObject({ type: "message" });
          expect(observed).not.toHaveBeenCalled();
          throw failure;
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(manager.getEntries()).toEqual(before);
      expect(manager.getEntry(tentativeId!)).toBeUndefined();
      expect(manager.getEntry(laterId!)).toBeUndefined();
      expect(manager.getLeafId()).toBe(originalLeaf);
      expect(SessionManager.open(target).getEntries()).toEqual(before);
      expect(guard.getPendingIds()).toEqual([]);
      expect(observed).not.toHaveBeenCalled();
      expect(read()).toMatchObject([{ content: "opening turn" }]);
      const following = await manager.appendMessageAsync(assistant("following-call"));
      assert(typeof following === "string");
      expect(manager.getEntry(following)).toMatchObject({ parentId: originalLeaf });
      expect(guard.getPendingIds()).toEqual(["following-call"]);
      expect(observed).toHaveBeenCalledOnce();
    });
  },
);

it("retries a stale ready metadata append on its original scoped owner", async () => {
  await withReadyManager(async ({ manager, target }) => {
    const sibling = SessionManager.open(target);
    const originalLeaf = manager.getLeafId();
    let firstId: string | undefined;
    let secondId: string | undefined;
    SessionManager.readSessionContext(target, () => {
      firstId = manager.appendCustomEntry("first scoped metadata", {});
      sibling.resetLeaf();
      secondId = sibling.appendCustomEntry("retried scoped metadata", {});
      expect(sibling.getEntry(firstId)).toMatchObject({ parentId: originalLeaf });
      expect(sibling.getEntry(secondId)).toMatchObject({ parentId: null });
      expect(sibling.getLeafId()).toBe(secondId);
    });
    const reopened = SessionManager.open(target);
    expect(reopened.getEntries()).toEqual(sibling.getEntries());
    expect(reopened.getEntries()).toHaveLength(3);
    expect(reopened.getEntry(firstId!)).toMatchObject({ customType: "first scoped metadata" });
    expect(reopened.getEntry(secondId!)).toMatchObject({
      customType: "retried scoped metadata",
      parentId: null,
    });
    expect(reopened.getLeafId()).toBe(secondId);
  });
});

it.each(["replacement", "revocation"] as const)(
  "refuses a stale ready metadata retry after original owner %s",
  async (invalidation) => {
    await withReadyManager(async ({ manager, target }) => {
      const sibling = SessionManager.open(target);
      const view = (owner: SessionManager) =>
        structuredClone({
          header: owner.getHeader(),
          entries: owner.getEntries(),
          tree: owner.getTree(),
          branch: owner.getBranch(),
          context: owner.buildSessionContext(),
          leaf: owner.getLeafId(),
          parent: owner.getAppendParentId(),
          mode: owner.getAppendMode(),
          boundaries: owner.getBoundaryCount(),
          cwd: owner.getCwd(),
        });
      const replacementTarget = {
        ...target,
        sessionId: "metadata-replacement",
        sessionKey: "agent:main:dashboard:metadata-replacement",
      };
      const replacement = SessionManager.open(replacementTarget);
      replacement.appendMessage({ role: "user", content: "replacement view", timestamp: 2 });
      const replacementBefore = replacement.getEntries();
      const replacementView = view(replacement);
      expect(replacementView.cwd).not.toBe(sibling.getCwd());
      manager.appendCustomEntry("committed before stale metadata", {});
      const originalBefore = SessionManager.open(target).getEntries();
      if (invalidation === "revocation") {
        sibling.resetLeaf();
      }
      const siblingBefore = sibling.getEntries();
      const siblingView = view(sibling);
      const revokedOwner = new Error("original metadata owner revoked");
      const conflicts: unknown[] = [];
      const appendIntents: Array<"active-branch" | undefined> = [];
      let revoked = false;
      let replacementReturned = false;
      let appendAttempts = 0;
      let mutationReads = 0;
      const withReadyMetadata = metadataRuntime.withReadySessionMetadata;
      const observe = vi
        .spyOn(metadataRuntime, "withReadySessionMetadata")
        .mockImplementation((scopeTarget, assertCurrent, operation) =>
          withReadyMetadata(scopeTarget, assertCurrent, (scope) =>
            operation({
              get tentative() {
                return scope.tentative;
              },
              publish: scope.publish,
              execute(command) {
                const original = scopeTarget.sessionId === target.sessionId;
                if (original && command.type === "session.metadata.mutation") {
                  mutationReads += 1;
                }
                const event = "event" in command.input ? command.input.event : undefined;
                const attempted =
                  original &&
                  command.type === "session.metadata.append" &&
                  event?.type === "custom" &&
                  event.customType === "refused stale metadata";
                if (attempted) {
                  appendAttempts += 1;
                  appendIntents.push(
                    "options" in command.input ? command.input.options.appendIntent : undefined,
                  );
                }
                try {
                  return scope.execute(command);
                } catch (error) {
                  if (attempted && isSqliteTranscriptMutationConflict(error)) {
                    conflicts.push(error);
                    if (invalidation === "replacement") {
                      sibling.setSessionTarget(replacementTarget);
                      replacementReturned = true;
                    } else {
                      revoked = true;
                    }
                  }
                  throw error;
                }
              },
            }),
          ),
        );
      let caught: unknown;
      try {
        const append = () => sibling.appendCustomEntry("refused stale metadata", {});
        if (invalidation === "revocation") {
          withSessionTranscriptWriteAssertion(
            target,
            () => {
              if (revoked) {
                throw revokedOwner;
              }
            },
            append,
          );
        } else {
          append();
        }
      } catch (error) {
        caught = error;
      } finally {
        observe.mockRestore();
      }
      expect(conflicts).toHaveLength(1);
      expect(isSqliteTranscriptMutationConflict(conflicts[0])).toBe(true);
      if (invalidation === "replacement") {
        expect(appendIntents).toEqual(["active-branch"]);
      }
      expect(caught).not.toBe(conflicts[0]);
      expect(appendAttempts).toBe(1);
      expect(mutationReads).toBe(0);
      expect(SessionManager.open(target).getEntries()).toEqual(originalBefore);
      expect(SessionManager.open(replacementTarget).getEntries()).toEqual(replacementBefore);
      if (invalidation === "replacement") {
        expect(caught).toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
        expect(replacementReturned).toBe(true);
        expect(sibling.getSessionId()).toBe(replacementTarget.sessionId);
        expect(sibling.getEntries()).toEqual(replacementBefore);
        expect(sibling.getLeafId()).toBe(replacement.getLeafId());
        expect(view(sibling)).toEqual(replacementView);
      } else {
        expect(caught).toBe(revokedOwner);
        expect(sibling.getSessionId()).toBe(target.sessionId);
        expect(sibling.getEntries()).toEqual(siblingBefore);
        expect(sibling.getLeafId()).toBeNull();
        expect(view(sibling)).toEqual(siblingView);
      }
    });
  },
);

it("restores two managers sharing one incarnation without undoing an unrelated navigation", async () => {
  await withReadyManager(async ({ manager, target }) => {
    const sibling = SessionManager.open(target);
    const otherTarget = {
      ...target,
      sessionId: "other-view",
      sessionKey: "agent:main:dashboard:other-view",
    };
    const other = SessionManager.open(otherTarget);
    other.appendMessage({ role: "user", content: "independent navigation", timestamp: 2 });
    // The other logical session still uses this same native DB incarnation. Its
    // navigation is therefore part of this transaction, unlike a foreign DB below.
    const foreignTarget = {
      ...target,
      agentId: "foreign-view",
      sessionId: "foreign-view",
      sessionKey: "agent:foreign-view:dashboard:foreign-view",
      storePath: agentDatabase.resolveIncognitoOpenClawAgentSqlitePath({
        agentId: "foreign-view",
        env: target.env,
      }),
    };
    const foreign = SessionManager.open(foreignTarget);
    foreign.appendMessage({ role: "user", content: "foreign view", timestamp: 3 });
    const before = manager.getEntries();
    const beforeSibling = sibling.getEntries();
    const beforeOtherLeaf = other.getLeafId();
    const failure = new Error("shared incarnation outer abort");
    let firstId: string | undefined;
    let secondId: string | undefined;
    const callback = vi.fn(() => {
      firstId = manager.appendCustomEntry("first manager", {});
      sibling.resetLeaf();
      secondId = sibling.appendCustomEntry("second manager", {});
      other.resetLeaf();
      foreign.resetLeaf();
      throw failure;
    });
    expect(() => SessionManager.readSessionContext(target, callback)).toThrow(failure);
    expect(callback).toHaveBeenCalledOnce();
    expect(manager.getEntries()).toEqual(before);
    expect(sibling.getEntries()).toEqual(beforeSibling);
    expect(manager.getEntry(firstId!)).toBeUndefined();
    expect(sibling.getEntry(secondId!)).toBeUndefined();
    expect(other.getLeafId()).toBe(beforeOtherLeaf);
    expect(foreign.getLeafId()).toBeNull();
    expect(SessionManager.open(target).getEntries()).toEqual(before);
  });
});

it("reverses nested fresh-callback views before their later parent stage on outer rollback", async () => {
  await withReadyManager(async ({ manager, target, read }) => {
    const observed = vi.fn();
    const guard = installSessionToolResultGuard(manager, { onMessagePersisted: observed });
    const before = manager.getEntries();
    const failure = new Error("outer caller failed after successful nested and parent stages");
    let nestedId: string | undefined;
    let parentId: string | undefined;
    let caught: unknown;
    const beforeFresh = vi.fn(() => {
      nestedId = manager.appendMessage(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "nested append" }] }),
      );
      expect(manager.getEntry(nestedId)).toMatchObject({ type: "message" });
      expect(observed).not.toHaveBeenCalled();
    });
    try {
      SessionManager.readSessionContext(target, () => {
        parentId = manager.appendMessage(
          { role: "user", content: "parent after nested append", timestamp: 3 },
          {
            beforeFreshMessageCommit: beforeFresh,
          },
        );
        expect(manager.getEntries()).toHaveLength(before.length + 2);
        expect(manager.getEntry(nestedId!)).toMatchObject({ type: "message" });
        expect(manager.getEntry(parentId)).toMatchObject({ type: "message" });
        expect(read().map((message) => message.role)).toEqual(["user", "assistant", "user"]);
        expect(observed).not.toHaveBeenCalled();
        throw failure;
      });
    } catch (error) {
      caught = error;
    }
    expect(beforeFresh).toHaveBeenCalledOnce();
    expect(caught).toBe(failure);
    expect(manager.getEntries()).toEqual(before);
    expect(manager.getEntry(nestedId!)).toBeUndefined();
    expect(manager.getEntry(parentId!)).toBeUndefined();
    expect(SessionManager.open(target).getEntries()).toEqual(before);
    expect(guard.getPendingIds()).toEqual([]);
    expect(observed).not.toHaveBeenCalled();
    const following = manager.appendCustomEntry("after-outer-rollback", { kept: true });
    expect(SessionManager.open(target).getEntry(following)).toMatchObject({
      customType: "after-outer-rollback",
    });
  });
});

it("preserves an independently replaced manager view when its original scoped work rolls back", async () => {
  await withReadyManager(async ({ manager, target }) => {
    const independentTarget = {
      ...target,
      sessionId: "independent-session",
      sessionKey: "agent:main:dashboard:incognito-independent",
    };
    const independent = SessionManager.open(independentTarget);
    const independentLeaf = independent.appendMessage({
      role: "user",
      content: "independent committed view",
      timestamp: 2,
    });
    const original = manager.getEntries();
    const replacement = independent.getEntries();
    const failure = new Error("original snapshot aborted after target replacement");
    let tentativeId: string | undefined;
    expect(() =>
      SessionManager.readSessionContext(target, () => {
        tentativeId = manager.appendCustomEntry("discarded-before-replacement", {});
        manager.resetLeaf();
        manager.setSessionTarget(independentTarget);
        expect(manager.getEntries()).toEqual(replacement);
        throw failure;
      }),
    ).toThrow(failure);
    expect(manager.getSessionId()).toBe(independentTarget.sessionId);
    expect(manager.getLeafId()).toBe(independentLeaf);
    expect(manager.getEntries()).toEqual(replacement);
    expect(manager.getEntry(tentativeId!)).toBeUndefined();
    expect(SessionManager.open(target).getEntries()).toEqual(original);
    expect(SessionManager.open(independentTarget).getEntries()).toEqual(replacement);
  });
});

it.each([false, true])(
  "keeps a guarded ready caller hook separate from branded fresh authority with revocation=%s",
  async (revoke) => {
    await withReadyManager(async ({ manager, target, read }) => {
      const profile = ensureProfileForEmail("scoped-input@example.test");
      const releaseCatalog = retainUserProfileCatalog();
      const client = sharingPolicyClient({ user: profile.id }) as GatewayWsClient;
      const context = {} as GatewayRequestContext;
      const device = captureGatewayDeviceRevocation(context, {}, () => true);
      let work: ReturnType<typeof createChatSendWorkAdmission> | undefined;
      try {
        const params = { sessionKey: target.sessionKey, message: "fresh input" };
        const request: GatewayRequestOptions = {
          req: { type: "req", id: "scoped-input", method: "chat.send", params },
          client,
          context,
          respond: vi.fn(),
          isWebchatConnect: () => true,
          hasCurrentClientAuthority: device.isCurrent,
        };
        bindWebSocketRequestMutationAuthority(
          request,
          client,
          new SharedGatewaySessionGenerationState({ current: undefined, required: null }).reader,
        );
        const profileBinding = await createExpectedProfileBinding(profile.id, client);
        profileBinding!.assertCurrent();
        const handler = bindGatewayRequestHandlerMutationAuthority(
          request,
          { ...request, params },
          profileBinding,
        );
        const admission = await beginSessionWorkAdmission({
          scope: target.storePath!,
          identities: [target.sessionKey, target.sessionId],
          assertAllowed: () => profileBinding!.assertCurrent(),
        });
        work = createChatSendWorkAdmission({
          admission,
          logGateway: { warn: vi.fn() },
          releaseCallerAuthority: device.release,
        });
        const lifetime = work.captureInputLifetime({
          controller: new AbortController(),
          queuedTurns: new Map(),
          runId: "scoped-input",
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
        });
        const authority = captureGatewayFreshInputWorkerAuthority(handler, lifetime);
        expect(authority).toBeDefined();
        const message = {
          role: "user" as const,
          content: "fresh input",
          timestamp: 2,
          idempotencyKey: "branded-input",
        };
        const opaqueAssertion = vi.fn(() => profileBinding!.assertCurrent());
        const recorder = createUserTurnTranscriptRecorder({
          message,
          target: { ...target, sessionEntry: undefined },
          assertOriginalInputCommit: opaqueAssertion,
          freshInputWorkerAuthority: authority,
        });
        const observed = vi.fn();
        guardSessionManager(manager, {
          preparedUserTurnMessage: message,
          preparedUserTurnTranscriptRecorder: recorder,
          onMessagePersisted: observed,
        });
        const before = manager.getEntries();
        const beforeFresh = vi.fn(() => {
          expect(read()).toMatchObject([{ content: "opening turn" }]);
          if (revoke) {
            admission.release();
          }
        });
        const appended = manager.appendMessageAsync(message, {
          beforeFreshMessageCommit: beforeFresh,
        });
        if (revoke) {
          const rejected = await appended.catch((error: unknown) => error);
          assert(rejected instanceof MessageInjectionAuthorityError);
          assert(rejected.cause instanceof Error);
          expect(rejected.cause.message).toBe(
            "Chat admission ended or was cancelled; submit a new turn.",
          );
          expect(manager.getEntries()).toEqual(before);
          expect(read()).toMatchObject([{ content: "opening turn" }]);
          expect(observed).not.toHaveBeenCalled();
        } else {
          const entryId = await appended;
          assert(typeof entryId === "string");
          expect(manager.getEntry(entryId)).toMatchObject({ message });
          expect(
            manager.appendMessage(
              { ...message, content: "ignored replay" },
              {
                beforeFreshMessageCommit: beforeFresh,
              },
            ),
          ).toBe(entryId);
          expect(observed).toHaveBeenCalledOnce();
          expect(read()).toMatchObject([{ content: "opening turn" }, { content: "fresh input" }]);
        }
        expect(beforeFresh).toHaveBeenCalledOnce();
        // The ready grant uses the branded owner, never the opaque recorder callback.
        expect(opaqueAssertion).not.toHaveBeenCalled();
      } finally {
        try {
          if (work) {
            await work.release();
          } else {
            device.release();
          }
        } finally {
          releaseCatalog();
        }
      }
    });
  },
);

it("preserves normal post-await store ownership across manager objects and multi-yield repair", async () => {
  await withReadyManager(async ({ manager, target, read }) => {
    const observed: string[] = [];
    const guard = installSessionToolResultGuard(manager, {
      onMessagePersisted(message) {
        observed.push(message.role);
      },
    });
    const beforeFresh = vi.fn();
    await withSessionManagerWrite(manager, async () => {
      await Promise.resolve();
      manager.appendCustomEntry("after-await", { order: 1 });
      const sibling = SessionManager.open(target);
      await Promise.resolve();
      sibling.appendCustomEntry("same-store-owner", { order: 2 });
      await manager.reloadPersistedTranscriptAsync();
      await manager.appendMessageAsync(
        makeAgentAssistantMessage({
          content: [
            { type: "toolCall", id: "first", name: "read", arguments: {} },
            { type: "toolCall", id: "second", name: "read", arguments: {} },
          ],
          stopReason: "toolUse",
        }),
      );
      expect(guard.getPendingIds()).toEqual(["first", "second"]);
      manager.appendCustomEntry("after-native-adoption", { order: 3 });
      await manager.appendMessageAsync(
        { role: "user", content: "next turn", timestamp: 3 },
        {
          beforeFreshMessageCommit: beforeFresh,
        },
      );
    });
    expect(beforeFresh).toHaveBeenCalledOnce();
    expect(guard.getPendingIds()).toEqual([]);
    expect(observed).toEqual(["assistant", "toolResult", "toolResult", "user"]);
    expect(read().map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "user",
    ]);
    expect(
      manager
        .getEntries()
        .filter((entry) => entry.type === "custom")
        .map((entry) => entry.customType),
    ).toEqual(["after-await", "same-store-owner", "after-native-adoption"]);
  });
});

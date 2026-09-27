import { inspect } from "node:util";
import { getEnvironmentData, type Worker } from "node:worker_threads";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import { isSqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import * as scopedRuntime from "../../infra/sqlite-worker-scoped-operation.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import {
  captureOpenClawAgentHostExecution,
  runOpenClawAgentWriteAdmission,
} from "../../state/openclaw-agent-write-admission.js";
import { installSessionToolResultGuard } from "../session-tool-result-guard.js";
import {
  createSessionToolResultPending,
  sessionToolResultPending,
} from "../session-tool-result-pending.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { SessionTranscriptMessageCommittedError } from "./session-manager-message-error.js";
import * as messageRuntime from "./session-manager-message-runtime.js";
import {
  createScopedWorkerFixture,
  assistant,
} from "./session-manager-scoped-worker.test-support.js";
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

it("keeps a ready context lazy and its local callback result outside native transport", async () => {
  await withReadyManager(async ({ manager, target, read }) => {
    const large = "x".repeat(9 * 1024 * 1024);
    manager.appendMessage({ role: "user", content: large, timestamp: 2 });
    const createScope = scopedRuntime.createSqliteWorkerHostScope;
    const requests: string[] = [];
    const observer = vi
      .spyOn(scopedRuntime, "createSqliteWorkerHostScope")
      .mockImplementation((run, viewOwner, retainPublication) =>
        createScope(
          (step, scope) =>
            run(step, {
              call(action) {
                if (step.kind === "session-context") {
                  requests.push(action.kind);
                }
                return scope.call(action);
              },
            }),
          viewOwner,
          retainPublication,
        ),
      );
    const local = { callback() {}, identity: Symbol("local result") };
    let retained: Iterator<AgentMessage> | undefined;
    try {
      const result = SessionManager.readSessionContext(target, (messages, header) => {
        expect(header).toMatchObject({ id: target.sessionId });
        retained = messages[Symbol.iterator]();
        expect(retained.next()).toMatchObject({ done: false, value: { content: "opening turn" } });
        return local;
      });
      expect(result).toBe(local);
      expect(requests).toEqual(["next", "return"]);
      expect(retained?.next()).toEqual({ done: true, value: undefined });
      requests.length = 0;
      expect(read().map((message) => message.role)).toEqual(["user", "user"]);
      expect(requests).toEqual(["next", "next", "next", "return"]);
      expect(read()[1]).toMatchObject({ content: large });
    } finally {
      observer.mockRestore();
    }
  });
});

it("preserves thrown undefined and checks a found callback thenable exactly once", async () => {
  await withReadyManager(async ({ manager, target, read }) => {
    const before = manager.getEntries();
    let caught = false;
    try {
      SessionManager.readSessionContext(target, () => {
        manager.appendCustomEntry("rolled-back-undefined", {});
        // oxlint-disable-next-line typescript/only-throw-error -- Raw undefined must survive the original rollback boundary.
        throw undefined;
      });
    } catch (error) {
      caught = true;
      expect(error).toBeUndefined();
    }
    expect(caught).toBe(true);
    expect(manager.getEntries()).toEqual(before);
    const then = vi.fn();
    const getThen = vi.fn(() => then);
    // oxlint-disable-next-line unicorn/no-thenable -- Exercise exactly-once thenable accessor classification without invoking it.
    const thenable = Object.defineProperty({}, "then", { get: getThen });
    expect(() => SessionManager.readSessionContext(target, () => thenable)).toThrow(
      "SQLite write transactions must be synchronous",
    );
    expect(getThen).toHaveBeenCalledOnce();
    expect(then).not.toHaveBeenCalled();
    expect(read()).toMatchObject([{ content: "opening turn" }]);
    // The existing missing-snapshot callback is outside any transaction.
    const missing = {
      ...target,
      agentId: "missing",
      sessionId: "missing-session",
      sessionKey: "agent:missing:dashboard:incognito-missing",
      storePath: agentDatabase.resolveIncognitoOpenClawAgentSqlitePath({
        agentId: "missing",
        env: target.env,
      }),
    };
    expect(
      SessionManager.readSessionContext(missing, (messages, header) => {
        expect([...messages]).toEqual([]);
        expect(header).toBeUndefined();
        return thenable;
      }),
    ).toBe(thenable);
    expect(getThen).toHaveBeenCalledOnce();
  });
});

it("settles every pending owner before outward publication stops at its first failure", async () => {
  await withReadyManager(async ({ manager, target, read }) => {
    const failure = new Error("first outward observer failed");
    const observed: AgentMessage[] = [];
    const guard = installSessionToolResultGuard(manager, {
      onMessagePersisted(message) {
        observed.push(message);
        throw failure;
      },
    });
    const first = makeAgentAssistantMessage({ content: [{ type: "text", text: "first" }] });
    let caught: unknown;
    try {
      SessionManager.readSessionContext(target, () => {
        manager.appendMessage(first);
        manager.appendMessage(assistant("last-committed-call"));
        expect(observed).toEqual([]);
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(observed).toEqual([first]);
    expect(guard.getPendingIds()).toEqual(["last-committed-call"]);
    expect(read().map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(manager.getEntries()).toHaveLength(3);
  });
});

it.each([
  { mode: "ready", failureKind: "Error", privateFailure: false },
  { mode: "ready", failureKind: "undefined", privateFailure: false },
  { mode: "async", failureKind: "Error", privateFailure: false },
  { mode: "async", failureKind: "undefined", privateFailure: false },
  { mode: "ready", failureKind: "Error", privateFailure: true },
  { mode: "async", failureKind: "undefined", privateFailure: true },
] as const)(
  "delivers $mode message observers after fixed settlement ($failureKind, private failure: $privateFailure)",
  async ({ mode, failureKind, privateFailure }) => {
    await withReadyManager(async ({ target, read }) => {
      const observerFailure =
        failureKind === "Error" ? new Error("first message observer failed") : undefined;
      const cleanupFailure = new Error("original message private finish failed");
      const first = makeAgentAssistantMessage({ content: [{ type: "text", text: "first" }] });
      const last = assistant("settled-before-observation");
      const parent = { role: "user" as const, content: "parent message", timestamp: 2 };
      const childIds = new Set<string>();
      const order: string[] = [];
      let freshReturned = false;
      let cleanupFaults = 0;
      let publishCalls = 0;
      let parentScope: ReturnType<typeof scopedRuntime.createSqliteWorkerHostScope> | undefined;
      const createScope = scopedRuntime.createSqliteWorkerHostScope;
      const scopeSpy = vi
        .spyOn(scopedRuntime, "createSqliteWorkerHostScope")
        .mockImplementation((...args) => {
          const scope = createScope(...args);
          if (!parentScope) {
            parentScope = scope;
            const publish = scope.publish;
            scope.publish = () => {
              publishCalls += 1;
              publish();
            };
          }
          return scope;
        });
      const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
      const admissionSpy = vi
        .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((...args) => {
          const admission = createAdmission(...args);
          if (privateFailure && args[2] && args[2] === parentScope) {
            const finish = admission.finish;
            admission.finish = () => {
              finish();
              if (!cleanupFaults && admission.committed) {
                expect(admission.settlement?.kind).toBe("completed");
                expect(admission.settlement?.committed).toBe(admission.committed);
                expect(freshReturned).toBe(true);
                cleanupFaults += 1;
                order.push("private-failure");
                throw cleanupFailure;
              }
            };
          }
          return admission;
        });
      const createRuntime = messageRuntime.createSessionManagerMessageRuntime;
      const runtimeSpy = vi
        .spyOn(messageRuntime, "createSessionManagerMessageRuntime")
        .mockImplementation((params) =>
          createRuntime({
            ...params,
            commit(facts) {
              params.commit?.(facts);
              order.push(childIds.has(facts.receipt.messageId) ? "child-commit" : "parent-commit");
            },
            publishCommit(facts) {
              order.push(
                childIds.has(facts.receipt.messageId) ? "child-publication" : "parent-publication",
              );
              params.publishCommit?.(facts);
            },
          }),
        );
      try {
        const manager = SessionManager.open(target);
        const observed: AgentMessage[] = [];
        const guard = installSessionToolResultGuard(manager, {
          onMessagePersisted(message) {
            observed.push(message);
            order.push("observer");
            expect(freshReturned).toBe(true);
            expect(order.filter((entry) => entry === "child-commit")).toHaveLength(2);
            expect(order).toContain("parent-commit");
            expect(order).not.toContain("parent-publication");
            expect(guard.getPendingIds()).toEqual(["settled-before-observation"]);
            if (!privateFailure) {
              expect(manager.getEntries()).toHaveLength(4);
            }
            assert(parentScope);
            // The journal was drained before outward code; reentry cannot replay its batch.
            parentScope.publish();
            // oxlint-disable-next-line typescript/only-throw-error -- Preserve the observer's original Error or raw undefined after settlement.
            throw observerFailure;
          },
        });
        const fresh = vi.fn(() => {
          childIds.add(manager.appendMessage(first));
          childIds.add(manager.appendMessage(last));
          expect(observed).toEqual([]);
          expect(order).toEqual([]);
          freshReturned = true;
        });
        let caught: { error: unknown } | undefined;
        try {
          if (mode === "ready") {
            manager.appendMessage(parent, { beforeFreshMessageCommit: fresh });
          } else {
            await manager.appendMessageAsync(parent, { beforeFreshMessageCommit: fresh });
          }
        } catch (error) {
          caught = { error };
        }
        assert(caught);
        if (privateFailure) {
          assert(caught.error instanceof SessionTranscriptMessageCommittedError);
          assert(caught.error.cause instanceof AggregateError);
          expect(caught.error.cause.errors[0]).toBe(cleanupFailure);
          expect(caught.error.cause.errors).toContain(observerFailure);
          expect(caught.error).not.toBe(observerFailure);
        } else {
          expect(caught.error).toBe(observerFailure);
          expect(SessionManager.open(target).getEntries()).toEqual(manager.getEntries());
        }
        expect(fresh).toHaveBeenCalledOnce();
        expect(cleanupFaults).toBe(privateFailure ? 1 : 0);
        expect(publishCalls).toBe(2);
        expect(observed).toEqual([first]);
        expect(order.filter((entry) => entry === "child-publication")).toHaveLength(1);
        expect(order).not.toContain("parent-publication");
        expect(order.at(-1)).toBe("observer");
        expect(read()).toEqual([
          expect.objectContaining({ content: "opening turn" }),
          first,
          last,
          parent,
        ]);
        if (privateFailure) {
          // Committed ledger facts survive private cleanup failure, but an
          // unadopted manager view cannot select active calls or authorize replay.
          for (const readView of [guard.getPendingIds, () => manager.getEntries()]) {
            let failure: { error: unknown } | undefined;
            try {
              readView();
            } catch (error) {
              failure = { error };
            }
            assert(failure);
            expect(failure.error).toBe(caught.error);
          }
          const owner = manager[sessionToolResultPending];
          expect(owner.pending.calls(owner.owner).map((call) => call.id)).toEqual([
            "settled-before-observation",
          ]);
        } else {
          expect(guard.getPendingIds()).toEqual(["settled-before-observation"]);
        }
        expect(observed).toEqual([first]);
      } finally {
        runtimeSpy.mockRestore();
        admissionSpy.mockRestore();
        scopeSpy.mockRestore();
      }
    });
  },
);

it("retains the exact host failure when a rollback owner adds its own cleanup failure", async () => {
  await withReadyManager(async ({ manager, read }) => {
    const hostFailure = new Error("original fresh callback failed");
    const cleanupFailure = new Error("private rollback owner failed");
    const before = manager.getEntries();
    const createSettlement = appendReceipt.createSessionMessageAppendSettlement;
    const observer = vi
      .spyOn(appendReceipt, "createSessionMessageAppendSettlement")
      .mockImplementation((...args) => {
        const retained = createSettlement(...args);
        const settle = retained.settle;
        let failed = false;
        retained.settle = (...settlement) => {
          settle(...settlement);
          if (!failed && retained.outcome === "rolled-back") {
            failed = true;
            throw cleanupFailure;
          }
        };
        return retained;
      });
    try {
      let caught: unknown;
      try {
        manager.appendMessage(
          { role: "user", content: "must roll back", timestamp: 2 },
          {
            beforeFreshMessageCommit() {
              throw hostFailure;
            },
          },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      expect(caught).not.toBe(hostFailure);
      expect((caught as AggregateError).cause).toBe(hostFailure);
      const nested: unknown[] = [caught];
      for (const error of nested) {
        if (error instanceof AggregateError) {
          nested.push(...error.errors);
        }
      }
      expect(nested).toContain(cleanupFailure);
      expect(manager.getEntries()).toEqual(before);
      expect(read()).toMatchObject([{ content: "opening turn" }]);
    } finally {
      observer.mockRestore();
    }
  });
});

it("keeps nested reads on independently authorized logical connections without disturbing the outer cursor", async () => {
  await withReadyManager(async ({ manager, target, read }) => {
    const siblingTarget = {
      ...target,
      sessionId: "same-connection",
      sessionKey: "agent:main:dashboard:incognito-sibling",
    };
    const sibling = SessionManager.open(siblingTarget);
    sibling.appendMessage({ role: "user", content: "same connection", timestamp: 1 });
    const foreignTarget = {
      ...target,
      agentId: "foreign",
      sessionId: "foreign-session",
      sessionKey: "agent:foreign:dashboard:incognito-foreign",
      storePath: agentDatabase.resolveIncognitoOpenClawAgentSqlitePath({
        agentId: "foreign",
        env: target.env,
      }),
    };
    const foreign = SessionManager.open(foreignTarget);
    foreign.appendMessage({ role: "user", content: "independent connection", timestamp: 1 });
    const foreignRead = vi.fn((messages: Iterable<AgentMessage>) => [...messages]);
    const before = manager.getEntries();
    SessionManager.readSessionContext(target, (messages) => {
      const outer = messages[Symbol.iterator]();
      expect(outer.next()).toMatchObject({ done: false, value: { content: "opening turn" } });
      expect(
        SessionManager.readSessionContext(siblingTarget, (siblingMessages) => [...siblingMessages]),
      ).toMatchObject([{ content: "same connection" }]);
      expect(SessionManager.readSessionContext(foreignTarget, foreignRead)).toMatchObject([
        { content: "independent connection" },
      ]);
      expect(foreignRead).toHaveBeenCalledOnce();
      expect(manager.getEntries()).toEqual(before);
      expect(outer.next()).toEqual({ done: true, value: undefined });
      manager.appendCustomEntry("following-independent-read", { kept: true });
      expect(read()).toMatchObject([{ content: "opening turn" }]);
    });
    expect(manager.getEntries().at(-1)).toMatchObject({
      type: "custom",
      customType: "following-independent-read",
    });
    expect(SessionManager.open(target).getEntries()).toEqual(manager.getEntries());
    expect(
      SessionManager.readSessionContext(foreignTarget, (messages) => [...messages]),
    ).toMatchObject([{ content: "independent connection" }]);
  });
});

it.skipIf(Boolean(process.versions.bun)).each(["commit", "rollback"] as const)(
  "keeps a scoped %s outcome UNKNOWN when the actual data worker exits before its receipt",
  async (boundary) => {
    await withReadyManager(async ({ manager }) => {
      const observed = vi.fn();
      installSessionToolResultGuard(manager, { onMessagePersisted: observed });
      const before = manager.getEntries();
      const hostFailure = new Error("public callback requested rollback");
      const control = new Int32Array(nativeFault.control);
      const beforeFresh = vi.fn(() => {
        Atomics.store(control, 0, boundary === "commit" ? 1 : 2);
        if (boundary === "rollback") {
          throw hostFailure;
        }
      });
      let failure: unknown;
      try {
        manager.appendMessage(
          { role: "user", content: "lost scoped outcome", timestamp: 2 },
          {
            beforeFreshMessageCommit: beforeFresh,
          },
        );
      } catch (error) {
        failure = error;
      }
      expect(beforeFresh).toHaveBeenCalledOnce();
      expect(Atomics.load(control, boundary === "commit" ? 1 : 2)).toBe(1);
      expect(isSqliteWorkerError(failure, "outcome-unknown")).toBe(true);
      expect(failure).not.toBe(hostFailure);
      expect(observed).not.toHaveBeenCalled();
      expect(manager.getEntries()).toEqual(before);
      expect(() =>
        manager.appendMessage({ role: "user", content: "no replay", timestamp: 3 }),
      ).toThrow();
    });
  },
);

it.skipIf(Boolean(process.versions.bun)).each(["commit", "rollback"] as const)(
  "retains both original actor owners when an independent child %s loses its native receipt",
  async (boundary) => {
    await withReadyManager(async ({ manager, target, durable }) => {
      assert.ok(durable);
      const before = manager.getEntries();
      const observed = vi.fn();
      installSessionToolResultGuard(manager, { onMessagePersisted: observed });
      const control = new Int32Array(nativeFault.control);
      type HostScope = ReturnType<typeof scopedRuntime.createSqliteWorkerHostScope>;
      const scopes = new Map<"A" | "B", HostScope>();
      const actors = new Map<HostScope, Parameters<HostScope["bind"]>[0]>();
      const settlements: Array<{
        owner: "A" | "B";
        settlement: Parameters<HostScope["settleChildren"]>[0];
        committed: boolean | undefined;
      }> = [];
      const createScope = scopedRuntime.createSqliteWorkerHostScope;
      const scopeSpy = vi
        .spyOn(scopedRuntime, "createSqliteWorkerHostScope")
        .mockImplementation((run, ...args) => {
          const scope = createScope(
            (step, cursor) => {
              if (step.kind === "fresh-input") {
                const actor = actors.get(scope);
                assert(actor);
                scopes.set(actor.volatile ? "B" : "A", scope);
              }
              return run(step, cursor);
            },
            ...args,
          );
          const bind = scope.bind;
          scope.bind = (actor, ...bindingArgs) => {
            bind(actor, ...bindingArgs);
            actors.set(scope, actor);
          };
          const settleChildren = scope.settleChildren;
          scope.settleChildren = (settlement, committed) => {
            try {
              return settleChildren(settlement, committed);
            } finally {
              const owner =
                scopes.get("A") === scope ? "A" : scopes.get("B") === scope ? "B" : undefined;
              if (owner) {
                settlements.push({ owner, settlement, committed });
              }
            }
          };
          return scope;
        });
      let execution: ReturnType<typeof captureOpenClawAgentDatabaseExecution> | undefined;
      let runtime: ReturnType<typeof messageRuntime.createSessionManagerMessageRuntime> | undefined;
      try {
        const childFailure = new Error("independent B requested rollback");
        const fresh = vi.fn(() => {
          Atomics.store(control, 0, boundary === "commit" ? 1 : 2);
          if (boundary === "rollback") {
            throw childFailure;
          }
        });
        let childError: unknown;
        const predicate = vi.fn(() => {
          try {
            manager.appendMessage(
              { role: "user", content: "independent lost receipt", timestamp: 3 },
              { beforeFreshMessageCommit: fresh },
            );
          } catch (error) {
            childError = error;
            throw error;
          }
        });
        const scope = { ...durable, sessionId: "outer-durable", env: target.env };
        const options = { agentId: scope.agentId, path: scope.storePath, env: scope.env };
        const adopt = vi.fn();
        const publish = vi.fn();
        const commit = vi.fn();
        const publishCommit = vi.fn();
        const pending = createSessionToolResultPending();
        // This lower runtime still owns a durable actor's live host continuation;
        // public durable entry patches use their synchronous native commit owner.
        const outcome = await runOpenClawAgentWriteAdmission(options, async () => {
          const retained = captureOpenClawAgentDatabaseExecution(options);
          execution = retained;
          const assertCurrent = () => retained.assertCurrent();
          const host = captureOpenClawAgentHostExecution(options);
          runtime = messageRuntime.createSessionManagerMessageRuntime({
            execution: retained,
            scope,
            pending,
            assertCurrent,
            commit,
            publishCommit,
          });
          return runtime.append(
            {
              cwd: manager.getCwd(),
              message: { role: "user", content: "uncommitted A", timestamp: 2 },
            },
            { beforeFreshMessageCommit: predicate },
            { adopt, publish, assertCurrent, host },
          );
        });
        const diagnostic = inspect(
          { outer: outcome, child: childError, settlements },
          { depth: null },
        );
        const outerScope = scopes.get("A");
        const childScope = scopes.get("B");
        assert(outerScope && childScope, diagnostic);
        const outerActor = actors.get(outerScope);
        const childActor = actors.get(childScope);
        assert(outerActor && childActor, diagnostic);
        expect(outerActor, diagnostic).not.toBe(childActor);
        expect(outerActor.volatile, diagnostic).toBeUndefined();
        expect(childActor.volatile, diagnostic).toBe(true);
        expect(outerActor.slot, diagnostic).toBe(childActor.slot);
        expect(predicate, diagnostic).toHaveBeenCalledOnce();
        expect(fresh, diagnostic).toHaveBeenCalledOnce();
        expect(Atomics.load(control, boundary === "commit" ? 1 : 2), diagnostic).toBe(1);
        expect(Atomics.load(control, 0), diagnostic).toBe(0);
        expect(isSqliteWorkerError(childError, "outcome-unknown"), diagnostic).toBe(true);
        const outerSettlement = settlements.filter((entry) => entry.owner === "A");
        const childSettlement = settlements.filter((entry) => entry.owner === "B");
        expect(outerSettlement, diagnostic).toHaveLength(1);
        expect(childSettlement, diagnostic).toHaveLength(1);
        const outer = outerSettlement[0]!;
        const child = childSettlement[0]!;
        assert(outer.settlement.kind === "unknown", diagnostic);
        assert(child.settlement.kind === "unknown", diagnostic);
        expect(outer.committed, diagnostic).toBe(false);
        expect(child.committed, diagnostic).toBe(false);
        const nativeLoss = outer.settlement.error;
        expect(child.settlement.error, diagnostic).toBe(nativeLoss);
        expect(nativeLoss, diagnostic).toMatchObject({
          message: "SQLite data worker exited with code 19",
        });
        assert(outcome.kind === "unknown", diagnostic);
        const seen = new Set<unknown>();
        let childOccurrences = 0;
        const assertFailure = (error: unknown): void => {
          if (error === nativeLoss) {
            return;
          }
          assert(!seen.has(error), diagnostic);
          seen.add(error);
          if (error === childError) {
            childOccurrences += 1;
            // The host lost-owner guard precedes the native exit witness. Only
            // this exact cause-less leaf is independent of the later nativeLoss.
            if (
              isSqliteWorkerError(error, "outcome-unknown") &&
              error.message === "SQLite scoped operation lost its native owner" &&
              !("cause" in error) &&
              !("errors" in error)
            ) {
              return;
            }
          }
          if (error instanceof AggregateError) {
            assert(Array.isArray(error.errors) && error.errors.length > 0, diagnostic);
            expect(error.cause, diagnostic).toBe(error.errors[0]);
            // Cause repeats the first edge; inspect each failure branch only once.
            for (const nested of error.errors) {
              assertFailure(nested);
            }
            return;
          }
          assert(isSqliteWorkerError(error, "outcome-unknown"), diagnostic);
          expect(error.cause, diagnostic).toBe(nativeLoss);
          assertFailure(error.cause);
        };
        assertFailure(outcome.error);
        expect(childOccurrences, diagnostic).toBe(1);
        expect(outcome.error).not.toBe(childFailure);
        expect(adopt).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
        expect(publishCommit).not.toHaveBeenCalled();
        expect(pending.size).toBe(0);
        expect(observed).not.toHaveBeenCalled();
        expect(manager.getEntries()).toEqual(before);
        expect(() =>
          manager.appendMessage({ role: "user", content: "no child replay", timestamp: 4 }),
        ).toThrow();
      } finally {
        try {
          if (runtime) {
            await runtime.close();
          } else {
            await execution?.release();
          }
        } finally {
          scopeSpy.mockRestore();
        }
      }
    }, true);
  },
);

it("runs the public fresh callback once on its caller stack and preserves current-key replay", async () => {
  await withReadyManager(async ({ manager, target, read }) => {
    let callerActive = false;
    const beforeFresh = vi.fn(() => {
      expect(callerActive).toBe(true);
      expect(read()).toMatchObject([{ content: "opening turn" }]);
      manager.appendCustomEntry("fresh-callback", { nested: true });
    });
    const original = {
      role: "user" as const,
      content: "stored body",
      timestamp: 2,
      idempotencyKey: "fresh-key",
    };
    callerActive = true;
    const id = manager.appendMessage(original, { beforeFreshMessageCommit: beforeFresh });
    callerActive = false;
    expect(beforeFresh).toHaveBeenCalledOnce();
    const before = manager.getEntries();
    expect(
      manager.appendMessage(
        { ...original, content: "ignored replay body" },
        {
          beforeFreshMessageCommit: beforeFresh,
        },
      ),
    ).toBe(id);
    expect(beforeFresh).toHaveBeenCalledOnce();
    expect(manager.getEntries()).toEqual(before);
    expect(SessionManager.readSessionContext(target, (messages) => [...messages])).toMatchObject([
      { content: "opening turn" },
      { content: "stored body" },
    ]);
  });
});

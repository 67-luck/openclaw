import { afterEach, assert, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import {
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { readSessionTranscriptContextMessages } from "../../config/sessions/session-accessor.sqlite-model-context.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import {
  captureOpenClawAgentDatabaseExecution,
  retainGatewaySessionBroker,
} from "../../state/openclaw-agent-execution.js";
import {
  captureOpenClawAgentHostExecution,
  runOpenClawAgentWriteAdmission,
} from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSessionToolResultPending } from "../session-tool-result-pending.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import * as messageRuntime from "./session-manager-message-runtime.js";
import * as metadataRuntime from "./session-manager-metadata-runtime.js";
import { SessionManager } from "./session-manager.js";
import type { SessionMessageAppendOutcome } from "./session-message-append-operation.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 1,
}));

afterEach(() => vi.restoreAllMocks());

it("keeps cold durable OPEN unscoped while retaining the message append callback scope", async () => {
  type AdmissionFactory = operationAdmission.SqliteWorkerAdmissionFactory;
  type Admission = ReturnType<AdmissionFactory>;
  type Grant = {
    stage: operationAdmission.SqliteWorkerAdmissionRequest["stage"];
    granted: boolean;
  };
  type Observation = {
    retained: Admission;
    settled: Parameters<AdmissionFactory>[0]["settled"];
    lifetime: string[];
    settlements: Parameters<NonNullable<Admission["admission"]["scope"]>["settleChildren"]>[];
  };
  const grants = new Map<Admission["admission"], Grant[]>();
  const opens: Array<{
    result: ReturnType<typeof workerStore.openAgentDatabaseSqliteWorkerStore>;
    admissions: Observation[];
  }> = [];
  const operations: Array<{
    store: Parameters<typeof workerStore.runSqliteWorkerStoreOperation>[0];
    commands: PropertyKey[];
    admissions: Observation[];
  }> = [];
  const observe = (factory: AdmissionFactory, rows: Observation[]): AdmissionFactory =>
    operationAdmission.createSqliteWorkerAdmissionFactory(
      factory.requiresHostContinuation,
      function (this: unknown, operation) {
        const retained = factory.call(this, operation);
        const row: Observation = {
          retained,
          settled: operation.settled,
          lifetime: [],
          settlements: [],
        };
        rows.push(row);
        const scope = retained.admission.scope;
        if (scope) {
          const { bind, settleChildren, close } = scope;
          vi.spyOn(scope, "bind").mockImplementation((...args) => {
            const result = bind.apply(scope, args);
            row.lifetime.push("bind");
            return result;
          });
          vi.spyOn(scope, "settleChildren").mockImplementation((...args) => {
            const result = settleChildren.apply(scope, args);
            row.settlements.push(args);
            row.lifetime.push("settle");
            return result;
          });
          vi.spyOn(scope, "close").mockImplementation(() => {
            try {
              return close.call(scope);
            } finally {
              row.lifetime.push("close");
            }
          });
        }
        return retained;
      },
    );
  const fresh = vi.fn();
  const commit = vi.fn();
  const publishCommit = vi.fn();
  const adopt = vi.fn();
  const publish = vi.fn();
  const message = { role: "user" as const, content: "cold durable append", timestamp: 2 };
  let outcome: SessionMessageAppendOutcome | undefined;
  let persisted: AgentMessage[] | undefined;
  const failures: unknown[] = [];
  await withOpenClawTestState({ label: "cold-durable-message-scope" }, async (state) => {
    const database = agentDatabase.openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const target = {
      agentId: "main",
      sessionId: "cold-durable-message",
      sessionKey: "agent:main:cold-durable-message",
      storePath: database.path,
      env: state.env,
    };
    writeSessionEntry(database, target.sessionKey, { sessionId: target.sessionId, updatedAt: 1 });
    await agentDatabase.closeOpenClawAgentDatabaseByPathAsync(database.path);
    const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
    const admissionSpy = vi
      .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment, scope) => {
        const decisions: Grant[] = [];
        const admission = createAdmission(
          (request, grant) =>
            admit(request, () => {
              const granted = grant();
              decisions.push({ stage: request.stage, granted });
              return granted;
            }),
          attachment,
          scope,
        );
        grants.set(admission, decisions);
        return admission;
      });
    const openStore = workerStore.openAgentDatabaseSqliteWorkerStore;
    const openSpy = vi
      .spyOn(workerStore, "openAgentDatabaseSqliteWorkerStore")
      .mockImplementation((options, custody) => {
        if (options.databasePath !== target.storePath) {
          return openStore(options, custody);
        }
        const admissions: Observation[] = [];
        const result = openStore(options, {
          ...custody,
          createAdmission: observe(custody.createAdmission, admissions),
        });
        opens.push({ result, admissions });
        return result;
      });
    const runOperation = workerStore.runSqliteWorkerStoreOperation;
    const operationSpy = vi
      .spyOn(workerStore, "runSqliteWorkerStoreOperation")
      .mockImplementation((store, operation, context, assertCurrent, factory, requireLifecycle) => {
        const observed: (typeof operations)[number] = { store, commands: [], admissions: [] };
        operations.push(observed);
        return runOperation(
          store,
          (scope) =>
            operation({
              ...scope,
              execute(command, options) {
                observed.commands.push(command.type);
                return scope.execute(command, options);
              },
            }),
          context,
          assertCurrent,
          factory && observe(factory, observed.admissions),
          requireLifecycle,
        );
      });
    let broker: ReturnType<typeof retainGatewaySessionBroker> | undefined;
    let execution: ReturnType<typeof captureOpenClawAgentDatabaseExecution> | undefined;
    let runtime: ReturnType<typeof messageRuntime.createSessionManagerMessageRuntime> | undefined;
    try {
      broker = retainGatewaySessionBroker();
      await broker.ready;
      const options = { agentId: target.agentId, path: target.storePath, env: target.env };
      outcome = await runOpenClawAgentWriteAdmission(options, async () => {
        const retained = captureOpenClawAgentDatabaseExecution(options);
        execution = retained;
        const assertCurrent = () => retained.assertCurrent();
        const host = captureOpenClawAgentHostExecution(options);
        runtime = messageRuntime.createSessionManagerMessageRuntime({
          execution: retained,
          scope: target,
          pending: createSessionToolResultPending(),
          assertCurrent,
          commit,
          publishCommit,
        });
        return runtime.append(
          { cwd: state.workspaceDir, message },
          { beforeFreshMessageCommit: fresh },
          { adopt, publish, assertCurrent, host },
        );
      });
      if (outcome.kind === "unknown" || outcome.kind === "not-committed") {
        failures.push(outcome.error);
      }
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        if (runtime) {
          await runtime.close();
        } else {
          await execution?.release();
        }
      } catch (error) {
        failures.push(error);
      }
      try {
        await agentDatabase.closeOpenClawAgentDatabaseByPathAsync(target.storePath);
        if (outcome?.kind === "committed") {
          persisted = readSessionTranscriptContextMessages(target, (messages) => [...messages]);
        }
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          await agentDatabase.closeOpenClawAgentDatabaseByPathAsync(target.storePath);
        } catch (error) {
          failures.push(error);
        }
        try {
          await broker?.stop();
        } catch (error) {
          failures.push(error);
        }
        operationSpy.mockRestore();
        openSpy.mockRestore();
        admissionSpy.mockRestore();
      }
    }
  }).catch((error: unknown) => {
    failures.push(error);
  });
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length) {
    throw new AggregateError(failures, "Cold durable append and cleanup failed", {
      cause: failures[0],
    });
  }
  expect(opens).toHaveLength(1);
  const opening = opens[0]!;
  const store = await opening.result;
  expect(store).toBeDefined();
  expect(opening.admissions).toHaveLength(1);
  const opened = opening.admissions[0]!;
  expect(grants.get(opened.retained.admission)).toContainEqual({ stage: "open", granted: true });
  expect(await opened.settled).toEqual({ kind: "completed" });
  expect(opened.retained.admission.failure).toBeUndefined();
  expect(opened.retained.admission.scope).toBeUndefined();
  const executed = operations.filter((operation) => operation.store === store);
  expect(executed.map((operation) => operation.commands)).toEqual([
    ["database.prepareWrite"],
    ["database.domain.run"],
  ]);
  for (const operation of executed) {
    expect(operation.admissions).toHaveLength(1);
    const observed = operation.admissions[0]!;
    expect(observed.retained.admission.scope).toBeDefined();
    // Host custody is observed here; native prepareWrite consumption is a worker contract.
    expect(observed.lifetime).toEqual(["bind", "settle", "close"]);
    expect(observed.settlements).toEqual([
      [{ kind: "completed" }, operation.commands[0] === "database.domain.run"],
    ]);
    expect(await observed.settled).toEqual({ kind: "completed" });
    expect(observed.retained.admission.failure).toBeUndefined();
    const decisions = grants.get(observed.retained.admission);
    assert(decisions && decisions.length > 0);
    expect(decisions.every((grant) => grant.granted)).toBe(true);
  }
  expect(fresh).toHaveBeenCalledOnce();
  assert(outcome?.kind === "committed");
  expect(outcome.failures).toEqual([]);
  expect(outcome.facts.receipt.appended).toBe(true);
  expect(commit).toHaveBeenCalledExactlyOnceWith(outcome.facts);
  expect(publishCommit).toHaveBeenCalledExactlyOnceWith(outcome.facts);
  expect(adopt).toHaveBeenCalledExactlyOnceWith(outcome.value);
  expect(publish).toHaveBeenCalledExactlyOnceWith(outcome.value);
  expect(persisted).toEqual([message]);
});

it.each(["message", "metadata"] as const)(
  "publishes the original durable identity for async %s-first initialization",
  async (first) => {
    await withOpenClawTestState({ label: "durable-initial-identity" }, async (state) => {
      const database = agentDatabase.openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const originalIdentity = readOpenClawAgentDatabaseIdentity(database).identity;
      const target = {
        agentId: "main",
        sessionId: "durable-initial-identity",
        sessionKey: "agent:main:durable-initial-identity",
        storePath: database.path,
        env: state.env,
      };
      const manager = SessionManager.open(target);
      const events: SessionIdentityMutation[] = [];
      const outcomes: SessionMessageAppendOutcome[] = [];
      const createRuntime = messageRuntime.createSessionManagerMessageRuntime;
      const messageSpy = vi
        .spyOn(messageRuntime, "createSessionManagerMessageRuntime")
        .mockImplementation((params) => {
          const runtime = createRuntime(params);
          return {
            ...runtime,
            async append(...args) {
              const outcome = await runtime.append(...args);
              outcomes.push(outcome);
              return outcome;
            },
          };
        });
      const metadataSpy = vi.spyOn(metadataRuntime, "withSessionMetadataWorker");
      const stop = onSessionIdentityMutation((event) => {
        if (event.kind !== "delete" && event.current.sessionKeys.includes(target.sessionKey)) {
          events.push(event);
        }
      });
      const assistant = () =>
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "worker initialization identity" }],
        });
      try {
        expect(events).toEqual([]);
        if (first === "message") {
          await manager.appendMessageAsync(assistant());
          expect(outcomes).toHaveLength(1);
          expect(outcomes[0]).toMatchObject({
            kind: "committed",
            facts: {
              kind: "manager",
              initial: { identity: { databaseIdentity: originalIdentity } },
            },
          });
        } else {
          await manager.appendModelChange("openai", "fixture-model");
          expect(metadataSpy).toHaveBeenCalledOnce();
        }
        expect(events).toEqual([
          expect.objectContaining({
            kind: "create",
            agentId: target.agentId,
            databaseIdentity: originalIdentity,
            current: { sessionId: target.sessionId, sessionKeys: [target.sessionKey] },
          }),
        ]);
        await manager.appendMessageAsync(assistant());
        await manager.appendModelChange("openai", "fixture-warm-model");
        expect(events).toHaveLength(1);
        expect(readOpenClawAgentDatabaseIdentity(database).identity).toBe(originalIdentity);
      } finally {
        stop();
        messageSpy.mockRestore();
        metadataSpy.mockRestore();
      }
    });
  },
);

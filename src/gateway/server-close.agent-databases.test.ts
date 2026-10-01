import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { type MessagePort, Worker } from "node:worker_threads";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, type TestContext, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  createReplyOperation,
  type ReplyOperation,
} from "../auto-reply/reply/reply-run-registry.js";
import { runGatewayLoop } from "../cli/gateway-cli/run-loop.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { runSqliteSessionReclamation } from "../config/sessions/session-accessor.sqlite-reclamation-run.js";
import { SqliteReclamationWorker } from "../config/sessions/session-accessor.sqlite-reclamation-worker-lifetime.js";
import { createSessionMaintenanceStatisticsOperation } from "../config/sessions/session-accessor.sqlite-reclamation.js";
import * as reconcileDelegation from "../config/sessions/session-transcript-reconcile-delegation.js";
import * as reconcilePool from "../config/sessions/session-transcript-reconcile-pool.js";
import { useReconcileWorkerObserver } from "../config/sessions/session-transcript-reconcile.test-support.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { writeGatewayRestartIntentSync } from "../infra/restart-intent.js";
import type { SqliteIntegrityDiagnostics } from "../infra/sqlite-integrity.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../infra/supervisor-markers.js";
import * as systemdTimeout from "../infra/systemd-stop-timeout.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import * as pluginMetadataLifecycle from "../plugins/plugin-metadata-lifecycle.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeSnapshotState } from "../secrets/runtime-state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { isPidAlive } from "../shared/pid-alive.js";
import {
  beginAgentDeletionJournal,
  completeAgentDeletionJournalInDatabase,
} from "../state/agent-deletion-journal.js";
import {
  assertNoOpenClawAgentDatabaseLeasesReadOnly,
  OpenClawAgentDatabaseLeaseActiveError,
} from "../state/openclaw-agent-db-lease.js";
import { agentDatabaseLifecycle } from "../state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import * as schema from "../state/openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenIncognitoAgentDatabases,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { readOpenClawAgentIntegrityVerification } from "../state/openclaw-quarantine-store.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import type { GatewayServer } from "./server-public.js";

it("closes a Gateway with an active plugin while retaining a deleted agent store", async () => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-retained-deleted-agent-close");
  try {
    const pluginId = fixture.pluginId;
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: pluginId });
    const registered = new PluginInstance(record.id, { record, registry });
    let disposed = false;
    registered.lifecycle.onDispose(() => {
      disposed = true;
    });
    registry.plugins.push(record);
    setActivePluginRegistry(registry);
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    expect(fixture.kernels.get(port)?.pluginRuntime.registry.plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: pluginId })]),
    );
    const activeStore = path.join(fixture.state.sessionsDir("main"), "sessions.json");
    const retainedStore = path.join(fixture.state.sessionsDir("retired"), "sessions.json");
    for (const [agentId, storePath] of [
      ["main", activeStore],
      ["retired", retainedStore],
    ] as const) {
      await replaceSessionEntry(
        { agentId, storePath, sessionKey: `agent:${agentId}:main` },
        {
          sessionId: `${agentId}-session`,
          updatedAt: 1,
          pluginExtensions: { [pluginId]: { active: true } },
        },
      );
    }
    const retainedDatabase = path.join(fixture.state.agentDir("retired"), "openclaw-agent.sqlite");
    const operationId = randomUUID();
    beginAgentDeletionJournal(
      {
        agentId: "retired",
        operationId,
        agentDir: fixture.state.agentDir("retired"),
        sessionsDir: fixture.state.sessionsDir("retired"),
        workspaceDir: path.join(fixture.state.root, "workspace-retired"),
        databasePaths: [retainedDatabase],
        deleteFiles: false,
      },
      { env: fixture.state.env },
    );
    runOpenClawStateWriteTransaction(
      (database) => completeAgentDeletionJournalInDatabase(database, "retired", operationId),
      { env: fixture.state.env },
    );
    await expect(server.close({ reason: "gateway stopping" })).resolves.toBeUndefined();
    expect(disposed).toBe(true);
    expect((await fs.stat(retainedDatabase)).isFile()).toBe(true);
    expect(
      loadSessionEntry({ agentId: "main", storePath: activeStore, sessionKey: "agent:main:main" })
        ?.pluginExtensions,
    ).toBeUndefined();
  } finally {
    await fixture.cleanup();
  }
}, 300_000);

vi.mock("node:worker_threads", async () =>
  (
    await import("../config/sessions/session-transcript-reconcile.test-support.js")
  ).createObservedWorkerThreads(),
);

const reconcileObserver = useReconcileWorkerObserver();
let delegatedGatewayBody: Promise<void> | undefined;

// Vitest can abort its wrapper before this body's finally completes. Stack-ordered
// hooks must join that owner before the observer can terminate workers or reset.
afterEach(async () => {
  const completion = delegatedGatewayBody;
  if (!completion) {
    return;
  }
  try {
    await completion;
  } finally {
    if (delegatedGatewayBody === completion) {
      delegatedGatewayBody = undefined;
    }
  }
});

function retainDelegatedGatewayBody(body: (signal: AbortSignal) => Promise<void>) {
  return ({ signal }: Pick<TestContext, "signal">) => {
    delegatedGatewayBody = body(signal);
    return delegatedGatewayBody;
  };
}

it.skipIf(Boolean(process.versions.bun))(
  "joins delegated DATA finish and compute exit only when the final Gateway closes",
  retainDelegatedGatewayBody(async (signal) => {
    const { Worker: NativeWorker } =
      await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
    expect(Object.getPrototypeOf(Worker.prototype)).toBe(NativeWorker.prototype);
    expect(Object.hasOwn(Worker.prototype, "postMessage")).toBe(false);
    const releaseTask = createDeferredCore();
    const releaseTermination = createDeferredCore();
    const closeEntered = createDeferredCore();
    const terminationEntered = createDeferredCore();
    const nativeExited = createDeferredCore();
    const dataFinished = createDeferredCore<Record<string, unknown>>();
    const aborted = createDeferredCore<never>();
    void aborted.promise.catch(() => undefined);
    const releaseGates = () => {
      releaseTask.resolve();
      releaseTermination.resolve();
    };
    const abort = () => {
      releaseGates();
      aborted.reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    type Start = Parameters<
      typeof reconcileDelegation.createSessionReconcileHostEndpoint
    >[0]["startTask"];
    type Row = {
      input: Parameters<Start>[0];
      port: MessagePort;
      signal: AbortSignal;
      native?: ReturnType<Start>;
      worker?: Worker;
      operation?: unknown;
      dispatches: number;
      closes: number;
    };
    let intendedSessionId: string | undefined;
    let row: Row | undefined;
    let restoreClose: (() => void) | undefined;
    let restorePost: (() => void) | undefined;
    let restoreTerminate: (() => void) | undefined;
    let restoreMetadataClose: (() => void) | undefined;
    const metadataOwners: ReturnType<typeof pluginMetadataLifecycle.retainGatewayPluginMetadata>[] =
      [];
    const retainMetadata = pluginMetadataLifecycle.retainGatewayPluginMetadata;
    const metadataSpy = vi
      .spyOn(pluginMetadataLifecycle, "retainGatewayPluginMetadata")
      .mockImplementation(() => {
        const owner = retainMetadata();
        metadataOwners.push(owner);
        return owner;
      });
    const createEndpoint = reconcileDelegation.createSessionReconcileHostEndpoint;
    const endpointSpy = vi
      .spyOn(reconcileDelegation, "createSessionReconcileHostEndpoint")
      .mockImplementation((params) => {
        const endpoint = createEndpoint({
          ...params,
          startTask(input, port, taskSignal) {
            if (input.sessionIds.length !== 1 || input.sessionIds[0] !== intendedSessionId) {
              return params.startTask(input, port, taskSignal);
            }
            row = { input, port, signal: taskSignal, dispatches: 0, closes: 0 };
            const captured = row;
            const native = params.startTask(input, port, taskSignal);
            captured.native = native;
            const close = native.close;
            const closeSpy = vi.spyOn(native, "close").mockImplementation((...args) => {
              captured.closes++;
              closeEntered.resolve();
              // Hold before the original close: a resolved close Promise no longer owns capacity.
              return releaseTask.promise.then(() => close.apply(native, args));
            });
            restoreClose = () => closeSpy.mockRestore();
            return native;
          },
        });
        const host = reconcileObserver.parents.get(endpoint.port)?.port;
        assert(host);
        host.on("message", (message: unknown) => {
          if (row && isRecord(message) && message.kind === "start" && row.port === message.port) {
            row.operation = message.operation;
          }
        });
        const post = host.postMessage.bind(host);
        const postSpy = vi.spyOn(host, "postMessage").mockImplementation(function (...args) {
          const result = post(...args);
          const [message] = args;
          if (
            isRecord(message) &&
            message.kind === "finish" &&
            message.operation === row?.operation
          ) {
            dataFinished.resolve(message);
          }
          return result;
        });
        restorePost = () => postSpy.mockRestore();
        return endpoint;
      });
    const dispatchSpy = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      ...args: Parameters<Worker["postMessage"]>
    ) {
      const [message] = args;
      if (
        row &&
        isRecord(message) &&
        isRecord(message.input) &&
        message.input.port === row.port &&
        message.input.input === row.input
      ) {
        row.worker = this;
        row.dispatches++;
      }
      return NativeWorker.prototype.postMessage.apply(this, args);
    });
    type Fixture = Awaited<ReturnType<typeof createGatewayMetadataCloseFixture>>;
    let creatingFixture: Promise<Fixture> | undefined;
    let fixture: Fixture | undefined;
    let initialPoolClose: Promise<void> | undefined;
    const startingGateways: ReturnType<Fixture["start"]>[] = [];
    let finalClose: Promise<void> | undefined;
    let finalSettled = false;
    let nativeCalls = 0;
    const failures: unknown[] = [];
    try {
      creatingFixture = createGatewayMetadataCloseFixture("gateway-delegated-drain");
      fixture = await racePromiseWithAbortSignal(creatingFixture, signal);
      const ownedFixture = fixture;
      const startGateway = () => {
        const starting = ownedFixture.reservePort().then((port) => ownedFixture.start(port));
        startingGateways.push(starting);
        return starting;
      };
      initialPoolClose = reconcilePool.closeSessionTranscriptReconcileWorkerPool();
      await racePromiseWithAbortSignal(initialPoolClose, signal);
      const first = await racePromiseWithAbortSignal(startGateway(), signal);
      const last = await racePromiseWithAbortSignal(startGateway(), signal);
      // This budget measures delegated drain, not real Gateway startup.
      const deadline = performance.now() + 30_000;
      const observe = <T>(promise: PromiseLike<T>, phase: string) => {
        const remaining = Math.min(10_000, deadline - performance.now());
        const result = Promise.race([promise, aborted.promise]);
        if (remaining <= 0) {
          void result.catch(() => undefined);
          return Promise.reject(new Error(`Gateway delegated observation deadline: ${phase}`));
        }
        return withTestTimeout(result, remaining, `Gateway did not observe ${phase}`);
      };
      expect(metadataOwners).toHaveLength(2);
      const finalMetadata = metadataOwners[1];
      assert(finalMetadata);
      expect(endpointSpy).toHaveBeenCalledTimes(1);
      const broker = agentDatabaseLifecycle.gatewayExecution;
      assert(broker);
      const endpoint = broker.projection;
      const state = fixture.state;
      const options = { agentId: "main", env: state.env };
      const agent = openOpenClawAgentDatabase(options);
      const shared = openOpenClawStateDatabase({ env: state.env }).db;
      const target = {
        ...options,
        sessionId: "gateway-delegated-drain",
        sessionKey: "agent:main:dashboard:incognito-delegated-drain",
        storePath: resolveIncognitoOpenClawAgentSqlitePath(options),
      };
      const manager = SessionManager.open(target, state.workspaceDir);
      const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
      manager.appendMessage({ role: "user", content: "abandoned", timestamp: 2 });
      manager.branch(root);
      intendedSessionId = target.sessionId;
      manager.appendCustomEntry("delegated-reconcile", { branch: root });
      await observe(closeEntered.promise, "completed task held before close");
      assert(row?.native && row.worker);
      const original = row;
      const task = row.native;
      const controller = row.signal;
      const worker = row.worker;
      const result = task.result;
      await expect(observe(result, "actual native result")).resolves.toBeUndefined();
      let computeExited = false;
      const teardownOrder: string[] = [];
      const teardownObservations: {
        boundary: "registry-retirement" | "final-close";
        computeExited: boolean;
        threadId: number;
      }[] = [];
      const recordTeardown = (boundary: "registry-retirement" | "final-close") => {
        teardownOrder.push(boundary);
        teardownObservations.push({ boundary, computeExited, threadId: worker.threadId });
      };
      worker.once("exit", () => {
        computeExited = true;
        teardownOrder.push("compute-exit");
        nativeExited.resolve();
      });
      const closeMetadata = finalMetadata.close;
      const metadataCloseSpy = vi
        .spyOn(finalMetadata, "close")
        .mockImplementation((onFinal, retireRegistry) =>
          closeMetadata.call(
            finalMetadata,
            onFinal,
            retireRegistry &&
              (() => {
                recordTeardown("registry-retirement");
                return retireRegistry();
              }),
          ),
        );
      restoreMetadataClose = () => metadataCloseSpy.mockRestore();
      const terminate = worker.terminate.bind(worker);
      const terminateSpy = vi.spyOn(worker, "terminate").mockImplementation(() => {
        terminationEntered.resolve();
        return releaseTermination.promise.then(() => {
          nativeCalls++;
          return terminate();
        });
      });
      restoreTerminate = () => terminateSpy.mockRestore();
      expect(row.dispatches).toBe(1);
      expect(row.closes).toBe(1);
      expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
        workers: 1,
        activeTasks: 1,
        pendingTasks: 1,
      });
      await observe(first.close({ reason: "sibling stopping" }), "sibling close");
      expect(agentDatabaseLifecycle.gatewayExecution).toBe(broker);
      expect(broker.projection).toBe(endpoint);
      expect(broker.phase).toBe("ready");
      expect(broker.dataClosed).toBe(false);
      expect(row).toBe(original);
      expect(row.native).toBe(task);
      expect(task.result).toBe(result);
      expect(row.signal).toBe(controller);
      expect(controller.aborted).toBe(false);
      expect(worker.threadId).toBeGreaterThan(0);
      expect(nativeCalls).toBe(0);
      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).toThrow(
        OpenClawAgentDatabaseLeaseActiveError,
      );
      finalClose = last.close({ reason: "final delegated drain" }).finally(() => {
        recordTeardown("final-close");
        finalSettled = true;
      });
      void finalClose.catch(() => undefined);
      await observe(
        new Promise<void>((resolve) => {
          if (controller.aborted) {
            resolve();
          } else {
            controller.addEventListener("abort", () => resolve(), { once: true });
          }
        }),
        "final logical-owner revocation",
      );
      expect(finalSettled).toBe(false);
      expect(row.closes).toBe(1);
      expect(nativeCalls).toBe(0);
      releaseTask.resolve();
      await expect(observe(dataFinished.promise, "actual DATA finish")).resolves.not.toHaveProperty(
        "error",
      );
      await observe(terminationEntered.promise, "final compute pool retirement");
      // DATA can already be closed here. Only the final Gateway joins the idle
      // compute pool before registry retirement and release of database leases.
      expect(finalSettled).toBe(false);
      expect(worker.threadId).toBeGreaterThan(0);
      expect(nativeCalls).toBe(0);
      expect(reconcilePool.getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
        workers: 1,
        activeTasks: 0,
        pendingTasks: 0,
      });
      expect(getActiveSecretsRuntimeSnapshotState()).not.toBeNull();
      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).toThrow(
        OpenClawAgentDatabaseLeaseActiveError,
      );
      releaseTermination.resolve();
      await observe(finalClose, "final Gateway close");
      expect(teardownOrder).toEqual(["compute-exit", "registry-retirement", "final-close"]);
      expect(teardownObservations).toEqual([
        { boundary: "registry-retirement", computeExited: true, threadId: -1 },
        { boundary: "final-close", computeExited: true, threadId: -1 },
      ]);
      await observe(nativeExited.promise, "real compute worker exit");
      expect(worker.threadId).toBe(-1);
      expect(nativeCalls).toBe(1);
      expect(row.dispatches).toBe(1);
      expect(row.closes).toBe(1);
      expect(broker.dataClosed).toBe(true);
      expect(agentDatabaseLifecycle.gatewayExecution).toBeUndefined();
      expect(agent.db.isOpen).toBe(false);
      expect(shared.isOpen).toBe(false);
      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).not.toThrow();
    } catch (error) {
      failures.push(error);
    } finally {
      releaseGates();
      const joinCleanup = async (cleanup: () => Promise<unknown>) => {
        try {
          await cleanup();
        } catch (error) {
          if (!failures.includes(error)) {
            failures.push(error);
          }
        }
      };
      try {
        // Observation timeouts do not cancel setup. Join late registration before
        // fixture cleanup can enumerate its servers or restore its global spies.
        await joinCleanup(async () => {
          fixture ??= await creatingFixture;
        });
        await joinCleanup(async () => {
          await initialPoolClose;
        });
        await Promise.all(startingGateways.map((starting) => joinCleanup(() => starting)));
        await joinCleanup(async () => {
          await finalClose;
        });
        await joinCleanup(async () => {
          await fixture?.cleanup();
        });
        await joinCleanup(() => reconcilePool.closeSessionTranscriptReconcileWorkerPool());
        await joinCleanup(async () => {
          expect([...reconcileObserver.workers].every((worker) => worker.threadId === -1)).toBe(
            true,
          );
        });
      } finally {
        restoreMetadataClose?.();
        restoreTerminate?.();
        restoreClose?.();
        restorePost?.();
        dispatchSpy.mockRestore();
        endpointSpy.mockRestore();
        metadataSpy.mockRestore();
        signal.removeEventListener("abort", abort);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Gateway delegated observation and cleanup failed", {
        cause: failures[0],
      });
    }
  }),
);

it.each(["stop", "restart"] as const)(
  "releases agent leases for Doctor after the final Gateway %s while its process stays alive",
  async (mode) => {
    const fixture = await createGatewayMetadataCloseFixture(`gateway-agent-leases-${mode}`);
    const ownerPid = process.pid;
    try {
      const first = await fixture.start(await fixture.reservePort());
      const siblingPort = await fixture.reservePort();
      const sibling = await fixture.start(siblingPort);
      const options = { agentId: "main", env: fixture.state.env };
      const agent = openOpenClawAgentDatabase(options);
      const incognitoTarget = {
        ...options,
        sessionId: `gateway-agent-leases-${mode}`,
        sessionKey: `agent:main:dashboard:incognito-${mode}`,
        storePath: resolveIncognitoOpenClawAgentSqlitePath(options),
      };
      const broker = agentDatabaseLifecycle.gatewayExecution;
      assert(broker);
      expect(broker.phase).toBe("ready");
      expect(broker.dataClosed).toBe(false);
      const incognito = SessionManager.open(incognitoTarget, fixture.state.workspaceDir);
      const opening = { role: "user" as const, content: "before Gateway close", timestamp: 1 };
      incognito.appendMessage(opening);
      const readIncognito = () =>
        SessionManager.readSessionContext(incognitoTarget, (messages) => [...messages]);
      expect(readIncognito()).toEqual([opening]);
      // This list observes host handles, not the broker's live Incognito storage.
      expect(listOpenIncognitoAgentDatabases()).toEqual([]);
      const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
      const inspectForDoctor = () =>
        assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env });
      expect(inspectForDoctor).toThrow(OpenClawAgentDatabaseLeaseActiveError);
      const closeOptions = {
        reason: mode === "restart" ? "gateway restarting" : "gateway stopping",
        restartExpectedMs: mode === "restart" ? 1_500 : null,
      };

      await first.close(closeOptions);
      expect(agent.db.isOpen).toBe(true);
      expect(agentDatabaseLifecycle.gatewayExecution).toBe(broker);
      expect(broker.phase).toBe("ready");
      expect(broker.dataClosed).toBe(false);
      const afterFirstClose = { ...opening, content: "after first Gateway close", timestamp: 2 };
      incognito.appendMessage(afterFirstClose);
      expect(readIncognito()).toEqual([opening, afterFirstClose]);
      expect(listOpenIncognitoAgentDatabases()).toEqual([]);
      expect(inspectForDoctor).toThrow(OpenClawAgentDatabaseLeaseActiveError);
      const response = await fetch(`http://127.0.0.1:${siblingPort}/healthz`);
      await response.body?.cancel();
      expect(response.ok).toBe(true);

      await sibling.close(closeOptions);
      expect(process.pid).toBe(ownerPid);
      expect(isPidAlive(ownerPid)).toBe(true);
      expect(inspectForDoctor).not.toThrow();
      expect(agent.db.isOpen).toBe(false);
      expect(shared.isOpen).toBe(false);
      expect(() =>
        incognito.appendMessage({ ...opening, content: "after final Gateway close", timestamp: 3 }),
      ).toThrow("Agent database execution admission is closed");
      expect(broker.phase).toBe("closing");
      // The backend stop receipt does not claim that a pooled carrier exited.
      expect(broker.dataClosed).toBe(true);
      expect(agentDatabaseLifecycle.gatewayExecution).toBeUndefined();
      expect(listOpenIncognitoAgentDatabases()).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "joins agent resources and records a clean witness after a managed SIGTERM drain",
  async () => {
    const fixture = await createGatewayMetadataCloseFixture("gateway-agent-resource-close");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const started = createDeferredCore<GatewayServer>();
    const exited = createDeferredCore<number>();
    const exit = vi.fn((code: number) => exited.resolve(code));
    const completeBoot = vi.fn();
    const previousStops = new Set(process.listeners("SIGTERM"));
    let closing: Promise<void> | undefined;
    let unregister: (() => void) | undefined;
    let stop: ((signal: "SIGTERM") => void) | undefined;
    let operation: ReplyOperation | undefined;
    let execution: ReturnType<typeof captureOpenClawAgentDatabaseExecution> | undefined;
    const writerReleased = createDeferredCore();
    try {
      for (const name of SUPERVISOR_HINT_ENV_VARS) {
        vi.stubEnv(name, undefined);
      }
      vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "external");
      vi.spyOn(systemdTimeout, "readSystemdStopTimeout").mockResolvedValue({
        timeoutMs: 90_000,
        source: "systemd fixture TimeoutStopUSec",
      });
      const port = await fixture.reservePort();
      void runGatewayLoop({
        lockPort: port,
        completeBoot,
        start: async (options) => {
          const server = await fixture.start(port, {
            hostLifecycle: options?.hostLifecycle,
            startupOperation: options?.startupOperation,
          });
          started.resolve(server);
          return server;
        },
        runtime: { log() {}, error() {}, exit },
      }).catch(started.reject);
      const server = await started.promise;
      await nextTurn();
      stop = process.listeners("SIGTERM").find((listener) => !previousStops.has(listener));
      assert(stop);
      const kernel = fixture.kernels.get(port);
      assert(kernel);
      operation = createReplyOperation({
        sessionKey: "agent:main:managed-restart",
        sessionId: "managed-restart",
        resetTriggered: false,
      });
      operation.setPhase("running");
      bindGatewayContextResolver(operation, kernel.resolvePluginGatewayContext);
      operation.abortSignal.addEventListener(
        "abort",
        () => {
          void execution?.release().then(() => {
            operation?.complete();
            writerReleased.resolve();
          }, writerReleased.reject);
        },
        { once: true },
      );
      const options = { agentId: "main", env: fixture.state.env };
      const agent = openOpenClawAgentDatabase(options);
      agent.db.exec("INSERT INTO auth_profile_state VALUES ('restart-proof', '{}', 1)");
      const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
      execution = captureOpenClawAgentDatabaseExecution(options);
      const writer = execution;
      await writer.runExisting(
        {
          assertCurrent: () => writer.assertCurrent(),
          requiresHostContinuation: false,
          createAdmission: (binding) => () => ({
            nativeLocations: binding.nativeLocations,
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              binding.authorize(request);
              writer.assertCurrent();
              assert(grant());
            }, binding.attachment),
          }),
        },
        (scope) =>
          scope.execute({
            type: "session.entries.replace",
            input: {
              expectedRows: new Map(),
              validationKeys: ["agent:main:managed-restart"],
              labelOwnerKeys: [],
              replacements: [
                {
                  sessionKey: "agent:main:managed-restart",
                  entry: { sessionId: "managed-restart", updatedAt: 1 },
                },
              ],
            },
          }),
      );
      const reclamationClose = vi.spyOn(SqliteReclamationWorker.prototype, "close");
      await runSqliteSessionReclamation({
        forceInProcess: false,
        plan: createSessionMaintenanceStatisticsOperation({ ...options, path: agent.path }),
      });
      const hostLeaseCount = shared
        .prepare("SELECT count(*) AS n FROM agent_database_leases WHERE path = ?")
        .get(agent.path)?.n;
      expect(hostLeaseCount).toBe(3);
      // External cleanup can outlive the stop budget; idle writers must not wait for it.
      const removeSidecar = kernel.registerConnectionDependentSidecars({
        async stop() {
          entered.resolve();
          await release.promise;
        },
      });
      unregister = () => {
        removeSidecar();
      };
      expect(
        writeGatewayRestartIntentSync({
          env: fixture.state.env,
          targetPid: process.pid,
          intent: { reason: "gateway.restart", force: true, waitMs: 30_000 },
        }),
      ).toBe(true);
      const close = vi.spyOn(server, "close");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      vi.spyOn(performance, "now").mockImplementation(() => Date.now());
      stop("SIGTERM");
      await vi.advanceTimersByTimeAsync(29_999);
      expect(operation.abortSignal.aborted).toBe(false);
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(close).toHaveBeenCalledWith({
        reason: "gateway restarting",
        restartExpectedMs: 1_500,
        drainTimeoutMs: 0,
      });
      closing = close.mock.results[0]?.value;
      assert(closing);
      await Promise.race([
        entered.promise,
        closing.then(() => {
          throw new Error("Gateway acknowledged closure before its agent resource joined");
        }),
      ]);
      expect(isAgentRunRestartAbortReason(operation.abortSignal.reason)).toBe(true);
      await writerReleased.promise;
      expect(reclamationClose).toHaveBeenCalledOnce();
      await reclamationClose.mock.results[0]?.value;
      expect(
        shared
          .prepare("SELECT count(*) AS n FROM agent_database_leases WHERE path = ?")
          .get(agent.path)?.n,
      ).toBe(1);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(exit).not.toHaveBeenCalled();
      expect(agent.db.isOpen).toBe(true);
      expect(shared.isOpen).toBe(true);
      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env })).toThrow(
        OpenClawAgentDatabaseLeaseActiveError,
      );
      await vi.advanceTimersByTimeAsync(4_999);
      release.resolve();
      await closing;
      await expect(exited.promise).resolves.toBe(0);
      expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
        outcome: "planned_restart",
        reason: expect.stringMatching(/restart \(SIGTERM: gateway\.restart\)$/),
      });
      expect(agent.db.isOpen).toBe(false);
      expect(shared.isOpen).toBe(false);
      expect(() =>
        assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env }),
      ).not.toThrow();
      expect(
        readOpenClawAgentIntegrityVerification(agent.path, fixture.state.env)?.clean_close,
      ).toBe(1);
      closeOpenClawAgentDatabasesForTest(fixture.state.stateDir);
      resetGatewayWorkAdmission();
      const gate = schema.agentDatabaseIntegrityBeforeMutationSteps;
      let diagnostics: SqliteIntegrityDiagnostics | undefined;
      vi.spyOn(schema, "agentDatabaseIntegrityBeforeMutationSteps").mockImplementation(function* (
        ...args
      ) {
        const result = yield* gate(...args);
        diagnostics = args[3];
        return result;
      });
      const reopened = openOpenClawAgentDatabase(options);
      expect(diagnostics?.integrityGateOutcome).toBe("cached");
      expect(
        reopened.db
          .prepare("SELECT state_json FROM auth_profile_state WHERE state_key='restart-proof'")
          .get(),
      ).toEqual({ state_json: "{}" });
    } finally {
      release.resolve();
      operation?.complete();
      await execution?.release();
      await Promise.allSettled([closing]);
      vi.useRealTimers();
      if (!exit.mock.calls.length && stop) {
        stop("SIGTERM");
        await exited.promise;
      }
      unregister?.();
      await fixture.cleanup();
      resetGatewayWorkAdmission();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  },
);

it("rejects Gateway closure when an agent handle cannot close and retains its lease", async () => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-agent-close-failure");
  let restoreClose: (() => void) | undefined;
  try {
    const server = await fixture.start(await fixture.reservePort());
    const agent = openOpenClawAgentDatabase({ agentId: "main", env: fixture.state.env });
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    const failure = new Error("native agent database close failed");
    const blockedClose = vi.spyOn(agent.db, "close").mockImplementation(() => {
      throw failure;
    });
    restoreClose = () => blockedClose.mockRestore();

    const outcome = await server
      .close({ reason: "gateway restarting", restartExpectedMs: 1_500 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(collectNestedErrorCandidates(outcome)).toContain(failure);
    expect(agent.db.isOpen).toBe(true);
    expect(shared.isOpen).toBe(true);
    expect(getActiveSecretsRuntimeSnapshotState()).not.toBeNull();
    expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env })).toThrow(
      OpenClawAgentDatabaseLeaseActiveError,
    );
  } finally {
    restoreClose?.();
    await fixture.cleanup();
  }
});

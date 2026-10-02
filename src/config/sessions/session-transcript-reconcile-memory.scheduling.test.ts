import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  prepareUsageCostWorker,
  runUsageCostWorker,
} from "../../infra/session-cost-usage-worker-runtime.js";
import type { WorkerTaskResponse } from "../../infra/worker-task-pool.types.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import * as databaseResources from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPath,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { formatSqliteSessionFileMarker } from "./legacy-sqlite-marker.js";
import {
  persistSessionTranscriptTurn,
  readSessionTranscriptMessageEventPage,
} from "./session-accessor.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import {
  useMemoryReconcileFixture,
  agentId,
  sessionId,
  message,
} from "./session-transcript-reconcile-memory.fixture.test-support.js";
import * as reconcilePool from "./session-transcript-reconcile-pool.js";
import {
  reconcileSessionTranscriptIndexes,
  isSessionTranscriptIndexReconcileRunning,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "./session-transcript-reconcile.test-support.js";
import * as transcriptWorkerRuntime from "./session-transcript-worker-runtime.js";
import { transcriptMessage } from "./transcript-message.test-support.js";
vi.mock("node:worker_threads", async () =>
  (await import("./session-transcript-reconcile.test-support.js")).createObservedWorkerThreads(),
);

const observer = useReconcileWorkerObserver();
describe("incognito transcript reconciliation", () => {
  let ambient: OpenClawTestState;
  let explicit: OpenClawTestState;
  const { target, expectNoDiskState } = useMemoryReconcileFixture((ambientState, explicitState) => {
    ambient = ambientState;
    explicit = explicitState;
  });

  it("joins a memory task revoked during async producer handoff without reopening its owner", async () => {
    const { scope, options } = target(explicit.env);
    await replaceTranscriptEvents(scope, [message("handoff-owner")]);
    await waitForSessionTranscriptIndexReconcile(options);
    const database = openOpenClawAgentDatabase(options);
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(sessionId);
    const sourceRequested = createDeferred();
    const handoff = createDeferred();
    const release = createDeferred();
    const order: string[] = [];
    const inputs: string[] = [];
    let worker: Worker | undefined;
    let owner: reconcilePool.SessionTranscriptReconcileOperation | undefined;
    type Task = Awaited<ReturnType<reconcilePool.SessionTranscriptReconcileOperation["startTask"]>>;
    let originalTask: Task | undefined;
    let returnedTask: Task | undefined;
    let tasks = 0;
    let retired = false;
    observer.onTask = ({ worker: created, observeMessage }) => {
      worker = created;
      tasks++;
      observeMessage((value) => {
        if (value.type === "source-read") {
          sourceRequested.resolve();
        }
      });
    };
    const runOperation = reconcilePool.runSessionTranscriptReconcileOperation;
    const producer = vi
      .spyOn(reconcilePool, "runSessionTranscriptReconcileOperation")
      .mockImplementationOnce((generation, run, resource) =>
        runOperation(
          generation,
          (operation) => {
            owner = operation;
            return run({
              ...operation,
              get retirement() {
                return operation.retirement;
              },
              async startTask(input) {
                inputs.push(input.mode);
                const task = await operation.startTask(input);
                originalTask = task;
                for (const [name, pending] of [
                  ["completion", task.completion],
                  ["closed", task.closed],
                  ["leaseRelease", task.leaseRelease],
                ] as const) {
                  void pending.then(
                    () => order.push(name),
                    () => order.push(name),
                  );
                }
                handoff.resolve();
                await release.promise;
                returnedTask = task;
                return task;
              },
            });
          },
          resource,
        ),
      );
    const publication = vi.fn();
    const unsubscribe = sessionChanges.subscribe(publication);
    const outcome = reconcileSessionTranscriptIndexes(options)
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      .finally(() => order.push("outward"));
    try {
      await handoff.promise;
      await sourceRequested.promise;
      expect(tasks).toBe(1);
      expect(inputs).toEqual(["memory"]);
      expect(worker?.threadId).toBeGreaterThan(0);
      closeOpenClawAgentDatabaseByPath(database.path);
      const retirement = owner?.retirement;
      expect(retirement).toBeInstanceOf(Promise);
      void retirement?.then(() => {
        retired = true;
      });
      expect(owner?.signal.aborted).toBe(true);
      const reason = owner?.signal.reason;
      expect(reason).toBeInstanceOf(Error);
      expect(retired).toBe(false);
      expect(order).not.toContain("outward");
      release.resolve();
      const result = await outcome;
      await retirement;
      expect(returnedTask).toBe(originalTask);
      expect(order.at(-1)).toBe("outward");
      expect(order.slice(0, -1).toSorted()).toEqual(["closed", "completion", "leaseRelease"]);
      expect(worker?.threadId).toBe(-1);
      expect("error" in result && result.error).toBe(reason);
      expect(tasks).toBe(1);
      expect(publication).not.toHaveBeenCalled();
      expect(database.db.isOpen).toBe(false);
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      expectNoDiskState();
    } finally {
      release.resolve();
      await outcome;
      await owner?.retirement;
      unsubscribe();
      producer.mockRestore();
    }
  });

  it("joins the final memory sweep after the pooled task completes", async ({ signal }) => {
    const { scope, options } = target(explicit.env);
    await replaceTranscriptEvents(scope, [message("seed")]);
    const database = openOpenClawAgentDatabase(options);
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(sessionId);
    const blocked = createDeferred();
    const release = createDeferred();
    const completed = createDeferred();
    let blocker: Promise<void> | undefined;
    let worker: Worker | undefined;
    let settled = false;
    observer.onTask = ({ worker: created, taskId, observeMessage }) => {
      worker = created;
      worker.on("message", (reply: { taskId: number; status: string }) => {
        if (reply.taskId === taskId && reply.status === "ok") {
          completed.resolve();
        }
      });
      observeMessage((workerMessage: { type: string }) => {
        if (workerMessage.type === "done") {
          // Memory's port can close while its final parent write waits in the FIFO.
          blocker = runExclusiveSqliteSessionWrite(
            options,
            async () => {
              blocked.resolve();
              await release.promise;
            },
            "sessions.transcript-index.preflight",
          );
        }
      });
    };
    const outcome = reconcileSessionTranscriptIndexes(options).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    try {
      await withinTest(blocked.promise, signal);
      await withinTest(completed.promise, signal);
      expect(worker?.threadId).toBeGreaterThan(0);
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      await blocker;
      await outcome;
    }
    expect(await outcome).toEqual({ value: { reconciledSessions: 1 } });
    expectNoDiskState();
  }, 20_000);

  it("hands a successor's scheduled work over after active old-task cancellation", async ({
    signal,
  }) => {
    const { scope, options } = target(ambient.env);
    await replaceTranscriptEvents(scope, [message("old-owner")]);
    const database = openOpenClawAgentDatabase(options);
    const state = () =>
      getOpenClawAgentDatabaseIfOpen(options)
        ?.db.prepare(
          "SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(sessionId);
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(sessionId);
    const joined = createDeferred();
    const workers = new Set<Worker>();
    let tasks = 0;
    let finishPrevious: (() => void) | undefined;
    observer.onTask = ({ worker, taskId }) => {
      workers.add(worker);
      tasks += 1;
      if (tasks === 1) {
        const emit = worker.emit.bind(worker);
        worker.emit = (...args: Parameters<typeof emit>) => {
          const [event, reply] = args;
          if (
            event === "message" &&
            isRecord(reply) &&
            reply.taskId === taskId &&
            reply.status === "ok"
          ) {
            finishPrevious = () => {
              emit(...args);
            };
            joined.resolve();
            return true;
          }
          return emit(...args);
        };
      }
    };
    startSessionTranscriptIndexReconcile(options);
    const pending = waitForSessionTranscriptIndexReconcile(options);
    try {
      await withinTest(joined.promise, signal);
      expect(state()).toEqual({ needs_rebuild: 0 });
      await runExclusiveSqliteSessionWrite(
        options,
        async () => undefined,
        "sessions.transcript-index.preflight",
      );
      expect([...workers][0]?.threadId).toBeGreaterThan(0);
      closeOpenClawAgentDatabaseByPath(database.path);
      await persistSessionTranscriptTurn(scope, {
        messages: [
          transcriptMessage("root", null, { role: "user", content: "root" }),
          transcriptMessage("abandoned", "root", { role: "assistant", content: "abandoned" }),
          transcriptMessage("active", "root", { role: "assistant", content: "active" }),
        ],
        touchSessionEntry: false,
      });
      expect(getOpenClawAgentDatabaseIfOpen(options)).not.toBe(database);
      expect(state()).toEqual({ needs_rebuild: 1 });
    } finally {
      finishPrevious?.();
      await pending;
    }
    expect(state()).toEqual({ needs_rebuild: 0 });
    expect(
      readSessionTranscriptMessageEventPage(scope, { maxMessages: 10, offset: 0 }).events.map(
        ({ event }) => event,
      ),
    ).toEqual([expect.objectContaining({ id: "root" }), expect.objectContaining({ id: "active" })]);
    expect(tasks).toBe(2);
    expect(workers.size).toBe(2);
    expect([...workers][0]?.threadId).toBe(-1);
    expect([...workers][1]?.threadId).toBeGreaterThan(0);
    expectNoDiskState();
  }, 20_000);

  it.for(["handoff", "initial"] as const)(
    "retains captured native demand through independent usage retirement (%s)",
    { timeout: 20_000 },
    async (admission, { signal }) => {
      const { scope, options } = target(ambient.env);
      await replaceTranscriptEvents(scope, [message("old-owner")]);
      const database = openOpenClawAgentDatabase(options);
      const state = () =>
        getOpenClawAgentDatabaseIfOpen(options)
          ?.db.prepare(
            "SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
          )
          .get(sessionId);
      database.db
        .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
        .run(sessionId);
      const taskJoined = createDeferred();
      const forwardRelease = createDeferred();
      const hostEffectEntered = createDeferred();
      const forwardHostEffect = createDeferred();
      const usageExited = createDeferred();
      const admissionBlocked =
        createDeferred<databaseResources.AgentDatabaseResourceAdmissionError>();
      const operations: reconcilePool.SessionTranscriptReconcileOperation[] = [];
      let originalResponse: WorkerTaskResponse | undefined;
      let forwardedResponse: WorkerTaskResponse | undefined;
      let usageWorker: Worker | undefined;
      let usageTasks = 0;
      let tasks = 0;
      let usageSettled = false;
      let schedulerSettled = false;
      let usage: Promise<unknown> | undefined;
      let pending: Promise<void> | undefined;
      observer.onTask = () => {
        tasks += 1;
      };
      const postMessage = vi.spyOn(Worker.prototype, "postMessage");
      postMessage.mockRestore();
      const postSpy = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
        this: Worker,
        ...args
      ) {
        const envelope = args[0];
        if (
          isRecord(envelope) &&
          isRecord(envelope.input) &&
          envelope.input.kind === "usage-cost"
        ) {
          usageTasks += 1;
          // Retain the actual intercepted native Worker as the later exit witness.
          // oxlint-disable-next-line typescript/no-this-alias, unicorn/no-this-assignment
          usageWorker = this;
          this.once("exit", () => usageExited.resolve());
        }
        return postMessage.apply(this, args);
      });
      const withDatabases = transcriptWorkerRuntime.withSessionCostUsageWorkerDatabases;
      const scopeSpy = vi
        .spyOn(transcriptWorkerRuntime, "withSessionCostUsageWorkerDatabases")
        .mockImplementation((databases, run) =>
          withDatabases(databases, (owner) =>
            run({
              ...owner,
              run(input, runOptions) {
                const onRequest = runOptions.onRequest;
                return owner.run(input, {
                  ...runOptions,
                  onRequest: onRequest
                    ? async (value, context) => {
                        const response = await onRequest(value, context);
                        expect(value).toMatchObject({ kind: "memory-stats" });
                        originalResponse = response;
                        hostEffectEntered.resolve();
                        // The original runtime tracks this accepted effect until its exact reply returns.
                        await forwardHostEffect.promise;
                        forwardedResponse = response;
                        return response;
                      }
                    : undefined,
                });
              },
            }),
          ),
        );
      const runOperation = reconcilePool.runSessionTranscriptReconcileOperation;
      const operationSpy = vi
        .spyOn(reconcilePool, "runSessionTranscriptReconcileOperation")
        .mockImplementation((generation, run, owner) =>
          runOperation(
            generation,
            (operation) => {
              operations.push(operation);
              return run(
                operations.length === 1
                  ? {
                      ...operation,
                      get retirement() {
                        return operation.retirement;
                      },
                      async startTask(input) {
                        const task = await operation.startTask(input);
                        return {
                          ...task,
                          leaseRelease: task.leaseRelease.then(async (receipt) => {
                            taskJoined.resolve();
                            await forwardRelease.promise;
                            return receipt;
                          }),
                        };
                      },
                    }
                  : operation,
              );
            },
            owner,
          ).catch((error: unknown) => {
            if (error instanceof databaseResources.AgentDatabaseResourceAdmissionError) {
              admissionBlocked.resolve(error);
            }
            throw error;
          }),
        );
      try {
        startSessionTranscriptIndexReconcile(options);
        pending = waitForSessionTranscriptIndexReconcile(options);
        await withinTest(taskJoined.promise, signal);
        await runExclusiveSqliteSessionWrite(
          options,
          async () => undefined,
          "sessions.transcript-index.preflight",
        );
        expect(state()).toEqual({ needs_rebuild: 0 });
        if (admission === "initial") {
          forwardRelease.resolve();
          await pending;
          expect(isSessionTranscriptIndexReconcileRunning(options)).toBe(false);
        }
        const sessionFile = formatSqliteSessionFileMarker(scope);
        const prepared = prepareUsageCostWorker({
          agentId,
          env: options.env,
          databasePath: options.path,
          storePath: options.path,
          sessionFiles: [sessionFile],
        });
        usage = runUsageCostWorker(prepared, { kind: "inventory", sessionFiles: [sessionFile] })
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          )
          .finally(() => {
            usageSettled = true;
          });
        await withinTest(hostEffectEntered.promise, signal);
        expect(originalResponse).toMatchObject({ input: { ok: true } });
        expect(usageWorker?.threadId).toBeGreaterThan(0);
        expect(usageTasks).toBe(1);
        closeOpenClawAgentDatabaseByPath(database.path);
        await persistSessionTranscriptTurn(scope, {
          messages: [
            transcriptMessage("root", null, { role: "user", content: "root" }),
            transcriptMessage("abandoned", "root", { role: "assistant", content: "abandoned" }),
            transcriptMessage("active", "root", { role: "assistant", content: "active" }),
          ],
          touchSessionEntry: false,
        });
        const successor = getOpenClawAgentDatabaseIfOpen(options);
        expect(successor).not.toBe(database);
        if (admission === "initial") {
          pending = waitForSessionTranscriptIndexReconcile(options);
        }
        void pending.then(() => {
          schedulerSettled = true;
        });
        forwardRelease.resolve();
        if (admission === "handoff") {
          expect(operations[0]?.retirement).toBeInstanceOf(Promise);
          await operations[0]?.retirement;
        }
        const blocked = await withinTest(admissionBlocked.promise, signal);
        await withinTest(usageExited.promise, signal);
        expect(usageWorker?.threadId).toBe(-1);
        expect(blocked.retirements).toHaveLength(1);
        expect(blocked.retirements?.[0]).not.toBe(operations[0]?.retirement);
        expect(state()).toEqual({ needs_rebuild: 1 });
        expect(isSessionTranscriptIndexReconcileRunning(options)).toBe(true);
        expect(schedulerSettled).toBe(false);
        expect(usageSettled).toBe(false);
        expect(operations).toHaveLength(1);
        expect(tasks).toBe(1);
        forwardHostEffect.resolve();
        await expect(usage).resolves.toMatchObject({ error: { code: "unavailable" } });
        await Promise.all(blocked.retirements!);
        await pending;
        expect(forwardedResponse).toBe(originalResponse);
        expect(getOpenClawAgentDatabaseIfOpen(options)).toBe(successor);
        expect(state()).toEqual({ needs_rebuild: 0 });
        expect(operations).toHaveLength(2);
        expect(tasks).toBe(2);
        expect(usageTasks).toBe(1);
        expect(isSessionTranscriptIndexReconcileRunning(options)).toBe(false);
        expect(
          readSessionTranscriptMessageEventPage(scope, { maxMessages: 10, offset: 0 }).events.map(
            ({ event }) => event,
          ),
        ).toEqual([
          expect.objectContaining({ id: "root" }),
          expect.objectContaining({ id: "active" }),
        ]);
        expectNoDiskState();
      } finally {
        forwardRelease.resolve();
        forwardHostEffect.resolve();
        try {
          closeOpenClawAgentDatabaseByPath(options.path);
          await pending;
          await usage;
          await Promise.all(databaseResources.revokeAgentDatabaseResources({ path: options.path }));
        } finally {
          operationSpy.mockRestore();
          scopeSpy.mockRestore();
          postSpy.mockRestore();
        }
      }
    },
  );

  it.for(["live", "disposed", "replaced", "stopped", "failed retirement", "same owner"] as const)(
    "keeps scheduled owner authority after native task completion (%s)",
    { timeout: 20_000 },
    async (ending, { signal }) => {
      const { scope, options } = target(ambient.env);
      await replaceTranscriptEvents(scope, [message("old-owner")]);
      const database = openOpenClawAgentDatabase(options);
      const state = () =>
        getOpenClawAgentDatabaseIfOpen(options)
          ?.db.prepare(
            "SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
          )
          .get(sessionId);
      database.db
        .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
        .run(sessionId);
      const taskJoined = createDeferred();
      const forwardRelease = createDeferred();
      const retirementEntered = createDeferred();
      const retire = createDeferred();
      const failure = new Error("original reconciliation retirement failed");
      let fail = ending === "failed retirement";
      let closeCalls = 0;
      let attempt: Promise<void> | undefined;
      let revocations: Promise<unknown>[] = [];
      let closingPool: Promise<void> | undefined;
      type Task = Awaited<
        ReturnType<reconcilePool.SessionTranscriptReconcileOperation["startTask"]>
      >;
      let originalTask: Task | undefined;
      let originalReceipt: Awaited<Task["leaseRelease"]> | undefined;
      let forwardedReceipt: typeof originalReceipt;
      const workers = new Set<Worker>();
      let tasks = 0;
      observer.onTask = ({ worker }) => {
        workers.add(worker);
        tasks += 1;
      };
      const register = databaseResources.registerOpenClawAgentDatabaseAsyncResource;
      const registrationSpy = vi
        .spyOn(databaseResources, "registerOpenClawAgentDatabaseAsyncResource")
        .mockImplementationOnce((resource, onRetirement) =>
          register(
            {
              ...resource,
              async close() {
                closeCalls += 1;
                await resource.close();
                retirementEntered.resolve();
                await retire.promise;
                if (fail) {
                  throw failure;
                }
              },
            },
            (pending) => {
              attempt = pending;
              onRetirement?.(pending);
            },
          ),
        );
      const runOperation = reconcilePool.runSessionTranscriptReconcileOperation;
      const operationSpy = vi
        .spyOn(reconcilePool, "runSessionTranscriptReconcileOperation")
        .mockImplementationOnce((generation, run, owner) =>
          runOperation(
            generation,
            (operation) =>
              run({
                ...operation,
                get retirement() {
                  return operation.retirement;
                },
                async startTask(input) {
                  const task = await operation.startTask(input);
                  originalTask = task;
                  return {
                    ...task,
                    leaseRelease: task.leaseRelease.then(async (receipt) => {
                      originalReceipt = receipt;
                      taskJoined.resolve();
                      await forwardRelease.promise;
                      forwardedReceipt = receipt;
                      return receipt;
                    }),
                  };
                },
              }),
            owner,
          ),
        );
      startSessionTranscriptIndexReconcile(options);
      const pending = waitForSessionTranscriptIndexReconcile(options);
      const failures: unknown[] = [];
      try {
        await withinTest(taskJoined.promise, signal);
        await runExclusiveSqliteSessionWrite(
          options,
          async () => undefined,
          "sessions.transcript-index.preflight",
        );
        await expect(originalTask?.completion).resolves.toBeUndefined();
        await originalTask?.closed;
        // Memory tasks close their port without the disk-only lease-released message.
        expect(originalReceipt).toMatchObject({ released: false, releaseFailed: false });
        expect(state()).toEqual({ needs_rebuild: 0 });
        expect([...workers][0]?.threadId).toBeGreaterThan(0);
        if (ending === "same owner") {
          revocations = databaseResources.revokeAgentDatabaseResources({ path: database.path });
          database.db
            .prepare(
              "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
            )
            .run(sessionId);
          startSessionTranscriptIndexReconcile(options);
        } else {
          closeOpenClawAgentDatabaseByPath(database.path);
          await persistSessionTranscriptTurn(scope, {
            messages: [
              transcriptMessage("root", null, { role: "user", content: "root" }),
              transcriptMessage("abandoned", "root", { role: "assistant", content: "abandoned" }),
              transcriptMessage("active", "root", { role: "assistant", content: "active" }),
            ],
            touchSessionEntry: false,
          });
          expect(getOpenClawAgentDatabaseIfOpen(options)).not.toBe(database);
        }
        expect(state()).toEqual({ needs_rebuild: 1 });
        forwardRelease.resolve();
        await withinTest(retirementEntered.promise, signal);
        expect(forwardedReceipt).toBe(originalReceipt);
        expect(isSessionTranscriptIndexReconcileRunning(options)).toBe(true);
        expect(tasks).toBe(1);
        expect(() =>
          databaseResources.registerOpenClawAgentDatabaseAsyncResource({
            agentId,
            path: options.path,
            revoke() {},
            close: async () => {},
          }),
        ).toThrow("are closing");
        if (ending === "disposed" || ending === "replaced") {
          const successor = getOpenClawAgentDatabaseIfOpen(options)!;
          closeOpenClawAgentDatabaseByPath(successor.path);
          if (ending === "replaced") {
            // Materialize C without requesting reconciliation; B cannot authorize it.
            await replaceTranscriptEvents(scope, [message("unrequested-replacement")]);
            expect(getOpenClawAgentDatabaseIfOpen(options)).not.toBe(successor);
            getOpenClawAgentDatabaseIfOpen(options)!
              .db.prepare(
                "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
              )
              .run(sessionId);
          }
        } else if (ending === "stopped") {
          closingPool = reconcilePool.closeSessionTranscriptReconcileWorkerPool();
        }
        retire.resolve();
        if (fail) {
          await expect(attempt).rejects.toBe(failure);
        } else {
          await attempt;
        }
        await pending;
        await Promise.all(revocations);
        expect(closeCalls).toBe(1);
        expect(isSessionTranscriptIndexReconcileRunning(options)).toBe(false);
        expect(tasks).toBe(ending === "live" ? 2 : 1);
        expect(workers.size).toBe(1);
        expect(state()).toEqual(
          ending === "disposed" ? undefined : { needs_rebuild: ending === "live" ? 0 : 1 },
        );
        if (ending === "live") {
          expect([...workers][0]?.threadId).toBeGreaterThan(0);
          expect(
            readSessionTranscriptMessageEventPage(scope, { maxMessages: 10, offset: 0 }).events.map(
              ({ event }) => event,
            ),
          ).toEqual([
            expect.objectContaining({ id: "root" }),
            expect.objectContaining({ id: "active" }),
          ]);
        } else if (fail) {
          expect(() =>
            databaseResources.registerOpenClawAgentDatabaseAsyncResource({
              agentId,
              path: options.path,
              revoke() {},
              close: async () => {},
            }),
          ).toThrow("are closing");
        }
        expectNoDiskState();
      } catch (error) {
        failures.push(error);
      } finally {
        forwardRelease.resolve();
        retire.resolve();
        try {
          const outcomes = await Promise.allSettled([pending, ...revocations]);
          failures.push(
            ...outcomes.flatMap((outcome) =>
              outcome.status === "rejected" ? [outcome.reason] : [],
            ),
          );
          fail = false;
          const cleanup = await Promise.allSettled([
            ...databaseResources.revokeAgentDatabaseResources({ path: options.path }),
            closingPool,
          ]);
          failures.push(
            ...cleanup.flatMap((outcome) =>
              outcome.status === "rejected" ? [outcome.reason] : [],
            ),
          );
        } finally {
          operationSpy.mockRestore();
          registrationSpy.mockRestore();
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length) {
        throw new AggregateError(failures, "Scheduled reconciliation cleanup failed");
      }
    },
  );
});

import { setImmediate as checkpoint } from "node:timers/promises";
import { expect, it, vi, type MockInstance } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import * as agentExecution from "../../state/openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  closeSessionTranscriptReconcileWorkerPool,
  getSessionTranscriptReconcileWorkerPoolSnapshot,
} from "./session-transcript-reconcile-pool.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcilesInStateDir,
} from "./session-transcript-reconcile.js";

const warnings = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger(name: string) {
      const logger = actual.createSubsystemLogger(name);
      return name === "sessions/transcript-index" ? { ...logger, warn: warnings } : logger;
    },
  };
});

it.for(["operation", "release", "same", "independent"] as const)(
  "joins reconciliation release and records the complete %s failure",
  async (mode, { signal }) => {
    await withOpenClawTestState({ label: "reconcile-release-failure" }, async (state) => {
      const options = { agentId: "main", env: state.env };
      openOpenClawAgentDatabase(options);
      const primary = new Error("reconciliation authority retired");
      const cleanup = mode === "same" ? primary : new Error("reconciliation release failed");
      const releasing = createDeferred();
      const released = createDeferred();
      const originalCapture = agentExecution.captureOpenClawAgentDatabaseExecution;
      const capture = vi
        .spyOn(agentExecution, "captureOpenClawAgentDatabaseExecution")
        .mockImplementation((input) => {
          const execution = originalCapture(input);
          const release = execution.release.bind(execution);
          if (mode !== "release") {
            vi.spyOn(execution, "assertCurrent").mockImplementation(() => {
              throw primary;
            });
          }
          vi.spyOn(execution, "release").mockImplementation(async () => {
            releasing.resolve();
            await released.promise;
            await release();
            if (mode !== "operation") {
              throw cleanup;
            }
          });
          return execution;
        });
      let completion: Promise<void> | undefined;
      warnings.mockClear();
      try {
        startSessionTranscriptIndexReconcile(options);
        completion = waitForSessionTranscriptIndexReconcile(options);
        await withinTest(releasing.promise, signal);
        expect(isSessionTranscriptIndexReconcileRunning(options)).toBe(true);
        expect(warnings).not.toHaveBeenCalled();
        released.resolve();
        await withinTest(completion, signal);
        expect(isSessionTranscriptIndexReconcileRunning(options)).toBe(false);
        expect(warnings).toHaveBeenCalledExactlyOnceWith(
          `session transcript reconcile failed agent=main error=${
            mode === "independent"
              ? `Transcript reconciliation and release failed | ${primary.message} | ${cleanup.message}`
              : mode === "release"
                ? cleanup.message
                : primary.message
          }`,
        );
      } finally {
        released.resolve();
        await completion;
        await waitForSessionTranscriptIndexReconcile(options);
        capture.mockRestore();
      }
    });
  },
);

it.for(["final", "superseded"] as const)(
  "joins late waits and successor demand while a %s borrow is releasing",
  { timeout: 30_000 },
  async (mode, { signal }) => {
    await withOpenClawTestState({ label: "reconcile-borrow-retirement" }, async (state) => {
      const options = {
        agentId: "main",
        env: state.env,
        path: state.path("custom", "transcripts.sqlite"),
      };
      const database = openOpenClawAgentDatabase(options);
      const originalCapture = agentExecution.captureOpenClawAgentDatabaseExecution;
      const previous = createDeferred();
      const successor = createDeferred();
      const retiring = createDeferred();
      const successorRetiring = createDeferred();
      const firstFinal = mode === "final" ? 0 : 2;
      const successorIndex = firstFinal + 1;
      const blockedIndex = mode === "final" ? 0 : 1;
      const releases: MockInstance<() => Promise<void>>[] = [];
      const capture = vi
        .spyOn(agentExecution, "captureOpenClawAgentDatabaseExecution")
        .mockImplementation((input) => {
          const execution = originalCapture(input);
          const index = releases.length;
          const release = execution.release.bind(execution);
          const observed = vi.spyOn(execution, "release").mockImplementation(async () => {
            if (index === firstFinal) {
              retiring.resolve();
            }
            if (index === blockedIndex) {
              await previous.promise;
            }
            if (index === successorIndex) {
              successorRetiring.resolve();
              await successor.promise;
            }
            await release();
          });
          releases.push(observed);
          return execution;
        });
      const waits: Promise<void>[] = [];
      let keyDrained = false;
      let rootDrained = false;
      try {
        startSessionTranscriptIndexReconcile(options);
        if (mode === "superseded") {
          startSessionTranscriptIndexReconcile(options);
          startSessionTranscriptIndexReconcile(options);
        }
        await withinTest(retiring.promise, signal);
        await checkpoint();
        expect(isSessionTranscriptIndexReconcileRunning(options)).toBe(true);
        waits.push(
          waitForSessionTranscriptIndexReconcile(options).then(() => {
            keyDrained = true;
          }),
          waitForSessionTranscriptIndexReconcilesInStateDir(state.stateDir).then(() => {
            rootDrained = true;
          }),
        );
        await checkpoint();
        expect([keyDrained, rootDrained]).toEqual([false, false]);

        startSessionTranscriptIndexReconcile(options);
        await withinTest(successorRetiring.promise, signal);
        previous.resolve();
        await checkpoint();
        expect(isSessionTranscriptIndexReconcileRunning(options)).toBe(true);
        expect([keyDrained, rootDrained]).toEqual([false, false]);
        successor.resolve();
        await withinTest(Promise.all(waits), signal);
        expect([keyDrained, rootDrained]).toEqual([true, true]);
        expect(isSessionTranscriptIndexReconcileRunning(options)).toBe(false);
        expect(releases).toHaveLength(successorIndex + 1);
        for (const release of releases) {
          expect(release).toHaveBeenCalledOnce();
        }
        expect(database.db.isOpen).toBe(true);
      } finally {
        previous.resolve();
        successor.resolve();
        await waitForSessionTranscriptIndexReconcilesInStateDir(state.stateDir);
        await Promise.all(waits);
        capture.mockRestore();
      }
    });
  },
);

it("drains deferred reconciliation after the caller retires its timer queue", async ({
  onTestFinished,
  signal,
}) => {
  const stateDir = useAutoCleanupTempDirTracker(onTestFinished).make("openclaw-reconcile-clock-");
  const options = { agentId: "main", env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  let releaseYield: (() => void) | undefined;
  const release = () => {
    releaseYield?.();
    releaseYield = undefined;
  };
  onTestFinished(async () => {
    signal.removeEventListener("abort", release);
    release();
    await closeSessionTranscriptReconcileWorkerPool();
    await closeOpenClawAgentDatabasesAsync(stateDir);
    closeOpenClawStateDatabaseForTest();
  });
  await persistSessionTranscriptTurn(
    { ...options, sessionId: "deferred", sessionKey: "agent:main:deferred" },
    {
      messages: [{ eventId: "message", message: { role: "user", content: "Deferred repair" } }],
      touchSessionEntry: false,
    },
  );
  await waitForSessionTranscriptIndexReconcile(options);
  await closeSessionTranscriptReconcileWorkerPool();
  const database = openOpenClawAgentDatabase(options);
  database.db.prepare("DELETE FROM session_transcript_fts").run();
  database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();

  signal.throwIfAborted();
  // A failing regression must release the withheld callback before fixture teardown.
  signal.addEventListener("abort", release, { once: true });
  const realSetImmediate = globalThis.setImmediate;
  const immediate = vi.spyOn(globalThis, "setImmediate").mockImplementationOnce((callback) => {
    releaseYield = () => callback();
    return realSetImmediate(() => undefined);
  });
  try {
    startSessionTranscriptIndexReconcile(options);
  } finally {
    immediate.mockRestore();
  }

  await closeSessionTranscriptReconcileWorkerPool();
  expect(database.db.prepare("SELECT message_id, text FROM session_transcript_fts").all()).toEqual([
    { message_id: "message", text: "Deferred repair" },
  ]);
  expect(
    database.db.prepare("SELECT needs_rebuild FROM session_transcript_index_state").all(),
  ).toEqual([{ needs_rebuild: 0 }]);
  expect(getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
    maxWorkers: 1,
    workers: 0,
    activeTasks: 0,
    pendingTasks: 0,
  });
}, 30_000);

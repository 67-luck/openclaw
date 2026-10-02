import fs from "node:fs";
import path from "node:path";
import { setImmediate as checkpoint } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { readActiveOpenClawAgentDatabaseLeasesReadOnly } from "../../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { claimOpenClawStateOwnership } from "../../state/openclaw-state-ownership-operations.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import {
  appendTranscriptEvent,
  persistSessionTranscriptTurn,
  readSessionTranscriptMessageEvents,
  SessionTranscriptProjectionUnavailableError,
} from "./session-accessor.js";
import {
  closeSessionTranscriptReconcileWorkerPool,
  getSessionTranscriptReconcileWorkerPoolSnapshot,
} from "./session-transcript-reconcile-pool.js";
import * as reconcile from "./session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "./session-transcript-reconcile.test-support.js";

vi.mock("node:worker_threads", async () =>
  (await import("./session-transcript-reconcile.test-support.js")).createObservedWorkerThreads(),
);

const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.cleanup());
const observer = useReconcileWorkerObserver();
let ownedBody: Promise<void> | undefined;

// Vitest's abort can settle its wrapper before native cleanup. Join this body
// before the stack-ordered observer and temporary-directory teardown.
afterEach(async () => {
  const completion = ownedBody;
  try {
    // The returned body owns its failure; this hook must not skip later teardown.
    await Promise.allSettled([completion]);
  } finally {
    if (ownedBody === completion) {
      ownedBody = undefined;
    }
  }
});

it.for([
  { trigger: "append", externallySupervised: false },
  { trigger: "append", externallySupervised: true },
  { trigger: "history read", externallySupervised: false },
])(
  "retains and drains the $trigger owner's database through lease settlement (external: $externallySupervised)",
  { timeout: 20_000 },
  ({ trigger, externallySupervised }, { signal }) => {
    ownedBody = (async () => {
      const root = tempDirs.make("openclaw-reconcile-owner-");
      const stateDir = path.join(root, "owner");
      const ambientStateDir = path.join(root, "ambient");
      fs.mkdirSync(ambientStateDir);
      const env: NodeJS.ProcessEnv = {
        OPENCLAW_STATE_DIR: stateDir,
        ...(externallySupervised ? { OPENCLAW_SUPERVISOR_MODE: "external" } : {}),
      };
      const ownerEnv = { ...env };
      const databasePath =
        trigger === "append"
          ? path.join(root, "custom", "transcripts.sqlite")
          : resolveOpenClawAgentSqlitePath({ agentId: "main", env });
      const options = { agentId: "main", env, path: databasePath };
      const scope = {
        agentId: options.agentId,
        env,
        storePath: databasePath,
        sessionId: "original-owner",
        sessionKey: "agent:main:original-owner",
      };
      const savedEnv = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_SUPERVISOR_MODE"]);
      const paused = createDeferred();
      const originals: Promise<unknown>[] = [];
      const exits: Promise<number>[] = [];
      const ports: Promise<void>[] = [];
      const restores: Array<() => void> = [];
      const tasks: Array<Parameters<NonNullable<typeof observer.onTask>>[0]> = [];
      const messages: string[] = [];
      const failures: unknown[] = [];
      let releaseAllowed = false;
      let forwardRelease: (() => void) | undefined;
      let closedPorts = 0;
      let poolClose: Promise<void> | undefined;
      const release = () => {
        releaseAllowed = true;
        const forward = forwardRelease;
        forwardRelease = undefined;
        forward?.();
      };
      const observe = <T>(promise: Promise<T>) => withinTest(promise, signal);
      signal.addEventListener("abort", release, { once: true });
      try {
        signal.throwIfAborted();
        setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
        if (externallySupervised) {
          setTestEnvValue("OPENCLAW_SUPERVISOR_MODE", "external");
          claimOpenClawStateOwnership("fixture-supervisor", { env });
        } else {
          deleteTestEnvValue("OPENCLAW_SUPERVISOR_MODE");
        }
        const seed = persistSessionTranscriptTurn(scope, {
          messages: [
            { eventId: "seed", parentId: null, message: { role: "user", content: "seed" } },
            {
              eventId: "answer",
              parentId: "seed",
              message: { role: "assistant", content: "answer" },
            },
          ],
          touchSessionEntry: false,
        });
        originals.push(seed);
        await observe(seed);
        const seeded = reconcile.waitForSessionTranscriptIndexReconcile(options);
        originals.push(seeded);
        await observe(seeded);
        const database = openOpenClawAgentDatabase(options);
        const state = openOpenClawStateDatabase({ env });
        const readLeases = () =>
          state.db.prepare("SELECT lease_id FROM agent_database_leases ORDER BY lease_id").all();
        const baseline = readLeases();
        expect(baseline).toHaveLength(1);
        expect(fs.readdirSync(ambientStateDir)).toEqual([]);
        let canonicalLeaseId: string | undefined;
        const createAdmission = admission.createSqliteWorkerOperationAdmission;
        const admissionSpy = vi
          .spyOn(admission, "createSqliteWorkerOperationAdmission")
          .mockImplementation((admit, attachment, ownerScope) =>
            createAdmission(
              (request, grant) => {
                if (
                  request.stage === "open" &&
                  isRecord(request.facts) &&
                  request.facts.databasePath === databasePath &&
                  typeof request.facts.leaseId === "string"
                ) {
                  expect(request.facts.stateDatabasePath).toBe(state.path);
                  canonicalLeaseId = request.facts.leaseId;
                }
                admit(request, grant);
              },
              attachment,
              ownerScope,
            ),
          );
        restores.push(() => admissionSpy.mockRestore());

        env.OPENCLAW_STATE_DIR = ambientStateDir;
        delete env.OPENCLAW_SUPERVISOR_MODE;
        setTestEnvValue("OPENCLAW_STATE_DIR", ambientStateDir);
        deleteTestEnvValue("OPENCLAW_SUPERVISOR_MODE");
        expect(openOpenClawAgentDatabase(options)).toBe(database);
        observer.onTask = (task) => {
          if (task.input.mode !== "disk" || task.input.path !== databasePath) {
            return;
          }
          tasks.push(task);
          exits.push(
            new Promise<number>((resolve) => {
              task.worker.once("exit", resolve);
            }),
          );
          ports.push(
            new Promise<void>((resolve) => {
              task.port.once("close", () => {
                closedPorts++;
                resolve();
              });
            }),
          );
          task.observeMessage((message) => messages.push(message.type));
          const post = task.port.postMessage.bind(task.port);
          const postSpy = vi.spyOn(task.port, "postMessage").mockImplementation((...args) => {
            const [message] = args;
            if (!releaseAllowed && isRecord(message) && message.type === "release") {
              // This is the original post-sweep command. Hold its exact arguments,
              // not a fabricated task result or a per-task native exit.
              forwardRelease = () => post(...args);
              paused.resolve();
              return;
            }
            post(...args);
          });
          restores.push(() => postSpy.mockRestore());
        };

        if (trigger === "append") {
          const append = appendTranscriptEvent(scope, {
            type: "leaf",
            id: "selected-leaf",
            parentId: "answer",
            targetId: "seed",
          });
          originals.push(append);
          await observe(append);
        } else {
          database.db
            .prepare(
              "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
            )
            .run(scope.sessionId);
          expect(reconcile.isSessionTranscriptIndexReconcileRunning(options)).toBe(false);
          expect(() => readSessionTranscriptMessageEvents(scope)).toThrow(
            SessionTranscriptProjectionUnavailableError,
          );
        }
        const reconciliation = reconcile.waitForSessionTranscriptIndexReconcile(options);
        originals.push(reconciliation);
        let drained = false;
        const drain = reconcile.waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);
        const observedDrain = drain.then(() => {
          drained = true;
        });
        originals.push(drain, observedDrain);
        await observe(paused.promise);
        expect(tasks).toHaveLength(1);
        const task = tasks[0];
        assert(task?.input.mode === "disk");
        expect(task.input).toMatchObject({
          mode: "disk",
          path: databasePath,
          stateDir,
          externallySupervised,
        });
        assert(typeof canonicalLeaseId === "string");
        expect(canonicalLeaseId).not.toBe(task.input.leaseId);
        expect(baseline).not.toContainEqual({ lease_id: canonicalLeaseId });
        const writerLeases = [...baseline, { lease_id: canonicalLeaseId }].sort((a, b) =>
          String(a.lease_id).localeCompare(String(b.lease_id)),
        );
        expect(readLeases()).toEqual(
          [...writerLeases, { lease_id: task.input.leaseId }].sort((a, b) =>
            String(a.lease_id).localeCompare(String(b.lease_id)),
          ),
        );
        expect(
          state.db
            .prepare(
              "SELECT agent_id, path, owner_pid FROM agent_database_leases WHERE lease_id = ?",
            )
            .get(canonicalLeaseId),
        ).toEqual({ agent_id: options.agentId, path: databasePath, owner_pid: process.pid });
        expect(fs.readdirSync(ambientStateDir)).toEqual([]);
        expect(messages).toContain("done");
        expect(messages).not.toContain("lease-released");
        expect(closedPorts).toBe(0);
        expect(readSessionTranscriptMessageEvents(scope).map(({ event }) => event)).toEqual(
          (trigger === "append" ? ["seed"] : ["seed", "answer"]).map((id) =>
            expect.objectContaining({ id }),
          ),
        );
        await checkpoint();
        expect(drained).toBe(false);
        expect(task.worker.threadId).toBeGreaterThan(0);

        release();
        await observe(reconciliation);
        await observe(observedDrain);
        await observe(Promise.all(ports));
        expect(messages.filter((type) => type === "lease-released")).toHaveLength(1);
        expect(closedPorts).toBe(1);
        // Planner settlement releases its deletion fence, not the bounded warm writer.
        // The original database close below owns that writer's final retirement.
        expect(readLeases()).toEqual(writerLeases);
        expect(readLeases()).not.toContainEqual({ lease_id: task.input.leaseId });
        expect(getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
          activeTasks: 0,
          pendingTasks: 0,
        });
        expect(task.worker.threadId).toBeGreaterThan(0);
        poolClose = closeSessionTranscriptReconcileWorkerPool();
        await observe(poolClose);
        await observe(Promise.all(exits));
        expect(task.worker.threadId).toBe(-1);
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          release();
        } catch (error) {
          failures.push(error);
        }
        for (const result of await Promise.allSettled([
          ...originals,
          reconcile.waitForSessionTranscriptIndexReconcile(options),
        ])) {
          if (result.status === "rejected" && !failures.includes(result.reason)) {
            failures.push(result.reason);
          }
        }
        for (const cleanup of [
          () => (poolClose ??= closeSessionTranscriptReconcileWorkerPool()),
          () => Promise.all([...ports, ...exits]),
          () => closeOpenClawAgentDatabaseByPath(databasePath),
          () => closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(ownerEnv)),
          () =>
            closeOpenClawStateDatabaseByPathAsync(
              resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: ambientStateDir }),
            ),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            if (!failures.includes(error)) {
              failures.push(error);
            }
          }
        }
        observer.onTask = undefined;
        signal.removeEventListener("abort", release);
        for (const restore of [...restores, () => savedEnv.restore()]) {
          try {
            restore();
          } catch (error) {
            if (!failures.includes(error)) {
              failures.push(error);
            }
          }
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Transcript owner proof or cleanup failed");
      }
      expect(readActiveOpenClawAgentDatabaseLeasesReadOnly({ env: ownerEnv })).toEqual([]);
      expect(fs.readdirSync(ambientStateDir)).toEqual([]);
    })();
    return ownedBody;
  },
);

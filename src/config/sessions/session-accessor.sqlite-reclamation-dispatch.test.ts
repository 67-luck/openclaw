import assert from "node:assert/strict";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { Worker } from "node:worker_threads";
import { expect, test, vi } from "vitest";
import * as lifecycleAdmission from "../../infra/state-database-coordinator-acquisition.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import * as retiredLease from "../../state/openclaw-agent-execution-cleanup.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as archive from "./session-accessor.sqlite-archive.js";
import { loadSessionEntry } from "./session-accessor.sqlite-entry.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import * as reclamation from "./session-accessor.sqlite-reclamation-worker.js";
import {
  createLifecycleArtifactReclamationPlan,
  runSqliteSessionReclamation,
} from "./session-accessor.sqlite-reclamation.js";

test.each([false, true].flatMap((warm) => ["revoked", "ended"].map((phase) => ({ warm, phase }))))(
  "joins native exit around dispatch preparation (warm: $warm, phase: $phase)",
  async ({ warm, phase }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionId: "dispatch-victim",
        sessionKey: "agent:main:dispatch-victim",
      };
      ensureSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const databaseOptions = {
        agentId: scope.agentId,
        env: state.env,
        path: openOpenClawAgentDatabase(scope).path,
      };
      const entry = loadSessionEntry(scope);
      assert.ok(entry);
      const plan = (remove: boolean) =>
        createLifecycleArtifactReclamationPlan({
          agentId: scope.agentId,
          databaseOptions,
          entries: remove ? [{ sessionKey: scope.sessionKey, expectedEntry: entry }] : [],
          materializedPlans: [],
        });
      const preparing = createDeferredCore();
      const allowPreparation = createDeferredCore();
      const terminationRequested = createDeferredCore();
      const allowTermination = createDeferredCore();
      let holdPreparation = false;
      let owner: reclamation.SqliteReclamationWorker | undefined;
      let child: Worker | undefined;
      let exit: Promise<void> | undefined;
      let exited = false;
      const attempted: string[] = [];
      const acquire = lifecycleAdmission.acquireStateDatabaseCoordinatorWithWait;
      const withWorker = reclamation.withSqliteReclamationWorker;
      const spawn = archive.createSqliteTranscriptArchiveWorker;
      const cleanupLease = vi.spyOn(retiredLease, "cleanupRetiredAgentDatabaseLease");
      vi.spyOn(lifecycleAdmission, "acquireStateDatabaseCoordinatorWithWait").mockImplementation(
        async (params) => {
          if (holdPreparation && params.operation === "mutation-worker-admission") {
            holdPreparation = false;
            preparing.resolve();
            await allowPreparation.promise;
          }
          return acquire(params);
        },
      );
      vi.spyOn(reclamation, "withSqliteReclamationWorker").mockImplementation(
        (options, claim, run, assertCurrent, signal) =>
          withWorker(
            options,
            claim,
            (worker) => {
              owner = worker;
              return run(worker);
            },
            assertCurrent,
            signal,
          ),
      );
      vi.spyOn(archive, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
        const worker = spawn(data);
        child = worker;
        exit = new Promise<void>((resolve) => {
          worker.once("exit", () => {
            exited = true;
            resolve();
          });
        });
        const post = worker.postMessage.bind(worker);
        vi.spyOn(worker, "postMessage").mockImplementation((message: unknown, transferList) => {
          attempted.push(
            typeof message === "object" && message !== null && "type" in message
              ? String(message.type)
              : "untyped",
          );
          post(message, transferList);
        });
        const terminate = worker.terminate.bind(worker);
        vi.spyOn(worker, "terminate").mockImplementation(async () => {
          terminationRequested.resolve();
          await allowTermination.promise;
          return terminate();
        });
        return worker;
      });
      let operation: Promise<unknown> | undefined;
      let closing: Promise<void> | undefined;
      try {
        if (warm) {
          await runSqliteSessionReclamation({ forceInProcess: false, plan: plan(false) });
        }
        const priorAttempts = [...attempted];
        holdPreparation = true;
        let completed = false;
        operation = runSqliteSessionReclamation({ forceInProcess: false, plan: plan(true) }).then(
          (result) => {
            completed = true;
            return result;
          },
          (error: unknown) => {
            completed = true;
            return error;
          },
        );
        await Promise.race([preparing.promise, operation.then(() => assert.fail("missing hold"))]);
        assert.ok(owner);
        assert.ok(child);
        if (phase === "ended") {
          allowTermination.resolve();
          await child.terminate();
          await exit;
        }
        let closed = false;
        closing = owner.close().then(() => {
          closed = true;
        });
        void closing.catch(() => {});
        allowPreparation.resolve();
        await Promise.race([
          terminationRequested.promise,
          operation.then(() => assert.fail("missing native termination")),
        ]);
        if (phase === "revoked") {
          await yieldToEventLoop();
          expect({ completed, closed, exited }).toEqual({
            completed: false,
            closed: false,
            exited: false,
          });
          expect(child.threadId).toBeGreaterThan(0);
        } else {
          expect(exited).toBe(true);
          expect(child.threadId).toBe(-1);
        }
        expect(attempted).toEqual(priorAttempts);
        expect(priorAttempts.includes("reclaim")).toBe(warm);
        allowTermination.resolve();
        await exit;
        await expect(operation).resolves.toMatchObject({
          message: expect.stringContaining(
            phase === "ended"
              ? "Worker ended without confirmed cleanup"
              : "database owner is no longer current",
          ),
        });
        await closing;
        expect(closed).toBe(true);
        expect(child.threadId).toBe(-1);
        expect(cleanupLease).toHaveBeenCalledTimes(warm ? 1 : 0);
        expect(loadSessionEntry(scope)).toEqual(entry);
        expect(
          openOpenClawStateDatabase({ env: state.env })
            .db.prepare("SELECT lease_id FROM agent_database_leases WHERE path = ?")
            .all(databaseOptions.path),
        ).toHaveLength(1);
      } finally {
        allowPreparation.resolve();
        allowTermination.resolve();
        await Promise.allSettled([operation, closing]);
        await child?.terminate();
        vi.restoreAllMocks();
      }
    });
  },
);

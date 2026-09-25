import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { invalidateOpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { clearOpenClawAgentIntegrityVerification } from "../../state/openclaw-quarantine-store.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { loadSessionEntry } from "./session-accessor.sqlite-entry.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import {
  createLifecycleArtifactReclamationPlan,
  runSqliteSessionReclamation,
} from "./session-accessor.sqlite-reclamation.js";

type FixtureMessage = { type: string; sequence?: number };
const boundary = vi.hoisted(() => ({
  moduleUrl: "",
  preload: "",
  gate: undefined as SharedArrayBuffer | undefined,
  worker: undefined as Worker | undefined,
  onMessage: undefined as ((message: FixtureMessage) => void) | undefined,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        const selected = boundary.preload && filename.toString() === boundary.moduleUrl;
        super(
          filename,
          selected
            ? {
                ...options,
                execArgv: [...(options?.execArgv ?? []), "--require", boundary.preload],
                workerData: { ...options?.workerData, fixtureProgressGate: boundary.gate },
              }
            : options,
        );
        if (selected) {
          boundary.worker = this;
          this.on("message", (message: FixtureMessage) => boundary.onMessage?.(message));
        }
      }
    },
  };
});
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    boundary.moduleUrl = boundary.preload = "";
    boundary.worker = boundary.gate = undefined;
    boundary.onMessage = undefined;
    vi.restoreAllMocks();
    cleanup();
  }),
);

test.each(["scan", "admission", "stale-failure", "validation-revocation"] as const)(
  "cold reclamation verifies under one admitted writer after %s",
  async (phase) => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("reclamation-progress-") };
    const options = { agentId: "main", env };
    ensureSessionEntrySync(
      { ...options, sessionKey: "agent:main:retained" },
      { sessionId: "retained", updatedAt: 1 },
    );
    const source = openOpenClawAgentDatabase(options);
    if (phase !== "validation-revocation") {
      clearOpenClawAgentIntegrityVerification(source.path, env);
    }
    const databaseOptions = { ...options, path: source.path };
    const gate = new Int32Array(new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT));
    const unblock = () => {
      Atomics.store(gate, 0, -1);
      Atomics.notify(gate, 0);
    };
    onTestFinished(unblock);
    const preload = path.join(env.OPENCLAW_STATE_DIR, "progress-boundary.cjs");
    writeFileSync(
      preload,
      `
    const { DatabaseSync } = require('node:sqlite');
    const { workerData, parentPort } = require('node:worker_threads');
    const gate = new Int32Array(workerData.fixtureProgressGate);
    const target = ${JSON.stringify(realpathSync(source.path))};
    const prepare = DatabaseSync.prototype.prepare;
    let retained;
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = prepare.call(this, sql);
      if (this.location() !== target) return statement;
      retained ??= this;
      if (this !== retained && /^PRAGMA integrity_check;?$/i.test(sql.trim())) {
        Atomics.add(gate, 2, 1);
      }
      if (this === retained && /^PRAGMA foreign_key_check;?$/i.test(sql.trim())) {
        const iterate = statement.iterate;
        statement.iterate = function* (...args) {
          yield* iterate.apply(this, args);
          const sequence = Atomics.add(gate, 1, 1) + 1;
          if (${JSON.stringify(phase === "scan" || phase === "stale-failure")}) {
            parentPort.postMessage({type:'fixture-preparation-complete',sequence});
            for (;;) {
              const observed = Atomics.load(gate, 0);
              if (observed < 0 || observed >= sequence) break;
              Atomics.wait(gate, 0, observed);
            }
            if (${JSON.stringify(phase)} === 'stale-failure') {
              Atomics.add(gate, 3, 1);
              throw Object.assign(new Error('synthetic stale integrity verdict after real checks'), {errcode: 11});
            }
          }
        };
      }
      return statement;
    };
  `,
    );
    boundary.preload = preload;
    boundary.moduleUrl = resolveRuntimeWorkerUrl(
      runtimeProcessEntrypoints.sessionTranscriptArchive,
    ).href;
    boundary.gate = gate.buffer;
    const competingCommits = 3;
    let committed = 0;
    let admissions = 0;
    let invalidations = 0;
    let completed = false;
    const operations: Promise<void>[] = [];
    const failures: unknown[] = [];
    const observations: Array<{
      boundary: string;
      committed: number;
      admissions: number;
      scans: number;
      completed: boolean;
    }> = [];
    const commit = () =>
      runOpenClawAgentWriteAdmission(databaseOptions, () => {
        const revision = committed + 1;
        assert.equal(
          ensureSessionEntrySync(
            { ...options, sessionKey: `agent:main:writer-${revision}` },
            { sessionId: `writer-${revision}`, updatedAt: revision },
          ),
          true,
        );
        assert.equal(
          loadSessionEntry({ ...options, sessionKey: `agent:main:writer-${revision}` })?.sessionId,
          `writer-${revision}`,
        );
        committed = revision;
      });
    boundary.onMessage = (message) => {
      if (message.type === "admission-request") {
        admissions += 1;
        observations.push({
          boundary: "admission",
          committed,
          admissions,
          scans: Atomics.load(gate, 1),
          completed,
        });
        if (phase === "validation-revocation" && invalidations === 0) {
          invalidateOpenClawAgentDatabaseValidation(source.path);
          invalidations += 1;
        }
        if (phase === "admission" && committed < competingCommits) {
          operations.push(
            commit().catch((error: unknown) => {
              failures.push(error);
            }),
          );
        }
      } else if (message.type === "fixture-preparation-complete") {
        const sequence = message.sequence;
        assert.ok(sequence);
        observations.push({ boundary: "scan", committed, admissions, scans: sequence, completed });
        const writing = committed < competingCommits ? commit() : Promise.resolve();
        operations.push(
          writing
            .catch((error: unknown) => {
              failures.push(error);
            })
            .finally(() => {
              Atomics.store(gate, 0, sequence);
              Atomics.notify(gate, 0);
            }),
        );
      }
    };
    try {
      await runSqliteSessionReclamation({
        forceInProcess: false,
        plan: createLifecycleArtifactReclamationPlan({
          agentId: options.agentId,
          databaseOptions,
          entries: [],
          materializedPlans: [],
        }),
      });
      completed = true;
      await Promise.all(operations);
      await closeOpenClawAgentDatabasesAsync();
      console.log(
        JSON.stringify({
          proof: "cold1-progress",
          phase,
          committed,
          admissions,
          invalidations,
          injectedStaleFailures: Atomics.load(gate, 3),
          preparationScans: Atomics.load(gate, 1),
          integrityChecksOnOtherConnections: Atomics.load(gate, 2),
          completed,
          nativeExitJoined: boundary.worker?.threadId === -1,
          observations,
        }),
      );
      expect(failures).toEqual([]);
      if (phase === "validation-revocation") {
        expect(invalidations).toBe(1);
      } else {
        expect(committed).toBeGreaterThan(0);
      }
      expect(boundary.worker?.threadId).toBe(-1);
      expect(admissions).toBe(1);
      expect(Atomics.load(gate, 1)).toBe(phase === "validation-revocation" ? 0 : 1);
      expect(Atomics.load(gate, 2)).toBe(1);
      expect(Atomics.load(gate, 3)).toBe(phase === "stale-failure" ? 1 : 0);
      expect(loadSessionEntry({ ...options, sessionKey: "agent:main:retained" })?.sessionId).toBe(
        "retained",
      );
    } finally {
      unblock();
      await Promise.allSettled(operations);
    }
  },
);

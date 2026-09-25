import assert from "node:assert/strict";
import { once } from "node:events";
import { parentPort, workerData } from "node:worker_threads";

const { register } = await import(workerData.sourceLoaderUrl);
register();
const { runWithSqliteMutationWorkerCoordination } =
  await import("../config/sessions/session-accessor.sqlite-worker-coordination.ts");
const { readExactSessionEntryCandidatesInDatabase } =
  await import("../config/sessions/session-accessor.sqlite-entry-cache.ts");
const { deleteSessionEntryRows } =
  await import("../config/sessions/session-accessor.sqlite-entry-store.ts");
const {
  closeOpenClawAgentDatabaseByPathAsync,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} = await import("../state/openclaw-agent-db.ts");
const { closeOpenClawStateDatabase } = await import("../state/openclaw-state-db.ts");
const { SessionMutationFactsUnavailableError } =
  await import("./session-mutation-authorization-error.ts");
const { readSessionMutationFactsInWorker } = await import("./session-sharing-worker-read.ts");
const [coordination] = await once(parentPort, "message");
const read = workerData.read;
const report = await runWithSqliteMutationWorkerCoordination(
  coordination,
  1,
  workerData.databaseOptions,
  async (options) => {
    const database = openOpenClawAgentDatabase(options);
    const key = read.expected.storeKey;
    const sentinel =
      workerData.failure === "Error" ? new Error("exact native row failure") : undefined;
    const prototype = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
    const original = new Map();
    const observations = [];
    let result;
    try {
      assert.equal(
        readSessionMutationFactsInWorker(database, read).target.entry.sessionId,
        read.expected.sessionId,
      );
      if (workerData.failure === "deleted") {
        runOpenClawAgentWriteTransaction((owned) => {
          assert.equal(owned, database);
          deleteSessionEntryRows(owned, key);
        }, options);
      } else {
        for (const method of ["all", "get", "iterate"]) {
          const invoke = prototype[method];
          original.set(method, invoke);
          prototype[method] = function (...args) {
            const sql = this.sourceSQL;
            const selected =
              sql.includes('from "session_nodes"') &&
              sql.includes('"current_session_id"') &&
              sql.includes('"updated_at"');
            const cohort =
              selected && sql.includes("json_each(") && args.includes(JSON.stringify([key]));
            const single = selected && sql.includes('"session_key" = ?') && args.includes(key);
            if (cohort || single) {
              observations.push(cohort ? "cohort" : "single");
              // The worker boundary must preserve the original raw failure, including undefined.
              // oxlint-disable-next-line typescript/only-throw-error
              throw sentinel;
            }
            return Reflect.apply(invoke, this, args);
          };
        }
      }
      const produced = readExactSessionEntryCandidatesInDatabase(database, [[key]], "list")[0];
      assert.ok(produced);
      let caught;
      try {
        readSessionMutationFactsInWorker(database, read);
      } catch (error) {
        caught = { error };
      }
      assert.ok(caught, "the original sharing guard must refuse the failed or deleted row");
      if (workerData.failure === "deleted") {
        assert.equal(produced.ok, true);
        assert.deepEqual(produced.value, []);
        assert.ok(caught.error instanceof SessionMutationFactsUnavailableError);
        result = { empty: true, unavailable: true, observations };
      } else {
        assert.equal(produced.ok, false);
        assert.equal(produced.error, sentinel);
        assert.equal(caught.error, sentinel);
        assert.deepEqual(observations, ["cohort", "single", "cohort", "single"]);
        result = { producerIdentity: true, guardIdentity: true, observations };
      }
    } finally {
      for (const [method, invoke] of original) {
        prototype[method] = invoke;
      }
      await closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId);
      assert.equal(getOpenClawAgentDatabaseIfOpen(options), undefined);
      closeOpenClawStateDatabase();
    }
    return { ...result, closed: true };
  },
);
parentPort.postMessage(report, []);
parentPort.close();

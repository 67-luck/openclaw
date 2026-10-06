import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { runWithSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import type { createSqliteWalCheckpoint } from "./sqlite-wal-checkpoint.js";
import { SQLITE_WAL_RESTART_BYTES } from "./sqlite-wal-policy.js";
import {
  createSqliteWalReclamationSteps,
  reclaimSqliteWalFreePages,
  type SqliteWalReclamationResult,
} from "./sqlite-wal-reclamation.js";
import type {
  SqliteWalPeriodicRequest,
  SqliteWalPeriodicResult,
} from "./sqlite-wal-write-admission.js";
import type { SqliteWalMaintenance } from "./sqlite-wal.js";
import type { SqliteWorkerWalLease } from "./sqlite-worker-wal-context.js";
import type { SqliteWalMaintenanceDispatchResult } from "./sqlite-worker-wal.types.js";

type Admit = (stage: "transaction" | "commit") => void;
type Periodic = NonNullable<SqliteWalMaintenance["maintainPeriodic"]>;
type AsyncPeriodic = {
  lease: SqliteWorkerWalLease;
  admit?: Admit;
  maintain?: () => void;
  run(
    request: SqliteWalPeriodicRequest,
    assertCurrent: () => void,
    admit?: Admit,
    maintain?: () => void,
  ): Promise<SqliteWalPeriodicResult>;
};
const asyncOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWalPeriodicOwners"),
  () => new WeakMap<Periodic, AsyncPeriodic>(),
);

/** A reused native handle binds opportunistic work to its current actor's grants. */
export function bindSqliteWalPeriodicAdmission(
  maintenance: SqliteWalMaintenance,
  admit: Admit,
): void {
  const owner = maintenance.maintainPeriodic && asyncOwners.get(maintenance.maintainPeriodic);
  if (owner) {
    owner.lease.bind();
    owner.admit = admit;
  }
}

/** Return a pass receipt; its checkpoint waits never retain the writer request. */
export function startSqliteWalWorkerMaintenance(
  maintenance: SqliteWalMaintenance,
  request: SqliteWalPeriodicRequest,
  admit?: Admit,
  maintain?: () => void,
): SqliteWalMaintenanceDispatchResult {
  const periodic = maintenance.maintainPeriodic;
  const owner = periodic && asyncOwners.get(periodic);
  if (!owner) {
    return {
      kind: "complete",
      result: periodic?.(request, admit, maintain) ?? { reclaimedPages: 0 },
    };
  }
  owner.admit = admit ?? owner.admit;
  owner.maintain = maintain ?? owner.maintain;
  const passAdmit = owner.admit;
  const passMaintain = owner.maintain;
  const pass = owner.lease.startPass(
    (assertCurrent) => owner.run(request, assertCurrent, passAdmit, passMaintain),
    true,
  );
  return { kind: "pending", receipt: pass.receipt };
}

export function createSqliteWalPeriodicMaintenance(
  database: DatabaseSync,
  checkpoint: ReturnType<typeof createSqliteWalCheckpoint>,
  runMaintenance: (operation: () => boolean) => boolean,
  onAttempt: () => void,
  lease?: SqliteWorkerWalLease,
) {
  const finish = (reclaimed: SqliteWalReclamationResult): SqliteWalPeriodicResult => ({
    reclaimedPages:
      reclaimed.checkpointCompleted &&
      reclaimed.freePagesBefore !== null &&
      reclaimed.remainingFreePages !== null
        ? Math.min(
            reclaimed.vacuumPagesRequested,
            reclaimed.freePagesBefore - reclaimed.remainingFreePages,
          )
        : 0,
    checkpoint: checkpoint.snapshot,
  });
  const maintainAfterCheckpoint = (
    request: SqliteWalPeriodicRequest,
    completed: boolean,
    maintain?: () => void,
  ) => {
    if (completed && request.maxPages > 0 && !request.continuation) {
      try {
        maintain?.();
      } catch (error) {
        if (!isSqliteLockError(error)) {
          throw error;
        }
      }
    }
  };
  const periodic: Periodic = (request, admit, maintain) => {
    if (request.checkpoint) {
      checkpoint.adopt(request.checkpoint);
    }
    let result: SqliteWalPeriodicResult = { reclaimedPages: 0 };
    runMaintenance(() => {
      onAttempt();
      const runCheckpoint = (mode: SqliteWalPeriodicRequest["checkpointMode"]) =>
        checkpoint.checkpoint(mode, { quiet: request.maxPages === 0 });
      const reclaimed = reclaimSqliteWalFreePages(database, runCheckpoint, {
        checkpointMode: request.checkpointMode,
        maxPages: request.maxPages,
        beforeMutation: () => admit?.("transaction"),
        onCommit: () => admit?.("commit"),
      });
      if (
        reclaimed.checkpointCompleted &&
        request.checkpointMode === "PASSIVE" &&
        (checkpoint.health?.walBytes ?? 0) > SQLITE_WAL_RESTART_BYTES
      ) {
        admit?.("transaction");
        runWithSqliteBusyTimeout(database, 0, () => runCheckpoint("RESTART"));
      }
      result = finish(reclaimed);
      maintainAfterCheckpoint(request, reclaimed.checkpointCompleted, maintain);
      return reclaimed.checkpointCompleted;
    });
    return { ...result, checkpoint: checkpoint.snapshot };
  };
  let deferred:
    | ((request: SqliteWalPeriodicRequest) => Promise<SqliteWalPeriodicResult | undefined>)
    | undefined;
  if (lease) {
    const owner: AsyncPeriodic = {
      lease,
      async run(request, assertCurrent, admit, maintain) {
        onAttempt();
        const steps = createSqliteWalReclamationSteps(database, {
          checkpointMode: "PASSIVE",
          maxPages: request.maxPages,
          beforeMutation: () => admit?.("transaction"),
          onCommit: () => admit?.("commit"),
        });
        const advance = (completed: boolean) =>
          lease.schedule(() => {
            assertCurrent();
            lease.assertCurrent();
            let step: ReturnType<typeof steps.next> | undefined;
            runMaintenance(() => {
              step = runWithSqliteBusyTimeout(database, 0, () => steps.next(completed));
              return true;
            });
            if (!step) {
              throw new Error("SQLite periodic maintenance lost its native owner");
            }
            return step;
          });
        // The first yield only requests a checkpoint and holds no SQLite statement or grant.
        let step = steps.next();
        while (!step.done) {
          assertCurrent();
          const observation = await lease.checkpoint();
          if (!observation) {
            return { reclaimedPages: 0, checkpoint: checkpoint.snapshot };
          }
          assertCurrent();
          checkpoint.adopt(observation);
          const next = await advance(observation.health.state === "complete");
          if (!next) {
            throw new Error("SQLite periodic maintenance was cancelled before its native unit");
          }
          step = next;
        }
        const reclaimed = step.value;
        if (
          maintain &&
          reclaimed.checkpointCompleted &&
          request.maxPages > 0 &&
          !request.continuation
        ) {
          await lease.schedule(() => {
            assertCurrent();
            lease.assertCurrent();
            runMaintenance(() => {
              maintainAfterCheckpoint(request, reclaimed.checkpointCompleted, maintain);
              return reclaimed.checkpointCompleted;
            });
          });
        }
        return finish(reclaimed);
      },
    };
    asyncOwners.set(periodic, owner);
    deferred = (request) => {
      const admit = owner.admit;
      const maintain = owner.maintain;
      return lease.startPass(
        (assertCurrent) => owner.run(request, assertCurrent, admit, maintain),
        false,
      ).result;
    };
  }
  return { periodic, deferred };
}

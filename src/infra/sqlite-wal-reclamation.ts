import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { runWithSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import type {
  SqliteWalCheckpointMode,
  SqliteWalCheckpointSnapshot,
} from "./sqlite-wal-checkpoint.js";

const VACUUM_UNIT_TARGET_MS = 25;
// Scheduling estimates belong to the native connection lifetime, never persisted store facts.
const vacuumPageBudgets = new WeakMap<DatabaseSync, number>();

export type SqliteWalReclamationOptions = {
  maxPages?: number;
  checkpointMode?: SqliteWalCheckpointMode;
  beforeMutation?: () => void;
  onCommit?: () => void;
  afterCommit?: () => void;
};

export type SqliteWalReclamationResult = {
  checkpointCompleted: boolean;
  checkpoint?: SqliteWalCheckpointSnapshot;
  freePagesBefore: number | null;
  remainingFreePages: number | null;
  checkpointCalls: number;
  checkpointIncomplete: number;
  checkpointMs: number;
  checkpointMaxMs: number;
  queryMs: number;
  vacuumMs: number;
  vacuumPasses: number;
  vacuumPagesRequested: number;
};

export function createSqliteWalReclamationResult(): SqliteWalReclamationResult {
  return {
    checkpointCompleted: false,
    freePagesBefore: null,
    remainingFreePages: null,
    checkpointCalls: 0,
    checkpointIncomplete: 0,
    checkpointMs: 0,
    checkpointMaxMs: 0,
    queryMs: 0,
    vacuumMs: 0,
    vacuumPasses: 0,
    vacuumPagesRequested: 0,
  };
}

/** One online unit never waits for readers or adds vacuum frames behind a blocked checkpoint. */
export function reclaimSqliteWalFreePages(
  database: DatabaseSync,
  runCheckpoint: (mode: SqliteWalCheckpointMode) => boolean,
  options: SqliteWalReclamationOptions,
): SqliteWalReclamationResult {
  return runWithSqliteBusyTimeout(database, 0, () => {
    const steps = createSqliteWalReclamationSteps(database, options);
    let step = steps.next();
    while (!step.done) {
      options.beforeMutation?.();
      step = steps.next(runCheckpoint(step.value));
    }
    return step.value;
  });
}

/** Yield only at checkpoint boundaries, with no native transaction or statement held. */
export function* createSqliteWalReclamationSteps(
  database: DatabaseSync,
  options: SqliteWalReclamationOptions,
): Generator<SqliteWalCheckpointMode, SqliteWalReclamationResult, boolean> {
  const result = createSqliteWalReclamationResult();
  const checkpoint = function* (): Generator<SqliteWalCheckpointMode, boolean, boolean> {
    const startedAt = performance.now();
    try {
      const mode = options.checkpointMode ?? "TRUNCATE";
      let completed = yield mode;
      result.checkpointCalls++;
      if (!completed && mode === "TRUNCATE") {
        // Readers can prevent WAL reset after every frame has been copied.
        // Require a fresh complete checkpoint, not an empty WAL file, before
        // adding vacuum frames or letting disk-budget eviction proceed.
        completed = yield "PASSIVE";
        result.checkpointCalls++;
      }
      result.checkpointCompleted = completed;
      result.checkpointIncomplete += Number(!completed);
      return completed;
    } finally {
      const elapsed = performance.now() - startedAt;
      result.checkpointMs += elapsed;
      result.checkpointMaxMs = Math.max(result.checkpointMaxMs, elapsed);
    }
  };
  const freePages = () => {
    const startedAt = performance.now();
    try {
      return Number(
        // sqlite-allow-raw -- Physical page accounting belongs to the WAL owner.
        database.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0,
      );
    } finally {
      result.queryMs += performance.now() - startedAt;
    }
  };
  // A zero page budget is a checkpoint-only pass; vacuum keeps its own cadence.
  if (!(yield* checkpoint()) || options.maxPages === 0) {
    return result;
  }
  const before = freePages();
  result.freePagesBefore = before;
  result.remainingFreePages = before;
  if (!Number.isSafeInteger(before) || before <= 0) {
    return result;
  }
  const pages = Math.min(vacuumPageBudgets.get(database) ?? 8, before, options.maxPages ?? 512);
  if (!Number.isSafeInteger(pages) || pages <= 0) {
    throw new Error("SQLite page reclamation requires a positive integer page limit");
  }
  const startedAt = performance.now();
  let entered = false;
  let completed = false;
  try {
    runSqliteImmediateTransactionSync(
      database,
      () => {
        entered = true;
        options.beforeMutation?.();
        result.vacuumPasses++;
        result.vacuumPagesRequested += pages;
        // sqlite-allow-raw -- Bound physical maintenance within its admitted synchronous transaction.
        database.exec(`PRAGMA incremental_vacuum(${pages});`);
        options.onCommit?.();
      },
      { busyTimeoutMs: 0, operationLabel: "incremental-vacuum" },
    );
    completed = true;
  } catch (error) {
    if (entered || !isSqliteLockError(error)) {
      throw error;
    }
    return result;
  } finally {
    const elapsedMs = performance.now() - startedAt;
    result.vacuumMs += elapsedMs;
    if (completed) {
      vacuumPageBudgets.set(
        database,
        Math.max(
          1,
          Math.min(
            512,
            pages * 2,
            Math.floor((pages * VACUUM_UNIT_TARGET_MS) / Math.max(elapsedMs, 0.001)),
          ),
        ),
      );
    }
  }
  options.afterCommit?.();
  if (yield* checkpoint()) {
    result.remainingFreePages = freePages();
  }
  return result;
}

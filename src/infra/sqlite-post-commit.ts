import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";

type PendingTransactionState = {
  commit: () => void;
  prepareObservers?: () => void;
  rollback: (error: unknown) => void;
};

type StagedTransactionState = PendingTransactionState & { stage: (transaction: object) => void };

type TransactionJournal = {
  publications: Array<() => void>;
  states: PendingTransactionState[];
  phase: "transaction" | "committed" | "rolled-back" | "discarded";
  previous?: TransactionJournal;
};

export type CapturedSqliteTransactionState = {
  transaction: object;
  stage: (state: StagedTransactionState) => boolean;
};

// One connection can cross native and transformed SDK module graphs mid-transaction.
const transactionJournals = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteTransactionState"),
  () => new WeakMap<DatabaseSync, TransactionJournal>(),
);

function currentJournal(db: DatabaseSync): TransactionJournal | undefined {
  const journal = transactionJournals.get(db);
  return journal?.phase === "transaction" ? journal : undefined;
}

/** Snapshots read within this managed transaction can still roll back. */
export function hasSqlitePostCommitScope(db: DatabaseSync): boolean {
  return currentJournal(db) !== undefined;
}

/** Fallible observers run after COMMIT; their errors propagate without rolling back durable state. */
export function deferSqlitePostCommitPublication(db: DatabaseSync, publish: () => void): boolean {
  const journal = currentJournal(db);
  if (!journal) {
    return false;
  }
  journal.publications.push(publish);
  return true;
}

/** A retained completion must never borrow a later transaction on the same connection. */
export function captureSqlitePostCommitPublication(db: DatabaseSync) {
  const journal = currentJournal(db);
  return (publish: () => void): boolean => {
    if (!journal || currentJournal(db) !== journal) {
      return false;
    }
    journal.publications.push(publish);
    return true;
  };
}

/**
 * Stage private transaction-local state that publishes before fallible observers.
 * Observer preparation follows every committed state update. All callbacks must not throw.
 */
export function stageSqliteTransactionState(
  db: DatabaseSync,
  state: StagedTransactionState,
): boolean {
  return captureSqliteTransactionState(db)?.stage(state) ?? false;
}

/** A view read from a tentative snapshot retains that exact journal, never its successor. */
export function captureSqliteTransactionState(
  db: DatabaseSync,
): CapturedSqliteTransactionState | undefined {
  const journal = currentJournal(db);
  if (!journal) {
    return undefined;
  }
  return {
    transaction: journal.states,
    stage(state) {
      if (currentJournal(db) !== journal) {
        return false;
      }
      state.stage(journal.states);
      journal.states.push({
        commit: state.commit,
        prepareObservers: state.prepareObservers,
        rollback: state.rollback,
      });
      return true;
    },
  };
}

function rollbackTransactionState(states: PendingTransactionState[], error: unknown): void {
  const failures: unknown[] = [];
  for (const state of states.toReversed()) {
    try {
      state.rollback(error);
    } catch (failure) {
      failures.push(failure);
    }
  }
  if (failures.length > 0) {
    throw createSqliteLifecycleAggregateError(
      [error, ...failures],
      "SQLite transaction and rollback observers failed",
      error,
    );
  }
}

/** A lost transaction invalidates every savepoint's staged state and observers. */
export function discardSqliteTransactionState(db: DatabaseSync, error: unknown): void {
  const batches: PendingTransactionState[][] = [];
  // Invalidate every suspended uncommitted owner before any inverse can reenter.
  // A committed inner tail keeps its receipts and cannot revive a poisoned parent.
  for (let journal = transactionJournals.get(db); journal; journal = journal.previous) {
    if (journal.phase !== "transaction") {
      continue;
    }
    journal.phase = "discarded";
    journal.publications.splice(0);
    batches.unshift(journal.states.splice(0));
  }
  rollbackTransactionState(batches.flat(), error);
}

/** Nested rollback restores staged state and discards observers; savepoints wait for outer commit. */
export function withSqlitePostCommitPublications<T>(
  db: DatabaseSync,
  transaction: () => T,
  retainPublication?: (publish: () => void) => void,
): T {
  const nested = db.isTransaction;
  const journal: TransactionJournal | undefined = nested
    ? currentJournal(db)
    : {
        publications: [],
        states: [],
        phase: "transaction",
        previous: transactionJournals.get(db),
      };
  const publications = journal?.publications;
  const transactionState = journal?.states;
  const publicationStart = publications?.length ?? 0;
  const stateStart = transactionState?.length ?? 0;
  if (!nested) {
    transactionJournals.set(db, journal!);
  }
  try {
    let result: T;
    try {
      result = transaction();
    } catch (error) {
      if (!nested && journal!.phase !== "discarded") {
        journal!.phase = "rolled-back";
      }
      publications?.splice(publicationStart);
      const rolledBackState = transactionState?.splice(stateStart) ?? [];
      rollbackTransactionState(rolledBackState, error);
      throw error;
    }
    if (!nested) {
      journal!.phase = "committed";
      const failures: unknown[] = [];
      for (const state of transactionState ?? []) {
        try {
          state.commit();
        } catch (error) {
          failures.push(error);
        }
      }
      for (const state of transactionState ?? []) {
        try {
          state.prepareObservers?.();
        } catch (error) {
          failures.push(error);
        }
      }
      // These fixed phases carry every original native receipt. A failure cannot
      // skip a sibling receipt or turn the already committed transaction into rollback.
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length) {
        throw createSqliteLifecycleAggregateError(
          failures,
          "SQLite committed state settlement failed",
          failures[0],
        );
      }
      const publish = () => {
        // Detach before invoking observers so a retained/reentrant continuation
        // cannot replay a completed batch, including after its first failure.
        for (const observer of publications?.splice(0) ?? []) {
          observer();
        }
      };
      if (retainPublication) {
        retainPublication(publish);
      } else {
        publish();
      }
    }
    return result;
  } finally {
    if (!nested) {
      // BEGIN admission can run another root before this root starts. Keep its
      // closed frame on top through every tail so callbacks cannot borrow the parent.
      const previous = journal!.previous;
      if (previous && previous.phase !== "discarded") {
        transactionJournals.set(db, previous);
      } else {
        transactionJournals.delete(db);
      }
      journal!.previous = undefined;
    }
  }
}

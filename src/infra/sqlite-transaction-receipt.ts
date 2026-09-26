import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { isPromise } from "node:util/types";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type SqliteTransactionReceipt = {
  beforeCommit(): void;
  committed(): void;
};
export type SqliteCreatedFileIdentity = { dev: bigint; ino: bigint; birthtimeNs: bigint };
export type SqliteTransactionReceiptObserver = ((
  database: DatabaseSync,
) => SqliteTransactionReceipt | undefined) & {
  prepareOpen?(pathname: string, reserve: () => SqliteCreatedFileIdentity | undefined): void;
  opened?(database: DatabaseSync): void;
};

// Receipts observe an already-admitted native transaction; they never grant admission.
const observers = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteTransactionReceiptObserver"),
  () => new AsyncLocalStorage<SqliteTransactionReceiptObserver>(),
);

export function withSqliteTransactionReceiptObserver<T>(
  observer: SqliteTransactionReceiptObserver | undefined,
  operation: () => T,
): T {
  if (!observer) {
    return operation();
  }
  let active = true;
  const release = () => {
    active = false;
  };
  try {
    const scoped: SqliteTransactionReceiptObserver = (database) =>
      active ? observer(database) : undefined;
    scoped.prepareOpen = (pathname, reserve) => {
      if (active) {
        observer.prepareOpen?.(pathname, reserve);
      }
    };
    scoped.opened = (database) => {
      if (active) {
        observer.opened?.(database);
      }
    };
    const result = observers.run(scoped, operation);
    if (isPromise(result)) {
      void result.then(release, release);
    } else {
      release();
    }
    return result;
  } catch (error) {
    release();
    throw error;
  }
}

/** The native-open owner can certify exclusive creation; the observer cannot grant open authority. */
export function observeSqliteReceiptOpen(
  pathname: string,
  reserve: () => SqliteCreatedFileIdentity | undefined,
): void {
  observers.getStore()?.prepareOpen?.(pathname, reserve);
}

export function observeSqliteReceiptOpened(database: DatabaseSync): void {
  observers.getStore()?.opened?.(database);
}

export function runOutsideSqliteTransactionReceiptObserver<T>(operation: () => T): T {
  return observers.exit(operation);
}

/** Called only after BEGIN IMMEDIATE excludes other native writers. */
export function observeSqliteTransaction(
  database: DatabaseSync,
): SqliteTransactionReceipt | undefined {
  return observers.getStore()?.(database);
}

import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  UpdateDatabaseGenerations,
  UpdateDatabaseWriteAttribution,
} from "./update-database-generations.js";

export type UpdateDatabaseMigrationCommit = {
  runId: string;
  path: string;
  migrationId: string;
  fromContentVersion: string | null;
  toContentVersion: string | null;
  foreignWrite: boolean;
};

export type UpdateMigrationObserver = {
  runId: string;
  record(commit: UpdateDatabaseMigrationCommit): void;
  begin(database: DatabaseSync, migrationId: string): (() => void) | undefined;
};

const observer = resolveGlobalSingleton(
  Symbol.for("openclaw.updateDatabaseMigrationObserver"),
  () => new AsyncLocalStorage<UpdateMigrationObserver>(),
);

export function captureUpdateDatabaseMigrationObserver(): UpdateMigrationObserver | undefined {
  return observer.getStore();
}

/** Arrival order is not commit order when native workers publish alongside the caller. */
export function orderUpdateDatabaseMigrationWrites(
  before: UpdateDatabaseGenerations,
  after: UpdateDatabaseGenerations,
  writes: UpdateDatabaseWriteAttribution["writes"],
): Pick<UpdateDatabaseWriteAttribution, "writes" | "unattributedPaths"> {
  const ordered: UpdateDatabaseWriteAttribution["writes"] = [];
  const unattributedPaths: string[] = [];
  for (const pathname of Object.keys(before)) {
    const pending = writes.filter((write) => write.path === pathname);
    let current = before[pathname];
    while (pending.length > 0) {
      let index = pending.findIndex(
        (write) => write.fromContentVersion === current && write.toContentVersion === current,
      );
      if (index < 0) {
        index = pending.findIndex((write) => write.fromContentVersion === current);
      }
      if (index < 0) {
        break;
      }
      const [write] = pending.splice(index, 1);
      ordered.push(write!);
      current = write!.toContentVersion;
    }
    if (pending.length > 0 || after[pathname] !== current) {
      unattributedPaths.push(pathname);
    }
  }
  return { writes: ordered, unattributedPaths };
}

export function withUpdateDatabaseMigrationObserver<T>(
  value: UpdateMigrationObserver,
  operation: () => T,
): T {
  return observer.run(value, operation);
}

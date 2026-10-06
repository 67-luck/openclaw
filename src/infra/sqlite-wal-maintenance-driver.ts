import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  SqliteWalPeriodicRequest,
  SqliteWalPeriodicResult,
} from "./sqlite-wal-write-admission.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";
import type { SqliteWalMaintenanceDispatchResult } from "./sqlite-worker-wal.types.js";

type RunMaintenance = (
  start: () => Promise<SqliteWalMaintenanceDispatchResult>,
  options: { signal?: AbortSignal },
) => Promise<SqliteWalPeriodicResult>;
const bindings = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWalMaintenanceScopes"),
  () => new WeakMap<object, RunMaintenance>(),
);

/** Project operation custody; the client invalidates every binding when its scope settles. */
export function registerSqliteWalMaintenanceScope(scope: object, run: RunMaintenance): void {
  bindings.set(scope, run);
}

export function inheritSqliteWalMaintenanceScope(source: object, target: object): void {
  const run = bindings.get(source);
  if (run) {
    bindings.set(target, run);
  }
}

/** Keep completion custody while checkpoint waits leave the writer FIFO available. */
export function runSqliteWalWorkerMaintenance(
  scope: {
    execute(
      command: { type: "database.walMaintenance"; input: SqliteWalPeriodicRequest },
      options?: { signal?: AbortSignal },
    ): Promise<SqliteWalMaintenanceDispatchResult>;
  },
  request: SqliteWalPeriodicRequest,
  options: { signal?: AbortSignal } = {},
): Promise<SqliteWalPeriodicResult> {
  const run = bindings.get(scope);
  if (!run) {
    return Promise.reject(
      new SqliteWorkerError("SQLite maintenance scope has no native owner", "unavailable"),
    );
  }
  return run(
    () => scope.execute({ type: "database.walMaintenance", input: request }, options),
    options,
  );
}

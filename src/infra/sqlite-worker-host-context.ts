import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { Actor, OperationScope } from "./sqlite-worker-broker.types.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";

export type SqliteWorkerHostDriver = {
  actor: Actor;
  viewOwner?: object;
  transaction: object;
  active: boolean;
  assertLive(): void;
  callerActive(): boolean;
  publishAfterSettlement(publish: () => void): void;
  stageRollback(rollback: () => void): void;
  execute(
    actor: Actor,
    payload: Uint8Array,
    scope: OperationScope,
    assertCurrent: () => void,
  ): { value: unknown; pending: Promise<unknown> };
};
const hostDrivers = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerHostDriver"),
  () => new AsyncLocalStorage<SqliteWorkerHostDriver>(),
);

/** A direct descendant cannot queue behind the native frame waiting for its caller. */
export function executeSqliteWorkerScopedCommand(
  actor: Actor,
  payload: Uint8Array,
  scope: OperationScope,
  assertCurrent: () => void,
) {
  const driver = hostDrivers.getStore();
  if (!driver || !driver.active || driver.actor.slot !== actor.slot) {
    return undefined;
  }
  driver.assertLive();
  const slot = actor.slot;
  if (
    !driver.callerActive() ||
    !slot.actors.has(actor) ||
    slot.failed ||
    slot.retiring ||
    slot.retirementReason ||
    slot.childStopped ||
    actor.runtimeGeneration !== driver.actor.runtimeGeneration ||
    !actor.initialized ||
    actor.backendClosed ||
    actor.protocolFailure ||
    (driver.actor !== actor && (driver.actor.volatile || !actor.volatile))
  ) {
    throw new SqliteWorkerError("SQLite descendant lost its retained native owner", "unavailable");
  }
  return driver.execute(actor, payload, scope, assertCurrent);
}

/** View attribution is not admission: capture this exact live journal before updating a manager. */
export function captureSqliteWorkerCallerViewRollback(viewOwner: object | undefined) {
  const driver = hostDrivers.getStore();
  if (!viewOwner || !driver?.active || !driver.callerActive() || driver.viewOwner !== viewOwner) {
    return undefined;
  }
  return (rollback: () => void) => {
    if (!driver.active || !driver.callerActive()) {
      return false;
    }
    driver.stageRollback(rollback);
    return true;
  };
}

/** An opaque direct-caller scope labels tentative state; it supplies no write authority. */
export function captureSqliteWorkerCallerTransaction(): object | undefined {
  const driver = hostDrivers.getStore();
  return driver?.active && driver.callerActive() ? driver.transaction : undefined;
}

/** Outward observation resumes on the original host driver, never in private settlement. */
export function deferSqliteWorkerCallerPublication(publish: () => void): boolean {
  const driver = hostDrivers.getStore();
  if (!driver?.active || !driver.callerActive()) {
    return false;
  }
  driver.publishAfterSettlement(publish);
  return true;
}

/** Only fixed host state is staged here; native transaction outcome decides its rollback. */
export function stageSqliteWorkerCallerRollback(rollback: () => void): boolean {
  const driver = hostDrivers.getStore();
  if (!driver?.active || !driver.callerActive()) {
    return false;
  }
  driver.stageRollback(rollback);
  return true;
}

export function runSqliteWorkerHostContext<T>(
  inCaller: ReturnType<typeof AsyncLocalStorage.snapshot>,
  runHostStep: (<Value>(run: () => Value) => Value) | undefined,
  driver: SqliteWorkerHostDriver | undefined,
  run: () => T,
): T {
  // Restoring the writer snapshot also restores ALS. Install the exact driver
  // afterward so nested commands cannot queue behind their parent.
  const invoke = () => (driver ? hostDrivers.run(driver, run) : run());
  return inCaller(() => (runHostStep ? runHostStep(invoke) : invoke()));
}

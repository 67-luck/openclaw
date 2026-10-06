import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveGatewayStateOwnerPath } from "../infra/gateway-state-owner.js";
import { createSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import { createUpdateDoctorDatabaseWriteCapture } from "../infra/update-doctor-result.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import {
  createOpenClawDatabaseMaintenanceScope,
  type OpenClawDatabaseMaintenanceScope,
} from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { acquireDoctorGatewayMaintenanceOwner } from "./doctor-maintenance-foreground.js";
import type { DoctorMaintenanceParams } from "./doctor-maintenance-types.js";
import { sanitizeDoctorNote } from "./doctor/emit-notes.js";

/** Database custody can change paths while stopped-service custody remains with Doctor. */
export function createDoctorMaintenanceState(options: {
  params: DoctorMaintenanceParams;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  deadline: () => number | undefined;
  assertCurrent?: () => void;
  assertReadCurrent: () => void;
  settle: <T>(operation: () => Promise<T>) => Promise<T>;
  warn: (message: string) => void;
}) {
  const { params, env, settle } = options;
  let resources: OpenClawDatabaseMaintenanceScope | undefined;
  let inspections: ReturnType<typeof createSqliteReadOnlyWorkerScope> | undefined;
  let owner: Awaited<ReturnType<typeof acquireDoctorGatewayMaintenanceOwner>> | undefined;
  let selectedEnv = env;
  let captureAdmitted = false;
  const capture = createUpdateDoctorDatabaseWriteCapture(params.databaseGenerations, {
    env,
    root: params.root ?? undefined,
    signal: options.signal,
    assertCurrent: () => owner!.assertCurrent(options.assertCurrent),
    warn: options.warn,
  });
  const closeResources = async () => {
    const failures: unknown[] = [];
    const closeScope = async (
      current: { close: () => Promise<void> } | undefined,
      clear: () => void,
    ) => {
      if (!current) {
        return;
      }
      try {
        await current.close();
        clear();
      } catch (error) {
        // A disposer can fail after retiring only part of its owned batch. Retry
        // that same sealed scope once so a transient close error cannot leave a
        // cached database handle behind when the managed Gateway is restored.
        try {
          await current.close();
          clear();
          failures.push(error);
        } catch (retryError) {
          failures.push(
            new AggregateError([error, retryError], "Doctor maintenance resource cleanup failed.", {
              cause: retryError,
            }),
          );
        }
      }
    };
    await closeScope(resources, () => {
      resources = undefined;
    });
    await closeScope(inspections, () => {
      inspections = undefined;
    });
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Doctor maintenance resource cleanup failed.");
    }
  };
  const settleCapture = async () => {
    if (owner && capture && captureAdmitted) {
      // Settle the original receipt keys before their canonical path can change.
      await settle(() => capture.settle());
      captureAdmitted = false;
    }
  };
  const enterResources = async (acquired: NonNullable<typeof owner>) => {
    // Transfer can retire the source owner before caller revalidation runs.
    owner = acquired;
    try {
      acquired.assertCurrent(options.assertCurrent);
      resources = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertDatabaseAccess: acquired.assertDatabaseAccess,
        assertOwnerCurrent: (access) => {
          acquired.assertCurrent(() => {
            options.assertCurrent?.();
            options.assertReadCurrent();
          }, access);
        },
      });
      inspections = createSqliteReadOnlyWorkerScope({
        signal: options.signal,
        deadlineOwnedByCaller: false,
      });
    } catch (error) {
      await acquired.release();
      owner = undefined;
      throw error;
    }
    if (capture) {
      await settle(() => resources!.run(() => capture.admit()));
      captureAdmitted = true;
    }
  };
  const state = {
    get owner() {
      return owner;
    },
    get resources() {
      return resources;
    },
    get hasOpenResources() {
      return Boolean(resources || inspections);
    },
    get receipt() {
      return owner ? undefined : capture?.receipt;
    },
    run<T>(operation: () => T): T {
      // Cancellation stops read-only inspections; admitted writers retain their resource scope.
      return resources!.run(() => inspections!.run(operation));
    },
    async acquire(relocatedMaintenanceOwner?: typeof owner) {
      if (resources) {
        return;
      }
      const assertCurrent = relocatedMaintenanceOwner
        ? () => relocatedMaintenanceOwner.assertCurrent(options.assertCurrent)
        : options.assertCurrent;
      assertCurrent?.();
      const acquired = await acquireDoctorGatewayMaintenanceOwner(
        path.resolve(resolveOpenClawStateSqlitePath(selectedEnv)),
        selectedEnv,
        {
          ...params,
          assertCurrent,
          deadlineMs: options.deadline(),
          relocatedMaintenanceOwner,
        },
      );
      await enterResources(acquired);
    },
    async relocateLegacyRoot() {
      const { resolvePendingLegacyStateDirMigrationPaths, prepareLegacyStateDirMigration } =
        await import("../infra/state-migrations.state-dir.js");
      const pending = resolvePendingLegacyStateDirMigrationPaths({ env });
      const sourceDir = resolveStateDir(env);
      if (!pending || path.resolve(sourceDir) !== path.resolve(pending.source)) {
        return;
      }
      const { closeOpenClawAgentDatabasesAsync } =
        await import("../state/openclaw-agent-db-lifecycle.js");
      owner!.assertCurrent(options.assertCurrent);
      const sourceDatabase = resolveOpenClawStateSqlitePath(env);
      // This runs before the long-lived Doctor callback: closing its own tracked
      // callback would self-wait. Include CLI/bootstrap resources predating this scope.
      await closeResources();
      await closeOpenClawAgentDatabasesAsync(sourceDir);
      await closeOpenClawStateDatabaseByPathAsync(sourceDatabase);
      await settleCapture();
      const migration = owner!.run(() => {
        options.assertCurrent?.();
        owner!.assertCurrent();
        return prepareLegacyStateDirMigration({ env });
      });
      // Root rename, alias creation, and rollback are synchronous under the source
      // owner. Acquire the resulting root before surrendering source exclusion.
      selectedEnv = { ...env, OPENCLAW_STATE_DIR: migration?.stateDir ?? sourceDir };
      const changedOwnerPath =
        resolveGatewayStateOwnerPath(resolveOpenClawStateSqlitePath(selectedEnv)) !==
        owner!.lockPath;
      if (changedOwnerPath) {
        await state.acquire(owner);
      } else {
        await enterResources(owner!);
      }
      if (migration) {
        const result = await resources!.run(() => migration.complete());
        for (const change of [...result.changes, ...(result.notices ?? [])]) {
          params.runtime.log(sanitizeDoctorNote(change));
        }
        for (const warning of result.warnings) {
          options.warn(sanitizeDoctorNote(warning));
        }
      }
    },
    async release() {
      const failures: unknown[] = [];
      try {
        await closeResources();
      } catch (error) {
        // An uncertain command process or a scope that still owns resources can
        // continue writing. Retain process ownership and do not publish a receipt.
        if (hasCommandProcessCleanupError(error) || state.hasOpenResources) {
          throw error;
        }
        failures.push(error);
      }
      try {
        await settleCapture();
      } catch (error) {
        if (hasCommandProcessCleanupError(error)) {
          throw error;
        }
        failures.push(error);
      }
      try {
        await owner?.release();
        owner = undefined;
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Doctor maintenance state cleanup failed.");
      }
    },
  };
  return state;
}

import type { getAuthoredConfigSecretRef } from "../../config/resolution-facts.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../../infra/runtime-worker-url.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { createPluginSourceCaptureRootAsync } from "../../plugins/plugin-source-capture-directory.js";
import type { planOpenClawModelsJsonSource } from "../models-config.js";
import type {
  PreparedModelCatalogWorkerTask,
  PreparedModelWorkerResult,
} from "../prepared-model-catalog-worker.types.js";

export type CatalogInspectionTask = PreparedModelCatalogWorkerTask & {
  inspection?: {
    existingAgentIds?: string[];
    provider?: string;
    expectedCredential?: string;
    failCatalog?: boolean;
    copyProbePath?: string;
  };
};

export type CatalogInspection = {
  sqliteCopies: number;
  copyHookObserved?: boolean;
  registeredAgentId?: string;
  foreignReleased?: boolean;
  runtimeFactsAbsent: boolean;
  sourceFactsAbsent: boolean;
  sameResolutionFacts: boolean;
  credentialMatches?: boolean;
  authoredRef?: ReturnType<typeof getAuthoredConfigSecretRef>;
  resolvedEnvRef?: ReturnType<typeof getAuthoredConfigSecretRef>;
  plans: Array<Awaited<ReturnType<typeof planOpenClawModelsJsonSource>>>;
};

export async function createCatalogInspectionPool(env: NodeJS.ProcessEnv) {
  const capture = await createPluginSourceCaptureRootAsync(
    resolveStateDir(env),
    "catalog-inspection-",
  );
  const workerUrl = new URL("./prepared-model-catalog-inspection.worker.ts", import.meta.url);
  let transferred = false;
  try {
    capture.assertCurrent();
    const pool = new WorkerTaskPool<
      CatalogInspectionTask,
      PreparedModelWorkerResult & { inspection: CatalogInspection }
    >({
      workerUrl,
      maxWorkers: 1,
      idleTimeoutMs: 0,
      restartOnError: false,
      prepareWorker: () => {
        capture.assertCurrent();
        const prepared = {
          releaseResources: capture.release,
          options: {
            env,
            execArgv: [
              ...resolveRuntimeWorkerThreadExecArgv(workerUrl),
              "--experimental-test-module-mocks",
            ],
            workerData: {
              sourceCaptureDirectory: capture.directory,
              sourceCaptureManagedRoot: capture.managedRoot,
            },
          },
        };
        transferred = true;
        return prepared;
      },
    });
    return {
      pool: {
        run: pool.run.bind(pool),
        close: async (error?: Error) => {
          const failures: unknown[] = [];
          try {
            await pool.close(error);
          } catch (closeError) {
            failures.push(closeError);
          }
          if (!transferred) {
            try {
              await capture.release();
            } catch (releaseError) {
              failures.push(releaseError);
            }
          }
          if (failures.length === 1) {
            throw failures[0];
          }
          if (failures.length > 1) {
            throw new AggregateError(failures, "Catalog inspection cleanup failed", {
              cause: failures[0],
            });
          }
        },
      },
      captureDirectory: capture.directory,
    };
  } catch (error) {
    try {
      await capture.release();
    } catch (releaseError) {
      throw createSqliteLifecycleAggregateError(
        [error, releaseError],
        "Catalog inspection preparation failed",
        error,
      );
    }
    throw error;
  }
}

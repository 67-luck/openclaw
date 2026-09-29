/** Catalog compute-pool construction and original source-capture custody. */
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import { WorkerTaskError, WorkerTaskPool } from "../infra/worker-task-pool.js";
import { createPluginSourceCaptureRootAsync } from "../plugins/plugin-source-capture-directory.js";
import type {
  PreparedModelCatalogWorkerData,
  PreparedModelCatalogWorkerTask,
  PreparedModelWorkerResult,
} from "./prepared-model-catalog-worker.types.js";
import { capturePreparedModelRuntimeLifetime } from "./prepared-model-runtime.lifecycle.js";

export const GATEWAY_CATALOG_WORKERS = 1;
// Leave room for source loaders and overlapping generations without inheriting the host heap budget.
const CATALOG_WORKER_HEAP_LIMIT_MB = 512;
export type CatalogPool = Pick<
  WorkerTaskPool<PreparedModelCatalogWorkerTask, PreparedModelWorkerResult>,
  "run" | "close" | "isClosed" | "getSnapshot"
>;

export async function createCatalogPool(
  env: NodeJS.ProcessEnv,
  validateResult: (result: PreparedModelWorkerResult) => void,
  assertCurrent?: () => void,
): Promise<CatalogPool> {
  const capturedEnv = cloneEnvWithPlatformSemantics(env);
  const assertLifetime = capturePreparedModelRuntimeLifetime();
  assertCurrent?.();
  const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.preparedModelCatalog);
  const capture = await createPluginSourceCaptureRootAsync(
    resolveStateDir(capturedEnv),
    "openclaw-model-catalog-",
  );
  let availableCapture: typeof capture | undefined = capture;
  let unusedRelease: Promise<void> | undefined;
  const releaseUnusedCapture = () => {
    if (!availableCapture) {
      return undefined;
    }
    return (unusedRelease ??= availableCapture
      .release()
      .then(() => {
        availableCapture = undefined;
      })
      .finally(() => {
        unusedRelease = undefined;
      }));
  };
  try {
    assertLifetime();
    assertCurrent?.();
    capture.assertCurrent();
    let sourceLoss: { error: unknown; closing: Promise<void> } | undefined;
    const pool = new WorkerTaskPool<PreparedModelCatalogWorkerTask, PreparedModelWorkerResult>({
      workerUrl,
      workerOptions: { resourceLimits: { maxOldGenerationSizeMb: CATALOG_WORKER_HEAP_LIMIT_MB } },
      maxWorkers: GATEWAY_CATALOG_WORKERS,
      // Only the inventory owner can replace captured code; idle retirement or crash restart
      // would import a different source generation into an existing publication.
      idleTimeoutMs: 0,
      restartOnError: false,
      prepareWorker: () => {
        assertLifetime();
        assertCurrent?.();
        assertCaptureCurrent();
        if (!availableCapture) {
          throw new WorkerTaskError("catalog source capture was already released", "unavailable");
        }
        const prepared = {
          releaseResources: capture.release,
          options: {
            workerData: {
              sourceCaptureDirectory: capture.directory,
              sourceCaptureManagedRoot: capture.managedRoot,
            } satisfies PreparedModelCatalogWorkerData,
            // Establish state/config before imported modules observe process.env.
            env: capturedEnv,
          },
        };
        // This pool neither idles nor restarts. Its sole Worker now owns the original root.
        availableCapture = undefined;
        return prepared;
      },
      validateResult: (result) => {
        assertCaptureCurrent();
        validateResult(result);
      },
    });
    const assertCaptureCurrent = () => {
      try {
        capture.assertCurrent();
      } catch (error) {
        sourceLoss ??= {
          error,
          closing: pool.close(error instanceof Error ? error : new Error(String(error))),
        };
        throw sourceLoss.error;
      }
    };
    const closePool = async (error?: Error) => {
      const failures: unknown[] = [];
      try {
        await (sourceLoss?.closing ?? pool.close(error));
      } catch (closeError) {
        failures.push(closeError);
      }
      try {
        // Queued cancellation or owner close can leave the root without a Worker.
        await releaseUnusedCapture();
      } catch (releaseError) {
        failures.push(releaseError);
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Catalog worker and unused capture failed to close", {
          cause: failures[0],
        });
      }
    };
    return {
      run: (input, options) =>
        pool
          .run(() => {
            assertCaptureCurrent();
            const prepared = typeof input === "function" ? input() : input;
            if (isPromiseLike<PreparedModelCatalogWorkerTask>(prepared)) {
              return Promise.resolve(prepared).then((value) => {
                assertCaptureCurrent();
                return value;
              });
            }
            assertCaptureCurrent();
            return prepared;
          }, options)
          .catch(async (error: unknown) => {
            const loss = sourceLoss;
            if (!loss) {
              throw error;
            }
            try {
              await closePool();
            } catch (cleanupError) {
              throw createSqliteLifecycleAggregateError(
                [loss.error, cleanupError],
                "Catalog source authority and cleanup failed",
                loss.error,
              );
            }
            throw loss.error;
          }),
      getSnapshot: () => pool.getSnapshot(),
      get isClosed() {
        return pool.isClosed;
      },
      close: closePool,
    };
  } catch (error) {
    try {
      await releaseUnusedCapture();
    } catch (releaseError) {
      throw createSqliteLifecycleAggregateError(
        [error, releaseError],
        "Catalog preparation and cleanup failed",
        error,
      );
    }
    throw error;
  }
}

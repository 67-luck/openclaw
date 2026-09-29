import path from "node:path";
import type { Result } from "@openclaw/normalization-core/result";
import {
  createSqliteLifecycleAggregateError,
  throwSqliteLifecycleErrors,
} from "../infra/sqlite-lifecycle-errors.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import { clearPluginModuleRequireCache, isJavaScriptModulePath } from "./native-module-require.js";
import {
  getPluginCache,
  getPluginCacheRetirementSignal,
  getPluginCacheSource,
  retirePluginCacheInstance,
} from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import {
  getPluginSourceCaptureScope,
  withPluginSourceCaptureScope,
} from "./plugin-source-capture-context.js";
import { acquirePluginSourceCaptureScope } from "./plugin-source-capture-directory.js";
import { PluginRegistrationResourceSource } from "./registry-registration-resources.js";

/** Prepare a writer for synchronous setup; actual instances retain it through module disposal. */
export async function preparePluginSetupSource<T>(
  read: () => T,
  assertCurrent: () => void,
): Promise<T> {
  assertCurrent();
  const cacheSignal = getPluginCacheRetirementSignal(getPluginCache());
  cacheSignal.throwIfAborted();
  const capture = await acquirePluginSourceCaptureScope();
  const source = new PluginRegistrationResourceSource(() => capture.release());
  const producer = source.acquireClaim("inspection");
  let outcome: Result<T, unknown>;
  try {
    assertCurrent();
    cacheSignal.throwIfAborted();
    const value = withPluginSourceCaptureScope(
      {
        ...capture.scope,
        retainSetupSource: () => {
          cacheSignal.throwIfAborted();
          const claim = source.acquireClaim("borrower");
          return {
            release: async () =>
              throwSqliteLifecycleErrors(
                await claim.release(),
                "Plugin setup source cleanup failed",
              ),
          };
        },
      },
      read,
    );
    assertCurrent();
    cacheSignal.throwIfAborted();
    outcome = { ok: true, value };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const failures: unknown[] = await producer.release().catch((error: unknown) => [error]);
  if (!outcome.ok) {
    if (failures.length) {
      throw createSqliteLifecycleAggregateError(
        [outcome.error, ...failures],
        "Plugin setup preparation and cleanup failed",
        outcome.error,
      );
    }
    throw outcome.error;
  }
  throwSqliteLifecycleErrors(failures, "Plugin setup source cleanup failed");
  assertCurrent();
  cacheSignal.throwIfAborted();
  return outcome.value;
}

/** Setup callbacks belong to the inventory that loaded them. */
export function getPluginSetupModuleLoader(
  record: PluginManifestRecord,
  source: string,
  rootDir: string,
) {
  const cache = getPluginCache();
  const key = `setup:${record.id}:${source}`;
  const cached = cache.setupModules.get(key);
  if (!cached && cache.retirement) {
    throw new Error(`Plugin ${record.id} setup inventory has retired`);
  }
  const instance = cached ?? new PluginInstance(record.id, { cache });
  const discard = () => {
    // Repeated inspections share callbacks already published by successful initialization.
    if (instance.controlPlaneInitialized) {
      return;
    }
    // A retained failed loader cannot evict its replacement; the cache joins cleanup failures.
    if (cache.setupModules.get(key) === instance) {
      cache.setupModules.delete(key);
    }
    void retirePluginCacheInstance(instance, cache).catch(() => {});
  };
  if (!cached) {
    cache.setupModules.set(key, instance);
  }
  try {
    const retainSource = getPluginSourceCaptureScope()?.retainSetupSource;
    if (retainSource) {
      let claim: ReturnType<typeof retainSource> | undefined = undefined;
      // Register first: an attachment refusal acquires no claim. Reverse cleanup keeps the
      // producer alive until artifact disposal and all admitted setup descendants have joined.
      instance.onModuleDispose(() => claim?.release());
      claim = retainSource();
    }
    if (!cached) {
      if (record.origin === "bundled" && isJavaScriptModulePath(source)) {
        const distribution = path.dirname(path.dirname(rootDir));
        const dependencyRoot =
          path.basename(path.dirname(rootDir)) === "extensions" &&
          path.basename(distribution) === "dist"
            ? distribution
            : rootDir;
        // Cold metadata reset refreshes CJS entry and hoisted helpers. Ordinary
        // inventory retirement must not evict code still used by another instance.
        getPluginCacheSource(source).disposeModule ??= () =>
          clearPluginModuleRequireCache(source, dependencyRoot);
      }
      bindPluginInstanceModuleLoader({
        instance,
        origin: record.origin,
        source,
        rootDir,
      });
    }
  } catch (error) {
    discard();
    throw error;
  }
  return Object.assign(
    (entry: string) => {
      try {
        return instance.loadModule(entry);
      } catch (error) {
        discard();
        throw error;
      }
    },
    {
      initialize<T>(this: void, run: () => T): T {
        try {
          const result = run();
          instance.controlPlaneInitialized = true;
          return result;
        } catch (error) {
          discard();
          throw error;
        }
      },
    },
  );
}

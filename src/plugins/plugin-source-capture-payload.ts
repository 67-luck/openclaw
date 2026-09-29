import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import { removeTemporaryArtifacts } from "../infra/temp-artifact-cleanup.js";
import type { PluginSourceCaptureInstance } from "./plugin-instance-invocation.types.js";
import { PLUGIN_SOURCE_CAPTURE_PREFIX } from "./plugin-source-capture-path.js";

export async function removePluginSourceCapturePayload(
  root: string,
  pendingNative: Iterable<string>,
  assertIdentity?: () => void,
): Promise<void> {
  assertIdentity?.();
  await fsPromises.rm(path.join(root, "captures"), { recursive: true, force: true });
  for (const directory of pendingNative) {
    assertIdentity?.();
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
  assertIdentity?.();
  const native = await fsPromises.readdir(path.join(root, "native")).catch((error: unknown) => {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return [];
  });
  if (native.length === 0) {
    assertIdentity?.();
    await fsPromises.rm(root, { recursive: true, force: true });
  }
}

/** Native snapshots keep their original capture reference through publication and disposal. */
export function createPluginNativeCapturePayload(
  instance: PluginSourceCaptureInstance,
  retainLoadedPluginSourceCapture: (root: string) => boolean,
) {
  try {
    const root = instance.createNativeDirectory();
    let committed = false;
    let disposed = false;
    let closing = false;
    let disposal: Promise<void> | undefined;
    return {
      directory: root.directory,
      commit() {
        instance.assertCurrent();
        if (disposed || closing) {
          throw new Error("Plugin native capture has been disposed");
        }
        root.commit();
        committed = true;
      },
      dispose() {
        if (disposal) {
          throw new Error("Plugin native capture asynchronous disposal is still pending");
        }
        if (!disposed) {
          closing = true;
          if (
            instance.isCurrent() &&
            !committed &&
            !retainLoadedPluginSourceCapture(root.directory)
          ) {
            fs.rmSync(root.directory, { recursive: true, force: true });
          }
          instance.release();
          disposed = true;
        }
      },
      disposeAsync() {
        if (disposed) {
          return Promise.resolve();
        }
        closing = true;
        return (disposal ??= (async () => {
          if (
            instance.isCurrent() &&
            !committed &&
            !retainLoadedPluginSourceCapture(root.directory)
          ) {
            await removeTemporaryArtifacts(root.directory, "Plugin native capture");
          }
          await instance.releaseAsync();
          disposed = true;
        })().finally(() => {
          disposal = undefined;
        }));
      },
    };
  } catch (error) {
    instance.release();
    throw error;
  }
}

/** Source allocation owns both its partial directory and its borrowed capture reference. */
export function createPluginSourceCapturePayload(
  instance: PluginSourceCaptureInstance | undefined,
  workerDirectory: string | undefined,
): string {
  let created: string | undefined;
  try {
    created =
      workerDirectory !== undefined
        ? fs.mkdtempSync(path.join(workerDirectory, PLUGIN_SOURCE_CAPTURE_PREFIX))
        : instance!.createDirectory();
    const directory = fs.realpathSync(created);
    fs.chmodSync(directory, 0o700);
    return directory;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      if (created) {
        instance?.assertCurrent();
        fs.rmSync(created, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      instance?.release();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw createSqliteLifecycleAggregateError(
        [error, ...cleanupErrors],
        "Plugin source capture setup and cleanup failed",
        error,
      );
    }
    throw error;
  }
}

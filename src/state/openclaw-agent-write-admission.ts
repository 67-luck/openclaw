import { AsyncLocalStorage } from "node:async_hooks";
import {
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  runQueuedStoreWrite,
  runReadyStoreWrite,
  captureStoreWriterHostExecution,
  captureActiveStoreWriterHostExecution,
  type StoreWriterQueue,
  type StoreWriterTiming,
} from "../shared/store-writer-queue.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";

// Native and SDK module graphs share the same queue and worker reservation.
// A second queue would admit a foreground writer while reclamation owns SQLite.
const admission = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseWriteAdmission"),
  () => ({
    queues: new Map<string, StoreWriterQueue>(),
    workers: new Map<string, object>(),
  }),
);

export const SQLITE_SESSION_WRITER_QUEUES = admission.queues;

type WriteTarget = {
  pathname: string;
  identity: DatabasePathIdentity;
  assertCurrent(this: void): void;
};
type WriteTargetScope = { target: WriteTarget; active: boolean; parent?: WriteTargetScope };
const writeTargets = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseWriteTargets"),
  () => new AsyncLocalStorage<WriteTargetScope>(),
);

function captureWriteTarget(options: OpenClawAgentDatabaseOptions): WriteTarget {
  const pathname = resolveOpenClawAgentSqlitePath(options);
  for (let scope = writeTargets.getStore(); scope; scope = scope.parent) {
    if (scope.active && scope.target.pathname === pathname) {
      scope.target.assertCurrent();
      return scope.target;
    }
  }
  const volatile = isIncognitoOpenClawAgentSqlitePath(pathname, options);
  const identity: DatabasePathIdentity = volatile
    ? { key: `path:${pathname}`, canonicalPath: pathname }
    : readDatabasePathIdentitySync(pathname);
  let original: WriteTarget | undefined;
  for (let scope = writeTargets.getStore(); scope; scope = scope.parent) {
    if (scope.active && scope.target.identity.canonicalPath === identity.canonicalPath) {
      original = scope.target;
      break;
    }
  }
  return {
    pathname,
    identity: original?.identity ?? identity,
    assertCurrent() {
      original?.assertCurrent();
      if (volatile) {
        return;
      }
      const current = readDatabasePathIdentitySync(pathname);
      if (
        current.canonicalPath !== identity.canonicalPath ||
        (identity.key.startsWith("file:") &&
          (current.key !== identity.key || current.birthtime !== identity.birthtime))
      ) {
        throw new Error("Agent database target changed before write admission");
      }
    },
  };
}

function retainHostTarget(
  target: WriteTarget,
  host: ReturnType<typeof captureStoreWriterHostExecution>,
) {
  return {
    run<T>(run: () => T): T {
      return host.run(() => {
        target.assertCurrent();
        return run();
      });
    },
    beginNative() {
      target.assertCurrent();
      const native = host.beginNative();
      return {
        ...native,
        runHostStep<T>(this: void, run: () => T): T {
          return native.runHostStep(() => {
            target.assertCurrent();
            return run();
          });
        },
      };
    },
  };
}

/** Capability capture and ready reentry share the ordinary canonical store lane. */
export function captureOpenClawAgentHostExecution(options: OpenClawAgentDatabaseOptions) {
  const target = captureWriteTarget(options);
  target.assertCurrent();
  return retainHostTarget(
    target,
    captureStoreWriterHostExecution(admission.queues, target.identity.canonicalPath),
  );
}

export function captureActiveOpenClawAgentHostExecution(options: OpenClawAgentDatabaseOptions) {
  const target = captureWriteTarget(options);
  const host = captureActiveStoreWriterHostExecution(
    admission.queues,
    target.identity.canonicalPath,
  );
  if (!host) {
    return undefined;
  }
  target.assertCurrent();
  return retainHostTarget(target, host);
}

export function runReadyOpenClawAgentWriteAdmission<T>(
  options: OpenClawAgentDatabaseOptions,
  fn: () => T,
): T {
  const target = captureWriteTarget(options);
  const scope = { target, active: true, parent: writeTargets.getStore() };
  // This scope carries the original target, not writer authority. The shared
  // queue still owns all active, native, and detached-continuation checks.
  try {
    return runReadyStoreWrite({
      queues: admission.queues,
      storePath: target.identity.canonicalPath,
      fn: () =>
        writeTargets.run(scope, () => {
          target.assertCurrent();
          return fn();
        }),
    });
  } finally {
    scope.active = false;
  }
}

export function runOpenClawAgentWriteAdmission<T>(
  options: OpenClawAgentDatabaseOptions,
  run: (identity: DatabasePathIdentity, assertCurrent: () => void) => Promise<T> | T,
  reentrant = false,
  timing?: StoreWriterTiming,
  signal?: AbortSignal,
): Promise<T> {
  const target = captureWriteTarget(options);
  const { identity, assertCurrent } = target;
  const storePath = identity.canonicalPath;
  return runQueuedStoreWrite({
    queues: admission.queues,
    storePath,
    label: "agent database write admission",
    // Worker callbacks inherit their parent's async context, but not its native
    // writer lock. Their foreground writes must queue, never reenter that owner.
    reentrant: reentrant && !admission.workers.has(storePath),
    fn: async () => {
      assertCurrent();
      const scope = { target, active: true, parent: writeTargets.getStore() };
      try {
        return await writeTargets.run(scope, () => run(identity, assertCurrent));
      } finally {
        scope.active = false;
      }
    },
    timing,
    signal,
  });
}

/** Reserve a native write permit without admitting inherited foreground callbacks. */
export function runOpenClawAgentWorkerWrite<T>(
  options: OpenClawAgentDatabaseOptions,
  run: () => Promise<T>,
  timing?: StoreWriterTiming,
  signal?: AbortSignal,
): Promise<T> {
  return runOpenClawAgentWriteAdmission(
    options,
    async ({ canonicalPath: storePath }) => {
      const owner = {};
      admission.workers.set(storePath, owner);
      try {
        return await run();
      } finally {
        if (admission.workers.get(storePath) === owner) {
          admission.workers.delete(storePath);
        }
      }
    },
    true,
    timing,
    signal,
  );
}

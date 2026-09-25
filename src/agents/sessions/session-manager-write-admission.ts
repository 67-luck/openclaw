import { AsyncLocalStorage } from "node:async_hooks";
import type { TranscriptMessageAppendResult } from "../../config/sessions/session-accessor.sqlite-contract.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { isTranscriptMessageAppendCurrentTail } from "../../config/sessions/session-accessor.sqlite-transcript-append-result.js";
import { appendTranscriptMessageSnapshotSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target-paths.js";
import { captureSessionStoreReadCandidate } from "../../config/sessions/session-store-read-candidates.js";
import {
  captureSessionTranscriptStorageEnvironment,
  captureSessionTranscriptTargetBinding,
  sameSessionTranscriptTargetBinding,
  sessionTranscriptExecution,
} from "../../config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  withOwnedSessionTranscriptWriterFence,
} from "../../config/sessions/transcript-write-context.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { runInDetachedAsyncContext, trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../../shared/store-writer-queue.js";
import {
  registerOpenClawAgentDatabaseAsyncResource,
  registerOpenClawAgentDatabaseReadCandidateResource,
} from "../../state/openclaw-agent-db-resources.js";
import {
  withOpenClawAgentDatabaseAsync,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { AgentDatabaseExecutionBinding } from "../../state/openclaw-agent-execution.js";
import {
  runOpenClawAgentWriteAdmission,
  runReadyOpenClawAgentWriteAdmission,
  captureOpenClawAgentHostExecution,
} from "../../state/openclaw-agent-write-admission.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  registerOpenClawStateDatabaseAsyncResource,
} from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { CustomMessage } from "./messages.js";
import type { SessionManagerCore } from "./session-manager-core.js";
import { SessionTranscriptMessageCommittedError } from "./session-manager-message-error.js";
import type { AppendPersistenceOptions } from "./session-manager-types.js";

// Detached managers have no database path; keep their existing write boundary keyed by owner.
const detachedWriterQueues = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionManagerDetachedWriterQueues"),
  () => new WeakMap<object, Map<string, StoreWriterQueue>>(),
);

export type SessionManagerWriteAdmission = {
  database: OpenClawAgentDatabase;
  options: OpenClawAgentDatabaseOptions;
};

type ManagerOwner = Pick<SessionManagerCore, "getSessionTarget" | "getSessionId">;
type HostExecution = {
  readonly binding: AgentDatabaseExecutionBinding;
  run<T>(this: void, run: () => T): T;
  beginNative(
    this: void,
  ): ReturnType<ReturnType<typeof captureOpenClawAgentHostExecution>["beginNative"]>;
  close(): void;
};
const hostExecutions = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionManagerHostExecution"),
  () => new AsyncLocalStorage<HostExecution>(),
);

function retainHostExecution(
  binding: AgentDatabaseExecutionBinding,
  options: OpenClawAgentDatabaseOptions,
  assertCurrent: () => void,
): HostExecution {
  const host = captureOpenClawAgentHostExecution(options);
  let active = true;
  const owner: HostExecution = {
    binding,
    run<T>(run: () => T): T {
      if (!active) {
        throw new Error("Session manager operation has already settled");
      }
      binding.assertCurrent();
      assertCurrent();
      return host.run(() => hostExecutions.run(owner, run));
    },
    beginNative() {
      if (!active) {
        throw new Error("Session manager operation has already settled");
      }
      binding.assertCurrent();
      assertCurrent();
      const operation = host.beginNative();
      return {
        runHostStep<T>(run: () => T): T {
          if (!active) {
            throw new Error("Session manager operation has already settled");
          }
          binding.assertCurrent();
          assertCurrent();
          return operation.runHostStep(() => hostExecutions.run(owner, run));
        },
        settle: operation.settle,
      };
    },
    close() {
      active = false;
    },
  };
  return owner;
}

/** Capture on the actual caller stack; only the normal async driver retains this continuation. */
export function captureSessionManagerHostExecution(manager: ManagerOwner) {
  const target = manager.getSessionTarget();
  const binding = target?.[sessionTranscriptExecution]?.execution;
  if (!binding) {
    return { run: <T>(run: () => T): T => run() };
  }
  const owner = hostExecutions.getStore();
  if (!owner || owner.binding.incarnation !== binding.incarnation) {
    throw new Error("Session manager has no original host execution owner");
  }
  captureOpenClawAgentHostExecution({
    agentId: binding.agentId,
    path: binding.path,
    env: target.env,
  });
  return { run: owner.run, beginNative: owner.beginNative };
}

/** Native and durable SDK calls keep their native boundary; only the new ready backend needs this gate. */
export function withSessionManagerReadyWrite<T>(manager: ManagerOwner, write: () => T): T {
  const target = manager.getSessionTarget();
  const binding = target?.[sessionTranscriptExecution]?.execution;
  if (!binding) {
    return write();
  }
  const options = { agentId: binding.agentId, path: binding.path, env: target.env };
  const assertOwned = captureOwnedTranscriptWriteAssertion(target);
  return runReadyOpenClawAgentWriteAdmission(options, () => {
    const operation = retainHostExecution(binding, options, () => {
      assertOwned();
      if (!sameSessionTranscriptTargetBinding(target, manager.getSessionTarget())) {
        throw new Error("Session manager identity changed before transcript write admission");
      }
    });
    try {
      return operation.run(write);
    } finally {
      operation.close();
    }
  });
}

/** Keep the manager operation, committed view adoption, and cleanup in one storage admission. */
export async function withSessionManagerWrite<T>(
  manager: Pick<SessionManagerCore, "getSessionTarget" | "getSessionId">,
  write: (admission?: SessionManagerWriteAdmission) => T | Promise<T>,
): Promise<T> {
  const target = manager.getSessionTarget();
  if (!target) {
    const sessionId = manager.getSessionId();
    const queues = detachedWriterQueues.get(manager) ?? new Map<string, StoreWriterQueue>();
    detachedWriterQueues.set(manager, queues);
    return await trackAsyncWork(() =>
      runQueuedStoreWrite({
        queues,
        storePath: "session",
        label: "detached session write admission",
        reentrant: true,
        fn: async () => {
          if (manager.getSessionTarget() || manager.getSessionId() !== sessionId) {
            throw new Error("Session manager identity changed before transcript write admission");
          }
          return await write();
        },
      }),
    );
  }
  const identity = { ...target };
  const assertCurrent = captureOwnedTranscriptWriteAssertion(identity);
  const binding = target[sessionTranscriptExecution]?.execution;
  if (binding) {
    const options = { agentId: binding.agentId, path: binding.path, env: target.env };
    return await trackAsyncWork(() =>
      runOpenClawAgentWriteAdmission(
        options,
        async () => {
          const operation = retainHostExecution(binding, options, () => {
            assertCurrent();
            if (!sameSessionTranscriptTargetBinding(identity, manager.getSessionTarget())) {
              throw new Error("Session manager identity changed before transcript write admission");
            }
          });
          try {
            return await operation.run(() => write());
          } finally {
            operation.close();
          }
        },
        true,
      ),
    );
  }
  const options = toDatabaseOptions(resolveSqliteReadScope(identity));
  options.env = captureSessionTranscriptStorageEnvironment(options.env ?? process.env);
  options.path = resolveOpenClawAgentSqlitePath(options);
  // A tool's cancellation race or a void extension callback can return first.
  // Its existing runtime owner must still retain the admitted write.
  return await trackAsyncWork(() =>
    runOpenClawAgentWriteAdmission(
      options,
      () =>
        withOpenClawAgentDatabaseAsync(
          options,
          (database) => {
            const current = manager.getSessionTarget();
            if (!sameSessionTranscriptTargetBinding(identity, current)) {
              throw new Error("Session manager identity changed before transcript write admission");
            }
            // Each native kernel or worker command still validates live authority at commit.
            return write({ database, options });
          },
          assertCurrent,
        ),
      true,
    ),
  );
}

/** Append a custom note without changing a manager's loaded view. */
export async function appendSessionTranscriptNote(
  target: SessionTranscriptRuntimeTarget,
  message: CustomMessage,
  options?: Pick<AppendPersistenceOptions, "config">,
): Promise<
  Pick<TranscriptMessageAppendResult<CustomMessage>, "messageId" | "message" | "appended"> & {
    currentTail: boolean;
  }
> {
  const captured = withOwnedSessionTranscriptWriterFence(
    captureSessionTranscriptTargetBinding(target),
  );
  if (isIncognitoSessionKey(captured.sessionKey)) {
    // The caller retains the process-held incognito owner until its actor cutover.
    const snapshot = appendTranscriptMessageSnapshotSync(captured, {
      cwd: process.cwd(),
      message,
      ...(options?.config ? { config: options.config } : {}),
    });
    if (!snapshot.ok) {
      throw new Error("Session transcript message was not persisted", { cause: snapshot.error });
    }
    const result = snapshot.value.result;
    if (!result) {
      throw new Error("Session transcript message was not persisted");
    }
    return {
      messageId: result.messageId,
      message: result.message,
      appended: result.appended,
      currentTail: isTranscriptMessageAppendCurrentTail(snapshot.value),
    };
  }
  const unresolved = resolveUnsuffixedSqliteTargetFromSessionStorePath(captured.storePath);
  const candidate = captureSessionStoreReadCandidate(
    unresolved.path,
    unresolved.agentId || captured.storePath.endsWith(".sqlite") ? undefined : "sibling-family",
  );
  const state = captureOpenClawStateDatabaseReadAdmission(
    resolveOpenClawStateSqlitePath(captured.env),
  );
  const assertOwned = captureOwnedTranscriptWriteAssertion(captured);
  const completion = createDeferredCore();
  let revoked = false;
  const revoke = () => {
    revoked = true;
  };
  const assertCurrent = () => {
    if (revoked) {
      throw new Error("Session transcript append was revoked before completion");
    }
    state.assertCurrent();
    assertOwned();
    if (
      captureSessionStoreReadCandidate(candidate.path, candidate.scope).physicalPath !==
      candidate.physicalPath
    ) {
      throw new Error("Session store alias changed before transcript append completion");
    }
  };
  const input = {
    target: captured,
    candidate,
    message: structuredClone(message),
    ...(options?.config ? { config: structuredClone(options.config) } : {}),
    cwd: process.cwd(),
    assertCurrent,
  };
  const releases: Array<() => void> = [];
  // Storage close must also join preparation, before a native executor exists.
  try {
    for (const pathname of new Set([candidate.path, candidate.physicalPath])) {
      const resource = { path: pathname, revoke, close: () => completion.promise };
      releases.push(
        unresolved.agentId
          ? registerOpenClawAgentDatabaseAsyncResource({
              ...resource,
              agentId: unresolved.agentId,
            })
          : registerOpenClawAgentDatabaseReadCandidateResource({
              ...resource,
              scope: candidate.scope,
            }),
      );
    }
    releases.push(
      registerOpenClawStateDatabaseAsyncResource({
        close: async (identity) => {
          if (!identity || identity.key === state.identity.key) {
            revoke();
            await completion.promise;
          }
        },
      }),
    );
    assertCurrent();
    // Reserve the existing store lane before lazy loading or target preparation can reorder calls.
    return await trackAsyncWork(() =>
      runOpenClawAgentWriteAdmission(
        { agentId: captured.agentId, path: unresolved.path, env: captured.env },
        async () => {
          assertCurrent();
          const { appendSessionTranscriptMessage } = await runInDetachedAsyncContext(
            () => import("./session-manager-message-runtime.js"),
          );
          const committed = await appendSessionTranscriptMessage(input);
          try {
            assertCurrent();
          } catch (error) {
            throw new SessionTranscriptMessageCommittedError(committed.messageId, error, captured);
          }
          return committed;
        },
        true,
      ),
    );
  } finally {
    completion.resolve();
    for (const unregister of releases.toReversed()) {
      unregister();
    }
  }
}

import { randomUUID } from "node:crypto";
import { isMainThread } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { deferSqliteWorkerCallerPublication } from "../../infra/sqlite-worker-host-context.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import type { SqliteWorkerHostScope } from "../../infra/sqlite-worker-scoped-operation.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { agentDatabaseLifecycle } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import type {
  AgentDatabaseOperations,
  AgentDatabaseRequestExecutionSource,
} from "../../state/openclaw-agent-execution-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  type AgentDatabaseExecutionBinding,
} from "../../state/openclaw-agent-execution.js";
import {
  captureActiveOpenClawAgentHostExecution,
  captureOpenClawAgentHostExecution,
} from "../../state/openclaw-agent-write-admission.js";
import { retainSessionEntryWorkerPublication } from "./session-accessor.sqlite-entry-cache.js";
import {
  resolveSqliteAgentId,
  resolveSqliteSessionKey,
  resolveSqliteTranscriptReadScope,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptReadScope } from "./session-accessor.types.js";
import {
  sessionTranscriptExecution,
  captureSessionTranscriptStorageEnvironment,
  type SessionTranscriptTargetBinding,
} from "./transcript-target-binding.js";

// Keep ordinary shared/custom targets out of synchronous registry resolution;
// the canonical Incognito sentinel check is lexical and performs no I/O.
function isIncognitoTranscriptCandidate(
  source: Pick<SessionTranscriptReadScope, "sessionKey" | "storePath" | "agentId" | "env">,
) {
  if (isIncognitoSessionKey(source.sessionKey)) {
    return true;
  }
  const agentId = resolveSqliteAgentId({
    scopedAgentId: source.agentId,
    sessionKey: source.sessionKey,
  });
  return Boolean(
    agentId &&
    source.storePath &&
    isIncognitoOpenClawAgentSqlitePath(source.storePath, { agentId, env: source.env }),
  );
}

/** The capability survives snapshot copies but never crosses structured-clone command transport. */
export function captureSessionTranscriptExecution(target: SessionTranscriptTargetBinding) {
  const retained = target[sessionTranscriptExecution];
  if (retained) {
    retained.execution.assertCurrent();
    const scope = resolveSqliteTranscriptScope(target);
    if (
      scope.sessionId !== retained.scope.sessionId ||
      scope.sessionKey !== retained.scope.sessionKey ||
      resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope)) !== retained.execution.path
    ) {
      throw new Error("Session transcript target differs from its retained logical owner");
    }
    return target;
  }
  if (
    !isMainThread ||
    !agentDatabaseLifecycle.gatewayExecution ||
    !isIncognitoTranscriptCandidate(target)
  ) {
    return target;
  }
  const scope = resolveSqliteTranscriptScope(target);
  const options = toDatabaseOptions(scope);
  if (!isIncognitoOpenClawAgentSqlitePath(resolveOpenClawAgentSqlitePath(options), options)) {
    return target;
  }
  const execution = captureOpenClawAgentDatabaseExecution(options);
  const binding = execution.binding;
  // This immutable identity is not a native borrow. Each command retains its own original scope.
  void execution.release();
  return { ...target, [sessionTranscriptExecution]: { execution: binding, scope } };
}

/** Optional read keys remain optional; connection custody never invents a writer target. */
export function captureSessionTranscriptReadExecution(
  source: SessionTranscriptReadScope &
    Pick<SessionTranscriptTargetBinding, typeof sessionTranscriptExecution>,
) {
  if (!isMainThread) {
    return undefined;
  }
  const retained = source[sessionTranscriptExecution];
  if (retained) {
    retained.execution.assertCurrent();
    const resolved = resolveSqliteTranscriptReadScope(source);
    const sessionKey =
      resolved.sessionKey === undefined
        ? undefined
        : resolveSqliteSessionKey(resolved.sessionKey, resolved.agentId);
    if (
      resolved.sessionId !== retained.scope.sessionId ||
      sessionKey !== retained.scope.sessionKey ||
      resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved)) !== retained.execution.path
    ) {
      throw new Error("Session read differs from its retained logical owner");
    }
    return {
      scope: { ...source, agentId: resolved.agentId, sessionKey },
      execution: retained.execution,
    };
  }
  if (!agentDatabaseLifecycle.gatewayExecution || !isIncognitoTranscriptCandidate(source)) {
    return undefined;
  }
  const scope = {
    ...source,
    env: captureSessionTranscriptStorageEnvironment(source.env ?? process.env),
  };
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const captured = captureOpenClawAgentDatabaseExecution(toDatabaseOptions(resolved));
  const execution = captured.binding;
  void captured.release();
  return {
    scope: {
      ...scope,
      agentId: resolved.agentId,
      sessionKey:
        resolved.sessionKey === undefined
          ? undefined
          : resolveSqliteSessionKey(resolved.sessionKey, resolved.agentId),
    },
    execution,
  };
}

export function retainSessionTranscriptReadScope(
  execution: AgentDatabaseExecutionBinding,
  assertCurrent: () => void,
  scope: SqliteWorkerHostScope,
) {
  return retainSessionTranscriptOperation({ execution }, assertCurrent, "read", scope);
}

/** Entry and transcript readers share native custody without creating a missing logical store. */
export function retainSessionDatabaseRead(
  execution: AgentDatabaseExecutionBinding,
  assertCurrent: () => void,
) {
  return retainSessionTranscriptOperation({ execution }, assertCurrent, "read");
}

/** Read authority never creates a missing logical store or grants a transaction. */
export function retainSessionTranscriptRead(
  target: SessionTranscriptTargetBinding,
  assertCurrent: () => void,
) {
  return retainSessionTranscriptOperation(requireExecution(target), assertCurrent, "read");
}

/** The synchronous writer constructor, unlike a snapshot reader, owns first-use storage creation. */
export function retainSessionTranscriptInitialization(
  target: SessionTranscriptTargetBinding,
  assertCurrent: () => void,
) {
  return retainSessionTranscriptOperation(requireExecution(target), assertCurrent, "initialize");
}

/** Metadata writes retain their caller's storage admission; reads never acquire this authority. */
export function retainSessionTranscriptWrite(
  target: SessionTranscriptTargetBinding,
  assertCurrent: () => void,
) {
  return retainSessionTranscriptOperation(requireExecution(target), assertCurrent, "write");
}

function requireExecution(target: SessionTranscriptTargetBinding) {
  const binding = target[sessionTranscriptExecution];
  if (!binding) {
    throw new Error("Session transcript has no retained logical execution owner");
  }
  return binding;
}

function retainSessionTranscriptOperation(
  binding: { execution: AgentDatabaseExecutionBinding },
  assertCurrent: () => void,
  access: "read" | "initialize" | "write",
  scope?: SqliteWorkerHostScope,
) {
  binding.execution.assertCurrent();
  const execution = binding.execution.borrow();
  let admission: SqliteWorkerOperationAdmission | undefined;
  let settlement: SqliteWorkerOperationSettlement | undefined;
  let tentative = false;
  let publishedInitial: ReturnType<
    ReturnType<typeof retainSessionEntryWorkerPublication>["settle"]
  >;
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent,
    requiresHostContinuation: scope !== undefined,
    createAdmission(native) {
      return () => {
        let initializing: string | undefined;
        let publication: ReturnType<typeof retainSessionEntryWorkerPublication> | undefined;
        let published: ReturnType<NonNullable<typeof publication>["settle"]>;
        const original = createSqliteWorkerOperationAdmission(
          (request, grant) => {
            if (
              access !== "write" &&
              request.stage !== "prepare" &&
              !(access === "initialize" && request.stage === "open")
            ) {
              throw new Error("Session snapshot authority cannot grant a transcript write");
            }
            native.authorize(request);
            assertCurrent();
            const facts = isRecord(request.facts) ? request.facts.domain : undefined;
            if (
              execution.backend === "volatile" &&
              request.stage === "transaction" &&
              isRecord(facts) &&
              facts.kind === "session.metadata.initialize" &&
              typeof facts.sessionKey === "string"
            ) {
              initializing = facts.sessionKey;
              publication = retainSessionEntryWorkerPublication({
                agentId: execution.agentId,
                storePath: execution.path,
                identityKind: "volatile",
              });
              publication.begin([initializing], []);
            }
            if (!grant()) {
              throw new Error("Session transcript read admission expired");
            }
          },
          native.attachment,
          scope,
        );
        admission = original;
        return {
          nativeLocations: native.nativeLocations,
          admission: original,
          stage() {
            tentative = true;
            if (publication && !deferSqliteWorkerCallerPublication(() => published?.publish())) {
              throw new Error("Session initialization lost its original publication scope");
            }
          },
          settle(outcome) {
            settlement = outcome.settlement;
            const facts = original.committed?.facts;
            const created =
              isRecord(facts) &&
              facts.kind === "session.metadata.initialize" &&
              facts.sessionKey === initializing &&
              facts.created === true;
            published = publication?.settle(
              undefined,
              settlement.kind === "unknown",
              created && initializing ? [initializing] : [],
            );
            publishedInitial = published;
          },
        };
      };
    },
  };
  let operation;
  try {
    operation = execution.retainReadyOperation?.(source, { createIfMissing: access !== "read" });
    if (!operation) {
      throw new Error("Session transcript logical read requires its ready owner");
    }
  } catch (error) {
    void execution.release().catch(() => undefined);
    throw error;
  }
  const begin = () => {
    binding.execution.assertCurrent();
    assertCurrent();
    const options = { agentId: binding.execution.agentId, path: binding.execution.path };
    const host =
      access === "write"
        ? captureOpenClawAgentHostExecution(options)
        : captureActiveOpenClawAgentHostExecution(options);
    const native = host?.beginNative();
    try {
      if (native && scope) {
        scope.bindHostExecution(native.runHostStep);
      }
    } catch (error) {
      native?.settle();
      throw error;
    }
    admission = undefined;
    settlement = undefined;
    tentative = false;
    publishedInitial = undefined;
    return () => {
      // A tentative child has returned to its original direct driver. Its final
      // COMMIT/rollback custody stays with the outer scope, not the awaiting caller.
      if (
        !admission ||
        settlement?.kind === "completed" ||
        settlement?.kind === "not-entered" ||
        (tentative && admission.tentative)
      ) {
        try {
          if (!tentative) {
            publishedInitial?.publish();
          }
        } finally {
          native?.settle();
        }
      }
    };
  };
  const execute: typeof operation.execute = async <K extends keyof AgentDatabaseOperations>(
    command: { type: K; input: AgentDatabaseOperations[K]["input"] },
    options?: { signal?: AbortSignal },
  ): Promise<AgentDatabaseOperations[K]["output"]> => {
    const finish = begin();
    let outcome: { value: AgentDatabaseOperations[K]["output"] } | { error: unknown };
    let finishFailure: { error: unknown } | undefined;
    try {
      outcome = { value: await operation.execute(command, options) };
    } catch (error) {
      outcome = { error };
    } finally {
      try {
        finish();
      } catch (error) {
        finishFailure = { error };
      }
    }
    if (finishFailure) {
      if ("error" in outcome) {
        throw new AggregateError(
          [outcome.error, finishFailure.error],
          "Session transcript outcome and ownership failed",
          { cause: outcome.error },
        );
      }
      throw finishFailure.error;
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  };
  const executeReady: typeof operation.executeReady = <
    K extends keyof AgentDatabaseOperations,
  >(command: {
    type: K;
    input: AgentDatabaseOperations[K]["input"];
  }): AgentDatabaseOperations[K]["output"] => {
    const finish = begin();
    let outcome: { value: AgentDatabaseOperations[K]["output"] } | { error: unknown };
    let finishFailure: { error: unknown } | undefined;
    try {
      outcome = { value: operation.executeReady(command) };
    } catch (error) {
      outcome = { error };
    } finally {
      try {
        finish();
      } catch (error) {
        finishFailure = { error };
      }
    }
    if (finishFailure) {
      if ("error" in outcome) {
        throw new AggregateError(
          [outcome.error, finishFailure.error],
          "Session transcript outcome and ownership failed",
          { cause: outcome.error },
        );
      }
      throw finishFailure.error;
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  };
  return {
    command(moduleUrl: URL, command: { type: string; input: unknown }) {
      return {
        type: "database.domain.run" as const,
        input: {
          id: randomUUID(),
          moduleUrl: moduleUrl.href,
          input: undefined,
          command,
          ...(scope ? { scoped: true as const } : {}),
        },
      };
    },
    execute,
    executeReady,
    get tentative() {
      return tentative;
    },
    get nativeSettlement() {
      return admission?.settlement;
    },
    async close() {
      try {
        await operation.close();
      } finally {
        await execution.release();
      }
    },
  };
}

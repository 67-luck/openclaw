import { randomUUID } from "node:crypto";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptMessageAppendOptions,
} from "../../config/sessions/session-accessor.sqlite-contract.js";
import {
  captureSessionPendingInputWorkerAppend,
  SessionPendingInputSettlementUnknownError,
} from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import {
  prepareSqliteTranscriptReadScope,
  resolveSqliteSessionKey,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { isTranscriptMessageAppendCurrentTail } from "../../config/sessions/session-accessor.sqlite-transcript-append-result.js";
import { prepareSerializedTranscriptMessageAppend } from "../../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import { redactTranscriptMessageForStorage } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import type {
  SessionPendingInputWorkerAssociation,
  SessionPendingInputTerminalResult,
} from "../../config/sessions/session-pending-input.types.js";
import {
  assertSessionStoreReadCandidate,
  type SessionStoreReadCandidate,
} from "../../config/sessions/session-store-read-candidates.js";
import {
  sessionTranscriptExecution,
  type SessionTranscriptTargetBinding,
} from "../../config/sessions/transcript-target-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PreparedSessionMutationFacts } from "../../gateway/session-sharing-policy.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-coordinator.js";
import { isSqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import type { UserTurnFreshInputCommit } from "../../sessions/user-turn-transcript-admission.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  type OpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import type {
  PendingToolResult,
  SessionToolResultPending,
} from "../session-tool-result-pending.js";
import type { CustomMessage } from "./messages.js";
import { SessionTranscriptMessageCommittedError } from "./session-manager-message-error.js";
import type {
  SessionMessageWorkerAppend,
  SessionMessageWorkerOperations,
  SessionMessageWorkerTerminal,
} from "./session-manager-message.worker.js";
import {
  createSessionMessageAppendOperation,
  type SessionMessageAppendOutcome,
  type MessageOperationResult,
  type MessageAppendSteps,
  type HostExecution,
  type MessageCompletion,
} from "./session-message-append-operation.js";
import type { SessionMessageCommitFacts } from "./session-message-append-receipt.js";

const moduleUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionManagerMessage);
type ManagerAppend = Extract<SessionMessageWorkerAppend, { kind: "manager" }>;

async function runMessageAppend(
  steps: MessageAppendSteps,
  host?: HostExecution,
): Promise<SessionMessageAppendOutcome> {
  let next = host ? host.run(() => steps.next()) : steps.next();
  while (!next.done) {
    const result = await next.value.execute();
    try {
      next = result.continuation
        ? result.continuation.runHostStep(() => steps.next(result))
        : host
          ? host.run(() => steps.next(result))
          : steps.next(result);
    } finally {
      if (result.hasConsumedNativeOutcome?.() !== false) {
        result.continuation?.settle();
      }
    }
  }
  return next.value;
}

function runReadyMessageAppend(steps: MessageAppendSteps): SessionMessageAppendOutcome {
  let next = steps.next();
  while (!next.done) {
    const result = next.value.executeReady();
    try {
      next = result.continuation
        ? result.continuation.runHostStep(() => steps.next(result))
        : steps.next(result);
    } finally {
      if (result.hasConsumedNativeOutcome?.() !== false) {
        result.continuation?.settle();
      }
    }
  }
  return next.value;
}
type MessageRuntimeParams = {
  execution: OpenClawAgentDatabaseExecution;
  scope: SessionTranscriptWriteScope &
    Pick<SessionTranscriptTargetBinding, typeof sessionTranscriptExecution> & {
      agentId: string;
      sessionId: string;
      sessionKey: string;
    };
  assertCurrent(this: void): void;
  commit?(facts: SessionMessageCommitFacts): void;
  publishCommit?(facts: SessionMessageCommitFacts): void;
};

/** A retained execution reference supplies storage custody; no host DatabaseSync is borrowed. */
export function createSessionManagerMessageRuntime(
  params: MessageRuntimeParams & {
    pending: SessionToolResultPending;
  },
) {
  const runtime = createSessionMessageRuntime({
    ...params,
    owner: { kind: "manager", pending: params.pending },
  });
  return { append: runtime.append, appendReady: runtime.appendReady, close: runtime.close };
}

function createSessionMessageRuntime(
  params: MessageRuntimeParams & {
    owner: { kind: "manager"; pending: SessionToolResultPending } | { kind: "target-note" };
  },
) {
  const { execution, assertCurrent: assertSourceCurrent } = params;
  const { env, [sessionTranscriptExecution]: _execution, ...target } = params.scope;
  const scope = {
    ...structuredClone(target),
    sessionKey: resolveSqliteSessionKey(target.sessionKey, target.agentId),
  };
  const owner = Object.freeze({
    databasePath: execution.path,
    sessionId: scope.sessionId,
    sessionKey: scope.sessionKey,
  });
  const options = { agentId: execution.agentId, path: execution.path, env: env && { ...env } };
  const operations = new Set<Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let unsafeView: Error | undefined;
  let unresolvedInput = false;
  let inputExecution: OpenClawAgentDatabaseExecution | undefined;
  let inputReferences = 0;
  const invalidateView = (cause: unknown) => {
    // COMMIT is final even if adoption fails. Only a new, reloaded view may
    // append again; caller currentness cannot make this stale view authoritative.
    unsafeView ??= new Error(
      "Reload the committed transcript into a new message runtime before appending",
      { cause },
    );
  };
  const assertCurrent = () => {
    if (closed) {
      throw new Error("Session message runtime is closed");
    }
    if (unsafeView) {
      throw unsafeView;
    }
    execution.assertCurrent();
    assertSourceCurrent();
  };
  const createOperation = <K extends keyof SessionMessageWorkerOperations>(
    type: K,
    input: SessionMessageWorkerOperations[K]["input"],
    source: AgentDatabaseRequestExecutionSource,
    settle: () => Promise<void>,
    reference = execution,
    host?: HostExecution,
    hasConsumedNativeOutcome?: () => boolean,
  ) => {
    const command = {
      type: "database.domain.run" as const,
      input: {
        id: input.operationId,
        moduleUrl: moduleUrl.href,
        input: undefined,
        command: { type, input },
        ...(type === "session.message.append" && "freshInputHost" in input && input.freshInputHost
          ? { scoped: true as const }
          : {}),
      },
    };
    const outcome = (): MessageOperationResult<SessionMessageWorkerOperations[K]["output"]> => ({
      value: undefined,
      missing: false,
      failures: [],
      continuation: undefined,
      hasConsumedNativeOutcome,
    });
    return {
      async execute() {
        const result = outcome();
        const perform = async () => {
          let retained: ReturnType<NonNullable<typeof reference.retainReadyOperation>> | undefined;
          try {
            result.continuation = host?.beginNative?.();
            retained = reference.retainReadyOperation?.(source, {
              createIfMissing: params.owner.kind === "manager",
            });
            // The callback reaches execute synchronously for an already-ready volatile owner.
            // There is no host bind/open continuation in front of this complete original job.
            const value = await (retained
              ? retained.execute(command)
              : reference.runExisting(source, (writer) => writer.execute(command)));
            // The fixed message domain also preserves existing-only absence as undefined.
            // SAFETY: it returns the output for this original command.
            result.value = value as SessionMessageWorkerOperations[K]["output"] | undefined;
            result.missing = value === undefined;
          } catch (error) {
            result.failures.push(error);
          } finally {
            try {
              await retained?.close();
            } catch (error) {
              result.failures.push(error);
            }
            try {
              await settle();
            } catch (error) {
              result.failures.push(error);
            }
          }
        };
        try {
          if (reference.backend === "volatile") {
            await perform();
          } else {
            await runOpenClawAgentWorkerWrite(options, perform);
          }
        } catch (error) {
          result.failures.push(error);
        }
        return result;
      },
      executeReady() {
        const result = outcome();
        let retained: ReturnType<NonNullable<typeof reference.retainReadyOperation>> | undefined;
        try {
          result.continuation = host?.beginNative?.();
          retained = reference.retainReadyOperation?.(source, {
            createIfMissing: params.owner.kind === "manager",
          });
          if (!retained) {
            throw new Error("Session synchronous worker append requires its ready volatile owner");
          }
          const value = retained.executeReady(command);
          // SAFETY: the fixed message domain returns this command's output on the original ready path.
          result.value = value as SessionMessageWorkerOperations[K]["output"] | undefined;
          result.missing = result.value === undefined;
        } catch (error) {
          result.failures.push(error);
        } finally {
          // A timed-out waiter cannot abandon its original native scope or retained receipt.
          if (retained) {
            const joined = retained.close().then(settle);
            operations.add(joined);
            void joined.finally(() => operations.delete(joined)).catch(() => undefined);
          }
        }
        return result;
      },
    };
  };

  const append = createSessionMessageAppendOperation({
    execution,
    scope,
    owner,
    options,
    params,
    assertCurrent,
    invalidateView,
    createOperation,
    getUnsafeView: () => unsafeView,
    retainUnresolvedInput: () => {
      unresolvedInput = true;
    },
  });
  const inputAssociation: SessionPendingInputWorkerAssociation = {
    retain() {
      assertCurrent();
      // Terminal work can follow message-runtime close. The original input owns
      // a separate reference to the same native owner, not a future close waiter.
      inputExecution ??= captureOpenClawAgentDatabaseExecution(options);
      const retained = inputExecution;
      inputReferences += 1;
      let released: Promise<void> | undefined;
      return () => {
        if (!released) {
          inputReferences -= 1;
          if (inputReferences === 0) {
            inputExecution = undefined;
            released = retained.release();
          } else {
            released = Promise.resolve();
          }
        }
        return released;
      };
    },
    settle(terminal, authorize) {
      const operation = (async (): Promise<SessionPendingInputTerminalResult> => {
        const retained = inputExecution;
        if (!retained || inputReferences === 0) {
          throw new Error("Input settlement lost its original execution reference");
        }
        const input: SessionMessageWorkerTerminal = {
          operationId: randomUUID(),
          scope,
          terminal: structuredClone(terminal),
        };
        let native: SqliteWorkerOperationAdmission | undefined;
        let settled: Promise<SqliteWorkerOperationSettlement> | undefined;
        let settlement: SqliteWorkerOperationSettlement | undefined;
        let committedFacts:
          | SessionMessageWorkerOperations["session.input.settle"]["output"]
          | undefined;
        const source: AgentDatabaseRequestExecutionSource = {
          // Terminal disposition retains the original physical reference, not
          // permission to execute another turn after cancellation or view failure.
          assertCurrent: () => retained.assertCurrent(),
          requiresHostContinuation: false,
          createAdmission(binding) {
            return (retainedAdmission) => {
              let phase: "waiting" | "transaction" | "commit" = "waiting";
              const admission = createSqliteWorkerOperationAdmission((request, grant) => {
                binding.authorize(request);
                if (request.stage === "transaction" || request.stage === "commit") {
                  const facts = isRecord(request.facts) ? request.facts.domain : undefined;
                  if (
                    !isRecord(facts) ||
                    facts.operationId !== input.operationId ||
                    facts.inputId !== terminal.owner.inputId ||
                    facts.kind !== terminal.kind ||
                    (request.stage === "transaction"
                      ? phase !== "waiting"
                      : phase !== "transaction")
                  ) {
                    throw new Error("Input settlement differs from its retained operation");
                  }
                  if (terminal.kind === "complete") {
                    if (!isRecord(facts.authorization)) {
                      throw new Error("Input completion has no current target facts");
                    }
                    // SAFETY: the paired worker produced these connection-local facts.
                    authorize(facts.authorization as PreparedSessionMutationFacts);
                  }
                  if (request.stage === "commit") {
                    // SAFETY: the paired worker owns this bounded completion result.
                    committedFacts = structuredClone(facts) as NonNullable<typeof committedFacts>;
                  }
                  phase = request.stage;
                  native = admission;
                  settled = retainedAdmission.settled;
                }
                if (!grant()) {
                  throw new Error("Input settlement admission expired");
                }
              }, binding.attachment);
              return { nativeLocations: binding.nativeLocations, admission };
            };
          },
        };
        const { failures, missing } = await createOperation(
          "session.input.settle",
          input,
          source,
          async () => {
            settlement = await settled;
          },
          retained,
        ).execute();
        if (missing) {
          failures.push(new Error("Input settlement lost its existing storage"));
        }
        const receipt = native?.committed?.facts;
        if (isRecord(receipt) && receipt.operationId === input.operationId && committedFacts) {
          return { kind: "committed", outcome: committedFacts.outcome, failures };
        }
        const error =
          failures.length === 1
            ? failures[0]
            : new AggregateError(
                failures,
                "Input settlement did not retain a native commit receipt",
              );
        if (settlement?.kind === "unknown") {
          unresolvedInput = true;
          return { kind: "unknown", error };
        }
        return { kind: "not-committed", error };
      })();
      operations.add(operation);
      void operation.finally(() => operations.delete(operation)).catch(() => {});
      return operation;
    },
  };
  function prepareAppend(
    messageOptions: Omit<
      TranscriptMessageAppendOptions<AgentMessage>,
      "prepareMessageAfterIdempotencyCheck" | "beforeFreshMessageCommit"
    >,
    preparation: {
      repairedCall?: PendingToolResult;
      parent?: ManagerAppend["prepared"];
      limits?: ManagerAppend["limits"];
      initialize?: ManagerAppend["initialize"];
      loadedVersion?: ManagerAppend["loadedVersion"];
      freshInput?: UserTurnFreshInputCommit;
      assertFreshInput?: () => void;
      beforeFreshMessageCommit?: () => void;
    } = {},
    completion?: MessageCompletion,
  ) {
    assertCurrent();
    completion?.assertCurrent?.();
    if (params.owner.kind !== "manager") {
      throw new Error("Target-only transcript notes cannot adopt a session manager");
    }
    const pending = params.owner.pending;
    const inputCapture = captureSessionPendingInputWorkerAppend(
      { ...owner, sessionKey: scope.sessionKey },
      messageOptions.message,
      inputAssociation,
    );
    const prepared = pending.serialize(owner, () =>
      inputCapture
        ? { messageJson: inputCapture.input.identity.messageJson }
        : prepareSerializedTranscriptMessageAppend(messageOptions),
    );
    assertCurrent();
    const { message: _message, ...appendOptions } = messageOptions;
    const input: SessionMessageWorkerAppend = {
      kind: "manager",
      operationId: randomUUID(),
      scope,
      messageJson: prepared.messageJson,
      options: structuredClone({
        ...appendOptions,
        eventId: appendOptions.eventId ?? randomUUID(),
        now: appendOptions.now ?? Date.now(),
      }),
      prepared: preparation.parent && { ...preparation.parent },
      limits: preparation.limits && { ...preparation.limits },
      pendingInput: inputCapture && structuredClone(inputCapture.input),
      initialize: preparation.initialize && { ...preparation.initialize },
      loadedVersion: preparation.loadedVersion && { ...preparation.loadedVersion },
      freshInput: Boolean(
        preparation.beforeFreshMessageCommit ||
        preparation.assertFreshInput ||
        preparation.freshInput,
      ),
      ...(preparation.beforeFreshMessageCommit ||
      (preparation.assertFreshInput && !preparation.freshInput)
        ? { freshInputHost: true as const }
        : {}),
    };
    return {
      steps: append(
        input,
        (transaction) => ({
          ...owner,
          kind: "manager",
          capture: pending.capture(owner, transaction),
          inputCapture,
        }),
        preparation.repairedCall,
        completion && { ...completion },
        preparation.freshInput,
        preparation.beforeFreshMessageCommit,
        preparation.assertFreshInput,
      ),
      inputCapture,
      host: completion?.host,
    };
  }
  return {
    append(
      this: void,
      ...args: Parameters<typeof prepareAppend>
    ): Promise<SessionMessageAppendOutcome> {
      const prepared = prepareAppend(...args);
      const result = runMessageAppend(prepared.steps, prepared.host);
      prepared.inputCapture?.retain(result);
      operations.add(result);
      void result.finally(() => operations.delete(result)).catch(() => {});
      return result;
    },
    appendReady(
      this: void,
      ...args: Parameters<typeof prepareAppend>
    ): SessionMessageAppendOutcome {
      return runReadyMessageAppend(prepareAppend(...args).steps);
    },
    appendTargetNote(messageJson: string, cwd: string) {
      assertCurrent();
      if (params.owner.kind !== "target-note") {
        throw new Error("Manager appends require their actual pending reservation owner");
      }
      const result = runMessageAppend(
        append(
          {
            kind: "target-note",
            operationId: randomUUID(),
            scope,
            messageJson,
            options: { cwd, eventId: randomUUID(), now: Date.now() },
          },
          () => ({ ...owner, kind: "target-note" }),
        ),
      );
      operations.add(result);
      void result.finally(() => operations.delete(result)).catch(() => {});
      return result;
    },
    close(this: void) {
      closed = true;
      closing ??= (async () => {
        while (operations.size) {
          await Promise.allSettled(operations);
        }
        if (unresolvedInput) {
          throw new SessionPendingInputSettlementUnknownError();
        }
        await execution.release();
      })();
      return closing;
    },
  };
}

/** Target-only notes share native append settlement without adopting a manager's view or pending set. */
export async function appendSessionTranscriptMessage(input: {
  target: SessionTranscriptTargetBinding & SessionTranscriptWriteScope;
  candidate: SessionStoreReadCandidate;
  message: CustomMessage;
  config?: OpenClawConfig;
  cwd: string;
  assertCurrent: () => void;
}): Promise<{
  messageId: string;
  message: CustomMessage;
  appended: boolean;
  currentTail: boolean;
}> {
  const message = redactTranscriptMessageForStorage(input.message, input);
  const preparedJson = JSON.stringify(message);
  const assertPrepared = () => {
    input.assertCurrent();
    if (JSON.stringify(redactTranscriptMessageForStorage(input.message, input)) !== preparedJson) {
      throw new Error("Transcript message redaction changed before persistence");
    }
  };
  assertPrepared();
  const resolved = await prepareSqliteTranscriptReadScope(input.target);
  const options = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  const assertCurrent = () => {
    assertPrepared();
    assertSessionStoreReadCandidate(databasePath, [input.candidate]);
  };
  assertCurrent();
  const execution = captureOpenClawAgentDatabaseExecution(options);
  let runtime: ReturnType<typeof createSessionMessageRuntime> | undefined;
  let committed: SessionMessageCommitFacts | undefined;
  let value:
    | { messageId: string; message: CustomMessage; appended: boolean; currentTail: boolean }
    | undefined;
  const failures: unknown[] = [];
  try {
    runtime = createSessionMessageRuntime({
      execution,
      scope: { ...input.target, agentId: resolved.agentId, storePath: execution.path },
      owner: { kind: "target-note" },
      assertCurrent,
    });
    const outcome = await runtime.appendTargetNote(preparedJson, input.cwd);
    if (outcome.kind === "tentative") {
      throw new Error("Target note completion must join its outer native settlement");
    }
    if (outcome.kind !== "committed") {
      if (outcome.kind === "missing") {
        throw new Error("Session transcript message was not persisted");
      }
      if (outcome.kind === "unknown" && outcome.error instanceof Error) {
        recordModelFallbackStop(outcome.error);
      }
      throw outcome.error;
    }
    committed = outcome.facts;
    failures.push(...outcome.failures);
    if (outcome.value?.message.role !== "custom") {
      throw new Error("Committed transcript note has no matching delivered message");
    }
    value = {
      messageId: committed.receipt.messageId,
      message: outcome.value.message,
      appended: committed.receipt.appended,
      currentTail: isTranscriptMessageAppendCurrentTail({
        ...committed,
        result: { ...committed.receipt, message: outcome.value.message },
      }),
    };
    assertCurrent();
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      if (runtime) {
        await runtime.close();
      } else {
        await execution.release();
      }
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    if (failures.length > 1) {
      throw createSqliteLifecycleAggregateError(
        failures,
        "Session transcript append and cleanup failed",
        failures[0],
      );
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    assertCurrent();
  } catch (error) {
    if (committed) {
      throw new SessionTranscriptMessageCommittedError(
        committed.receipt.messageId,
        error,
        input.target,
        committed.after,
        committed.lifecycleRevision,
      );
    }
    if (
      error instanceof Error &&
      collectNestedErrorCandidates(error).some((cause) =>
        isSqliteWorkerError(cause, "outcome-unknown"),
      )
    ) {
      recordModelFallbackStop(error);
    }
    throw error;
  }
  if (!value) {
    throw new Error("Session transcript message was not persisted");
  }
  return value;
}

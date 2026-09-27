import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { retainSessionEntryWorkerPublication } from "../../config/sessions/session-accessor.sqlite-entry-cache.js";
import type { SessionPendingInputWorkerFacts } from "../../config/sessions/session-pending-input.types.js";
import { startSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { isSqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCallerPublication,
  stageSqliteWorkerCallerRollback,
} from "../../infra/sqlite-worker-host-context.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { createSqliteWorkerHostScope } from "../../infra/sqlite-worker-scoped-operation.js";
import {
  assertUserTurnFreshInputCommit,
  type UserTurnFreshInputCommit,
} from "../../sessions/user-turn-transcript-admission.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-contract.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import type { PendingToolResult } from "../session-tool-result-pending.js";
import type {
  SessionMessageWorkerAppend,
  SessionMessageWorkerOperations,
  SessionMessagePendingPreparation,
} from "./session-manager-message.worker.js";
import {
  createSessionMessageAppendSettlement,
  type SessionMessageAppendOwner,
  type SessionMessageCommitFacts,
} from "./session-message-append-receipt.js";

type MessageReply = SessionMessageWorkerOperations["session.message.append"]["output"];
type SessionMessageAppendSuccess = {
  facts: SessionMessageCommitFacts;
  value?: MessageReply;
  failures: readonly unknown[];
  publish?(this: void, observer: () => void): void;
};
export type SessionMessageAppendOutcome =
  | ({ kind: "committed" } & SessionMessageAppendSuccess)
  | ({ kind: "tentative" } & SessionMessageAppendSuccess)
  | { kind: "not-committed" | "unknown"; error: unknown }
  | { kind: "missing" };
export type MessageOperationResult<Value = MessageReply> = {
  value: Value | undefined;
  missing: boolean;
  failures: unknown[];
  continuation?: { runHostStep<T>(this: void, run: () => T): T; settle(): void };
  hasConsumedNativeOutcome?: () => boolean;
};
type MessageOperation = {
  execute(): Promise<MessageOperationResult>;
  executeReady(): MessageOperationResult;
};
export type MessageAppendSteps = Generator<
  MessageOperation,
  SessionMessageAppendOutcome,
  MessageOperationResult
>;
export type HostExecution = {
  run<T>(this: void, run: () => T): T;
  beginNative?(): NonNullable<MessageOperationResult["continuation"]>;
};
export type MessageCompletion = {
  adopt(value: MessageReply): void;
  stage?(value: MessageReply): () => void;
  publish(value: MessageReply): void;
  assertCurrent?(): void;
  host?: HostExecution;
};

// Borrow runtime-owned references and accessors; each generator owns only its
// append's settlement, while tracking and close remain with the runtime.
export function createSessionMessageAppendOperation(bindings: {
  execution: OpenClawAgentDatabaseExecution;
  scope: SessionMessageWorkerAppend["scope"];
  owner: Pick<SessionMessageAppendOwner, "databasePath" | "sessionId" | "sessionKey">;
  options: OpenClawAgentDatabaseOptions;
  params: {
    commit?(facts: SessionMessageCommitFacts): void;
    publishCommit?(facts: SessionMessageCommitFacts): void;
  };
  assertCurrent(this: void): void;
  invalidateView(this: void, cause: unknown): void;
  getUnsafeView(this: void): Error | undefined;
  retainUnresolvedInput(this: void): void;
  createOperation(
    this: void,
    type: "session.message.append",
    input: SessionMessageWorkerAppend,
    source: AgentDatabaseRequestExecutionSource,
    settle: () => Promise<void>,
    reference: OpenClawAgentDatabaseExecution,
    host?: HostExecution,
    hasConsumedNativeOutcome?: () => boolean,
  ): MessageOperation;
}) {
  const {
    execution,
    scope,
    owner,
    options,
    params,
    assertCurrent,
    invalidateView,
    getUnsafeView,
    retainUnresolvedInput,
    createOperation,
  } = bindings;

  function* append(
    input: SessionMessageWorkerAppend,
    retainOwner: (transaction: object) => SessionMessageAppendOwner,
    repairedCall?: PendingToolResult,
    completion?: MessageCompletion,
    freshInput?: UserTurnFreshInputCommit,
    beforeFreshMessageCommit?: () => void,
    assertFreshInput?: () => void,
  ): MessageAppendSteps {
    let custody: ReturnType<typeof createSessionMessageAppendSettlement> | undefined;
    let manager: Extract<SessionMessageAppendOwner, { kind: "manager" }> | undefined;
    let native: SqliteWorkerOperationAdmission | undefined;
    let settled: Promise<SqliteWorkerOperationSettlement> | undefined;
    let originalSettlement: SqliteWorkerOperationSettlement | undefined;
    let adopted = false;
    let committedApplied = false;
    let rollbackView: (() => void) | undefined;
    let rollbackInitialization: (() => void) | undefined;
    let nativeContinuation: MessageOperationResult["continuation"];
    let hostFreshChecked = false;
    let hostScope: ReturnType<typeof createSqliteWorkerHostScope> | undefined;
    let retainedPublication: (() => void) | undefined;
    const initialPublication =
      execution.backend === "volatile" && input.kind === "manager" && input.initialize
        ? retainSessionEntryWorkerPublication({
            agentId: execution.agentId,
            storePath: execution.path,
            identityKind: "volatile",
          })
        : undefined;
    let publishedInitial: ReturnType<NonNullable<typeof initialPublication>["settle"]>;
    const assertOperationCurrent = () => {
      assertCurrent();
      completion?.assertCurrent?.();
    };
    const privateFailures: unknown[] = [];
    const rollbackStagedView = () => {
      const restores = [rollbackView, rollbackInitialization];
      rollbackView = undefined;
      rollbackInitialization = undefined;
      adopted = false;
      const failures: unknown[] = [];
      for (const restore of restores) {
        try {
          restore?.();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length) {
        throw new AggregateError(failures, "Session tentative view rollback failed", {
          cause: failures[0],
        });
      }
    };
    const settleCustody = (settlement: SqliteWorkerOperationSettlement) => {
      originalSettlement = settlement;
      const failures: unknown[] = [];
      try {
        custody?.settle(native?.committed?.facts, settlement);
      } catch (error) {
        failures.push(error);
      }
      const committed = custody?.committed;
      try {
        publishedInitial ??= initialPublication?.settle(
          undefined,
          settlement.kind === "unknown",
          committed?.kind === "manager" && committed.initial?.identity
            ? [...committed.initial.identity.current.keys()]
            : [],
        );
      } catch (error) {
        failures.push(error);
      }
      if (committed && !committedApplied) {
        try {
          committedApplied = true;
          if (committed.kind === "manager" && committed.initial?.fence) {
            Object.assign(scope, committed.initial.fence);
          }
          params.commit?.(committed);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        const error =
          failures.length === 1
            ? failures[0]
            : new AggregateError(failures, "Session private settlement failed", {
                cause: failures[0],
              });
        if (custody?.committed && manager) {
          invalidateView(error);
        }
        throw error;
      }
    };
    const source: AgentDatabaseRequestExecutionSource = {
      assertCurrent: assertOperationCurrent,
      requiresHostContinuation: input.kind === "manager" && Boolean(input.freshInputHost),
      createAdmission(binding) {
        return (retained) => {
          const retainedOwner = retainOwner(retained.transaction);
          manager = retainedOwner.kind === "manager" ? retainedOwner : undefined;
          manager?.inputCapture?.retain(retained.settled);
          custody = createSessionMessageAppendSettlement(input.operationId, retainedOwner);
          const attachment: SessionMessagePendingPreparation | undefined = manager && {
            operationId: input.operationId,
            calls: manager.capture.facts,
            repairedToken: repairedCall && manager.capture.token(repairedCall),
          };
          let phase: "waiting" | "transaction" | "commit" = "waiting";
          let freshInputChecked = false;
          if (binding.operation === "execute" && input.kind === "manager" && input.freshInputHost) {
            hostScope = createSqliteWorkerHostScope(
              (step) => {
                if (
                  step.kind !== "fresh-input" ||
                  !isRecord(step.value) ||
                  step.value.operationId !== input.operationId ||
                  hostFreshChecked ||
                  !nativeContinuation ||
                  (!beforeFreshMessageCommit && !assertFreshInput)
                ) {
                  throw new Error("Fresh input continuation differs from its original append");
                }
                assertOperationCurrent();
                beforeFreshMessageCommit?.();
                // An opaque native-compatible recorder assertion stays on this
                // caller stack. Branded authority is checked by the fixed grant.
                if (!freshInput) {
                  assertFreshInput?.();
                }
                assertOperationCurrent();
                hostFreshChecked = true;
                return undefined;
              },
              execution.binding.incarnation,
              (publish) => {
                retainedPublication = publish;
              },
            );
            if (nativeContinuation) {
              hostScope.bindHostExecution(nativeContinuation.runHostStep);
            }
          }
          const admission = createSqliteWorkerOperationAdmission(
            (request, grant) => {
              // Domain facts extend, never replace, the native physical identity envelope.
              binding.authorize(request);
              assertOperationCurrent();
              if (request.stage === "transaction" || request.stage === "commit") {
                const facts = isRecord(request.facts) ? request.facts.domain : undefined;
                const freshCheckpoint = isRecord(facts) && facts.checkpoint === "fresh-input";
                if (
                  !isRecord(facts) ||
                  facts.operationId !== input.operationId ||
                  facts.kind !== retainedOwner.kind ||
                  !isRecord(facts.owner) ||
                  facts.owner.databasePath !== owner.databasePath ||
                  facts.owner.sessionId !== owner.sessionId ||
                  facts.owner.sessionKey !== owner.sessionKey ||
                  (request.stage === "transaction"
                    ? freshCheckpoint
                      ? phase !== "transaction" ||
                        freshInputChecked ||
                        input.kind !== "manager" ||
                        !input.freshInput
                      : phase !== "waiting" || facts.checkpoint !== undefined
                    : phase !== "transaction" || facts.checkpoint !== undefined)
                ) {
                  throw new Error("Session message admission differs from its retained operation");
                }
                manager?.capture.assertCurrent();
                if (manager?.inputCapture) {
                  if (!isRecord(facts.pendingInput)) {
                    throw new Error("Session message admission omitted its pending input");
                  }
                  manager.inputCapture.assertCurrent(
                    // The paired worker projects pending rows and authorization facts.
                    // SAFETY: this capture checks those facts against its original operation owner.
                    facts.pendingInput as SessionPendingInputWorkerFacts,
                  );
                }
                if (freshCheckpoint) {
                  // This fixed admission is requested at the kernel's fresh-candidate branch,
                  // not inferred from the eventual result or delegated to a public predicate.
                  if (input.kind === "manager" && input.freshInputHost) {
                    if (!hostFreshChecked) {
                      throw new Error("Fresh input host continuation did not complete");
                    }
                  }
                  if (freshInput) {
                    assertUserTurnFreshInputCommit(freshInput);
                  }
                  freshInputChecked = true;
                }
                if (request.stage === "commit") {
                  if (freshInputChecked && freshInput) {
                    assertUserTurnFreshInputCommit(freshInput);
                  }
                  // SAFETY: paired worker facts are bounded; prepare maps tokens to exact captured objects.
                  custody!.prepare(facts as SessionMessageCommitFacts);
                }
                phase = request.stage;
                native = admission;
                settled = retained.settled;
                if (request.stage === "transaction") {
                  initialPublication?.begin([owner.sessionKey], []);
                }
              }
              if (!grant()) {
                throw new Error("Session message admission expired");
              }
            },
            { ...binding.attachment, domain: attachment },
            hostScope,
          );
          native = admission;
          settled = retained.settled;
          return {
            nativeLocations: binding.nativeLocations,
            admission,
            stage(result) {
              if (!native?.tentative || !custody || !completion?.stage) {
                throw new Error("Nested session append has no tentative view owner");
              }
              // SAFETY: this original child's result has a tentative receipt; operationId is checked below.
              const value = result as MessageReply;
              if (value.facts.operationId !== input.operationId) {
                throw new Error("Tentative session result changed its operation");
              }
              // Register before applying any tentative host state. Its exact stage
              // order, not child receipt order, also owns partial-adoption rollback.
              if (!stageSqliteWorkerCallerRollback(rollbackStagedView)) {
                throw new Error("Tentative session view lost its outer rollback owner");
              }
              custody.stage();
              if (value.facts.kind === "manager" && value.facts.initial?.fence) {
                const previous = {
                  expectedLifecycleRevision: scope.expectedLifecycleRevision,
                  expectedWriterRunId: scope.expectedWriterRunId,
                };
                Object.assign(scope, value.facts.initial.fence);
                rollbackInitialization = () => {
                  Object.assign(scope, previous);
                };
              }
              rollbackView = completion.stage(value);
              adopted = true;
              if (
                !deferSqliteWorkerCallerPublication(() => {
                  const facts = custody?.committed;
                  if (!facts) {
                    return;
                  }
                  try {
                    publishedInitial?.publish();
                    params.publishCommit?.(facts);
                  } finally {
                    completion.publish(value);
                  }
                })
              ) {
                throw new Error("Tentative session publication lost its outer caller scope");
              }
            },
            settle({ settlement, result }) {
              try {
                settleCustody(settlement);
                if (custody?.committed && completion && !result.ok && !adopted) {
                  invalidateView(result.error);
                }
                if (custody?.committed && result.ok && completion && !adopted) {
                  // This original job succeeded with matched committed custody.
                  // SAFETY: operationId and currentness precede adoption of its MessageReply.
                  const value = result.value as MessageReply;
                  if (value.facts.operationId !== input.operationId) {
                    throw new Error(
                      "Session message result differs from its retained native operation",
                    );
                  }
                  assertOperationCurrent();
                  completion.adopt(value);
                  adopted = true;
                  assertOperationCurrent();
                }
              } catch (error) {
                privateFailures.push(error);
                if (custody?.committed && completion) {
                  invalidateView(error);
                }
              }
            },
          };
        };
      },
    };
    const operation = yield createOperation(
      "session.message.append",
      input,
      source,
      async () => {
        const settlement = await settled;
        if (settlement) {
          settleCustody(settlement);
        }
      },
      execution,
      completion?.host?.beginNative
        ? {
            run: completion.host.run,
            beginNative() {
              nativeContinuation = completion.host?.beginNative?.();
              if (!nativeContinuation) {
                throw new Error("Session append lost its native continuation owner");
              }
              return nativeContinuation;
            },
          }
        : completion?.host,
      () =>
        privateFailures.length === 0 &&
        (!native ||
          originalSettlement?.kind === "completed" ||
          originalSettlement?.kind === "not-entered" ||
          (native.tentative && custody?.outcome === "tentative")),
    );
    let { value } = operation;
    const { missing, failures } = operation;
    failures.push(...privateFailures);
    const hostFailure = failures.length
      ? hostScope?.restoreHostFailure(
          failures.length === 1
            ? failures[0]
            : new AggregateError(failures, "Session message and settlement failed", {
                cause: failures[0],
              }),
          native?.settlement,
        )
      : undefined;
    const facts = custody?.committed;
    const tentative = custody?.tentative;
    if (facts && value?.facts.operationId !== input.operationId) {
      const error = new Error("Committed session message has no matching delivered result");
      failures.push(error);
      if (completion && !adopted) {
        invalidateView(error);
      }
      value = undefined;
    }
    let publicationFailure: { error: unknown } | undefined;
    const publish = retainedPublication;
    try {
      // Fixed settlement and result adoption precede these child observers;
      // parent identity/currentness publication remains behind their fail-fast boundary.
      publish?.();
      publishedInitial?.publish();
    } catch (error) {
      publicationFailure = { error };
      if (
        !hostFailure &&
        facts &&
        value &&
        adopted &&
        originalSettlement?.kind === "completed" &&
        failures.length === 0
      ) {
        throw error;
      }
      failures.push(error);
    }
    if (hostFailure) {
      return {
        kind: "not-committed",
        error: publicationFailure
          ? new AggregateError(
              [hostFailure.error, publicationFailure.error],
              "Session message and settlement failed",
              { cause: hostFailure.error },
            )
          : hostFailure.error,
      };
    }
    if (tentative && value && adopted) {
      return {
        kind: "tentative",
        facts: tentative,
        value,
        failures,
        publish(observer) {
          if (
            !deferSqliteWorkerCallerPublication(() => {
              if (custody?.committed) {
                observer();
              }
            })
          ) {
            throw new Error("Tentative session observer left its original caller scope");
          }
        },
      };
    }
    if (facts) {
      if (!publicationFailure) {
        try {
          params.publishCommit?.(facts);
        } catch (error) {
          failures.push(error);
        }
      }
      // Manager appends retain their worker-local kick; notes defer it to this retained host owner.
      if (
        value &&
        facts.kind === "target-note" &&
        facts.projectionNeedsReconcile &&
        execution.backend !== "volatile"
      ) {
        try {
          assertCurrent();
          startSessionTranscriptIndexReconcile({ ...options, preferredSessionId: scope.sessionId });
        } catch (error) {
          failures.push(error);
        }
      }
      if (!publicationFailure && value && completion) {
        if (!getUnsafeView() && adopted) {
          try {
            completion.publish(value);
          } catch (error) {
            failures.push(error);
          }
        }
      }
      return { kind: "committed", facts, value, failures };
    }
    if (missing && failures.length === 0) {
      return { kind: "missing" };
    }
    const error =
      failures.length === 1
        ? failures[0]
        : failures.length > 1
          ? new AggregateError(failures, "Session message and settlement failed", {
              cause: failures[0],
            })
          : new Error("Session message did not retain a native commit receipt");
    if (manager?.inputCapture && custody?.outcome === "unknown") {
      retainUnresolvedInput();
    }
    return {
      kind:
        custody?.outcome === "unknown" || isSqliteWorkerError(error, "outcome-unknown")
          ? "unknown"
          : "not-committed",
      error,
    };
  }
  return append;
}

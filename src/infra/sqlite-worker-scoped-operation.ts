import { AsyncLocalStorage } from "node:async_hooks";
import { MessageChannel } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Result } from "@openclaw/normalization-core/result";
import { createDeferredCore } from "../shared/deferred.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import { assertSyncTransactionResult } from "./sqlite-transaction.js";
import { bindSqliteWorkerDatabaseAuthority } from "./sqlite-worker-broker-admission.js";
import type { Actor, SqliteWorkerJobTerminal } from "./sqlite-worker-broker.types.js";
import {
  isSqliteWorkerError,
  someScopedError,
  SqliteWorkerError,
  type SqliteWorkerScopeAction,
  type SqliteWorkerScopeStep,
  type SqliteWorkerScopeWireResult as WireResult,
} from "./sqlite-worker-contract.js";
import {
  runSqliteWorkerHostContext,
  type SqliteWorkerHostDriver,
} from "./sqlite-worker-host-context.js";
import type { SqliteWorkerAdmissionFactory } from "./sqlite-worker-operation-admission.js";
import type {
  SqliteWorkerNativeSettlement,
  SqliteWorkerOperationSettlement,
} from "./sqlite-worker-operation-settlement.js";
import { createSqliteWorkerScopedTransfer } from "./sqlite-worker-transfer.js";
import { SQLITE_WORKER_PROTOCOL_WAIT_NS } from "./sqlite-worker-transport-contract.js";

type Entered = { id: number; step: SqliteWorkerScopeStep };
type HostWait = (complete: () => boolean) => SqliteWorkerJobTerminal | undefined;
type HostRollbackScope = { parent?: HostRollbackScope };
type HostTransaction = {
  publications: Array<() => void>;
  nativeWaitNs: { value: bigint };
  rollbacks: Array<{ scope: HostRollbackScope; rollback: () => void }>;
};

export function createSqliteWorkerHostTransaction(nativeWaitNs = { value: 0n }): HostTransaction {
  return { publications: [], nativeWaitNs, rollbacks: [] };
}

function readWireResult(result: WireResult, scope?: SqliteWorkerHostScope): unknown {
  if (result.ok) {
    return result.value;
  }
  const error = new Error("SQLite scoped command failed");
  if (result.error) {
    retainOpenClawStateWorkerErrorPayload(error, result.error);
  }
  const failure = hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
  if (result.hostFailure) {
    scope?.retainNativeHostFailure(failure, result.hostFailure.only);
  }
  throw failure;
}

/** Private framing only records a handoff. The direct driver alone enters caller code. */
export function createSqliteWorkerHostScope(
  run: (
    step: SqliteWorkerScopeStep,
    scope: {
      call(action: SqliteWorkerScopeAction): unknown;
    },
  ) => boolean | undefined,
  viewOwner?: object,
  retainPublication?: (publish: () => void) => void,
) {
  const { port1, port2 } = new MessageChannel();
  let entered: Entered | undefined;
  let reply: { sequence: number; result: WireResult } | undefined;
  let nextSequence = 0;
  let wake = createDeferredCore();
  let closed = false;
  let driving = false;
  let failure: Error | undefined;
  let hostFailure: { error: unknown } | undefined;
  let nativeHostFailure: { error: unknown; only: boolean } | undefined;
  let privateAdoptionFailure: { error: unknown } | undefined;
  let pausedNs = 0n;
  let requestDeadlineNs: bigint | undefined;
  const inCaller = AsyncLocalStorage.snapshot();
  let binding: { actor: Actor; nativeLocations: readonly string[] } | undefined;
  let transaction = createSqliteWorkerHostTransaction();
  const rollbackScope: HostRollbackScope = {};
  let drivingChild: { readonly requestDeadlineNs: bigint | undefined } | undefined;
  let runHostStep: (<T>(run: () => T) => T) | undefined;
  let committed = false;
  const children: Array<{
    retained: ReturnType<SqliteWorkerAdmissionFactory>;
    settled: ReturnType<typeof createDeferredCore<SqliteWorkerOperationSettlement>>;
    result?: Result<unknown, unknown>;
    closed?: true;
  }> = [];
  const failProtocol = (error: unknown) => {
    if (failure === undefined) {
      const unknown = isSqliteWorkerError(error, "outcome-unknown")
        ? error
        : new SqliteWorkerError("SQLite scoped protocol settlement is unknown", "outcome-unknown");
      if (unknown !== error) {
        Object.defineProperty(unknown, "cause", { value: error });
      }
      failure = binding ? (binding.actor.protocolFailure ??= unknown) : unknown;
    }
    wake.resolve();
    return failure;
  };
  const transfer = createSqliteWorkerScopedTransfer(
    port1,
    (message, ports) => {
      if (ports.length || !isRecord(message)) {
        throw new Error("SQLite host scope received an invalid envelope");
      }
      if (
        message.kind === "enter" &&
        typeof message.id === "number" &&
        Number.isSafeInteger(message.id) &&
        isRecord(message.step)
      ) {
        const kind = message.step.kind;
        if (
          entered ||
          (kind !== "session-context" &&
            kind !== "fresh-input" &&
            kind !== "entry-should-commit" &&
            kind !== "entry-before-write")
        ) {
          throw new Error("SQLite host scope received an unexpected caller handoff");
        }
        entered = { id: message.id, step: { kind, value: message.step.value } };
      } else if (
        message.kind === "result" &&
        Number.isSafeInteger(message.sequence) &&
        isRecord(message.result) &&
        typeof message.result.ok === "boolean" &&
        !reply
      ) {
        // SAFETY: the paired native owner supplies the bounded canonical error/result envelope.
        reply = { sequence: message.sequence as number, result: message.result as WireResult };
      } else {
        throw new Error("SQLite host scope received an out-of-order reply");
      }
      wake.resolve();
    },
    failProtocol,
  );
  const service = (check?: () => void) => {
    if (failure !== undefined) {
      throw failure;
    }
    transfer.service(check);
    for (const child of children) {
      child.retained.admission.service(check);
      child.retained.admission.scope?.service(check);
    }
  };
  const settleChild = (
    child: (typeof children)[number],
    settlement: SqliteWorkerOperationSettlement,
    nativeCommitted: boolean | undefined,
  ) => {
    if (child.closed) {
      return;
    }
    child.closed = true;
    const admission = child.retained.admission;
    let completedSettlement = settlement;
    try {
      const failures: unknown[] = [];
      try {
        admission.scope?.settleChildren(settlement, nativeCommitted);
      } catch (error) {
        failures.push(error);
      }
      try {
        admission.finish();
      } catch (error) {
        failures.push(error);
      }
      failures.push(...admission.cleanupFailures);
      if (failures.length) {
        const error = new AggregateError(failures, "Nested SQLite cleanup failed");
        completedSettlement = { kind: "unknown", error };
        child.result = {
          ok: false,
          error:
            child.result?.ok === false
              ? new AggregateError(
                  [child.result.error, error],
                  "Nested SQLite failure and cleanup failed",
                  { cause: child.result.error },
                )
              : error,
        };
      }
      try {
        child.retained.settle?.({
          settlement: completedSettlement,
          result: child.result ?? {
            ok: false,
            error: new SqliteWorkerError(
              "Nested SQLite result was not delivered",
              "outcome-unknown",
            ),
          },
        });
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length) {
        throw new AggregateError(failures, "Nested SQLite cleanup failed");
      }
    } finally {
      child.settled.resolve(completedSettlement);
    }
  };
  const owner = {
    port: port2,
    get pending() {
      return entered !== undefined;
    },
    get hostFailure() {
      return hostFailure;
    },
    retainNativeHostFailure(error: unknown, only: boolean) {
      nativeHostFailure = { error, only };
    },
    restoreHostFailure(error: unknown, settlement: SqliteWorkerNativeSettlement | undefined) {
      const nativeFailure = nativeHostFailure;
      if (
        !hostFailure ||
        !nativeFailure ||
        settlement?.kind !== "completed" ||
        settlement.committed ||
        !someScopedError(error, (entry) => entry === nativeFailure.error)
      ) {
        return undefined;
      }
      return nativeFailure.only && nativeFailure.error === error
        ? hostFailure
        : {
            error: new AggregateError(
              [hostFailure.error, error],
              "SQLite caller failure and cleanup failed",
              { cause: hostFailure.error },
            ),
          };
    },
    get pausedNs() {
      return pausedNs;
    },
    get requestDeadlineNs(): bigint | undefined {
      return drivingChild?.requestDeadlineNs ?? requestDeadlineNs;
    },
    bindHostExecution(execute: <T>(run: () => T) => T) {
      if (runHostStep) {
        throw new Error("SQLite caller scope already has its original host operation");
      }
      runHostStep = execute;
    },
    bind: (
      actor: Actor,
      nativeLocations: readonly string[],
      parent?: { transaction: HostTransaction; rollbackScope?: HostRollbackScope },
    ) => {
      if (binding && binding.actor !== actor) {
        throw new Error("SQLite caller scope changed actors");
      }
      binding = { actor, nativeLocations: [...nativeLocations] };
      if (parent) {
        // Admission captured this exact journal before dispatch. Independent work
        // has its own journal; only same-actor descendants inherit rollback ancestry.
        transaction = parent.transaction;
        if (!parent.rollbackScope) {
          return;
        }
        if (rollbackScope.parent && rollbackScope.parent !== parent.rollbackScope) {
          throw new Error("SQLite caller scope changed its original parent");
        }
        rollbackScope.parent = parent.rollbackScope;
      }
    },
    settleChildren: (
      parent: SqliteWorkerOperationSettlement,
      nativeCommitted: boolean | undefined,
    ) => {
      const failures: unknown[] = [];
      if (parent.kind === "completed" && nativeCommitted !== undefined) {
        committed = nativeCommitted;
        // Views stage across message, metadata and nested caller scopes. Undo their
        // actual order before child receipt cleanup; RELEASE alone never discards it.
        for (let index = transaction.rollbacks.length - 1; index >= 0; index--) {
          const entry = transaction.rollbacks[index]!;
          let scope: HostRollbackScope | undefined = entry.scope;
          while (scope && scope !== rollbackScope) {
            scope = scope.parent;
          }
          if (!scope) {
            continue;
          }
          transaction.rollbacks.splice(index, 1);
          if (!nativeCommitted) {
            try {
              entry.rollback();
            } catch (error) {
              failures.push(error);
            }
          }
        }
      }
      const retainedChildren = children.map((child) => {
        const admission = child.retained.admission;
        let childCommitted: boolean | undefined;
        let nativeSettlement: SqliteWorkerNativeSettlement | undefined;
        try {
          admission.service();
        } catch (error) {
          failures.push(error);
        }
        try {
          childCommitted = admission.committed !== undefined;
        } catch (error) {
          failures.push(error);
        }
        try {
          nativeSettlement = admission.settlement;
        } catch (error) {
          failures.push(error);
        }
        const settlement: SqliteWorkerOperationSettlement =
          nativeSettlement?.kind === "completed" && childCommitted !== undefined
            ? { kind: "completed" }
            : {
                kind: "unknown",
                error:
                  parent.kind === "completed"
                    ? new SqliteWorkerError(
                        "Nested SQLite operation has no outer settlement",
                        "outcome-unknown",
                      )
                    : parent.error,
              };
        return { child, childCommitted, settlement };
      });
      const rolledBack = retainedChildren.filter(
        ({ settlement, childCommitted }) => settlement.kind === "completed" && !childCommitted,
      );
      // Original pending reservations retain their own reverse native settlement order.
      for (const { child, childCommitted, settlement } of [
        ...rolledBack.toReversed(),
        ...retainedChildren.filter((item) => !rolledBack.includes(item)),
      ]) {
        if (parent.kind === "completed" && settlement.kind === "unknown") {
          failures.push(failProtocol(settlement.error));
        }
        try {
          settleChild(child, settlement, childCommitted);
        } catch (error) {
          failures.push(error);
        }
      }
      // One failed receipt or close cannot detach the remaining original children.
      // Each completion is delivered only after that child's own cleanup was attempted.
      for (let index = children.length - 1; index >= 0; index--) {
        if (children[index]?.closed) {
          children.splice(index, 1);
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Nested SQLite settlement failed");
      }
    },
    publish(this: void) {
      const publications = transaction.publications.splice(0);
      if (!publications.length) {
        return;
      }
      const publish = () => {
        for (const callback of publications) {
          inCaller(() => (runHostStep ? runHostStep(callback) : callback()));
        }
      };
      // Message delivery records its native result before a fallible observer.
      // Other callers retain the same direct, fail-fast publication boundary.
      if (retainPublication) {
        retainPublication(publish);
      } else {
        publish();
      }
    },
    service,
    /** Called after the private wait returns, never from its admission/frame callbacks. */
    drive(wait: HostWait) {
      if (!entered || driving || closed) {
        throw new Error("SQLite host scope has no live caller handoff");
      }
      const current = entered;
      entered = undefined;
      driving = true;
      const began = process.hrtime.bigint();
      const nativeWaitBefore = transaction.nativeWaitNs.value;
      let result: boolean | undefined;
      let abort = false;
      let privateWait = false;
      let terminal: SqliteWorkerJobTerminal | undefined;
      const interrupted = Symbol("SQLite original job completed during caller handoff");
      const assertLive = () => {
        if (terminal) {
          throw terminal.result.ok ? interrupted : terminal.result.error;
        }
      };
      const call = (
        action:
          | SqliteWorkerScopeAction
          | { kind: "execute"; targetActor: number; value: Uint8Array },
        child?: (typeof children)[number],
      ) => {
        assertLive();
        if (!driving || closed || privateWait) {
          throw new Error("SQLite snapshot cursor has left its caller scope");
        }
        const sequence = ++nextSequence;
        const started = process.hrtime.bigint();
        let receivedReply = false;
        const previousDeadline = requestDeadlineNs;
        requestDeadlineNs = started + SQLITE_WORKER_PROTOCOL_WAIT_NS;
        try {
          transfer.post(
            { kind: "call", id: current.id, sequence, action },
            child ? [child.retained.admission.port] : [],
          );
          // Reply is set by receive callbacks serviced by the synchronous native pump.
          // oxlint-disable-next-line eslint/no-unmodified-loop-condition
          while (!reply) {
            privateWait = true;
            const waitStarted = process.hrtime.bigint();
            try {
              terminal = wait(
                () => reply !== undefined || child?.retained.admission.scope?.pending === true,
              );
            } finally {
              transaction.nativeWaitNs.value += process.hrtime.bigint() - waitStarted;
              privateWait = false;
            }
            assertLive();
            const childScope = child?.retained.admission.scope;
            if (!reply && childScope?.pending) {
              const before = childScope.pausedNs;
              drivingChild = childScope;
              try {
                childScope.drive(wait);
              } finally {
                drivingChild = undefined;
                requestDeadlineNs += childScope.pausedNs - before;
              }
            }
          }
          if (reply.sequence !== sequence) {
            throw new Error("SQLite snapshot reply differs from its request");
          }
          const received = reply;
          reply = undefined;
          receivedReply = true;
          return readWireResult(received.result, child?.retained.admission.scope);
        } catch (error) {
          if (terminal) {
            throw error;
          }
          if (!receivedReply) {
            throw failProtocol(error);
          }
          throw error;
        } finally {
          requestDeadlineNs = previousDeadline;
        }
      };
      const driver: SqliteWorkerHostDriver | undefined = binding && {
        actor: binding.actor,
        viewOwner,
        transaction,
        active: true,
        assertLive,
        callerActive: () => !terminal && !privateWait && driving && !closed,
        publishAfterSettlement(publish) {
          transaction.publications.push(() => {
            if (committed) {
              publish();
            }
          });
        },
        stageRollback(rollback) {
          transaction.rollbacks.push({ scope: rollbackScope, rollback });
        },
        execute(actor, payload, operation, assertRequest) {
          assertLive();
          if (privateAdoptionFailure) {
            throw privateAdoptionFailure.error;
          }
          if (privateWait || !operation.active || !operation.createAdmission) {
            throw new Error("Nested SQLite execution has no original caller admission");
          }
          const settled = createDeferredCore<SqliteWorkerOperationSettlement>();
          const independent = actor !== binding!.actor;
          const selectedTransaction = independent
            ? createSqliteWorkerHostTransaction(transaction.nativeWaitNs)
            : transaction;
          const retained = operation.createAdmission({
            settled: settled.promise,
            transaction: selectedTransaction,
          });
          const child: (typeof children)[number] = { retained, settled };
          children.push(child);
          operation.pending.add(settled.promise);
          void settled.promise.then(() => operation.pending.delete(settled.promise));
          const failures: unknown[] = [];
          try {
            if (retained.nativeLocations.some((path) => !binding!.nativeLocations.includes(path))) {
              throw new Error("Nested SQLite execution cannot borrow another lifecycle owner");
            }
            const assertCurrent = () => {
              assertLive();
              if (
                !operation.active ||
                !actor.slot.actors.has(actor) ||
                actor.slot.failed ||
                actor.slot.retiring ||
                actor.slot.retirementReason ||
                actor.protocolFailure
              ) {
                throw new SqliteWorkerError(
                  "Nested SQLite admission lost its original owner",
                  "closed",
                );
              }
            };
            bindSqliteWorkerDatabaseAuthority(
              retained.admission,
              actor.stateDatabasePath ?? actor.databasePath,
              operation.maintenanceScope,
              () => {
                assertCurrent();
                assertRequest();
              },
              assertCurrent,
            );
            retained.admission.scope?.bind(actor, retained.nativeLocations, {
              transaction: selectedTransaction,
              ...(!independent ? { rollbackScope } : {}),
            });
          } catch (error) {
            child.result = { ok: false, error };
            failures.push(error);
            try {
              settleChild(child, { kind: "not-entered", error }, false);
            } catch (cleanupError) {
              failures.push(cleanupError);
            } finally {
              if (child.closed) {
                children.splice(children.indexOf(child), 1);
              }
            }
            if (failures.length === 1) {
              throw error;
            }
            throw new AggregateError(failures, "Nested SQLite admission and cleanup failed", {
              cause: error,
            });
          }
          try {
            const value = call({ kind: "execute", targetActor: actor.id, value: payload }, child);
            child.result = { ok: true, value };
          } catch (error) {
            if (terminal) {
              throw error;
            }
            child.result = { ok: false, error };
            failures.push(error);
          }
          try {
            retained.admission.service();
            // A domain may handle its refusal; lost request/database authority cannot
            // be converted into success by a native domain result.
            if (
              retained.admission.failureSource !== "domain" &&
              retained.admission.failure !== undefined
            ) {
              const error = retained.admission.failure;
              if (child.result.ok || child.result.error !== error) {
                failures.push(error);
              }
              child.result = { ok: false, error };
            }
            if (child.result.ok && retained.admission.tentative) {
              try {
                retained.stage?.(child.result.value);
              } catch (error) {
                // The native child savepoint has already released. Only the original
                // outer rollback can undo partially adopted private state now.
                privateAdoptionFailure ??= { error };
                throw error;
              }
            } else if (retained.admission.settlement?.kind === "completed") {
              settleChild(child, { kind: "completed" }, retained.admission.committed !== undefined);
            }
          } catch (error) {
            failures.push(error);
          } finally {
            if (child.closed) {
              children.splice(children.indexOf(child), 1);
            }
          }
          if (independent && child.closed && retained.admission.settlement?.kind === "completed") {
            try {
              // This is the original direct caller, after B's private settlement.
              // A later durable rollback cannot suppress B's committed observers.
              retained.admission.scope?.publish();
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length === 1) {
            throw failures[0];
          }
          if (failures.length) {
            throw new AggregateError(failures, "Nested SQLite execution and cleanup failed", {
              cause: failures[0],
            });
          }
          return {
            value: child.result.ok ? child.result.value : undefined,
            pending: settled.promise,
          };
        },
      };
      try {
        result = runSqliteWorkerHostContext(inCaller, runHostStep, driver, () =>
          run(current.step, { call }),
        );
        assertSyncTransactionResult(result);
      } catch (error) {
        if (!terminal && failure === undefined) {
          hostFailure ??= {
            error:
              privateAdoptionFailure && privateAdoptionFailure.error !== error
                ? new AggregateError(
                    [privateAdoptionFailure.error, error],
                    "SQLite caller and tentative adoption failed",
                    { cause: privateAdoptionFailure.error },
                  )
                : error,
          };
        }
        abort = true;
      } finally {
        driving = false;
        if (driver) {
          driver.active = false;
        }
        pausedNs +=
          process.hrtime.bigint() - began - (transaction.nativeWaitNs.value - nativeWaitBefore);
      }
      // The original Job owns this outcome. A terminal unwind is neither a new
      // host failure nor permission to post finish to an already-settled scope.
      if (terminal) {
        return;
      }
      if (privateAdoptionFailure) {
        hostFailure ??= privateAdoptionFailure;
        abort = true;
      }
      if (current.step.kind === "session-context") {
        requestDeadlineNs = process.hrtime.bigint() + SQLITE_WORKER_PROTOCOL_WAIT_NS;
      }
      // No event-loop yield between the public predicate and its native continuation.
      try {
        transfer.post({
          kind: "finish",
          id: current.id,
          abort: abort || failure !== undefined,
          value: result,
        });
      } catch (error) {
        failProtocol(error);
      }
      if (failure !== undefined) {
        throw failure;
      }
    },
    async driveAsync(wait: HostWait) {
      // Receive/failure/close callbacks change these flags and resolve the current wake.
      // oxlint-disable-next-line eslint/no-unmodified-loop-condition
      while (!closed && failure === undefined) {
        // Admission, failure and close own the flags; idle wake has no fixed deadline.
        // oxlint-disable-next-line eslint/no-unmodified-loop-condition
        while (!entered && !closed && failure === undefined) {
          await wake.promise;
          wake = createDeferredCore();
        }
        if (closed) {
          owner.publish();
          return;
        }
        service();
        owner.drive(wait);
      }
      if (closed) {
        owner.publish();
      }
      if (failure !== undefined) {
        throw failure;
      }
    },
    fail(error: unknown) {
      failProtocol(error);
    },
    close: () => {
      closed = true;
      wake.resolve();
      transfer.close();
      port2.close();
    },
  };
  return owner;
}
export type SqliteWorkerHostScope = ReturnType<typeof createSqliteWorkerHostScope>;

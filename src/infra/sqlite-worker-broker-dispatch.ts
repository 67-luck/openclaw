import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferredCore } from "../shared/deferred.js";
import { runWithStoreWriterNativeWait } from "../shared/store-writer-queue.js";
import { retainSqliteWriteAdmissionService } from "./sqlite-transaction.js";
import {
  borrowSqliteWorkerLifecycle,
  prepareSqliteWorkerLifecycle,
  releaseSqliteWorkerLifecycle,
} from "./sqlite-worker-broker-admission.js";
import type { Actor, Job, Slot } from "./sqlite-worker-broker.types.js";
import {
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
  SqliteWorkerError,
  withSqliteWorkerCleanupFailure,
  type SqliteWorkerReply,
  type SqliteWorkerRequest,
} from "./sqlite-worker-contract.js";
import { createSqliteWorkerLifecyclePreparation } from "./sqlite-worker-lifecycle-preparation.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";
import { createSqliteWorkerHostTransaction } from "./sqlite-worker-scoped-operation.js";
import { createSqliteWorkerTransferOwner } from "./sqlite-worker-transfer.js";
import { resolveStateDatabaseCoordinatorPath } from "./state-database-coordinator.js";

export function dispatchSqliteWorkerJob(
  slot: Slot,
  job: Job,
  onRejected: (error: unknown, retire: boolean) => void,
): void {
  const reject = (error: unknown, preparedNotEntered = false) => {
    let failure = error;
    let retire = job.preparation
      ? job.nativeDispatched === true || (job.requestPosted === true && !preparedNotEntered)
      : Boolean(
          job.request.gatewaySchemaFence ||
          job.request.maintenanceSchemaFence ||
          job.request.stateLifecycle ||
          job.request.operationAdmission,
        );
    if (
      job.preparation &&
      !job.nativeDispatched &&
      (!job.requestPosted || preparedNotEntered) &&
      slot.current === job
    ) {
      try {
        // No port reached native code. Release prepared custody before a follower can dispatch.
        releaseSqliteWorkerLifecycle(job);
      } catch (cleanupError) {
        // A revoked, unposted actor fence cannot serve another job until cleanup finishes.
        failure = withSqliteWorkerCleanupFailure(
          toErrorObject(error, "SQLite worker preparation failed"),
          cleanupError,
        );
        retire = true;
      }
    }
    onRejected(failure, retire);
  };
  job.rejectPreparation = (error) => reject(error, true);
  const actor = [...slot.actors].find((candidate) => candidate.id === job.request.actor);
  // Host grants must remain serviceable while a native caller waits on lifecycle custody.
  job.requireStateLifecycle ||=
    (job.request.stateContext ?? actor?.stateContext) !== undefined &&
    (job.request.type === "close" ||
      (job.request.type === "execute" && job.createAdmission !== undefined));
  if (job.requireStateLifecycle) {
    job.cancelPreparation = new AbortController();
  }
  const assertDispatchable = () => {
    job.assertCurrent?.();
    job.cancelPreparation?.signal.throwIfAborted();
    if (slot.failed || slot.retiring || slot.retirementReason || slot.current !== job) {
      throw (
        slot.failed ??
        slot.retirementReason ??
        new SqliteWorkerError("SQLite worker job is no longer current", "closed")
      );
    }
  };
  try {
    assertDispatchable();
    let attempted = false;
    const dispatch = () => {
      if (slot.retiring || slot.retirementReason) {
        return;
      }
      if (attempted) {
        return;
      }
      attempted = true;
      job.dispatchPrepared = undefined;
      try {
        assertDispatchable();
        postSqliteWorkerJob(slot, job, assertDispatchable, actor);
      } catch (error) {
        reject(error);
      }
    };
    prepareSqliteWorkerLifecycle(job, actor, assertDispatchable);
    if (job.requireStateLifecycle && !job.request.workerStateLifecycle) {
      // Async delivery and the private ready pump share this one dispatch transition.
      job.dispatchPrepared = dispatch;
      job.preparation = Promise.resolve();
      void job.preparation.then(dispatch, reject);
    } else {
      dispatch();
    }
  } catch (error) {
    reject(error);
  }
}

function postSqliteWorkerJob(
  slot: Slot,
  job: Job,
  assertDispatchable: () => void,
  actor: Actor | undefined,
): void {
  const dispatched = () => {
    job.nativeDispatched = true;
    if (job.request.workerStateLifecycle) {
      job.preparedAtNs ??= process.hrtime.bigint();
    }
    job.detach();
    if (job.dispatchState) {
      job.dispatchState.dispatched = true;
    }
  };
  if (job.request.workerStateLifecycle) {
    const context = job.request.stateContext;
    if (!actor || !context || !job.cancelPreparation) {
      throw new Error("Worker lifecycle preparation requires its captured owner");
    }
    const preparation = createSqliteWorkerLifecyclePreparation({
      assertCurrent: assertDispatchable,
      signal: job.cancelPreparation.signal,
      borrow: () => borrowSqliteWorkerLifecycle(job, actor),
      admit: () => prepareSqliteWorkerOperationAdmission(job, actor, slot),
      dispatch: dispatched,
      receiveResult(reply, pumping) {
        if (!isRecord(reply) || typeof reply.id !== "number" || typeof reply.ok !== "boolean") {
          throw new Error("SQLite lifecycle reply is invalid");
        }
        // SAFETY: This private port carries the same trusted worker reply as its message event.
        slot.receiveReply(reply as SqliteWorkerReply, pumping);
      },
    });
    const releaseService = retainSqliteWriteAdmissionService(
      [
        resolveStateDatabaseCoordinatorPath({
          databasePath: job.request.stateDatabasePath ?? actor.databasePath,
          runtimeDirectory: context.coordinatorRuntime.directory,
          uid: typeof process.getuid === "function" ? process.getuid() : undefined,
        }),
      ],
      () => {
        preparation.service();
        job.operationAdmission?.admission.service();
      },
    );
    job.lifecyclePreparation = {
      service: preparation.service,
      get failure() {
        return preparation.failure;
      },
      finish() {
        const failures: unknown[] = [];
        try {
          releaseService();
        } catch (error) {
          failures.push(error);
        }
        try {
          preparation.finish();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length) {
          throw new AggregateError(failures, "SQLite lifecycle preparation cleanup failed", {
            cause: failures[0],
          });
        }
      },
    };
    job.preparation = preparation.prepared;
    job.request.lifecyclePreparation = preparation.port;
  } else {
    job.request.operationAdmission = prepareSqliteWorkerOperationAdmission(job, actor, slot);
  }
  const request = prepareSqliteWorkerRequest(job);
  assertDispatchable();
  // A throwing transfer may still have reached the worker; failure joins its exit.
  if (!job.request.workerStateLifecycle) {
    dispatched();
  }
  job.requestPosted = true;
  (slot.transport?.post ?? slot.worker.postMessage.bind(slot.worker))(
    request,
    [
      request.gatewaySchemaFence,
      request.maintenanceSchemaFence,
      request.stateLifecycle,
      request.operationAdmission,
      request.lifecyclePreparation,
      ...(request.type === "open" ? [request.backendService] : []),
    ].filter((port) => port !== undefined),
  );
}

function prepareSqliteWorkerOperationAdmission(job: Job, actor: Actor | undefined, slot: Slot) {
  if (job.createAdmission) {
    const settlement = createDeferredCore<SqliteWorkerOperationSettlement>();
    job.settleNative = settlement.resolve;
    const transaction = createSqliteWorkerHostTransaction();
    const retained = job.createAdmission({ settled: settlement.promise, transaction });
    job.operationAdmission = {
      admission: retained.admission,
      settle: retained.settle,
      // SQLite reports canonical paths; retain the physical owner's already-admitted
      // aliases so a native writer can service this grant without filesystem discovery.
      releaseService: retainSqliteWriteAdmissionService(
        [...retained.nativeLocations, ...(actor?.pathReferences.keys() ?? [])],
        () => retained.admission.service(),
      ),
    };
    const scope = retained.admission.scope;
    if (scope && actor) {
      scope.bind(actor, retained.nativeLocations, { transaction });
    }
    if (scope && !job.ready) {
      const waiting = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      // The async caller resumes on its normal host continuation. Private frame and
      // admission callbacks only wake that driver; they never invoke its predicates.
      job.scopeDriver = scope.driveAsync((complete) =>
        runWithStoreWriterNativeWait(() => {
          const watch = slot.transport?.watch(job.request.id);
          const check = () => {
            if (job.terminal) {
              return;
            }
            if (slot.failed || slot.current !== job) {
              throw new SqliteWorkerError(
                "SQLite scoped operation lost its native owner",
                "outcome-unknown",
              );
            }
            const deadline = scope.requestDeadlineNs;
            if (deadline !== undefined && process.hrtime.bigint() >= deadline) {
              throw new SqliteWorkerError(
                "SQLite scoped request settlement is unknown",
                "outcome-unknown",
              );
            }
            watch?.check();
          };
          try {
            while (!job.terminal && !complete()) {
              check();
              job.lifecyclePreparation?.service(check);
              if (job.terminal) {
                break;
              }
              retained.admission.service(check);
              if (job.terminal) {
                break;
              }
              scope.service(check);
              if (job.terminal) {
                break;
              }
              check();
              if (!complete()) {
                const pumped = slot.transport?.pump();
                if (job.terminal) {
                  break;
                }
                if (!pumped) {
                  Atomics.wait(waiting, 0, 0, 5);
                }
              }
            }
            return job.terminal;
          } finally {
            watch?.finish();
          }
        }),
      );
      void job.scopeDriver.catch((error: unknown) => {
        // The ordinary retirement owner joins native failure and retains original claims.
        if (slot.current === job) {
          job.rejectPreparation?.(error);
        }
      });
    }
    return retained.admission.port;
  }
  return undefined;
}

function prepareSqliteWorkerRequest(job: Job): SqliteWorkerRequest {
  if (
    job.request.type !== "execute" ||
    job.request.input.byteLength <= SQLITE_WORKER_MAX_MESSAGE_BYTES
  ) {
    return job.request;
  }
  const { input, ...request } = job.request;
  const producer = createSqliteWorkerTransferOwner();
  const transfer = producer.start([{ kind: "command", serialized: input }].values(), {
    kinds: ["command"],
  });
  job.inputTransfer = { id: transfer.id, producer };
  job.request.input = new Uint8Array();
  return { ...request, type: "execute-start", transfer };
}

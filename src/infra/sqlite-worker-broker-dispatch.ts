import { createDeferredCore } from "../shared/deferred.js";
import { runWithStoreWriterNativeWait } from "../shared/store-writer-queue.js";
import { retainSqliteWriteAdmissionService } from "./sqlite-transaction.js";
import {
  bindSqliteWorkerDatabaseAuthority,
  prepareSqliteWorkerActorContext,
} from "./sqlite-worker-broker-admission.js";
import type { Actor, Job, Slot } from "./sqlite-worker-broker.types.js";
import {
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
  SqliteWorkerError,
  type SqliteWorkerRequest,
} from "./sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionFactory,
} from "./sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";
import { createSqliteWorkerHostTransaction } from "./sqlite-worker-scoped-operation.js";
import { createSqliteWorkerTransferOwner } from "./sqlite-worker-transfer.js";

export function dispatchSqliteWorkerJob(
  slot: Slot,
  job: Job,
  onRejected: (error: unknown, retire: boolean) => void,
): void {
  const actor = [...slot.actors].find((candidate) => candidate.id === job.request.actor);
  const assertCurrentJob = () => {
    if (slot.failed || slot.retiring || slot.retirementReason || slot.current !== job) {
      throw (
        slot.failed ??
        slot.retirementReason ??
        new SqliteWorkerError("SQLite worker job is no longer current", "closed")
      );
    }
  };
  const assertDispatchable = () => {
    if (!job.nativeDispatched) {
      job.signal?.throwIfAborted();
    }
    job.assertCurrent?.();
    assertCurrentJob();
  };
  try {
    assertDispatchable();
    prepareSqliteWorkerActorContext(actor, job);
    job.request.operationAdmission = prepareSqliteWorkerOperationAdmission(
      job,
      actor,
      slot,
      assertDispatchable,
      assertCurrentJob,
      onRejected,
    );
    const request = prepareSqliteWorkerRequest(job);
    assertDispatchable();
    job.nativeDispatched = true;
    job.detach();
    if (job.dispatchState) {
      job.dispatchState.dispatched = true;
    }
    // A throwing transfer may still have reached native code; retirement must join it.
    job.requestPosted = true;
    (slot.transport?.post ?? slot.worker.postMessage.bind(slot.worker))(
      request,
      [
        request.operationAdmission,
        ...(request.type === "open" ? [request.backendService] : []),
      ].filter((port) => port !== undefined),
    );
  } catch (error) {
    onRejected(error, job.requestPosted === true);
  }
}

function prepareSqliteWorkerOperationAdmission(
  job: Job,
  actor: Actor | undefined,
  slot: Slot,
  assertDispatchable: () => void,
  assertCurrentJob: () => void,
  onRejected: (error: unknown, retire: boolean) => void,
) {
  const databasePath = job.request.stateDatabasePath ?? actor?.databasePath;
  if (!job.createAdmission && !databasePath) {
    return undefined;
  }
  const settlement = createDeferredCore<SqliteWorkerOperationSettlement>();
  job.settleNative = settlement.resolve;
  const transaction = createSqliteWorkerHostTransaction();
  const retained: ReturnType<SqliteWorkerAdmissionFactory> = job.createAdmission
    ? job.createAdmission({ settled: settlement.promise, transaction })
    : {
        admission: createSqliteWorkerOperationAdmission(() => {
          throw new SqliteWorkerError(
            "SQLite domain operation requires its own admission",
            "closed",
          );
        }),
        nativeLocations: databasePath ? [databasePath] : [],
      };
  // Keep cleanup attached to the original job even when authority binding fails.
  job.operationAdmission = {
    admission: retained.admission,
    settle: retained.settle,
    releaseService: retainSqliteWriteAdmissionService(
      [
        ...retained.nativeLocations,
        ...(databasePath ? [databasePath] : []),
        ...(actor?.pathReferences.keys() ?? []),
      ],
      () => retained.admission.service(),
    ),
  };
  if (databasePath) {
    bindSqliteWorkerDatabaseAuthority(
      retained.admission,
      databasePath,
      job.maintenanceScope,
      assertDispatchable,
      assertCurrentJob,
    );
  }
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
        onRejected(error, job.requestPosted === true);
      }
    });
  }
  return retained.admission.port;
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

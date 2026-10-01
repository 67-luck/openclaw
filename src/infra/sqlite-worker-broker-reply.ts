import { deserialize, serialize } from "node:v8";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import {
  retainOpenClawStateWorkerErrorPayload,
  hydrateOpenClawStateWorkerError,
  type OpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import type { Job, Slot } from "./sqlite-worker-broker.types.js";
import {
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
  retainSqliteWorkerErrorCode,
  SqliteWorkerError,
  withSqliteWorkerCleanupFailure,
  type SqliteWorkerReply,
  type SqliteWorkerCloseReceipt,
  type SqliteWorkerRequest,
} from "./sqlite-worker-contract.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";
import {
  createSqliteWorkerTransferReceiver,
  type SqliteWorkerTransferFrame,
  type SqliteWorkerTransferHandle,
} from "./sqlite-worker-transfer.js";

function decodeSqliteWorkerReplyValue(
  job: Job,
  reply: Extract<SqliteWorkerReply, { ok: true }>,
):
  | { type: "complete"; value: unknown }
  | {
      type: "continue";
      request: Extract<SqliteWorkerRequest, { type: "result-next" | "execute-frame" }>;
    } {
  if (reply.input === "next") {
    const transfer = job.inputTransfer;
    if (!transfer || reply.transfer) {
      throw new Error("SQLite worker requested unexpected command input");
    }
    const frame = transfer.producer.next(transfer.id);
    const input = serialize(frame);
    if (input.byteLength > SQLITE_WORKER_MAX_MESSAGE_BYTES) {
      throw new Error("SQLite worker input frame exceeds the transport byte limit");
    }
    if (frame.done) {
      transfer.producer.end(transfer.id);
      job.inputTransfer = undefined;
    }
    return {
      type: "continue",
      request: { type: "execute-frame", id: job.request.id, actor: job.request.actor, input },
    };
  }
  if (job.inputTransfer) {
    throw new Error("SQLite worker completed before receiving its command input");
  }
  let value: unknown;
  if (reply.transfer === "start") {
    // SAFETY: The matching worker emits this private handle; framing validates its records.
    const handle = deserialize(reply.value) as SqliteWorkerTransferHandle;
    if (
      job.request.type !== "execute" ||
      job.transfer ||
      handle.kinds.length !== 1 ||
      handle.kinds[0] !== "result"
    ) {
      throw new Error("SQLite worker returned an unexpected result transfer");
    }
    const transfer: NonNullable<Job["transfer"]> = {
      id: handle.id,
      value: undefined,
      receiver: createSqliteWorkerTransferReceiver(handle, (record) => {
        transfer.value = record.value;
      }),
    };
    job.transfer = transfer;
  } else if (reply.transfer === "frame") {
    const transfer = job.transfer;
    if (!transfer) {
      throw new Error("SQLite worker returned an unexpected result frame");
    }
    // SAFETY: The matching worker emits frames; the shared receiver validates their sequence and bounds.
    const frame = deserialize(reply.value) as SqliteWorkerTransferFrame;
    const counts = transfer.receiver.accept(frame);
    if (counts) {
      if (counts.length !== 1 || counts[0]?.[1] !== 1) {
        throw new Error("SQLite worker returned an incomplete result transfer");
      }
      value = transfer.value;
      job.transfer = undefined;
    }
  } else {
    if (job.transfer) {
      throw new Error("SQLite worker ended its result transfer without completion");
    }
    value = deserialize(reply.value);
  }
  return job.transfer
    ? {
        type: "continue",
        request: {
          type: "result-next",
          id: job.request.id,
          actor: job.request.actor,
          transferId: job.transfer.id,
        },
      }
    : { type: "complete", value };
}

function decodeSqliteWorkerReplyError(
  job: Job,
  error: Extract<SqliteWorkerReply, { ok: false }>["error"],
): Error {
  const failure = Object.assign(new Error(error.message), {
    name: error.name,
    ...(error.code === undefined ? {} : { code: error.code }),
  });
  if (job.request.stateContext && error.code !== "outcome-unknown" && error.sharedState) {
    retainOpenClawStateWorkerErrorPayload(failure, error.sharedState);
  }
  if (error.hostFailure) {
    job.operationAdmission?.admission.scope?.retainNativeHostFailure(
      failure,
      error.hostFailure.only,
    );
  }
  return failure;
}

function decodeSqliteWorkerCleanupError(payload: OpenClawStateWorkerErrorPayload): Error {
  const failure = new Error("SQLite worker native cleanup failed");
  retainOpenClawStateWorkerErrorPayload(failure, payload);
  return hydrateOpenClawStateWorkerError(failure, { includeOrdinary: true });
}

export type CompletedSqliteWorkerOutcome = { value: unknown } | { error: unknown };

export type SqliteWorkerReplyOwner = {
  fail(
    reason: unknown,
    currentError?: Error,
    openOutcome?: "refused-before-agent-open",
    completed?: CompletedSqliteWorkerOutcome,
  ): void;
  finish(
    job: Job,
    error?: unknown,
    value?: unknown,
    settlement?: SqliteWorkerOperationSettlement,
    closeReceipt?: SqliteWorkerCloseReceipt,
  ): void;
  dispatch(): void;
};

export function receiveSqliteWorkerReply(
  slot: Pick<Slot, "current" | "failed" | "transport"> & {
    worker: Pick<Slot["worker"], "postMessage">;
  },
  reply: SqliteWorkerReply,
  owner: SqliteWorkerReplyOwner,
  pumping = false,
): void {
  const job = slot.current;
  if (!job || reply.id !== job.request.id) {
    owner.fail(new Error("SQLite worker returned an unexpected response"));
    return;
  }
  const settle = (operation: () => void) => {
    if (pumping && !job.readyReply) {
      queueMicrotask(() => {
        if (slot.current === job && !slot.failed) {
          operation();
        }
      });
    } else {
      operation();
    }
  };
  if (!reply.ok) {
    if (reply.cleanupFailure && job.nativeDispatched && !reply.retire) {
      const admission = job.operationAdmission?.admission;
      const failure =
        admission?.failureSource === "domain" && !reply.admissionRefused
          ? undefined
          : admission?.failure;
      const original = failure ?? decodeSqliteWorkerReplyError(job, reply.error);
      owner.fail(decodeSqliteWorkerCleanupError(reply.cleanupFailure), undefined, undefined, {
        error: original,
      });
      return;
    }
    if (reply.openNotEntered && job.request.type === "open" && job.dispatchState) {
      job.dispatchState.openNotEntered = true;
    }
    const error = decodeSqliteWorkerReplyError(job, reply.error);
    if (job.request.type === "open" && reply.openNotEntered && !reply.retire) {
      settle(() => {
        slot.current = undefined;
        const refusal = job.operationAdmission?.admission.failure ?? error;
        owner.finish(job, refusal, undefined, { kind: "not-entered", error: refusal });
        owner.dispatch();
      });
      return;
    }
    if (job.request.type !== "execute" || reply.retire) {
      const refusedOpen =
        job.request.type === "open" && reply.openOutcome === "refused-before-agent-open";
      const failure =
        refusedOpen || (job.request.type === "open" && reply.admissionRefused)
          ? toErrorObject(job.operationAdmission?.admission.failure ?? error, error.message)
          : error;
      owner.fail(
        failure,
        job.request.type !== "execute" ? failure : undefined,
        refusedOpen ? "refused-before-agent-open" : undefined,
      );
      return;
    }
    settle(() => {
      slot.current = undefined;
      owner.finish(job, job.operationAdmission?.admission.failure ?? error);
      owner.dispatch();
    });
    return;
  }
  let value: unknown;
  try {
    const result = decodeSqliteWorkerReplyValue(job, reply);
    if (result.type === "continue") {
      // Continuations retain the current job and its reserved transport credits through drain.
      (slot.transport?.post ?? slot.worker.postMessage.bind(slot.worker))(result.request, []);
      return;
    }
    value = result.value;
  } catch (error) {
    owner.fail(error);
    return;
  }
  if (reply.cleanupFailure) {
    const admission = job.operationAdmission?.admission;
    const failure = admission?.failureSource === "domain" ? undefined : admission?.failure;
    owner.fail(
      decodeSqliteWorkerCleanupError(reply.cleanupFailure),
      undefined,
      undefined,
      failure === undefined ? { value } : { error: failure },
    );
    return;
  }
  settle(() => {
    slot.current = undefined;
    if (job.request.type === "close") {
      owner.finish(job, undefined, value, undefined, reply.closeReceipt);
    } else {
      // Domains own handled refusal results; physical and request authority still fence delivery.
      const admission = job.operationAdmission?.admission;
      owner.finish(
        job,
        admission?.failureSource === "domain" ? undefined : admission?.failure,
        value,
      );
    }
    owner.dispatch();
  });
}

export function settleFailedSqliteWorkerJobs({
  queuedError,
  current,
  queued,
  error,
  currentError,
  completed,
  openOutcome,
  retire,
  finish,
}: {
  queuedError: Error;
  current: Job | undefined;
  queued: Job[];
  error: Error;
  currentError?: Error;
  completed?: CompletedSqliteWorkerOutcome;
  openOutcome?: "refused-before-agent-open";
  retire: () => Promise<void>;
  finish: typeof settleSqliteWorkerJob;
}): void {
  const retirement = retire();
  // Join native exit before releasing any operation that might have touched SQLite.
  const finishFailed = (retired: boolean, cleanupError?: unknown) => {
    if (current && completed) {
      process.emitWarning(
        new Error("SQLite worker operation completed before native cleanup failed", {
          cause: withSqliteWorkerCleanupFailure(error, cleanupError),
        }),
      );
      finish(
        current,
        "error" in completed ? completed.error : undefined,
        "value" in completed ? completed.value : undefined,
        retired ? { kind: "completed" } : { kind: "unknown", error: cleanupError ?? error },
      );
    } else if (current) {
      const failure =
        currentError ??
        new SqliteWorkerError(
          `SQLite worker stopped before its result was received: ${error.message}`,
          current.request.type === "execute" && current.nativeDispatched
            ? "outcome-unknown"
            : "unavailable",
        );
      if (!currentError) {
        failure.cause = error;
      }
      finish(
        current,
        withSqliteWorkerCleanupFailure(failure, cleanupError),
        undefined,
        current.nativeDispatched
          ? retired && openOutcome === "refused-before-agent-open"
            ? { kind: "completed" }
            : { kind: "unknown", error: currentError ?? error }
          : { kind: "not-entered", error },
      );
    }
    for (const job of queued) {
      finish(job, withSqliteWorkerCleanupFailure(queuedError, cleanupError));
    }
  };
  void retirement.then(
    () => finishFailed(!current?.operationAdmission?.admission.cleanupFailures.length),
    (cleanupError: unknown) => finishFailed(false, cleanupError),
  );
}

export function settleSqliteWorkerJob(
  job: Job,
  error?: unknown,
  value?: unknown,
  settlement?: SqliteWorkerOperationSettlement,
): void {
  const nativeSettlement =
    settlement ??
    (job.nativeDispatched
      ? { kind: "completed" as const }
      : { kind: "not-entered" as const, error });
  let failure = error;
  let failed = error !== undefined;
  const retainCleanupFailure = (cleanupError: unknown) => {
    failure = failed
      ? retainSqliteWorkerErrorCode(
          new AggregateError([failure, cleanupError], "SQLite worker failure and cleanup failed", {
            cause: failure,
          }),
          failure,
        )
      : cleanupError;
    failed = true;
  };
  const admission = job.operationAdmission?.admission;
  if (admission?.scope) {
    let committed: boolean | undefined;
    try {
      committed = admission.committed !== undefined;
    } catch (cleanupError) {
      retainCleanupFailure(cleanupError);
    }
    try {
      admission.scope.settleChildren(nativeSettlement, committed);
    } catch (cleanupError) {
      retainCleanupFailure(cleanupError);
    }
  }
  // Cleanup failures never skip another original owner or its completion signal.
  try {
    admission?.finish();
  } catch (cleanupError) {
    retainCleanupFailure(cleanupError);
  }
  try {
    job.operationAdmission?.releaseService();
  } catch (cleanupError) {
    retainCleanupFailure(cleanupError);
  }
  const admissionCleanupFailures = job.operationAdmission?.admission.cleanupFailures ?? [];
  if (admissionCleanupFailures.length > 0) {
    const cleanupError = new AggregateError(
      admissionCleanupFailures,
      "SQLite worker admission cleanup failed",
    );
    if (!failed && job.request.type === "execute") {
      process.emitWarning(cleanupError);
    } else {
      retainCleanupFailure(cleanupError);
    }
  }
  try {
    job.inputTransfer?.producer.cancel();
  } catch (cleanupError) {
    retainCleanupFailure(cleanupError);
  }
  job.inputTransfer = undefined;
  job.transfer = undefined;
  try {
    job.detach();
  } catch (cleanupError) {
    retainCleanupFailure(cleanupError);
  }
  try {
    // Promise delivery is observation only. A ready follower may dispatch in this same turn.
    job.operationAdmission?.settle?.({
      settlement: nativeSettlement,
      result: failed ? { ok: false, error: failure } : { ok: true, value },
    });
  } catch (cleanupError) {
    retainCleanupFailure(cleanupError);
  }
  job.settleNative?.(nativeSettlement);
  // All private cleanup contributes before either waiter observes this one outcome.
  const terminal = (job.terminal = {
    settlement: nativeSettlement,
    result: failed ? { ok: false as const, error: failure } : { ok: true as const, value },
  });
  const deliver = () =>
    terminal.result.ok ? job.resolve(terminal.result.value) : job.reject(terminal.result.error);
  if (job.scopeDriver) {
    // Private settlement has already unblocked native followers. Public delivery
    // still joins the original host driver and cannot lose a fallible observer.
    void job.scopeDriver.then(deliver, (scopeError: unknown) => {
      retainCleanupFailure(scopeError);
      terminal.result = { ok: false, error: failure };
      deliver();
    });
  } else {
    deliver();
  }
}

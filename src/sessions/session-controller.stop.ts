import {
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError,
} from "../agents/run-termination.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import type { ReplyOperation } from "./session-controller.contracts.js";
import type { SessionTarget } from "./session-controller.lifecycle.js";
import {
  abortSessionControllerInput,
  captureSessionControllerSourceSettlement,
  type SessionControllerInput,
} from "./session-controller.mailbox.js";
import {
  findSessionControllerEntries,
  isReplyOperationAbortable,
  isCurrentSessionControllerOperation,
  sessionControllers,
} from "./session-controller.state.js";

export type SessionControllerStopCapture = Readonly<{
  inputs: readonly SessionControllerInput[];
  queuedInputs: readonly SessionControllerInput[];
  activeInputs: readonly SessionControllerInput[];
  operations: readonly ReplyOperation[];
  /** Actual captured producer/adoption completion, never a signal or timeout proxy. */
  settled: Promise<void>;
}>;

/** The scope adapter resolves/authorizes targets; this owner captures instances before it yields. */
export function captureSessionControllerStop(params: {
  inputs?: Iterable<SessionControllerInput>;
  operations?: Iterable<ReplyOperation | undefined>;
  targets?: Iterable<SessionTarget>;
  includeQueued?: boolean;
  includeActive?: boolean;
}): SessionControllerStopCapture {
  const inputs = new Set(params.inputs);
  const operations = new Set(
    [...(params.operations ?? [])].filter((operation): operation is ReplyOperation =>
      Boolean(operation),
    ),
  );
  for (const target of params.targets ?? []) {
    for (const owner of findSessionControllerEntries(target.sessionKey, target)) {
      if (params.includeActive !== false && owner.active) {
        operations.add(owner.active);
      }
      for (const input of owner.mailbox?.entries ?? []) {
        if (input.phase === "consumed") {
          continue;
        }
        const selected = Boolean(input.claim);
        if (selected ? params.includeActive !== false : params.includeQueued !== false) {
          inputs.add(input);
        }
      }
    }
  }
  // Collected siblings keep receipt identity, but the latest eligible source owns aggregate Stop.
  const sourceByOperation = new Map<ReplyOperation, SessionControllerInput>();
  const queuedInputs: SessionControllerInput[] = [];
  const selectedInputs: SessionControllerInput[] = [];
  for (const input of inputs) {
    const operation = input.claim?.operation;
    if (!operation) {
      if (!input.custody.cancellationRetired && input.phase !== "consumed") {
        if (input.claim && !input.claim.released) {
          selectedInputs.push(input);
        } else {
          queuedInputs.push(input);
        }
      }
      continue;
    }
    if (input.custody.cancellationRetired) {
      continue;
    }
    operations.add(operation);
    const prior = sourceByOperation.get(operation);
    if (!prior || prior.sequence < input.sequence) {
      sourceByOperation.set(operation, input);
    }
  }
  const activeInputs = [...selectedInputs, ...sourceByOperation.values()];
  const bareOperations = [...operations].filter((operation) => !sourceByOperation.has(operation));
  // Captured retained sources remain in settlement even when cancellation moved to a sibling.
  const raw = [
    ...[...inputs].map(captureSessionControllerSourceSettlement),
    ...[...operations].map((operation) => operation.ownerSettlement),
  ];
  // A routing snapshot may never select this owner. Do not retain observers on
  // unrelated long-lived producers until a caller actually joins their receipt.
  let settled: Promise<void> | undefined;
  return Object.freeze({
    inputs: Object.freeze([...inputs]),
    queuedInputs: Object.freeze(queuedInputs),
    activeInputs: Object.freeze(activeInputs),
    operations: Object.freeze(bareOperations),
    get settled() {
      if (!settled) {
        settled = Promise.all(raw).then(() => undefined);
        void settled.catch(() => {});
      }
      return settled;
    },
  });
}

/** Request-local selection for a target discovered by asynchronous routing. */
export function captureSessionControllerStopCandidates() {
  return [...sessionControllers.values()].map((entry) => ({
    storeScope: entry.target?.storeScope,
    aliases: new Set(entry.aliases),
    capture: captureSessionControllerStop({
      inputs: entry.mailbox?.entries.filter((input) => input.phase !== "consumed"),
      operations: [entry.active],
    }),
  }));
}

export type SessionControllerStopResult = {
  queuedCancelled: number;
  activeCancelled: number;
  abortedInputs: SessionControllerInput[];
  abortedOperations: ReplyOperation[];
  settled: Promise<void>;
  failures: Array<{ target: SessionControllerInput | ReplyOperation; error: unknown }>;
  finalizing: number;
};

export type SessionStopSource =
  | "channel-user"
  | "client-session"
  | "client-run"
  | "mutation"
  | "interrupt"
  | "restart"
  | "watchdog"
  | "operator-revocation"
  | "supersede";

type SessionStopPolicy = Readonly<{
  cancelQueued: boolean;
  stopChildren: boolean;
  recordMessageCutoff: boolean;
  fireCommandHook: boolean;
}>;

const SESSION_STOP_POLICY = {
  "channel-user": {
    cancelQueued: true,
    stopChildren: true,
    recordMessageCutoff: true,
    fireCommandHook: true,
  },
  "client-session": {
    cancelQueued: true,
    stopChildren: true,
    recordMessageCutoff: false,
    fireCommandHook: true,
  },
  "client-run": {
    cancelQueued: true,
    stopChildren: true,
    recordMessageCutoff: false,
    fireCommandHook: true,
  },
  mutation: {
    cancelQueued: false,
    stopChildren: false,
    recordMessageCutoff: false,
    fireCommandHook: false,
  },
  interrupt: {
    cancelQueued: false,
    stopChildren: false,
    recordMessageCutoff: false,
    fireCommandHook: false,
  },
  restart: {
    cancelQueued: true,
    stopChildren: false,
    recordMessageCutoff: false,
    fireCommandHook: false,
  },
  watchdog: {
    cancelQueued: false,
    stopChildren: false,
    recordMessageCutoff: false,
    fireCommandHook: false,
  },
  "operator-revocation": {
    cancelQueued: true,
    stopChildren: false,
    recordMessageCutoff: false,
    fireCommandHook: false,
  },
  supersede: {
    cancelQueued: false,
    stopChildren: false,
    recordMessageCutoff: false,
    fireCommandHook: false,
  },
} as const satisfies Record<SessionStopSource, SessionStopPolicy>;

export type SessionStopHookContext = Readonly<{
  sessionKey: string;
  sessionEntry?: SessionEntry;
  sessionId?: string;
  commandSource?: string;
  senderId?: string;
}>;

export type SessionStopChildrenResult = Readonly<{ stopped: number; failed: number }>;
export type SessionStopTargetStatus = "aborted" | "finalizing" | "unchanged";

export type SessionStopExternalParent =
  | Readonly<{
      /** Captured queued parent; cancellation remains synchronous with queue withdrawal. */
      phase: "queued";
      stop: () => SessionStopTargetStatus | Promise<SessionStopTargetStatus>;
      settled?: Promise<unknown>;
    }>
  | Readonly<{
      /** Captured active parent; adapters may join an asynchronous remote cancellation. */
      phase: "active";
      /** Start before native active callbacks when another owner must not be starved by them. */
      start?: "after-queued";
      stop: () => SessionStopTargetStatus | Promise<SessionStopTargetStatus>;
      settled?: Promise<unknown>;
    }>;

export type SessionStopOutcome = Readonly<{
  aborted: boolean;
  alreadyFinalizing: boolean;
  queuedCancelled: number;
  activeCancelled: number;
  childrenStopped: number;
  childFailures: number;
  settled: Promise<void>;
  failures: SessionControllerStopResult["failures"];
}>;

export type SessionStopExecution = SessionStopOutcome & {
  /** Joins cutoff persistence, the command hook, and captured child cancellation. */
  completed: Promise<SessionStopOutcome>;
};

type SessionStopRequestBase = {
  source: SessionStopSource;
  /** Captured synchronously by ingress; a resolver may select among captured candidates later. */
  capture: SessionControllerStopCapture | (() => SessionControllerStopCapture);
  assertCurrent?: () => void;
  reason?: unknown;
  messageIdentity?: unknown;
  recordAbortTarget?: (options: { recordCutoff: boolean }) => Promise<void>;
  hookContext?: SessionStopHookContext;
  stopChildren?: (applyParentStop: () => Promise<boolean>) => Promise<SessionStopChildrenResult>;
  externalParents?: readonly SessionStopExternalParent[];
  /** Authorize and reserve presentation or partial custody before invoking cancel exactly once. */
  cancelInput?: (input: SessionControllerInput, cancel: () => boolean) => boolean;
  cancelOperation?: (operation: ReplyOperation, cancel: () => boolean) => boolean;
  /** Authorized effects owned by another runtime, sequenced after queued withdrawal. */
  afterQueued?: () => void;
  /** Publication effects that require the captured parent cancellation result. */
  afterParent?: (result: SessionControllerStopResult) => void;
  /** Exact external parents may decline the child cancellation they provisionally captured. */
  continueChildStop?: () => boolean;
  onCancelled?: (target: SessionControllerInput | ReplyOperation) => void;
  onError?: (target: SessionControllerInput | ReplyOperation, error: unknown) => "continue" | void;
};

export type SessionStopRequest = SessionStopRequestBase &
  (
    | {
        source: "mutation";
        mutation: Readonly<{ cancelQueued: boolean; stopChildren: boolean }>;
      }
    | {
        source: Exclude<SessionStopSource, "mutation">;
        mutation?: never;
      }
  );

/** One sequencer for captured Stop. Publication adapters wrap, but never replace, its primitive. */
function applySessionControllerStop(
  capture: SessionControllerStopCapture,
  params: {
    source: SessionStopSource;
    assertCurrent?: () => void;
    reason?: unknown;
    phase?: "all" | "queued" | "active";
    /** Reserve presentation/partial custody before invoking cancel exactly once. */
    cancelInput?: (input: SessionControllerInput, cancel: () => boolean) => boolean;
    cancelOperation?: (operation: ReplyOperation, cancel: () => boolean) => boolean;
    /** Independent authorized effects, such as captured channel inputs, between queue and active. */
    afterQueued?: () => void;
    onCancelled?: (target: SessionControllerInput | ReplyOperation) => void;
    onError?: (
      target: SessionControllerInput | ReplyOperation,
      error: unknown,
    ) => "continue" | void;
  },
): SessionControllerStopResult {
  const result: SessionControllerStopResult = {
    queuedCancelled: 0,
    activeCancelled: 0,
    abortedInputs: [],
    abortedOperations: [],
    settled: capture.settled,
    failures: [],
    finalizing: 0,
  };
  const assertCurrent = params.assertCurrent ?? (() => {});
  const reason =
    params.reason ??
    (params.source === "restart"
      ? createAgentRunRestartAbortError()
      : params.source === "supersede"
        ? createAgentRunSupersededAbortError()
        : params.source === "channel-user"
          ? "stop"
          : undefined);
  const once = (
    effect: () => boolean,
    committedAfterFailure: () => boolean,
    record: () => void,
    assertEffectCurrent: () => void = assertCurrent,
  ) => {
    let called = false;
    let accepted = false;
    return () => {
      if (called) {
        return accepted;
      }
      assertEffectCurrent();
      called = true;
      try {
        accepted = effect();
      } catch (error) {
        // Exact owner outcome/custody records distinguish a failed observer from
        // an uncommitted refusal. Never discover a successor or infer idle=settled.
        accepted = committedAfterFailure();
        if (accepted) {
          record();
        }
        throw error;
      }
      if (accepted) {
        record();
      }
      return accepted;
    };
  };
  const cancelSource = (input: SessionControllerInput, queued: boolean) => {
    // Adapters may reserve presentation or custody before cancellation, but the
    // exact shared primitive always revalidates live authority at the side effect.
    assertCurrent();
    const operation = input.claim?.operation;
    const hadResult = Boolean(operation?.result);
    const wasRetiring = input.retirementRequested;
    const wasAborted = input.abortSignal.aborted;
    const cancel = once(
      () => abortSessionControllerInput(input, reason, assertCurrent),
      () =>
        (!hadResult && operation?.result?.kind === "aborted") ||
        (!wasRetiring &&
          input.retirementRequested === true &&
          !wasAborted &&
          input.abortSignal.aborted),
      () => {
        result.abortedInputs.push(input);
        if (queued) {
          result.queuedCancelled++;
        } else {
          result.activeCancelled++;
        }
        params.onCancelled?.(input);
      },
      assertCurrent,
    );
    if (params.cancelInput) {
      params.cancelInput(input, cancel);
    } else {
      cancel();
    }
    if (
      !queued &&
      !input.abortSignal.aborted &&
      operation &&
      isCurrentSessionControllerOperation(operation) &&
      !operation.result &&
      (operation.abortFrozen || !isReplyOperationAbortable(operation))
    ) {
      result.finalizing++;
    }
  };
  const effect = (target: SessionControllerInput | ReplyOperation, run: () => void) => {
    try {
      run();
    } catch (error) {
      result.failures.push({ target, error });
      if (params.onError?.(target, error) !== "continue") {
        throw error;
      }
    }
  };
  if (params.phase !== "active") {
    for (const input of capture.queuedInputs) {
      effect(input, () => cancelSource(input, true));
    }
    if (params.afterQueued) {
      assertCurrent();
      params.afterQueued();
    }
  }
  if (params.phase === "queued") {
    return result;
  }
  for (const input of capture.activeInputs) {
    effect(input, () => cancelSource(input, false));
  }
  for (const operation of capture.operations) {
    effect(operation, () => {
      assertCurrent();
      const hadResult = Boolean(operation.result);
      let recorded = false;
      const record = () => {
        if (recorded) {
          return;
        }
        recorded = true;
        result.abortedOperations.push(operation);
        result.activeCancelled++;
        params.onCancelled?.(operation);
      };
      const cancel = once(
        () => {
          if (!isCurrentSessionControllerOperation(operation)) {
            return false;
          }
          return params.source === "watchdog" ? operation.abortForStall() : operation.abort(reason);
        },
        () =>
          !hadResult &&
          (operation.result?.kind === "aborted" ||
            (params.source === "watchdog" &&
              operation.result?.kind === "failed" &&
              operation.result.code === "run_stalled")),
        record,
      );
      if (params.cancelOperation) {
        if (params.cancelOperation(operation, cancel)) {
          record();
        }
      } else {
        cancel();
      }
      if (
        !operation.abortSignal.aborted &&
        isCurrentSessionControllerOperation(operation) &&
        !operation.result &&
        (operation.abortFrozen || !isReplyOperationAbortable(operation))
      ) {
        result.finalizing++;
      }
    });
  }
  return result;
}

/** Exact source teardown cancels its captured input without adopting session-wide Stop policy. */
export function cancelCapturedSessionControllerSource(
  capture: SessionControllerStopCapture,
  params: Omit<Parameters<typeof applySessionControllerStop>[1], "source" | "phase"> = {},
): SessionControllerStopResult {
  return applySessionControllerStop(capture, {
    ...params,
    source: "operator-revocation",
    phase: "all",
  });
}

function resolveStopOutcome(
  result: SessionControllerStopResult,
  externalActiveCancelled: number,
  externalQueuedCancelled: number,
  externalFinalizing: number,
  children: SessionStopChildrenResult,
): SessionStopOutcome {
  return Object.freeze({
    aborted: result.activeCancelled + externalActiveCancelled > 0,
    alreadyFinalizing: result.finalizing + externalFinalizing > 0,
    queuedCancelled: result.queuedCancelled + externalQueuedCancelled,
    activeCancelled: result.activeCancelled + externalActiveCancelled,
    childrenStopped: children.stopped,
    childFailures: children.failed,
    settled: result.settled,
    failures: result.failures,
  });
}

/**
 * Applies the source policy to one captured stop request.
 *
 * The caller resolves and authorizes the target. This owner decides which captured
 * inputs, child runs, cutoff writer, and command hook participate in the request.
 */
export function stopSession(request: SessionStopRequest): SessionStopExecution {
  const sourcePolicy = SESSION_STOP_POLICY[request.source];
  const policy =
    request.source === "mutation"
      ? {
          ...sourcePolicy,
          cancelQueued: request.mutation.cancelQueued,
          stopChildren: request.mutation.stopChildren,
        }
      : sourcePolicy;
  let externalActiveCancelled = 0;
  let externalQueuedCancelled = 0;
  let externalFinalizing = 0;
  let parentResult: SessionControllerStopResult | undefined;
  let runPostParent: (() => Promise<void>) | undefined;
  let resolveParentResult!: (result: SessionControllerStopResult) => void;
  let rejectParentResult!: (error: unknown) => void;
  const parentResultReady = new Promise<SessionControllerStopResult>((resolve, reject) => {
    resolveParentResult = resolve;
    rejectParentResult = reject;
  });
  void parentResultReady.catch(() => {});
  const applyParentStop = async (): Promise<boolean> => {
    if (parentResult) {
      return true;
    }
    const capture = typeof request.capture === "function" ? request.capture() : request.capture;
    request.assertCurrent?.();
    const pendingExternalStops: Promise<void>[] = [];
    const startedExternalStops = new Set<SessionStopExternalParent>();
    const recordExternalStatus = (
      parent: SessionStopExternalParent,
      status: SessionStopTargetStatus,
    ) => {
      if (status === "aborted") {
        if (parent.phase === "active") {
          externalActiveCancelled++;
        } else {
          externalQueuedCancelled++;
        }
      } else if (status === "finalizing") {
        externalFinalizing++;
      }
    };
    parentResult = applySessionControllerStop(capture, {
      source: request.source,
      assertCurrent: request.assertCurrent,
      reason: request.reason,
      phase: policy.cancelQueued ? "all" : "active",
      cancelInput: request.cancelInput,
      cancelOperation: request.cancelOperation,
      afterQueued: () => {
        for (const parent of request.externalParents ?? []) {
          if (parent.phase === "queued" || ("start" in parent && parent.start === "after-queued")) {
            startedExternalStops.add(parent);
            pendingExternalStops.push(
              Promise.resolve(parent.stop()).then((status) => recordExternalStatus(parent, status)),
            );
          }
        }
        request.afterQueued?.();
      },
      onCancelled: request.onCancelled,
      onError: request.onError,
    });
    for (const parent of request.externalParents ?? []) {
      if (parent.phase === "queued" || startedExternalStops.has(parent)) {
        continue;
      }
      request.assertCurrent?.();
      pendingExternalStops.push(
        Promise.resolve(parent.stop()).then((status) => recordExternalStatus(parent, status)),
      );
    }
    const externalSettlements = (request.externalParents ?? []).flatMap((parent) =>
      parent.settled ? [parent.settled] : [],
    );
    if (externalSettlements.length > 0) {
      parentResult.settled = Promise.all([parentResult.settled, ...externalSettlements]).then(
        () => undefined,
      );
    }
    resolveParentResult(parentResult);
    request.afterParent?.(parentResult);
    runPostParent = async () => {
      await Promise.all(pendingExternalStops);
      const currentParentResult = parentResult;
      if (!currentParentResult) {
        throw new Error("Parent Stop result is unavailable");
      }
      const alreadyFinalizing = currentParentResult.finalizing + externalFinalizing > 0;
      const activeCancelled = currentParentResult.activeCancelled + externalActiveCancelled;
      if ((!alreadyFinalizing || activeCancelled > 0) && request.recordAbortTarget) {
        await request.recordAbortTarget({
          recordCutoff: policy.recordMessageCutoff && request.messageIdentity !== undefined,
        });
      }
      if (policy.fireCommandHook) {
        const hookContext = request.hookContext;
        if (!hookContext) {
          throw new Error(`Stop source ${request.source} requires command hook context`);
        }
        request.assertCurrent?.();
        await triggerInternalHook(
          createInternalHookEvent("command", "stop", hookContext.sessionKey, {
            sessionEntry: hookContext.sessionEntry,
            sessionId: hookContext.sessionId,
            commandSource: hookContext.commandSource,
            senderId: hookContext.senderId,
          }),
        );
      }
    };
    return request.continueChildStop?.() ?? true;
  };

  let children: Promise<SessionStopChildrenResult>;
  try {
    children = policy.stopChildren
      ? (request.stopChildren?.(applyParentStop) ??
        applyParentStop().then(() => ({ stopped: 0, failed: 0 })))
      : applyParentStop().then(() => ({ stopped: 0, failed: 0 }));
  } catch (error) {
    rejectParentResult(error);
    throw error;
  }
  const pendingSettlement = parentResultReady.then((result) => result.settled);
  void pendingSettlement.catch(() => {});
  const initial = parentResult
    ? resolveStopOutcome(
        parentResult,
        externalActiveCancelled,
        externalQueuedCancelled,
        externalFinalizing,
        { stopped: 0, failed: 0 },
      )
    : resolveStopOutcome(
        {
          queuedCancelled: 0,
          activeCancelled: 0,
          abortedInputs: [],
          abortedOperations: [],
          settled: pendingSettlement,
          failures: [],
          finalizing: 0,
        },
        0,
        0,
        0,
        { stopped: 0, failed: 0 },
      );
  const completed = children.then(
    async (childResult) => {
      const postParent = runPostParent;
      const currentParentResult = parentResult;
      if (!postParent || !currentParentResult) {
        throw new Error("Parent Stop result is unavailable");
      }
      await postParent();
      return resolveStopOutcome(
        currentParentResult,
        externalActiveCancelled,
        externalQueuedCancelled,
        externalFinalizing,
        childResult,
      );
    },
    async (error) => {
      await runPostParent?.();
      throw error;
    },
  );
  void completed.catch(rejectParentResult);
  void completed.catch(() => {});
  return Object.freeze({ ...initial, completed });
}

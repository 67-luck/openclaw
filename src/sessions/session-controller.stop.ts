import { createAgentRunRestartAbortError } from "../agents/run-termination.js";
import type { ReplyOperation } from "./session-controller.contracts.js";
import type { SessionTarget } from "./session-controller.lifecycle.js";
import {
  abortSessionControllerInput,
  captureSessionControllerSourceSettlement,
  type SessionControllerInput,
} from "./session-controller.mailbox.js";
import {
  findSessionControllerEntries,
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
};

/** One sequencer for captured Stop. Publication adapters wrap, but never replace, its primitive. */
export function stopSessionController(
  capture: SessionControllerStopCapture,
  params: {
    source:
      | "gateway"
      | "channel-stop"
      | "channel-abort"
      | "fast-abort"
      | "restart"
      | "operator-revocation"
      | "watchdog";
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
  };
  const assertCurrent = params.assertCurrent ?? (() => {});
  const reason =
    params.reason ??
    (params.source === "restart"
      ? createAgentRunRestartAbortError()
      : params.source === "channel-stop" ||
          params.source === "channel-abort" ||
          params.source === "fast-abort"
        ? "stop"
        : undefined);
  const once = (
    effect: () => boolean,
    committedAfterFailure: () => boolean,
    record: () => void,
  ) => {
    let called = false;
    let accepted = false;
    return () => {
      if (called) {
        return accepted;
      }
      assertCurrent();
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
    );
    if (params.cancelInput) {
      params.cancelInput(input, cancel);
    } else {
      cancel();
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
        () => {
          result.abortedOperations.push(operation);
          result.activeCancelled++;
          params.onCancelled?.(operation);
        },
      );
      if (params.cancelOperation) {
        params.cancelOperation(operation, cancel);
      } else {
        cancel();
      }
    });
  }
  return result;
}

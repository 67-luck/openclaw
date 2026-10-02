import { createDeferredCore } from "../shared/deferred.js";
import {
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  type ReplyOperation,
} from "./session-controller.contracts.js";
import {
  runAfterRetiringSessionSources,
  waitUnlessAborted,
} from "./session-controller.lifecycle-observation.js";
import {
  effectMatchesSessionId,
  inputMatchesSessionId,
} from "./session-controller.lifecycle-projections.js";
import type { Effect, OwnerContext } from "./session-controller.lifecycle.types.js";
import type { SessionControllerInput } from "./session-controller.mailbox.types.js";
import {
  isReplyOperationAbortable,
  type SessionControllerEntry,
} from "./session-controller.state.js";
import type { SessionStopChildrenResult } from "./session-controller.stop.js";
import type { SessionTarget } from "./session-controller.target.js";

export type SessionMutationKind = "reset" | "delete" | "compaction";

export type SessionMutationPreemptOptions = Readonly<{
  activeRun: "abort" | "abort-if-abortable";
  waitingInputs: "cancel" | "keep";
  reason?: Error;
  shouldPreempt?: () => boolean;
  settleTimeoutMs?: number;
  stopChildren?: (applyParentStop: () => Promise<boolean>) => Promise<SessionStopChildrenResult>;
}>;

export type SessionMutationPolicy =
  | {
      kind: SessionMutationKind;
      policy: "preempt";
      preempt: SessionMutationPreemptOptions;
    }
  | {
      kind?: SessionMutationKind;
      policy?: "allow-live" | "wait";
      preempt?: never;
    };

export type SessionMutationPreemption = {
  settlement: Promise<void>;
  timeoutMs: number;
  sessionKey: string;
  kind: SessionMutationKind;
  reason: Error;
};

/** Selects subordinate effects that must settle before a mutation can run. */
export function selectSessionMutationEffects(params: {
  entries: readonly SessionControllerEntry[];
  current: OwnerContext | undefined;
  requiredSessionId?: string;
  waitForCompetitors: boolean;
}): Set<Effect> {
  return new Set(
    params.entries.flatMap((entry) =>
      [...(entry.lifecycle?.effects ?? [])].filter(
        (effect) =>
          effectMatchesSessionId(effect, params.requiredSessionId) &&
          (effect.phase === "validating" ||
            effect.phase === "writer" ||
            (params.waitForCompetitors && effect.phase === "acquired")) &&
          !params.current?.effects.has(effect),
      ),
    ),
  );
}

/** Interrupts selected effects for preemption and returns their settlement barrier. */
export function settleSessionMutationEffects(params: {
  effects: ReadonlySet<Effect>;
  preemption?: SessionMutationPreemption;
  waitForCompetitors: boolean;
  interrupt: (effect: Effect, reason: Error) => void;
}): Promise<unknown> {
  if (params.preemption) {
    for (const effect of params.effects) {
      params.interrupt(effect, params.preemption.reason);
    }
  }
  return Promise.all(
    [...params.effects].map((effect) =>
      params.waitForCompetitors ? effect.ref.released : effect.validated.promise,
    ),
  );
}

/** Reports that a mutation's captured preemption work did not settle within its bound. */
export class SessionMutationPreemptTimeoutError extends Error {
  constructor(
    readonly sessionKey: string,
    readonly mutationKind: SessionMutationKind,
  ) {
    super(`Session ${sessionKey} did not settle before ${mutationKind} preemption timed out`);
    this.name = "SessionMutationPreemptTimeoutError";
  }
}

function didMutationCancellationCommit(target: SessionControllerInput | ReplyOperation): boolean {
  return "mailbox" in target
    ? target.retirementRequested === true && target.abortSignal.aborted
    : target.result?.kind === "aborted" && target.abortSignal.aborted;
}

/** Captures and starts the exact Stop operation selected by a mutation. */
function prepareSessionMutationPreemption(params: {
  stop: typeof import("./session-controller.stop.js");
  options: SessionMutationPreemptOptions;
  claims: readonly import("./session-controller.mailbox.js").SessionControllerMailboxClaim[];
  entries: readonly SessionControllerEntry[];
  competitors: readonly ReplyOperation[];
  requiredSessionId?: string;
  targets: readonly SessionTarget[];
  kind: SessionMutationKind;
}): SessionMutationPreemption | undefined {
  const { options } = params;
  const { captureSessionControllerStop, stopSession } = params.stop;
  if (options.shouldPreempt?.() === false) {
    return undefined;
  }
  const claims = params.claims.filter(
    (claim) => options.activeRun === "abort" || claim.operation !== undefined,
  );
  const capture = captureSessionControllerStop({
    inputs: [
      ...claims.flatMap((claim) => claim.inputs),
      ...(options.waitingInputs === "cancel"
        ? params.entries.flatMap(
            (entry) =>
              entry.mailbox?.entries.filter(
                (input) => !input.claim && inputMatchesSessionId(input, params.requiredSessionId),
              ) ?? [],
          )
        : []),
    ],
    operations: params.competitors,
  });
  const cancelActive = (operation: ReplyOperation | undefined, cancel: () => boolean) =>
    options.activeRun === "abort" ||
    (operation !== undefined && isReplyOperationAbortable(operation))
      ? cancel()
      : false;
  const stopChildren = options.stopChildren;
  const stop = stopSession({
    source: "mutation",
    mutation: {
      cancelQueued: options.waitingInputs === "cancel",
      stopChildren: stopChildren !== undefined,
    },
    capture,
    reason: options.reason,
    cancelInput: (input, cancel) => cancelActive(input.claim?.operation, cancel),
    cancelOperation: (operation, cancel) => cancelActive(operation, cancel),
    // Backend observers can throw after the exact owner committed its abort.
    // Settlement, not that observer failure, decides whether mutation may proceed.
    onError: (target) => (didMutationCancellationCommit(target) ? "continue" : undefined),
    stopChildren: stopChildren
      ? async (applyParentStop) =>
          await stopChildren(async () => {
            await applyParentStop();
            return true;
          })
      : undefined,
  });
  return {
    settlement: stop.completed.then((outcome) => outcome.settled),
    timeoutMs: options.settleTimeoutMs ?? REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
    sessionKey: params.targets[0]?.sessionKey ?? params.entries[0]?.key ?? "unknown",
    kind: params.kind,
    reason: options.reason ?? new Error("Session mutation interrupted preparation"),
  };
}

/** Applies the selected wait or preempt policy to captured mutation competitors. */
export async function prepareSessionMutationCompetition(params: {
  policy: SessionMutationPolicy;
  claims: readonly import("./session-controller.mailbox.js").SessionControllerMailboxClaim[];
  entries: readonly SessionControllerEntry[];
  competitors: readonly ReplyOperation[];
  requiredSessionId?: string;
  targets: readonly SessionTarget[];
  signal?: AbortSignal;
}): Promise<{ waitForCompetitors: boolean; preemption?: SessionMutationPreemption }> {
  if (params.policy.policy === "preempt") {
    // Stop reaches the mailbox and reply queue; storage modules import the lifecycle,
    // so a static edge here would close an import cycle back into the session accessor.
    const stop = await import("./session-controller.stop.js");
    const preemption = prepareSessionMutationPreemption({
      stop,
      options: params.policy.preempt,
      claims: params.claims,
      entries: params.entries,
      competitors: params.competitors,
      requiredSessionId: params.requiredSessionId,
      targets: params.targets,
      kind: params.policy.kind,
    });
    return { waitForCompetitors: preemption !== undefined, preemption };
  }
  if (params.policy.policy === "wait") {
    await waitUnlessAborted(
      Promise.all([
        ...params.competitors.map((operation) => operation.ownerSettlement),
        ...params.claims.map((claim) => claim.settlement.promise),
      ]),
      params.signal,
    );
    return { waitForCompetitors: true };
  }
  return { waitForCompetitors: false };
}

/** Bounds preemption settlement while leaving the mutation body outside the deadline. */
export async function runWithMutationPreemptionTimeout<T>(params: {
  settleAndRun: (markSettled: () => void) => Promise<T>;
  timeoutMs: number;
  sessionKey: string;
  kind: SessionMutationKind;
}): Promise<T> {
  let timedOut = false;
  const timeoutError = new SessionMutationPreemptTimeoutError(params.sessionKey, params.kind);
  const timeout = createDeferredCore<never>();
  const timer = setTimeout(() => {
    timedOut = true;
    timeout.reject(timeoutError);
  }, params.timeoutMs);
  timer.unref?.();
  const task = params.settleAndRun(() => {
    if (timedOut) {
      throw timeoutError;
    }
    clearTimeout(timer);
  });
  try {
    return await Promise.race([task, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/** Waits for captured Stop and effect settlement before starting the mutation body. */
export async function runPreemptedSessionMutation<T>(params: {
  preemption: SessionMutationPreemption;
  effectsSettled: Promise<unknown>;
  targets: readonly SessionTarget[];
  requiredSessionId?: string;
  run: () => Promise<T>;
}): Promise<T> {
  return await runWithMutationPreemptionTimeout({
    timeoutMs: params.preemption.timeoutMs,
    sessionKey: params.preemption.sessionKey,
    kind: params.preemption.kind,
    settleAndRun: async (markSettled) => {
      await params.preemption.settlement;
      await params.effectsSettled;
      return await runAfterRetiringSessionSources(
        params.targets,
        params.requiredSessionId,
        async () => {
          markSettled();
          return await params.run();
        },
      );
    },
  });
}

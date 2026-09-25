import type { AgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.types.js";
import { createMessageInjectionAuthority } from "../auto-reply/reply/message-injection-authority.js";
import type { SessionPendingInputReceipt } from "../config/sessions/session-accessor.pending-input-receipt.js";
import type { TranscriptEntryAnchor } from "../config/sessions/transcript-entry-anchor.js";
import type { GatewayPendingInputWorkerAuthority } from "../gateway/server-methods/session-mutation-guards.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptAdmissionReceipt,
  UserTurnTranscriptRecorder,
} from "./user-turn-transcript.types.js";

type AdmissionOwner = {
  freshInput?: { assertCurrent: () => void; isExempt(): boolean };
  pending: {
    read(): SessionPendingInputReceipt | undefined;
    bind: (
      receipt: SessionPendingInputReceipt,
      authority: GatewayPendingInputWorkerAuthority,
    ) => boolean;
    join: (receipt: SessionPendingInputReceipt) => Promise<void> | undefined;
    complete(
      outcome: AgentRunTerminalOutcome,
    ): AgentRunTerminalOutcome | Promise<AgentRunTerminalOutcome> | undefined;
    sources(): readonly UserTurnTranscriptRecorder[] | undefined;
  };
  receipt: () => UserTurnTranscriptAdmissionReceipt | undefined;
  message: () => PersistedUserTurnMessage | undefined;
  blocked: () => boolean;
  sentToProvider: () => boolean;
  refresh: (
    admission: UserTurnTranscriptAdmissionReceipt,
    message: PersistedUserTurnMessage,
  ) => void;
};

// Only the recorder factory registers an owner; copied SDK values cannot bind one.
const admissionOwners = new WeakMap<UserTurnTranscriptRecorder, AdmissionOwner>();
export const sessionFreshInputCommit = Symbol("sessionFreshInputCommit");

class FreshInputCommit {
  readonly #assert: () => void;

  constructor(recorder: UserTurnTranscriptRecorder, owner: AdmissionOwner) {
    this.#assert = createMessageInjectionAuthority(() => {
      if (admissionOwners.get(recorder) !== owner || !owner.freshInput) {
        throw new Error("Fresh input lost its original recorder admission");
      }
      if (!owner.freshInput.isExempt()) {
        owner.freshInput.assertCurrent();
      }
      return true;
    });
    Object.freeze(this);
  }

  static assertCurrent(value: unknown): void {
    if (typeof value !== "object" || value === null || !(#assert in value)) {
      throw new Error("Fresh input requires its original private commit admission");
    }
    value.#assert();
  }
}

export type UserTurnFreshInputCommit = FreshInputCommit;
export function captureUserTurnFreshInputCommit(
  recorder: UserTurnTranscriptRecorder | undefined,
): UserTurnFreshInputCommit | undefined {
  const owner = recorder && admissionOwners.get(recorder);
  return recorder && owner?.freshInput ? new FreshInputCommit(recorder, owner) : undefined;
}
export function assertUserTurnFreshInputCommit(value: UserTurnFreshInputCommit | undefined): void {
  FreshInputCommit.assertCurrent(value);
}

export function registerUserTurnTranscriptAdmissionOwner(
  recorder: UserTurnTranscriptRecorder,
  owner: AdmissionOwner,
): void {
  admissionOwners.set(recorder, owner);
}

export function getUserTurnTranscriptAdmissionOwner(
  recorder: UserTurnTranscriptRecorder,
): AdmissionOwner | undefined {
  return admissionOwners.get(recorder);
}

/** Snapshot only the factory-owned input that has not crossed its foreground model boundary. */
export function readPendingUserTurnTranscriptAdmission(
  recorder: UserTurnTranscriptRecorder | undefined,
): UserTurnTranscriptAdmissionReceipt | undefined {
  const owner = recorder ? admissionOwners.get(recorder) : undefined;
  if (!owner || owner.blocked() || owner.sentToProvider()) {
    return undefined;
  }
  const receipt = owner.receipt();
  return receipt ? { ...receipt } : undefined;
}

export function resolveUserTurnTranscriptAdmission(params: {
  logicalTurnId: string;
  receipt: TranscriptEntryAnchor | UserTurnTranscriptAdmissionReceipt;
}): UserTurnTranscriptAdmissionReceipt {
  return "logicalTurnId" in params.receipt
    ? params.receipt
    : {
        ...params.receipt,
        logicalTurnId: params.logicalTurnId,
        role: "user",
      };
}

export function bindUserTurnPendingInputWorkerAuthority(
  recorder: UserTurnTranscriptRecorder,
  authority: GatewayPendingInputWorkerAuthority,
): boolean {
  const pending = admissionOwners.get(recorder)?.pending;
  const receipt = pending?.read();
  if (!pending || !receipt) {
    authority.release();
    return false;
  }
  return pending.bind(receipt, authority);
}

/** Internal joined operation on the same recorder; native and no-receipt results stay synchronous. */
export function completeUserTurnTranscriptProcessing(
  recorder: UserTurnTranscriptRecorder | undefined,
  outcome: AgentRunTerminalOutcome,
): AgentRunTerminalOutcome | Promise<AgentRunTerminalOutcome> | undefined {
  const owner = recorder && admissionOwners.get(recorder)?.pending;
  return owner ? owner.complete(outcome) : recorder?.completeProcessing?.(outcome);
}

export function joinUserTurnPendingInput(
  recorder: UserTurnTranscriptRecorder | undefined,
): Promise<void> | undefined {
  const pending = recorder && admissionOwners.get(recorder)?.pending;
  const receipt = pending?.read();
  if (pending && receipt) {
    // A native receipt can join synchronously; only absence permits source recursion.
    return pending.join(receipt);
  }
  const joins = (pending?.sources() ?? []).flatMap(
    (source) => joinUserTurnPendingInput(source) ?? [],
  );
  return joins.length
    ? Promise.allSettled(joins).then((settlements) => {
        const failures = settlements.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length) {
          throw new AggregateError(failures, "Collected input sources did not all settle");
        }
      })
    : undefined;
}

export function finishUserTurnPendingInput(
  recorder: UserTurnTranscriptRecorder | undefined,
  disposition: "cancelled" | "interrupted",
): Promise<void> | undefined {
  let failure: { error: unknown } | undefined;
  try {
    recorder?.finishPendingInput?.(disposition);
  } catch (error) {
    failure = { error };
  }
  const joined = joinUserTurnPendingInput(recorder);
  if (!failure) {
    return joined;
  }
  const error = failure.error;
  if (!joined) {
    throw error;
  }
  return joined.then(
    () => {
      throw error;
    },
    (joinError: unknown) => {
      throw new AggregateError([error, joinError], "Pending input finish and settlement failed");
    },
  );
}

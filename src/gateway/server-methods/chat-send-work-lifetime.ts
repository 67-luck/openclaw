import { isSessionPendingInputSettlementUnknown } from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext } from "./types.js";

// Keep lifetime issuance with the retained work owner, independent of session loading.
const inputLifetimeIssuer = Symbol("chatInputLifetimeIssuer");

class ChatSendInputLifetime {
  readonly #assert: (allowAborted: boolean) => void;

  constructor(issuer: symbol, assert: (allowAborted: boolean) => void) {
    if (issuer !== inputLifetimeIssuer) {
      throw new Error("Chat input lifetime requires its original admission owner");
    }
    this.#assert = assert;
    Object.freeze(this);
  }

  static assertCurrent(value: unknown, allowAborted: boolean): void {
    if (typeof value !== "object" || value === null || !(#assert in value)) {
      throw new Error("Pending chat input has no retained work admission");
    }
    value.#assert(allowAborted);
  }
}

export type RetainedChatSendInputLifetime = ChatSendInputLifetime;

export function assertChatSendInputLifetime(
  value: RetainedChatSendInputLifetime,
  allowAborted = false,
): void {
  ChatSendInputLifetime.assertCurrent(value, allowAborted);
}

/** Queued and collected turns share the original session and caller admission until settlement. */
export function createChatSendWorkAdmission(params: {
  admission: Pick<SessionWorkAdmissionLease, "release"> &
    Partial<Pick<SessionWorkAdmissionLease, "isActive">>;
  releaseCallerAuthority?: () => void | Promise<void>;
  logGateway: Pick<GatewayRequestContext["logGateway"], "warn">;
}) {
  let references = 1;
  let finishPendingInput: (() => void | Promise<void>) | undefined;
  let settlement: Promise<void> | undefined;
  const releaseOwners = () => {
    const failures: unknown[] = [];
    const closing: Promise<void>[] = [];
    for (const release of [() => params.admission.release(), params.releaseCallerAuthority]) {
      try {
        const pending = release?.();
        if (pending) {
          closing.push(pending);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    const finish = () => {
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Chat input owner release failed");
      }
    };
    if (!closing.length) {
      return finish();
    }
    return Promise.allSettled(closing).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          failures.push(result.reason);
        }
      }
      finish();
    });
  };
  const reportFailure = (error: unknown) => {
    params.logGateway.warn(`Failed to finish pending chat input: ${formatForLog(error)}`);
  };
  const release = () => {
    if (references === 0) {
      return settlement;
    }
    references -= 1;
    if (references !== 0) {
      return undefined;
    }
    let pending: void | Promise<void> = undefined;
    try {
      pending = finishPendingInput?.();
    } catch (error) {
      // The durable row remains recoverable; a failed disposition write must
      // not strand session/root drain ownership during shutdown.
      reportFailure(error);
      if (isSessionPendingInputSettlementUnknown(error)) {
        throw error;
      }
    }
    if (pending instanceof Promise) {
      settlement = pending.then(releaseOwners, (error: unknown) => {
        reportFailure(error);
        if (isSessionPendingInputSettlementUnknown(error)) {
          throw error;
        }
        return releaseOwners();
      });
      void settlement.catch(() => {});
      return settlement;
    }
    const joined = releaseOwners();
    if (joined) {
      settlement = joined;
      void settlement.catch(() => {});
    }
    return settlement;
  };
  const hold = () => {
    let released = false;
    let joined: Promise<void> | undefined;
    let failure: { error: unknown } | undefined;
    return () => {
      if (failure) {
        throw failure.error;
      }
      if (released) {
        return joined;
      }
      released = true;
      try {
        joined = release();
      } catch (error) {
        failure = { error };
        throw error;
      }
      return joined;
    };
  };
  return {
    isActive: () => references > 0,
    captureInputLifetime(input: {
      controller: AbortController;
      queuedTurns: GatewayRequestContext["chatQueuedTurns"];
      runId: string;
      lifecycleGeneration: string;
    }): RetainedChatSendInputLifetime {
      if (!params.admission.isActive) {
        throw new Error("Chat input requires its native work admission");
      }
      const { controller, queuedTurns, runId, lifecycleGeneration } = input;
      return new ChatSendInputLifetime(inputLifetimeIssuer, (allowAborted) => {
        const queued = queuedTurns.get(runId);
        if (
          (!allowAborted && references === 0) ||
          !params.admission.isActive!() ||
          lifecycleGeneration !== getAgentEventLifecycleGeneration() ||
          (!allowAborted &&
            controller.signal.aborted &&
            !(queued?.controller === controller && queued.abortable === false))
        ) {
          throw new Error("Chat admission ended or was cancelled; submit a new turn.");
        }
      });
    },
    release: hold(),
    retain: () => {
      if (references === 0) {
        throw new Error("cannot retain a released chat work admission");
      }
      references += 1;
      return hold();
    },
    setPendingInputCleanup: (finish: () => void | Promise<void>) => {
      finishPendingInput = finish;
    },
  };
}

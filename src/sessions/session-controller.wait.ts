import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  findSessionControllerEntries,
  getSessionControllerEntry,
  mergeReplyRunAdmissionSource,
  pruneSessionControllerEntry,
} from "./session-controller.state.js";
import type {
  ReplyRunAdmissionSource,
  ReplyRunWaiter,
  SessionControllerEntry,
} from "./session-controller.state.types.js";

function waitForSessionControllerEntryIdle(
  owner: SessionControllerEntry,
  timeoutMs?: number | null,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!owner.active) {
    return Promise.resolve(true);
  }
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const waiters = owner.waiters;
    let abortHandler: (() => void) | undefined;
    let settled = false;
    const waiter: ReplyRunWaiter = {
      finish: (ended) => {
        if (settled) {
          return;
        }
        settled = true;
        waiters.delete(waiter);
        pruneSessionControllerEntry(owner);
        if (waiter.timer) {
          clearTimeout(waiter.timer);
        }
        if (abortHandler) {
          signal?.removeEventListener("abort", abortHandler);
        }
        resolve(ended);
      },
    };
    if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
      waiter.timer = setTimeout(
        () => waiter.finish(false),
        resolveTimerTimeoutMs(timeoutMs, 100, 100),
      );
    }
    if (signal) {
      abortHandler = () => waiter.finish(false);
      signal.addEventListener("abort", abortHandler, { once: true });
    }
    waiters.add(waiter);
    if (!owner.active) {
      waiter.finish(true);
    }
  });
}

/** Waits for every active physical owner selected by a logical key to release its slot. */
export function waitForSessionRunIdle(
  sessionKey: string,
  timeoutMs?: number | null,
  opts?: { signal?: AbortSignal },
): Promise<boolean> {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey) {
    return Promise.resolve(true);
  }
  const owners = findSessionControllerEntries(normalizedSessionKey).filter((entry) => entry.active);
  return Promise.all(
    owners.map((owner) => waitForSessionControllerEntryIdle(owner, timeoutMs, opts?.signal)),
  ).then((outcomes) => outcomes.every(Boolean));
}

type ReplyRunAdmissionSettlement = { settled: boolean; sources?: ReplyRunAdmissionSource[] };

async function waitForReplyRunAdmissionBarrier(params: {
  barrierKind: "followupBarrier" | "successorBarrier";
  minimumTimeoutMs: number;
  sessionKey: string;
  signal?: AbortSignal;
  timeoutMs?: number | null;
}): Promise<ReplyRunAdmissionSettlement> {
  const deadline =
    typeof params.timeoutMs === "number"
      ? Date.now() +
        resolveTimerTimeoutMs(params.timeoutMs, params.minimumTimeoutMs, params.minimumTimeoutMs)
      : undefined;
  const sources = new Map<ReplyRunAdmissionSource["databaseIdentity"], ReplyRunAdmissionSource>();
  while (true) {
    if (params.signal?.aborted) {
      return { settled: false };
    }
    const barrier = getSessionControllerEntry(params.sessionKey)[params.barrierKind];
    if (!barrier) {
      return { settled: true, ...(sources.size ? { sources: [...sources.values()] } : {}) };
    }
    const remainingMs = deadline === undefined ? undefined : deadline - Date.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      return { settled: false };
    }
    let timer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    const outcome = await Promise.race([
      barrier.settled.then(() => true),
      ...(remainingMs !== undefined
        ? [
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), Math.max(1, remainingMs));
              timer.unref?.();
            }),
          ]
        : []),
      ...(params.signal
        ? [
            new Promise<boolean>((resolve) => {
              abortHandler = () => resolve(false);
              params.signal?.addEventListener("abort", abortHandler, { once: true });
              if (params.signal?.aborted) {
                abortHandler();
              }
            }),
          ]
        : []),
    ]);
    if (timer) {
      clearTimeout(timer);
    }
    if (abortHandler) {
      params.signal?.removeEventListener("abort", abortHandler);
    }
    if (!outcome) {
      return { settled: false };
    }
    for (const [identity, source] of barrier.sources) {
      sources.set(
        identity,
        mergeReplyRunAdmissionSource(
          { ...source, sessionIds: new Set(source.sessionIds) },
          sources.get(identity),
        ),
      );
    }
  }
}

export async function waitForReplyRunFollowupAdmission(
  sessionKey: string,
  timeoutMs: number,
  opts?: { signal?: AbortSignal },
): Promise<ReplyRunAdmissionSettlement> {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  return normalizedSessionKey
    ? await waitForReplyRunAdmissionBarrier({
        barrierKind: "followupBarrier",
        minimumTimeoutMs: 100,
        sessionKey: normalizedSessionKey,
        signal: opts?.signal,
        timeoutMs,
      })
    : { settled: true };
}

export async function waitForReplyRunSuccessorAdmission(
  sessionKey: string,
  timeoutMs?: number | null,
  opts?: { signal?: AbortSignal },
): Promise<ReplyRunAdmissionSettlement> {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  return normalizedSessionKey
    ? await waitForReplyRunAdmissionBarrier({
        barrierKind: "successorBarrier",
        minimumTimeoutMs: 0,
        sessionKey: normalizedSessionKey,
        signal: opts?.signal,
        timeoutMs,
      })
    : { settled: true };
}

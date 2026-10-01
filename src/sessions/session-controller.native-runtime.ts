import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import {
  getActiveNativeAttempt,
  getEmbeddedRunAttachment,
  type EmbeddedAgentQueueHandle,
} from "../agents/embedded-agent-runner/run-state.js";
import { diagnosticLogger as diag } from "../logging/diagnostic.js";
import {
  waitForReplyOperationOwnerSettlement,
  waitForReplyRunEndBySessionId,
} from "./session-controller.settlement.js";

/** Reports whether the current native attempt is streaming output. */
export function isSessionNativeAttemptStreaming(sessionId: string): boolean {
  return getActiveNativeAttempt(sessionId)?.isStreaming() ?? false;
}

/** Joins one captured native attempt without observing a same-ID successor. */
export async function waitForSessionNativeAttemptEnd(
  sessionId: string,
  timeoutMs: number | null,
  handle: EmbeddedAgentQueueHandle | undefined,
): Promise<boolean> {
  const registration = handle ? getEmbeddedRunAttachment(handle) : undefined;
  if (!registration) {
    return true;
  }
  const settled = registration.settlement.promise.then(() => true);
  if (timeoutMs === null) {
    return await settled;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      settled,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(
          () => {
            diag.warn(`wait timeout: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
            resolve(false);
          },
          resolveTimerTimeoutMs(timeoutMs, 100, 100),
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** Joins the exact native attempt and controller owner captured for a session run. */
export async function waitForSessionRunEnd(
  sessionId: string,
  timeoutMs: number | null = 15_000,
): Promise<boolean> {
  const handle = getActiveNativeAttempt(sessionId);
  const operation = handle ? getEmbeddedRunAttachment(handle)?.operation : undefined;
  const nativeSettlement = waitForSessionNativeAttemptEnd(sessionId, timeoutMs, handle);
  const ownerSettlement = operation
    ? timeoutMs === null
      ? operation.ownerSettlement.then(() => true)
      : waitForReplyOperationOwnerSettlement(operation, timeoutMs)
    : handle
      ? Promise.resolve(true)
      : waitForReplyRunEndBySessionId(sessionId, timeoutMs);
  const [nativeSettled, ownerSettled] = await Promise.all([nativeSettlement, ownerSettlement]);
  return nativeSettled && ownerSettled;
}

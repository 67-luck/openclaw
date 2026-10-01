import {
  isAgentRunRestartAbortReason,
  isAgentRunSupersededAbortReason,
} from "../agents/run-termination.js";
import type { ReplyOperation, ReplyBackendCancelReason } from "./session-controller.contracts.js";
type AbortCode = Extract<NonNullable<ReplyOperation["result"]>, { kind: "aborted" }>["code"];

/** Binds the original upstream reason to this exact admitted operation. */
export function bindReplyOperationUpstreamAbort(
  operation: ReplyOperation,
  signal: AbortSignal,
  abortOperation: (reason: ReplyBackendCancelReason, cause: unknown, code: AbortCode) => void,
): (() => void) | undefined {
  const abortFromUpstream = () => {
    if (operation.result) {
      return;
    }
    const restart = isAgentRunRestartAbortReason(signal.reason);
    const superseded = isAgentRunSupersededAbortReason(signal.reason);
    abortOperation(
      restart ? "restart" : superseded ? "superseded" : "user_abort",
      signal.reason,
      restart ? "aborted_for_restart" : superseded ? "aborted_for_supersession" : "aborted_by_user",
    );
  };
  if (signal.aborted) {
    abortFromUpstream();
    return undefined;
  }
  signal.addEventListener("abort", abortFromUpstream, { once: true });
  return abortFromUpstream;
}

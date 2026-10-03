/** Active-run queue admission for prepared reply turns. */
import type { ReplyPayload } from "../types.js";
import type { QueueSettings } from "./queue.js";

export const REPLY_RUN_STILL_SHUTTING_DOWN_TEXT =
  "⚠️ Previous run is still shutting down. Please try again in a moment.";

/** Waits for admitted active work and returns guidance if it still has not settled. */
export async function waitForPreparedReplyQueue(params: {
  activeSessionId: string;
  queueMode: QueueSettings["mode"];
  interruptActiveRun: () => Promise<boolean>;
  waitForActiveRunEnd: (sessionId: string) => Promise<unknown>;
  refreshPreparedState: () => Promise<void>;
  resolveBusyState: () => { isActive: boolean };
}): Promise<ReplyPayload | undefined> {
  if (params.queueMode === "interrupt") {
    // An idle run slot is not evidence that its former writer settled. In
    // particular a watchdog can release the slot while delivery still owns I/O.
    if (!(await params.interruptActiveRun())) {
      return { kind: "reply", reply: { text: REPLY_RUN_STILL_SHUTTING_DOWN_TEXT } };
    }
  } else {
    await params.waitForActiveRunEnd(params.activeSessionId);
  }
  await params.refreshPreparedState();
  return params.resolveBusyState().isActive
    ? { text: REPLY_RUN_STILL_SHUTTING_DOWN_TEXT }
    : undefined;
}

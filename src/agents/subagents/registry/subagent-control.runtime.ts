/** Runtime adapters consume the physical controller owner, never a global session-ID vote. */
import { selectedOperations } from "../../../sessions/session-controller.lifecycle-projections.js";
import {
  cancelCapturedSessionControllerSource,
  captureSessionControllerStop,
} from "../../../sessions/session-controller.stop.js";
import type { SessionTarget } from "../../../sessions/session-controller.target.js";
export { clearSessionQueues } from "../../../auto-reply/reply/queue.js";

export function isTargetSessionRunActive(sessionId: string, target: SessionTarget): boolean {
  return [...selectedOperations([target])].some(
    (operation) => operation.hasOwnedSessionId(sessionId) && !operation.result,
  );
}

export function abortEmbeddedAgentRun(sessionId: string, target: SessionTarget): boolean {
  const capture = captureSessionControllerStop({
    operations: [...selectedOperations([target])].filter((operation) =>
      operation.hasOwnedSessionId(sessionId),
    ),
  });
  return cancelCapturedSessionControllerSource(capture).activeCancelled > 0;
}

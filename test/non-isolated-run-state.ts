import {
  activeNativeAttempts,
  captureEmbeddedRunCleanupOwners,
  getEmbeddedRunAttachment,
} from "../src/agents/embedded-agent-runner/run-state.js";
import { waitForSessionControllerSettlement } from "../src/sessions/session-controller.lifecycle-observation.js";
import { SESSION_CONTROLLER_DRAIN_TIMEOUT_MS } from "../src/sessions/session-controller.lifecycle.js";
import {
  captureSessionControllerStop,
  captureSessionControllerStopCandidates,
  stopSession,
} from "../src/sessions/session-controller.stop.js";

function cleanupFailure(message: string, cause?: unknown): Error {
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

/** Stops current run owners and joins their producers before test module invalidation. */
export async function drainNonIsolatedRunState(): Promise<void> {
  const candidates = captureSessionControllerStopCandidates();
  const cleanupOwners = captureEmbeddedRunCleanupOwners();
  const nativeAttempts = [...activeNativeAttempts()].map(([sessionId, handle]) => {
    const attachment = getEmbeddedRunAttachment(handle);
    if (!attachment) {
      throw new Error(`Active native attempt lost its attachment: ${sessionId}`);
    }
    return { sessionId, handle, attachment };
  });
  const nativeSettlements = nativeAttempts.map(({ attachment }) =>
    Promise.all([attachment.settlement.promise, attachment.runCleanupSettlement]),
  );
  const detachedAttempts = nativeAttempts.filter(({ attachment }) => !attachment.operation);
  const capture = captureSessionControllerStop({
    inputs: candidates.flatMap((candidate) => candidate.capture.inputs),
    operations: candidates.flatMap((candidate) => candidate.capture.operations),
  });
  const failures: Error[] = [];
  const settlements: Promise<unknown>[] = [
    ...nativeSettlements,
    ...cleanupOwners.map((owner) => owner.settlement),
  ];

  if (capture.inputs.length > 0 || capture.operations.length > 0) {
    settlements.push(capture.settled);
    try {
      const execution = stopSession({
        source: "restart",
        capture,
        onError: () => "continue",
      });
      settlements.push(
        execution.completed.then((outcome) => {
          for (const failure of outcome.failures) {
            failures.push(cleanupFailure("Session-controller Stop cleanup failed", failure.error));
          }
          return outcome.settled;
        }),
      );
    } catch (error) {
      failures.push(cleanupFailure("Session-controller Stop failed", error));
    }
  }

  for (const { handle } of detachedAttempts) {
    try {
      if (handle.isAbortable?.() !== false) {
        handle.abort("restart");
      }
    } catch (error) {
      failures.push(cleanupFailure("Detached embedded run cleanup failed", error));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Run cancellation failed; refusing module invalidation");
  }

  const observed = settlements.map((settlement) =>
    settlement.catch((error: unknown) => {
      failures.push(cleanupFailure("Run producer settlement failed", error));
    }),
  );
  const settled = await waitForSessionControllerSettlement(
    Promise.all(observed).then(() => undefined),
    SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
  );
  if (!settled) {
    const pending = new Error(
      `Run cleanup remains pending after ${SESSION_CONTROLLER_DRAIN_TIMEOUT_MS}ms; refusing module invalidation`,
    );
    if (failures.length > 0) {
      throw new AggregateError(
        [...failures, pending],
        "Run cleanup failed and remains pending; refusing module invalidation",
      );
    }
    throw pending;
  }
  for (const owner of cleanupOwners) {
    owner.acknowledge();
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Run cleanup failed; refusing module invalidation");
  }
}

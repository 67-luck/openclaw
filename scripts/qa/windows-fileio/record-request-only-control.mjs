import assert from "node:assert/strict";
import { verifyDeletionControl } from "./verify-deletion-control.mjs";

export function recordRequestOnlyControl(input) {
  const { cell, observer, identity } = input;
  const observation = cell.observation;
  assert.equal(cell.enabledAcknowledged, true);
  assert.equal(cell.targetJoinedAtObserverCompletion, false);
  assert.ok(observer.receipt.joined && observer.receipt.jobObserved);
  assert.equal(observation?.pid, identity.pid);
  assert.equal(observation?.nativeStartFileTime, identity.nativeStartFileTime);
  assert.equal(observation?.postStopAdmission?.state, "Live");
  assert.equal(observation.postStopAdmission.admitted, true);
  assert.equal(observation.projectionStarted, true);
  assert.equal(observation.threadCoverage?.after, "completed");
  // These describe incomplete host-wide coverage; no rejected event is admitted.
  assert.ok(
    observation.partial.every((reason) =>
      [
        "irp-reuse-without-end",
        "owned-requests-without-path",
        "unverified-issuing-threads",
      ].includes(reason),
    ),
    "Unexpected capture or admission failure",
  );
  const facts = observer.records.find((record) => record.phase === "owned-begin-facts");
  assert.equal(facts?.diagnosticOnly, true);
  assert.equal(facts.unavailable, false);
  assert.equal(facts.priorityTruncated, false);
  assert.ok(facts.events.length <= 16);
  assert.ok(Buffer.byteLength(JSON.stringify(facts)) <= 32768);
  const start = Date.parse(observation.captureInterval?.startedAt);
  const end = Date.parse(observation.captureInterval?.endedAt);
  assert.ok(Number.isFinite(start) && Number.isFinite(end) && start <= end);
  const request = facts.events
    .map((event) => event.requestEvent)
    .find(
      (event) =>
        event?.evidenceKind === "request-event-only" &&
        event.pathProvenance === "explicit-FilePath" &&
        event.pid === identity.pid &&
        event.nativeStartFileTime === identity.nativeStartFileTime &&
        Number.isInteger(event.threadId) &&
        event.threadId > 0 &&
        event.threadId <= 0xffffffff &&
        event.relativeTarget === "koffi.node" &&
        event.eventId === 26 &&
        event.eventVersion === 1 &&
        [13, 64].includes(event.infoClass) &&
        Date.parse(event.eventAt) >= start &&
        Date.parse(event.eventAt) <= end &&
        event.completion === "unknown" &&
        event.ntStatus === null,
    );
  const fixture = input.target.records.find((record) => record.event === "result");
  if (fixture) {
    const { pid, mode, operation, target, unlinkCode, beganAt, endedAt } = fixture;
    cell.unlinkResult = { pid, mode, operation, target, unlinkCode, beganAt, endedAt };
  }
  assert.ok(request, "No admitted explicit-path deletion request event was observed");
  // The existing verifier still owns all completed-deletion and capture checks.
  // Only its final missing-completion assertion permits diagnostic continuation.
  try {
    verifyDeletionControl(input);
  } catch (error) {
    if (
      !(error instanceof assert.AssertionError) ||
      error.code !== "ERR_ASSERTION" ||
      error.message !== "No deletion-disposition completion was attributed" ||
      error.operator !== "==" ||
      error.actual !== false ||
      error.expected !== true
    ) {
      throw error;
    }
    cell.completedDeletionFailure = {
      name: error.name,
      code: error.code,
      message: error.message,
      operator: error.operator,
      actual: error.actual,
      expected: error.expected,
    };
    cell.requestEventEvidence = request;
    return;
  }
  throw new Error("Unexpected completed-deletion verdict requires review");
}

import assert from "node:assert/strict";

export function verifyDeletionControl({ cell, observer, target, identity, fixtureMode }) {
  assert.equal(cell.observerCode, 0);
  cell.withinFiveSeconds = observer.receipt.elapsedMs <= 5000;
  assert.equal(cell.withinFiveSeconds, true);
  const observation = cell.observation;
  assert.equal(observation?.cleanupVerified, true);
  assert.equal(observation?.loss?.statisticsKnown, true);
  assert.equal(
    observation.loss.eventsLost +
      observation.loss.logBuffersLost +
      observation.loss.realTimeBuffersLost,
    0,
  );
  assert.equal(observation.observation, "attributed");
  if (
    observation.threadCoverage?.after !== "completed" ||
    observation.counts?.unresolvedThreads > 0
  ) {
    assert.equal(
      observation.coverageComplete,
      false,
      "Unknown thread coverage must remain partial",
    );
  }
  const fixture = target.records.find((record) => record.event === "result");
  assert.ok(fixture, "The controlled unlink must have completed");
  assert.equal(fixture.pid, identity.pid);
  assert.equal(fixture.mode, fixtureMode);
  assert.equal(fixture.operation, "unlink");
  assert.equal(fixture.target, "koffi.node");
  assert.equal(fixture.unlinkCode, fixtureMode === "loaded" ? "EPERM" : null);
  // Kernel-File events 17/18/26 identify set-information/delete/path requests;
  // only disposition classes 13/64 establish deletion, not an open precursor.
  const deletionCompletions = observation.records.filter(
    (row) =>
      row.pid === identity.pid &&
      row.nativeStartFileTime === identity.nativeStartFileTime &&
      row.relativeTarget === "koffi.node" &&
      [17, 18, 26].includes(row.eventId) &&
      [13, 64].includes(Number(row.infoClass)) &&
      /^0x[0-9a-f]{8}$/iu.test(row.ntStatus) &&
      (fixtureMode === "loaded"
        ? Number(row.ntStatus) >= 0x80000000
        : row.ntStatus === "0x00000000"),
  );
  assert.ok(deletionCompletions.length > 0, "No deletion-disposition completion was attributed");
  cell.deletionCompletions = deletionCompletions;
  cell.unlinkResult = fixture;
}

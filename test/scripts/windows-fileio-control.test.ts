import { describe, expect, it } from "vitest";
import { verifyDeletionControl } from "../../scripts/qa/windows-fileio/verify-deletion-control.mjs";

function control(mode: "loaded" | "unloaded", eventId = 18, infoClass = "64") {
  const identity = { pid: 1234, nativeStartFileTime: "133000000000000000" };
  const row = {
    ...identity,
    relativeTarget: "koffi.node",
    eventId,
    infoClass,
    ntStatus: mode === "loaded" ? "0xC0000121" : "0x00000000",
  };
  return {
    identity,
    fixtureMode: mode,
    observer: { receipt: { elapsedMs: 1900 } },
    target: {
      records: [
        {
          event: "result",
          pid: identity.pid,
          mode,
          operation: "unlink",
          target: "koffi.node",
          unlinkCode: mode === "loaded" ? "EPERM" : null,
        },
      ],
    },
    cell: {
      observerCode: 0,
      observation: {
        observation: "attributed",
        cleanupVerified: true,
        coverageComplete: false,
        partial: ["thread-refresh-incomplete"],
        loss: { statisticsKnown: true, eventsLost: 0, logBuffersLost: 0, realTimeBuffersLost: 0 },
        records: [row],
      },
    },
  };
}

describe("native deletion control qualification", () => {
  it.each(["loaded", "unloaded"] as const)(
    "accepts a completed %s deletion with explicit partial coverage",
    (mode) => {
      const input = control(mode);
      expect(() => verifyDeletionControl(input)).not.toThrow();
      expect(input.cell).toHaveProperty("deletionCompletions", input.cell.observation.records);
      expect(input.cell).toHaveProperty("unlinkResult", input.target.records[0]);
    },
  );

  it.each([
    [12, "64"],
    [14, "13"],
    [17, "4"],
  ])("rejects event %s class %s as deletion proof", (eventId, infoClass) => {
    expect(() => verifyDeletionControl(control("loaded", eventId, infoClass))).toThrow(
      "No deletion-disposition completion",
    );
  });

  it("requires the actual unlink result as well as ETW status", () => {
    const input = control("loaded");
    input.target.records = [];
    expect(() => verifyDeletionControl(input)).toThrow("controlled unlink must have completed");
  });

  it("does not claim complete coverage when thread verification is unavailable", () => {
    const input = control("unloaded");
    input.cell.observation.coverageComplete = true;
    expect(() => verifyDeletionControl(input)).toThrow(
      "Unknown thread coverage must remain partial",
    );
  });

  it("does not accept a pending status as completed deletion", () => {
    const input = control("unloaded");
    input.cell.observation.records[0].ntStatus = "0x00000103";
    expect(() => verifyDeletionControl(input)).toThrow("No deletion-disposition completion");
  });

  it("does not qualify failed or slow observers after cleanup", () => {
    const input = control("unloaded");
    input.cell.observerCode = 2;
    expect(() => verifyDeletionControl(input)).toThrow();
    input.cell.observerCode = 0;
    input.observer.receipt.elapsedMs = 5001;
    expect(() => verifyDeletionControl(input)).toThrow();
  });
});

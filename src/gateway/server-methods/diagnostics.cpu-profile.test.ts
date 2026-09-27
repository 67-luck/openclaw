import { afterEach, beforeEach, describe, vi } from "vitest";
import type { captureDiagnosticCpuProfile } from "../../logging/diagnostic-cpu-profile.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { registerDiagnosticProfileDispatchTests } from "./diagnostics.profile.test-support.js";

const capture = vi.hoisted(() => vi.fn());
vi.mock("../../logging/diagnostic-cpu-profile.js", () => ({
  captureDiagnosticCpuProfile: capture,
}));

const result = {
  requestedDurationMs: 5_000,
  actualDurationMs: 5_015,
  startBlockedMs: 2_100,
  samplingIntervalMicros: 10_000,
  sampleLossCount: null,
  redactedNodeCount: 1,
  profile: {
    nodes: [
      {
        id: 1,
        callFrame: {
          functionName: "(root)",
          scriptId: "0",
          url: "",
          lineNumber: -1,
          columnNumber: -1,
        },
        children: [2],
      },
      {
        id: 2,
        callFrame: {
          functionName: "[redacted]",
          scriptId: "12",
          url: "",
          lineNumber: -10,
          columnNumber: -200,
        },
        positionTicks: [{ line: -9, ticks: 1 }],
      },
    ],
    startTime: 0,
    endTime: 5_015_000,
    samples: [2],
    timeDeltas: [10_000],
  },
};

beforeEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  capture
    .mockReset()
    .mockResolvedValue({ status: "complete", result } satisfies Awaited<
      ReturnType<typeof captureDiagnosticCpuProfile>
    >);
});
afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

describe("diagnostics.cpuProfile dispatch", () => {
  registerDiagnosticProfileDispatchTests({
    method: "diagnostics.cpuProfile",
    requestId: "cpu-profile",
    capture,
    result,
    validParams: [undefined, {}],
    validParamsTitle: "preserves signed-origin profiles for admin requests with empty params %j",
    invalidParams: [null, [], "", 1, { durationMs: 1 }, { filename: "profile" }],
    invalidParamsTitle: "rejects nonempty/nonobject params %j before capture",
    captureFailedMessage: "CPU profile unavailable: capture-failed",
    tracingActiveMessage:
      "CPU profile unavailable: stop active Node tracing, including non-CPU categories, before requesting a profile",
  });
});

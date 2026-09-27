import { afterEach, beforeEach, describe, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { registerDiagnosticProfileDispatchTests } from "./diagnostics.profile.test-support.js";

const capture = vi.hoisted(() => vi.fn());
vi.mock("../../logging/diagnostic-heap-profile.js", () => ({
  captureDiagnosticHeapProfile: capture,
}));

const result = {
  durationMs: 5_000,
  samplingIntervalBytes: 32_768,
  heapUsedBefore: 100,
  heapUsedAfter: 200,
  rssBefore: 300,
  rssAfter: 400,
  truncated: false,
};

beforeEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  capture.mockReset().mockResolvedValue({ status: "complete", result });
});
afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

describe("diagnostics.heapProfile dispatch", () => {
  registerDiagnosticProfileDispatchTests({
    method: "diagnostics.heapProfile",
    requestId: "heap-profile",
    capture,
    result,
    validParams: [undefined, {}, { durationMs: 200, samplingIntervalBytes: 4096 }],
    validParamsTitle:
      "serves allocation attribution through the registered admin RPC with params %j",
    invalidParams: [
      null,
      [],
      "",
      1,
      { durationMs: 0 },
      { durationMs: 1.5 },
      { durationMs: "5" },
      { samplingIntervalBytes: -1 },
      { samplingIntervalBytes: Infinity },
      { filename: "profile" },
    ],
    invalidParamsTitle: "rejects invalid params %j before capture",
    captureFailedMessage: "Heap profile unavailable: capture-failed",
    tracingActiveMessage:
      "Heap profile unavailable: stop active Node tracing, including non-CPU categories, before requesting a profile",
  });
});

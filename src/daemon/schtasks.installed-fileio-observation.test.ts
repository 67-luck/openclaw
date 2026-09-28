import assert from "node:assert/strict";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { compileFunction } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createInstalledTerminalJsonCapture } from "./schtasks.installed-command.test-support.js";
import { createInstalledFileIoDescriptorFixture } from "./schtasks.installed-fileio-fixtures.test-support.js";
import { readInstalledFileIoObservation } from "./schtasks.installed-fileio-observation.test-support.js";
import {
  buildInstalledUpdateRetirementCensus,
  type InstalledUpdateRetirementBinding,
} from "./schtasks.installed-retirement-observation.test-support.js";
import {
  buildInstalledCensusInvocation,
  readRelatedProcessDiagnosticsResult,
} from "./schtasks.integration-observation.test-support.js";

function input() {
  const pin = { pid: 1234, startTicks: "134350962258102430" };
  const identity = { pid: pin.pid, nativeStartFileTime: pin.startTicks };
  const terminal = createInstalledTerminalJsonCapture((value) => value);
  terminal.observe(
    JSON.stringify({ status: "ok", mode: "npm", steps: [], durationMs: 0 }, null, 2) + "\n",
    false,
    Date.parse("2026-09-28T00:00:00Z"),
  );
  const terminalJson = terminal.current();
  assert.ok(terminalJson);
  const binding: InstalledUpdateRetirementBinding = {
    launcherPid: 1200,
    commandPid: 1234,
    commandStartedAtMs: 1,
    commandSpawnedAtMs: 2,
    entry: "C:\\owned\\entry.cjs",
    profile: "synthetic",
    expectedNodeExe: "C:\\node.exe",
    expectedArgv: ["C:\\owned\\entry.cjs", "--profile", "synthetic", "update"],
    runId: "synthetic",
    runCreatedAtMs: 3,
    globalRoot: "C:\\owned",
    pinnedProcess: pin,
    fileIo: {
      ...createInstalledFileIoDescriptorFixture("C:\\owned"),
      trigger: {
        ledgerObservedAtMs: Date.parse("2026-09-28T00:00:00Z"),
        terminalJson,
      },
    },
  };
  const requestEvent = {
    ...identity,
    evidenceKind: "request-event-only",
    pathProvenance: "explicit-FilePath",
    threadId: 22,
    relativeTarget: ".openclaw.package-backup-1234-1790473504245\\koffi.node",
    eventId: 26,
    eventVersion: 1,
    infoClass: 64,
    eventAt: "2026-09-28T00:00:02.0000001Z",
    completion: "unknown",
    ntStatus: null,
  };
  const facts = {
    phase: "owned-begin-facts",
    diagnosticOnly: true,
    unavailable: false,
    truncated: true,
    priorityTruncated: false,
    nonPriorityTruncated: true,
    events: [{ requestEvent }],
  };
  const result = {
    ...identity,
    phase: "result",
    observation: "insufficient-evidence",
    coverageComplete: false,
    cleanupVerified: true,
    identityRefused: false,
    projectionStarted: true,
    elapsedMs: 2100,
    rawArtifactUploadAllowed: false,
    partial: ["irp-reuse-without-end"],
    records: [],
    counts: {
      parsed: 10,
      ownBegins: 2,
      unmatchedEnds: 0,
      unresolvedTargets: 0,
      unresolvedThreads: 0,
      outOfScope: 0,
    },
    threadCoverage: { before: "held-native-handles", after: "completed", maximumHandles: 256 },
    captureInterval: { startedAt: "2026-09-28T00:00:01Z", endedAt: "2026-09-28T00:00:03Z" },
    postStopAdmission: {
      state: "Live",
      admitted: true,
      nativeError: null,
      waitStatus: 258,
      reason: null,
    },
    loss: {
      statisticsKnown: true,
      stopStatus: 0,
      eventsLost: 0,
      logBuffersLost: 0,
      realTimeBuffersLost: 0,
      buffersWritten: 3,
    },
  };
  return {
    binding,
    requestEvent,
    facts,
    result,
    outcome: { exitCode: 0, records: [facts, result] },
  };
}

describe("installed FileIO receiving boundary", () => {
  it("retains only bound request presence and explicit partiality", () => {
    const value = input();
    Object.assign(value.requestEvent, { rawPointer: "HOST_PRIVATE_CANARY" });
    Object.assign(value.facts, { allHostEvents: "HOST_PRIVATE_CANARY" });
    const read = readInstalledFileIoObservation(value.outcome, value.binding);
    assert.ok("result" in read);
    expect(read.result?.observation).toBe("insufficient-evidence");
    expect(read.facts?.events[0]?.requestEvent).toMatchObject({
      completion: "unknown",
      ntStatus: null,
      infoClass: 64,
    });
    expect(read.facts?.nonPriorityTruncated).toBe(true);
    expect(read.result?.partial).toContain("irp-reuse-without-end");
    expect(JSON.stringify(read)).not.toContain("HOST_PRIVATE_CANARY");
  });

  it.each([
    "pin",
    "request-pid",
    "request-start",
    "absolute-path",
    "traversal",
    "outside-window",
    "pre-terminal",
    "wrong-class",
    "wrong-version",
    "row-cap",
  ])("refuses %s without retaining native payload", (scenario) => {
    const value = input();
    if (scenario === "request-pid") {
      value.requestEvent.pid++;
    }
    if (scenario === "request-start") {
      value.requestEvent.nativeStartFileTime = "134350962258102431";
    }
    if (scenario === "absolute-path") {
      value.requestEvent.relativeTarget = "C:\\foreign\\HOST_PRIVATE_CANARY";
    }
    if (scenario === "traversal") {
      value.requestEvent.relativeTarget = "..\\HOST_PRIVATE_CANARY";
    }
    if (scenario === "outside-window") {
      value.requestEvent.eventAt = "2026-09-28T00:00:04Z";
    }
    if (scenario === "pre-terminal") {
      value.result.captureInterval.startedAt = "2026-09-27T23:59:59Z";
    }
    if (scenario === "wrong-class") {
      value.requestEvent.infoClass = 4;
    }
    if (scenario === "wrong-version") {
      value.requestEvent.eventVersion = 0;
    }
    if (scenario === "row-cap") {
      value.facts.events = Array.from({ length: 17 }, () => ({ requestEvent: value.requestEvent }));
    }
    const read = readInstalledFileIoObservation(value.outcome, {
      ...value.binding,
      ...(scenario === "pin" ? { pinnedProcess: undefined } : {}),
    });
    expect(read).toMatchObject({ unavailable: expect.any(String) });
    expect(read).not.toHaveProperty("result");
    expect(read).not.toHaveProperty("facts");
    expect(JSON.stringify(read)).not.toContain("HOST_PRIVATE_CANARY");
  });
});

it.each([false, true])(
  "sends the real census through bounded stdin (oversized=%s)",
  (oversized) => {
    const source = readFileSync(
      new URL("./schtasks.integration-observation.test-support.ts", import.meta.url),
      "utf8",
    );
    const begin = source.indexOf("export function readRelatedProcessDiagnostics(");
    const end = source.indexOf("\nexport function ", begin + 1);
    assert.ok(begin >= 0 && end > begin);
    const declaration = stripTypeScriptTypes(source.slice(begin, end).replace("export ", ""));
    const owned = "C:\\private-診断-é";
    const binding = {
      ...input().binding,
      globalRoot: owned,
      expectedArgv: [oversized ? "診".repeat(400_000) : "native-script-canary-診断-é"],
    };
    const spawn = vi
      .fn<
        (
          file: string,
          args: string[],
          options: SpawnSyncOptionsWithStringEncoding,
        ) => { status: number; stdout: string; stderr: string }
      >()
      .mockReturnValue({
        status: 0,
        stdout: JSON.stringify({
          retirement: null,
          processes: [
            { ProcessId: 1234, ParentProcessId: 0, CommandLine: `node ${owned}\\entry.cjs` },
            { ProcessId: 9999, ParentProcessId: 0, CommandLine: "host-foreign-canary" },
          ],
        }),
        stderr: "",
      });
    const invoke = compileFunction(`${declaration}\nreturn readRelatedProcessDiagnostics;`, [
      "spawnSync",
      "getWindowsPowerShellExePath",
      "buildInstalledUpdateRetirementCensus",
      "buildInstalledCensusInvocation",
      "readRelatedProcessDiagnosticsResult",
    ])(
      spawn,
      () => "powershell.exe",
      buildInstalledUpdateRetirementCensus,
      buildInstalledCensusInvocation,
      readRelatedProcessDiagnosticsResult,
    );
    if (oversized) {
      expect(() => invoke([owned], binding)).toThrow("Census input exceeds its byte bound");
      expect(spawn).not.toHaveBeenCalled();
      return;
    }
    const result = invoke([owned], binding);
    expect(result.processes).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("host-foreign-canary");
    const script = buildInstalledUpdateRetirementCensus(binding);
    expect(Buffer.from(script, "utf16le").toString("base64").length).toBeGreaterThan(32767);
    const [, args, options] = spawn.mock.calls[0]!;
    expect(options.input).toBe(script);
    expect(options).toMatchObject({ encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
    expect(args.join(" ").length).toBeLessThan(1024);
    expect(args.join(" ")).not.toContain("native-script-canary");
  },
);

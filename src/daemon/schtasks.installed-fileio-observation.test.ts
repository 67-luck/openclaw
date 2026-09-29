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

function input(extraRecords: unknown[] = []) {
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
    outcome: { exitCode: 0, records: [facts, result, ...extraRecords] },
  };
}

function filterCensus(selectionReason: "header-pid" | "owned-path" = "header-pid") {
  const counts = () =>
    Object.fromEntries([10, 11, 12, 13, 14, 15, 17, 18, 24, 26].map((id) => [id, 0]));
  const relevantEventCounts = counts();
  const headerPidMatchCounts = counts();
  relevantEventCounts[26] = 1;
  headerPidMatchCounts[26] = selectionReason === "header-pid" ? 1 : 0;
  const row = {
    eventId: 26,
    eventVersion: 1,
    selectionReason,
    headerPidMatched: selectionReason === "header-pid",
    priorityEventFamily: true,
    timeWindowMatched: true,
    processLifetimeMatched: true,
    processTime: {
      querySucceeded: true,
      nativeError: null,
      creationMatches: true,
      eventNotBeforeCreation: true,
      exitTimePresent: false,
      eventNotAfterExit: null,
    },
    issuingThreadVerified: false,
    fieldPresence: {
      Irp: true,
      IrpPtr: false,
      FileObject: true,
      FileKey: true,
      IssuingThreadId: true,
      TTID: false,
      ThreadId: false,
      Status: false,
      FileName: false,
      OpenPath: false,
      FilePath: true,
      CreateOptions: false,
      InfoClass: true,
    },
    irpValueNonzero: true,
    fieldShapeUnavailable: false,
    filterReason: "unverified-issuing-thread",
  };
  const census = {
    phase: "filter-census",
    diagnosticOnly: true,
    meaning:
      "provider event counts; header PID or explicit owned-path selection grants no process, thread, or operation authority",
    relevantEventCounts,
    headerPidMatchCounts,
    filterReasonCounts: {
      "outside-capture-window": 0,
      "outside-original-lifetime": 0,
      "unknown-schema": 0,
      "name-event": 0,
      "completion-event": 0,
      "missing-or-zero-irp": 0,
      "missing-issuing-thread": 0,
      "unverified-issuing-thread": 1,
      "outside-owned-path": 0,
      "unresolved-target": 0,
      "request-retained": 0,
      "processing-interrupted": 0,
    },
    events: [row],
    unavailable: false,
    truncated: false,
    priorityTruncated: false,
    nonPriorityTruncated: false,
    rowLimit: 32,
    byteLimit: 32768,
    countKeyLimit: 32,
    priorityRowLimit: 16,
    nonPriorityRowLimit: 16,
  };
  return { census, row };
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

  it.each(["header-pid", "owned-path"] as const)(
    "retains %s filter facts through the real census receiver without admitting an owned request",
    (selectionReason) => {
      const { census } = filterCensus(selectionReason);
      const value = input([census]);
      value.facts.events = [];
      value.result.counts.ownBegins = 0;
      value.result.counts.unresolvedThreads = 86;
      value.result.partial = ["unverified-issuing-threads"];
      const read = readRelatedProcessDiagnosticsResult(
        {
          status: 0,
          stdout: JSON.stringify({ processes: [], retirement: null, fileIo: value.outcome }),
          stderr: "",
        },
        [value.binding.globalRoot],
        value.binding,
      );
      assert.ok("fileIo" in read);
      expect(read.fileIo).toMatchObject({
        result: {
          observation: "insufficient-evidence",
          records: [],
          counts: { ownBegins: 0, unresolvedThreads: 86 },
        },
        facts: { events: [] },
        filterCensus: {
          phase: "filter-census",
          diagnosticOnly: true,
          unavailable: false,
          relevantEventCounts: { "26": 1 },
          headerPidMatchCounts: { "26": selectionReason === "header-pid" ? 1 : 0 },
          filterReasonCounts: { "unverified-issuing-thread": 1 },
          events: [
            {
              eventId: 26,
              selectionReason,
              headerPidMatched: selectionReason === "header-pid",
              issuingThreadVerified: false,
              filterReason: "unverified-issuing-thread",
              processTime: { eventNotAfterExit: null },
            },
          ],
        },
      });
    },
  );

  it.each(["FileName", "OpenPath", "FilePath"] as const)(
    "retains owned-path %s presence within an exited process lifetime without granting authority",
    (field) => {
      const { census, row } = filterCensus("owned-path");
      row.fieldPresence.FilePath = false;
      row.fieldPresence[field] = true;
      Object.assign(row.processTime, { exitTimePresent: true, eventNotAfterExit: true });
      Object.assign(row, { rawPath: "HOST_PRIVATE_CENSUS_CANARY", rawPid: 987654 });
      const value = input([census]);
      value.facts.events = [];
      const read = readInstalledFileIoObservation(value.outcome, value.binding);
      expect(read).toMatchObject({
        result: { observation: "insufficient-evidence", records: [] },
        facts: { events: [] },
        filterCensus: {
          unavailable: false,
          events: [
            {
              selectionReason: "owned-path",
              headerPidMatched: false,
              issuingThreadVerified: false,
              processTime: { exitTimePresent: true, eventNotAfterExit: true },
            },
          ],
        },
      });
      expect(JSON.stringify(read)).not.toContain("HOST_PRIVATE_CENSUS_CANARY");
      expect(JSON.stringify(read)).not.toContain("987654");
    },
  );

  it.each([
    "header-matched",
    "window-false",
    "window-unknown",
    "lifetime-false",
    "lifetime-unknown",
    "process-time-missing",
    "query-failed",
    "creation-mismatch",
    "creation-unknown",
    "before-creation",
    "creation-window-unknown",
    "exit-unknown",
    "after-exit",
    "exit-comparison-unknown",
    "missing-explicit-path",
    "incomplete-shape",
    "outside-capture-window",
    "outside-original-lifetime",
    "unknown-schema",
  ])(
    "refuses inconsistent owned-path %s diagnostics without changing results or request facts",
    (scenario) => {
      const { census, row } = filterCensus("owned-path");
      const value = input([census]);
      const before = readInstalledFileIoObservation(value.outcome, value.binding);
      expect(before).toHaveProperty("filterCensus.events.0.selectionReason", "owned-path");
      if (scenario === "header-matched") {
        row.headerPidMatched = true;
      }
      if (scenario === "window-false") {
        row.timeWindowMatched = false;
      }
      if (scenario === "window-unknown") {
        Object.assign(row, { timeWindowMatched: null });
      }
      if (scenario === "lifetime-false") {
        row.processLifetimeMatched = false;
      }
      if (scenario === "lifetime-unknown") {
        Object.assign(row, { processLifetimeMatched: null });
      }
      if (scenario === "process-time-missing") {
        Object.assign(row, { processTime: null });
      }
      if (scenario === "query-failed") {
        row.processTime.querySucceeded = false;
      }
      if (scenario === "creation-mismatch") {
        row.processTime.creationMatches = false;
      }
      if (scenario === "creation-unknown") {
        Object.assign(row.processTime, { creationMatches: null });
      }
      if (scenario === "before-creation") {
        row.processTime.eventNotBeforeCreation = false;
      }
      if (scenario === "creation-window-unknown") {
        Object.assign(row.processTime, { eventNotBeforeCreation: null });
      }
      if (scenario === "exit-unknown") {
        Object.assign(row.processTime, { exitTimePresent: null });
      }
      if (scenario === "after-exit") {
        Object.assign(row.processTime, { exitTimePresent: true, eventNotAfterExit: false });
      }
      if (scenario === "exit-comparison-unknown") {
        Object.assign(row.processTime, { exitTimePresent: true, eventNotAfterExit: null });
      }
      if (scenario === "missing-explicit-path") {
        row.fieldPresence.FilePath = false;
      }
      if (scenario === "incomplete-shape") {
        row.fieldShapeUnavailable = true;
      }
      if (
        ["outside-capture-window", "outside-original-lifetime", "unknown-schema"].includes(scenario)
      ) {
        row.filterReason = scenario;
      }
      const read = readInstalledFileIoObservation(value.outcome, value.binding);
      assert.ok("result" in before && "result" in read);
      expect(read.result).toEqual(before.result);
      expect(read.facts).toEqual(before.facts);
      expect(read).toHaveProperty("filterCensus", {
        phase: "filter-census",
        diagnosticOnly: true,
        unavailable: true,
      });
    },
  );

  it("strips raw diagnostic canaries while preserving fixed nullable observations", () => {
    const { census, row } = filterCensus();
    const canary = "HOST_PRIVATE_CENSUS_CANARY";
    Object.assign(census, { rawHostEvents: canary });
    Object.assign(row, {
      pointer: canary,
      threadId: canary,
      filePath: canary,
      timeWindowMatched: null,
      processLifetimeMatched: null,
      issuingThreadVerified: null,
      irpValueNonzero: null,
      filterReason: "processing-interrupted",
    });
    Object.assign(row.processTime, {
      querySucceeded: false,
      nativeError: 5,
      creationMatches: null,
      eventNotBeforeCreation: null,
      exitTimePresent: null,
      eventNotAfterExit: null,
      rawError: canary,
    });
    Object.assign(row.fieldPresence, { rawPayload: canary });
    const value = input([census]);
    const read = readInstalledFileIoObservation(value.outcome, value.binding);
    expect(read).toMatchObject({
      filterCensus: {
        events: [
          {
            timeWindowMatched: null,
            processLifetimeMatched: null,
            issuingThreadVerified: null,
            irpValueNonzero: null,
            processTime: { querySucceeded: false, nativeError: 5, creationMatches: null },
          },
        ],
      },
    });
    expect(JSON.stringify(read)).not.toContain(canary);
  });

  it("retains the existing 16+16 row capacity and incomplete field-shape observation", () => {
    const { census, row } = filterCensus();
    census.events = [
      row,
      ...Array.from({ length: 15 }, () => ({ ...row })),
      ...Array.from({ length: 16 }, () => ({ ...row, eventId: 15, priorityEventFamily: false })),
    ];
    Object.assign(row, {
      processTime: null,
      fieldPresence: {},
      fieldShapeUnavailable: true,
    });
    census.unavailable = true;
    census.truncated = true;
    census.nonPriorityTruncated = true;
    const value = input([census]);
    const read = readInstalledFileIoObservation(value.outcome, value.binding);
    expect(read).toHaveProperty("filterCensus.events.length", 32);
    expect(read).toHaveProperty("filterCensus.events.0.processTime", null);
    expect(read).toHaveProperty("filterCensus.events.0.fieldPresence", {});
    expect(read).toHaveProperty("filterCensus.events.0.fieldShapeUnavailable", true);
    expect(read).toMatchObject({
      filterCensus: {
        unavailable: true,
        truncated: true,
        nonPriorityTruncated: true,
      },
    });
  });

  it.each([
    "missing",
    "null",
    "duplicate",
    "malformed-duplicate",
    "unknown-phase",
    "unknown-reason",
    "unknown-id",
    "missing-selection",
    "unknown-selection",
    "header-mismatch",
    "missing-boolean",
    "invalid-boolean",
    "unknown-count-key",
    "missing-count-key",
    "negative-count",
    "fractional-count",
    "excess-count",
    "row-cap",
    "priority-cap",
    "priority-mismatch",
    "byte-cap",
    "missing-shape",
    "invalid-native-error",
  ])("marks %s census unavailable without changing the existing result or facts", (scenario) => {
    const { census, row } = filterCensus();
    const value = input([census]);
    if (scenario === "missing") {
      value.outcome.records.pop();
    }
    if (scenario === "null") {
      value.outcome.records[2] = null;
    }
    if (scenario === "duplicate") {
      value.outcome.records.push(structuredClone(census));
    }
    if (scenario === "malformed-duplicate") {
      value.outcome.records.push({ phase: "filter-census" });
    }
    if (scenario === "unknown-phase") {
      census.phase = "unknown-phase";
    }
    if (scenario === "unknown-reason") {
      row.filterReason = "HOST_PRIVATE_CENSUS_CANARY";
    }
    if (scenario === "unknown-id") {
      row.eventId = 999;
    }
    if (scenario === "missing-selection") {
      Reflect.deleteProperty(row, "selectionReason");
    }
    if (scenario === "unknown-selection") {
      Object.assign(row, { selectionReason: "HOST_PRIVATE_CENSUS_CANARY" });
    }
    if (scenario === "header-mismatch") {
      row.headerPidMatched = false;
    }
    if (scenario === "missing-boolean") {
      Reflect.deleteProperty(row, "issuingThreadVerified");
    }
    if (scenario === "invalid-boolean") {
      Object.assign(row, { issuingThreadVerified: "false" });
    }
    if (scenario === "unknown-count-key") {
      census.relevantEventCounts.HOST_PRIVATE_CENSUS_CANARY = 1;
    }
    if (scenario === "missing-count-key") {
      Reflect.deleteProperty(census.relevantEventCounts, "26");
    }
    if (scenario === "negative-count") {
      census.relevantEventCounts[26] = -1;
    }
    if (scenario === "fractional-count") {
      census.relevantEventCounts[26] = 1.5;
    }
    if (scenario === "excess-count") {
      census.relevantEventCounts[26] = 20001;
    }
    if (scenario === "row-cap") {
      census.events = Array.from({ length: 33 }, () => row);
    }
    if (scenario === "priority-cap") {
      census.events = Array.from({ length: 17 }, () => row);
    }
    if (scenario === "priority-mismatch") {
      row.priorityEventFamily = false;
    }
    if (scenario === "byte-cap") {
      Object.assign(census, { extra: "HOST_PRIVATE_CENSUS_CANARY".repeat(1400) });
    }
    if (scenario === "missing-shape") {
      Object.assign(row, { fieldPresence: {} });
    }
    if (scenario === "invalid-native-error") {
      Object.assign(row.processTime, { nativeError: "HOST_PRIVATE_CENSUS_CANARY" });
    }
    const baseline = input();
    const before = readInstalledFileIoObservation(baseline.outcome, baseline.binding);
    const read = readInstalledFileIoObservation(value.outcome, value.binding);
    assert.ok("result" in before && "result" in read);
    expect(read.result).toEqual(before.result);
    expect(read.facts).toEqual(before.facts);
    expect(read).toHaveProperty("filterCensus", {
      phase: "filter-census",
      diagnosticOnly: true,
      unavailable: true,
    });
    expect(JSON.stringify(read)).not.toContain("HOST_PRIVATE_CENSUS_CANARY");
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

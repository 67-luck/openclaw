import { describe, expect, it } from "vitest";
import {
  readInstalledUpdateRetirementObservation,
  type InstalledUpdateRetirementBinding,
} from "./schtasks.installed-retirement-observation.test-support.js";

const digest = "a".repeat(64);
const entry = "C:\\fixture space\\node_modules\\openclaw\\openclaw.mjs";
const relativePath = "node_modules\\@koromix\\koffi-win32-x64\\win32_x64\\koffi.node";
const canonicalPath = "C:\\fixture space\\node_modules\\openclaw\\" + relativePath;
const reportedPath = "\\\\?\\" + canonicalPath;
const startTicks = "134350000003332222";
const binding: InstalledUpdateRetirementBinding = {
  launcherPid: 99,
  commandPid: 100,
  commandStartedAtMs: 1_790_000_000_000,
  commandSpawnedAtMs: 1_790_000_000_100,
  entry,
  profile: "fixture",
  expectedNodeExe: "C:\\Program Files\\nodejs\\node.exe",
  expectedArgv: [
    entry,
    "--profile",
    "fixture",
    "update",
    "--yes",
    "--tag",
    "C:\\candidate package.tgz",
    "--json",
  ],
  runId: "fixture-run",
  runCreatedAtMs: 1_790_000_003_000,
  globalRoot: "C:\\fixture space\\node_modules",
  namespaceWasEmpty: true,
  expectedAddon: { canonicalPath, relativePath, sha256: digest, bytes: 1_044_480 },
};

function candidate(pid: number, parentPid: number, respawn: boolean) {
  return {
    pid,
    parentPid,
    createdAt: "2026-09-26T21:49:10.3332222Z",
    commandLine:
      '"C:\\Program Files\\nodejs\\node.exe" ' +
      (respawn ? "--stack-size=8192 " : "") +
      '"C:\\fixture space\\node_modules\\openclaw\\openclaw.mjs" --profile fixture update --yes --tag "C:\\candidate package.tgz" --json',
    startTicks,
    afterStartTicks: startTicks,
    hasExited: false,
    nodeReportedPath: "\\\\?\\C:\\Program Files\\nodejs\\node.exe",
    moduleReportedPaths: [reportedPath],
    modulesComplete: true,
    backupsComplete: true,
    unavailable: [] as string[],
    backups: [
      {
        root: "C:\\fixture space\\node_modules\\.openclaw.package-backup-101-1790000001000",
        kind: "pid-name-correlation",
        complete: true,
        unavailable: [] as string[],
        leaves: [
          { relativePath, bytes: 1_044_480, sha256: digest },
          { relativePath: "different\\koffi.node", bytes: 1_044_480, sha256: digest },
        ],
      },
    ],
  };
}

function payload() {
  return {
    startedAtMs: 1_790_000_300_000,
    finishedAtMs: 1_790_000_301_000,
    candidates: [candidate(100, 99, false), candidate(101, 100, true)],
  };
}

describe("installed updater retirement evidence reader", () => {
  it("binds the unique exact startup leaf and separates module, digest, and relative-name matches", () => {
    const native = payload();
    const observed = readInstalledUpdateRetirementObservation(structuredClone(native), binding);
    expect(observed).toMatchObject({
      originalProcess: { pid: 101, startTicks },
      complete: true,
      moduleReportedPaths: [reportedPath],
      expectedModuleObserved: true,
      backups: [
        {
          kind: "pid-name-correlation",
          leaves: [
            { matchesExpectedDigest: true, matchesExpectedRelativePath: true },
            { matchesExpectedDigest: true, matchesExpectedRelativePath: false },
          ],
        },
      ],
    });
    expect(native.candidates[1]?.moduleReportedPaths).toEqual([reportedPath]);
    expect(observed.limitation).toContain("do not identify the mapped file object");
  });

  it("keeps collection complete when the observed module is elsewhere and does not infer causation", () => {
    const native = payload();
    native.candidates[1]!.moduleReportedPaths = ["\\\\?\\C:\\different\\koffi.node"];
    const observed = readInstalledUpdateRetirementObservation(native, binding);
    expect(observed).toMatchObject({ complete: true, expectedModuleObserved: false });
    expect(observed.originalProcess).toEqual({ pid: 101, startTicks });
  });

  it.each([
    "ambiguous",
    "foreign profile",
    "foreign tag",
    "unknown bootstrap",
    "native executable",
    "PID replacement",
    "start replacement",
    "during-capture reuse",
    "exited",
  ] as const)("does not pin unavailable or replaced process evidence (%s)", (kind) => {
    const native = payload();
    const driver = native.candidates[1]!;
    let expected = binding;
    switch (kind) {
      case "ambiguous":
        native.candidates.push(candidate(102, 100, true));
        break;
      case "foreign profile":
        driver.commandLine = driver.commandLine.replace("--profile fixture", "--profile foreign");
        break;
      case "foreign tag":
        driver.commandLine = driver.commandLine.replace(
          "candidate package.tgz",
          "other package.tgz",
        );
        break;
      case "unknown bootstrap":
        driver.commandLine = driver.commandLine.replace("--stack-size=8192", "--eval=unrelated");
        break;
      case "native executable":
        driver.nodeReportedPath = "C:\\other\\node.exe";
        break;
      case "PID replacement":
        expected = { ...binding, pinnedProcess: { pid: 900, startTicks } };
        break;
      case "start replacement":
        expected = { ...binding, pinnedProcess: { pid: 101, startTicks: "134350000003332221" } };
        break;
      case "during-capture reuse":
        driver.afterStartTicks = "134350000003332223";
        break;
      case "exited":
        driver.hasExited = true;
        break;
    }
    const observed = readInstalledUpdateRetirementObservation(native, expected);
    expect(observed.complete).toBe(false);
    expect(observed.originalProcess).toBeUndefined();
    expect(observed.unavailable).toBeTypeOf("string");
  });

  it("retains validated identity but not a completion claim for partial inventory", () => {
    const native = payload();
    const driver = native.candidates[1]!;
    driver.backups[0]!.complete = false;
    driver.backups[0]!.unavailable = ["inventory-unavailable:inventory-entry-limit"];
    const observed = readInstalledUpdateRetirementObservation(native, {
      ...binding,
      pinnedProcess: { pid: 101, startTicks },
    });
    expect(observed.originalProcess).toEqual({ pid: 101, startTicks });
    expect(observed.complete).toBe(false);
    expect(observed.backups?.[0]?.unavailable).toEqual([
      "inventory-unavailable:inventory-entry-limit",
    ]);
  });

  it("preserves shim namespace correlation separately from PID-named package evidence", () => {
    const native = payload();
    native.candidates[1]!.backups.push({
      root: "C:\\fixture space\\node_modules\\.openclaw.shim-backup-Ab12Cd",
      kind: "shim-namespace",
      complete: true,
      unavailable: [],
      leaves: [{ relativePath: "openclaw.cmd", bytes: 42, sha256: "b".repeat(64) }],
    });
    const observed = readInstalledUpdateRetirementObservation(native, binding);
    expect(observed.backups?.map(({ kind }) => kind)).toEqual([
      "pid-name-correlation",
      "shim-namespace",
    ]);
    expect(observed.backups?.[1]?.leaves[0]).toMatchObject({
      matchesExpectedDigest: false,
      matchesExpectedRelativePath: false,
    });
  });
});

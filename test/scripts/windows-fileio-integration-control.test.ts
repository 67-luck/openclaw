import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import { parse } from "acorn";
import { describe, expect, it } from "vitest";
import {
  hasUnjoinedWork,
  inspectManagedProcessGroup,
  runManagedCommand,
} from "../../scripts/lib/managed-child-process.mts";
import {
  instrumentCensus,
  projectCensusResult,
} from "../../scripts/qa/windows-fileio-integration-control.mjs";
import { createFixtureInput } from "../../scripts/qa/windows-fileio/fixture-input.cjs";
import { recordRequestOnlyControl } from "../../scripts/qa/windows-fileio/record-request-only-control.mjs";
import { createInstalledTerminalJsonCapture } from "../../src/daemon/schtasks.installed-command.test-support.js";
import {
  buildInstalledUpdateRetirementCensus,
  type InstalledUpdateRetirementBinding,
} from "../../src/daemon/schtasks.installed-retirement-observation.test-support.js";
import { hasErrnoCode } from "../../src/infra/errno.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";

const binding: InstalledUpdateRetirementBinding = {
  launcherPid: 40,
  commandPid: 41,
  commandStartedAtMs: 1_800_000_000_000,
  commandSpawnedAtMs: 1_800_000_000_001,
  entry: "C:\\control\\entry.cjs",
  profile: "fileio-integration-control",
  expectedNodeExe: "C:\\control\\node.exe",
  expectedArgv: ["C:\\control\\entry.cjs", "--profile", "fileio-integration-control", "update"],
  runId: "synthetic-control",
  runCreatedAtMs: 1_800_000_000_002,
  globalRoot: "C:\\control\\node_modules",
};

describe("integrated FileIO control evidence boundary", () => {
  it("filters host siblings and removes private argv before retaining a census", () => {
    const foreign = "HOST_FOREIGN_COMMAND_MUST_NOT_REACH_ARTIFACT";
    const privateHome = "C:\\Users\\synthetic-person";
    const selectedRoot = `${privateHome}\\control`;
    const source = {
      processes: [
        { ProcessId: 40, ParentProcessId: 1, CommandLine: "node managed-launcher" },
        {
          ProcessId: 41,
          ParentProcessId: 40,
          CommandLine: `node ${selectedRoot}\\entry.cjs`,
          extraHostField: foreign,
        },
        { ProcessId: 42, ParentProcessId: 40, CommandLine: foreign },
        { ProcessId: 43, ParentProcessId: 41, CommandLine: "node owned-descendant" },
      ],
      retirement: {
        startedAtMs: 1_800_000_000_010,
        finishedAtMs: 1_800_000_000_011,
        candidates: [],
      },
      unrecognizedHostPayload: foreign,
    };
    const projection = projectCensusResult(
      { env: { USERPROFILE: privateHome }, stateDir: selectedRoot },
      { status: 0, stdout: JSON.stringify(source), stderr: "" },
      [selectedRoot],
      binding,
    );
    expect(projection.ok).toBe(true);
    expect(projection.processes.map((row) => row.pid)).toEqual([40, 41, 43]);
    expect(JSON.stringify(projection)).not.toContain(foreign);
    expect(JSON.stringify(projection)).not.toContain("synthetic-person");
    expect(projection.retirement?.complete).toBe(false);
  });

  it.each([false, true])(
    "adds a bounded post-Enable callback to the actual census (block=%s)",
    (block) => {
      const original = buildInstalledUpdateRetirementCensus(binding);
      const instrumented = instrumentCensus(original, block);
      expect(instrumented).toContain('[Console]::Error.WriteLine(\'{"event":"fileio-enabled"}\')');
      expect(instrumented).toContain("if($fact.phase -ceq 'observing')");
      expect(instrumented.includes("$gate.WaitOne()")).toBe(block);
      expect(instrumented).not.toContain("Start-Sleep");
      // The native timeout remains with the real spawnSync owner. Instrumentation
      // cannot silently select a second observer if the generated contract changes.
      expect(() => instrumentCensus(original + original, block)).toThrow(
        "Expected exactly one canonical observe call",
      );
    },
  );
});

it.each([
  "known-completion",
  "secondary-success-missing-request",
  "secondary-joined-failure",
  "secondary-unjoined",
  "native-lifetime",
  "native-lifetime-and-cleanup",
  "native-unjoined",
  "native-pending",
  "guard",
  "timeout",
  "cleanup",
  "joined-failure",
  "joined-failure-and-cleanup",
  "unjoined",
] as const)(
  "runs the actual cell driver with %s and preserves its cleanup boundary",
  async (scenario) => {
    const source = fs.readFileSync(
      new URL("../../scripts/qa/windows-fileio-integration-control.mjs", import.meta.url),
      "utf8",
    );
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const main = ast.body.find(
      (node) => node.type === "FunctionDeclaration" && node.id?.name === "main",
    );
    assert.ok(main?.type === "FunctionDeclaration");
    const cellFunction = main.body.body.find(
      (node) => node.type === "FunctionDeclaration" && node.id?.name === "runCell",
    );
    const driver = main.body.body.find((node) => node.type === "TryStatement");
    assert.ok(cellFunction && driver);
    const cells: Array<{
      name: string;
      qualified: boolean;
      cleanupVerified?: boolean;
      completedDeletionFailure?: { message: string };
    }> = [];
    const started: string[] = [];
    const cleaned: string[] = [];
    const failures: unknown[] = [];
    const nativeFailure = Object.assign(
      new Error("Synthetic native boundary failure"),
      scenario === "unjoined" || scenario === "native-unjoined"
        ? { processTreeState: "indeterminate" }
        : { code: "ETIMEDOUT" },
    );
    const cleanupFailure = new Error("Synthetic exact cleanup failure");
    const targets = new Map<string, { release: () => void; joined: () => boolean }>();
    const secondaryCalls: string[] = [];
    const secondaryFailure = Object.assign(
      new Error("Synthetic reader failure"),
      scenario === "secondary-unjoined"
        ? { processTreeState: "indeterminate" }
        : { code: "ETIMEDOUT" },
    );
    let originalRequestFailure: unknown;
    const processState = { execPath: "synthetic-node", exitCode: 0 };
    const identity = { pid: 1234, nativeStartFileTime: "133000000000000000" };
    const addonSha256 = "939156f310bd7a7d9d1db1b5249a5d135739b049c24c79fd3c201701333ddbf3";
    let lifetimeJoins = 0;
    const order: string[] = [];
    let markNativeEntered!: () => void;
    const nativeEntered = new Promise<void>((resolve) => {
      markNativeEntered = resolve;
    });
    let releaseNative!: () => void;
    const nativeRelease = new Promise<void>((resolve) => {
      releaseNative = resolve;
    });
    // Execute the unchanged driver and runCell bodies in this realm so the real
    // recorder's AssertionError identity remains part of the continuation gate.
    const dependencies = {
      assert,
      path,
      AbortController,
      hasUnjoinedWork,
      hasErrnoCode,
      recordRequestOnlyControl(input: Parameters<typeof recordRequestOnlyControl>[0]) {
        if (scenario.startsWith("secondary-")) {
          expect(secondaryCalls).toEqual(["unloaded"]);
          input.observer.records[0].events = [];
        }
        try {
          return recordRequestOnlyControl(input);
        } catch (error) {
          originalRequestFailure = error;
          throw error;
        }
      },
      async compareSameEtl(
        _descriptor: unknown,
        _identity: unknown,
        _admission: unknown,
        primary: { cleanupVerified: boolean },
        receipt: { joined: boolean },
      ) {
        expect(receipt.joined && primary.cleanupVerified).toBe(true);
        expect(targets.get("unloaded")?.joined()).toBe(true);
        secondaryCalls.push("unloaded");
        if (scenario === "secondary-joined-failure" || scenario === "secondary-unjoined") {
          throw secondaryFailure;
        }
        return { diagnosticOnly: true };
      },
      cells,
      admissions: [],
      commands: [],
      mode: "run",
      env: {},
      privateRoot: "/synthetic-private",
      evidence: "/synthetic-evidence",
      helper: "/synthetic-helper",
      addon: "synthetic-addon",
      toolingSha: "a".repeat(40),
      addonSha256,
      process: processState,
      fs: { mkdirSync() {}, readdirSync: () => [] },
      persistAdmission: async () => {},
      persistEvidence() {},
      save() {},
      projectCensusResult: () => ({ processes: [] }),
      safeError(error: unknown) {
        failures.push(error);
        return { unjoined: hasUnjoinedWork(error) };
      },
      lifetime: {
        async cleanup() {
          lifetimeJoins++;
        },
      },
      async prepareInstalledFileIo({ task }: { task: { rootDir: string } }) {
        const name = path.basename(task.rootDir);
        started.push(name);
        order.push(`prepare:${name}`);
        return {
          descriptor: { runtime: {} },
          async cleanup() {
            cleaned.push(name);
            if (
              name === "unloaded" &&
              (scenario === "cleanup" ||
                scenario === "joined-failure-and-cleanup" ||
                scenario === "native-lifetime-and-cleanup")
            ) {
              throw cleanupFailure;
            }
          },
        };
      },
      async nativeLifetimeControl() {
        expect(started).toEqual(["unloaded"]);
        order.push("api-enter");
        markNativeEntered();
        if (scenario === "native-pending") {
          await nativeRelease;
        }
        if (
          ["native-lifetime", "native-lifetime-and-cleanup", "native-unjoined"].includes(scenario)
        ) {
          throw nativeFailure;
        }
        order.push("api-joined");
      },
      fixtureTarget(options: { label: string; signal: AbortSignal }, argv: string[]) {
        const name = options.label.split(":")[0];
        assert.ok(name);
        order.push(`fixture:${name}`);
        const loaded = argv[4] === "__fileio_loaded";
        const terminal = createInstalledTerminalJsonCapture((value) => value);
        const stdout =
          JSON.stringify({ status: "ok", mode: "npm", steps: [], durationMs: 0 }, null, 2) + "\n";
        const receipt = {
          joined: false,
          jobObserved: true,
          launcherPid: 100,
          commandPid: 1234,
          commandStartedAtMs: 1,
          commandSpawnedAtMs: 2,
        };
        let finish!: (code: number) => void;
        let reject!: (error: Error) => void;
        const completion = new Promise<number>((resolve, fail) => {
          finish = resolve;
          reject = fail;
        });
        void completion.catch(() => {});
        const release = () => {
          if (receipt.joined) {
            return;
          }
          if (name === "unloaded" && scenario === "unjoined") {
            reject(nativeFailure);
            return;
          }
          receipt.joined = true;
          if (
            name === "unloaded" &&
            (scenario === "joined-failure" || scenario === "joined-failure-and-cleanup")
          ) {
            reject(nativeFailure);
          } else {
            finish(0);
          }
        };
        targets.set(name, { release, joined: () => receipt.joined });
        options.signal.addEventListener(
          "abort",
          () => {
            receipt.joined = true;
            reject(Object.assign(new Error("Synthetic fixture abort"), { code: "ABORT_ERR" }));
          },
          { once: true },
        );
        return {
          receipt,
          completion,
          child: {
            stdin: {
              name,
              write(line: string, callback: (error?: Error) => void) {
                expect(line).toBe("terminal\n");
                terminal.observe(stdout, false, 3);
                callback();
              },
            },
          },
          records: [
            {
              event: "result",
              mode: loaded ? "loaded" : "unloaded",
              pid: identity.pid,
              operation: "unlink",
              target: "koffi.node",
              unlinkCode: loaded ? "EPERM" : null,
            },
          ],
          get terminal() {
            return terminal.current();
          },
          final: () => terminal.final(stdout, false),
          async waitFor() {
            return { pid: identity.pid, modulePresent: loaded, addonSha256 };
          },
        };
      },
      createFixtureRelease(stream: { name: string }) {
        return { observe() {}, release: () => targets.get(stream.name)!.release() };
      },
      async census(
        current: InstalledUpdateRetirementBinding,
        _context: unknown,
        label: string,
        onEnabled?: () => void,
      ) {
        const name = current.runId;
        order.push(`census:${label}`);
        if (label.endsWith(":pin")) {
          if (name === "unloaded" && scenario === "timeout") {
            throw nativeFailure;
          }
          return {
            capture: {
              retirement: {
                complete: !(name === "unloaded" && scenario === "guard"),
                originalProcess: { pid: identity.pid, startTicks: identity.nativeStartFileTime },
                expectedModuleObserved: name !== "unloaded",
                backups: [{ leaves: [{}, {}] }, { leaves: [{}, {}] }],
              },
            },
          };
        }
        if (name !== "unloaded" && name !== "loaded") {
          return { capture: { fileIo: { unavailable: "synthetic refused input" } } };
        }
        onEnabled?.();
        return {
          observer: { receipt: { exitCode: 0, elapsedMs: 1, joined: true, jobObserved: true } },
          capture: {
            fileIo: {
              result: {
                ...identity,
                cleanupVerified: true,
                observation: "attributed",
                records: [],
                partial: [],
                loss: {
                  statisticsKnown: true,
                  eventsLost: 0,
                  logBuffersLost: 0,
                  realTimeBuffersLost: 0,
                },
                counts: { unresolvedThreads: 0 },
                threadCoverage: { after: "completed" },
                postStopAdmission: { state: "Live", admitted: true },
                projectionStarted: true,
                captureInterval: {
                  startedAt: "2026-09-28T00:00:00.000Z",
                  endedAt: "2026-09-28T00:00:01.000Z",
                },
              },
              facts: {
                phase: "owned-begin-facts",
                diagnosticOnly: true,
                unavailable: false,
                priorityTruncated: false,
                events: [
                  {
                    requestEvent: {
                      ...identity,
                      evidenceKind: "request-event-only",
                      pathProvenance: "explicit-FilePath",
                      threadId: 22,
                      relativeTarget: "koffi.node",
                      eventId: 26,
                      eventVersion: 1,
                      infoClass: 64,
                      eventAt: "2026-09-28T00:00:00.005Z",
                      completion: "unknown",
                      ntStatus: null,
                    },
                  },
                ],
              },
            },
          },
        };
      },
      synchronousTimeoutControl: () => ({ capture: {}, receipt: { pid: 9876 } }),
      getWindowsPowerShellExePath: () => "synthetic-powershell",
      launchManaged: () => ({
        completion: Promise.resolve(0),
        result: () => ({ stdout: '{"directCensusProcessAbsent":true}' }),
      }),
    };
    const driverCompletion = compileFunction(
      `return (async () => {let failed = false; ${source.slice(cellFunction.start, cellFunction.end)}\n${source.slice(driver.start, driver.end)}})();`,
      Object.keys(dependencies),
    )(...Object.values(dependencies));
    let pendingFixtureCount: number | undefined;
    if (scenario === "native-pending") {
      await nativeEntered;
      pendingFixtureCount = targets.size;
      releaseNative();
    }
    await driverCompletion;
    if (scenario === "native-pending") {
      expect(pendingFixtureCount).toBe(0);
    }
    if (scenario.startsWith("secondary-")) {
      assert.ok(originalRequestFailure instanceof assert.AssertionError);
      expect(originalRequestFailure.message).toBe(
        "No admitted explicit-path deletion request event was observed",
      );
      const combined = failures.find((error) => error instanceof AggregateError);
      if (scenario === "secondary-unjoined") {
        assert.ok(combined instanceof AggregateError);
        expect(combined.errors).toEqual([secondaryFailure, originalRequestFailure]);
        expect(hasUnjoinedWork(combined)).toBe(true);
      } else {
        expect(failures).toContain(originalRequestFailure);
        expect(combined).toBeUndefined();
      }
    }
    expect(lifetimeJoins).toBe(1);
    expect(processState.exitCode).toBe(1);
    if (["native-lifetime", "native-lifetime-and-cleanup", "native-unjoined"].includes(scenario)) {
      expect(targets.size).toBe(0);
      expect(order).toEqual(["prepare:unloaded", "api-enter"]);
    } else {
      expect(order.slice(0, 5)).toEqual([
        "prepare:unloaded",
        "api-enter",
        "api-joined",
        "fixture:unloaded",
        "census:unloaded:pin",
      ]);
    }
    if (scenario === "known-completion" || scenario === "native-pending") {
      expect(started).toEqual([
        "unloaded",
        "loaded",
        "absent-pin",
        "wrong-pin",
        "wrong-dll",
        "wrong-runtime",
        "wrong-custody",
        "sync-timeout",
        "fixture-abort",
      ]);
      expect(cleaned).toEqual(started);
      expect(cells.slice(0, 2).map((cell) => cell.completedDeletionFailure?.message)).toEqual([
        "No deletion-disposition completion was attributed",
        "No deletion-disposition completion was attributed",
      ]);
    } else {
      expect(started).toEqual(["unloaded"]);
      expect(cleaned).toEqual(
        scenario === "unjoined" ||
          scenario === "native-unjoined" ||
          scenario === "secondary-unjoined"
          ? []
          : ["unloaded"],
      );
      expect(cells[0]?.qualified).toBe(false);
      if (
        scenario === "joined-failure" ||
        scenario === "timeout" ||
        scenario === "native-lifetime" ||
        scenario === "native-unjoined"
      ) {
        expect(failures).toContain(nativeFailure);
      }
      if (scenario === "joined-failure-and-cleanup" || scenario === "native-lifetime-and-cleanup") {
        const failure = failures[0];
        assert.ok(failure instanceof AggregateError);
        expect(failure.errors).toEqual([nativeFailure, cleanupFailure]);
      }
    }
  },
);

it("preserves split UTF-8 codepoints through the actual managed stdout and stderr pipes", async () => {
  const source = fs.readFileSync(
    new URL("../../scripts/qa/windows-fileio-integration-control.mjs", import.meta.url),
    "utf8",
  );
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const declaration = ast.body.find(
    (node) => node.type === "FunctionDeclaration" && node.id?.name === "launchManaged",
  );
  assert.ok(declaration);
  const dependencies = {
    assert,
    performance,
    StringDecoder,
    runManagedCommand,
    inspectManagedProcessGroup,
    safeError: (error: unknown) => ({
      name: error instanceof Error ? error.name : "Error",
      unjoined: hasUnjoinedWork(error),
    }),
  };
  const launch = compileFunction(
    `return ${source.slice(declaration.start, declaration.end)}`,
    Object.keys(dependencies),
  )(...Object.values(dependencies));
  const lifetime = createFixtureLifetime();
  const root = lifetime.createTempDir("fileio-utf8-pipe-");
  const childPath = path.join(root, "split-child.cjs");
  const inputOwner = fileURLToPath(
    new URL("../../scripts/qa/windows-fileio/fixture-input.cjs", import.meta.url),
  );
  fs.writeFileSync(
    childPath,
    `
const { createFixtureInput } = require(${JSON.stringify(inputOwner)});
const bytes = Buffer.from('🌊\\n', 'utf8');
const input = createFixtureInput(process.stdin);
(async () => {
  try {
    process.stdout.write(bytes.subarray(0, 2));
    await input.read('continue\\n');
    process.stdout.write(bytes.subarray(2));
    process.stderr.write(bytes.subarray(0, 2));
    await input.read('continue\\n');
    process.stderr.write(bytes.subarray(2));
  } finally { await input.close(); }
})().catch(() => { process.exitCode = 1; });
`,
  );
  const chunks = { stdout: [] as number[], stderr: [] as number[] };
  const stderrLines: string[] = [];
  const inputErrors: Error[] = [];
  let stdoutAcknowledged = false;
  let stderrAcknowledged = false;
  let target:
    | {
        child: ChildProcess;
        receipt: { joined: boolean; stdoutBytes: number };
        completion: Promise<number>;
        result: () => { stdout: string };
      }
    | undefined;
  const recordInputError = (error?: Error | null) => {
    if (error) {
      inputErrors.push(error);
    }
  };
  try {
    target = launch({
      lifetime,
      commands: [],
      env: { PATH: process.env.PATH },
      label: "split-utf8-real-pipe",
      bin: process.execPath,
      args: [childPath],
      timeoutMs: 5000,
      onStdout() {
        if (stdoutAcknowledged) {
          return;
        }
        stdoutAcknowledged = true;
        assert.ok(target);
        const child = target.child;
        assert.ok(child.stdin && child.stdout && child.stderr);
        const stdin = child.stdin;
        chunks.stdout.push(target.receipt.stdoutBytes);
        stdin.on("error", recordInputError);
        // Attach the raw stderr barrier before allowing the child to enter that
        // phase; it cannot emit either tail before the parent's acknowledgement.
        child.stderr.on("data", (chunk: Buffer) => {
          chunks.stderr.push(chunk.length);
          if (stderrAcknowledged) {
            return;
          }
          stderrAcknowledged = true;
          stdin.end("continue\n", recordInputError);
        });
        child.stdout.on("data", (chunk: Buffer) => chunks.stdout.push(chunk.length));
        stdin.write("continue\n", recordInputError);
      },
      onStderrLine(line: string) {
        stderrLines.push(line);
      },
    });
    assert.ok(target);
    expect(await target.completion).toBe(0);
    expect(target.receipt.joined).toBe(true);
    expect(inputErrors).toEqual([]);
    expect(stdoutAcknowledged && stderrAcknowledged).toBe(true);
    expect(chunks).toEqual({ stdout: [2, 3], stderr: [2, 3] });
    expect({ stdout: target.result().stdout, stderrLines }).toEqual({
      stdout: "🌊\n",
      stderrLines: ["🌊"],
    });
  } finally {
    if (target) {
      await target.completion.catch(() => undefined);
    }
    await lifetime.cleanup();
  }
});

it.each([
  "missing",
  "invalid",
  "false",
  "query-threw",
  "early-exit",
  "complete",
  "thread-worker-false",
  "thread-belongs-threw",
  "thread-rejected",
  "thread-oracle-failed",
  "thread-oracle-threw",
  "input-bom-prefix",
  "input-eof",
  "input-mismatch",
  "input-other",
  "input-unknown",
  "process-ready",
  "process-creation",
  "process-hold",
  "process-lease",
  "process-terminal-write",
  "process-terminal-ack",
] as const)(
  "retains nullable lifetime diagnostics without weakening admission (%s)",
  async (scenario) => {
    const source = fs.readFileSync(
      new URL("../../scripts/qa/windows-fileio-integration-control.mjs", import.meta.url),
      "utf8",
    );
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const main = ast.body.find(
      (node) => node.type === "FunctionDeclaration" && node.id?.name === "main",
    );
    assert.ok(main?.type === "FunctionDeclaration");
    const declaration = main.body.body.find(
      (node) => node.type === "FunctionDeclaration" && node.id?.name === "nativeLifetimeControl",
    );
    assert.ok(declaration);
    const outcomeKeys = [
      "processLive",
      "processInsideExit",
      "processAfterExit",
      "threadLive",
      "threadInsideExit",
      "threadAfterExit",
      "naturalRelease",
    ];
    const observationKeys = [
      "childHasExited",
      "callCompleted",
      "querySucceeded",
      "creationMatches",
      "eventNotBeforeCreation",
      "exitTimePresent",
      "eventNotAfterExit",
      "containsTime",
    ];
    const threadObservationKeys = [
      "workerAlive",
      "belongsAtCallCompleted",
      "belongsAt",
      "oracleCallCompleted",
      "oracleQuerySucceeded",
      "oracleCreationNotAfterSample",
    ];
    const emptyThreadObservation = Object.fromEntries(
      threadObservationKeys.map((key) => [key, null]),
    );
    const threadCase = scenario.startsWith("thread-");
    const expectedThreadObservation =
      scenario === "complete"
        ? {
            ...emptyThreadObservation,
            workerAlive: true,
            belongsAtCallCompleted: true,
            belongsAt: true,
          }
        : scenario === "thread-worker-false"
          ? { ...emptyThreadObservation, workerAlive: false }
          : scenario === "thread-belongs-threw"
            ? { ...emptyThreadObservation, workerAlive: true, belongsAtCallCompleted: false }
            : threadCase
              ? {
                  workerAlive: true,
                  belongsAtCallCompleted: true,
                  belongsAt: false,
                  oracleCallCompleted: scenario !== "thread-oracle-threw",
                  oracleQuerySucceeded:
                    scenario === "thread-oracle-threw" ? null : scenario !== "thread-oracle-failed",
                  oracleCreationNotAfterSample: scenario === "thread-rejected" ? false : null,
                }
              : emptyThreadObservation;
    const inputCase = scenario.startsWith("input-");
    const inputCategory = inputCase ? scenario.slice(6) : undefined;
    const claimsComplete = scenario === "complete" || inputCase;
    const emptyObservation = Object.fromEntries(observationKeys.map((key) => [key, null]));
    const observed = {
      childHasExited: scenario === "early-exit",
      callCompleted: true,
      querySucceeded: true,
      creationMatches: true,
      eventNotBeforeCreation: true,
      exitTimePresent: false,
      eventNotAfterExit: null,
      containsTime: true,
    };
    const expectedObservation =
      scenario === "query-threw"
        ? { ...emptyObservation, callCompleted: false }
        : scenario === "early-exit" || claimsComplete || threadCase
          ? observed
          : emptyObservation;
    const boundaryStage = threadCase
      ? "thread-live"
      : scenario.startsWith("process-")
        ? scenario
        : undefined;
    const record: Record<string, unknown> = {
      phase: "native-lifetime-control",
      passed: !boundaryStage,
      stage: boundaryStage ?? "complete",
      sourceSha256: "source",
      dllSha256: "dll",
      nodeSha256: "node",
      fixtureSha256: "fixture",
      fixtureInputSha256: "input",
      terminalInputFailure:
        inputCategory === "unknown" ? "PRIVATE_EXCEPTION_CANARY" : inputCategory,
      foreign: "PRIVATE_EXCEPTION_CANARY",
    };
    if (scenario === "missing") {
      delete record.passed;
    } else if (scenario === "invalid") {
      record.passed = "true";
    }
    if (scenario !== "missing") {
      if (!boundaryStage) {
        for (const key of outcomeKeys) {
          record[key] = scenario === "invalid" ? "true" : claimsComplete;
        }
      }
      if (!boundaryStage || threadCase) {
        record.processLiveObservation =
          scenario === "invalid"
            ? Object.fromEntries(observationKeys.map((key) => [key, "PRIVATE_EXCEPTION_CANARY"]))
            : { ...expectedObservation, unknown: "PRIVATE_EXCEPTION_CANARY" };
      }
      record.threadLiveObservation =
        scenario === "invalid"
          ? Object.fromEntries(
              threadObservationKeys.map((key) => [key, "PRIVATE_EXCEPTION_CANARY"]),
            )
          : {
              ...expectedThreadObservation,
              rawThreadId: "PRIVATE_EXCEPTION_CANARY",
              rawCreationTime: "PRIVATE_EXCEPTION_CANARY",
            };
    }
    const descriptor = {
      sourceSha256: "source",
      dllSha256: "dll",
      powerShellExe: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      powerShellSha256: "powerShell",
      runtime: {
        executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        psVersion: "7.6.0",
        edition: "Core",
        clrVersion: "10.0.0",
        is64BitProcess: true,
      },
    };
    let verifications = 0;
    const dependencies = {
      assert,
      path,
      helper: "/synthetic-helper",
      hasUnjoinedWork,
      lifetime: {},
      commands: [],
      env: {},
      nodeSha256: "node",
      process: { execPath: "fixture-node" },
      hash: (file: string) =>
        file === "fixture-node"
          ? "node"
          : file.endsWith("lifetime-fixture.cjs")
            ? "fixture"
            : file.endsWith("fixture-input.cjs")
              ? "input"
              : "script",
      async verifyInstalledFileIoExecutable(value: unknown) {
        expect(value).toBe(descriptor);
        verifications++;
      },
      launchManaged: (options: { bin: string; args: string[] }) => {
        expect(verifications).toBe(1);
        expect(options.bin).toBe(descriptor.powerShellExe);
        const encoded = options.args[options.args.indexOf("-ExpectedRuntimeBase64") + 1];
        assert.ok(encoded);
        expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toEqual(
          descriptor.runtime,
        );
        expect(options.args[options.args.indexOf("-ExpectedPowerShellSha256") + 1]).toBe(
          descriptor.powerShellSha256,
        );
        return {
          completion: Promise.resolve(boundaryStage ? 2 : 0),
          receipt: { joined: true, jobObserved: true },
          result: () => ({ stdout: JSON.stringify(record) }),
        };
      },
    };
    const invoke = compileFunction(
      `return ${source.slice(declaration.start, declaration.end)}`,
      Object.keys(dependencies),
    )(...Object.values(dependencies));
    const cell: { nativeLifetimeControl?: Record<string, unknown> } = {};
    const call = invoke(descriptor, cell);
    if (scenario === "complete" || scenario === "input-unknown") {
      await call;
    } else {
      await expect(call).rejects.toThrow(assert.AssertionError);
    }
    expect(verifications).toBe(2);
    expect(cell.nativeLifetimeControl?.passed).toBe(
      scenario === "missing" || scenario === "invalid" ? null : !boundaryStage,
    );
    expect(cell.nativeLifetimeControl?.terminalInputFailure).toBe(
      inputCase && inputCategory !== "unknown" ? inputCategory : null,
    );
    expect(cell.nativeLifetimeControl?.stage).toBe(boundaryStage ?? "complete");
    expect(cell.nativeLifetimeControl?.processLiveObservation).toEqual(expectedObservation);
    expect(cell.nativeLifetimeControl?.threadLiveObservation).toEqual(expectedThreadObservation);
    for (const key of outcomeKeys) {
      expect(cell.nativeLifetimeControl?.[key]).toBe(
        scenario === "missing" || scenario === "invalid" || boundaryStage ? null : claimsComplete,
      );
    }
    expect(JSON.stringify(cell)).not.toContain("PRIVATE_EXCEPTION_CANARY");
  },
);

it.each([
  "held-until-release",
  "cleanup-before-terminal",
  "eof-before-terminal",
  "eof-after-terminal",
  "release-first",
  "crlf-rejected",
  "bom-prefix",
  "double-bom",
  "private-mismatch",
  "byte-bound",
  "unknown-error",
] as const)("Node lifetime fixture uses the actual pipe: %s", async (scenario) => {
  const lifetime = createFixtureLifetime();
  let completion: Promise<number> | undefined;
  let child: ChildProcess | undefined;
  const records: string[] = [];
  const inputErrors: Error[] = [];
  let heldAfterTerminal = false;
  try {
    const root = lifetime.createTempDir("fileio-lifetime-診断-é-");
    const fixture = path.join(root, "lifetime-fixture.cjs");
    const original = fs.readFileSync(
      new URL("../../scripts/qa/windows-fileio/lifetime-fixture.cjs", import.meta.url),
      "utf8",
    );
    // Local transport proof removes only the three native runtime prerequisites.
    const runtimeGuards = /^ {2}assert\.equal\(process\.(?:platform|arch|version), [^\n]+\);\n/gm;
    expect(original.match(runtimeGuards)).toHaveLength(3);
    fs.writeFileSync(fixture, original.replace(runtimeGuards, ""));
    fs.copyFileSync(
      new URL("../../scripts/qa/windows-fileio/fixture-input.cjs", import.meta.url),
      path.join(root, "fixture-input.cjs"),
    );
    if (scenario === "unknown-error") {
      fs.appendFileSync(
        path.join(root, "fixture-input.cjs"),
        `
const original = module.exports.createFixtureInput;
module.exports.createFixtureInput = (stream) => {
 const input = original(stream);
 return {...input, async read(expected) {
  await input.read(expected);
  if(expected === 'terminal\\n') throw Object.assign(new Error('PRIVATE_EXCEPTION_CANARY'), {
   code:'ERR_ASSERTION',operator:'strictEqual',actual:'\\uFEFFterminal\\n',expected:'terminal\\n'
  });
 }};
};
`,
      );
    }
    completion = lifetime.track(
      runManagedCommand({
        bin: process.execPath,
        args: [fixture],
        cwd: root,
        env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
        timeoutMs: 30_000,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        onReady(launched) {
          child = launched;
          const stdin = launched.stdin!;
          stdin.on("error", (error) => inputErrors.push(error));
          let carry = "";
          launched.stdout!.on("data", (chunk: Buffer) => {
            carry += chunk.toString("utf8");
            let end;
            while ((end = carry.indexOf("\n")) !== -1) {
              const line = carry.slice(0, end);
              carry = carry.slice(end + 1);
              records.push(line);
              if (line === "lifetime-ready") {
                if (scenario === "release-first") {
                  stdin.end("release\n");
                } else if (scenario === "eof-before-terminal") {
                  stdin.end();
                } else if (scenario === "cleanup-before-terminal") {
                  stdin.end("terminal\nrelease\n");
                } else {
                  const commands: Record<string, string> = {
                    "crlf-rejected": "terminal\r\n",
                    "bom-prefix": "\uFEFFterminal\n",
                    "double-bom": "\uFEFF\uFEFFterminal\n",
                    "private-mismatch": "PRIVATE_INPUT_CANARY\n",
                    "byte-bound": "x".repeat(33) + "\n",
                  };
                  stdin.write(commands[scenario] ?? "terminal\n");
                }
              } else if (line === "lifetime-terminal" && scenario !== "cleanup-before-terminal") {
                heldAfterTerminal =
                  inspectManagedProcessGroup(launched, { errorPolicy: "indeterminate" }) === "live";
                stdin.end(scenario === "eof-after-terminal" ? undefined : "release\n");
              }
            }
          });
          launched.stderr!.resume();
        },
      }),
    );
    const accepted = scenario === "held-until-release" || scenario === "cleanup-before-terminal";
    expect(await completion).toBe(accepted ? 0 : 1);
    expect(inputErrors).toEqual([]);
    const categories: Record<string, string> = {
      "eof-before-terminal": "eof",
      "release-first": "mismatch",
      "crlf-rejected": "mismatch",
      "bom-prefix": "bom-prefix",
      "double-bom": "mismatch",
      "private-mismatch": "mismatch",
      "byte-bound": "other",
      "unknown-error": "other",
    };
    expect(records).toEqual([
      "lifetime-ready",
      ...(categories[scenario] ? [`lifetime-terminal-failure:${categories[scenario]}`] : []),
      ...(["held-until-release", "cleanup-before-terminal", "eof-after-terminal"].includes(scenario)
        ? ["lifetime-terminal"]
        : []),
    ]);
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
    if (scenario === "held-until-release" || scenario === "eof-after-terminal") {
      expect(heldAfterTerminal).toBe(true);
    }
    assert.ok(child);
    expect(inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" })).toBe("dead");
  } finally {
    child?.stdin?.end();
    if (completion) {
      await completion.catch(() => undefined);
    }
    await lifetime.cleanup();
  }
});

it.each(["marker", "close", "marker-and-close"] as const)(
  "retains the terminal assertion when %s also fails",
  async (failureMode) => {
    const source = fs.readFileSync(
      new URL("../../scripts/qa/windows-fileio/lifetime-fixture.cjs", import.meta.url),
      "utf8",
    );
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "script" });
    const declaration = ast.body.find(
      (node) => node.type === "FunctionDeclaration" && node.id?.name === "main",
    );
    assert.ok(declaration);
    const input = createFixtureInput(Readable.from([Buffer.from("\uFEFFterminal\n")]));
    const markerError = new Error("PRIVATE_MARKER_FAILURE");
    const closeError = new Error("PRIVATE_CLOSE_FAILURE");
    let originalFailure: unknown;
    let closeCalls = 0;
    const writes: string[] = [];
    const dependencies = {
      assert,
      process: {
        argv: ["node", "fixture"],
        platform: "win32",
        arch: "x64",
        version: "v26.8.2",
        stdin: {},
        stdout: {
          write(value: string) {
            writes.push(value);
            if (value.startsWith("lifetime-terminal-failure:") && failureMode !== "close") {
              throw markerError;
            }
          },
        },
      },
      createFixtureInput: () => ({
        async read(expected: string) {
          try {
            await input.read(expected);
          } catch (error) {
            originalFailure = error;
            throw error;
          }
        },
        async close() {
          closeCalls++;
          await input.close();
          if (failureMode !== "marker") {
            throw closeError;
          }
        },
      }),
    };
    const main = compileFunction(
      `return ${source.slice(declaration.start, declaration.end)}`,
      Object.keys(dependencies),
    )(...Object.values(dependencies));
    const failures: unknown[] = [];
    const flatten = (error: unknown) => {
      if (error instanceof AggregateError) {
        error.errors.forEach(flatten);
      } else {
        failures.push(error);
      }
    };
    await main().then(() => {
      throw new Error("Expected fixture failure");
    }, flatten);
    expect(originalFailure).toBeInstanceOf(assert.AssertionError);
    expect(failures).toEqual([
      originalFailure,
      ...(failureMode !== "close" ? [markerError] : []),
      ...(failureMode !== "marker" ? [closeError] : []),
    ]);
    expect(closeCalls).toBe(1);
    expect(writes).toEqual(["lifetime-ready\n", "lifetime-terminal-failure:bom-prefix\n"]);
  },
);

it.each(["initial-pin", "trace", "refused", "changed", "failed-and-changed", "unjoined"] as const)(
  "uses admitted Core only for trace-bearing census (%s)",
  async (scenario) => {
    const source = fs.readFileSync(
      new URL("../../scripts/qa/windows-fileio-integration-control.mjs", import.meta.url),
      "utf8",
    );
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const main = ast.body.find(
      (node) => node.type === "FunctionDeclaration" && node.id?.name === "main",
    );
    assert.ok(main?.type === "FunctionDeclaration");
    const declaration = main.body.body.find(
      (node) => node.type === "FunctionDeclaration" && node.id?.name === "census",
    );
    assert.ok(declaration);
    const descriptor = {
      powerShellExe: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      powerShellSha256: "a".repeat(64),
    };
    const censusBinding = {
      globalRoot: "C:\\fixture",
      ...(scenario === "initial-pin" ? {} : { fileIo: descriptor }),
    };
    const order: string[] = [];
    const changed = new Error("Synthetic executable changed");
    const failed = new Error("Synthetic census failed");
    const unjoined = Object.assign(new Error("Synthetic census unjoined"), {
      processTreeState: "indeterminate",
    });
    const receipt = { joined: false, jobObserved: true };
    const dependencies = {
      assert,
      hasUnjoinedWork,
      env: {},
      lifetime: {},
      commands: [],
      async verifyInstalledFileIoExecutable(value: unknown) {
        expect(value).toBe(descriptor);
        order.push(receipt.joined ? "verify-after" : "verify-before");
        if (
          scenario === "refused" ||
          (receipt.joined && ["changed", "failed-and-changed"].includes(scenario))
        ) {
          throw changed;
        }
      },
      buildInstalledUpdateRetirementCensus: () => "synthetic-census",
      instrumentCensus: (script: string) => script,
      instrumentCensusInvocation: (script: string) => ({
        args: ["synthetic-bootstrap"],
        input: script,
      }),
      getWindowsPowerShellExePath: () => "windows-powershell-5.1",
      projectCensusResult: () => ({ diagnosticOnly: true }),
      launchManaged(options: { bin: string; timeoutMs: number; input: string }) {
        order.push("launch");
        expect(options).toMatchObject({
          bin: scenario === "initial-pin" ? "windows-powershell-5.1" : descriptor.powerShellExe,
          timeoutMs: 5000,
          input: "synthetic-census",
        });
        return {
          receipt,
          completion: (async () => {
            order.push("completion");
            if (scenario === "unjoined") {
              throw unjoined;
            }
            receipt.joined = true;
            if (scenario === "failed-and-changed") {
              throw failed;
            }
            return 0;
          })(),
          result: () => ({ stdout: "{}" }),
        };
      },
    };
    const invoke = compileFunction(
      `return ${source.slice(declaration.start, declaration.end)}`,
      Object.keys(dependencies),
    )(...Object.values(dependencies));
    let caught: unknown;
    const result = await invoke(censusBinding, {}, "census").catch((error: unknown) => {
      caught = error;
    });
    if (scenario === "initial-pin" || scenario === "trace") {
      expect(caught).toBeUndefined();
      expect(result).toMatchObject({ capture: { diagnosticOnly: true } });
    } else {
      expect(result).toBeUndefined();
      if (scenario === "failed-and-changed") {
        assert.ok(caught instanceof AggregateError);
        expect(caught.errors).toEqual([failed, changed]);
      } else {
        expect(caught).toBe(scenario === "unjoined" ? unjoined : changed);
      }
    }
    expect(order).toEqual(
      scenario === "initial-pin"
        ? ["launch", "completion"]
        : scenario === "refused"
          ? ["verify-before"]
          : scenario === "unjoined"
            ? ["verify-before", "launch", "completion"]
            : ["verify-before", "launch", "completion", "verify-after"],
    );
  },
);

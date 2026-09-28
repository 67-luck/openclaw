import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import vm from "node:vm";
import { parse } from "acorn";
import { describe, expect, it } from "vitest";
import {
  runManagedCommand,
  inspectManagedProcessGroup,
} from "../../scripts/lib/managed-child-process.mts";
import {
  createFixtureInput,
  createFixtureRelease,
} from "../../scripts/qa/windows-fileio/fixture-input.cjs";
import { recordRequestOnlyControl } from "../../scripts/qa/windows-fileio/record-request-only-control.mjs";
import { verifyDeletionControl } from "../../scripts/qa/windows-fileio/verify-deletion-control.mjs";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";

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
        records: [row] satisfies [typeof row],
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

function requestControl(mode: "loaded" | "unloaded") {
  const input = control(mode, 12, "4");
  const requestEvent = {
    evidenceKind: "request-event-only",
    pathProvenance: "explicit-FilePath",
    ...input.identity,
    threadId: 22,
    relativeTarget: "koffi.node",
    eventId: 26,
    eventVersion: 1,
    infoClass: 64,
    eventAt: "2026-09-28T00:00:00.005Z",
    completion: "unknown",
    ntStatus: null,
  };
  const facts = {
    phase: "owned-begin-facts",
    diagnosticOnly: true,
    unavailable: false,
    priorityTruncated: false,
    events: [{ requestEvent }] satisfies [{ requestEvent: typeof requestEvent }],
  };
  return {
    ...input,
    cell: {
      ...input.cell,
      enabledAcknowledged: true,
      targetJoinedAtObserverCompletion: false,
      observation: {
        ...input.cell.observation,
        ...input.identity,
        postStopAdmission: { state: "Live", admitted: true },
        projectionStarted: true,
        threadCoverage: { after: "completed" },
        partial: ["irp-reuse-without-end"],
        captureInterval: {
          startedAt: "2026-09-28T00:00:00.000Z",
          endedAt: "2026-09-28T00:00:01.000Z",
        },
      },
    },
    observer: {
      receipt: { ...input.observer.receipt, joined: true, jobObserved: true },
      records: [facts] satisfies [typeof facts],
    },
  };
}

describe("request-only diagnostic continuation", () => {
  it.each(["loaded", "unloaded"] as const)(
    "preserves the %s completed-deletion failure",
    (mode) => {
      const input = requestControl(mode);
      const fixture = input.target.records[0];
      assert.ok(fixture);
      Object.assign(fixture, { root: "C:\\PRIVATE_ROOT_CANARY", unneeded: "PRIVATE_FIELD_CANARY" });
      expect(() => verifyDeletionControl(input)).toThrow("No deletion-disposition completion");
      recordRequestOnlyControl(input);
      expect(input.cell).toHaveProperty("completedDeletionFailure", {
        name: "AssertionError",
        code: "ERR_ASSERTION",
        message: "No deletion-disposition completion was attributed",
        operator: "==",
        actual: false,
        expected: true,
      });
      expect(input.cell).toHaveProperty("requestEventEvidence.completion", "unknown");
      expect(input.cell).toHaveProperty(
        "unlinkResult.unlinkCode",
        mode === "loaded" ? "EPERM" : null,
      );
      expect(JSON.stringify(input.cell)).not.toContain("PRIVATE_");
      expect(input.cell).not.toHaveProperty("deletionCompletions");
      expect(() => verifyDeletionControl(input)).toThrow("No deletion-disposition completion");
    },
  );

  const failures: Array<[string, (input: ReturnType<typeof requestControl>) => void]> = [
    ["native refusal", (input) => (input.cell.observation.postStopAdmission.admitted = false)],
    ["loss", (input) => (input.cell.observation.loss.eventsLost = 1)],
    ["unknown loss", (input) => (input.cell.observation.loss.statisticsKnown = false)],
    ["timeout", (input) => (input.observer.receipt.elapsedMs = 5001)],
    ["observer failure", (input) => (input.cell.observerCode = 2)],
    ["unjoined", (input) => (input.observer.receipt.joined = false)],
    ["cleanup", (input) => (input.cell.observation.cleanupVerified = false)],
    [
      "capture failure",
      (input) => input.cell.observation.partial.push("capture-or-projection-incomplete"),
    ],
    ["guard failure", (input) => (input.cell.observation.threadCoverage.after = "unavailable")],
    ["priority overflow", (input) => (input.observer.records[0].priorityTruncated = true)],
    ["projection unavailable", (input) => (input.observer.records[0].unavailable = true)],
    [
      "outside interval",
      (input) =>
        (input.observer.records[0].events[0].requestEvent.eventAt = "2026-09-29T00:00:00Z"),
    ],
    [
      "wrong identity",
      (input) =>
        (input.observer.records[0].events[0].requestEvent.nativeStartFileTime =
          "133000000000000001"),
    ],
    [
      "wrong target",
      (input) => (input.observer.records[0].events[0].requestEvent.relativeTarget = "other.node"),
    ],
    [
      "mapped provenance",
      (input) => (input.observer.records[0].events[0].requestEvent.pathProvenance = "mapped"),
    ],
    ["missing actual unlink", (input) => (input.target.records = [])],
    ["unexpected completed proof", (input) => (input.cell.observation.records[0].eventId = 18)],
  ];
  it.each(failures)("aborts for %s instead of continuing", (_name, mutate) => {
    const input = requestControl("unloaded");
    if (_name === "unexpected completed proof") {
      input.cell.observation.records[0].infoClass = "64";
    }
    mutate(input);
    expect(() => recordRequestOnlyControl(input)).toThrow();
    expect(input.cell).not.toHaveProperty("completedDeletionFailure");
  });
});

// Execute the real cell and outer driver with only native commands replaced.
// This catches a caller that forgets aggregate failure or continues after cleanup failure.
describe("request-only control owner", () => {
  it.each(["known-completion-failure", "loss", "timeout", "cleanup"])(
    "%s preserves failure, continuation boundaries and cleanup",
    async (scenario) => {
      const source = fs.readFileSync(
        process.env.FILEIO_CONTROL_SOURCE ?? "scripts/qa/windows-fileio-control.mjs",
        "utf8",
      );
      const syntax = parse(source, { ecmaVersion: "latest", sourceType: "module" });
      const cellFunction = syntax.body.find(
        (node) => node.type === "FunctionDeclaration" && node.id?.name === "runCell",
      );
      const driver = syntax.body.find(
        (node) =>
          node.type === "VariableDeclaration" &&
          node.declarations.some(
            (declaration) =>
              declaration.id.type === "Identifier" && declaration.id.name === "failed",
          ),
      );
      assert.ok(cellFunction && driver);
      const lifetime = createFixtureLifetime();
      const root = lifetime.createTempDir("fileio-control-owner-");
      const privateRoot = path.join(root, "private");
      fs.mkdirSync(privateRoot);
      const saved = new Map<string, unknown>();
      const releases: string[] = [];
      const cleaned: string[] = [];
      const targets = new Map<string, { release: () => void }>();
      const processState = { execPath: process.execPath, exitCode: 0 };
      let ownerJoins = 0;
      try {
        const runSource = `(async () => {
            let admission;
            const cells = [];
            ${source.slice(cellFunction.start, cellFunction.end)}
            ${source.slice(driver.start)}
          })()`;
        const dependencies = {
          assert,
          fs,
          path,
          randomUUID,
          AbortController,
          BigInt,
          // Native acquisition is synthetic here; keep deliberate cleanup refusal
          // separate from the real lifetime that owns this test's temporary files.
          lifetime: {
            async acquire(
              body: (
                rollback: (cause: unknown, cleanup: () => Promise<void>) => Promise<never>,
              ) => Promise<{ cleanup: () => Promise<void> }>,
            ) {
              return body(async (cause, cleanup) => {
                await cleanup();
                throw cause;
              });
            },
            async cleanup() {
              ownerJoins++;
            },
          },
          mode: "run",
          addon: "owned-addon.node",
          helper: root,
          probe: "owned-probe.ps1",
          inspect: "owned-inspect.ps1",
          privateRoot,
          evidence: root,
          admissionFile: path.join(privateRoot, "installed-cleanup.json"),
          process: processState,
          persist() {},
          save(file: string, value: unknown) {
            saved.set(path.basename(file), structuredClone(value));
          },
          binding: () => [],
          hasUnjoinedWork: () => false,
          describeError: (error: Error) => ({ name: error.name }),
          recordRequestOnlyControl,
          verifyDeletionControl,
          async cleanupResource(resource: { name: string; cleanupVerified: boolean }) {
            cleaned.push(resource.name);
            if (scenario === "cleanup" && resource.name === "unloaded") {
              throw new Error("Synthetic native cleanup refusal");
            }
            Object.assign(resource, {
              cleanupVerified: true,
              cleanupOutcome: { acquisition: "not-started", traceAbsent: true, rawAbsent: true },
            });
          },
          async powershell(label: string) {
            if (label.endsWith(":identity")) {
              return [control("unloaded").identity];
            }
            if (label.endsWith(":query")) {
              return [{ wrongGuidRefused: true, ownerUnchanged: true }];
            }
            return [];
          },
          launch(
            label: string,
            _bin: string,
            args: string[],
            options: { onRecord?: (record: Record<string, unknown>) => void; timeoutMs: number },
          ) {
            const name = label.split(":")[0];
            assert.ok(name);
            if (label.endsWith(":fixture")) {
              expect(options.timeoutMs).toBe(30_000);
              const receipt = { joined: false, jobObserved: true };
              let resolve: (code: number) => void;
              const completion = new Promise<number>((done) => {
                resolve = done;
              });
              const release = () => {
                if (!receipt.joined) {
                  releases.push(name);
                  receipt.joined = true;
                  resolve(0);
                }
              };
              targets.set(name, { release });
              return {
                receipt,
                completion,
                records: control(args[1] === "loaded" ? "loaded" : "unloaded").target.records,
                async waitFor() {
                  options.onRecord?.({
                    event: "created",
                    root: path.join(
                      privateRoot,
                      name,
                      "fileio-probe",
                      "owned-addon-attribution-test",
                    ),
                  });
                  return { event: "ready", pid: 1234 };
                },
                fixtureInput(earlyExit: boolean) {
                  return {
                    observe: () => {
                      if (earlyExit) {
                        release();
                      }
                    },
                    release,
                  };
                },
              };
            }
            expect(options.timeoutMs).toBe(5000);
            const input = requestControl(name === "unloaded" ? "unloaded" : "loaded");
            if (name !== "wrong-start") {
              options.onRecord?.({ phase: "observing" });
            }
            const observation: Record<string, unknown> = {
              ...input.cell.observation,
              phase: "result",
            };
            if (name === "early-exit") {
              Object.assign(observation, {
                observation: "insufficient-evidence",
                records: [],
                postStopAdmission: { state: "Exited", admitted: false },
                projectionStarted: false,
                counts: { parsed: 0 },
              });
            }
            if (name === "wrong-start") {
              Object.assign(observation, {
                observation: "insufficient-evidence",
                identityRefused: true,
                records: [],
              });
            }
            if (scenario === "loss" && name === "unloaded") {
              input.cell.observation.loss.eventsLost = 1;
            }
            const completion =
              name === "observer-abort" || (scenario === "timeout" && name === "unloaded")
                ? Promise.reject(
                    Object.assign(new Error("Synthetic managed observer failure"), {
                      code: name === "observer-abort" ? "ABORT_ERR" : "ETIMEDOUT",
                    }),
                  )
                : Promise.resolve(0);
            return {
              ...input.observer,
              records: [...input.observer.records, observation],
              completion,
            };
          },
        };
        await vm.compileFunction(
          `return ${runSource}`,
          Object.keys(dependencies),
        )(...Object.values(dependencies));
        const summary = saved.get("run-summary.json");
        expect(summary).toMatchObject({ completed: false, rawArtifactsIncluded: false });
        expect(processState.exitCode).toBe(1);
        expect(ownerJoins).toBe(1);
        if (scenario === "known-completion-failure") {
          expect(cleaned).toEqual([
            "partial-preparation",
            "early-exit",
            "unloaded",
            "loaded",
            "wrong-start",
            "foreign-guid",
            "observer-abort",
          ]);
          expect(summary).toMatchObject({
            cleanupVerified: true,
            cells: [
              { qualified: true },
              { qualified: true },
              {
                name: "unloaded",
                qualified: false,
                requestEventEvidence: { completion: "unknown", ntStatus: null },
                completedDeletionFailure: {
                  message: "No deletion-disposition completion was attributed",
                },
                targetNaturalExit: true,
                cleanupVerified: true,
              },
              {
                name: "loaded",
                qualified: false,
                requestEventEvidence: { completion: "unknown", ntStatus: null },
                completedDeletionFailure: {
                  message: "No deletion-disposition completion was attributed",
                },
                targetNaturalExit: true,
                cleanupVerified: true,
              },
              { qualified: true },
              { qualified: true },
              { qualified: true },
            ],
          });
          expect(saved.get("run-failure.json")).toMatchObject({
            reason: "completed-deletion-unqualified",
          });
        } else {
          expect(cleaned).toContain("unloaded");
          expect(cleaned).not.toContain("loaded");
          expect(saved.has("run-failure.json")).toBe(true);
        }
        expect(releases).toContain("unloaded");
      } finally {
        for (const target of targets.values()) {
          target.release();
        }
        await lifetime.cleanup();
      }
    },
  );
});

describe("FileIO fixture stdin lifetime", () => {
  it.each([
    "held-until-release",
    "teardown-before-observe-sends-observe-then-release",
    "early-exit",
    "unexpected-eof",
    "literal-release-first-rejected",
    "early-failure-late-release",
  ])("%s uses the real pipe and joins with the expected outcome", async (mode) => {
    const lifetime = createFixtureLifetime();
    let child: ChildProcess | undefined;
    let completion: Promise<number> | undefined;
    let release: ReturnType<typeof createFixtureRelease> | undefined;
    const records: string[] = [];
    const listeners = new Set<(record: string) => void>();
    const inputErrors: string[] = [];
    let errorObserved: () => void;
    const inputFailed = new Promise<void>((resolve) => {
      errorObserved = resolve;
    });
    try {
      const root = lifetime.createTempDir("fileio-stdin-");
      const fixture = path.join(root, "child.cjs");
      const helper = path.resolve("scripts/qa/windows-fileio/fixture-input.cjs");
      fs.writeFileSync(
        fixture,
        `
const {createFixtureInput}=require(${JSON.stringify(helper)});
(async()=>{
 const commands=createFixtureInput(process.stdin);
 try {
  console.log('ready');
  await commands.read('observe\\n');
  console.log('performed');
  if(process.argv[2]==='early-failure-late-release') {process.exitCode=7;return;}
  if(process.argv[2]!=='early-exit') {
   await commands.read('release\\n');
   console.log('released');
  }
 } finally {await commands.close();}
})().catch(()=>{process.exitCode=1;});
`,
      );
      completion = lifetime.track(
        runManagedCommand({
          bin: process.execPath,
          args: [fixture, mode],
          cwd: root,
          env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
          timeoutMs: 30_000,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          onReady(launched) {
            child = launched;
            let carry = "";
            launched.stdout!.on("data", (chunk: Buffer) => {
              carry += chunk.toString();
              let newline;
              while ((newline = carry.indexOf("\n")) >= 0) {
                const record = carry.slice(0, newline);
                carry = carry.slice(newline + 1);
                records.push(record);
                for (const listener of listeners) {
                  listener(record);
                }
              }
            });
            launched.stderr!.resume();
          },
        }),
      );
      const waitFor = async (wanted: string) => {
        if (records.includes(wanted)) {
          return;
        }
        let listener: (record: string) => void;
        const found = new Promise<void>((resolve) => {
          listener = (record) => {
            if (record === wanted) {
              resolve();
            }
          };
          listeners.add(listener);
        });
        try {
          await Promise.race([
            found,
            completion!.then(() => {
              throw new Error("Handshake missing");
            }),
          ]);
        } finally {
          listeners.delete(listener!);
        }
      };
      await waitFor("ready");
      release = createFixtureRelease(
        child!.stdin!,
        mode === "early-exit",
        (error: NodeJS.ErrnoException) => {
          inputErrors.push(error.code ?? "unknown");
          errorObserved();
        },
      );
      if (mode === "literal-release-first-rejected") {
        child!.stdin!.end("release\n");
      } else if (mode === "teardown-before-observe-sends-observe-then-release") {
        release.release();
      } else {
        release.observe();
        await waitFor("performed");
        if (mode !== "early-exit") {
          if (mode !== "early-failure-late-release") {
            expect(child!.stdin!.writableEnded).toBe(false);
            expect(inspectManagedProcessGroup(child!, { errorPolicy: "indeterminate" })).toBe(
              "live",
            );
          }
          if (mode === "early-failure-late-release") {
            expect(await completion).toBe(7);
            release.release();
            await inputFailed;
          } else if (mode === "unexpected-eof") {
            child!.stdin!.end();
          } else {
            release.release();
          }
        }
      }
      const rejected = mode === "unexpected-eof" || mode === "literal-release-first-rejected";
      if (!rejected) {
        release.release();
      }
      expect(await completion).toBe(mode === "early-failure-late-release" ? 7 : rejected ? 1 : 0);
      expect(inspectManagedProcessGroup(child!, { errorPolicy: "indeterminate" })).toBe("dead");
      expect(records).toEqual(
        mode === "literal-release-first-rejected"
          ? ["ready"]
          : mode === "early-exit" ||
              mode === "unexpected-eof" ||
              mode === "early-failure-late-release"
            ? ["ready", "performed"]
            : ["ready", "performed", "released"],
      );
      if (mode === "early-failure-late-release") {
        expect(inputErrors).toHaveLength(1);
        expect(["ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END", "EPIPE"]).toContain(
          inputErrors[0],
        );
      } else {
        expect(inputErrors).toEqual([]);
      }
    } finally {
      if (child?.exitCode === null) {
        release?.release();
      }
      if (completion) {
        await completion.catch(() => undefined);
      }
      await lifetime.cleanup();
    }
  });
});

it("bounds fixture command bytes before accepting a command", async () => {
  const stream = Readable.from([Buffer.alloc(33, 65)]);
  const commands = createFixtureInput(stream);
  try {
    await expect(commands.read("observe\n")).rejects.toThrow("Fixture command byte bound");
  } finally {
    await commands.close();
  }
  expect(stream.destroyed).toBe(true);
});

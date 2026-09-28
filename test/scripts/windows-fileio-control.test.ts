import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  runManagedCommand,
  inspectManagedProcessGroup,
} from "../../scripts/lib/managed-child-process.mts";
import {
  createFixtureInput,
  createFixtureRelease,
} from "../../scripts/qa/windows-fileio/fixture-input.cjs";
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

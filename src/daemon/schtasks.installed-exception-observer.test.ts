import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { createInstalledExceptionObserver } from "./schtasks.installed-exception-observer.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

function frame(filename: string, index = 0, label = "ownedFailure") {
  return `    ${index}: ${label} [0x1234] [${filename}:12:3] [bytecode=0xabcd offset=17](this=0x4567,heap_argument_canary)`;
}

function exception(message: string, frames: string[] = [], length = message.length) {
  return [
    "Exception thrown:",
    "0x1234: [JS_ERROR_TYPE]",
    " - All own properties (excluding elements): {",
    `    0x1234: [String] in ReadOnlySpace: #message: 0x5678 <String[${length}]: #${message}> (const data field 2, attrs: [W_C]), location: in-object`,
    " }",
    "Stack Trace:",
    "==== JS stack trace =========================================",
    ...frames,
    "==== Details ================================================",
    "source and heap_local_canary must not escape",
    "",
  ].join("\n");
}

function project(raw: Buffer, installRoot: string, size = raw.length) {
  const observer = createInstalledExceptionObserver({ installRoot });
  for (let offset = 0; offset < raw.length; offset += size) {
    observer.write(raw.subarray(offset, offset + size));
  }
  return observer.finish((value) => value);
}

describe("installed V8 exception observation", () => {
  it.each([
    { prefix: "C:\\fixture\\home", label: "~" },
    { prefix: "C:\\fixture\\home\\.openclaw", label: "$OPENCLAW_STATE_DIR" },
  ])("withholds private Windows suffixes after $label support redaction", ({ prefix, label }) => {
    const message = `opening ${prefix}\\private_suffix_canary\\file`;
    const redact = (value: string) =>
      redactSupportString(value, {
        env: { HOME: "C:\\fixture\\home", USERPROFILE: "C:\\fixture\\home" },
        stateDir: "C:\\fixture\\home\\.openclaw",
      });
    expect(redact(message)).toContain(`${label}\\private_suffix_canary`);
    const observer = createInstalledExceptionObserver({ installRoot: "C:\\owned" });
    observer.write(Buffer.from(exception(message)));
    const result = observer.finish(redact);
    expect(JSON.stringify(result)).not.toContain("private_suffix_canary");
    expect(result.exceptions[0]?.message).toContain("opening");
  });
  it("projects a real caught exception without retaining heap, arguments, foreign paths or normal output", () => {
    const root = realpathSync(temporary.make("installed-v8-exception-"));
    const installRoot = path.join(root, "owned");
    mkdirSync(installRoot);
    const credential = "synthetic_credential_canary";
    writeFileSync(
      path.join(root, "foreign_module_canary.cjs"),
      "module.exports = function foreignCall(fn, value) { return fn(value); };\n",
    );
    const entry = path.join(installRoot, "caught.cjs");
    writeFileSync(
      entry,
      [
        'const call = require("../foreign_module_canary.cjs");',
        "function caughtError(value) {",
        '  const hidden = "heap_local_canary";',
        '  try { throw new Error("caught-update-failure " + value); } catch {}',
        "  return hidden.length;",
        "}",
        `call(caughtError, ${JSON.stringify(credential)});`,
        'process.stdout.write("normal_output_canary\\n");',
      ].join("\n"),
    );
    const child = spawnSync(process.execPath, ["--print-all-exceptions", entry], {
      env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    // Never give an assertion the raw buffers: failed tests must not dump V8 locals.
    expect(child.status).toBe(0);
    expect(child.signal).toBeNull();
    expect(child.stdout.includes(Buffer.from("Exception thrown:"))).toBe(true);
    expect(child.stdout.includes(Buffer.from("heap_local_canary"))).toBe(true);
    expect(child.stdout.includes(Buffer.from("normal_output_canary"))).toBe(true);
    const observer = createInstalledExceptionObserver({ installRoot });
    for (let offset = 0; offset < child.stdout.length; offset += 7) {
      observer.write(child.stdout.subarray(offset, offset + 7));
    }
    const result = observer.finish((value) => value.replaceAll(credential, "redacted"));
    const serialized = JSON.stringify(result);
    for (const withheld of [
      credential,
      "heap_local_canary",
      "foreign_module_canary",
      "normal_output_canary",
      root,
      "0x",
    ]) {
      expect(serialized.includes(withheld)).toBe(false);
    }
    const caught = result.exceptions.find(
      (value) => value.message === "caught-update-failure redacted",
    );
    expect(caught?.frames).toContainEqual(
      expect.objectContaining({ module: "caught.cjs", functionName: "caughtError" }),
    );
    expect(caught?.partial).toBe(false);
  });

  it("handles byte-split UTF-8 and CRLF while admitting only owned file locations", () => {
    const root = "C:\\fixture\\owned";
    const raw = Buffer.from(
      exception("caught café 🦞", [
        frame("C:\\fixture\\owned\\dist\\worker.mjs"),
        frame("file:///C:/fixture/owned/dist/next.mjs", 1, "next(aka next)"),
        frame("C:\\fixture\\owned-sibling\\foreign.mjs", 2),
        frame("C:\\fixture\\owned\\..\\foreign.mjs", 3),
        frame("node:internal/process/execution", 4),
        frame("C:\\fixture\\owned\\dist\\anonymous.mjs", 5, "/* anonymous */"),
      ]).replaceAll("\n", "\r\n"),
    );
    const original = Buffer.from(raw);
    const result = project(raw, root, 1);
    expect(raw.equals(original)).toBe(true);
    expect(result).toEqual(project(raw, root));
    expect(result.exceptions).toEqual([
      {
        message: "caught café 🦞",
        partial: false,
        frames: [
          { module: "worker.mjs", line: 12, column: 3, functionName: "ownedFailure" },
          { module: "next.mjs", line: 12, column: 3, functionName: "next" },
          { module: "anonymous.mjs", line: 12, column: 3, functionName: "anonymous" },
        ],
      },
    ]);
    expect(result.excludedFrames).toBe(3);
  });

  it("keeps the last 32 exceptions and accounts for discarded owned frames", () => {
    const raw = Buffer.from(
      Array.from({ length: 40 }, (_, index) =>
        exception(
          `failure ${index}`,
          Array.from({ length: 20 }, (_entry, frameIndex) =>
            frame("/owned/worker.mjs", frameIndex),
          ),
        ),
      ).join(""),
    );
    const result = project(raw, "/owned", 113);
    expect(result.observedExceptions).toBe(40);
    expect(result.droppedExceptions).toBe(8);
    expect(result.exceptions).toHaveLength(32);
    expect(result.exceptions[0]?.message).toBe("failure 8");
    expect(result.exceptions.at(-1)?.message).toBe("failure 39");
    expect(result.exceptions.every((value) => value.frames.length === 16 && value.partial)).toBe(
      true,
    );
    expect(result.droppedFrames).toBe(160);
    expect(result.partialExceptions).toBe(40);
    expect(result.outputTruncated).toBe(true);
  });

  it("withholds abbreviated, oversized and unfinished raw messages before redaction", () => {
    const observer = createInstalledExceptionObserver({ installRoot: "/owned" });
    const raw =
      exception("abbreviated", [], 20_000) +
      exception("x".repeat(20_000)) +
      "Exception thrown:\n - All own properties (excluding elements): {\n    0x1234: [String] in ReadOnlySpace: #message: 0x5678 <String[6]: #part";
    observer.write(Buffer.from(raw));
    let redactorCalls = 0;
    const result = observer.finish((value) => {
      redactorCalls++;
      return value;
    });
    expect(redactorCalls).toBe(0);
    expect(result.observedExceptions).toBe(3);
    expect(result.exceptions.every((value) => value.message === undefined && value.partial)).toBe(
      true,
    );
    expect(result.partialExceptions).toBe(3);
    expect(result.droppedLines).toBe(2);
  });

  it("redacts complete messages before clipping and withholds redaction failures", () => {
    const observer = createInstalledExceptionObserver({ installRoot: "/owned" });
    const message = `${"x".repeat(510)}credential_canary${"y".repeat(510)}`;
    observer.write(Buffer.from(exception(message)));
    let observedLength = 0;
    const result = observer.finish((value) => {
      observedLength = value.length;
      return value.replaceAll("credential_canary", "redacted");
    });
    expect(observedLength).toBe(message.length);
    expect(JSON.stringify(result).includes("credential")).toBe(false);
    expect(result.exceptions[0]?.message).toHaveLength(512);
    expect(result.exceptions[0]?.messageTruncated).toBe(true);
    expect(result.truncatedMessages).toBe(1);
    const refusing = createInstalledExceptionObserver({ installRoot: "/owned" });
    refusing.write(Buffer.from(exception("credential_canary", [frame("/owned/worker.mjs")])));
    const refused = refusing.finish(() => {
      throw new Error("redactor unavailable");
    });
    expect(JSON.stringify(refused).includes("credential_canary")).toBe(false);
    expect(refused.exceptions).toEqual([{ partial: true, frames: [] }]);
    expect(refused.redactionFailures).toBe(1);
  });

  it("removes message paths and pointers and caps the complete encoded projection", () => {
    const privateMessage = "failure at 0x1234 opening C:\\foreign\\private-file";
    const projection = project(Buffer.from(exception(privateMessage)), "/owned");
    expect(projection.exceptions[0]?.message).toBe("failure at [pointer] opening [redacted-path]");
    const root = temporary.make("installed-exception-cap-");
    const filename = path.join(root, `${"m".repeat(124)}.mjs`);
    const label = "f".repeat(128);
    const raw = Buffer.from(
      Array.from({ length: 32 }, (_, index) =>
        exception(
          `${index} ${"🦞".repeat(254)}`,
          Array.from({ length: 16 }, (_entry, frameIndex) =>
            frame(pathToFileURL(filename).href, frameIndex, label),
          ),
        ),
      ).join(""),
    );
    const result = project(raw, root, 4096);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
    expect(result.observedExceptions).toBe(32);
    expect(result.droppedExceptions).toBeGreaterThan(0);
    expect(result.droppedExceptions).toBe(32 - result.exceptions.length);
    expect(result.exceptions.at(-1)?.message?.startsWith("31 ")).toBe(true);
    expect(result.outputTruncated).toBe(true);
  });
});

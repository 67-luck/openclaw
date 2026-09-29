import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { compileFunction } from "node:vm";
import { parse } from "acorn";
import { expect, it } from "vitest";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { createDeferred } from "../helpers/promise.js";

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
  (node) => node.type === "FunctionDeclaration" && node.id?.name === "compareSameEtl",
);
assert.ok(declaration);

it.each([
  "success",
  "executable-refused",
  "executable-changed",
  "timeout-and-executable-changed",
  "runtime-version-mismatch",
  "runtime-clr-mismatch",
  "pending",
  "primary-unjoined",
  "trace-not-stopped",
  "wrong-primary-identity",
  "launch-throws",
  "launch-refused-joined",
  "timeout-joined",
  "unjoined",
  "nested-unjoined",
  "persist-pending-fails",
  "persist-joined-fails",
  "script-changed",
  "nonzero-exit",
  "unknown-id",
  "missing-id",
  "negative-count",
  "fraction-count",
  "count-overflow",
  "header-overflow",
  "invalid-runtime",
  "extra-envelope",
  "byte-overflow",
] as const)("compares only the retained ETL with existing custody: %s", async (scenario) => {
  const gate = createDeferred();
  const entered = createDeferred();
  const ownerFailure = Object.assign(
    new Error("PRIVATE_READER_ERROR"),
    scenario === "launch-refused-joined" ? { code: "ENOENT" } : { code: "ETIMEDOUT" },
  );
  const unjoined = Object.assign(new Error("PRIVATE_UNJOINED"), {
    processTreeState: "indeterminate",
  });
  const failure =
    scenario === "nested-unjoined"
      ? new Error("PRIVATE_WRAPPER", { cause: unjoined })
      : scenario === "unjoined"
        ? unjoined
        : ownerFailure;
  const admission: Record<string, unknown> = { rootDir: "/private/unloaded" };
  const persisted: unknown[] = [];
  const launches: Array<{ bin: string; args: string[]; timeoutMs: number; stdoutLimit: number }> =
    [];
  const counts = () =>
    Object.fromEntries([10, 11, 12, 13, 14, 15, 17, 18, 24, 26].map((id) => [id, 0]));
  const relevant = counts();
  relevant[26] = 1;
  const header = counts();
  header[26] = 1;
  const record = {
    phase: "same-etl-reader",
    diagnosticOnly: true,
    runtime: {
      psVersion: "7.6.0",
      edition: "Core",
      clrVersion: "10.0.0",
      is64BitProcess: true,
      rawPath: "PRIVATE_RUNTIME_PATH",
    },
    relevantEventCounts: relevant,
    headerPidMatchCounts: header,
    rawEvent: "PRIVATE_EVENT_PATH",
  };
  if (scenario === "unknown-id") {
    relevant[999] = 1;
  }
  if (scenario === "missing-id") {
    delete relevant[10];
  }
  if (scenario === "negative-count") {
    relevant[26] = -1;
  }
  if (scenario === "fraction-count") {
    relevant[26] = 0.5;
  }
  if (scenario === "count-overflow") {
    relevant[26] = 20001;
  }
  if (scenario === "header-overflow") {
    header[26] = 2;
  }
  if (scenario === "invalid-runtime") {
    record.runtime.edition = "PRIVATE_EDITION";
  }
  if (scenario === "runtime-version-mismatch") {
    record.runtime.psVersion = "7.6.1";
  }
  if (scenario === "runtime-clr-mismatch") {
    record.runtime.clrVersion = "10.0.1";
  }
  const core = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const descriptor = {
    receiptPath: "/private/unloaded/.fileio-private/trace.json",
    expectedGuid: "11111111-1111-4111-8111-111111111111",
    powerShellExe: core,
    powerShellSha256: "e".repeat(64),
    runtime: {
      executable: core,
      psVersion: "7.6.0",
      edition: "Core",
      clrVersion: "10.0.0",
      is64BitProcess: true,
    },
  };
  const verifierFailure = new Error("PRIVATE_EXECUTABLE_REFUSAL");
  let verifications = 0;
  let commandJoined = false;
  const hashCalls = new Map<string, number>();
  const dependencies = {
    assert,
    path,
    Buffer,
    hasUnjoinedWork,
    helper: "/trusted/helper",
    privateRoot: "/private",
    lifetime: {},
    commands: [],
    env: { PATH: "PRIVATE_SHADOW_PWSH" },
    async verifyInstalledFileIoExecutable(value: unknown, env: unknown) {
      expect(value).toBe(descriptor);
      expect(env).toEqual({ PATH: "PRIVATE_SHADOW_PWSH" });
      verifications++;
      if (verifications > 1) {
        expect(commandJoined).toBe(true);
      }
      if (
        scenario === "executable-refused" ||
        (verifications > 1 &&
          ["executable-changed", "timeout-and-executable-changed"].includes(scenario))
      ) {
        throw verifierFailure;
      }
    },
    hash(file: string) {
      const count = (hashCalls.get(file) ?? 0) + 1;
      hashCalls.set(file, count);
      return count > 1 && scenario === "script-changed" && file.endsWith(".ps1")
        ? "b".repeat(64)
        : "a".repeat(64);
    },
    async persistAdmission() {
      persisted.push(admission.fileIoReaderState);
      if (
        (scenario === "persist-pending-fails" && persisted.length === 1) ||
        (scenario === "persist-joined-fails" && persisted.length === 2)
      ) {
        throw ownerFailure;
      }
    },
    launchManaged(options: (typeof launches)[number]) {
      expect(persisted).toEqual(["pending"]);
      launches.push(options);
      entered.resolve();
      if (scenario === "launch-throws") {
        throw ownerFailure;
      }
      const receipt = { joined: false, jobObserved: scenario !== "launch-refused-joined" };
      const completion = (async () => {
        if (scenario === "pending") {
          await gate.promise;
        }
        receipt.joined = scenario !== "unjoined";
        commandJoined = receipt.joined;
        if (
          [
            "launch-refused-joined",
            "timeout-joined",
            "timeout-and-executable-changed",
            "unjoined",
            "nested-unjoined",
          ].includes(scenario)
        ) {
          throw failure;
        }
        return scenario === "nonzero-exit" ? 2 : 0;
      })();
      return {
        receipt,
        completion,
        result() {
          expect(receipt.joined).toBe(true);
          const suffix =
            scenario === "extra-envelope"
              ? "\n{}"
              : scenario === "byte-overflow"
                ? " ".repeat(4096)
                : "";
          return { stdout: JSON.stringify(record) + suffix };
        },
      };
    },
  };
  const compare = compileFunction(
    `${source.slice(declaration.start, declaration.end)};return compareSameEtl;`,
    Object.keys(dependencies),
  )(...Object.values(dependencies));
  const primary = {
    pid: 1234,
    nativeStartFileTime: "133000000000000000",
    cleanupVerified: scenario !== "trace-not-stopped",
    captureInterval: { endedAt: "2026-09-29T00:00:00Z" },
  };
  if (scenario === "wrong-primary-identity") {
    primary.pid++;
  }
  const completion = compare(
    descriptor,
    { pid: 1234, startTicks: "133000000000000000" },
    admission,
    primary,
    { joined: scenario !== "primary-unjoined", jobObserved: true },
  );
  if (scenario === "pending") {
    await Promise.race([entered.promise, completion]);
    expect(admission.fileIoReaderState).toBe("pending");
    expect(persisted).toEqual(["pending"]);
    gate.resolve();
  }
  let caught: unknown;
  const result = await completion.catch((error: unknown) => {
    caught = error;
  });
  const beforeLaunch = [
    "primary-unjoined",
    "trace-not-stopped",
    "wrong-primary-identity",
    "executable-refused",
  ].includes(scenario);
  if (beforeLaunch) {
    expect(launches).toEqual([]);
    expect(verifications).toBe(scenario === "executable-refused" ? 1 : 0);
    expect(persisted).toEqual([]);
    expect(admission.fileIoReaderState).toBeUndefined();
  } else {
    const uncertain = [
      "launch-throws",
      "persist-pending-fails",
      "unjoined",
      "nested-unjoined",
    ].includes(scenario);
    expect(admission.fileIoReaderState).toBe(uncertain ? "pending" : "joined");
    expect(hasUnjoinedWork(caught)).toBe(uncertain);
    expect(verifications).toBe(uncertain ? 1 : 2);
    if (launches.length) {
      expect(launches).toHaveLength(1);
      expect(launches[0]).toMatchObject({ bin: core, timeoutMs: 5000, stdoutLimit: 4096 });
      expect(launches[0]?.args).toEqual([
        "-NoProfile",
        "-NonInteractive",
        "-File",
        "/trusted/helper/Read-OwnedFileTrace.ps1",
        "-ReceiptPath",
        "/private/unloaded/.fileio-private/trace.json",
        "-ExpectedGuid",
        "11111111-1111-4111-8111-111111111111",
        "-TargetProcessId",
        "1234",
      ]);
    }
  }
  if (scenario === "success" || scenario === "pending") {
    expect(caught).toBeUndefined();
    expect(result).toEqual({
      phase: "same-etl-reader",
      diagnosticOnly: true,
      runtime: { psVersion: "7.6.0", edition: "Core", clrVersion: "10.0.0", is64BitProcess: true },
      relevantEventCounts: relevant,
      headerPidMatchCounts: header,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  } else {
    expect(caught).toBeInstanceOf(Error);
    expect(result).toBeUndefined();
    if (scenario === "timeout-and-executable-changed") {
      assert.ok(caught instanceof AggregateError);
      expect(caught.errors).toEqual([ownerFailure, verifierFailure]);
    }
    if (["launch-refused-joined", "timeout-joined", "persist-joined-fails"].includes(scenario)) {
      expect(caught).toBe(ownerFailure);
    }
  }
});

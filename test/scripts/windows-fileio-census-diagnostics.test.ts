import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { compileFunction } from "node:vm";
import { parse } from "acorn";
import { describe, expect, it } from "vitest";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { commandFailureFacts } from "../../src/daemon/schtasks.installed-fileio.test-support.js";
import { buildInstalledCensusInvocation } from "../../src/daemon/schtasks.integration-observation.test-support.js";

const source = fs.readFileSync(
  new URL("../../scripts/qa/windows-fileio-integration-control.mjs", import.meta.url),
  "utf8",
);
const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
function declaration(name: string) {
  for (const node of ast.body) {
    if (node.type === "FunctionDeclaration" && node.id?.name === name) {
      return source.slice(node.start, node.end);
    }
    if (node.type === "VariableDeclaration") {
      const entry = node.declarations.find(
        (value) => value.id.type === "Identifier" && value.id.name === name,
      );
      if (entry?.init) {
        return source.slice(entry.init.start, entry.init.end);
      }
    }
  }
  throw new Error(`Missing actual owner ${name}`);
}
const safeError = compileFunction(`return (${declaration("safeError")})`, [
  "hasUnjoinedWork",
  "commandFailureFacts",
])(hasUnjoinedWork, commandFailureFacts);
const censusStages = compileFunction(`return (${declaration("censusStages")})`)();
const instrumentCensusInvocation = compileFunction(
  `return ${declaration("instrumentCensusInvocation")}`,
  ["assert", "buildInstalledCensusInvocation"],
)(assert, buildInstalledCensusInvocation);
const marker = (stage: string) => JSON.stringify({ event: "census-stage", stage });

type Receipt = {
  error?: ReturnType<typeof commandFailureFacts> & { unjoined: boolean };
  commandPhase: string;
  observedExitCode: number | null;
  exitCode?: number;
  censusStageArrivals: { stage: string; pipeArrivalElapsedMs: number }[];
  joined: boolean;
};
function launchCase({
  error,
  lines = [],
  code = 0,
}: {
  error?: Error;
  lines?: string[];
  code?: number;
}) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    pid: 12,
  });
  const dependencies = {
    assert,
    StringDecoder,
    safeError,
    censusStages,
    performance: { now: () => 100 },
    inspectManagedProcessGroup: () => "dead",
    runManagedCommand: async ({ onReady }: { onReady: (child: EventEmitter) => void }) => {
      onReady(child);
      child.emit("message", { type: "ready", job: "owned" });
      child.emit("message", { type: "spawned", job: "owned", pid: 13 });
      await Promise.resolve();
      for (const line of lines) {
        const midpoint = Math.floor(line.length / 2);
        child.stderr.write(line.slice(0, midpoint));
        child.stderr.write(line.slice(midpoint));
      }
      child.stderr.end();
      child.stdout.end();
      child.emit("exit", code);
      if (error) {
        throw error;
      }
      return code;
    },
  };
  const launch = compileFunction(
    `return ${declaration("launchManaged")}`,
    Object.keys(dependencies),
  )(...Object.values(dependencies));
  const callbackFailure = new Error("private callback must never become an artifact");
  return {
    callbackFailure,
    command: launch({
      lifetime: { track: <T>(value: Promise<T>) => value },
      commands: [],
      env: {},
      label: "census",
      bin: "owned",
      args: [],
      timeoutMs: 5000,
      captureCensusStages: true,
      onStderrLine: () => {
        throw callbackFailure;
      },
    }) as { receipt: Receipt; completion: Promise<number> },
  };
}

describe("actual managed census diagnostic boundary", () => {
  it.each(["ETIMEDOUT", "ENOENT", "ERR_IPC_CHANNEL_CLOSED"])(
    "retains fixed %s without replacing the original failure",
    async (code) => {
      const failure = Object.assign(new Error("PRIVATE_ERROR_CANARY"), { code });
      const { command } = launchCase({ error: failure });
      await expect(command.completion).rejects.toBe(failure);
      expect(command.receipt.error?.errors[0]).toMatchObject({ code, category: "error" });
      expect(command.receipt.commandPhase).toBe("exited");
      expect(command.receipt.joined).toBe(true);
      expect(JSON.stringify(command.receipt)).not.toContain("PRIVATE_ERROR_CANARY");
    },
  );
  it("retains cleanup precedence and bounded nested facts without choosing a timeout verdict", async () => {
    const timeout = Object.assign(new Error("PRIVATE_TIMEOUT"), { code: "ETIMEDOUT" });
    const cleanup = Object.assign(new Error("PRIVATE_CLEANUP", { cause: timeout }), {
      code: "EPROCESSGROUP_CLEANUP_FAILED",
      manualRecoveryRequired: true,
      processTreeState: "indeterminate",
    });
    const nested = new AggregateError([timeout], "PRIVATE_AGGREGATE", { cause: cleanup });
    const small = launchCase({ error: nested }).command;
    await expect(small.completion).rejects.toBe(nested);
    expect(small.receipt.error?.errors.map((fact) => fact.code)).toEqual([
      null,
      "EPROCESSGROUP_CLEANUP_FAILED",
      "ETIMEDOUT",
    ]);
    const failure = new AggregateError(
      [cleanup, ...Array.from({ length: 20 }, () => new Error("PRIVATE_OTHER"))],
      "PRIVATE_AGGREGATE",
      { cause: cleanup },
    );
    const { command } = launchCase({ error: failure });
    await expect(command.completion).rejects.toBe(failure);
    expect(command.receipt.error?.errors[1]?.code).toBe("EPROCESSGROUP_CLEANUP_FAILED");
    expect(command.receipt.error?.errors.length).toBeLessThanOrEqual(8);
    expect(command.receipt.error?.errorsTruncated).toBe(true);
    expect(command.receipt.error?.unjoined).toBe(true);
    expect(JSON.stringify(command.receipt)).not.toContain("PRIVATE_");
  });
  it("keeps unknown codes null and numeric script exit distinct from timeout", async () => {
    const failure = Object.assign(new Error("PRIVATE_MESSAGE"), {
      code: "PRIVATE_CODE",
      reason: "PRIVATE_REASON",
    });
    const failed = launchCase({ error: failure }).command;
    await expect(failed.completion).rejects.toBe(failure);
    expect(failed.receipt.error?.errors[0]).toMatchObject({
      code: null,
      codePresent: true,
      reason: null,
    });
    expect(JSON.stringify(failed.receipt)).not.toContain("PRIVATE_");
    const script = launchCase({ code: 2 }).command;
    expect(await script.completion).toBe(2);
    expect(script.receipt.observedExitCode).toBe(2);
    expect(script.receipt.exitCode).toBe(2);
    expect(script.receipt.error).toBeUndefined();
  });
  it("records only five unique complete fixed markers and preserves unknown-line refusal", async () => {
    const stages = [
      "binding-text-decoded",
      "census-entered",
      "process-query-returned",
      "binding-decoded",
      "bootstrap-failed",
    ];
    const { command } = launchCase({
      lines: [...stages, ...stages].map((stage) => marker(stage) + "\n"),
    });
    expect(await command.completion).toBe(0);
    expect(command.receipt.censusStageArrivals).toEqual(
      stages.map((stage) => ({ stage, pipeArrivalElapsedMs: 0 })),
    );
    const partial = launchCase({ lines: [marker("census-entered")] }).command;
    await partial.completion;
    expect(partial.receipt.censusStageArrivals).toEqual([]);
    const unknown = launchCase({ lines: [marker("PRIVATE_UNKNOWN") + "\n"] });
    await expect(unknown.command.completion).rejects.toBe(unknown.callbackFailure);
    expect(unknown.command.receipt.censusStageArrivals).toEqual([]);
    expect(JSON.stringify(unknown.command.receipt)).not.toContain("PRIVATE_");
  });
});

it("instruments a trusted copy under the existing byte cap and refuses ambiguous query placement", () => {
  const binding =
    "$binding=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('e30=')) | ConvertFrom-Json";
  const script = `${binding}\n$all=@(Get-CimInstance Win32_Process)\n'{"ok":true}'`;
  const invocation = buildInstalledCensusInvocation(script);
  const instrumented = instrumentCensusInvocation(script);
  expect(instrumented.args.slice(0, 3)).toEqual(invocation.args.slice(0, 3));
  expect(() => instrumentCensusInvocation(script + script)).toThrow(
    "Expected exactly one process query",
  );
  expect(() => instrumentCensusInvocation(`${binding}\n${script}`)).toThrow(
    "Expected exactly one binding pipeline",
  );
  expect(() => instrumentCensusInvocation(script.replace(binding, ""))).toThrow(
    "Expected exactly one binding pipeline",
  );
  for (const collision of [
    "$__OPENCLAWFILEIOBINDINGTEXT=1",
    "${__openclawFileIoBindingText}=1",
    "$script:__openclawFileIoBindingText=1",
    "@__openclawFileIoBindingText",
    "Get-Variable __openclawFileIoBindingText",
  ]) {
    expect(() => instrumentCensusInvocation(`${script}\n${collision}`)).toThrow(
      "Private binding temporary collision",
    );
  }
  const conflictingBootstrap = compileFunction(
    `return ${declaration("instrumentCensusInvocation")}`,
    ["assert", "buildInstalledCensusInvocation"],
  )(assert, (value: string) => {
    const conflictingInvocation = buildInstalledCensusInvocation(value);
    conflictingInvocation.args[3] += "; $__openclawFileIoBindingText=1";
    return conflictingInvocation;
  });
  expect(() => conflictingBootstrap(script)).toThrow("Private binding temporary collision");
  expect(() =>
    instrumentCensusInvocation(
      script.replace("[Text.Encoding]::UTF8.GetString", "[Other]::Decode"),
    ),
  ).toThrow();
  const atLimit = script + " ".repeat(1024 * 1024 - Buffer.byteLength(script));
  expect(() => buildInstalledCensusInvocation(atLimit)).not.toThrow();
  expect(() => instrumentCensusInvocation(atLimit)).toThrow("Census input exceeds its byte bound");
});

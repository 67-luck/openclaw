#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import {
  createInstalledTerminalJsonCapture,
  projectInstalledUpdateProcessCapture,
} from "../../src/daemon/schtasks.installed-command.test-support.ts";
import {
  commandFailureFacts,
  prepareInstalledFileIo,
  cleanupInstalledFileIo,
} from "../../src/daemon/schtasks.installed-fileio.test-support.ts";
import { buildInstalledUpdateRetirementCensus } from "../../src/daemon/schtasks.installed-retirement-observation.test-support.ts";
import {
  buildInstalledCensusInvocation,
  readRelatedProcessDiagnosticsResult,
} from "../../src/daemon/schtasks.integration-observation.test-support.ts";
import { hasErrnoCode } from "../../src/infra/errno.ts";
import { resolveDiagnosticProcessEnv } from "../../src/infra/process-env.ts";
import {
  getWindowsInstallRoots,
  getWindowsPowerShellExePath,
} from "../../src/infra/windows-install-roots.ts";
import { redactSupportString } from "../../src/logging/diagnostic-support-redaction.ts";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.ts";
import {
  hasUnjoinedWork,
  inspectManagedProcessGroup,
  runManagedCommand,
} from "../lib/managed-child-process.mts";
import { createFixtureRelease } from "./windows-fileio/fixture-input.cjs";
import { recordRequestOnlyControl } from "./windows-fileio/record-request-only-control.mjs";

const helper = fileURLToPath(new URL("./windows-fileio/", import.meta.url));
const addonSha256 = "939156f310bd7a7d9d1db1b5249a5d135739b049c24c79fd3c201701333ddbf3";
const nodeSha256 = "23062343ad39fc79f12ae39cfb324e93a20ced5f1d342e7b850c148c022ddbca";
const enabledLine = '{"event":"fileio-enabled"}';
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const save = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flush: true });
const safeError = (error) => ({
  name: error instanceof Error ? error.name : "Error",
  unjoined: hasUnjoinedWork(error),
  ...commandFailureFacts(error),
});

/** Only a trusted control copy gains the fixed post-Enable handshake. */
export function instrumentCensus(script, blockAfterEnable = false) {
  const marker = "Invoke-OwnedFileTraceOperation -Mode observe";
  assert.equal(script.split(marker).length, 2, "Expected exactly one canonical observe call");
  const block = blockAfterEnable
    ? "$gate=[Threading.ManualResetEvent]::new($false);try{[void]$gate.WaitOne()}finally{$gate.Dispose()}"
    : "";
  return script.replace(
    marker,
    `${marker} -PublishFact {param($fact) if($fact.phase -ceq 'observing'){[Console]::Error.WriteLine('${enabledLine}');${block}}}`,
  );
}

const censusStages = [
  "binding-text-decoded",
  "census-entered",
  "process-query-returned",
  "binding-decoded",
  "bootstrap-failed",
];

/** Only trusted control copies publish fixed stage facts; the production transport stays intact. */
function instrumentCensusInvocation(script) {
  const emit = (stage) =>
    `[Console]::Error.WriteLine('{"event":"census-stage","stage":"${stage}"}');`;
  const query = "$all=@(Get-CimInstance Win32_Process)";
  assert.equal(script.split(query).length, 2, "Expected exactly one process query");
  const bindings = script
    .split("\n")
    .filter((line) => line.startsWith("$binding=") && line.endsWith(" | ConvertFrom-Json"));
  assert.equal(bindings.length, 1, "Expected exactly one binding pipeline");
  const temporary = "__openclawFileIoBindingText";
  assert.ok(
    !script.toLowerCase().includes(temporary.toLowerCase()),
    "Private binding temporary collision",
  );
  const rhs = bindings[0].slice("$binding=".length, -" | ConvertFrom-Json".length);
  assert.match(
    rhs,
    /^\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('[A-Za-z0-9+/]*={0,2}'\)\)$/u,
  );
  const instrumented = script
    .replace(
      bindings[0],
      `try {\n$${temporary}=${rhs}\n${emit("binding-text-decoded")}\n$binding=$${temporary} | ConvertFrom-Json\n} finally {$${temporary}=$null}\n${emit("binding-decoded")}`,
    )
    .replace(query, `${query}\n${emit("process-query-returned")}`);
  // Apply the existing byte limit to the complete instrumented input.
  const invocation = buildInstalledCensusInvocation(`${emit("census-entered")}\n${instrumented}`);
  assert.ok(
    !invocation.args.some((arg) => arg.toLowerCase().includes(temporary.toLowerCase())),
    "Private binding temporary collision",
  );
  assert.equal(invocation.args.length, 4);
  assert.equal(invocation.args[2], "-Command");
  return {
    args: [
      ...invocation.args.slice(0, 3),
      `try {${invocation.args[3]}} catch {${emit("bootstrap-failed")} throw}`,
    ],
    input: invocation.input,
  };
}

/** Raw host-wide envelopes must cross both existing boundaries before retention. */
export function projectCensusResult(context, result, needles, binding) {
  return projectInstalledUpdateProcessCapture(
    context,
    readRelatedProcessDiagnosticsResult(result, needles, binding),
  );
}

// This copy preserves the real synchronous caller and its original 5000ms timeout.
// Its builder is the sole replaced dependency; the spawn delegate observes only
// fixed result metadata and then returns the untouched result to the real receiver.
function synchronousTimeoutControl(binding, context, needles) {
  const source = fs.readFileSync(
    fileURLToPath(
      new URL("../../src/daemon/schtasks.integration-observation.test-support.ts", import.meta.url),
    ),
    "utf8",
  );
  const begin = source.indexOf("export function readRelatedProcessDiagnostics(");
  const end = source.indexOf("\nexport function ", begin + 1);
  assert.ok(begin >= 0 && end > begin);
  const declaration = stripTypeScriptTypes(source.slice(begin, end).replace("export ", ""));
  let receipt;
  const invoke = compileFunction(`${declaration}\nreturn readRelatedProcessDiagnostics;`, [
    "spawnSync",
    "getWindowsPowerShellExePath",
    "buildInstalledUpdateRetirementCensus",
    "buildInstalledCensusInvocation",
    "readRelatedProcessDiagnosticsResult",
  ])(
    (...args) => {
      const result = spawnSync(...args);
      receipt = {
        pid: result.pid,
        errorCode: result.error?.code,
        enabledAcknowledged: result.stderr?.trim() === enabledLine,
        status: result.status,
        signal: result.signal,
      };
      return result;
    },
    getWindowsPowerShellExePath,
    (value) => instrumentCensus(buildInstalledUpdateRetirementCensus(value), true),
    buildInstalledCensusInvocation,
    readRelatedProcessDiagnosticsResult,
  );
  const started = performance.now();
  const capture = projectInstalledUpdateProcessCapture(context, invoke(needles, binding));
  assert.equal(receipt?.errorCode, "ETIMEDOUT");
  assert.equal(receipt.enabledAcknowledged, true);
  assert.ok(Number.isSafeInteger(receipt.pid) && receipt.pid > 0);
  return { capture, receipt: { ...receipt, elapsedMs: performance.now() - started } };
}

function launchManaged({
  lifetime,
  commands,
  env,
  label,
  bin,
  args,
  input,
  timeoutMs,
  stdoutLimit = 1024 * 1024,
  onStdout,
  onStderrLine,
  captureCensusStages = false,
  signal,
}) {
  const started = performance.now();
  const receipt = {
    label,
    commandStartedAtMs: Date.now(),
    timeoutMs,
    joined: false,
    jobObserved: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    // Last observed handle event; Windows exit comes from the managed launcher.
    commandPhase: "created",
    observedExitCode: null,
    censusStageArrivals: [],
  };
  commands.push(receipt);
  let child;
  let stdout = "";
  let stderr = "";
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let badOutput = false;
  let callbackError;
  let inputError;
  const completion = lifetime.track(
    runManagedCommand({
      bin,
      args,
      env,
      shell: false,
      signal,
      timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
      onReady(launched) {
        child = launched;
        receipt.commandPhase = "on-ready";
        launched.once("exit", (code) => {
          receipt.commandPhase = "exited";
          receipt.observedExitCode = Number.isInteger(code) ? code : null;
        });
        receipt.launcherPid = launched.pid;
        launched.on("message", (message) => {
          if (message?.type === "ready" && typeof message.job === "string") {
            receipt.launcherReadyAtMs ??= Date.now();
            receipt.commandPhase = "launcher-ready";
          }
          if (
            message?.type === "spawned" &&
            typeof message.job === "string" &&
            Number.isSafeInteger(message.pid) &&
            message.pid > 0
          ) {
            receipt.jobObserved = true;
            receipt.commandPhase = "spawned";
            receipt.commandPid = message.pid;
            receipt.commandSpawnedAtMs = Date.now();
          }
        });
        launched.stdout.on("data", (chunk) => {
          receipt.stdoutBytes += chunk.length;
          if (receipt.stdoutBytes > stdoutLimit) {
            badOutput = true;
            try {
              onStdout?.(stdout, true);
            } catch (error) {
              callbackError ??= error;
            }
            return;
          }
          stdout += stdoutDecoder.write(chunk);
          try {
            onStdout?.(stdout, badOutput);
          } catch (error) {
            callbackError = error;
          }
        });
        launched.stdout.once("end", () => {
          const tail = stdoutDecoder.end();
          if (tail && !badOutput) {
            stdout += tail;
            try {
              onStdout?.(stdout);
            } catch (error) {
              callbackError ??= error;
            }
          }
        });
        const receiveStderr = (text) => {
          stderr += text;
          let newline;
          while ((newline = stderr.indexOf("\n")) !== -1) {
            const line = stderr.slice(0, newline).trim();
            stderr = stderr.slice(newline + 1);
            try {
              const stage =
                captureCensusStages &&
                censusStages.find(
                  (value) => line === JSON.stringify({ event: "census-stage", stage: value }),
                );
              if (stage) {
                if (!receipt.censusStageArrivals.some((entry) => entry.stage === stage)) {
                  receipt.censusStageArrivals.push({
                    stage,
                    pipeArrivalElapsedMs: Math.round(performance.now() - started),
                  });
                }
              } else if (line) {
                onStderrLine?.(line);
              }
            } catch (error) {
              callbackError = error;
            }
          }
        };
        launched.stderr.on("data", (chunk) => {
          receipt.stderrBytes += chunk.length;
          if (receipt.stderrBytes > 32768) {
            badOutput = true;
            try {
              onStdout?.(stdout, true);
            } catch (error) {
              callbackError ??= error;
            }
            return;
          }
          receiveStderr(stderrDecoder.write(chunk));
        });
        launched.stderr.once("end", () => {
          const tail = stderrDecoder.end();
          if (tail && !badOutput) {
            receiveStderr(tail);
          }
        });
        if (input !== undefined) {
          const reportInputError = (error) => {
            if (!error || inputError) {
              return;
            }
            inputError = error;
            receipt.stdinError = safeError(error);
          };
          launched.stdin.on("error", reportInputError);
          try {
            launched.stdin.end(input, "utf8", reportInputError);
          } catch (error) {
            reportInputError(error);
          }
        }
      },
    })
      .then((code) => {
        receipt.exitCode = code;
        if (inputError) {
          throw inputError;
        }
        assert.equal(badOutput, false, "Control capture bound exceeded");
        if (callbackError) {
          throw callbackError;
        }
        return code;
      })
      .catch((/** @type {unknown} */ error) => {
        const failure =
          error instanceof Error
            ? error
            : new Error("Managed control command failed", { cause: error });
        receipt.error = safeError(failure);
        throw failure;
      })
      .finally(() => {
        receipt.elapsedMs = performance.now() - started;
        receipt.joined = Boolean(
          child && inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" }) === "dead",
        );
      }),
  );
  void completion.catch(() => {});
  return {
    receipt,
    completion,
    get child() {
      return child;
    },
    result() {
      assert.ok(receipt.joined, "Census owner must join before output projection");
      assert.equal(badOutput, false);
      return { status: receipt.exitCode, stdout, stderr: "" };
    },
  };
}

function fixtureTarget(options, argv) {
  const records = [];
  const listeners = new Set();
  let capturedStdout = "";
  let captureTruncated = false;
  const publish = (record) => {
    records.push(record);
    for (const listener of listeners) {
      listener(record);
    }
  };
  const terminal = createInstalledTerminalJsonCapture(
    (value) => redactSupportString(value, options.context, { maxLength: 2_000 }),
    (fact) => {
      if (fact) {
        publish({ event: "terminal", fact });
      }
    },
  );
  const target = launchManaged({
    ...options,
    bin: process.execPath,
    args: argv,
    timeoutMs: 30_000,
    stdoutLimit: 8192,
    onStdout(stdout, truncated = false) {
      capturedStdout = stdout;
      captureTruncated ||= truncated;
      terminal.observe(stdout, truncated, Date.now());
    },
    onStderrLine(line) {
      const record = JSON.parse(line);
      assert.ok(
        record?.event === "ready" ||
          record?.event === "result" ||
          record?.event === "fixture-failed",
      );
      assert.ok(Buffer.byteLength(line) <= 2048);
      // Reject additional keys before retaining even task-owned fixture output.
      const allowed =
        record.event === "ready"
          ? ["event", "mode", "pid", "modulePresent", "addonSha256"]
          : record.event === "result"
            ? [
                "event",
                "mode",
                "pid",
                "modulePresent",
                "beganAt",
                "endedAt",
                "operation",
                "target",
                "unlinkCode",
              ]
            : ["event", "observation"];
      assert.ok(Object.keys(record).every((key) => allowed.includes(key)));
      publish(record);
    },
  });
  return {
    ...target,
    get child() {
      return target.child;
    },
    records,
    get terminal() {
      return terminal.current();
    },
    final() {
      assert.equal(target.receipt.joined, true);
      return terminal.final(capturedStdout, captureTruncated);
    },
    async waitFor(event) {
      const existing = records.find((record) => record.event === event);
      if (existing) {
        return existing;
      }
      let listener;
      const ready = new Promise((resolve) => {
        listener = (record) => {
          if (record.event === event) {
            resolve(record);
          }
        };
        listeners.add(listener);
      });
      try {
        return await Promise.race([
          ready,
          target.completion.then(() => {
            throw new Error("Fixture handshake missing");
          }),
        ]);
      } finally {
        listeners.delete(listener);
      }
    },
  };
}

async function main() {
  const [mode, addon, evidence, privateRoot] = process.argv.slice(2);
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.equal(process.version, "v26.8.2");
  assert.equal(process.argv.length, 6);
  assert.ok(mode === "run" || mode === "cleanup");
  assert.equal(hash(process.execPath), nodeSha256);
  assert.equal(hash(addon), addonSha256);
  const inputs = JSON.parse(fs.readFileSync(path.join(evidence, "inputs.json"), "utf8"));
  const toolingSha = inputs.source;
  assert.match(toolingSha, /^[a-f0-9]{40}$/u);
  const lifetime = createFixtureLifetime(privateRoot);
  const admissions = [];
  const commands = [];
  const cells = [];
  const admissionFile = path.join(privateRoot, "integration-admission.json");
  const env = resolveDiagnosticProcessEnv(process.env, "win32");
  const persistAdmission = async () => {
    save(`${admissionFile}.next`, admissions);
    fs.renameSync(`${admissionFile}.next`, admissionFile);
  };
  const safeCommands = () =>
    commands.map((command) => ({
      ...command,
      ...(command.runtime
        ? { runtime: { ...command.runtime, executable: "<windows-powershell>" } }
        : {}),
    }));
  const persistEvidence = () => {
    if (mode === "run") {
      save(path.join(evidence, "integration-cells.json"), cells);
    }
    save(path.join(evidence, `${mode}-commands.json`), safeCommands());
  };
  let failed = false;
  async function cleanupAdmission(admission) {
    assert.equal(path.dirname(admission.rootDir), privateRoot);
    assert.match(
      path.basename(admission.rootDir),
      /^(?:loaded|unloaded|absent-pin|wrong-pin|wrong-dll|wrong-runtime|wrong-custody|sync-timeout|fixture-abort)$/u,
    );
    assert.equal(admission.installRoot, path.join(admission.rootDir, "install"));
    if (admission.fileIo) {
      await cleanupInstalledFileIo({
        task: { rootDir: admission.rootDir, installRoot: admission.installRoot, env },
        admission,
        toolingSha,
        lifetime,
        commandFacts: commands,
      });
    }
    admission.cleanupVerified = true;
    await persistAdmission();
  }
  async function census(binding, context, label, onEnabled) {
    const generated = buildInstalledUpdateRetirementCensus(binding);
    const script = binding.fileIo ? instrumentCensus(generated) : generated;
    const invocation = instrumentCensusInvocation(script);
    const observer = launchManaged({
      lifetime,
      commands,
      env,
      label,
      bin: getWindowsPowerShellExePath(),
      args: invocation.args,
      input: invocation.input,
      timeoutMs: 5000,
      captureCensusStages: true,
      onStderrLine(line) {
        assert.equal(line, enabledLine);
        onEnabled?.();
      },
    });
    assert.equal(await observer.completion, 0);
    assert.ok(observer.receipt.joined && observer.receipt.jobObserved);
    const capture = projectCensusResult(context, observer.result(), [binding.globalRoot], binding);
    return { observer, capture };
  }
  async function compareSameEtl(descriptor, identity, admission, primary, primaryReceipt) {
    assert.ok(primaryReceipt.joined && primaryReceipt.jobObserved);
    assert.equal(primary.cleanupVerified, true);
    assert.equal(primary.pid, identity.pid);
    assert.equal(primary.nativeStartFileTime, identity.startTicks);
    assert.ok(primary.captureInterval?.endedAt);
    const script = path.join(helper, "Read-OwnedFileTrace.ps1");
    const scriptSha256 = hash(script);
    // The copied diagnostic environment uses the existing pure root resolver.
    const core = path.win32.join(
      getWindowsInstallRoots(env).programFiles,
      "PowerShell",
      "7",
      "pwsh.exe",
    );
    const coreStat = fs.lstatSync(core);
    assert.ok(coreStat.isFile() && !coreStat.isSymbolicLink());
    assert.equal(
      path.win32.toNamespacedPath(fs.realpathSync.native(core)).toLowerCase(),
      path.win32.toNamespacedPath(core).toLowerCase(),
    );
    const coreSha256 = hash(core);
    let reader;
    let projection;
    const errors = [];
    assert.equal(admission.fileIoReaderState, undefined);
    admission.fileIoReaderState = "pending";
    try {
      await persistAdmission();
      reader = launchManaged({
        lifetime,
        commands,
        env,
        label: `${admission.rootDir === path.join(privateRoot, "unloaded") ? "unloaded" : "loaded"}:same-etl-reader`,
        bin: core,
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          script,
          "-ReceiptPath",
          descriptor.receiptPath,
          "-ExpectedGuid",
          descriptor.expectedGuid,
          "-TargetProcessId",
          String(identity.pid),
        ],
        timeoutMs: 5000,
        stdoutLimit: 4096,
      });
      assert.equal(await reader.completion, 0);
      assert.ok(reader.receipt.joined && reader.receipt.jobObserved);
      const output = reader.result().stdout;
      assert.ok(Buffer.byteLength(output) <= 4096);
      const record = JSON.parse(output);
      assert.equal(record.phase, "same-etl-reader");
      assert.equal(record.diagnosticOnly, true);
      const runtime = record.runtime;
      assert.equal(runtime.edition, "Core");
      assert.equal(runtime.is64BitProcess, true);
      for (const version of [runtime.psVersion, runtime.clrVersion]) {
        assert.equal(typeof version, "string");
        assert.ok(version.length <= 64);
        assert.match(version, /^\d+\.\d+\.\d+(?:\.\d+)?$/u);
      }
      const ids = [10, 11, 12, 13, 14, 15, 17, 18, 24, 26];
      const counts = (value) => {
        assert.ok(value && typeof value === "object" && !Array.isArray(value));
        assert.equal(Object.keys(value).length, ids.length);
        return Object.fromEntries(
          ids.map((id) => {
            assert.ok(Number.isInteger(value[id]) && value[id] >= 0 && value[id] <= 20000);
            return [id, value[id]];
          }),
        );
      };
      const relevantEventCounts = counts(record.relevantEventCounts);
      const headerPidMatchCounts = counts(record.headerPidMatchCounts);
      assert.ok(ids.every((id) => headerPidMatchCounts[id] <= relevantEventCounts[id]));
      projection = {
        phase: "same-etl-reader",
        diagnosticOnly: true,
        runtime: {
          psVersion: runtime.psVersion,
          edition: runtime.edition,
          clrVersion: runtime.clrVersion,
          is64BitProcess: runtime.is64BitProcess,
        },
        relevantEventCounts,
        headerPidMatchCounts,
      };
    } catch (error) {
      errors.push(error);
    } finally {
      // Only this command owner's actual receipt can release shared ETL custody.
      if (reader?.receipt.joined === true && !errors.some(hasUnjoinedWork)) {
        try {
          assert.equal(hash(script), scriptSha256);
          assert.equal(hash(core), coreSha256);
        } catch (error) {
          errors.push(error);
        }
        admission.fileIoReaderState = "joined";
        try {
          await persistAdmission();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (admission.fileIoReaderState !== "joined") {
      throw Object.assign(
        new AggregateError(errors, "Diagnostic ETL reader settlement unverified"),
        {
          processTreeState: "indeterminate",
        },
      );
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length) {
      throw new AggregateError(errors, "Diagnostic ETL reader or custody write failed");
    }
    return projection;
  }
  async function nativeLifetimeControl(descriptor, cell) {
    const script = path.join(helper, "Inspect-LifetimeControl.ps1");
    const scriptSha256 = hash(script);
    const fixture = path.join(helper, "lifetime-fixture.cjs");
    const fixtureInput = path.join(helper, "fixture-input.cjs");
    const fixtureSha256 = hash(fixture);
    const fixtureInputSha256 = hash(fixtureInput);
    assert.equal(hash(process.execPath), nodeSha256);
    const control = launchManaged({
      lifetime,
      commands,
      env,
      label: "unloaded:native-lifetime-contract",
      bin: descriptor.powerShellExe,
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        script,
        "-DllPath",
        descriptor.dllPath,
        "-ExpectedDllSha256",
        descriptor.dllSha256,
        "-ExpectedSourceSha256",
        descriptor.sourceSha256,
        "-NodeExe",
        process.execPath,
        "-ExpectedNodeSha256",
        nodeSha256,
        "-ExpectedFixtureSha256",
        fixtureSha256,
        "-ExpectedFixtureInputSha256",
        fixtureInputSha256,
      ],
      timeoutMs: 30_000,
      stdoutLimit: 4096,
    });
    const code = await control.completion;
    const record = JSON.parse(control.result().stdout);
    const stages = [
      "binding",
      "compile-control",
      "process-start",
      "process-ready",
      "process-creation",
      "process-hold",
      "process-lease",
      "process-terminal-write",
      "process-terminal-ack",
      "process-live",
      "process-exited",
      "thread-start",
      "thread-live",
      "thread-exited",
      "complete",
    ];
    const fields = [
      "processLive",
      "processInsideExit",
      "processAfterExit",
      "threadLive",
      "threadInsideExit",
      "threadAfterExit",
      "naturalRelease",
    ];
    const facts = Object.fromEntries(
      fields.map((field) => [field, typeof record[field] === "boolean" ? record[field] : null]),
    );
    const observationFields = [
      "childHasExited",
      "callCompleted",
      "querySucceeded",
      "creationMatches",
      "eventNotBeforeCreation",
      "exitTimePresent",
      "eventNotAfterExit",
      "containsTime",
    ];
    const processLiveObservation = Object.fromEntries(
      observationFields.map((field) => {
        const value = record.processLiveObservation?.[field];
        return [field, typeof value === "boolean" ? value : null];
      }),
    );
    const threadObservationFields = [
      "workerAlive",
      "belongsAtCallCompleted",
      "belongsAt",
      "oracleCallCompleted",
      "oracleQuerySucceeded",
      "oracleCreationNotAfterSample",
    ];
    const threadLiveObservation = Object.fromEntries(
      threadObservationFields.map((field) => {
        const value = record.threadLiveObservation?.[field];
        return [field, typeof value === "boolean" ? value : null];
      }),
    );
    const terminalFailureCategories = ["bom-prefix", "eof", "mismatch", "other"];
    cell.nativeLifetimeControl = {
      passed: typeof record.passed === "boolean" ? record.passed : null,
      stage: stages.includes(record.stage) ? record.stage : "unknown",
      scriptSha256,
      sourceSha256: descriptor.sourceSha256,
      dllSha256: descriptor.dllSha256,
      nodeSha256,
      fixtureSha256,
      fixtureInputSha256,
      ...facts,
      processLiveObservation,
      threadLiveObservation,
      terminalInputFailure: terminalFailureCategories.includes(record.terminalInputFailure)
        ? record.terminalInputFailure
        : null,
    };
    assert.equal(code, 0);
    assert.ok(control.receipt.joined && control.receipt.jobObserved);
    assert.equal(record.phase, "native-lifetime-control");
    assert.equal(record.sourceSha256, descriptor.sourceSha256);
    assert.equal(record.dllSha256, descriptor.dllSha256);
    assert.equal(hash(script), scriptSha256);
    assert.equal(hash(process.execPath), nodeSha256);
    assert.equal(hash(fixture), fixtureSha256);
    assert.equal(hash(fixtureInput), fixtureInputSha256);
    assert.equal(record.nodeSha256, nodeSha256);
    assert.equal(record.fixtureSha256, fixtureSha256);
    assert.equal(record.fixtureInputSha256, fixtureInputSha256);
    assert.equal(cell.nativeLifetimeControl.stage, "complete");
    assert.equal(cell.nativeLifetimeControl.passed, true);
    assert.equal(cell.nativeLifetimeControl.terminalInputFailure, null);
    assert.ok(Object.values(facts).every((value) => value === true));
  }
  async function runCell(name, fixtureMode) {
    const rootDir = path.join(privateRoot, name);
    const installRoot = path.join(rootDir, "install");
    const globalRoot = path.join(installRoot, "node_modules");
    const admission = { role: "selected", rootDir, installRoot, cleanupVerified: false };
    admissions.push(admission);
    await persistAdmission();
    fs.mkdirSync(globalRoot, { recursive: true });
    const cell = { name, fixtureMode, qualified: false, diagnosticOnly: true };
    cells.push(cell);
    const prepared = await prepareInstalledFileIo({
      task: { rootDir, installRoot, env },
      toolingSha,
      admission,
      persistAdmission,
      lifetime,
      ownedPrefix: globalRoot,
      commandFacts: commands,
    });
    const context = { env, stateDir: rootDir };
    const entry = path.join(helper, "integration-fixture.cjs");
    const argv = [
      entry,
      "--profile",
      "fileio-integration-control",
      "update",
      `__fileio_${fixtureMode}`,
      addon,
      globalRoot,
    ];
    const abort = new AbortController();
    let target;
    let release;
    let terminalSent = false;
    let inputError;
    const reportInputError = (error) => {
      if (!error || inputError) {
        return;
      }
      inputError = error;
      target.receipt.stdinError = safeError(error);
      if (!target.receipt.joined) {
        abort.abort();
      }
    };
    const sendTerminal = () => {
      if (!target || terminalSent || inputError || target.receipt.joined) {
        return;
      }
      terminalSent = true;
      try {
        target.child.stdin.write("terminal\n", reportInputError);
      } catch (error) {
        reportInputError(error);
      }
    };
    const joinTarget = async () => {
      if (!target) {
        return;
      }
      if (!target.receipt.joined) {
        if (release) {
          sendTerminal();
          release.release();
        } else {
          abort.abort();
        }
      }
      /** @type {Error | undefined} */
      let targetFailure;
      const code = await target.completion.catch((/** @type {unknown} */ error) => {
        targetFailure =
          error instanceof Error ? error : new Error("Fixture command failed", { cause: error });
      });
      if (targetFailure && hasUnjoinedWork(targetFailure)) {
        throw targetFailure;
      }
      assert.ok(target.receipt.joined && target.receipt.jobObserved);
      cell.completedTerminalJson = target.final().completedTerminalJson;
      if (inputError) {
        throw inputError;
      }
      if (
        targetFailure &&
        (name !== "fixture-abort" || !hasErrnoCode(targetFailure, "ABORT_ERR"))
      ) {
        throw targetFailure;
      }
      if (name !== "fixture-abort") {
        assert.equal(code, 0);
        assert.equal(cell.completedTerminalJson?.validAtJoin, true);
      }
    };
    const failures = [];
    try {
      if (name === "unloaded") {
        // Qualify the independent API prerequisite before the addon fixture's clock starts.
        await nativeLifetimeControl(prepared.descriptor, cell);
      }
      target = fixtureTarget(
        { lifetime, commands, env, context, label: `${name}:fixture`, signal: abort.signal },
        argv,
      );
      const ready = await target.waitFor("ready");
      assert.equal(ready.modulePresent, fixtureMode === "loaded");
      assert.equal(ready.addonSha256, addonSha256);
      assert.ok(target.receipt.jobObserved);
      release = createFixtureRelease(target.child.stdin, false, reportInputError);
      const binding = {
        launcherPid: target.receipt.launcherPid,
        commandPid: target.receipt.commandPid,
        commandStartedAtMs: target.receipt.commandStartedAtMs,
        commandSpawnedAtMs: target.receipt.commandSpawnedAtMs,
        entry,
        profile: "fileio-integration-control",
        expectedNodeExe: process.execPath,
        expectedArgv: argv,
        runId: name,
        runCreatedAtMs: Date.now(),
        globalRoot,
        namespaceWasEmpty: true,
        expectedAddon: {
          canonicalPath: path.join(globalRoot, "koffi.node"),
          relativePath: "koffi.node",
          sha256: addonSha256,
          bytes: 1044480,
        },
      };
      const first = await census(binding, context, `${name}:pin`);
      cell.before = first.capture;
      assert.equal(first.capture.retirement?.complete, true);
      assert.equal(first.capture.retirement.originalProcess.pid, ready.pid);
      assert.equal(first.capture.retirement.expectedModuleObserved, fixtureMode === "loaded");
      assert.equal(first.capture.retirement.backups.length, 2);
      assert.equal(
        first.capture.retirement.backups.reduce((sum, backup) => sum + backup.leaves.length, 0),
        4,
      );
      binding.pinnedProcess = first.capture.retirement.originalProcess;
      sendTerminal();
      await target.waitFor("terminal");
      assert.ok(target.terminal);
      binding.fileIo = {
        ...prepared.descriptor,
        trigger: { terminalJson: target.terminal, ledgerObservedAtMs: Date.now() },
      };
      if (name === "absent-pin") {
        delete binding.pinnedProcess;
      }
      if (name === "wrong-pin") {
        binding.pinnedProcess = {
          ...binding.pinnedProcess,
          startTicks: (BigInt(binding.pinnedProcess.startTicks) + 1n).toString(),
        };
      }
      if (name === "wrong-dll") {
        binding.fileIo.dllSha256 = "0".repeat(64);
      }
      if (name === "wrong-runtime") {
        binding.fileIo.runtime = { ...binding.fileIo.runtime, psVersion: "0.0" };
      }
      if (name === "wrong-custody") {
        binding.fileIo.expectedGuid = "00000000-0000-0000-0000-000000000001";
      }
      if (name === "sync-timeout") {
        const result = synchronousTimeoutControl(binding, context, [globalRoot]);
        cell.after = result.capture;
        cell.syncOwner = result.receipt;
        const absence = launchManaged({
          lifetime,
          commands,
          env,
          label: `${name}:direct-pid-absence`,
          bin: getWindowsPowerShellExePath(),
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(
              `$ErrorActionPreference='Stop';$p=Get-Process -Id ${result.receipt.pid} -ErrorAction SilentlyContinue;if($p){$p.Dispose();throw 'Direct census process remains'};[Console]::Out.Write('{"directCensusProcessAbsent":true}')`,
              "utf16le",
            ).toString("base64"),
          ],
          timeoutMs: 5000,
        });
        assert.equal(await absence.completion, 0);
        assert.deepEqual(JSON.parse(absence.result().stdout), { directCensusProcessAbsent: true });
        cell.directCensusProcessAbsent = true;
        cell.descendantCleanupClaimed = false;
      } else if (name === "fixture-abort") {
        abort.abort();
        await assert.rejects(
          target.completion,
          (error) => error?.code === "ABORT_ERR" && !hasUnjoinedWork(error),
        );
        assert.equal(target.receipt.joined, true);
        cell.managedFixtureAbortJoined = true;
      } else {
        const observed = await census(binding, context, `${name}:observe`, () => {
          cell.enabledAcknowledged = true;
          release.observe();
        });
        cell.after = observed.capture;
        cell.targetJoinedAtObserverCompletion = target.receipt.joined;
        assert.equal(cell.targetJoinedAtObserverCompletion, false);
        assert.equal(target.terminal, binding.fileIo.trigger.terminalJson);
        if (name === "loaded" || name === "unloaded") {
          cell.observerCode = observed.observer.receipt.exitCode;
          cell.observation = observed.capture.fileIo?.result;
          assert.ok(cell.observation);
          await target.waitFor("result");
          await joinTarget();
          assert.equal(cell.completedTerminalJson.fact, binding.fileIo.trigger.terminalJson);
          try {
            cell.sameEtlReader = await compareSameEtl(
              prepared.descriptor,
              binding.pinnedProcess,
              admission,
              cell.observation,
              observed.observer.receipt,
            );
          } catch (error) {
            cell.sameEtlReader = { diagnosticOnly: true, failure: safeError(error) };
            if (hasUnjoinedWork(error)) {
              failures.push(error);
            }
          }
          recordRequestOnlyControl({
            cell,
            observer: {
              receipt: observed.observer.receipt,
              records: [observed.capture.fileIo.facts],
            },
            target,
            identity: {
              pid: binding.pinnedProcess.pid,
              nativeStartFileTime: binding.pinnedProcess.startTicks,
            },
            fixtureMode,
          });
        } else {
          assert.equal(cell.enabledAcknowledged, undefined);
          assert.ok(
            observed.capture.fileIo?.unavailable ||
              observed.capture.fileIo?.result?.observation === "insufficient-evidence",
          );
          assert.ok(!observed.capture.fileIo?.facts?.events?.length);
          cell.refusedBeforeEnable = true;
        }
      }
      await joinTarget();
      cell.qualified = !cell.completedDeletionFailure;
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await joinTarget();
      } catch (error) {
        if (!failures.includes(error)) {
          failures.push(error);
        }
      }
      if ((!target || target.receipt.joined) && !failures.some(hasUnjoinedWork)) {
        try {
          await prepared.cleanup();
          admission.cleanupVerified = true;
          await persistAdmission();
          cell.cleanupVerified = true;
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        cell.qualified = false;
      }
      try {
        persistEvidence();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length) {
      throw new AggregateError(failures, "Control cell or exact cleanup failed");
    }
  }
  try {
    if (mode === "run") {
      assert.deepEqual(fs.readdirSync(privateRoot), []);
      await persistAdmission();
      const foreignCanary = "HOST_FOREIGN_COMMAND_MUST_NOT_REACH_ARTIFACT";
      const canary = projectCensusResult(
        { env, stateDir: privateRoot },
        {
          status: 0,
          stdout: JSON.stringify([
            { ProcessId: 414141, ParentProcessId: 1, CommandLine: foreignCanary },
          ]),
          stderr: "",
        },
        [path.join(privateRoot, "synthetic")],
      );
      assert.equal(JSON.stringify(canary).includes(foreignCanary), false);
      save(path.join(evidence, "foreign-command-control.json"), {
        excludedByActualReceiver: true,
        projection: canary,
      });
      for (const name of [
        "unloaded",
        "loaded",
        "absent-pin",
        "wrong-pin",
        "wrong-dll",
        "wrong-runtime",
        "wrong-custody",
        "sync-timeout",
        "fixture-abort",
      ]) {
        try {
          await runCell(name, name === "unloaded" ? "unloaded" : "loaded");
        } catch (error) {
          failed = true;
          cells.at(-1).failure = safeError(error);
          persistEvidence();
          break;
        }
      }
      failed ||= cells.some((cell) => !cell.qualified);
    } else {
      admissions.push(...JSON.parse(fs.readFileSync(admissionFile, "utf8")));
      for (const admission of admissions) {
        await cleanupAdmission(admission);
      }
    }
  } catch (error) {
    failed = true;
    save(path.join(evidence, `${mode}-failure.json`), safeError(error));
  } finally {
    try {
      await lifetime.cleanup();
    } catch {
      failed = true;
    }
    const cleanupVerified = admissions.every((admission) => admission.cleanupVerified);
    if (mode === "cleanup" && !failed && cleanupVerified) {
      fs.rmSync(privateRoot, { recursive: true });
    }
    persistEvidence();
    save(path.join(evidence, `${mode}-summary.json`), {
      mode,
      result: failed ? "FAIL" : "PASS",
      diagnosticOnly: true,
      completedDeletionQualified: false,
      cleanupVerified,
      rawArtifactsIncluded: false,
      cells,
    });
    if (failed || !cleanupVerified) {
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(() => {
    process.exitCode = 1;
    process.stderr.write("Integrated FileIO control failed before admission\n");
  });
}

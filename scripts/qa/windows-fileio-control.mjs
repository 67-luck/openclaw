#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { resolveDiagnosticProcessEnv } from "../../src/infra/process-env.ts";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.ts";
import {
  hasUnjoinedWork,
  inspectManagedProcessGroup,
  runManagedCommand,
} from "../lib/managed-child-process.mts";
import { createFixtureRelease } from "./windows-fileio/fixture-input.cjs";
import { recordRequestOnlyControl } from "./windows-fileio/record-request-only-control.mjs";

const helper = fileURLToPath(new URL("./windows-fileio/", import.meta.url));
const probe = path.join(helper, "Invoke-OwnedFileTrace.ps1");
const inspect = path.join(helper, "Inspect-Control.ps1");
const [mode, addon, evidence, privateRoot] = process.argv.slice(2);
assert.equal(process.platform, "win32");
assert.equal(process.arch, "x64");
assert.equal(process.version, "v26.8.2");
assert.ok(mode === "run" || mode === "cleanup");
assert.equal(process.argv.length, 6);
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
assert.equal(
  hash(process.execPath),
  "23062343ad39fc79f12ae39cfb324e93a20ced5f1d342e7b850c148c022ddbca",
);
assert.equal(hash(addon), "939156f310bd7a7d9d1db1b5249a5d135739b049c24c79fd3c201701333ddbf3");
const lifetime = createFixtureLifetime(privateRoot);
const admissionFile = path.join(privateRoot, "installed-cleanup.json");
const commands = [];
const cells = [];
const childEnv = resolveDiagnosticProcessEnv(process.env, "win32");
function save(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flush: true });
}
function describeError(/** @type {unknown} */ error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    code:
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined,
    unjoined: hasUnjoinedWork(error),
  };
}
let admission;
function persist() {
  const temporary = `${admissionFile}.next`;
  save(temporary, admission);
  fs.renameSync(temporary, admissionFile);
}
function projectFixtureRecord(record) {
  assert.ok(record && typeof record === "object");
  const { event } = record;
  if (event === "fixture-failed") {
    assert.equal(record.observation, "insufficient-evidence");
    return { event, observation: record.observation };
  }
  assert.ok(["created", "ready", "result"].includes(event));
  assert.ok(record.mode === "loaded" || record.mode === "unloaded");
  assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0 && record.pid <= 0xffffffff);
  const common = { event, mode: record.mode, pid: record.pid };
  if (event === "created") {
    return common;
  }
  assert.equal(typeof record.modulePresent, "boolean");
  if (event === "ready") {
    assert.match(record.addonSha256, /^[a-f0-9]{64}$/u);
    return { ...common, modulePresent: record.modulePresent, addonSha256: record.addonSha256 };
  }
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
  assert.match(record.beganAt, timestamp);
  assert.match(record.endedAt, timestamp);
  assert.equal(record.operation, "unlink");
  assert.equal(record.target, "koffi.node");
  assert.ok(
    record.unlinkCode === null ||
      (typeof record.unlinkCode === "string" && /^[A-Z][A-Z0-9_]{0,39}$/u.test(record.unlinkCode)),
  );
  return {
    ...common,
    modulePresent: record.modulePresent,
    beganAt: record.beganAt,
    endedAt: record.endedAt,
    operation: record.operation,
    target: record.target,
    unlinkCode: record.unlinkCode,
  };
}

function launch(
  label,
  bin,
  args,
  { timeoutMs = 30_000, onRecord, signal, recordKind = "probe" } = {},
) {
  assert.ok(recordKind === "probe" || recordKind === "fixture");
  const controller = new AbortController();
  const records = [];
  const listeners = new Set();
  const receipt = {
    label,
    timeoutMs,
    elapsedMs: null,
    exitCode: null,
    joined: false,
    jobObserved: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    records: [],
  };
  commands.push(receipt);
  let child;
  let carry = "";
  const stdoutDecoder = new StringDecoder("utf8");
  let outputError;
  let inputError;
  const started = performance.now();
  const completion = lifetime.track(
    runManagedCommand({
      bin,
      args,
      shell: false,
      env: childEnv,
      timeoutMs,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      stdio: ["pipe", "pipe", "pipe"],
      onReady(launched) {
        child = launched;
        launched.on("message", (message) => {
          if (message?.type === "spawned" && Number.isSafeInteger(message.pid)) {
            receipt.jobObserved = true;
            receipt.commandPid = message.pid;
          }
        });
        const receiveStdout = (text) => {
          carry += text;
          let newline;
          while ((newline = carry.indexOf("\n")) >= 0) {
            const line = carry.slice(0, newline).trim();
            carry = carry.slice(newline + 1);
            if (!line) {
              continue;
            }
            try {
              const record = JSON.parse(line);
              records.push(record);
              onRecord?.(record);
              receipt.records.push(
                recordKind === "fixture" ? projectFixtureRecord(record) : record,
              );
              for (const notify of listeners) {
                notify(record);
              }
            } catch {
              outputError = true;
              controller.abort();
            }
          }
        };
        launched.stdout.on("data", (chunk) => {
          receipt.stdoutBytes += chunk.length;
          if (receipt.stdoutBytes > 512 * 1024) {
            outputError = true;
            controller.abort();
            return;
          }
          receiveStdout(stdoutDecoder.write(chunk));
        });
        launched.stdout.once("end", () => {
          const tail = stdoutDecoder.end();
          if (tail && !outputError) {
            receiveStdout(tail);
          }
        });
        launched.stderr.on("data", (chunk) => {
          receipt.stderrBytes += chunk.length;
          if (receipt.stderrBytes > 32768) {
            controller.abort();
          }
        });
      },
    })
      .then((code) => {
        receipt.exitCode = code;
        assert.equal(outputError, undefined, "Malformed/bounded stdout");
        if (code === 0 && inputError) {
          throw inputError;
        }
        return code;
      })
      .catch((/** @type {unknown} */ error) => {
        receipt.error = describeError(error);
        throw error;
      })
      .finally(() => {
        receipt.elapsedMs = performance.now() - started;
        receipt.joined = Boolean(
          child && inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" }) === "dead",
        );
        save(path.join(evidence, `${mode}-commands.json`), commands);
      }),
  );
  void completion.catch(() => {});
  return {
    receipt,
    completion,
    records,
    fixtureInput(earlyExit) {
      assert.ok(child?.stdin);
      return createFixtureRelease(child.stdin, earlyExit, (error) => {
        inputError = error;
        receipt.stdinError = describeError(error);
        // Preserve an already observed target exit; a live command with failed
        // input is cancelled and joined by its existing command controller.
        if (child.exitCode === null) {
          controller.abort();
        }
      });
    },
    async waitFor(predicate) {
      const present = records.find(predicate);
      if (present) {
        return present;
      }
      let notify;
      const event = new Promise((resolve) => {
        notify = (record) => predicate(record) && resolve(record);
        listeners.add(notify);
      });
      try {
        return await Promise.race([
          event,
          completion.then(() => {
            throw new Error("Expected handshake missing");
          }),
        ]);
      } finally {
        listeners.delete(notify);
      }
    },
  };
}
async function powershell(label, script, args, options) {
  const command = launch(
    label,
    "pwsh.exe",
    ["-NoProfile", "-NonInteractive", "-File", script, ...args],
    options,
  );
  const code = await command.completion;
  assert.equal(code, 0, `${label} failed`);
  assert.ok(
    command.receipt.joined && command.receipt.jobObserved,
    `${label} native owner did not join`,
  );
  return command.records;
}
function binding(resource) {
  return ["-ReceiptPath", resource.receiptPath, "-ExpectedGuid", resource.guid];
}
async function cleanupResource(resource) {
  const records = await powershell(`${resource.name}:cleanup`, probe, [
    "-Mode",
    "cleanup",
    ...binding(resource),
  ]);
  const result = records.at(-1);
  assert.ok(result?.cleanupVerified && result.traceAbsent && result.rawAbsent);
  if (resource.identity) {
    const absent = await powershell(`${resource.name}:target-absence`, inspect, [
      "-Mode",
      "absent",
      "-TargetProcessId",
      String(resource.identity.pid),
      "-NativeStartFileTime",
      resource.identity.nativeStartFileTime,
    ]);
    assert.equal(absent.at(-1)?.originalAbsent, true);
  }
  if (resource.fixtureRoot) {
    assert.equal(path.dirname(resource.fixtureRoot), resource.fixtureParent);
    assert.ok(path.basename(resource.fixtureRoot).startsWith("owned-addon-attribution-"));
    if (fs.existsSync(resource.fixtureRoot)) {
      fs.rmSync(resource.fixtureRoot, { recursive: true });
    }
    assert.equal(fs.existsSync(resource.fixtureRoot), false);
  }
  resource.cleanupVerified = true;
  resource.cleanupOutcome = result;
  persist();
  return result;
}
async function runCell(name, fixtureMode) {
  const resource = {
    name,
    guid: randomUUID(),
    cleanupVerified: false,
    privateDirectory: path.join(privateRoot, name),
    fixtureParent: path.join(privateRoot, name, "fileio-probe"),
  };
  resource.receiptPath = path.join(resource.privateDirectory, "trace.json");
  admission.resources.push(resource);
  persist(); // Existing installed cleanup owns custody before any allocation.
  fs.mkdirSync(resource.fixtureParent, { recursive: true });
  let target;
  let fixtureRelease;
  let observer;
  const cell = { name, fixtureMode, qualified: false };
  cells.push(cell);
  const acquired = await lifetime.acquire(async (rollback) => {
    try {
      if (name === "partial-preparation") {
        // Simulate interrupted compiler output; cleanup must use trusted source,
        // prove exact session absence, and never load this incomplete DLL.
        fs.writeFileSync(path.join(resource.privateDirectory, "OwnedFileTrace.dll"), "incomplete", {
          flag: "wx",
        });
      } else {
        await powershell(`${name}:prepare`, probe, ["-Mode", "prepare", ...binding(resource)]);
      }
      return { cleanup: () => cleanupResource(resource) };
    } catch (error) {
      return rollback(error, () => cleanupResource(resource));
    }
  });
  try {
    if (name === "partial-preparation") {
      cell.control = "incomplete-compiler-output-no-session-started";
    } else if (name === "foreign-guid") {
      const records = await powershell(`${name}:query`, inspect, [
        "-Mode",
        "foreign-guid",
        ...binding(resource),
      ]);
      cell.control = records.at(-1);
      assert.ok(cell.control.wrongGuidRefused && cell.control.ownerUnchanged);
    } else {
      target = launch(
        `${name}:fixture`,
        process.execPath,
        [
          path.join(helper, "shallow-addon-attribution.cjs"),
          fixtureMode,
          addon,
          resource.fixtureParent,
          name === "early-exit" ? "early-exit" : "hold",
        ],
        {
          timeoutMs: 30_000,
          recordKind: "fixture",
          onRecord(record) {
            if (record.event === "created") {
              resource.fixtureRoot = record.root;
              persist();
            }
          },
        },
      );
      const ready = await target.waitFor((record) => record.event === "ready");
      fixtureRelease = target.fixtureInput(name === "early-exit");
      assert.ok(Number.isSafeInteger(ready.pid));
      const identities = await powershell(`${name}:identity`, inspect, [
        "-Mode",
        "identity",
        "-TargetProcessId",
        String(ready.pid),
      ]);
      resource.identity = identities.at(-1);
      assert.equal(resource.identity.pid, ready.pid);
      persist();
      cell.identity = resource.identity;
      const controller = new AbortController();
      const nativeStart =
        name === "wrong-start"
          ? (BigInt(resource.identity.nativeStartFileTime) + 1n).toString()
          : resource.identity.nativeStartFileTime;
      observer = launch(
        `${name}:observe`,
        "pwsh.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          probe,
          "-Mode",
          "observe",
          ...binding(resource),
          "-TargetProcessId",
          String(ready.pid),
          "-NativeStartFileTime",
          nativeStart,
          "-OwnedPrefix",
          resource.fixtureRoot,
        ],
        {
          timeoutMs: 5000,
          signal: controller.signal,
          onRecord(record) {
            if (record.phase === "observing") {
              cell.enabledAcknowledged = true;
              fixtureRelease.observe();
              if (name === "observer-abort") {
                controller.abort();
              }
            }
          },
        },
      );
      try {
        cell.observerCode = await observer.completion;
      } catch (error) {
        cell.observerError = describeError(error);
        assert.equal(name, "observer-abort");
        assert.equal(error.code, "ABORT_ERR");
        assert.equal(hasUnjoinedWork(error), false);
        cell.abortJoined = true;
      } finally {
        cell.observation = observer.records.find((record) => record.phase === "result");
        cell.targetJoinedAtObserverCompletion = target.receipt.joined;
        if (!target.receipt.joined) {
          fixtureRelease.release();
        }
      }
      if (name === "wrong-start") {
        assert.equal(cell.observerCode, 0);
        assert.equal(cell.enabledAcknowledged, undefined);
        assert.equal(cell.observation?.observation, "insufficient-evidence");
        assert.equal(cell.observation.identityRefused, true);
        assert.equal(cell.observation.records.length, 0);
      } else if (name === "observer-abort") {
        assert.ok(cell.enabledAcknowledged && cell.abortJoined);
      } else if (name === "early-exit") {
        cell.control = "natural-early-exit-without-attribution-requirement";
        assert.equal(cell.observerCode, 0);
        assert.equal(cell.targetJoinedAtObserverCompletion, true);
        assert.equal(cell.observation?.postStopAdmission?.state, "Exited");
        assert.equal(cell.observation.postStopAdmission.admitted, false);
        assert.equal(cell.observation.projectionStarted, false);
        assert.equal(cell.observation.counts.parsed, 0);
        assert.equal(cell.observation.records.length, 0);
        assert.equal(cell.observation.observation, "insufficient-evidence");
      } else {
        assert.equal(cell.targetJoinedAtObserverCompletion, false);
        assert.equal(await target.completion, 0);
        assert.ok(target.receipt.joined && target.receipt.jobObserved);
        recordRequestOnlyControl({
          cell,
          observer,
          target,
          identity: resource.identity,
          fixtureMode,
        });
      }
    }
    cell.qualified = !cell.completedDeletionFailure;
  } finally {
    if (target) {
      if (!target.receipt.joined && fixtureRelease) {
        fixtureRelease.release();
      }
      assert.equal(await target.completion, 0);
      assert.ok(target.receipt.joined && target.receipt.jobObserved);
      cell.targetNaturalExit = true;
    }
    await acquired.cleanup();
    cell.cleanup = resource.cleanupOutcome;
    cell.cleanupVerified = resource.cleanupVerified;
    if (name === "partial-preparation") {
      assert.equal(cell.cleanup.acquisition, "not-started");
    }
    save(path.join(evidence, "cells.json"), cells);
  }
}

let failed = false;
try {
  if (mode === "run") {
    assert.equal(fs.existsSync(admissionFile), false);
    assert.deepEqual(fs.readdirSync(privateRoot), [], "Private root must be freshly allocated");
    admission = {
      contract: "windows-fileio-control-v1",
      privateRoot: fs.realpathSync(privateRoot),
      resources: [],
    };
    persist();
    for (const [name, fixtureMode] of [
      ["partial-preparation", "unloaded"],
      ["early-exit", "unloaded"],
      ["unloaded", "unloaded"],
      ["loaded", "loaded"],
      ["wrong-start", "loaded"],
      ["foreign-guid", "unloaded"],
      ["observer-abort", "loaded"],
    ]) {
      await runCell(name, fixtureMode);
      if (cells.at(-1).completedDeletionFailure) {
        failed = true;
      }
    }
    if (failed) {
      save(path.join(evidence, "run-failure.json"), {
        reason: "completed-deletion-unqualified",
        failures: cells
          .filter((cell) => cell.completedDeletionFailure)
          .map((cell) => ({ name: cell.name, failure: cell.completedDeletionFailure })),
      });
    }
  } else {
    admission = JSON.parse(fs.readFileSync(admissionFile, "utf8"));
    assert.equal(admission.contract, "windows-fileio-control-v1");
    assert.equal(admission.privateRoot, fs.realpathSync(privateRoot));
    for (const resource of admission.resources) {
      assert.equal(path.dirname(resource.privateDirectory), privateRoot);
      assert.equal(resource.receiptPath, path.join(resource.privateDirectory, "trace.json"));
      await cleanupResource(resource);
    }
  }
} catch (error) {
  failed = true;
  save(path.join(evidence, `${mode}-failure.json`), {
    name: error.name,
    code: error.code,
    unjoined: hasUnjoinedWork(error),
  });
} finally {
  try {
    await lifetime.cleanup();
  } catch {
    failed = true;
  }
  const cleanupVerified = Boolean(
    admission?.resources.every((resource) => resource.cleanupVerified),
  );
  if (mode === "cleanup" && !failed && cleanupVerified) {
    fs.rmSync(privateRoot, { recursive: true });
    assert.equal(fs.existsSync(privateRoot), false);
  }
  save(path.join(evidence, `${mode}-summary.json`), {
    mode,
    completed: !failed && cleanupVerified,
    cleanupVerified,
    cells,
    resources: admission?.resources.map(({ name, guid, cleanupVerified: released }) => ({
      name,
      guid,
      cleanupVerified: released,
    })),
    rawArtifactsIncluded: false,
  });
  if (failed || !cleanupVerified) {
    process.exitCode = 1;
  }
}

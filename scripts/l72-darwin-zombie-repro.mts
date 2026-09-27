// Throwaway native diagnostic. Usage: node --import ./scripts/tsx.mjs scripts/l72-darwin-zombie-repro.mts CHECKOUT RECEIPT.json|OUTPUT_DIR/
// Run only on the authorized disposable Darwin runner. The receipt is never overwritten.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

type RecordValue = Record<string, unknown>;
type CloseReceipt = { code: number | null; signal: NodeJS.Signals | null; error?: unknown };
type FinalizerOutcome = { kind: "fulfilled" } | { kind: "rejected"; error: unknown };
const [checkoutArg, outputArg] = process.argv.slice(2);
assert(checkoutArg && outputArg && process.argv.length === 4, "Expected CHECKOUT RECEIPT.json");
assert.equal(process.platform, "darwin", "This diagnostic requires real Darwin process groups");
const checkout = fs.realpathSync(checkoutArg);
const requestedOutput = path.resolve(outputArg);
const output =
  outputArg.endsWith(path.sep) ||
  (fs.existsSync(requestedOutput) && fs.statSync(requestedOutput).isDirectory())
    ? path.join(requestedOutput, "darwin-zombie-outcome.json")
    : requestedOutput;
assert(!fs.existsSync(output), "Refusing to overwrite an existing outcome receipt");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "oc-darwin-zombie-"));
const ownerPath = path.join(checkout, "scripts/lib/managed-child-process.mts");
const { finalizeManagedChild, runManagedCommand, waitForManagedProcessGroupExit } = await import(
  pathToFileURL(ownerPath).href
);
const nativeSource = fs.readFileSync(new URL("./l72-darwin-zombie-fixture.c", import.meta.url));
const nativePath = path.join(work, "fixture.c");
const executable = path.join(work, "fixture");
fs.writeFileSync(nativePath, nativeSource, { flag: "wx", mode: 0o600 });
const cases: RecordValue[] = [];
const report: RecordValue = {
  schema: 1,
  diagnosticOnly: true,
  platform: process.platform,
  architecture: process.arch,
  kernelRelease: os.release(),
  kernelVersion: os.version(),
  node: process.version,
  ownerSha256: createHash("sha256").update(fs.readFileSync(ownerPath)).digest("hex"),
  fixtureSha256: createHash("sha256").update(nativeSource).digest("hex"),
  retainedArtifactRoot: work,
  cases,
  limits: [
    "Direct real finalizer proof; wrapper detached-session launch is not exercised.",
    "This does not establish the cause of the earlier transient lipo failure.",
    "Unknown/inaccessible live groups remain covered by existing strict owner controls; no permission error is mocked here.",
  ],
};

function errorRecord(error: unknown, depth = 0): unknown {
  if (depth > 3) return "nested error omitted";
  if (!(error instanceof Error)) return String(error);
  return {
    name: error.name,
    message: error.message,
    ...("code" in error ? { code: error.code } : {}),
    ...("processTreeState" in error ? { processTreeState: error.processTreeState } : {}),
    ...(error.cause ? { cause: errorRecord(error.cause, depth + 1) } : {}),
    ...(error instanceof AggregateError
      ? { errors: error.errors.map((value) => errorRecord(value, depth + 1)) }
      : {}),
  };
}

async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Fixture deadline: ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function launch(args: string[]) {
  const child = spawn(executable, args, { detached: false, stdio: ["pipe", "pipe", "pipe"] });
  const pendingPipes = new Set([child.stdout, child.stderr]);
  for (const stream of pendingPipes) stream.once("close", () => pendingPipes.delete(stream));
  let spawnError: unknown;
  let inputError: unknown;
  child.stdin.on("error", (error) => {
    inputError = error;
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-16_384);
  });
  const lines: string[] = [];
  const waiting: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    const next = waiting.shift();
    if (next) next.resolve(line);
    else lines.push(line);
  });
  let ended = false;
  child.once("error", (error) => {
    spawnError = error;
  });
  const closed = new Promise<CloseReceipt>((resolve) =>
    child.once("close", (code, signal) => {
      ended = true;
      for (const waiter of waiting.splice(0))
        waiter.reject(new Error("Native helper closed before its receipt"));
      resolve({ code, signal, ...(spawnError ? { error: spawnError } : {}) });
    }),
  );
  return {
    child,
    closed,
    stderr: () => stderr,
    inputError: () => inputError,
    pipesClosed: () => pendingPipes.size === 0,
    async receipt(): Promise<RecordValue> {
      const line = lines.length
        ? lines.shift()!
        : await bounded(
            new Promise<string>((resolve, reject) => {
              if (ended) reject(new Error("Native helper has no remaining receipt"));
              else waiting.push({ resolve, reject });
            }),
            "native receipt",
          );
      const value: unknown = JSON.parse(line);
      assert(
        value && typeof value === "object" && !Array.isArray(value),
        "Malformed native receipt",
      );
      return value as RecordValue;
    },
  };
}

function number(receipt: RecordValue, key: string): number {
  const value = receipt[key];
  assert(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    `Invalid native ${key}`,
  );
  return value;
}

function snapshot(pgid: number) {
  const observed = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,uid=,stat="], {
    encoding: "utf8",
    timeout: 2_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  assert(
    !observed.error && observed.status === 0 && observed.signal === null,
    "Darwin group census unavailable",
  );
  const rows: Array<{ pid: number; ppid: number; pgid: number; uid: number; state: string }> = [];
  for (const line of observed.stdout.split("\n")) {
    if (!line.trim()) continue;
    const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s*$/u.exec(line);
    assert(fields, "Darwin process census contained an unrecognized row");
    if (Number(fields[3]) === pgid)
      rows.push({
        pid: Number(fields[1]),
        ppid: Number(fields[2]),
        pgid,
        uid: Number(fields[4]),
        state: fields[5]!,
      });
  }
  return rows;
}

async function confirmGroupAbsent(child: ChildProcess) {
  assert(child.pid && child.pid > 1, "Missing owned child identity");
  assert(
    await waitForManagedProcessGroupExit(child, 5_000, {
      platform: "darwin",
      errorPolicy: "indeterminate",
    }),
    "Owned group did not settle during fixture cleanup",
  );
  assert.throws(() => process.kill(-child.pid!, 0), { code: "ESRCH" });
}

async function runCase(mode: "zombie" | "live") {
  const evidence: RecordValue = { mode, fixtureEstablished: false, cleanupVerified: false };
  cases.push(evidence);
  const leader = launch(["leader"]);
  let holder: ReturnType<typeof launch> | undefined;
  let p2: number | undefined;
  let failure: unknown;
  let finalization: Promise<FinalizerOutcome> | undefined;
  try {
    const first = await leader.receipt();
    assert.equal(first.event, "leader-ready");
    assert.equal(first.pid, leader.child.pid);
    assert.equal(first.pgid, leader.child.pid);
    assert.equal(first.ppid, process.pid);
    assert.equal(first.uid, process.getuid!());
    holder = launch(["holder", String(leader.child.pid), mode]);
    const second = await holder.receipt();
    assert.equal(second.event, "holder-ready");
    assert.equal(second.pid, holder.child.pid);
    assert.equal(second.pgid, holder.child.pid);
    assert.equal(second.ppid, process.pid);
    assert.equal(second.uid, first.uid);
    assert.equal(second.sid, first.sid);
    p2 = number(second, "p2");
    assert(p2 > 1 && p2 !== leader.child.pid && p2 !== holder.child.pid);
    assert.equal(second.p2ppid, holder.child.pid);
    assert.equal(second.p2pgid, leader.child.pid);
    assert.equal(second.p2sid, first.sid);
    assert.equal(second.p2uid, first.uid);
    assert.equal(second.zombie, mode === "zombie");
    if (mode === "zombie") {
      assert.equal(second.waitidPid, p2);
      assert.equal(second.waitidStatus, 0);
    }
    evidence.identities = { leader: first, holder: second };
    const before = snapshot(leader.child.pid!);
    evidence.beforeLeaderExit = before;
    assert.deepEqual(
      before.map(({ pid }) => pid).sort((a, b) => a - b),
      [leader.child.pid!, p2].sort((a, b) => a - b),
    );
    leader.child.stdin.end("exit\n");
    const leaderClose = await bounded(leader.closed, "leader close");
    assert.deepEqual(leaderClose, { code: 0, signal: null });
    assert(leader.pipesClosed(), "Leader output pipes have not actually closed");
    const held = snapshot(leader.child.pid!);
    assert.equal(held.length, 1, "Expected exactly the held P2 in the original group");
    assert.equal(held[0]!.pid, p2);
    assert.equal(held[0]!.ppid, holder.child.pid);
    assert.equal(held[0]!.uid, first.uid);
    assert.equal(held[0]!.state.startsWith("Z"), mode === "zombie");
    evidence.heldGroup = held;
    evidence.fixtureEstablished = true;
    if (mode === "zombie")
      assert.throws(() => process.kill(-leader.child.pid!, 0), { code: "EPERM" });
    else assert.equal(process.kill(-leader.child.pid!, 0), true);
    let terminatedCallbacks = 0;
    const finalizerStarted = performance.now();
    finalization = finalizeManagedChild(leader.child, undefined, {
      platform: "darwin",
      runTaskkill: spawnSync,
      areOutputPipesClosed: leader.pipesClosed,
      onTerminated: () => {
        terminatedCallbacks++;
      },
    }).then(
      () => ({ kind: "fulfilled" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    const outcome = await bounded(finalization, "existing finalizer outcome", 15_000);
    evidence.finalizerDurationMs = Math.round(performance.now() - finalizerStarted);
    evidence.finalizer =
      outcome.kind === "fulfilled"
        ? outcome
        : { kind: outcome.kind, error: errorRecord(outcome.error) };
    evidence.terminatedCallbacks = terminatedCallbacks;
    const after = snapshot(leader.child.pid!);
    evidence.afterFinalizer = after;
    const cleanupFailure =
      outcome.kind === "rejected" &&
      !!outcome.error &&
      typeof outcome.error === "object" &&
      "code" in outcome.error &&
      outcome.error.code === "EPROCESSGROUP_CLEANUP_FAILED";
    if (mode === "zombie") {
      assert(
        after.length === 1 && after[0]!.pid === p2 && after[0]!.state.startsWith("Z"),
        "Custodian did not retain the zombie through the finalizer outcome",
      );
      evidence.contractSatisfied = outcome.kind === "fulfilled" && terminatedCallbacks === 1;
      evidence.falseCleanupReproduced = cleanupFailure;
      evidence.classification =
        outcome.kind === "fulfilled"
          ? "zombie-only group accepted"
          : cleanupFailure
            ? "reproduced expected false cleanup error on real zombie-only group"
            : "unexpected finalizer error";
    } else {
      evidence.contractSatisfied = cleanupFailure;
      evidence.classification =
        outcome.kind === "rejected"
          ? "live descendant remains a strict failure"
          : "unexpected acceptance of live descendant";
    }
  } catch (error) {
    failure = error;
    evidence.fixtureError = errorRecord(error);
  } finally {
    const cleanupErrors: unknown[] = [];
    // EOF also commands cleanup in both native roles; signal only these actual ChildProcess handles if needed.
    if (!leader.child.stdin.destroyed && !leader.child.stdin.writableEnded)
      leader.child.stdin.end();
    if (holder && !holder.child.stdin.destroyed && !holder.child.stdin.writableEnded)
      holder.child.stdin.end("reap\n");
    if (holder) {
      try {
        const reaped = await holder.receipt();
        evidence.reaped = reaped;
        assert.equal(reaped.event, "reaped");
        assert.equal(reaped.holder, holder.child.pid);
        if (p2 !== undefined) assert.equal(reaped.pid, p2);
        assert.equal(reaped.setupFailed, false);
        if (mode === "zombie" && evidence.fixtureEstablished) assert.equal(reaped.exitCode, 0);
        if (mode === "live" && evidence.contractSatisfied)
          assert.equal(reaped.signal, os.constants.signals.SIGKILL);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const owned of [leader, holder].filter(
      (value): value is ReturnType<typeof launch> => value !== undefined,
    )) {
      try {
        const closed = await bounded(owned.closed, "owned helper close");
        assert(
          !closed.error && closed.code === 0 && closed.signal === null,
          `Native helper did not finish cleanly: ${owned.stderr()}`,
        );
        assert(!owned.inputError(), "Native control input failed during cleanup");
        assert(owned.pipesClosed(), "Owned helper output is still open");
        await confirmGroupAbsent(owned.child);
      } catch (error) {
        cleanupErrors.push(error);
        if (owned.child.exitCode === null && owned.child.signalCode === null) {
          try {
            owned.child.kill("SIGKILL");
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        try {
          await bounded(owned.closed, "forced owned helper close", 5_000);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    if (finalization) {
      try {
        await bounded(finalization, "finalizer settlement after native cleanup", 5_000);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    evidence.cleanupVerified = cleanupErrors.length === 0;
    evidence.inputErrors = [leader, holder]
      .filter((owned) => owned?.inputError())
      .map((owned) => errorRecord(owned!.inputError()));
    if (cleanupErrors.length)
      evidence.cleanupErrors = cleanupErrors.map((error) => errorRecord(error));
    console.log(JSON.stringify({ phase: mode, ...evidence }));
    if (failure || cleanupErrors.length)
      throw new AggregateError(
        [...(failure ? [failure] : []), ...cleanupErrors],
        "Native fixture proof was incomplete",
      );
  }
}

let exitCode = 0;
try {
  const compiled = await runManagedCommand({
    bin: "/usr/bin/xcrun",
    args: ["clang", "-std=c11", "-Wall", "-Wextra", "-Werror", nativePath, "-o", executable],
    cwd: work,
    stdio: "inherit",
    shell: false,
    requireProcessTreeExit: true,
    timeoutMs: 30_000,
  });
  assert.equal(compiled, 0, "Native fixture compilation failed");
  await runCase("zombie");
  await runCase("live");
  exitCode = cases.every(
    (entry) => entry.contractSatisfied === true && entry.cleanupVerified === true,
  )
    ? 0
    : 1;
} catch (error) {
  report.error = errorRecord(error);
  exitCode = 2;
} finally {
  report.exitCode = exitCode;
  report.completedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  // Link publishes only when the requested destination is still absent; then remove our private name.
  fs.linkSync(temporary, output);
  fs.unlinkSync(temporary);
  console.log(
    `Darwin group diagnostic receipt: ${output}; exit=${exitCode}; retained artifacts: ${work}`,
  );
  process.exitCode = exitCode;
}

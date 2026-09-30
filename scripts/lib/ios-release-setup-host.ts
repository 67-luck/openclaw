import type { ChildProcess } from "node:child_process";
import { chmod, lstat, mkdtemp, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  parseProcesses,
  parseStacks,
  parseSysctl,
  parseVm,
  projectReport,
  type Identity,
  type Outcome,
  type Phase,
  type ProcessRecord,
  type Report,
  type StackRecord,
  type Target,
  type ToolFailure,
  type Window,
} from "./ios-release-setup-host-records.js";
import {
  hasUnjoinedWork,
  runManagedCommand,
  type ManagedCommandLifecycle,
} from "./managed-child-process.mjs";

const MAX_REPORT_BYTES = 1_048_576;
const MAX_TOOL_BYTES = 65_536;
const LIFETIME_MS = 720_000;
const CLEANUP_FAILURE_EXIT = 75;
type ToolResult = { outcome: Outcome; elapsedMs: number; stdout: string };

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

async function readBounded(file: string, maximum = MAX_REPORT_BYTES): Promise<string | undefined> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead <= maximum ? buffer.toString("utf8", 0, bytesRead) : undefined;
  } finally {
    await handle.close();
  }
}

function cleanupFailure(): Error {
  return Object.assign(new Error("iOS setup host probe cleanup unconfirmed"), {
    processTreeState: "indeterminate",
  });
}

/** Optional observations run outside both observed event loops; only cleanup failure is fatal. */
export async function startIOSReleaseSetupHostProbe(options: {
  cwd: string;
  root: string;
  gatewayPid: number;
  signal: AbortSignal;
}): Promise<{
  evidence: Record<string, unknown>;
  markPhase(phase: "boot" | "setup-code"): void;
  stop(): Promise<void>;
}> {
  const report: Report = {
    status: "starting",
    cleanupConfirmed: true,
    host: [],
    stacks: [],
    failures: [],
  };
  const evidence: Record<string, unknown> = report;
  if (
    process.platform !== "darwin" ||
    !Number.isSafeInteger(options.gatewayPid) ||
    options.gatewayPid <= 1
  ) {
    report.status = "unavailable";
    return { evidence, markPhase() {}, async stop() {} };
  }
  let directory: string;
  try {
    directory = await mkdtemp(path.join(await realpath(options.root), "ios-setup-host-"));
    await chmod(directory, 0o700);
  } catch {
    report.status = "unavailable";
    return { evidence, markPhase() {}, async stop() {} };
  }
  const abort = new AbortController();
  let child: ChildProcess | undefined;
  let fatal: Error | undefined;
  let joined = false;
  let launched = false;
  let cleanExit = false;
  let wasReady = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  let control = "";
  const done = runManagedCommand({
    bin: process.execPath,
    args: [
      "--import",
      path.join(options.cwd, "scripts/tsx.mjs"),
      fileURLToPath(import.meta.url),
      "--probe-child",
      directory,
      String(process.pid),
      String(options.gatewayPid),
    ],
    cwd: options.cwd,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", TMPDIR: directory },
    stdio: ["pipe", "pipe", "ignore"],
    signal: AbortSignal.any([options.signal, abort.signal]),
    timeoutMs: LIFETIME_MS + 30_000,
    abortKillGraceMs: 20_000,
    signalKillGraceMs: 20_000,
    timeoutKillGraceMs: 20_000,
    requireProcessTreeExit: true,
    onReady(proc) {
      child = proc;
      launched = proc.pid !== undefined;
      proc.stdin?.on("error", () => {
        report.status = "failed";
      });
      proc.stdout?.on("data", (chunk: Buffer) => {
        control += chunk.toString("utf8");
        if (control.length > 128) {
          report.status = "failed";
          abort.abort();
          return;
        }
        if (control === "ready\n") {
          wasReady = true;
          report.status = "running";
          resolveReady();
        }
      });
    },
  })
    .then(
      (code) => {
        joined = true;
        cleanExit = code === 0;
        if (code === CLEANUP_FAILURE_EXIT) {
          fatal = cleanupFailure();
        } else if (code !== 0) {
          report.status = "failed";
        }
      },
      (error: unknown) => {
        cleanExit = child?.exitCode === 0 && child.signalCode === null;
        if (hasUnjoinedWork(error)) {
          fatal = error instanceof Error ? error : cleanupFailure();
        } else {
          joined = true;
        }
        if (!abort.signal.aborted && !options.signal.aborted) {
          report.status = "failed";
        }
      },
    )
    .finally(resolveReady);
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      abort.abort();
      child?.stdin?.end();
      await done;
      // A killed sampler's outer group cannot certify its nested detached tool groups.
      report.cleanupConfirmed = !launched || cleanExit;
      try {
        const raw = await readBounded(path.join(directory, "report.json"));
        if (raw !== undefined) {
          projectReport(JSON.parse(raw), report);
        } else {
          report.status = "failed";
        }
      } catch {
        report.status = "failed";
      }
      // A killed sampler cannot delete its raw reports; retain recovery state, not those files.
      await Promise.allSettled(
        Array.from({ length: 8 }, (_, index) =>
          rm(path.join(directory, `sample-${index}.txt`), { force: true }),
        ),
      );
      if (!joined || fatal || !report.cleanupConfirmed) {
        report.cleanupConfirmed = false;
        throw fatal ?? cleanupFailure();
      }
      report.cleanupConfirmed = true;
      if (report.status === "running" || report.status === "starting") {
        report.status = "stopped";
      }
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        report.status = "failed";
      }
    })());
  const startupTimer = setTimeout(() => {
    report.status = "failed";
    abort.abort();
  }, 20_000);
  await ready;
  clearTimeout(startupTimer);
  if (!wasReady) {
    // Return the retained handle even if startup cleanup failed, so the fixture owns that failure.
    await stop().catch(() => {});
  }
  let phase: "boot" | "setup-code" | undefined;
  return {
    evidence,
    markPhase(next) {
      if (stopping || !wasReady || phase === next || phase === "setup-code") {
        return;
      }
      phase = next;
      child?.stdin?.write(`${next}\n`, () => {});
    },
    stop,
  };
}

async function runTool(
  bin: string,
  args: string[],
  signal: AbortSignal,
  onLifecycle: (facts: ManagedCommandLifecycle) => void,
  timeoutMs = 2_000,
): Promise<ToolResult> {
  const started = performance.now();
  const overflow = new AbortController();
  let bytes = 0;
  let stdout = "";
  let stderr = "";
  let outcome: Outcome;
  try {
    const code = await runManagedCommand({
      bin,
      args,
      signal: AbortSignal.any([signal, overflow.signal]),
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs,
      timeoutKillGraceMs: 1_000,
      abortKillGraceMs: 1_000,
      signalKillGraceMs: 1_000,
      cleanupDrainTimeoutMs: 3_000,
      requireProcessTreeExit: true,
      onLifecycle,
      onReady(child) {
        for (const [stream, capture] of [
          [child.stdout, true],
          [child.stderr, false],
        ] as const) {
          stream?.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_TOOL_BYTES) {
              overflow.abort();
            } else if (capture) {
              stdout += chunk.toString("utf8");
            } else {
              stderr += chunk.toString("utf8");
            }
          });
        }
      },
    });
    outcome =
      overflow.signal.aborted || code === 128 + osConstants.signals.SIGXFSZ
        ? "output-limit"
        : code === 0
          ? "passed"
          : /(?:Operation not permitted|Permission denied|may not have permission)/iu.test(stderr)
            ? "denied"
            : "failed";
  } catch (error) {
    if (hasUnjoinedWork(error)) {
      throw error;
    }
    const code = isRecord(error) ? error.code : undefined;
    outcome = overflow.signal.aborted
      ? "output-limit"
      : signal.aborted
        ? "cancelled"
        : code === "ETIMEDOUT"
          ? "timeout"
          : code === "ENOENT"
            ? "unavailable"
            : code === "EACCES" || code === "EPERM"
              ? "denied"
              : "failed";
  }
  return { outcome, elapsedMs: elapsed(started), stdout };
}

async function runChild(directory: string, harnessPid: number, gatewayPid: number): Promise<void> {
  const report: Report = {
    status: "starting",
    cleanupConfirmed: false,
    host: [],
    stacks: [],
    failures: [],
  };
  const abort = new AbortController();
  const identities = new Map<Target, Identity>();
  const targets: { target: Target; pid: number }[] = [
    { target: "harness", pid: harnessPid },
    { target: "gateway", pid: gatewayPid },
  ];
  let phase: Phase = "baseline";
  let phaseGeneration = 0;
  let captureCount = 0;
  let queue = Promise.resolve();
  let persistence = Promise.resolve();
  let admittedIdentities = false;
  let unjoined = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const save = () =>
    (persistence = persistence.then(async () => {
      await writeFile(path.join(directory, "report.tmp"), JSON.stringify(report), { mode: 0o600 });
      await rename(path.join(directory, "report.tmp"), path.join(directory, "report.json"));
    }));
  const fail = (error: unknown) => {
    report.status = "failed";
    if (hasUnjoinedWork(error)) {
      unjoined = true;
    }
    abort.abort();
  };
  const observeTool = async (
    context: Pick<ToolFailure, "tool" | "stage" | "target" | "window">,
    action: (onLifecycle: (facts: ManagedCommandLifecycle) => void) => Promise<ToolResult>,
  ): Promise<ToolResult> => {
    const started = performance.now();
    const epochMs = Date.now();
    const startedPhase = phase;
    const cpuStart = process.cpuUsage();
    const loopStart = performance.eventLoopUtilization();
    const delay = monitorEventLoopDelay({ resolution: 20 });
    delay.enable();
    let lifecycle: ManagedCommandLifecycle | undefined;
    const record = (outcome: ToolFailure["outcome"]) => {
      const cpu = process.cpuUsage(cpuStart);
      if (report.failures.length === 16) {
        report.failures.shift();
      }
      report.failures.push({
        ...context,
        phase: startedPhase,
        outcome,
        epochMs,
        elapsedMs: elapsed(started),
        ...(lifecycle ? { lifecycle } : {}),
        // These are sampler-process observations; concurrent tools share their CPU intervals.
        observer: {
          cpuUserMs: cpu.user / 1_000,
          cpuSystemMs: cpu.system / 1_000,
          eventLoopUtilization: performance.eventLoopUtilization(loopStart).utilization,
          eventLoopDelayMaxMs: delay.max / 1_000_000,
          eventLoopDelaySamples: delay.count,
        },
      });
    };
    let result: ToolResult;
    try {
      try {
        result = await action((facts) => {
          lifecycle = facts;
        });
      } finally {
        delay.disable();
      }
    } catch (error) {
      record(hasUnjoinedWork(error) ? "unjoined" : "failed");
      fail(error);
      await save();
      throw error;
    }
    if (result.outcome !== "passed" && result.outcome !== "cancelled") {
      record(result.outcome === "timeout" ? "timeout" : "failed");
      await save();
    }
    return result;
  };
  const enqueue = (action: () => Promise<void>) => {
    queue = queue
      .then(async () => {
        if (!abort.signal.aborted) {
          await action();
        }
      })
      .catch(fail);
  };
  const processes = async (
    context: Pick<ToolFailure, "stage" | "target" | "window"> = { stage: "host" },
  ): Promise<ProcessRecord[]> => {
    const result = await observeTool({ ...context, tool: "processes" }, (onLifecycle) =>
      runTool(
        "/bin/ps",
        [
          "-p",
          `${harnessPid},${gatewayPid}`,
          "-o",
          "pid=,ppid=,pgid=,rss=,vsz=,%cpu=,time=,lstart=",
        ],
        abort.signal,
        onLifecycle,
      ),
    );
    const parsed = parseProcesses(result.stdout);
    const records = targets.map(({ target, pid }): ProcessRecord => {
      const found = parsed.get(pid);
      let outcome: Outcome = result.outcome;
      if (outcome === "passed") {
        outcome = found
          ? "passed"
          : parsed.size === 0 && result.stdout.trim()
            ? "parse-failed"
            : "exited";
      }
      if (found && outcome === "passed") {
        const before = identities.get(target);
        if (
          (target === "gateway" &&
            (found.identity.ppid !== harnessPid || found.identity.pgid !== gatewayPid)) ||
          (admittedIdentities && !before) ||
          (before &&
            (before.ppid !== found.identity.ppid ||
              before.pgid !== found.identity.pgid ||
              before.started !== found.identity.started))
        ) {
          outcome = "identity-changed";
        } else if (!before) {
          identities.set(target, found.identity);
        }
      }
      return {
        ...(outcome === "passed" ? found?.metrics : {}),
        target,
        outcome,
        elapsedMs: result.elapsedMs,
      };
    });
    admittedIdentities = true;
    if (records.some((record) => record.outcome === "identity-changed")) {
      report.status = "failed";
      abort.abort();
    }
    return records;
  };
  const host = async () => {
    if (report.host.length >= 144) {
      return;
    }
    const started = performance.now();
    const epochMs = Date.now();
    const startedPhase = phase;
    const settled = await Promise.allSettled([
      observeTool({ tool: "vm-stat", stage: "host" }, (onLifecycle) =>
        runTool("/usr/bin/vm_stat", [], abort.signal, onLifecycle),
      ),
      observeTool({ tool: "sysctl", stage: "host" }, (onLifecycle) =>
        runTool(
          "/usr/sbin/sysctl",
          ["vm.swapusage", "vm.loadavg", "hw.memsize", "hw.logicalcpu"],
          abort.signal,
          onLifecycle,
        ),
      ),
      processes(),
    ]);
    const [vmResult, sysctlResult, processResult] = settled;
    const vm = parseVm(vmResult.status === "fulfilled" ? vmResult.value.stdout : "");
    const sysctl = parseSysctl(
      sysctlResult.status === "fulfilled" ? sysctlResult.value.stdout : "",
    );
    report.host.push({
      ...vm,
      ...sysctl,
      epochMs,
      elapsedMs: elapsed(started),
      phase: startedPhase,
      ...(vmResult.status === "fulfilled" ? { vmMs: vmResult.value.elapsedMs } : {}),
      ...(sysctlResult.status === "fulfilled" ? { sysctlMs: sysctlResult.value.elapsedMs } : {}),
      vm:
        vmResult.status === "rejected"
          ? hasUnjoinedWork(vmResult.reason)
            ? "unjoined"
            : "failed"
          : vmResult.value.outcome === "passed" &&
              (vm.pageSizeBytes === undefined || vm.freePages === undefined)
            ? "parse-failed"
            : vmResult.value.outcome,
      sysctl:
        sysctlResult.status === "rejected"
          ? hasUnjoinedWork(sysctlResult.reason)
            ? "unjoined"
            : "failed"
          : sysctlResult.value.outcome === "passed" &&
              (sysctl.swapUsedBytes === undefined || sysctl.load1 === undefined)
            ? "parse-failed"
            : sysctlResult.value.outcome,
      processes: processResult.status === "fulfilled" ? processResult.value : [],
    });
    await save();
    for (const item of settled) {
      if (item.status === "rejected") {
        throw item.reason instanceof Error
          ? item.reason
          : new Error("Host snapshot collection failed");
      }
    }
  };
  const capture = async (window: Window) => {
    const generation = phaseGeneration;
    for (const { target, pid } of targets) {
      if (abort.signal.aborted || captureCount >= 8 || generation !== phaseGeneration) {
        return;
      }
      const epochMs = Date.now();
      const started = performance.now();
      const checks = await processes({ stage: "sample-identity", target, window });
      const check = checks.find((entry) => entry.target === target);
      const harness = checks.find((entry) => entry.target === "harness");
      const row: StackRecord = {
        epochMs,
        elapsedMs: 0,
        identityMs: check?.elapsedMs,
        target,
        window,
        outcome: checks.some((entry) => entry.outcome === "identity-changed")
          ? "identity-changed"
          : (check?.outcome ?? "failed"),
        countKind: "inclusive-tree-occurrences",
        truncated: false,
        threads: [],
      };
      const rawPath = path.join(directory, `sample-${captureCount++}.txt`);
      try {
        if (check?.outcome === "passed" && harness?.outcome === "passed" && !abort.signal.aborted) {
          // Fixed shell text sets a file-size limit before exec; target and output are positional.
          row.sampleEpochMs = Date.now();
          const result = await observeTool(
            { tool: "sample", stage: "sample-stack", target, window },
            (onLifecycle) =>
              runTool(
                "/bin/sh",
                [
                  "-c",
                  'ulimit -f 1024 || exit 70; exec /usr/bin/sample "$1" 1 10 -file "$2"',
                  "ios-setup-sample",
                  String(pid),
                  rawPath,
                ],
                abort.signal,
                onLifecycle,
                5_000,
              ),
          );
          row.sampleMs = result.elapsedMs;
          row.outcome = result.outcome;
          if (result.outcome === "passed") {
            const raw = await readBounded(rawPath);
            if (raw === undefined) {
              row.outcome = "output-limit";
            } else {
              const parsed = parseStacks(raw);
              row.threads = parsed.threads;
              row.truncated = parsed.truncated;
              if (row.threads.length === 0) {
                row.outcome = "parse-failed";
              }
            }
          }
        } else if (harness?.outcome !== "passed") {
          row.outcome = harness?.outcome ?? "failed";
        } else if (row.outcome === "passed" && abort.signal.aborted) {
          row.outcome = "cancelled";
        }
      } catch (error) {
        row.outcome = "failed";
        if (hasUnjoinedWork(error)) {
          row.outcome = "unjoined";
          unjoined = true;
          throw error;
        }
      } finally {
        row.elapsedMs = elapsed(started);
        report.stacks.push(row);
        await rm(rawPath, { force: true });
        await save();
      }
    }
  };
  const schedule = (milliseconds: number, window: Window) => {
    if (abort.signal.aborted) {
      return;
    }
    const generation = phaseGeneration;
    const timer = setTimeout(() => {
      timers.delete(timer);
      enqueue(async () => {
        if (generation === phaseGeneration) {
          await capture(window);
        }
      });
    }, milliseconds);
    timers.add(timer);
  };
  const stop = () => {
    abort.abort();
  };
  let input = "";
  const accept = (chunk: Buffer) => {
    if (abort.signal.aborted) {
      return;
    }
    input += chunk.toString("utf8");
    if (input.length > 64) {
      stop();
      return;
    }
    let newline = input.indexOf("\n");
    while (newline >= 0) {
      const next = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (next === "boot" && phase === "baseline") {
        phase = next;
        phaseGeneration++;
        schedule(20_000, "boot-20s");
      } else if (next === "setup-code" && phase !== "setup-code") {
        phase = next;
        phaseGeneration++;
        schedule(8_000, "setup-code-8s");
        schedule(20_000, "setup-code-20s");
      } else {
        stop();
      }
      newline = input.indexOf("\n");
    }
  };
  process.stdin.on("data", accept);
  process.stdin.once("end", stop);
  process.stdin.once("error", stop);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
  const lifetime = setTimeout(stop, LIFETIME_MS);
  let interval: ReturnType<typeof setInterval> | undefined;
  try {
    // Persist incomplete ownership before any nested group can outlive this process.
    await save();
    await host();
    await capture("baseline");
    if (!abort.signal.aborted) {
      report.status = "running";
      await save();
      process.stdout.write("ready\n");
      let hostPending = false;
      interval = setInterval(() => {
        if (hostPending || report.host.length >= 144) {
          return;
        }
        hostPending = true;
        enqueue(async () => {
          try {
            await host();
          } finally {
            hostPending = false;
          }
        });
      }, 5_000);
      await new Promise<void>((resolve) => {
        if (abort.signal.aborted) {
          resolve();
        } else {
          abort.signal.addEventListener("abort", () => resolve(), { once: true });
        }
      });
    }
  } catch (error) {
    fail(error);
  } finally {
    clearTimeout(lifetime);
    clearInterval(interval);
    for (const timer of timers) {
      clearTimeout(timer);
    }
    abort.abort();
    await queue;
    process.stdin.off("data", accept);
    process.stdin.off("end", stop);
    process.stdin.off("error", stop);
    process.stdin.pause();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    process.off("SIGHUP", stop);
    if (report.status !== "failed") {
      report.status = "stopped";
    }
    report.cleanupConfirmed = !unjoined;
    try {
      await save();
    } catch {
      report.status = "failed";
    }
    if (!report.cleanupConfirmed) {
      process.exitCode = CLEANUP_FAILURE_EXIT;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, directory, parentRaw, gatewayRaw, extra] = process.argv.slice(2);
  const parent = Number(parentRaw);
  const gateway = Number(gatewayRaw);
  try {
    if (
      process.platform !== "darwin" ||
      flag !== "--probe-child" ||
      extra !== undefined ||
      !directory ||
      !path.isAbsolute(directory) ||
      !path.basename(directory).startsWith("ios-setup-host-") ||
      !/^[1-9]\d*$/u.test(parentRaw ?? "") ||
      !/^[1-9]\d*$/u.test(gatewayRaw ?? "") ||
      !Number.isSafeInteger(parent) ||
      parent <= 1 ||
      parent !== process.ppid ||
      !Number.isSafeInteger(gateway) ||
      gateway <= 1 ||
      gateway > 0x7fffffff ||
      gateway === parent ||
      (await realpath(directory)) !== directory
    ) {
      throw new Error("invalid probe invocation");
    }
    const info = await lstat(directory);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0) {
      throw new Error("invalid probe directory");
    }
    process.umask(0o077);
    await runChild(directory, parent, gateway);
  } catch {
    process.exitCode = 1;
  }
}

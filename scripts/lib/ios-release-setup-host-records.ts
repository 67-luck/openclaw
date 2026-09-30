import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ManagedCommandLifecycle } from "./managed-child-process.mjs";

const OUTCOMES = [
  "passed",
  "failed",
  "timeout",
  "unavailable",
  "denied",
  "exited",
  "identity-changed",
  "parse-failed",
  "output-limit",
  "cancelled",
  "unjoined",
] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type Target = "harness" | "gateway";
export type Phase = "baseline" | "boot" | "setup-code";
type Window = "boot-and-setup";
const CATEGORIES = [
  "gc",
  "v8",
  "sqlite",
  "io",
  "poll",
  "mutex",
  "condition",
  "semaphore",
  "other",
] as const;
type Category = (typeof CATEGORIES)[number];
const HOST_FIELDS = [
  "pageSizeBytes",
  "freePages",
  "activePages",
  "inactivePages",
  "speculativePages",
  "wiredPages",
  "compressorPages",
  "compressedPagesStored",
  "pageins",
  "pageouts",
  "swapins",
  "swapouts",
  "swapTotalBytes",
  "swapUsedBytes",
  "swapFreeBytes",
  "load1",
  "load5",
  "load15",
  "memoryBytes",
  "logicalCpus",
  "vmMs",
  "sysctlMs",
] as const;
type HostField = (typeof HOST_FIELDS)[number];
const PROCESS_FIELDS = ["rssBytes", "virtualBytes", "cpuPercent", "cpuMs"] as const;
type ProcessField = (typeof PROCESS_FIELDS)[number];
export type ProcessRecord = Partial<Record<ProcessField, number>> & {
  target: Target;
  outcome: Outcome;
  elapsedMs: number;
};
type HostRecord = Partial<Record<HostField, number>> & {
  epochMs: number;
  elapsedMs: number;
  phase: Phase;
  vm: Outcome;
  sysctl: Outcome;
  processes: ProcessRecord[];
};
type ThreadRecord = {
  index: number;
  kind: "main" | "other";
  samples: number;
  frames: { category: Category; sampleTreeOccurrences: number }[];
};
export type StackRecord = {
  epochMs: number;
  elapsedMs: number;
  identityMs?: number;
  sampleEpochMs?: number;
  acknowledgedEpochMs?: number;
  durationMs?: number;
  intervalMs?: number;
  sampleMs?: number;
  target: Target;
  window: Window;
  outcome: Outcome;
  countKind: "inclusive-tree-occurrences";
  truncated: boolean;
  threads: ThreadRecord[];
};
export type ToolFailure = {
  tool: "vm-stat" | "sysctl" | "processes" | "sample";
  stage: "host" | "sample-identity" | "sample-stack";
  phase: Phase;
  outcome: "unjoined" | "timeout" | "failed";
  epochMs: number;
  elapsedMs: number;
  target?: Target;
  window?: Window;
  lifecycle?: ManagedCommandLifecycle;
  observer?: {
    cpuUserMs: number;
    cpuSystemMs: number;
    eventLoopUtilization: number;
    eventLoopDelayMaxMs: number;
    eventLoopDelaySamples?: number;
  };
};
export type Report = {
  status: "starting" | "running" | "stopped" | "unavailable" | "failed";
  cleanupConfirmed: boolean;
  host: HostRecord[];
  stacks: StackRecord[];
  failures: ToolFailure[];
};
export type Identity = { pid: number; ppid: number; pgid: number; started: string };

function finite(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function choice<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && choices.some((entry) => entry === value);
}

function copyNumbers<T extends string>(
  source: Record<string, unknown>,
  fields: readonly T[],
): Partial<Record<T, number>> {
  const result: Partial<Record<T, number>> = {};
  for (const field of fields) {
    if (finite(source[field])) {
      result[field] = source[field];
    }
  }
  return result;
}

function projectLifecycle(value: unknown): ManagedCommandLifecycle | undefined {
  if (!isRecord(value) || !finite(value.elapsedMs)) {
    return undefined;
  }
  const result: ManagedCommandLifecycle = {
    elapsedMs: value.elapsedMs,
    ...copyNumbers(value, [
      "spawnStartedMs",
      "spawnReturnedMs",
      "exitMs",
      "exitCode",
      "exitSignal",
      "stdoutCloseMs",
      "stderrCloseMs",
      "stopMs",
      "stopSignal",
    ]),
    ...(choice(value.stopReason, ["timeout", "aborted", "signal", "failed"])
      ? { stopReason: value.stopReason }
      : {}),
  };
  const cleanup = value.cleanup;
  if (
    isRecord(cleanup) &&
    finite(cleanup.startedMs) &&
    finite(cleanup.elapsedMs) &&
    choice(cleanup.groupState, ["dead", "indeterminate", "live"]) &&
    typeof cleanup.childExited === "boolean" &&
    typeof cleanup.stdoutClosed === "boolean" &&
    typeof cleanup.stderrClosed === "boolean" &&
    typeof cleanup.joined === "boolean"
  ) {
    result.cleanup = {
      startedMs: cleanup.startedMs,
      elapsedMs: cleanup.elapsedMs,
      groupState: cleanup.groupState,
      childExited: cleanup.childExited,
      stdoutClosed: cleanup.stdoutClosed,
      stderrClosed: cleanup.stderrClosed,
      joined: cleanup.joined,
    };
  }
  return result;
}

// The parent projects again: neither a malformed report nor a partial native tool line is publishable.
export function projectReport(value: unknown, report: Report): void {
  if (!isRecord(value)) {
    return;
  }
  if (choice(value.status, ["starting", "running", "stopped", "unavailable", "failed"])) {
    report.status = value.status;
  }
  report.cleanupConfirmed = value.cleanupConfirmed === true;
  report.failures = [];
  for (const row of Array.isArray(value.failures) ? value.failures.slice(-16) : []) {
    if (
      !isRecord(row) ||
      !choice(row.tool, ["vm-stat", "sysctl", "processes", "sample"]) ||
      !choice(row.stage, ["host", "sample-identity", "sample-stack"]) ||
      !choice(row.phase, ["baseline", "boot", "setup-code"]) ||
      !choice(row.outcome, ["unjoined", "timeout", "failed"]) ||
      !finite(row.epochMs) ||
      !finite(row.elapsedMs)
    ) {
      continue;
    }
    const lifecycle = projectLifecycle(row.lifecycle);
    const observer = row.observer;
    report.failures.push({
      tool: row.tool,
      stage: row.stage,
      phase: row.phase,
      outcome: row.outcome,
      epochMs: row.epochMs,
      elapsedMs: row.elapsedMs,
      ...(choice(row.target, ["harness", "gateway"]) ? { target: row.target } : {}),
      ...(choice(row.window, ["boot-and-setup"]) ? { window: row.window } : {}),
      ...(lifecycle ? { lifecycle } : {}),
      ...(isRecord(observer) &&
      finite(observer.cpuUserMs) &&
      finite(observer.cpuSystemMs) &&
      finite(observer.eventLoopUtilization) &&
      observer.eventLoopUtilization <= 1 &&
      finite(observer.eventLoopDelayMaxMs)
        ? {
            observer: {
              cpuUserMs: observer.cpuUserMs,
              cpuSystemMs: observer.cpuSystemMs,
              eventLoopUtilization: observer.eventLoopUtilization,
              eventLoopDelayMaxMs: observer.eventLoopDelayMaxMs,
              ...copyNumbers(observer, ["eventLoopDelaySamples"]),
            },
          }
        : {}),
    });
  }
  report.host = [];
  for (const row of Array.isArray(value.host) ? value.host.slice(0, 144) : []) {
    if (
      !isRecord(row) ||
      !finite(row.epochMs) ||
      !finite(row.elapsedMs) ||
      !choice(row.phase, ["baseline", "boot", "setup-code"]) ||
      !choice(row.vm, OUTCOMES) ||
      !choice(row.sysctl, OUTCOMES)
    ) {
      continue;
    }
    const processes: ProcessRecord[] = [];
    for (const item of Array.isArray(row.processes) ? row.processes.slice(0, 2) : []) {
      if (
        isRecord(item) &&
        choice(item.target, ["harness", "gateway"]) &&
        choice(item.outcome, OUTCOMES) &&
        finite(item.elapsedMs)
      ) {
        processes.push({
          ...copyNumbers(item, PROCESS_FIELDS),
          target: item.target,
          outcome: item.outcome,
          elapsedMs: item.elapsedMs,
        });
      }
    }
    report.host.push({
      ...copyNumbers(row, HOST_FIELDS),
      epochMs: row.epochMs,
      elapsedMs: row.elapsedMs,
      phase: row.phase,
      vm: row.vm,
      sysctl: row.sysctl,
      processes,
    });
  }
  report.stacks = [];
  for (const row of Array.isArray(value.stacks) ? value.stacks.slice(0, 2) : []) {
    if (
      !isRecord(row) ||
      !finite(row.epochMs) ||
      !finite(row.elapsedMs) ||
      !choice(row.target, ["harness", "gateway"]) ||
      !choice(row.window, ["boot-and-setup"]) ||
      !choice(row.outcome, OUTCOMES)
    ) {
      continue;
    }
    const threads: ThreadRecord[] = [];
    for (const thread of Array.isArray(row.threads) ? row.threads.slice(0, 32) : []) {
      if (
        !isRecord(thread) ||
        !finite(thread.index) ||
        !finite(thread.samples) ||
        !choice(thread.kind, ["main", "other"])
      ) {
        continue;
      }
      const frames: ThreadRecord["frames"] = [];
      for (const frame of Array.isArray(thread.frames)
        ? thread.frames.slice(0, CATEGORIES.length)
        : []) {
        if (
          isRecord(frame) &&
          choice(frame.category, CATEGORIES) &&
          finite(frame.sampleTreeOccurrences)
        ) {
          frames.push({
            category: frame.category,
            sampleTreeOccurrences: frame.sampleTreeOccurrences,
          });
        }
      }
      threads.push({ index: thread.index, kind: thread.kind, samples: thread.samples, frames });
    }
    report.stacks.push({
      ...copyNumbers(row, [
        "identityMs",
        "sampleEpochMs",
        "acknowledgedEpochMs",
        "durationMs",
        "intervalMs",
        "sampleMs",
      ]),
      epochMs: row.epochMs,
      elapsedMs: row.elapsedMs,
      target: row.target,
      window: row.window,
      outcome: row.outcome,
      countKind: "inclusive-tree-occurrences",
      truncated: row.truncated === true,
      threads,
    });
  }
}

export function parseVm(raw: string): Partial<Record<HostField, number>> {
  const result: Partial<Record<HostField, number>> = {};
  const names = new Map<string, HostField>([
    ["Pages free", "freePages"],
    ["Pages active", "activePages"],
    ["Pages inactive", "inactivePages"],
    ["Pages speculative", "speculativePages"],
    ["Pages wired down", "wiredPages"],
    ["Pages occupied by compressor", "compressorPages"],
    ["Pages stored in compressor", "compressedPagesStored"],
    ["Pageins", "pageins"],
    ["Pageouts", "pageouts"],
    ["Swapins", "swapins"],
    ["Swapouts", "swapouts"],
  ]);
  for (const line of raw.split("\n")) {
    const page = /^Mach Virtual Memory Statistics: \(page size of (\d+) bytes\)/u.exec(line);
    if (page && finite(Number(page[1])) && Number(page[1]) > 0) {
      result.pageSizeBytes = Number(page[1]);
    }
    const entry = /^([^:]+):\s*(\d+)\.?\s*$/u.exec(line);
    const field = names.get(entry?.[1] ?? "");
    if (field && finite(Number(entry?.[2]))) {
      result[field] = Number(entry?.[2]);
    }
  }
  return result;
}

export function parseSysctl(raw: string): Partial<Record<HostField, number>> {
  const result: Partial<Record<HostField, number>> = {};
  const units = new Map([
    ["", 1],
    ["B", 1],
    ["K", 1024],
    ["M", 1024 ** 2],
    ["G", 1024 ** 3],
    ["T", 1024 ** 4],
  ]);
  for (const line of raw.split("\n")) {
    const swap =
      /^vm\.swapusage:\s*total\s*=\s*([\d.]+)([BKMGT]?)\s+used\s*=\s*([\d.]+)([BKMGT]?)\s+free\s*=\s*([\d.]+)([BKMGT]?)(?:\s+\(encrypted\))?\s*$/u.exec(
        line,
      );
    if (swap) {
      for (const [index, field] of (
        ["swapTotalBytes", "swapUsedBytes", "swapFreeBytes"] as const
      ).entries()) {
        const unit = swap[index * 2 + 2];
        const multiplier = unit === undefined ? undefined : units.get(unit);
        const value = Number(swap[index * 2 + 1]) * (multiplier ?? Number.NaN);
        if (finite(value)) {
          result[field] = Math.round(value);
        }
      }
    }
    const load = /^vm\.loadavg:\s*\{\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\}\s*$/u.exec(line);
    if (load) {
      for (const [index, field] of (["load1", "load5", "load15"] as const).entries()) {
        if (finite(Number(load[index + 1]))) {
          result[field] = Number(load[index + 1]);
        }
      }
    }
    const memory = /^hw\.(memsize|logicalcpu):\s*(\d+)\s*$/u.exec(line);
    if (memory && finite(Number(memory[2]))) {
      result[memory[1] === "memsize" ? "memoryBytes" : "logicalCpus"] = Number(memory[2]);
    }
  }
  return result;
}

function cpuMillis(raw: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u.exec(raw);
  if (!match) {
    return undefined;
  }
  const value =
    ((Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0)) * 3600 +
      Number(match[3]) * 60 +
      Number(match[4])) *
    1000;
  return finite(value) ? Math.round(value) : undefined;
}

export function parseProcesses(
  raw: string,
): Map<number, { identity: Identity; metrics: Partial<Record<ProcessField, number>> }> {
  const result = new Map<
    number,
    { identity: Identity; metrics: Partial<Record<ProcessField, number>> }
  >();
  for (const line of raw.split("\n")) {
    const fields = line.trim().split(/\s+/u);
    if (
      fields.length !== 12 ||
      !fields.slice(0, 6).every((field) => /^\d+(?:\.\d+)?$/u.test(field) && finite(Number(field)))
    ) {
      continue;
    }
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    const pgid = Number(fields[2]);
    const rss = Number(fields[3]);
    const virtual = Number(fields[4]);
    const cpu = Number(fields[5]);
    const started = fields.slice(7).join(" ");
    if (
      !Number.isSafeInteger(pid) ||
      !Number.isSafeInteger(ppid) ||
      !Number.isSafeInteger(pgid) ||
      !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u.test(
        started,
      )
    ) {
      continue;
    }
    const cpuMs = cpuMillis(fields[6] ?? "");
    if (cpuMs === undefined || !finite(rss * 1024) || !finite(virtual * 1024)) {
      continue;
    }
    result.set(pid, {
      identity: { pid, ppid, pgid, started },
      metrics: {
        rssBytes: rss * 1024,
        virtualBytes: virtual * 1024,
        cpuPercent: cpu,
        cpuMs,
      },
    });
  }
  return result;
}

function category(symbol: string): Category {
  if (
    /^v8::internal::(?:Heap::(?:Collect|PerformGarbage)|MarkCompactCollector::|Scavenger::|MinorMarkSweepCollector::|ConcurrentMarking::)/u.test(
      symbol,
    )
  ) {
    return "gc";
  }
  if (/^v8::[A-Za-z_]/u.test(symbol)) {
    return "v8";
  }
  if (/^sqlite3[A-Za-z0-9_]*(?:\(|$)/u.test(symbol)) {
    return "sqlite";
  }
  if (/^(?:__psynch_cvwait|_?pthread_cond_(?:wait|timedwait))(?:\(|$)/u.test(symbol)) {
    return "condition";
  }
  if (
    /^(?:semaphore_wait_trap|semaphore_timedwait_trap|semaphore_wait|semaphore_timedwait)(?:\(|$)/u.test(
      symbol,
    )
  ) {
    return "semaphore";
  }
  if (
    /^(?:__psynch_mutexwait|__ulock_wait2?|_?pthread_mutex_lock|_?os_unfair_lock_lock_slow)(?:\(|$)/u.test(
      symbol,
    )
  ) {
    return "mutex";
  }
  if (/^(?:kevent(?:64)?|uv__io_poll|uv_run|poll|select|__select)(?:\(|$)/u.test(symbol)) {
    return "poll";
  }
  if (
    /^(?:pread|pwrite|read|write|open|fsync|fcntl|stat|lstat|getattrlist|uv__fs_work)(?:\$NOCANCEL)?(?:\(|$)/u.test(
      symbol,
    )
  ) {
    return "io";
  }
  return "other";
}

export function parseStacks(raw: string): { threads: ThreadRecord[]; truncated: boolean } {
  const threads: ThreadRecord[] = [];
  let current: ThreadRecord | undefined;
  let inGraph = false;
  let truncated = false;
  for (const line of raw.split("\n")) {
    if (line.length > 4096) {
      truncated = true;
      continue;
    }
    if (/^Call graph:\s*$/u.test(line)) {
      inGraph = true;
      continue;
    }
    if (!inGraph) {
      continue;
    }
    if (/^(?:Total number in stack|Sort by top of stack|Binary Images:)/u.test(line)) {
      break;
    }
    const thread = /^\s*(\d+)\s+Thread_\d+(?:\s|:|$)/u.exec(line);
    if (thread) {
      if (threads.length >= 32 || !finite(Number(thread[1]))) {
        current = undefined;
        truncated = true;
        continue;
      }
      current = {
        index: threads.length,
        kind: /(?:^|\s)com\.apple\.main-thread(?:\s|$)/u.test(line) ? "main" : "other",
        samples: Number(thread[1]),
        frames: [],
      };
      threads.push(current);
      continue;
    }
    const frame = /^[\s+|!:]*(\d+)\s+(.+?)\s+\(in [^)]+\)/u.exec(line);
    if (!current || !frame?.[2] || !finite(Number(frame[1]))) {
      continue;
    }
    const label = category(frame[2]);
    const existing = current.frames.find((entry) => entry.category === label);
    const count = (existing?.sampleTreeOccurrences ?? 0) + Number(frame[1]);
    if (!finite(count)) {
      truncated = true;
      continue;
    }
    if (existing) {
      existing.sampleTreeOccurrences = count;
    } else {
      current.frames.push({ category: label, sampleTreeOccurrences: count });
    }
  }
  return { threads, truncated };
}

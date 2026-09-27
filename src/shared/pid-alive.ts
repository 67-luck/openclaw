// Native Node callers load this source closure without a TypeScript import resolver.
import childProcess from "node:child_process";
import fsSync from "node:fs";
import { createRequire } from "node:module";
import { resolveDiagnosticProcessEnv } from "../infra/process-env.ts";
import { readWindowsProcessStartTimeSync } from "../infra/windows-process-start.ts";
import { readFreeBsdProcessStartTime } from "./freebsd-process-identity.ts";

const PROCESS_START_TIMEOUT_MS = 1000;
declare const SEALED_RUNTIME_BUILD: boolean;
let darwinNative:
  | {
      library: import("koffi").LibraryHandle;
      query: ReturnType<import("koffi").LibraryHandle["func"]>;
    }
  | undefined;

function readDarwinNativeInfo(pid: number, flavor: number, size: number): Buffer | null {
  if (
    process.platform !== "darwin" ||
    (process.arch !== "arm64" && process.arch !== "x64") ||
    !isValidPid(pid) ||
    pid > 0x7fffffff ||
    (typeof SEALED_RUNTIME_BUILD === "boolean" && SEALED_RUNTIME_BUILD)
  ) {
    return null;
  }
  try {
    if (!darwinNative) {
      const koffi: typeof import("koffi").default = createRequire(import.meta.url)("koffi");
      const library = koffi.load("/usr/lib/libproc.dylib");
      const query = library.func(
        "int proc_pidinfo(int pid, int flavor, uint64_t arg, _Out_ void *buffer, int buffersize)",
      );
      darwinNative = { library, query };
    }
    // Query every foreign PID afresh; only the callable and its library are retained.
    const bytes = Buffer.alloc(size);
    return darwinNative.query(pid, flavor, 0, bytes, bytes.length) === bytes.length ? bytes : null;
  } catch {
    // Missing native packages and denied queries cannot establish native identity.
    return null;
  }
}

function readDarwinNativeIdentity(pid: number): { parentPid: number; startedAt: number } | null {
  // Darwin's public PROC_PIDTBSDINFO ABI is 136 bytes on arm64 and x86_64.
  const bytes = readDarwinNativeInfo(pid, 3, 136);
  if (!bytes) {
    return null;
  }
  const parentPid = bytes.readUInt32LE(16);
  const seconds = bytes.readBigUInt64LE(120);
  if (
    bytes.readUInt32LE(12) !== pid ||
    parentPid > 0x7fffffff ||
    seconds === 0n ||
    seconds > BigInt(Number.MAX_SAFE_INTEGER) ||
    bytes.readBigUInt64LE(128) >= 1_000_000n
  ) {
    return null;
  }
  // Published Darwin leases use ps lstart's epoch seconds, not microseconds.
  return { parentPid, startedAt: Number(seconds) };
}

// Keep launchd's synchronous XPC lookup in a bounded, joined diagnostic child.
const DARWIN_COALITION_INFO_SCRIPT = String.raw`
const koffi = require(process.argv[1]);
const library = koffi.load('/usr/lib/system/libxpc.dylib');
const copy = library.func('void *xpc_coalition_copy_info(uint64_t id)');
const release = library.func('void xpc_release(void *value)');
const type = library.func('void *xpc_get_type(void *value)');
const getId = library.func('uint64_t xpc_dictionary_get_uint64(void *value, const char *key)');
const getName = library.func('const char *xpc_dictionary_get_string(void *value, const char *key)');
const dictionaryType = koffi.address(library.symbol('_xpc_type_dictionary'));
const idKey = koffi.decode(library.symbol('XPC_COALITION_INFO_KEY_CID'), 'const char *');
const nameKey = koffi.decode(library.symbol('XPC_COALITION_INFO_KEY_NAME'), 'const char *');
const reply = copy(BigInt(process.argv[2]));
if (!reply) process.exit(1);
try {
  if (koffi.address(type(reply)) !== dictionaryType) throw new Error('Unexpected coalition reply');
  process.stdout.write(JSON.stringify({ id: String(getId(reply, idKey)), name: getName(reply, nameKey) }));
} finally {
  release(reply);
}
`;

/** Read kernel membership and launchd's job name when older launchctl omits them. */
export function readDarwinProcessResourceCoalition(
  pid: number,
): { id: bigint; name?: string } | null {
  // PROC_PIDCOALITIONINFO: two uint64 IDs (resource, jetsam), then three reserved uint64s.
  const bytes = readDarwinNativeInfo(pid, 20, 40);
  const id = bytes?.readBigUInt64LE(0);
  if (!id) {
    return null;
  }
  try {
    const koffiPath = createRequire(import.meta.url).resolve("koffi");
    const info: unknown = JSON.parse(
      childProcess.execFileSync(
        process.execPath,
        ["--input-type=commonjs", "-e", DARWIN_COALITION_INFO_SCRIPT, koffiPath, id.toString()],
        {
          encoding: "utf8",
          env: resolveDiagnosticProcessEnv(),
          stdio: ["ignore", "pipe", "ignore"],
          timeout: PROCESS_START_TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: 4096,
        },
      ),
    );
    if (
      info &&
      typeof info === "object" &&
      "id" in info &&
      info.id === id.toString() &&
      "name" in info &&
      typeof info.name === "string" &&
      info.name.trim()
    ) {
      return { id, name: info.name.trim() };
    }
  } catch {
    // IDs still prove shared membership; unequal IDs without names cannot prove escape.
  }
  return { id };
}
// Bound corrupted/cyclic ancestry while allowing nested service supervisors.
export const MAX_ANCESTOR_WALK_DEPTH = 32;

/** Project a best-effort ancestor chain without deciding liveness or authority. */
export function collectProcessAncestorPids(
  immediateParent: number,
  readParentPid: (pid: number) => number | null,
  throughPid?: number,
): Set<number> {
  const pids = new Set<number>([process.pid]);
  if (!Number.isFinite(immediateParent) || immediateParent <= 0) {
    return pids;
  }
  pids.add(immediateParent);
  let current = immediateParent;
  for (let depth = 0; depth < MAX_ANCESTOR_WALK_DEPTH && current !== throughPid; depth++) {
    const parent = readParentPid(current);
    if (parent == null || parent <= 0 || pids.has(parent)) {
      break;
    }
    pids.add(parent);
    current = parent;
  }
  return pids;
}

// Cache only a successful self read: this identity lasts for the process.
// Failed reads must retry, and foreign PIDs must stay fresh to detect PID reuse.
let selfStartTime: number | null = null;

function isValidPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

/**
 * Check if every thread has exited by reading Linux /proc/<pid>/status.
 * Returns false on non-Linux platforms or if the proc file can't be read.
 */
function isZombieProcess(pid: number): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const status = fsSync.readFileSync(`/proc/${pid}/status`, "utf8");
    const stateMatch = status.match(/^State:\s+(\S)/m);
    // pthread_exit can leave a zombie leader with live workers; missing thread
    // evidence must not revoke a live process's locks or cleanup obligations.
    return stateMatch?.[1] === "Z" && /^Threads:[ \t]+1[ \t]*$/m.test(status);
  } catch {
    return false;
  }
}

/** Returns true only when a positive PID exists and is not a Linux zombie process. */
export function isPidAlive(pid: number): boolean {
  if (!isValidPid(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM means the PID exists but we cannot signal it. Treat that as a
    // successful existence probe, then still apply the Linux zombie check.
    // Keep parity with isPidDefinitelyDead (EPERM is not "definitely dead").
    if ((err as NodeJS.ErrnoException).code !== "EPERM") {
      return false;
    }
  }
  return !isZombieProcess(pid);
}

/** Returns true only when the PID is invalid, missing, or known to be a Linux zombie. */
export function isPidDefinitelyDead(pid: number): boolean {
  if (!isValidPid(pid)) {
    return true;
  }
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
  return isZombieProcess(pid);
}

function getDarwinProcessStartTime(
  pid: number,
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
): number | null {
  const started = performance.now();
  const native = readDarwinNativeIdentity(pid);
  if (native) {
    return native.startedAt;
  }
  // The default bounds ps itself; explicit deadlines also pay for native loading.
  const remainingMs =
    timeoutMs === undefined
      ? PROCESS_START_TIMEOUT_MS
      : Math.ceil(timeoutMs - (performance.now() - started));
  if (remainingMs <= 0) {
    return null;
  }
  try {
    const startedAt = childProcess
      .execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        env: { ...resolveDiagnosticProcessEnv(env), LC_ALL: "C", TZ: "UTC" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: remainingMs,
        killSignal: "SIGKILL",
      })
      .trim();
    // Darwin's lstart output has no timezone. Force UTC for both ps and parsing so
    // a system timezone change cannot make a live lock owner look like PID reuse.
    const startedAtMs = Date.parse(`${startedAt} UTC`);
    return Number.isFinite(startedAtMs) ? Math.floor(startedAtMs / 1000) : null;
  } catch {
    return null;
  }
}

/** Read one Darwin PID's parent and birth together, without enumerating unrelated processes. */
export function readDarwinProcessIdentity(
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs?: number,
): { parentPid: number; startedAt: number } | null {
  if (process.platform !== "darwin" || !isValidPid(pid)) {
    return null;
  }
  const started = performance.now();
  const native = readDarwinNativeIdentity(pid);
  if (native) {
    return native;
  }
  const remainingMs =
    timeoutMs === undefined
      ? PROCESS_START_TIMEOUT_MS
      : Math.ceil(timeoutMs - (performance.now() - started));
  if (remainingMs <= 0) {
    return null;
  }
  try {
    const stdout = childProcess.execFileSync(
      "/bin/ps",
      ["-o", "pid=,ppid=,lstart=", "-p", String(pid)],
      {
        encoding: "utf8",
        env: { ...resolveDiagnosticProcessEnv(env), LC_ALL: "C", TZ: "UTC" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: remainingMs,
        killSignal: "SIGKILL",
        maxBuffer: 4096,
      },
    );
    // A complete single-PID record is required; truncated or extra rows are unknown.
    if (!stdout.endsWith("\n") || /[\r\n]/.test(stdout.slice(0, -1))) {
      return null;
    }
    const match =
      /^[ \t]*(\d+)[ \t]+(\d+)[ \t]+(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +(\d{1,2}) (\d{2}:\d{2}:\d{2}) (\d{4})[ \t]*$/.exec(
        stdout.slice(0, -1),
      );
    if (!match || Number(match[1]) !== pid || match[5] === undefined) {
      return null;
    }
    const parentPid = Number(match[2]);
    const date = `${match[3]}, ${match[5].padStart(2, "0")} ${match[4]} ${match[7]} ${match[6]} GMT`;
    const startedAtMs = Date.parse(date);
    if (
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0 ||
      !Number.isFinite(startedAtMs) ||
      new Date(startedAtMs).toUTCString() !== date
    ) {
      return null;
    }
    return { parentPid, startedAt: Math.floor(startedAtMs / 1000) };
  } catch {
    return null;
  }
}

/** Read the Linux procfs start identity used by Linux-owned runtime state. */
export function getProcessStartTime(pid: number): number | null {
  if (!isValidPid(pid) || process.platform !== "linux") {
    return null;
  }
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEndIndex = stat.lastIndexOf(")");
    if (commEndIndex < 0) {
      return null;
    }
    // The comm field (field 2) is wrapped in parens and can contain spaces,
    // so split after the last ")" to get fields 3..N reliably.
    const afterComm = stat.slice(commEndIndex + 1).trimStart();
    const fields = afterComm.split(/\s+/);
    // field 22 (starttime) = index 19 after the comm-split (field 3 is index 0).
    const starttime = Number(fields[19]);
    return Number.isInteger(starttime) && starttime >= 0 ? starttime : null;
  } catch {
    return null;
  }
}

/** Read a cross-platform process identity for filesystem lock ownership. */
export function getFileLockProcessStartTime(
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs?: number,
): number | null {
  if (!isValidPid(pid)) {
    return null;
  }
  const isSelf = pid === process.pid;
  if (isSelf && selfStartTime !== null) {
    return selfStartTime;
  }
  const startTime =
    process.platform === "darwin"
      ? getDarwinProcessStartTime(pid, env, timeoutMs)
      : process.platform === "win32"
        ? readWindowsProcessStartTimeSync(pid, timeoutMs, env)
        : process.platform === "freebsd"
          ? readFreeBsdProcessStartTime(pid)
          : getProcessStartTime(pid);
  if (isSelf && startTime !== null) {
    selfStartTime = startTime;
  }
  return startTime;
}

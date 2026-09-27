import childProcess from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const nativeKoffi = vi.hoisted(() => vi.fn());
const nativeResolve = vi.hoisted(() => vi.fn());
vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>();
  return {
    createRequire: (url: string | URL) => {
      const require = original.createRequire(url);
      return Object.assign((id: string) => (id === "koffi" ? nativeKoffi() : require(id)), {
        resolve: (id: string) => (id === "koffi" ? nativeResolve(id) : require.resolve(id)),
      });
    },
  };
});

const seconds = 1_790_000_000;
let bytes: Buffer;
const query = vi.fn();
const load = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
  bytes = Buffer.alloc(136);
  bytes.writeUInt32LE(42, 12);
  bytes.writeUInt32LE(7, 16);
  bytes.writeBigUInt64LE(BigInt(seconds), 120);
  bytes.writeBigUInt64LE(999_999n, 128);
  query.mockReset().mockImplementation((_pid, _flavor, _arg, output: Buffer) => {
    bytes.copy(output);
    return bytes.length;
  });
  load.mockReset().mockReturnValue({ func: () => query });
  nativeKoffi.mockReset().mockReturnValue({ load });
  nativeResolve.mockReset().mockReturnValue("/synthetic/koffi.cjs");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each(["arm64", "x64"] as const)(
  "reads fresh Darwin identities without process startup on %s",
  async (arch) => {
    vi.spyOn(process, "arch", "get").mockReturnValue(arch);
    const shell = vi.spyOn(childProcess, "execFileSync");
    const { getFileLockProcessStartTime, readDarwinProcessIdentity } =
      await import("./pid-alive.js");
    expect(getFileLockProcessStartTime(42)).toBe(seconds);
    bytes.writeBigUInt64LE(BigInt(seconds + 1), 120);
    bytes.writeUInt32LE(8, 16);
    expect(getFileLockProcessStartTime(42)).toBe(seconds + 1);
    expect(readDarwinProcessIdentity(42)).toEqual({ parentPid: 8, startedAt: seconds + 1 });
    expect(shell).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledExactlyOnceWith("/usr/lib/libproc.dylib");
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0]).toEqual([42, 3, 0, expect.any(Buffer), 136]);
  },
);

it.each([
  "short read",
  "wrong PID",
  "invalid parent",
  "zero start",
  "unsafe start",
  "invalid microseconds",
  "query error",
  "missing native package",
])("uses the bounded shell fallback after %s", async (failure) => {
  if (failure === "short read") {
    query.mockReturnValue(135);
  }
  if (failure === "wrong PID") {
    bytes.writeUInt32LE(43, 12);
  }
  if (failure === "invalid parent") {
    bytes.writeUInt32LE(0xffffffff, 16);
  }
  if (failure === "zero start") {
    bytes.writeBigUInt64LE(0n, 120);
  }
  if (failure === "unsafe start") {
    bytes.writeBigUInt64LE(2n ** 53n, 120);
  }
  if (failure === "invalid microseconds") {
    bytes.writeBigUInt64LE(1_000_000n, 128);
  }
  if (failure === "query error") {
    query.mockImplementation(() => {
      throw new Error("denied");
    });
  }
  if (failure === "missing native package") {
    nativeKoffi.mockImplementation(() => {
      throw new Error("unavailable");
    });
  }
  const shell = vi
    .spyOn(childProcess, "execFileSync")
    .mockImplementation((_file, args) =>
      args?.[1] === "lstart=" ? "Thu Sep 24 00:00:00 2026\n" : "42 7 Thu Sep 24 00:00:00 2026\n",
    );
  const { getFileLockProcessStartTime, readDarwinProcessIdentity } = await import("./pid-alive.js");
  const expected = Date.UTC(2026, 8, 24) / 1000;
  expect(getFileLockProcessStartTime(42)).toBe(expected);
  expect(readDarwinProcessIdentity(42)).toEqual({ parentPid: 7, startedAt: expected });
  expect(shell).toHaveBeenCalledTimes(2);
  for (const call of shell.mock.calls) {
    expect(call[2]?.timeout).toBeGreaterThan(0);
    expect(call[2]?.timeout).toBeLessThanOrEqual(1000);
  }
  shell.mockImplementation(() => {
    throw new Error("process absent");
  });
  expect(getFileLockProcessStartTime(42)).toBeNull();
  expect(readDarwinProcessIdentity(42)).toBeNull();
});

it("retries a failed native load without caching a missing process", async () => {
  nativeKoffi.mockImplementationOnce(() => {
    throw new Error("native package unavailable");
  });
  const shell = vi.spyOn(childProcess, "execFileSync").mockImplementation(() => {
    throw new Error("absent");
  });
  const { getFileLockProcessStartTime } = await import("./pid-alive.js");
  expect(getFileLockProcessStartTime(42)).toBeNull();
  expect(getFileLockProcessStartTime(42)).toBe(seconds);
  expect(shell).toHaveBeenCalledTimes(1);
});

it("keeps sealed helpers independent of installed native packages", async () => {
  vi.stubGlobal("SEALED_RUNTIME_BUILD", true);
  vi.spyOn(childProcess, "execFileSync").mockReturnValue("Thu Sep 24 00:00:00 2026\n");
  const { getFileLockProcessStartTime } = await import("./pid-alive.js");
  expect(getFileLockProcessStartTime(42)).toBe(Date.UTC(2026, 8, 24) / 1000);
  expect(nativeKoffi).not.toHaveBeenCalled();
});

it("preserves default shell recovery after slow native loading fails", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  nativeKoffi.mockImplementation(() => {
    now += 1500;
    throw new Error("native unavailable");
  });
  const shell = vi
    .spyOn(childProcess, "execFileSync")
    .mockImplementation((_file, args) =>
      args?.[1] === "lstart=" ? "Thu Sep 24 00:00:00 2026\n" : "42 7 Thu Sep 24 00:00:00 2026\n",
    );
  const { getFileLockProcessStartTime, readDarwinProcessIdentity } = await import("./pid-alive.js");
  const expected = Date.UTC(2026, 8, 24) / 1000;
  expect(getFileLockProcessStartTime(42)).toBe(expected);
  expect(readDarwinProcessIdentity(42)).toEqual({ parentPid: 7, startedAt: expected });
  expect(shell).toHaveBeenCalledTimes(2);
  for (const call of shell.mock.calls) {
    expect(call[2]?.timeout).toBe(1000);
  }
});

it.each([600, 1000])("charges %sms native loading to an explicit deadline", async (elapsed) => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  nativeKoffi.mockImplementation(() => {
    now += elapsed;
    throw new Error("native unavailable");
  });
  const shell = vi
    .spyOn(childProcess, "execFileSync")
    .mockImplementation((_file, args) =>
      args?.[1] === "lstart=" ? "Thu Sep 24 00:00:00 2026\n" : "42 7 Thu Sep 24 00:00:00 2026\n",
    );
  const { getFileLockProcessStartTime, readDarwinProcessIdentity } = await import("./pid-alive.js");
  expect(getFileLockProcessStartTime(42, process.env, 1000)).toBe(
    elapsed === 1000 ? null : Date.UTC(2026, 8, 24) / 1000,
  );
  expect(readDarwinProcessIdentity(42, process.env, 1000)).toEqual(
    elapsed === 1000 ? null : { parentPid: 7, startedAt: Date.UTC(2026, 8, 24) / 1000 },
  );
  if (elapsed === 1000) {
    expect(shell).not.toHaveBeenCalled();
  } else {
    expect(shell).toHaveBeenCalledTimes(2);
    for (const call of shell.mock.calls) {
      expect(call[2]).toMatchObject({ timeout: 400 });
    }
  }
});

it.each([0, -1, 1.5, Number.NaN, Infinity])(
  "rejects invalid PID %s before native conversion",
  async (pid) => {
    const shell = vi.spyOn(childProcess, "execFileSync");
    const {
      getFileLockProcessStartTime,
      readDarwinProcessIdentity,
      readDarwinProcessResourceCoalition,
    } = await import("./pid-alive.js");
    expect(readDarwinProcessResourceCoalition(pid)).toBeNull();
    expect(getFileLockProcessStartTime(pid)).toBeNull();
    expect(readDarwinProcessIdentity(pid)).toBeNull();
    expect(nativeKoffi).not.toHaveBeenCalled();
    expect(shell).not.toHaveBeenCalled();
  },
);

it.each(["arm64", "x64"] as const)(
  "reads fresh full-width Darwin coalitions and job names on %s with the shared native callable",
  async (arch) => {
    vi.spyOn(process, "arch", "get").mockReturnValue(arch);
    vi.stubEnv("NODE_OPTIONS", "--require=must-not-reach-diagnostic-child");
    const shell = vi
      .spyOn(childProcess, "execFileSync")
      .mockImplementation((_file, args) =>
        JSON.stringify({ id: args?.at(-1), name: "fixture.job" }),
      );
    const identity = bytes;
    bytes = Buffer.alloc(40);
    bytes.writeBigUInt64LE(2n ** 63n, 0);
    bytes.writeBigUInt64LE(99n, 8);
    const { readDarwinProcessResourceCoalition, readDarwinProcessIdentity } =
      await import("./pid-alive.js");
    expect(readDarwinProcessResourceCoalition(42)).toEqual({ id: 2n ** 63n, name: "fixture.job" });
    bytes.writeBigUInt64LE(2n ** 63n + 1n, 0);
    expect(readDarwinProcessResourceCoalition(42)).toEqual({
      id: 2n ** 63n + 1n,
      name: "fixture.job",
    });
    bytes = identity;
    expect(readDarwinProcessIdentity(42)).toEqual({ parentPid: 7, startedAt: seconds });
    expect(load).toHaveBeenCalledExactlyOnceWith("/usr/lib/libproc.dylib");
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0]).toEqual([42, 20, 0, expect.any(Buffer), 40]);
    expect(query.mock.calls[1]).toEqual([42, 20, 0, expect.any(Buffer), 40]);
    expect(query.mock.calls[2]).toEqual([42, 3, 0, expect.any(Buffer), 136]);
    expect(shell).toHaveBeenCalledTimes(2);
    for (const [file, args, options] of shell.mock.calls) {
      expect(file).toBe(process.execPath);
      expect(args).toEqual([
        "--input-type=commonjs",
        "-e",
        expect.any(String),
        "/synthetic/koffi.cjs",
        expect.any(String),
      ]);
      expect(options).toMatchObject({
        timeout: 1000,
        killSignal: "SIGKILL",
        maxBuffer: 4096,
        stdio: ["ignore", "pipe", "ignore"],
      });
      expect(options?.env).not.toHaveProperty("NODE_OPTIONS");
    }
  },
);

it.each(["zero resource ID", "short read", "query error", "missing native package"])(
  "keeps coalition %s unknown without a shell fallback",
  async (failure) => {
    bytes = Buffer.alloc(40);
    bytes.writeBigUInt64LE(failure === "zero resource ID" ? 0n : 123n, 0);
    bytes.writeBigUInt64LE(456n, 8);
    if (failure === "short read") {
      query.mockReturnValue(39);
    }
    if (failure === "query error") {
      query.mockImplementation(() => {
        throw new Error("denied");
      });
    }
    if (failure === "missing native package") {
      nativeKoffi.mockImplementation(() => {
        throw new Error("unavailable");
      });
    }
    const shell = vi.spyOn(childProcess, "execFileSync");
    const { readDarwinProcessResourceCoalition } = await import("./pid-alive.js");
    expect(readDarwinProcessResourceCoalition(42)).toBeNull();
    expect(shell).not.toHaveBeenCalled();
  },
);

it.each(["non-Darwin", "unsupported architecture", "sealed helper", "oversized PID"])(
  "does not load the coalition query for %s",
  async (condition) => {
    if (condition === "non-Darwin") {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    }
    if (condition === "unsupported architecture") {
      vi.spyOn(process, "arch", "get").mockReturnValue("arm");
    }
    if (condition === "sealed helper") {
      vi.stubGlobal("SEALED_RUNTIME_BUILD", true);
    }
    const { readDarwinProcessResourceCoalition } = await import("./pid-alive.js");
    expect(
      readDarwinProcessResourceCoalition(condition === "oversized PID" ? 0x80000000 : 42),
    ).toBeNull();
    expect(nativeKoffi).not.toHaveBeenCalled();
  },
);

it.each([
  { label: "mismatched coalition", output: JSON.stringify({ id: "124", name: "job" }) },
  { label: "malformed reply", output: "{" },
  { label: "non-dictionary reply", output: "null" },
  { label: "missing name", output: JSON.stringify({ id: "123" }) },
  { label: "non-string name", output: JSON.stringify({ id: "123", name: 1 }) },
  { label: "empty name", output: JSON.stringify({ id: "123", name: "  " }) },
  { label: "failed or timed-out child", error: new Error("diagnostic child unavailable") },
])("retains only the kernel ID after $label", async ({ output, error }) => {
  bytes = Buffer.alloc(40);
  bytes.writeBigUInt64LE(123n, 0);
  vi.spyOn(childProcess, "execFileSync").mockImplementation(() => {
    if (error) {
      throw error;
    }
    return output ?? "";
  });
  const { readDarwinProcessResourceCoalition } = await import("./pid-alive.js");
  expect(readDarwinProcessResourceCoalition(42)).toEqual({ id: 123n });
});

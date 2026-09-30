import { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createChild() {
  const child = new ChildProcess();
  let exitCode: number | null = null;
  Object.defineProperties(child, {
    pid: { value: 12345 },
    exitCode: { get: () => exitCode },
    stdout: { value: null, writable: true },
    stderr: { value: null, writable: true },
  });
  return {
    child,
    exit: () => {
      exitCode = 0;
      child.emit("exit", 0, null);
    },
  };
}

describe("managed child termination facts", () => {
  it.each([
    { exited: false, stdoutClosed: true, stderrClosed: true, groupState: "dead" },
    { exited: true, stdoutClosed: false, stderrClosed: true, groupState: "dead" },
    { exited: true, stdoutClosed: true, stderrClosed: false, groupState: "dead" },
    { exited: true, stdoutClosed: true, stderrClosed: true, groupState: "indeterminate" },
    { exited: true, stdoutClosed: true, stderrClosed: true, groupState: "live" },
  ] as const)(
    "reports unjoined cleanup facts before destroying output: $exited/$stdoutClosed/$stderrClosed/$groupState",
    async ({ exited, stdoutClosed, stderrClosed, groupState }) => {
      const { child, exit } = createChild();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      child.stdout = stdout;
      child.stderr = stderr;
      for (const pipe of [stdout, stderr]) {
        // Force close delivery during destruction to distinguish the retained
        // cleanup snapshot from the eventual locally closed stream handles.
        vi.spyOn(pipe, "destroy").mockImplementation(() => {
          pipe.emit("close");
          return pipe;
        });
      }
      vi.spyOn(child, "kill").mockReturnValue(true);
      const signalProcess = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
        if (signal === 0 && groupState !== "live") {
          throw Object.assign(new Error("group observation"), {
            code: groupState === "dead" ? "ESRCH" : "EIO",
          });
        }
        return true;
      });
      spawn.mockReturnValue(child);
      const abort = new AbortController();
      const onLifecycle = vi.fn(() => {
        throw new Error("diagnostic consumer failed");
      });
      await expect(
        runManagedCommand({
          bin: "fixture",
          platform: "darwin",
          stdio: "pipe",
          requireProcessTreeExit: true,
          env: { TMPDIR: process.cwd() },
          signal: abort.signal,
          abortKillGraceMs: 0,
          cleanupDrainTimeoutMs: 0,
          onLifecycle,
          onReady: () => {
            if (exited) {
              exit();
            }
            if (stdoutClosed) {
              stdout.emit("close");
            }
            if (stderrClosed) {
              stderr.emit("close");
            }
            abort.abort();
          },
        }),
      ).rejects.toMatchObject({ code: "EPROCESSGROUP_CLEANUP_FAILED" });
      expect(onLifecycle).toHaveBeenCalledExactlyOnceWith({
        elapsedMs: expect.any(Number),
        spawnStartedMs: expect.any(Number),
        spawnReturnedMs: expect.any(Number),
        ...(exited ? { exitMs: expect.any(Number), exitCode: 0 } : {}),
        stdoutCloseMs: expect.any(Number),
        stderrCloseMs: expect.any(Number),
        stopMs: expect.any(Number),
        stopSignal: 15,
        stopReason: "aborted",
        cleanup: {
          startedMs: expect.any(Number),
          elapsedMs: expect.any(Number),
          childExited: exited,
          groupState,
          stdoutClosed,
          stderrClosed,
          joined: false,
        },
      });
      expect(signalProcess.mock.calls.filter(([, signal]) => signal === 0)).toHaveLength(1);
    },
  );

  it("reports the first timeout even when abort and unjoined cleanup follow", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const { child } = createChild();
    spawn.mockReturnValue(child);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("group gone"), { code: "ESRCH" });
    });
    vi.spyOn(child, "kill").mockReturnValue(false);
    const abort = new AbortController();
    const onLifecycle = vi.fn();
    const command = runManagedCommand({
      bin: "fixture",
      platform: "darwin",
      stdio: "ignore",
      env: { TMPDIR: process.cwd() },
      timeoutMs: 10,
      timeoutKillGraceMs: 10,
      cleanupDrainTimeoutMs: 10,
      signal: abort.signal,
      onLifecycle,
    });
    const failed = expect(command).rejects.toMatchObject({ code: "EPROCESSGROUP_CLEANUP_FAILED" });
    await vi.advanceTimersByTimeAsync(10);
    abort.abort();
    await vi.advanceTimersByTimeAsync(20);
    await failed;
    expect(onLifecycle).toHaveBeenCalledExactlyOnceWith({
      elapsedMs: 30,
      spawnStartedMs: 0,
      spawnReturnedMs: 0,
      stopMs: 10,
      stopReason: "timeout",
      stopSignal: 15,
      cleanup: {
        startedMs: 10,
        elapsedMs: 20,
        groupState: "dead",
        childExited: false,
        stdoutClosed: true,
        stderrClosed: true,
        joined: false,
      },
    });
  });

  it.each([
    { received: null, strict: false },
    { received: "SIGTERM", strict: false },
    { received: null, strict: true },
  ] as const)(
    "reports ordinary exit ($received, strict $strict) despite diagnostic errors",
    async ({ received, strict }) => {
      const { child, exit } = createChild();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      spawn.mockReturnValue(child);
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("group gone"), { code: "ESRCH" });
      });
      let time = 0;
      vi.spyOn(performance, "now").mockImplementation(() => time);
      const onLifecycle = vi.fn(() => {
        if (strict) {
          return Promise.reject(new Error("asynchronous diagnostic consumer failed"));
        }
        throw new Error("diagnostic consumer failed");
      });
      await expect(
        runManagedCommand({
          bin: "fixture",
          platform: "darwin",
          stdio: "pipe",
          requireProcessTreeExit: strict,
          env: { TMPDIR: process.cwd() },
          onLifecycle,
          onReady: () => {
            time = 1;
            if (received) {
              child.emit("exit", null, received);
            } else {
              exit();
            }
            time = 2;
            child.stdout?.emit("close");
            time = 3;
            child.stderr?.emit("close");
            child.emit("close", received ? null : 0, received);
            time = 4;
          },
        }),
      ).resolves.toBe(received ? 143 : 0);
      expect(onLifecycle).toHaveBeenCalledExactlyOnceWith({
        elapsedMs: 4,
        spawnStartedMs: 0,
        spawnReturnedMs: 0,
        exitMs: 1,
        ...(received ? { exitSignal: 15 } : { exitCode: 0 }),
        stdoutCloseMs: 2,
        stderrCloseMs: 3,
        ...(strict
          ? {
              cleanup: {
                startedMs: 4,
                elapsedMs: 0,
                groupState: "dead",
                childExited: true,
                stdoutClosed: true,
                stderrClosed: true,
                joined: true,
              },
            }
          : {}),
      });
    },
  );

  it.each(["synchronous", "deferred"] as const)(
    "reports a %s spawn failure without inventing exit observations",
    async (failureKind) => {
      const { child } = createChild();
      const failure = new Error("spawn failed");
      spawn.mockImplementation(() => {
        if (failureKind === "synchronous") {
          throw failure;
        }
        return child;
      });
      const onLifecycle = vi.fn(() => {
        throw new Error("diagnostic consumer failed");
      });
      await expect(
        runManagedCommand({
          bin: "fixture",
          platform: "darwin",
          stdio: "ignore",
          env: { TMPDIR: process.cwd() },
          onLifecycle,
          onReady: () => child.emit("error", failure),
        }),
      ).rejects.toBe(failure);
      expect(onLifecycle).toHaveBeenCalledExactlyOnceWith({
        elapsedMs: expect.any(Number),
        spawnStartedMs: expect.any(Number),
        ...(failureKind === "deferred" ? { spawnReturnedMs: expect.any(Number) } : {}),
      });
    },
  );

  it.each(["SIGTERM", "SIGKILL"])(
    "retains POSIX %s failures through cleanup",
    async (failedSignal) => {
      const { child } = createChild();
      const groupError = Object.assign(new Error("group signal denied"), { code: "EPERM" });
      const childError = Object.assign(new Error("child signal denied"), { code: "EACCES" });
      const kill = vi.spyOn(child, "kill").mockImplementation((signal) => {
        if (signal === failedSignal) {
          throw childError;
        }
        return true;
      });
      const signalProcess = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
        if (signal === failedSignal) {
          throw groupError;
        }
        return true;
      });
      spawn.mockReturnValue(child);
      const abort = new AbortController();
      await expect(
        runManagedCommand({
          bin: "fixture",
          platform: "linux",
          shell: false,
          stdio: "ignore",
          env: { TMPDIR: process.cwd() },
          signal: abort.signal,
          abortKillGraceMs: 0,
          cleanupDrainTimeoutMs: 0,
          onReady: () => abort.abort(),
        }),
      ).rejects.toMatchObject({
        code: "EPROCESSGROUP_CLEANUP_FAILED",
        cause: { errors: [groupError, childError] },
      });
      expect(kill).toHaveBeenCalledWith(failedSignal);
      expect(signalProcess).toHaveBeenCalledWith(-12345, "SIGKILL");
    },
  );

  it.each(["exit", "missing PID", "alive"] as const)(
    "retains an unowned Windows tree after taskkill status 255 (%s)",
    async (state) => {
      const { child, exit } = createChild();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const kill = vi.spyOn(child, "kill").mockReturnValue(true);
      vi.spyOn(process, "kill").mockImplementation(() => {
        if (state === "missing PID") {
          throw Object.assign(new Error("process is gone"), { code: "ESRCH" });
        }
        return true;
      });
      spawn.mockReturnValue(child);
      const abort = new AbortController();
      const outputClosed = Promise.all([once(child.stdout, "close"), once(child.stderr, "close")]);
      const runTaskkill = vi.fn(() => {
        if (state === "exit") {
          exit();
        }
        return {
          status: 255,
          stdout: Buffer.from("taskkill attempted the owned tree"),
          stderr: Buffer.from("taskkill could not find the task"),
        };
      });
      try {
        const completed = runManagedCommand({
          bin: "fixture",
          platform: "win32",
          shell: false,
          // IPC callers bypass Job admission and exercise the unowned-tree contract.
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          // The synthetic child has no filesystem resources to retain on failure.
          env: { TMPDIR: process.cwd() },
          runTaskkill,
          signal: abort.signal,
          onReady: () => abort.abort(),
        });
        // Output may close after the synchronous termination attempt returns.
        if (state !== "alive") {
          setImmediate(() => {
            if (state === "missing PID") {
              exit();
            }
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.emit("close", 0, null);
          });
          await expect(completed).rejects.toMatchObject({
            code: "EPROCESSGROUP_CLEANUP_FAILED",
            processTreeState: "indeterminate",
          });
          expect(runTaskkill).toHaveBeenCalledOnce();
          expect(kill).not.toHaveBeenCalled();
        } else {
          await expect(completed).rejects.toMatchObject({
            code: "EPROCESSGROUP_CLEANUP_FAILED",
            processTreeState: "indeterminate",
            cause: {
              message: expect.stringContaining('"status":255'),
              taskkill: expect.arrayContaining([
                expect.objectContaining({
                  status: 255,
                  stdout: "taskkill attempted the owned tree",
                  stderr: "taskkill could not find the task",
                }),
              ]),
            },
          });
        }
      } finally {
        child.stdout.destroy();
        child.stderr.destroy();
        await outputClosed;
      }
    },
  );
});

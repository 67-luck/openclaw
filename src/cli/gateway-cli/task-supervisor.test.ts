import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  readWindowsTaskSupervisorRestartExitCode,
  WINDOWS_TASK_SUPERVISOR_CHILD_FLAG,
  WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE_MAX,
  WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE_MIN,
} from "../../daemon/windows-task-supervisor-contract.js";
import type { SpawnInput } from "../../process/supervisor/types.js";

const { spawn, acquireScopeCleanup, cleanupScope, log, flushLogger, bindWindowsTaskLauncher } =
  vi.hoisted(() => ({
    spawn: vi.fn(),
    acquireScopeCleanup: vi.fn(),
    cleanupScope: vi.fn(),
    log: { info: vi.fn(), error: vi.fn() },
    flushLogger: vi.fn(async () => {}),
    bindWindowsTaskLauncher: vi.fn(),
  }));

vi.mock("koffi", () => ({ default: {} }));
vi.mock("../../process/supervisor/service-child-windows-task-launcher.js", () => ({
  bindWindowsTaskLauncher,
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => log,
}));

vi.mock("../../logging/logger.js", () => ({ flushLogger }));

vi.mock("../../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn, acquireScopeCleanup }),
}));

function readSpawnRestartExitCode(input: SpawnInput): number {
  if (input.mode !== "child") {
    throw new Error("Expected structured child input");
  }
  const exitCode = readWindowsTaskSupervisorRestartExitCode(input.argv);
  if (exitCode === undefined) {
    throw new Error("Expected a correlated task-supervisor restart code");
  }
  expect(exitCode).toBeGreaterThanOrEqual(WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE_MIN);
  expect(exitCode).toBeLessThanOrEqual(WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE_MAX);
  return exitCode;
}

describe("Windows Gateway task supervisor", () => {
  const argv = [...process.argv];
  const execArgv = [...process.execArgv];
  const exitCode = process.exitCode;
  const launcherMarker = process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER;

  beforeEach(() => {
    process.argv = [
      process.execPath,
      "C:\\OpenClaw\\dist\\entry.js",
      "gateway",
      "--task-supervisor",
    ];
    process.execArgv = ["--import", "tsx"];
    process.exitCode = undefined;
    acquireScopeCleanup.mockReturnValue(cleanupScope);
    cleanupScope.mockResolvedValue(undefined);
    delete process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER;
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  });

  afterEach(() => {
    process.argv = [...argv];
    process.execArgv = [...execArgv];
    process.exitCode = exitCode;
    if (launcherMarker === undefined) {
      delete process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER;
    } else {
      process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER = launcherMarker;
    }
    vi.restoreAllMocks();
    vi.clearAllMocks();
    spawn.mockReset();
    acquireScopeCleanup.mockReset();
    cleanupScope.mockReset();
    bindWindowsTaskLauncher.mockReset();
  });

  it("binds launcher ownership before admitting a child and consumes the launcher marker", async () => {
    process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER = "wscript";
    bindWindowsTaskLauncher.mockImplementation(() => {
      expect(spawn).not.toHaveBeenCalled();
      expect(process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER).toBeUndefined();
    });
    spawn.mockImplementation(async () => {
      expect(bindWindowsTaskLauncher).toHaveBeenCalledOnce();
      expect(process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER).toBeUndefined();
      return { cancel: vi.fn(), wait: async () => ({ exitCode: 0, exitSignal: null }) };
    });
    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    await runWindowsGatewayTaskSupervisor();
    expect(spawn).toHaveBeenCalledOnce();
    expect(bindWindowsTaskLauncher).toHaveBeenCalledOnce();
  });

  it("does not admit a Gateway after its task launcher has exited", async () => {
    process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER = "wscript";
    spawn.mockResolvedValue({
      cancel: vi.fn(),
      wait: async () => ({ exitCode: 0, exitSignal: null }),
    });
    bindWindowsTaskLauncher.mockImplementation(() => {
      throw new Error("Windows task WScript launcher is no longer live");
    });
    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    await runWindowsGatewayTaskSupervisor();
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(JSON.stringify(log.error.mock.calls)).toContain("WScript launcher is no longer live");
    expect(process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER).toBeUndefined();
  });

  it("preserves literal child argv and joins required cleanup before returning", async () => {
    // A direct Startup fallback inherits the install preference, without a live WScript owner.
    process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER = "1";
    const entry = "C:\\réseau %% ^!\\dist\\entry.js";
    const loader = "C:\\réseau %PATH% ^!\\loader.mjs";
    process.argv = [
      process.execPath,
      entry,
      "gateway",
      "--task-supervisor",
      WINDOWS_TASK_SUPERVISOR_CHILD_FLAG,
      `${WINDOWS_TASK_SUPERVISOR_CHILD_FLAG}=65536`,
    ];
    process.execArgv = ["--import", loader];
    spawn.mockImplementation(async (input: SpawnInput) => {
      expect(acquireScopeCleanup).toHaveBeenCalledWith(input.scopeKey, {
        processTree: "required-all",
      });
      return {
        cancel: vi.fn(),
        wait: async () => ({ exitCode: 0, exitSignal: null }),
      };
    });
    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    await runWindowsGatewayTaskSupervisor();

    expect(bindWindowsTaskLauncher).not.toHaveBeenCalled();
    const input: SpawnInput = spawn.mock.calls[0]?.[0];
    const restartExitCode = readSpawnRestartExitCode(input);
    expect(input).toMatchObject({
      mode: "child",
      argv: [
        process.execPath,
        "--import",
        loader,
        entry,
        "gateway",
        `${WINDOWS_TASK_SUPERVISOR_CHILD_FLAG}=${restartExitCode}`,
      ],
      stdinMode: "pipe-closed",
      requireWindowsJob: true,
      scopeKey: `gateway-task-supervisor:${process.pid}`,
      captureOutput: false,
    });
    expect(cleanupScope).toHaveBeenCalledOnce();
  });

  it.each([
    { exitCode: 23, exitSignal: null, reason: "exit", expectedCode: 23 },
    { exitCode: null, exitSignal: "SIGTERM", reason: "signal", expectedCode: 1 },
    { exitCode: 0, exitSignal: null, reason: "exit", expectedCode: 0 },
  ])("records child result $exitCode/$exitSignal and preserves its task result", async (result) => {
    const stderr = "Gateway failed to bind its configured port\n";
    spawn.mockImplementation(async (input: SpawnInput) => {
      input.onStderr?.(stderr);
      return {
        cancel: vi.fn(),
        wait: async () => result,
      };
    });

    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    await runWindowsGatewayTaskSupervisor();

    expect(process.exitCode ?? 0).toBe(result.expectedCode);
    const diagnostic = result.exitCode === 0 ? log.info : log.error;
    expect(diagnostic).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        exitCode: result.exitCode,
        exitSignal: result.exitSignal,
        reason: result.reason,
        stderr,
      }),
    );
    expect(flushLogger).toHaveBeenCalledOnce();
  });

  it("retains only a bounded stderr tail and discards stdout", async () => {
    const lastReason = "final startup failure";
    spawn.mockImplementation(async (input: SpawnInput) => {
      expect(input.captureOutput).toBe(false);
      input.onStdout?.("unretained stdout");
      input.onStderr?.("old stderr diagnostic\n");
      input.onStderr?.("x".repeat(8192));
      input.onStderr?.(lastReason);
      return {
        cancel: vi.fn(),
        wait: async () => ({ exitCode: 1, exitSignal: null, reason: "exit" }),
      };
    });

    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    await runWindowsGatewayTaskSupervisor();

    expect(log.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ stderr: expect.stringContaining(lastReason) }),
    );
    const stderr: string = log.error.mock.calls[0]?.[1].stderr;
    expect(stderr.length).toBeLessThanOrEqual(8192);
    expect(stderr).not.toContain("old stderr diagnostic");
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("unretained stdout");
  });

  it.each([false, true])("retains a spawn failure when cleanup fails=%s", async (cleanupFails) => {
    spawn.mockRejectedValue(new Error("synthetic Job Object spawn failure"));
    if (cleanupFails) {
      cleanupScope.mockRejectedValue(new Error("synthetic startup cleanup failure"));
    }

    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    await runWindowsGatewayTaskSupervisor();

    expect(process.exitCode).toBe(1);
    expect(JSON.stringify(log.error.mock.calls)).toContain("synthetic Job Object spawn failure");
    if (cleanupFails) {
      expect(JSON.stringify(log.error.mock.calls)).toContain("synthetic startup cleanup failure");
    }
    expect(cleanupScope).toHaveBeenCalledOnce();
    expect(flushLogger).toHaveBeenCalledOnce();
  });

  it.each(["failure", "restart", "clean-stop"] as const)(
    "fails closed when required cleanup is uncertain after a child %s",
    async (outcome) => {
      const stderr = "synthetic child diagnostic";
      let childExitCode = 0;
      spawn.mockImplementation(async (input: SpawnInput) => {
        input.onStderr?.(stderr);
        childExitCode =
          outcome === "restart" ? readSpawnRestartExitCode(input) : outcome === "failure" ? 23 : 0;
        return {
          cancel: vi.fn(),
          wait: async () => ({ exitCode: childExitCode, exitSignal: null, reason: "exit" }),
        };
      });
      cleanupScope.mockImplementation(async () => {
        const diagnostic = outcome === "failure" ? log.error : log.info;
        expect(diagnostic).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ exitCode: childExitCode, stderr }),
        );
        throw new Error("Process-tree cleanup is uncertain: job-unavailable");
      });

      const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
      await runWindowsGatewayTaskSupervisor();

      expect(spawn).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(1);
      expect(JSON.stringify(log.error.mock.calls)).toContain("Process-tree cleanup is uncertain");
      expect(flushLogger).toHaveBeenCalledOnce();
    },
  );

  it("replaces only a child that requests an ordinary Gateway restart", async () => {
    const firstExtinction = createDeferred();
    const cleanupEntered = createDeferred();
    const firstCleanup = vi.fn(() => {
      cleanupEntered.resolve();
      return firstExtinction.promise;
    });
    const secondCleanup = vi.fn(async () => {});
    acquireScopeCleanup.mockReturnValueOnce(firstCleanup).mockReturnValueOnce(secondCleanup);
    spawn
      .mockImplementationOnce(async (input: SpawnInput) => ({
        cancel: vi.fn(),
        wait: async () => ({
          exitCode: readSpawnRestartExitCode(input),
          exitSignal: null,
        }),
      }))
      .mockResolvedValueOnce({
        cancel: vi.fn(),
        wait: async () => ({ exitCode: 0, exitSignal: null }),
      });
    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    const running = runWindowsGatewayTaskSupervisor();
    try {
      await Promise.race([cleanupEntered.promise, running]);
      expect(firstCleanup).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledOnce();
    } finally {
      firstExtinction.resolve();
      await running;
    }

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(firstCleanup).toHaveBeenCalledOnce();
    expect(secondCleanup).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it("does not mistake a conventional temporary-failure exit for a restart request", async () => {
    spawn.mockResolvedValue({
      cancel: vi.fn(),
      wait: async () => ({ exitCode: 75, exitSignal: null, reason: "exit" }),
    });

    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    await runWindowsGatewayTaskSupervisor();

    expect(spawn).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(75);
  });

  it("does not replace a restarting child when shutdown arrives during extinction", async () => {
    let shutdown: (() => void) | undefined;
    vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => {
      if (event === "SIGTERM") {
        shutdown = listener;
      }
      return process;
    }) as typeof process.once);
    spawn.mockImplementationOnce(async (input: SpawnInput) => ({
      cancel: vi.fn(),
      wait: async () => ({
        exitCode: readSpawnRestartExitCode(input),
        exitSignal: null,
      }),
    }));

    cleanupScope.mockImplementation(async () => shutdown?.());
    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    await runWindowsGatewayTaskSupervisor();

    expect(spawn).toHaveBeenCalledOnce();
  });

  it("exits cleanly when shutdown races a child restart result", async () => {
    let shutdown: (() => void) | undefined;
    vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => {
      if (event === "SIGTERM") {
        shutdown = listener;
      }
      return process;
    }) as typeof process.once);
    spawn.mockImplementationOnce(async (input: SpawnInput) => ({
      cancel: vi.fn(),
      wait: async () => {
        shutdown?.();
        return {
          exitCode: readSpawnRestartExitCode(input),
          exitSignal: null,
        };
      },
    }));

    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    await runWindowsGatewayTaskSupervisor();

    expect(spawn).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("cancels a child when shutdown arrives while spawn is pending", async () => {
    let resolveSpawn: ((value: unknown) => void) | undefined;
    const pendingSpawn = new Promise((resolve) => {
      resolveSpawn = resolve;
    });
    const cancel = vi.fn();
    let shutdown: (() => void) | undefined;
    vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => {
      if (event === "SIGTERM") {
        shutdown = listener;
      }
      return process;
    }) as typeof process.once);
    let signalSpawnEntered: (() => void) | undefined;
    const spawnEntered = new Promise<void>((resolve) => {
      signalSpawnEntered = resolve;
    });
    spawn.mockImplementation(() => {
      signalSpawnEntered?.();
      return pendingSpawn;
    });
    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    const running = runWindowsGatewayTaskSupervisor();
    await Promise.race([spawnEntered, running]);
    expect(spawn).toHaveBeenCalledOnce();
    shutdown?.();
    resolveSpawn?.({
      cancel,
      wait: async () => ({ exitCode: 0, exitSignal: null }),
    });
    await running;

    expect(cancel).toHaveBeenCalledOnce();
  });
});

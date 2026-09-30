import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { RunManagedCommandOptions } from "../../scripts/lib/managed-child-process.mjs";
import { createDeferred } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const native = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../../scripts/lib/managed-child-process.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-child-process.mjs")>()),
  runManagedCommand: native.command,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  native.command.mockReset();
});

it.each(["complete", "unjoined-vm"])(
  "preserves safe native observations and ownership for %s",
  async (scenario) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.resetModules();
    const directory = realpathSync(tempDirs.make("ios-setup-host-"));
    chmodSync(directory, 0o700);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const signals = new EventEmitter();
    const modulePath = fileURLToPath(
      new URL("../../scripts/lib/ios-release-setup-host.ts", import.meta.url),
    );
    const childProcess = Object.defineProperties(Object.create(process), {
      platform: { value: "darwin" },
      argv: { value: [process.execPath, modulePath, "--probe-child", directory, "1001", "2002"] },
      pid: { value: 1002 },
      ppid: { value: 1001 },
      stdin: { value: stdin },
      stdout: { value: stdout },
      exitCode: { value: 0, writable: true },
      umask: { value: vi.fn(() => 0o022) },
      on: { value: signals.on.bind(signals) },
      off: { value: signals.off.bind(signals) },
    });
    vi.stubGlobal("process", childProcess);
    const ready = createDeferred();
    let postBaseline = false;
    stdout.on("data", (chunk: Buffer) => {
      expect(chunk.toString()).toBe("ready\n");
      expect(JSON.parse(readFileSync(path.join(directory, "report.json"), "utf8"))).toMatchObject({
        status: "running",
        cleanupConfirmed: false,
      });
      postBaseline = true;
      if (scenario === "complete") {
        stdin.emit("end");
      }
      ready.resolve();
    });
    const rawStack = [
      "Process: PRIVATE_PROCESS /Users/private/token",
      "Arguments: --token=PRIVATE_ARGUMENT",
      "99 pread (in PRIVATE_HEADER)",
      "Call graph:",
      "    9 Thread_123 DispatchQueue_1: com.apple.main-thread (serial)",
      "    + 6 pread (in libsystem_kernel.dylib) + 4 [0x1234]",
      "    +   4 sqlite3_step (in /Users/private/library.dylib) + 4 [0x2345]",
      "    +     3 v8::internal::Heap::CollectGarbage() (in node) + 8 [0x3456]",
      "    + 5 preadPRIVATE_CREDENTIAL (in node) + 8 [0x4567]",
      "    2 Thread_456 PRIVATE_THREAD_NAME",
      "    + 2 __psynch_mutexwait (in libsystem_kernel.dylib) + 8 [0x5678]",
      ...Array.from(
        { length: 40 },
        (_, index) => `    1 Thread_${500 + index} PRIVATE_EXTRA_THREAD`,
      ),
      "Binary Images:",
      "99 write (in PRIVATE_FOOTER)",
    ].join("\n");
    native.command.mockImplementation(async (options: RunManagedCommandOptions) => {
      const output = new PassThrough();
      const errorOutput = new PassThrough();
      options.onReady?.(Object.assign(new ChildProcess(), { stdout: output, stderr: errorOutput }));
      if (options.bin === "/usr/bin/vm_stat") {
        if (postBaseline && scenario === "unjoined-vm") {
          throw Object.assign(new Error("PRIVATE_CREDENTIAL /Users/private/tool-failure"), {
            code: "ETIMEDOUT",
            processTreeState: "indeterminate",
            pid: 34567,
            stderr: "PRIVATE_STDERR",
          });
        }
        output.write(
          [
            "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
            "Pages free: 12.",
            "Pages active: 34.",
            "Pages occupied by compressor: 7.",
            "Swapouts: 9.",
            "Pages inactive: -1.",
            "PRIVATE_FIELD: 99.",
          ].join("\n"),
        );
      } else if (options.bin === "/usr/sbin/sysctl") {
        output.write(
          [
            "vm.swapusage: total = 2G used = 1.5M free = 2046.5M (encrypted)",
            postBaseline ? "vm.loadavg: { 9.25 8.5 7.75 }" : "vm.loadavg: { 1.25 2.5 3.75 }",
            "hw.memsize: 17179869184",
            "hw.logicalcpu: 8",
            "PRIVATE_FIELD: PRIVATE_VALUE",
          ].join("\n"),
        );
      } else if (options.bin === "/bin/ps") {
        expect(options.args?.join(" ")).not.toMatch(/\b(?:majflt|minflt|nvcsw|nivcsw)=/);
        output.write(
          [
            "1001 100 1001 1024 2048 2.5 01:02.50 Tue Sep 29 12:34:56 2026",
            "2002 1001 2002 2048 4096 5 00:03.25 Tue Sep 29 12:34:56 2026",
          ].join("\n"),
        );
      } else {
        expect(options.bin).toBe("/bin/sh");
        const rawPath = options.args?.at(-1);
        expect(rawPath).toBeDefined();
        writeFileSync(rawPath!, rawStack);
      }
      return 0;
    });

    const running = import("../../scripts/lib/ios-release-setup-host.js");
    if (scenario === "unjoined-vm") {
      await Promise.race([
        ready.promise,
        running.then(() => {
          throw new Error("sampler exited before baseline readiness");
        }),
      ]);
      stdin.write("boot\n");
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await running;

    const report = JSON.parse(readFileSync(path.join(directory, "report.json"), "utf8"));
    expect(childProcess.exitCode).toBe(scenario === "unjoined-vm" ? 75 : 0);
    expect(report).toMatchObject({
      status: scenario === "unjoined-vm" ? "failed" : "stopped",
      cleanupConfirmed: scenario === "complete",
      host: [
        {
          phase: "baseline",
          vm: "passed",
          sysctl: "passed",
          pageSizeBytes: 16384,
          freePages: 12,
          activePages: 34,
          compressorPages: 7,
          swapouts: 9,
          swapTotalBytes: 2147483648,
          swapUsedBytes: 1572864,
          swapFreeBytes: 2145910784,
          load1: 1.25,
          load5: 2.5,
          load15: 3.75,
          memoryBytes: 17179869184,
          logicalCpus: 8,
          processes: [
            {
              target: "harness",
              outcome: "passed",
              rssBytes: 1048576,
              virtualBytes: 2097152,
              cpuMs: 62500,
            },
            {
              target: "gateway",
              outcome: "passed",
              rssBytes: 2097152,
              virtualBytes: 4194304,
              cpuMs: 3250,
            },
          ],
        },
        ...(scenario === "unjoined-vm" ? [expect.objectContaining({ phase: "boot" })] : []),
      ],
    });
    expect(report.failures).toEqual(
      scenario === "unjoined-vm"
        ? [
            {
              tool: "vm-stat",
              stage: "host",
              phase: "boot",
              outcome: "unjoined",
              epochMs: expect.any(Number),
              elapsedMs: expect.any(Number),
            },
          ]
        : [],
    );
    expect(report.host[0]).not.toHaveProperty("inactivePages");
    expect(report.stacks).toHaveLength(2);
    expect(report.stacks.map((row: { target: string }) => row.target)).toEqual([
      "harness",
      "gateway",
    ]);
    for (const stack of report.stacks) {
      expect(stack).toMatchObject({
        window: "baseline",
        outcome: "passed",
        countKind: "inclusive-tree-occurrences",
        truncated: true,
      });
      expect(stack.threads).toHaveLength(32);
      expect(stack.threads.slice(0, 2)).toEqual([
        {
          index: 0,
          kind: "main",
          samples: 9,
          frames: [
            { category: "io", sampleTreeOccurrences: 6 },
            { category: "sqlite", sampleTreeOccurrences: 4 },
            { category: "gc", sampleTreeOccurrences: 3 },
            { category: "other", sampleTreeOccurrences: 5 },
          ],
        },
        {
          index: 1,
          kind: "other",
          samples: 2,
          frames: [{ category: "mutex", sampleTreeOccurrences: 2 }],
        },
      ]);
    }
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE|\/Users\/|token|0x1234|Thread_123|pread/);
    expect(readdirSync(directory)).toEqual(["report.json"]);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(signals.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    if (scenario === "unjoined-vm") {
      expect(report.host[1]).toMatchObject({
        vm: "unjoined",
        sysctl: "passed",
        swapUsedBytes: 1572864,
        load1: 9.25,
        load5: 8.5,
        load15: 7.75,
        processes: [
          { target: "harness", outcome: "passed", rssBytes: 1048576 },
          { target: "gateway", outcome: "passed", rssBytes: 2097152 },
        ],
      });
      const commandsAtFailure = native.command.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(native.command).toHaveBeenCalledTimes(commandsAtFailure);
    }
  },
);

it.each([true, false])(
  "joins cancelled sampler work and releases owned files only after confirmed cleanup (%s)",
  async (cleanupConfirmed) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.resetModules();
    vi.stubGlobal(
      "process",
      Object.defineProperties(Object.create(process), { platform: { value: "darwin" } }),
    );
    const root = tempDirs.make("ios-setup-parent-");
    const completion = createDeferred<number>();
    let reportPath = "";
    const control = new PassThrough();
    const commands: string[] = [];
    control.on("data", (chunk: Buffer) => commands.push(chunk.toString()));
    let childSignal: AbortSignal | undefined;
    native.command.mockImplementation((options: RunManagedCommandOptions) => {
      childSignal = options.signal;
      const childIndex = options.args?.indexOf("--probe-child") ?? -1;
      const directory = childIndex >= 0 ? options.args?.[childIndex + 1] : undefined;
      if (!directory) {
        throw new Error("sampler must pass its owned output directory");
      }
      reportPath = path.join(directory, "report.json");
      const output = new PassThrough();
      options.onReady?.(Object.assign(new ChildProcess(), { stdin: control, stdout: output }));
      output.write("ready\n");
      return completion.promise;
    });
    const { startIOSReleaseSetupHostProbe } =
      await import("../../scripts/lib/ios-release-setup-host.js");
    const controller = new AbortController();
    const probe = await startIOSReleaseSetupHostProbe({
      cwd: process.cwd(),
      root,
      gatewayPid: 2002,
      signal: controller.signal,
    });
    probe.markPhase("boot");
    probe.markPhase("setup-code");
    expect(commands).toEqual(["boot\n", "setup-code\n"]);
    controller.abort();
    let stopped = false;
    const stopping = probe.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(childSignal?.aborted).toBe(true);
    expect(control.writableEnded).toBe(true);
    expect(stopped).toBe(false);
    expect(readdirSync(root)).toHaveLength(1);
    const status = cleanupConfirmed ? "stopped" : "running";
    writeFileSync(path.join(path.dirname(reportPath), "sample-0.txt"), "PRIVATE_RAW_STACK");
    writeFileSync(
      reportPath,
      JSON.stringify({
        status,
        cleanupConfirmed,
        token: "PRIVATE_TOKEN",
        failures: [
          {
            tool: "vm-stat",
            stage: "host",
            phase: "setup-code",
            outcome: "timeout",
            epochMs: 105,
            elapsedMs: 6,
            error: "PRIVATE_ERROR /Users/private/failure",
          },
          {
            tool: "PRIVATE_TOOL",
            stage: "host",
            phase: "setup-code",
            outcome: "failed",
            epochMs: 106,
            elapsedMs: 7,
          },
        ],
        host: [
          {
            epochMs: 100,
            elapsedMs: 5,
            phase: "setup-code",
            vm: "passed",
            sysctl: "passed",
            rssBytes: "PRIVATE_VALUE",
            load1: 2.5,
            memoryBytes: -1,
            path: "/Users/private",
            processes: [
              {
                target: "gateway",
                outcome: "passed",
                elapsedMs: 2,
                rssBytes: 2048,
                args: "PRIVATE_ARGS",
              },
            ],
          },
        ],
        stacks: [
          {
            epochMs: 101,
            elapsedMs: 4,
            target: "gateway",
            window: "setup-code-8s",
            outcome: "passed",
            raw: "PRIVATE_STACK",
            threads: [
              {
                index: 0,
                kind: "main",
                samples: 3,
                name: "PRIVATE_THREAD",
                frames: [
                  { category: "io", sampleTreeOccurrences: 3, symbol: "PRIVATE_SYMBOL" },
                  { category: "PRIVATE_CATEGORY", sampleTreeOccurrences: 9 },
                ],
              },
            ],
          },
        ],
      }),
    );
    completion.reject(Object.assign(new Error("PRIVATE_CANCELLED"), { code: "ABORT_ERR" }));
    if (cleanupConfirmed) {
      await stopping;
    } else {
      await expect(stopping).rejects.toMatchObject({ processTreeState: "indeterminate" });
    }
    expect(probe.evidence).toEqual({
      status,
      cleanupConfirmed,
      failures: [
        {
          tool: "vm-stat",
          stage: "host",
          phase: "setup-code",
          outcome: "timeout",
          epochMs: 105,
          elapsedMs: 6,
        },
      ],
      host: [
        {
          epochMs: 100,
          elapsedMs: 5,
          phase: "setup-code",
          vm: "passed",
          sysctl: "passed",
          load1: 2.5,
          processes: [{ target: "gateway", outcome: "passed", elapsedMs: 2, rssBytes: 2048 }],
        },
      ],
      stacks: [
        {
          epochMs: 101,
          elapsedMs: 4,
          target: "gateway",
          window: "setup-code-8s",
          outcome: "passed",
          countKind: "inclusive-tree-occurrences",
          truncated: false,
          threads: [
            {
              index: 0,
              kind: "main",
              samples: 3,
              frames: [{ category: "io", sampleTreeOccurrences: 3 }],
            },
          ],
        },
      ],
    });
    expect(stopped).toBe(cleanupConfirmed);
    expect(JSON.stringify(probe.evidence)).not.toMatch(/PRIVATE|\/Users\//);
    expect(readdirSync(root)).toEqual(
      cleanupConfirmed ? [] : [path.basename(path.dirname(reportPath))],
    );
    if (!cleanupConfirmed) {
      expect(readdirSync(path.dirname(reportPath))).toEqual(["report.json"]);
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

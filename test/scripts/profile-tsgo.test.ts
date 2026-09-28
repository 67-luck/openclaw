import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { withDistArtifactOwnership } from "../../scripts/lib/dist-artifact-ownership.mts";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { isProcessAlive, waitForDead, waitForFixtureFile } from "../helpers/process-wait.js";
import { installDistArtifactScripts } from "./dist-artifact-fixture.js";
import {
  overrideNativeFixtureExecutable,
  hasSemanticTestBackend,
} from "./native-boundary-fixture.js";

const lifetime = createFixtureLifetime();
afterEach(() => lifetime.cleanup());

it.runIf(process.platform === "linux" && hasSemanticTestBackend())(
  "retains exact scope attribution and refuses another profiler after supervisor death",
  ({ signal }) =>
    lifetime.run(async () => {
      const root = fs.realpathSync(lifetime.createTempDir("openclaw-profile-crash-"));
      // The killed supervisor intentionally retains its claim. The fixture's
      // outer lifetime verifies the exact cgroup before disposing this private owner.
      const resourceOwner = createVitestResourceOwner(root);
      fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
      fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
      installDistArtifactScripts(root, ["profile-tsgo.mts"], {
        compiler: false,
        dependencies: ["@openclaw/fs-safe"],
      });
      const compiler = path.join(root, "compiler.cjs");
      fs.writeFileSync(
        compiler,
        `#!${resolveTestNodeExecPath()}
require('node:fs').appendFileSync('compiler-pids', String(process.pid) + '\\n');
setInterval(() => {}, 1000);
`,
      );
      fs.chmodSync(compiler, 0o755);
      overrideNativeFixtureExecutable(root, compiler);
      // Isolate this deliberately retained owner from the worker account's real
      // admission slot; HOME/TMPDIR must not alter production account identity.
      const account = path.join(root, "account.mjs");
      fs.writeFileSync(
        account,
        `import os from 'node:os';
const userInfo = os.userInfo.bind(os);
os.userInfo = (options) => ({ ...userInfo(options), homedir: ${JSON.stringify(root)} });
`,
      );
      const env = {
        ...process.env,
        TMPDIR: root,
        TMP: root,
        TEMP: root,
        NODE_OPTIONS: `--import=${pathToFileURL(account).href}`,
      };
      let child: ChildProcess | undefined;
      let compilerPid: number | undefined;
      let unit: string | undefined;
      const command = {
        bin: resolveTestNodeExecPath(),
        args: [path.join(root, "scripts/profile-tsgo.mts"), "ui"],
        cwd: root,
        env,
        signal,
        requireProcessTreeExit: true,
      };
      const completion = lifetime.track(
        runManagedCommand({
          ...command,
          onReady: (started) => {
            child = started;
          },
        }),
      );
      try {
        const pidFile = path.join(root, "compiler-pids");
        await waitForFixtureFile(pidFile, completion);
        compilerPid = Number(fs.readFileSync(pidFile, "utf8").trim());
        const directory = path.join(root, ".cache/openclaw/semantic-checks");
        const lockPath = path.join(directory, `${os.hostname()}.lock`);
        const ownerBytes = fs.readFileSync(lockPath, "utf8");
        const owner = JSON.parse(ownerBytes) as { scopeReceipt: string };
        unit = fs.readFileSync(path.join(directory, owner.scopeReceipt), "utf8").trim();
        expect(unit).toMatch(/^openclaw-check-[a-f0-9-]+\.scope$/u);
        child!.kill("SIGKILL");
        expect(await completion).toBe(137);
        expect(() => resourceOwner.assertReleased()).toThrow("Unreleased Vitest resource claim");
        // Use a different checkout artifact root so admission, not the crashed
        // profiler's artifact lock, is the boundary rejecting the second leaf.
        const next = path.join(root, "next.mts");
        fs.writeFileSync(
          next,
          `import { runSemanticCheck } from './scripts/lib/semantic-check-admission.mts';
try { process.exitCode = await runSemanticCheck({ bin: ${JSON.stringify(compiler)}, cwd: ${JSON.stringify(root)} }); }
catch { process.exitCode = 1; }
`,
        );
        expect(await lifetime.track(runManagedCommand({ ...command, args: [next] }))).toBe(1);
        expect(fs.readFileSync(lockPath, "utf8")).toBe(ownerBytes);
        expect(fs.readFileSync(pidFile, "utf8").trim().split("\n")).toHaveLength(1);
      } finally {
        await lifetime.verifyCleanup(async () => {
          if (child?.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          try {
            await completion;
          } finally {
            if (unit) {
              for (const args of [["kill", "--kill-whom=all", "--signal=SIGKILL"], ["stop"]]) {
                spawnSync("systemctl", ["--user", ...args, unit], { timeout: 5_000 });
              }
              const state = spawnSync(
                "systemctl",
                ["--user", "show", "--property=LoadState", "--property=ControlGroup", unit],
                { encoding: "utf8", timeout: 5_000 },
              );
              expect(state.error).toBeUndefined();
              const fields = Object.fromEntries(
                state.stdout
                  .trim()
                  .split("\n")
                  .map((line) => line.split("=")),
              );
              if (fields.LoadState !== "not-found") {
                expect(fields.ControlGroup?.endsWith("/" + unit)).toBe(true);
                expect(
                  fs.readFileSync(
                    path.join("/sys/fs/cgroup", fields.ControlGroup!, "cgroup.events"),
                    "utf8",
                  ),
                ).toMatch(/^populated 0$/mu);
              }
            }
            if (compilerPid !== undefined) await waitForDead(compilerPid, 2_000);
          }
        });
      }
    }),
);

it.runIf(process.platform === "linux" && hasSemanticTestBackend())(
  "releases profiling artifacts after canceling a compiler that requires forced termination",
  ({ signal }) =>
    lifetime.run(async () => {
      const root = fs.realpathSync(lifetime.createTempDir("openclaw-cancel-profile-"));
      fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
      fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
      installDistArtifactScripts(root, ["profile-tsgo.mts"], {
        compiler: false,
        dependencies: ["@openclaw/fs-safe"],
      });
      const compiler = path.join(root, "compiler.cjs");
      fs.writeFileSync(
        compiler,
        `#!${resolveTestNodeExecPath()}
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
require('node:fs').appendFileSync('compiler-pids', String(process.pid) + '\\n');
`,
      );
      fs.chmodSync(compiler, 0o755);
      overrideNativeFixtureExecutable(root, compiler);
      const clock = path.join(root, "supervisor-clock.mjs");
      // Accelerate every supervisor's existing grace period equally. Readiness and
      // process completion still use real pipes and OS signals, without sleeps.
      fs.writeFileSync(
        clock,
        `const now = Date.now.bind(Date), start = now();
Date.now = () => start + (now() - start) * 10;
`,
      );
      let child: ChildProcess | undefined;
      let output = "";
      let compilerPid: number | undefined;
      const completion = lifetime.track(
        runManagedCommand({
          bin: resolveTestNodeExecPath(),
          args: [path.join(root, "scripts/profile-tsgo.mts"), "ui"],
          cwd: root,
          env: {
            ...process.env,
            NODE_OPTIONS: `--import=${pathToFileURL(clock).href}`,
          },
          stdio: ["pipe", "pipe", "pipe"],
          signal,
          requireProcessTreeExit: true,
          onReady: (started) => {
            child = started;
            started.stdout!.resume();
            started.stderr!.on("data", (chunk) => {
              output += String(chunk);
            });
          },
        }),
      );
      try {
        const pidFile = path.join(root, "compiler-pids");
        await waitForFixtureFile(pidFile, completion);
        compilerPid = Number(fs.readFileSync(pidFile, "utf8").trim());
        if (!child) {
          throw new Error("Missing profile process");
        }
        child.kill("SIGTERM");
        expect(await completion, output).toBe(143);
        expect(() => process.kill(compilerPid!, 0)).toThrow();
        expect(fs.readFileSync(pidFile, "utf8").trim().split("\n")).toHaveLength(1);
        expect(fs.existsSync(path.join(root, ".artifacts/tsgo-profile/latest.json"))).toBe(false);
        expect(fs.readdirSync(path.join(root, ".artifacts/dist-artifacts.lock"))).toEqual([]);
        await withDistArtifactOwnership(root, async () => {
          fs.writeFileSync(path.join(root, "next-check"), "acquired");
        });
        expect(fs.readFileSync(path.join(root, "next-check"), "utf8")).toBe("acquired");
      } finally {
        await lifetime.verifyCleanup(async () => {
          child?.stdin?.end();
          try {
            await completion;
          } finally {
            if (compilerPid !== undefined) {
              if (isProcessAlive(compilerPid)) {
                process.kill(compilerPid, "SIGKILL");
              }
              await waitForDead(compilerPid, 2_000);
            }
          }
        });
      }
    }),
);

it
  .runIf(process.platform === "linux" && hasSemanticTestBackend())
  .for(["success", "failure", "overflow", "dense"])(
  "contains profiling compiler leaves and publishes only completed reports; mode=%s",
  (mode, { signal }) =>
    lifetime.run(async () => {
      const fail = mode === "failure" || mode === "overflow";
      const root = fs.realpathSync(lifetime.createTempDir("openclaw-profile-memory-"));
      fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
      fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
      installDistArtifactScripts(root, ["profile-tsgo.mts"], {
        compiler: false,
        dependencies: ["@openclaw/fs-safe"],
      });
      const compiler = path.join(root, "compiler.cjs");
      fs.writeFileSync(
        compiler,
        `#!${resolveTestNodeExecPath()}
const fs=require("node:fs"),path=require("node:path");
const group=fs.readFileSync("/proc/self/cgroup","utf8").trim().split("::")[1];
const max=fs.readFileSync(path.join("/sys/fs/cgroup",group,"memory.max"),"utf8").trim();
fs.appendFileSync("profile-calls", JSON.stringify({max,pid:process.pid})+"\\n");
if (${mode === "failure"}) process.exit(7);
if (${mode === "overflow"}) {
  process.stdout.write(Buffer.alloc(8 * 1024 ** 2, 120));
  process.stderr.write(Buffer.alloc(9 * 1024 ** 2, 121));
  setInterval(() => {}, 1000);
} else if(process.argv.includes("--listFilesOnly")) console.log(${mode === "dense"}
  ? ' ui/src/example.test.ts\\r\\n'.repeat(100000) + '\\nFiles: 100003\\nsrc/index.ts\\n/outside/types.d.ts\\nC:/outside/types.d.ts'
  : "ui/src/example.ts");
else console.log("Files: 1\\nMemory used: 1K\\nTotal time: 0.1s\\nCheck time: 0.1s");
`,
      );
      fs.chmodSync(compiler, 0o755);
      overrideNativeFixtureExecutable(root, compiler);
      let output = "";
      let errors = "";
      const status = await lifetime.track(
        runManagedCommand({
          bin: resolveTestNodeExecPath(),
          args: [path.join(root, "scripts/profile-tsgo.mts"), "ui", "--explain", "--json"],
          cwd: root,
          env: process.env,
          signal,
          requireProcessTreeExit: true,
          stdio: ["ignore", "pipe", "pipe"],
          onReady(child) {
            child.stdout!.setEncoding("utf8");
            child.stdout!.on("data", (chunk) => {
              output += chunk;
            });
            child.stderr!.setEncoding("utf8");
            child.stderr!.on("data", (chunk) => {
              errors += chunk;
            });
          },
        }),
      );
      const calls = fs
        .readFileSync(path.join(root, "profile-calls"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { max: string; pid: number });
      expect(status).toBe(fail ? 1 : 0);
      if (mode === "overflow") {
        expect(errors).toContain("exceeded its 16777216-byte output limit");
        expect(errors.trimEnd()).toMatch(/\[tsgo-profile\] FAILED \(exit 1\)$/u);
      }
      expect(calls).toHaveLength(fail ? 1 : 4);
      for (const call of calls) {
        expect(Number(call.max)).toBeGreaterThanOrEqual(512 * 1024 ** 2);
        expect(Number(call.max)).toBeLessThanOrEqual(8 * 1024 ** 3);
        expect(isProcessAlive(call.pid)).toBe(false);
      }
      const report = path.join(root, ".artifacts/tsgo-profile/latest.json");
      expect(fs.existsSync(report)).toBe(!fail);
      if (!fail) {
        const result = JSON.parse(output);
        expect(result.graphs[0].check.diagnostics["Memory used"]).toBe(1024);
        expect(result.graphs[0].files.totalFiles).toBe(mode === "dense" ? 100003 : 1);
        if (mode === "dense") {
          expect(result.graphs[0].files).toMatchObject({
            projectRelativeFiles: 100001,
            testFiles: 100000,
            groups: [
              { key: "ui/src", count: 100000 },
              { key: "src/index.ts", count: 1 },
            ],
          });
        }
      }
      expect(fs.readdirSync(path.join(root, ".artifacts/dist-artifacts.lock"))).toEqual([]);
    }),
);

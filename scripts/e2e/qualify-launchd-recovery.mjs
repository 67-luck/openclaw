#!/usr/bin/env node
// Runnable only in the reviewed disposable macOS qualification environment.
// Invoke with the candidate's loader:
// node scripts/e2e/qualify-launchd-recovery.mjs <checkout> <full-commit> <result.json>
import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";

const [checkoutArg, expectedCommit, resultFile] = process.argv.slice(2);
assert(resultFile && path.isAbsolute(resultFile), "provide an absolute retained result path");
const receipt = {
  candidate: expectedCommit,
  mode: "component",
  phase: "preflight",
  cases: [],
  cleanup: { resourcesSettled: false, disabledPolicyRestored: false },
  hostTeardownRequired: true,
  policyRowsRetiredByHostedJobDisposal: [],
};
await fs.mkdir(path.dirname(resultFile), { recursive: true });
await fs.writeFile(resultFile, JSON.stringify(receipt, null, 2) + "\n");
// Observe the actual synchronous membership calls, preserving their arguments,
// environment, timeout, result and fail-closed interpretation. No fixture override.
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  const result = originalSpawnSync(...args);
  const [command, argv] = args;
  const coalition =
    command === "/bin/launchctl" && argv?.[0] === "print" && argv[1]?.startsWith("pid/");
  const groups = command === "ps" && argv?.[1] === "pid=,pgid=,sess=";
  if (coalition || groups) {
    const stdout = String(result.stdout ?? "");
    (receipt.membershipObservations ??= []).push({
      command,
      argv,
      status: result.status,
      signal: result.signal,
      error: result.error ? inspect(result.error, { depth: 2 }) : undefined,
      stderr: String(result.stderr ?? ""),
      // Retain coalition identity fields only, never unrelated domain environment.
      stdout: coalition
        ? stdout
            .split("\n")
            .filter((line) => /coalition|^\s*(ID|id|type|name|state|active count)\s*=/.test(line))
            .join("\n")
        : stdout,
    });
  }
  return result;
};
syncBuiltinESMExports();
try {
  await qualify();
} catch (error) {
  receipt.error = inspect(error, { depth: 5 });
  process.exitCode = 1;
} finally {
  childProcess.spawnSync = originalSpawnSync;
  syncBuiltinESMExports();
  receipt.status = process.exitCode ? "failed" : "passed";
  await fs.writeFile(resultFile, JSON.stringify(receipt, null, 2) + "\n");
}

async function qualify() {
  assert.equal(process.platform, "darwin", "disposable macOS required");
  assert.match(expectedCommit ?? "", /^[a-f0-9]{40}$/);
  assert(resultFile && path.isAbsolute(resultFile), "provide an absolute retained result path");
  const hardware = execFileSync("/usr/sbin/sysctl", ["-n", "hw.model"], {
    encoding: "utf8",
  }).trim();
  assert(
    process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_OS === "macOS" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted",
    "requires an ephemeral GitHub-hosted macOS job; persistent VMs/self-hosted runners and operator desktops are ineligible; never forge CI markers",
  );
  const checkout = await fs.realpath(checkoutArg);
  const git = (args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  assert.equal(git(["rev-parse", "HEAD"]), expectedCommit);
  assert.equal(
    git(["status", "--porcelain", "--untracked-files=no"]),
    "",
    "candidate must be frozen/committed",
  );
  await import(pathToFileURL(path.join(checkout, "scripts/tsx.mjs")).href);
  const source = (file) => import(pathToFileURL(path.join(checkout, file)).href);
  const { installLaunchAgent, readRelocatedLaunchAgentForInstall } = await source(
    "src/daemon/launchd-install.ts",
  );
  const {
    resolveLaunchAgentPlistPath,
    resolvePreCanonicalLaunchAgentPlistPath,
    resolveLaunchAgentEnvFilePath,
    resolveLaunchAgentEnvWrapperPath,
  } = await source("src/daemon/launchd-service-files.ts");
  const { withGatewayServiceUpdateAuthority, assertGatewayServiceUpdateCurrent } = await source(
    "src/daemon/service-update-authority.ts",
  );
  const { runCommandWithTimeout } = await source("src/process/exec.ts");
  const { parseLaunchAgentEnabled } = await source("src/daemon/launchd-runtime.ts");
  const baseEnv = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG"]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  const native = async (args) => {
    const result = await runCommandWithTimeout(args, {
      baseEnv,
      timeoutMs: 120000,
      maxOutputBytes: 1024 * 1024,
    });
    assert.equal(result.termination, "exit", "native child must settle");
    return result;
  };
  const checked = async (args) => {
    const result = await native(args);
    assert.equal(result.code, 0, result.stderr || result.stdout || args[0] + " failed");
    return result.stdout;
  };
  const uid = process.getuid();
  const domain = "gui/" + uid;
  await checked(["launchctl", "print", domain]);
  const root = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP || "/tmp", "pr133215-native-"));
  const mount = path.join(root, "external");
  const image = path.join(root, "external.dmg");
  Object.assign(receipt, {
    phase: "native",
    candidate: expectedCommit,
    hardware,
    fixture: "boot-cached-original moved to external home; no external bootstrap",
    injectedFailure: "one candidate-bootstrap result; restoration uses real launchctl",
    claims: [
      "native source recovery",
      "post-bootstrap registration authority",
      "production registration directory discovery",
    ],
    excludedClaims: [
      "full Swift suite",
      "published updater",
      "actual Gateway RPC",
      "L8",
      "c064",
      "F1",
    ],
    cases: [],
    cleanup: { resourcesSettled: false, disabledPolicyRestored: false },
    hostTeardownRequired: true,
    policyRowsRetiredByHostedJobDisposal: [],
  });
  const muted = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  let attached = false;
  const unsettledLabels = new Set();
  async function waitForExit(pids) {
    const deadline = Date.now() + 15000;
    for (;;) {
      const remaining = [...pids].filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          if (error.code === "ESRCH") {
            return false;
          }
          throw error;
        }
      });
      if (remaining.length === 0) {
        return;
      }
      assert(Date.now() < deadline, "fixture processes still alive: " + remaining.join(","));
      await delay(100);
    }
  }
  async function waitForWitness(file, label, marker, formerPid) {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const witness = await fs
        .readFile(file, "utf8")
        .then(JSON.parse)
        .catch(() => null);
      const print = await native(["launchctl", "print", domain + "/" + label]);
      const pid = Number(/\bpid = (\d+)/.exec(print.stdout)?.[1]);
      if (witness && pid && witness.pid === pid && pid !== formerPid && witness.marker === marker) {
        return witness;
      }
      await delay(200);
    }
    throw new Error("restored supervision/witness did not become ready");
  }

  try {
    await fs.mkdir(mount);
    await checked([
      "hdiutil",
      "create",
      "-size",
      "128m",
      "-fs",
      "APFS",
      "-volname",
      "OpenClawRecovery",
      image,
    ]);
    await checked(["hdiutil", "attach", "-nobrowse", "-mountpoint", mount, image]);
    attached = true;
    assert.notEqual((await fs.stat(mount)).dev, (await fs.stat("/")).dev);
    for (const scenario of [
      { failure: true, revoked: false },
      { failure: true, revoked: false, mode: 0o600 },
      { failure: false, revoked: false },
      { failure: false, revoked: true },
    ]) {
      const label = "ai.openclaw.recovery-" + randomUUID();
      const home = path.join(mount, label);
      await fs.mkdir(home);
      const state = path.join(home, "state");
      const witness = path.join(home, "witness.json");
      const payload = path.join(home, "supervised.cjs");
      await fs.writeFile(
        payload,
        "require('node:fs').writeFileSync(process.env.NATIVE_WITNESS,JSON.stringify({pid:process.pid,marker:process.env.NATIVE_MARKER,args:process.argv.slice(2)}));setInterval(()=>{},1000);\n",
      );
      const env = {
        HOME: home,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_PROFILE: "default",
        OPENCLAW_LAUNCHD_LABEL: label,
      };
      const canonical = resolveLaunchAgentPlistPath(env);
      const former = resolvePreCanonicalLaunchAgentPlistPath(env, label);
      assert.notEqual(canonical, former);
      assert.equal(
        (await fs.stat(path.dirname(path.dirname(path.dirname(canonical))))).dev,
        (await fs.stat("/")).dev,
      );
      const originalArgs = {
        env,
        stdout: muted,
        programArguments: [process.execPath, payload, "old-argument"],
        environment: { HOME: home, NATIVE_WITNESS: witness, NATIVE_MARKER: "original" },
      };
      const effects = [];
      const caseReceipt = { ...scenario, effects };
      receipt.activeCase = caseReceipt;
      let updaterCurrent = true;
      let injected = false;
      const observedPids = new Set();
      unsettledLabels.add(label);
      receipt.policyRowsRetiredByHostedJobDisposal.push(label);
      try {
        await installLaunchAgent(originalArgs);
        const originalWitness = await waitForWitness(witness, label, "original", 0);
        observedPids.add(originalWitness.pid);
        await fs.mkdir(path.dirname(former), { recursive: true });
        const original = await fs.readFile(canonical);
        // These paths deliberately reside on different devices. Preserve and verify
        // the external copy before removing the boot-volume file; launchd retains
        // the already-loaded original throughout this fixture-only relocation.
        const originalMode = (await fs.stat(canonical)).mode & 0o7777;
        // The real initial install must create the login-discoverable registration.
        assert((await fs.lstat(former)).isSymbolicLink());
        assert.equal(await fs.readlink(former), canonical);
        // Remove only this fixture's verified alias to recreate the retained legacy layout.
        await fs.unlink(former);
        await fs.copyFile(canonical, former, fsConstants.COPYFILE_EXCL);
        await fs.chmod(former, originalMode);
        assert((await fs.readFile(former)).equals(original));
        assert.equal((await fs.stat(former)).mode & 0o7777, originalMode);
        await fs.unlink(canonical);
        if (scenario.mode) {
          await fs.chmod(former, scenario.mode);
        }
        const originals = await Promise.all(
          [
            former,
            resolveLaunchAgentEnvFilePath(env, label),
            resolveLaunchAgentEnvWrapperPath(env, label),
          ].map(async (file) => ({
            file,
            bytes: await fs.readFile(file),
            mode: (await fs.stat(file)).mode & 0o7777,
          })),
        );
        if (scenario.failure) {
          await checked(["launchctl", "disable", domain + "/" + label]);
        }
        const prior = await readRelocatedLaunchAgentForInstall(env, { requireEffective: true });
        assert(prior);
        const candidateArgs = {
          ...originalArgs,
          programArguments: [process.execPath, payload, "candidate-argument"],
          environment: { HOME: home, NATIVE_WITNESS: witness, NATIVE_MARKER: "candidate" },
        };
        let failure;
        try {
          await withGatewayServiceUpdateAuthority(
            () => {
              assert(updaterCurrent, "original updater revoked");
            },
            () => installLaunchAgent(candidateArgs),
            {
              nativeCommand: async (argv, options) => {
                if (argv[1] === "bootout" && !injected) {
                  const files = await fs.readdir(path.dirname(canonical));
                  const copies = files.filter(
                    (file) =>
                      file.startsWith(path.basename(canonical) + ".reconcile-") &&
                      file.endsWith(".bak"),
                  );
                  assert(copies.length > 0, "recovery must exist before unload");
                  const preserved = await Promise.all(
                    copies.map((file) => fs.readFile(path.join(path.dirname(canonical), file))),
                  );
                  assert(preserved.some((value) => value.equals(original)));
                }
                assertGatewayServiceUpdateCurrent();
                const bootstrap = argv[0] === "launchctl" && argv[1] === "bootstrap";
                if (bootstrap) {
                  assert.notEqual(
                    argv[3],
                    former,
                    "protected external bootstrap must not be retried",
                  );
                }
                effects.push({ action: argv[1], live: updaterCurrent });
                if (bootstrap && scenario.failure && !injected) {
                  injected = true;
                  return {
                    code: 5,
                    stdout: "",
                    stderr: "injected candidate activation failure",
                    signal: null,
                    killed: false,
                    termination: "exit",
                  };
                }
                const result = await runCommandWithTimeout(argv, options);
                if (bootstrap && result.code === 0 && scenario.revoked) {
                  updaterCurrent = false;
                }
                return result;
              },
            },
          );
        } catch (error) {
          failure = error;
          caseReceipt.installFailure = inspect(error, { depth: 5 });
        }
        assert.equal(Boolean(failure), scenario.failure || scenario.revoked);
        assert.equal(
          injected,
          scenario.failure,
          "intended candidate bootstrap failure must execute",
        );
        if (scenario.revoked) {
          assert.equal(updaterCurrent, false, "intended original-updater revocation must execute");
        }
        const finalWitness = await waitForWitness(
          witness,
          label,
          scenario.failure ? "original" : "candidate",
          originalWitness.pid,
        );
        observedPids.add(finalWitness.pid);
        assert.deepEqual(finalWitness.args, [
          scenario.failure ? "old-argument" : "candidate-argument",
        ]);
        const formerBytes = await fs.readFile(former).catch(() => null);
        if (scenario.failure || scenario.revoked) {
          assert(formerBytes?.equals(original));
        } else {
          assert((await fs.lstat(former)).isSymbolicLink());
          assert.equal(await fs.readlink(former), canonical);
        }
        if (scenario.failure) {
          assert((await fs.readFile(canonical)).equals(original));
          for (const saved of originals) {
            assert((await fs.readFile(saved.file)).equals(saved.bytes));
            assert.equal((await fs.stat(saved.file)).mode & 0o7777, saved.mode);
          }
          assert.equal((await fs.stat(canonical)).mode & 0o7777, originals[0].mode);
          const disabled = await checked(["launchctl", "print-disabled", domain]);
          assert.equal(parseLaunchAgentEnabled(disabled, label), false);
        }
        assert(effects.every((effect) => effect.live));
        let retryPid;
        if (scenario.failure) {
          // Recovery must leave the next ordinary install executable, without
          // manual plist removal. No injection is active for this real retry.
          await installLaunchAgent(candidateArgs);
          const retried = await waitForWitness(witness, label, "candidate", finalWitness.pid);
          retryPid = retried.pid;
          observedPids.add(retryPid);
          assert.deepEqual(retried.args, ["candidate-argument"]);
          assert((await fs.lstat(former)).isSymbolicLink());
          assert.equal(await fs.readlink(former), canonical);
        }
        let discoveredPid;
        if (!scenario.revoked) {
          // Exercise launchd's directory discovery of the production-created alias,
          // not an explicit bootstrap of its target. This is not a logout/login claim.
          const priorPid = retryPid ?? finalWitness.pid;
          await checked(["launchctl", "bootout", domain + "/" + label]);
          await waitForExit(observedPids);
          await checked(["launchctl", "bootstrap", domain, path.dirname(former)]);
          const discovered = await waitForWitness(witness, label, "candidate", priorPid);
          discoveredPid = discovered.pid;
          observedPids.add(discoveredPid);
          assert.deepEqual(discovered.args, ["candidate-argument"]);
          assert.equal(await fs.readlink(former), canonical);
        }
        receipt.cases.push({
          ...caseReceipt,
          passed: true,
          originalPid: originalWitness.pid,
          finalPid: finalWitness.pid,
          retryPid,
          discoveredPid,
          originalSha256: createHash("sha256").update(original).digest("hex"),
        });
        delete receipt.activeCase;
      } finally {
        const beforeStop = await native(["launchctl", "print", domain + "/" + label]);
        const currentPid = Number(/\bpid = (\d+)/.exec(beforeStop.stdout)?.[1]);
        if (currentPid) {
          observedPids.add(currentPid);
        } else {
          assert(
            beforeStop.code === 0 ||
              /not found|could not find service|no such process/i.test(
                beforeStop.stderr + beforeStop.stdout,
              ),
            "fixture process identity could not be inspected",
          );
        }
        const stopped = await native(["launchctl", "bootout", domain + "/" + label]);
        assert(
          stopped.code === 0 ||
            /not found|could not find service|no such process/i.test(
              stopped.stderr + stopped.stdout,
            ),
          "fixture job cleanup failed",
        );
        const remaining = await native(["launchctl", "print", domain + "/" + label]);
        assert(
          remaining.code !== 0 &&
            /not found|could not find service|no such process/i.test(
              remaining.stderr + remaining.stdout,
            ),
          "fixture job absence could not be verified",
        );
        await waitForExit(observedPids);
        // Restore this unique label's default behavior only. launchctl offers no
        // per-label deletion of the override row; the ephemeral job owns that tail.
        await checked(["launchctl", "enable", domain + "/" + label]);
        assert.equal(
          parseLaunchAgentEnabled(await checked(["launchctl", "print-disabled", domain]), label),
          true,
        );
        for (const entry of await fs.readdir(path.dirname(canonical))) {
          if (
            entry === path.basename(canonical) ||
            entry.startsWith(path.basename(canonical) + ".reconcile-")
          ) {
            await fs.unlink(path.join(path.dirname(canonical), entry));
          }
        }
        unsettledLabels.delete(label);
      }
    }
    assert.equal(git(["rev-parse", "HEAD"]), expectedCommit);
    assert.equal(git(["status", "--porcelain", "--untracked-files=no"]), "");
  } catch (error) {
    receipt.error = inspect(error, { depth: 5 });
    process.exitCode = 1;
  } finally {
    try {
      assert.equal(
        unsettledLabels.size,
        0,
        "retain mounted inputs until every fixture job and artifact is settled",
      );
      if (attached) {
        await checked(["hdiutil", "detach", mount]);
      }
      await fs.rm(root, { recursive: true });
      receipt.cleanup = { resourcesSettled: true, disabledPolicyRestored: true };
    } catch (error) {
      receipt.cleanupError = inspect(error, { depth: 5 });
      receipt.retainedRoot = root;
      receipt.unsettledLabels = [...unsettledLabels];
      process.exitCode = 1;
    }
  }
}

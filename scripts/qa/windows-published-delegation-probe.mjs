import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run } from "../../src/daemon/schtasks.installed-command.test-support.ts";
import {
  boundedEnv,
  cellEvidence,
  packageRoot,
  prefix,
  readInput,
  readPreparedCell,
  verifyPreparedInstall,
} from "../../src/daemon/schtasks.installed-package.test-support.ts";
import { redactSupportString } from "../../src/logging/diagnostic-support-redaction.ts";
import { prepareInstalledPackage } from "../lib/gateway-bench-installed-package.ts";
import { createPackagedOwnerLoader, verifyPackageMember } from "../lib/windows-repair-package.mts";

const fixture = fileURLToPath(import.meta.url);
const tsx = new URL("../tsx.mjs", import.meta.url).href;
const originalSource = "f919d94ee89a0f05b0de479e79fdd55a2925443c";
const publishedExec = {
  file: "dist/exec-B2rMqfhN.mjs",
  sha256: "770231f92f26e29004dbc7a9259ff3f99310ce543f5953c5e38b3cd87cf37f7a",
};

function recorder(file, spec) {
  const value = { scope: spec.scope, phases: [], owners: [] };
  return {
    value,
    save(phase, facts = {}) {
      value.phases.push({ phase, atMs: Date.now(), ...facts });
      writeFileSync(file, JSON.stringify(value, null, 2));
    },
    error(error) {
      return redactSupportString(String(error), { env: process.env }, { maxLength: 2_000 });
    },
  };
}

function outcome(result) {
  return {
    code: result.code,
    signal: result.signal,
    termination: result.termination,
    cleanup: result.cleanup,
    stdout: redactSupportString(result.stdout ?? "", { env: process.env }, { maxLength: 65_536 }),
    stderr: redactSupportString(result.stderr ?? "", { env: process.env }, { maxLength: 2_000 }),
  };
}

async function receive(spec) {
  const record = recorder(spec.receiverProof, spec);
  record.save("receiver-started", {
    pid: process.pid,
    parentPid: process.ppid,
    node: process.version,
  });
  try {
    let text = "";
    for await (const chunk of process.stdin) {
      text += chunk.toString();
      assert.ok(text.length <= 65_536, "Private grant exceeded its fixture bound");
    }
    const grant = JSON.parse(text);
    record.save("private-input-received");
    using load = await createPackagedOwnerLoader(spec.candidateRoot, spec.candidateTarball);
    const owner = await load(
      "update-command-executor",
      ["withDelegatedUpdateCommandExecutor"],
      record.value.owners,
    );
    record.save("candidate-owner-authenticated");
    await owner.withDelegatedUpdateCommandExecutor(
      grant,
      spec.runId,
      spec.candidateRoot,
      async (fence) => {
        fence.assertCurrent();
        record.save("candidate-callback-admitted");
      },
    );
    record.save("candidate-owner-settled");
    process.stdout.write(JSON.stringify({ admitted: true, settled: true }));
  } catch (error) {
    record.save("receiver-failed", { error: record.error(error) });
    throw error;
  }
}

async function control(spec) {
  const record = recorder(spec.controllerProof, spec);
  record.save("controller-started", { pid: process.pid });
  try {
    using load = await createPackagedOwnerLoader(spec.publishedRoot, spec.publishedTarball);
    const execFile = path.join(spec.publishedRoot, publishedExec.file);
    const binding = await verifyPackageMember(spec.publishedRoot, spec.publishedTarball, execFile);
    assert.equal(binding.sha256, publishedExec.sha256);
    // The bound 9.4 export clause names runUtf8CommandWithTimeout as i; its SDK copy is distinct.
    const { i: runUtf8CommandWithTimeout } = await import(pathToFileURL(execFile).href);
    assert.equal(typeof runUtf8CommandWithTimeout, "function");
    record.value.owners.push({ ...binding, exports: { runUtf8CommandWithTimeout: "i" } });
    const owner = await load(
      "update-command-executor",
      ["withUpdateCommandExecutor", "withUpdateCommandExecutorChild"],
      record.value.owners,
    );
    record.save("published-owners-authenticated");
    const worker = path.join(spec.candidateRoot, "dist/infra/update-migrated-finalize.worker.js");
    const workerBinding = await verifyPackageMember(
      spec.candidateRoot,
      spec.candidateTarball,
      worker,
    );
    record.value.owners.push(workerBinding);
    const probe = await runUtf8CommandWithTimeout([process.execPath, worker, "--check"], {
      cwd: spec.candidateRoot,
      baseEnv: {},
      env: { ...process.env, OPENCLAW_UPDATE_IN_PROGRESS: "1" },
      timeoutMs: 30_000,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
      killGraceMs: 500,
      maxOutputBytes: 64 * 1024,
    });
    record.save("capability-probe-returned", { outcome: outcome(probe) });
    const contract = JSON.parse(probe.stdout);
    assert.equal(probe.termination, "exit");
    assert.equal(probe.code, 0);
    assert.equal(probe.cleanup, "normal");
    assert.equal(contract.executorDelegation, "pid-start-v1");
    record.save("capability-contract-accepted");
    await owner.withUpdateCommandExecutor(spec.runId, async (executor) => {
      const fence = await executor.enter(spec.candidateRoot);
      record.save("published-parent-admitted");
      // Preserve the published two-argument child API and its real beforeInput binding.
      const child = await owner.withUpdateCommandExecutorChild(fence, async (grant, bindChild) => {
        record.save("published-child-grant-created", {
          parentVersion: grant.parent.version,
          parentIdentity: grant.parent.executor,
          helperIdentity: grant.parent.helper,
        });
        const result = await runUtf8CommandWithTimeout(
          [process.execPath, "--import", tsx, fixture, "--receiver", spec.specPath],
          {
            cwd: spec.candidateRoot,
            baseEnv: {},
            env: process.env,
            input: JSON.stringify(grant),
            beforeInput(pid) {
              record.save("before-child-bind", { pid });
              bindChild(pid);
              record.save("published-child-bound", { pid });
            },
            timeoutMs: 60_000,
            killProcessTree: true,
            requireProcessTreeExtinction: true,
            killGraceMs: 500,
            maxOutputBytes: 64 * 1024,
          },
        );
        record.save("published-child-command-returned", { outcome: outcome(result) });
        return result;
      });
      record.save("published-child-owner-settled");
      assert.equal(child.code, 0);
      assert.equal(child.termination, "exit");
      assert.equal(child.cleanup, "normal");
      assert.deepEqual(JSON.parse(child.stdout), { admitted: true, settled: true });
      fence.assertCurrent();
    });
    record.save("published-parent-settled");
  } catch (error) {
    record.save("controller-failed", { error: record.error(error) });
    throw error;
  }
}

async function main(inputPath) {
  const input = await readInput(inputPath);
  assert.equal(input.sourceSha, originalSource);
  const prepared = await readPreparedCell(inputPath, input, "2026.9.4");
  const publishedPrefix = prefix(input, "2026.9.4");
  await verifyPreparedInstall(prepared, "2026.9.4", publishedPrefix);
  const published = input.published.find((item) => item.version === "2026.9.4");
  assert.ok(published);
  const evidence = cellEvidence(inputPath, "2026.9.4");
  const root = path.join(input.stateRoot, "delegation-compatibility");
  const candidatePrefix = path.join(input.installRoot, "delegation-candidate");
  await fs.mkdir(root);
  await fs.mkdir(candidatePrefix);
  const env = boundedEnv(root, candidatePrefix);
  for (const name of ["appdata", "local-appdata", "tmp", "npm-cache"]) {
    await fs.mkdir(path.join(root, name));
  }
  await fs.writeFile(path.join(root, "npmrc"), "");
  await fs.writeFile(path.join(root, "global-npmrc"), "");
  const spec = {
    scope:
      "Published 9.4 capability and live delegation only; no update, Doctor or service activation",
    runId: randomUUID(),
    toolingSha: input.toolingSha,
    candidate: input.candidate,
    candidateRoot: packageRoot(candidatePrefix),
    candidateTarball: input.tarball,
    publishedRoot: packageRoot(publishedPrefix),
    publishedTarball: published.tarball,
    specPath: path.join(evidence, "delegation-input.json"),
    controllerProof: path.join(evidence, "delegation-controller.json"),
    receiverProof: path.join(evidence, "delegation-receiver.json"),
  };
  await fs.writeFile(spec.specPath, JSON.stringify(spec, null, 2));
  const commands = [];
  let failure;
  let cleanup;
  try {
    const npm = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
    await run(
      [
        npm,
        "install",
        "--global",
        "--prefix",
        candidatePrefix,
        "--no-audit",
        "--no-fund",
        "--ignore-scripts=false",
        input.tarball,
      ],
      env,
      root,
      commands,
    );
    await prepareInstalledPackage({ ...input, installRoot: candidatePrefix });
    await run(["--import", tsx, fixture, "--controller", spec.specPath], env, root, commands);
  } catch (error) {
    failure = redactSupportString(String(error), { env }, { maxLength: 2_000 });
  } finally {
    try {
      if (commands.length > 0 && commands.every((command) => command.joined)) {
        await fs.rm(candidatePrefix, { recursive: true });
        await fs.rm(root, { recursive: true });
        cleanup = "owned diagnostic directories removed after joined commands";
      } else {
        cleanup = "retained because command joining was not proven";
      }
    } catch (error) {
      const detail = redactSupportString(String(error), { env }, { maxLength: 2_000 });
      cleanup = `Cleanup failed: ${detail}`;
      failure = failure ? `${failure}; ${cleanup}` : cleanup;
    }
    await fs.writeFile(
      path.join(evidence, "delegation-result.json"),
      JSON.stringify(
        { ...spec, commands, failure, cleanup, fullCampaignQualified: false },
        null,
        2,
      ),
    );
  }
  assert.equal(failure, undefined, failure);
  assert.ok(commands.every((command) => command.joined));
}

const [mode, input] = process.argv.slice(2);
if (mode === "--controller" || mode === "--receiver") {
  const spec = JSON.parse(await fs.readFile(input, "utf8"));
  await (mode === "--controller" ? control(spec) : receive(spec));
} else {
  await main(mode);
}

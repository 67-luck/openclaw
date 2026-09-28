"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createFixtureInput } = require("./fixture-input.cjs");

const addonSha256 = "939156f310bd7a7d9d1db1b5249a5d135739b049c24c79fd3c201701333ddbf3";
const nodeSha256 = "23062343ad39fc79f12ae39cfb324e93a20ced5f1d342e7b850c148c022ddbca";
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const normalize = (value) => path.toNamespacedPath(path.resolve(value)).toLowerCase();
const emit = (record) => process.stderr.write(JSON.stringify(record) + "\n");

async function main() {
  const [profileFlag, profile, command, controlMode, sourceArg, globalRootArg] =
    process.argv.slice(2);
  assert.equal(process.argv.length, 8);
  assert.equal(profileFlag, "--profile");
  assert.equal(profile, "fileio-integration-control");
  assert.equal(command, "update");
  assert.ok(controlMode === "__fileio_loaded" || controlMode === "__fileio_unloaded");
  const mode = controlMode === "__fileio_loaded" ? "loaded" : "unloaded";
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.equal(process.version, "v26.8.2");
  assert.equal(sha256(await fs.readFile(process.execPath)), nodeSha256);
  const source = await fs.realpath(sourceArg);
  const bytes = await fs.readFile(source);
  assert.equal(sha256(bytes), addonSha256);
  const globalRoot = await fs.realpath(globalRootArg);
  assert.equal(path.basename(globalRoot), "node_modules");
  assert.deepEqual(await fs.readdir(globalRoot), []);
  const addon = path.join(globalRoot, "koffi.node");
  await fs.writeFile(addon, bytes, { flag: "wx" });
  // Exercise both actual census naming contracts and its bounded leaf inventory.
  for (const name of [
    `.openclaw.package-backup-${process.pid}-${Date.now()}`,
    ".openclaw.shim-backup-A1b2C3",
  ]) {
    const backup = path.join(globalRoot, name);
    await fs.mkdir(backup);
    await fs.writeFile(path.join(backup, "koffi.node"), bytes, { flag: "wx" });
    await fs.writeFile(path.join(backup, "residual.txt"), "synthetic residual\n", { flag: "wx" });
  }
  if (mode === "loaded") {
    require(addon);
  }
  const modulePresent = process.report
    .getReport()
    .sharedObjects.some((item) => normalize(item) === normalize(addon));
  assert.equal(modulePresent, mode === "loaded");
  emit({ event: "ready", mode, pid: process.pid, modulePresent, addonSha256 });
  const input = createFixtureInput(process.stdin);
  try {
    await input.read("terminal\n");
    // This is deliberately one complete published-shaped terminal response.
    // It does not claim a package upgrade or command settlement.
    process.stdout.write(
      JSON.stringify(
        {
          status: "ok",
          mode: "npm",
          reason: "synthetic-fileio-control",
          durationMs: 0,
          before: { version: "0.0.0-control" },
          after: { version: "0.0.0-control" },
          steps: [],
        },
        null,
        2,
      ) + "\n",
    );
    await input.read("observe\n");
    const beganAt = new Date().toISOString();
    let unlinkCode = null;
    try {
      await fs.unlink(addon);
    } catch (error) {
      assert.ok(error instanceof Error && typeof error.code === "string");
      unlinkCode = error.code;
    }
    emit({
      event: "result",
      mode,
      pid: process.pid,
      modulePresent,
      beganAt,
      endedAt: new Date().toISOString(),
      operation: "unlink",
      target: "koffi.node",
      unlinkCode,
    });
    assert.equal(unlinkCode, mode === "loaded" ? "EPERM" : null);
    assert.equal(sha256(await fs.readFile(source)), addonSha256);
    await input.read("release\n");
  } finally {
    await input.close();
  }
}

main().catch(() => {
  emit({ event: "fixture-failed", observation: "insufficient-evidence" });
  process.exitCode = 1;
});

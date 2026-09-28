"use strict";

// Child fixture only. The existing command owner owns deadline and cleanup.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createFixtureInput } = require("./fixture-input.cjs");

const addonSha256 = "939156f310bd7a7d9d1db1b5249a5d135739b049c24c79fd3c201701333ddbf3";
const nodeSha256 = "23062343ad39fc79f12ae39cfb324e93a20ced5f1d342e7b850c148c022ddbca";
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const normalize = (value) => path.toNamespacedPath(path.resolve(value)).toLowerCase();
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");

async function main() {
  const [mode, sourceArg, fixtureParentArg, lifetimeMode] = process.argv.slice(2);
  assert.equal(process.argv.length, 6);
  assert.ok(lifetimeMode === "hold" || lifetimeMode === "early-exit");
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.equal(process.version, "v26.8.2");
  assert.ok(mode === "loaded" || mode === "unloaded");
  assert.equal(sha256(await fs.readFile(process.execPath)), nodeSha256);
  const source = await fs.realpath(sourceArg);
  const sourceBytes = await fs.readFile(source);
  assert.equal(sha256(sourceBytes), addonSha256);
  const fixtureParent = await fs.realpath(fixtureParentArg);
  assert.equal(path.basename(fixtureParent).toLowerCase(), "fileio-probe");
  const root = await fs.mkdtemp(path.join(fixtureParent, "owned-addon-attribution-"));
  // Emitted before writes/load so the owner can retain cleanup custody on failure.
  emit({ event: "created", mode, root, pid: process.pid });
  const addon = path.join(root, "koffi.node");
  await fs.writeFile(addon, sourceBytes, { flag: "wx" });
  const canonicalAddon = await fs.realpath(addon);
  if (mode === "loaded") {
    require(canonicalAddon);
  }
  const modulePresent = process.report
    .getReport()
    .sharedObjects.some((value) => normalize(value) === normalize(canonicalAddon));
  assert.equal(modulePresent, mode === "loaded");
  emit({ event: "ready", mode, root, pid: process.pid, modulePresent, addonSha256 });

  // The owner starts observation, captures native PID/start identity, then sends
  // exactly "observe\n". No fixture-side timeout, retry, preload, or forced exit.
  const commands = createFixtureInput(process.stdin);
  try {
    await commands.read("observe\n");
    const beganAt = new Date().toISOString();
    let unlinkCode = null;
    try {
      // One native deletion attempt gives the observer a simple known operation.
      // It intentionally does not duplicate the historical recursive-rm retries.
      await fs.unlink(canonicalAddon);
    } catch (error) {
      assert.ok(error instanceof Error && typeof error.code === "string");
      unlinkCode = error.code;
    }
    assert.equal(sha256(await fs.readFile(source)), addonSha256);
    emit({
      event: "result",
      mode,
      root,
      pid: process.pid,
      modulePresent,
      beganAt,
      endedAt: new Date().toISOString(),
      operation: "unlink",
      target: "koffi.node",
      unlinkCode,
      interpretation: "Fixture operation only; JavaScript error is not native NTSTATUS",
    });
    assert.equal(unlinkCode, mode === "loaded" ? "EPERM" : null);
    if (lifetimeMode === "hold") {
      await commands.read("release\n");
    }
  } finally {
    await commands.close();
  }
}

main().catch(() => {
  // Do not echo arbitrary paths, loader messages, or inherited environment.
  emit({ event: "fixture-failed", observation: "insufficient-evidence" });
  process.exitCode = 1;
});

"use strict";

const assert = require("node:assert/strict");
const { createFixtureInput } = require("./fixture-input.cjs");

async function main() {
  assert.equal(process.argv.length, 2);
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.equal(process.version, "v26.8.2");
  const input = createFixtureInput(process.stdin);
  try {
    process.stdout.write("lifetime-ready\n");
    await input.read("terminal\n");
    process.stdout.write("lifetime-terminal\n");
    await input.read("release\n");
  } finally {
    await input.close();
  }
}

main().catch(() => {
  process.exitCode = 1;
});

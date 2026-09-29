"use strict";

const assert = require("node:assert/strict");
const { createFixtureInput } = require("./fixture-input.cjs");

async function main() {
  assert.equal(process.argv.length, 2);
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.equal(process.version, "v26.8.2");
  const input = createFixtureInput(process.stdin);
  const failures = [];
  try {
    process.stdout.write("lifetime-ready\n");
    try {
      await input.read("terminal\n");
    } catch (error) {
      let category = "other";
      if (
        error instanceof assert.AssertionError &&
        error.code === "ERR_ASSERTION" &&
        error.operator === "strictEqual"
      ) {
        if (
          error.expected === "terminal\n" &&
          typeof error.actual === "string" &&
          error.actual !== error.expected
        ) {
          category = error.actual === "\uFEFFterminal\n" ? "bom-prefix" : "mismatch";
        } else if (
          error.actual === true &&
          error.expected === false &&
          error.message.startsWith("Fixture command missing before EOF\n")
        ) {
          category = "eof";
        }
      }
      try {
        process.stdout.write(`lifetime-terminal-failure:${category}\n`);
      } catch (markerFailure) {
        throw new AggregateError([error, markerFailure], "Terminal failure marker write failed", {
          cause: markerFailure,
        });
      }
      throw error;
    }
    process.stdout.write("lifetime-terminal\n");
    await input.read("release\n");
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await input.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures);
  }
}

main().catch(() => {
  process.exitCode = 1;
});

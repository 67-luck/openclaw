"use strict";
const assert = require("node:assert/strict");

function createFixtureInput(stream) {
  const input = stream[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  return {
    async read(expected) {
      while (!buffered.includes(10)) {
        const next = await input.next();
        assert.equal(next.done, false, "Fixture command missing before EOF");
        assert.ok(buffered.length + next.value.length <= 32, "Fixture command byte bound");
        buffered = Buffer.concat([buffered, next.value]);
      }
      const end = buffered.indexOf(10) + 1;
      const command = buffered.subarray(0, end).toString("utf8");
      buffered = buffered.subarray(end);
      assert.equal(command, expected);
    },
    async close() {
      await input.return();
    },
  };
}

function createFixtureRelease(stream, earlyExit, onError) {
  let failed = false;
  const reportError = (error) => {
    if (!error || failed) {
      return;
    }
    failed = true;
    onError(error);
  };
  // A close can race the command owner's joined receipt. Handle both the
  // callback and error event; neither may escape the existing command owner.
  stream.on("error", reportError);
  const send = (line, end) => {
    if (end) {
      stream.end(line, reportError);
    } else {
      stream.write(line, reportError);
    }
  };
  let observed = false;
  let released = false;
  const observe = () => {
    if (observed || failed) {
      return;
    }
    send("observe\n", earlyExit);
    observed = true;
    released = earlyExit;
  };
  return {
    observe,
    release() {
      observe();
      if (released || failed) {
        return;
      }
      send("release\n", true);
      released = true;
    },
  };
}

module.exports = { createFixtureInput, createFixtureRelease };

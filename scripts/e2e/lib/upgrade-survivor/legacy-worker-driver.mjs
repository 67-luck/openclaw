import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";

// Observation only. Never intercept updater, npm, IPC, registry, or exit behavior.
if (isMainThread && process.argv[2] === "update") {
  const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
  assert(artifacts);
  const entry = fs.realpathSync(process.argv[1]);
  let root = path.dirname(entry);
  while (!fs.existsSync(path.join(root, "package.json"))) {
    assert.notEqual(root, path.dirname(root));
    root = path.dirname(root);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "openclaw");
  const identity = {
    pid: process.pid,
    parentPid: process.ppid,
    timeOriginUnixMs: performance.timeOrigin,
    entry,
    relativeEntry: path.relative(root, entry),
    root,
    entrySha256: createHash("sha256").update(fs.readFileSync(entry)).digest("hex"),
    version: manifest.version,
    buildInfo: JSON.parse(fs.readFileSync(path.join(root, "dist/build-info.json"), "utf8")),
    args: process.argv.slice(2),
    postCore: process.env.OPENCLAW_UPDATE_POST_CORE === "1",
  };
  const file = path.join(artifacts, "legacy-worker-driver-" + process.pid);
  fs.writeFileSync(file + "-started.json", JSON.stringify(identity, null, 2) + "\n", {
    flag: "wx",
  });
  process.once("exit", (exitCode) => {
    fs.writeFileSync(
      file + "-exited.json",
      JSON.stringify({ ...identity, exitCode }, null, 2) + "\n",
      { flag: "wx" },
    );
  });
}

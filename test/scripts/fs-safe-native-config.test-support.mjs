import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Manual proof branch: application bytes are pinned independently of this harness commit.
const sourceBase = "6f6d3e3915074cd0ad37ed809a970630d02e1e7c";
const expectedApplicationTreeSha256 =
  "98d4d6851b578813c2cca014d0bccd72181dabaa2a7b6ec433c7f42fcad18cf1";
const proofPaths = [
  Buffer.from("test/scripts/fs-safe-native-config.test-support.mjs"),
  Buffer.from("test/scripts/fs-safe-native-observation-proof.test.ts"),
];
const expectedSourceHashes = {
  "src/config/source-file.ts": "eb1635b3c5e65d31e7753c073a63ed0170c64f8188e0b7525e259e8280650bd3",
  "src/config/source-file-roots.ts":
    "ad3423d36fbc0ee22fbe1b742e47d74f8ebce091a7657e7dc55faff4f95d8113",
  "src/config/source-file-stability.ts":
    "0913bc9c913c83afde5f26c46505acd469a6efdcaefe3702610344eb73f8752c",
  "src/infra/fs-observation-root.ts":
    "7b0110c5f38ae5921f596fed75f9113f02eba447171ce86d6cd968c5b5ec8991",
  "src/infra/fs-observation-snapshot.ts":
    "ab7850b40ebb56a9f4d3ca081d275c593e84d4ed4d0bd93604e0c5c3409100be",
  "src/infra/fs-observation-mode.ts":
    "cbd92b087d427bfe32bb1c5aecfb665c3acad372476acd7cf4eaf45df4416e69",
  "package.json": "50aae0f39f71e0781c8a5f47923e38d9ee4056c83154d88f17d22467a56f2ba1",
  "pnpm-lock.yaml": "510ee0dd1f3c3d60702b6d4933abf79c01fa8650bcb00dab60b1f6a3e884cd18",
};
const cwd = await fs.realpath(process.cwd());
assert.equal(process.platform, "win32");
assert.equal(process.arch, "x64");
assert.equal(process.versions.node, "24.21.0");
assert.equal(process.versions.bun, undefined);
const proofHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function assertFrozenApplicationTree() {
  assert.equal(
    execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
    "",
    "the proof checkout must have no tracked or untracked changes",
  );
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(),
    proofHead,
    "the proof commit changed",
  );
  const tree = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  const hash = createHash("sha256");
  for (let start = 0; start < tree.length;) {
    const end = tree.indexOf(0, start);
    assert.ok(end >= start, "Git tree record is not NUL terminated");
    const record = tree.subarray(start, end);
    const separator = record.indexOf(9);
    assert.ok(separator >= 0, "Git tree record has no path separator");
    const file = record.subarray(separator + 1);
    if (!proofPaths.some((proofPath) => proofPath.equals(file))) {
      hash.update(tree.subarray(start, end + 1));
    }
    start = end + 1;
  }
  const digest = hash.digest("hex");
  assert.equal(digest, expectedApplicationTreeSha256, "the complete application tree differs");
  return digest;
}
const applicationTreeSha256 = assertFrozenApplicationTree();
const sourceHashes = {};
for (const [file, expected] of Object.entries(expectedSourceHashes)) {
  const bytes = await fs.readFile(path.join(cwd, file));
  assert.equal(sha(bytes), expected, `frozen source differs: ${file}`);
  sourceHashes[file] = sha(bytes);
}
const require = createRequire(path.join(cwd, "package.json"));
const packageFile = require.resolve("@openclaw/fs-safe/package.json");
const fsSafePackage = JSON.parse(await fs.readFile(packageFile, "utf8"));
assert.equal(fsSafePackage.version, "0.21.2");
const nativeName = "@openclaw/fs-safe-win32-x64-msvc";
const packageRequire = createRequire(packageFile);
const nativeBinary = await fs.realpath(packageRequire.resolve(nativeName));
const nativePackage = JSON.parse(
  await fs.readFile(path.join(path.dirname(nativeBinary), "package.json"), "utf8"),
);
assert.equal(nativePackage.version, "0.21.2");
const dependencyHashes = {};
for (const file of [packageFile, nativeBinary, require.resolve("@openclaw/fs-safe/watch")]) {
  dependencyHashes[file] = sha(await fs.readFile(file));
}
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
async function within(promise, label, milliseconds = 5_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(predicate, label) {
  const started = performance.now();
  while (!predicate()) {
    assert.ok(performance.now() - started < 5_000, label);
    await sleep(10);
  }
}
// openclaw-temp-dir: allow this standalone process verifies its own joined fixture removal.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-native-0212-"));
const root = await fs.realpath(directory);
const primary = path.join(root, "openclaw.json");
const included = path.join(root, "include.json");
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
process.env.OPENCLAW_CONFIG_PATH = primary;
process.env.FS_SAFE_NATIVE_MODE = "require";
process.env.CHOKIDAR_USEPOLLING = "false";
process.env.CHOKIDAR_INTERVAL = "2147483647";
const changes = [];
const warnings = [];
const errors = [];
const results = [];
let adapter;
let receipt;
try {
  const { getFsSafeNativeConfig } = await import(
    pathToFileURL(require.resolve("@openclaw/fs-safe/config"))
  );
  assert.equal(getFsSafeNativeConfig().mode, "require");
  const { createConfigFileAdapter } = await import(
    pathToFileURL(path.join(cwd, "src/config/source-file.ts"))
  );
  await fs.writeFile(primary, "{}");
  await fs.writeFile(included, "{}");
  const ready = Promise.withResolvers();
  adapter = createConfigFileAdapter({
    path: primary,
    includedPaths: [included],
    includeRoots: [],
    onReady: () => ready.resolve(),
    onChange: () => changes.push(performance.now()),
    log: {
      warn(message) {
        warnings.push(message);
        ready.reject(new Error(message));
      },
      error(message) {
        errors.push(message);
        ready.reject(new Error(message));
      },
    },
  });
  adapter.start();
  await within(ready.promise, "native Config readiness did not settle");
  const readyAt = performance.now();
  const loaded = process.report.getReport().sharedObjects;
  const matchingNames = loaded.filter(
    (file) => path.basename(file).toLowerCase() === path.basename(nativeBinary).toLowerCase(),
  );
  const loadedNativePaths = await Promise.all(matchingNames.map((file) => fs.realpath(file)));
  assert.ok(
    loadedNativePaths.some((loadedPath) => path.relative(nativeBinary, loadedPath) === ""),
    "the exact fs-safe 0.21.2 native addon must be loaded",
  );
  async function mutate(label, operation) {
    const previous = changes.length;
    const started = performance.now();
    await operation();
    await until(() => changes.length > previous, `${label} was not observed`);
    results.push({ label, latencyMs: changes[previous] - started });
    let count = changes.length;
    let quietSince = performance.now();
    await until(() => {
      if (changes.length !== count) {
        count = changes.length;
        quietSince = performance.now();
      }
      return performance.now() - quietSince >= 500;
    }, `${label} trailing events did not drain`);
  }
  await mutate("primary edit", () => fs.writeFile(primary, '{"primary":true}'));
  await mutate("include edit", () => fs.writeFile(included, '{"included":true}'));
  for (const [label, file] of [
    ["primary", primary],
    ["include", included],
  ]) {
    await mutate(`atomic ${label} replacement`, async () => {
      const stage = `${file}.stage`;
      await fs.writeFile(stage, JSON.stringify({ atomic: label }));
      await fs.rename(stage, file);
    });
  }
  const deliveryWindowMs = performance.now() - readyAt;
  assert.ok(
    deliveryWindowMs < 30_000,
    "periodic 30-second reconciliation cannot supply this event proof",
  );
  await adapter.stop();
  const closedCount = changes.length;
  await fs.writeFile(primary, '{"afterClose":true}');
  await sleep(300);
  assert.equal(changes.length, closedCount, "joined Config stop must prevent callbacks");
  assert.deepEqual(warnings, []);
  assert.deepEqual(errors, []);
  for (const [file, expected] of Object.entries(sourceHashes)) {
    assert.equal(sha(await fs.readFile(path.join(cwd, file))), expected, `source changed: ${file}`);
  }
  for (const [file, expected] of Object.entries(dependencyHashes)) {
    assert.equal(sha(await fs.readFile(file)), expected, `dependency changed: ${file}`);
  }
  assert.equal(assertFrozenApplicationTree(), applicationTreeSha256);
  receipt = {
    sourceBase,
    proofHead,
    applicationTreeSha256,
    sourceHashes,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    fsSafe: fsSafePackage.version,
    native: {
      package: nativeName,
      version: nativePackage.version,
      loaded: true,
      required: true,
      sha256: dependencyHashes[nativeBinary],
    },
    mode: "native-events-required",
    pollingIntervalMs: 2_147_483_647,
    manualReconcile: false,
    fakeTimers: false,
    results,
    deliveryWindowMs,
    postCloseCallbacks: changes.length - closedCount,
    warnings,
    errors,
    sourceVerified: true,
    dependenciesVerified: true,
  };
} finally {
  try {
    await adapter?.stop();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
await assert.rejects(fs.stat(directory), { code: "ENOENT" });
console.log(JSON.stringify({ ...receipt, joinedStop: true, ownedTempRemoved: true }, null, 2));

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { packageRoot } from "./schtasks.installed-package.test-support.js";

export async function readInstalledRetirementBaseline(task: {
  entry: string;
  installRoot: string;
}) {
  const installRoot = await fs.realpath(task.installRoot);
  const globalRoot = await fs.realpath(path.join(installRoot, "node_modules"));
  const root = await fs.realpath(packageRoot(task.installRoot));
  const comparisonKey = (value: string) => path.toNamespacedPath(value).toLowerCase();
  assert.equal(comparisonKey(globalRoot), comparisonKey(path.join(installRoot, "node_modules")));
  assert.equal(comparisonKey(root), comparisonKey(path.join(globalRoot, "openclaw")));
  const backupNamespaceBefore = (await fs.readdir(globalRoot)).filter((name) =>
    /^\.openclaw[.-](?:package|shim)-backup-/u.test(name),
  );
  assert.deepEqual(
    backupNamespaceBefore,
    [],
    "Retirement observation requires a fresh fixture prefix without prior backups",
  );
  const driverRequire = createRequire(task.entry);
  const koffiRequire = createRequire(driverRequire.resolve("koffi"));
  const nativeEntry = koffiRequire.resolve("@koromix/koffi-win32-x64");
  const nativePath = await fs.realpath(
    path.join(path.dirname(nativeEntry), "win32_x64/koffi.node"),
  );
  const relativePath = path.relative(root, nativePath);
  assert.ok(
    relativePath && !path.isAbsolute(relativePath) && !relativePath.split(path.sep).includes(".."),
    "Published addon must belong to the fixture-owned package before update",
  );
  const before = await fs.stat(nativePath, { bigint: true });
  assert.ok(before.isFile() && before.size > 0n && before.size <= 2_097_152n);
  const bytes = await fs.readFile(nativePath);
  const after = await fs.stat(nativePath, { bigint: true });
  assert.equal(before.dev, after.dev);
  assert.equal(before.ino, after.ino);
  assert.equal(before.size, after.size);
  assert.equal(before.mtimeNs, after.mtimeNs);
  assert.equal(BigInt(bytes.length), before.size);
  return {
    packageRoot: root,
    globalRoot,
    namespaceWasEmpty: true as const,
    backupNamespaceBefore,
    observedAtMs: Date.now(),
    expectedAddon: {
      relativePath,
      canonicalPath: nativePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      fileIdentity: { device: before.dev.toString(), inode: before.ino.toString() },
    },
  };
}

export type InstalledRetirementBaseline = Awaited<
  ReturnType<typeof readInstalledRetirementBaseline>
>;

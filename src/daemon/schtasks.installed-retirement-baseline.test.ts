import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readInstalledRetirementBaseline } from "./schtasks.installed-retirement-baseline.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

async function createInstalledFixture() {
  const installRoot = temporary.make("installed-addon-baseline-");
  const root = path.join(installRoot, "node_modules/openclaw");
  const koffi = path.join(root, "node_modules/koffi");
  const native = path.join(koffi, "node_modules/@koromix/koffi-win32-x64");
  await fs.mkdir(path.join(native, "win32_x64"), { recursive: true });
  for (const directory of [root, koffi, native]) {
    await fs.writeFile(path.join(directory, "package.json"), '{"main":"index.js"}');
    await fs.writeFile(
      path.join(directory, "index.js"),
      'throw new Error("Do not execute fixture modules");',
    );
  }
  const entry = path.join(root, "openclaw.mjs");
  await fs.writeFile(entry, "");
  const addon = path.join(native, "win32_x64/koffi.node");
  const bytes = Buffer.from("synthetic native file; resolution must not execute it");
  await fs.writeFile(addon, bytes);
  return { installRoot, entry, root, native, addon, bytes };
}

it("binds the actual nested installed addon bytes without executing either package", async () => {
  const fixture = await createInstalledFixture();
  const baseline = await readInstalledRetirementBaseline(fixture);
  expect(baseline.packageRoot).toBe(await fs.realpath(fixture.root));
  expect(baseline.expectedAddon).toMatchObject({
    relativePath: path.relative(fixture.root, fixture.addon),
    canonicalPath: await fs.realpath(fixture.addon),
    sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
    bytes: fixture.bytes.length,
  });
});

it("refuses a native package that resolves outside the owned installation", async () => {
  const fixture = await createInstalledFixture();
  const outside = temporary.make("external-addon-baseline-");
  await fs.rename(fixture.native, path.join(outside, "native"));
  await fs.symlink(
    path.join(outside, "native"),
    fixture.native,
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(readInstalledRetirementBaseline(fixture)).rejects.toThrow(
    "fixture-owned package before update",
  );
});

it("refuses to attribute backups already present before the observed command", async () => {
  const fixture = await createInstalledFixture();
  await fs.mkdir(path.join(fixture.installRoot, "node_modules/.openclaw.shim-backup-Ab1234"));
  await expect(readInstalledRetirementBaseline(fixture)).rejects.toThrow("without prior backups");
});

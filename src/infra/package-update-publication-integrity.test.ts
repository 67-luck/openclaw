import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { encodePackageActivationLauncher } from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import { preparePackageActivationJournal } from "./package-update-activation-prepare.js";
import * as integrity from "./package-update-integrity.js";
import { createPublicationOwner } from "./package-update-publication-owner.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";

const fixture = createPackageActivationLifetimeFixture();
let root: string;
beforeEach(() => {
  ({ root } = fixture.setup());
});
afterEach(async () => {
  try {
    await fixture.lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

async function withPublication(
  run: (owner: ReturnType<typeof createPublicationOwner>, anchor: string) => Promise<void>,
) {
  await fixture.lifetime.run(async () => {
    const f = await createPackageSwapFixture(root);
    for (const directory of [f.packageRoot, f.params.stage.packageRoot]) {
      fs.mkdirSync(path.join(directory, "payload"));
      fs.writeFileSync(path.join(directory, "payload/data"), "original bytes\n", { mode: 0o644 });
      fs.symlinkSync("data", path.join(directory, "payload/link"));
    }
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(f.packageRoot);
      const reader = integrity.createPackageIntegrityReader();
      const { anchor, journal } = await preparePackageActivationJournal({
        options: { fence, nodeRunner: process.execPath, onPrepared: () => {} },
        liveRoot: f.packageRoot,
        stageRoot: f.params.stage.packageRoot,
        launcherRoot: f.params.stage.layout.binDir,
        binDir: path.dirname(f.launcher),
        previous: await reader.tree(f.packageRoot),
        launchers: [
          {
            name: "openclaw",
            previous: encodePackageActivationLauncher(await reader.launcher(f.launcher)),
          },
        ],
      });
      await run(createPublicationOwner(anchor, journal, fence.assertCurrent), anchor);
    });
  });
}

it.skipIf(process.platform === "win32")(
  "hashes authoritative generations and reuses only intermediate and backup receipts",
  () =>
    withPublication(async (owner) => {
      const reads = new Map<string, number>();
      const open = fsp.open;
      vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (String(args[0]).endsWith("/payload/data")) {
          const stat = await handle.stat({ bigint: true });
          const key = `${stat.dev}:${stat.ino}`;
          const read = handle.read.bind(handle);
          vi.spyOn(handle, "read").mockImplementation((...readArgs) => {
            reads.set(key, (reads.get(key) ?? 0) + 1);
            return read(...readArgs);
          });
        }
        return handle;
      });
      await expect(owner.publish(false)).resolves.toMatchObject({ phase: "publication-complete" });
      expect([...reads.values()]).toEqual([1, 2]);
      await expect(owner.publish(true)).resolves.toMatchObject({ phase: "publication-complete" });
      expect([...reads.values()]).toEqual([2, 4]);
      await expect(owner.retire()).resolves.toMatchObject({ phase: "complete" });
      expect([...reads.values()]).toEqual([2, 5]);
    }),
);

const mutations = {
  bytes: (file: string) => {
    const stat = fs.statSync(file);
    fs.writeFileSync(file, "modified bytes\n");
    fs.utimesSync(file, stat.atime, stat.mtime);
  },
  replacement: (file: string) => {
    const replacement = path.join(root, "replacement");
    fs.writeFileSync(replacement, fs.readFileSync(file), { mode: 0o644 });
    fs.renameSync(replacement, file);
  },
  addition: (file: string) => fs.writeFileSync(path.join(path.dirname(file), "added"), "extra"),
  removal: (file: string) => fs.unlinkSync(file),
  mode: (file: string) => fs.chmodSync(file, 0o600),
  symlink: (file: string) => {
    const link = path.join(path.dirname(file), "link");
    fs.unlinkSync(link);
    fs.symlinkSync("../package.json", link);
  },
};

it.skipIf(process.platform === "win32")(
  "rehashes the live candidate before completion even when its receipt reports unchanged",
  () =>
    withPublication(async (owner, anchor) => {
      const create = integrity.createPackageIntegrityReader;
      const unchanged = vi.fn(async () => true);
      vi.spyOn(integrity, "createPackageIntegrityReader").mockImplementation((...args) => ({
        ...create(...args),
        treeUnchanged: unchanged,
      }));
      await expect(
        owner.publish(false, () => mutations.bytes(path.join(anchor, "candidate/payload/data"))),
      ).rejects.toThrow("Package publication object changed:");
      expect(unchanged).toHaveBeenCalled();
      expect(fs.existsSync(path.join(anchor, "candidate"))).toBe(false);
      expect(owner.status().phase).toBe("publishing");
    }),
);

it.skipIf(process.platform === "win32")(
  "rechecks visited files before promoting the candidate",
  () =>
    withPublication(async (owner, anchor) => {
      const candidate = path.join(anchor, "candidate");
      let changed = false;
      await expect(
        owner.publish(false, () => {
          const lstat = fsp.lstat;
          vi.spyOn(fsp, "lstat").mockImplementation(async (...args) => {
            const stat = await lstat(...args);
            if (!changed && args[0] === path.join(candidate, "payload/link")) {
              changed = true;
              fs.writeFileSync(path.join(candidate, "payload/data"), "modified bytes\n");
            }
            return stat;
          });
        }),
      ).rejects.toThrow("Package publication object changed:");
      expect(changed).toBe(true);
      expect(fs.existsSync(candidate)).toBe(true);
    }),
);

it
  .skipIf(process.platform === "win32")
  .each(
    (["candidate", "previous"] as const).flatMap((generation) =>
      Object.entries(mutations).map(([name, mutate]) => ({ generation, name, mutate })),
    ),
  )("refuses $generation $name changes after displacement", ({ generation, mutate }) =>
  withPublication(async (owner, anchor) => {
    await expect(
      owner.publish(false, () => {
        mutate(path.join(anchor, generation, "payload/data"));
      }),
    ).rejects.toThrow("Package publication object changed:");
    expect(owner.status().phase).toBe("publishing");
    expect(fs.existsSync(path.join(anchor, "candidate"))).toBe(true);
  }),
);

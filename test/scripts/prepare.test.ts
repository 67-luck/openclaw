import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { preparePackageManifest, restorePackageManifest } from "../../scripts/package-manifest.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["source", "dependency-stage", "published"])(
  "runs the prepare lifecycle in a %s checkout",
  async (layout) => {
    const root = tempDirs.make("openclaw-prepare-");
    const sourceManifest = JSON.parse(readFileSync("package.json", "utf8"));
    const manifest = JSON.stringify({ scripts: { prepare: sourceManifest.scripts.prepare } });
    writeFileSync(join(root, "package.json"), manifest);
    const scripts = ["scripts/prepare-git-hooks.mjs"];
    if (layout === "published") {
      await preparePackageManifest(root);
    } else {
      scripts.push("scripts/prepare.mjs");
    }
    if (layout === "source") {
      scripts.push("scripts/generate-kysely-types.mts", "scripts/lib/direct-run.mjs");
      mkdirSync(join(root, "src/state"), { recursive: true });
      for (const schema of ["openclaw-state", "openclaw-agent"]) {
        writeFileSync(
          join(root, "src/state", `${schema}-schema.sql`),
          "CREATE TABLE records (id INTEGER PRIMARY KEY, title TEXT NOT NULL);",
        );
      }
    }
    for (const script of scripts) {
      mkdirSync(dirname(join(root, script)), { recursive: true });
      copyFileSync(script, join(root, script));
    }

    const result = spawnSync(process.execPath, ["--run", "prepare"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    if (layout === "source") {
      for (const schema of ["openclaw-state", "openclaw-agent"]) {
        expect(
          readFileSync(join(root, ".artifacts/kysely", `${schema}-db.generated.ts`), "utf8"),
        ).toContain("export interface Records");
      }
    } else {
      expect(existsSync(join(root, ".artifacts/kysely"))).toBe(false);
    }
    if (layout === "published") {
      await restorePackageManifest(root);
      expect(readFileSync(join(root, "package.json"), "utf8")).toBe(manifest);
    }
  },
);

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function createToolingDependencyFixture(root: string, staleAncestor = false) {
  const checkout = join(root, "checkout");
  const tooling = join(root, "tooling #root");
  const lib = join(checkout, "scripts", "lib");
  mkdirSync(lib, { recursive: true });
  for (const directory of [checkout, tooling]) {
    for (const args of [
      ["init", "--quiet", directory],
      ["-C", directory, "remote", "add", "origin", "https://github.com/openclaw/openclaw.git"],
    ]) {
      const result = spawnSync("git", args, { encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(result.stderr);
      }
    }
  }
  for (const name of ["tsx-cli-shim.mjs", "tooling-dependencies.mjs", "local-check-runtime.mts"]) {
    copyFileSync(resolve("scripts/lib", name), join(lib, name));
  }
  for (const name of ["tsx.mjs", "crabbox-wrapper.mjs"]) {
    copyFileSync(resolve("scripts", name), join(checkout, "scripts", name));
  }
  writeFileSync(
    join(checkout, "package.json"),
    JSON.stringify({
      devDependencies: { tsx: "1.0.0", "fixture-pkg": "1.0.0", "private-pkg": "1.0.0" },
    }),
  );
  function writePackage(
    name: string,
    source: string,
    version = "1.0.0",
    owner = tooling,
    subpaths: Record<string, string> = {},
  ) {
    const directory = join(owner, "node_modules", name);
    mkdirSync(directory, { recursive: true });
    const exports: Record<string, string> =
      name === "tsx" ? { "./esm": "./index.mjs" } : { ".": "./index.mjs" };
    for (const [subpath, subpathSource] of Object.entries(subpaths)) {
      exports[subpath] = `${subpath}.mjs`;
      writeFileSync(join(directory, `${subpath}.mjs`), subpathSource);
    }
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name, version, type: "module", exports }),
    );
    writeFileSync(join(directory, "index.mjs"), source);
    return directory;
  }
  // Exercise the preload contract without installing a compiler in the fixture.
  writePackage("tsx", 'process.env.TOOLING_FIXTURE_PRELOADED = "1";');
  const packageRoot = writePackage(
    "fixture-pkg",
    'export default "qualified"; export { default as privateValue } from "private-pkg";',
  );
  writePackage("private-pkg", 'export default "root";');
  writePackage("private-pkg", 'export default "private";', "2.0.0", packageRoot);
  if (staleAncestor) {
    writePackage(
      "fixture-pkg",
      'export default "stale ancestor"; export const privateValue = "private";',
      "0.0.0-stale",
      root,
    );
  }
  writeFileSync(
    join(checkout, "scripts/crabbox-wrapper.mts"),
    `import assert from "node:assert/strict";
import value, { privateValue } from "fixture-pkg";
assert.equal(value, "qualified");
assert.equal(privateValue, "private");
assert.equal(process.env.TOOLING_FIXTURE_PRELOADED, "1");
assert.equal(process.env.TSX_DISABLE_CACHE, "1");
assert.equal(process.argv[2], "--help");
console.log("qualified bootstrap OK");
`,
  );
  writeFileSync(
    join(checkout, "scripts/ordinary.mjs"),
    'import { runTsxCliShim } from "./lib/tsx-cli-shim.mjs"; await runTsxCliShim(import.meta.url, { implementation: "./crabbox-wrapper.mts" });',
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: "",
    NODE_PATH: "",
    OPENCLAW_PR_TOOLING_ROOT: tooling,
  };
  for (const name of [
    "PNPM_CONFIG_MODULES_DIR",
    "pnpm_config_modules_dir",
    "npm_config_modules_dir",
    "OPENCLAW_PR_GIT",
    "TOOLING_FIXTURE_PRELOADED",
  ]) {
    delete env[name];
  }
  return {
    checkout,
    tooling,
    writePackage,
    run: (entrypoint = "crabbox-wrapper.mjs") =>
      spawnSync(process.execPath, [join(checkout, "scripts", entrypoint), "--help"], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 10_000,
      }),
  };
}

export function createToolingWorkspaceFixture(root: string, staleAncestor = false) {
  const fixture = createToolingDependencyFixture(root, staleAncestor);
  const workspace = join(fixture.checkout, "packages", "fixture");
  const donor = join(fixture.tooling, "packages", "fixture");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(donor, "node_modules"), { recursive: true });
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({
      name: "@fixture/workspace",
      type: "module",
      exports: "./index.mjs",
      dependencies: { "fixture-pkg": "2.0.0", "workspace-only": "1.0.0" },
    }),
  );
  // The donor's manifest and source are not the dependency contract.
  writeFileSync(join(donor, "package.json"), JSON.stringify({ dependencies: {} }));
  writeFileSync(join(donor, "index.mjs"), 'throw new Error("DONOR SOURCE EXECUTED");');
  const installed = fixture.writePackage(
    "fixture-pkg",
    'export default "workspace"; export { default as privateValue } from "private-pkg";',
    "2.0.0",
    join(fixture.tooling, "node_modules", ".pnpm", "fixture-pkg@2.0.0"),
  );
  fixture.writePackage("private-pkg", 'export default "workspace private";', "3.0.0", installed);
  const workspaceOnly = fixture.writePackage(
    "workspace-only",
    'export default "workspace only";',
    "1.0.0",
    join(fixture.tooling, "node_modules", ".pnpm", "workspace-only@1.0.0"),
  );
  for (const [name, target] of [
    ["fixture-pkg", installed],
    ["workspace-only", workspaceOnly],
  ] as const) {
    symlinkSync(
      target,
      join(donor, "node_modules", name),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  writeFileSync(
    join(workspace, "index.mjs"),
    `import assert from "node:assert/strict";
import value, { privateValue } from "fixture-pkg";
import only from "workspace-only";
assert.equal(value, "workspace");
assert.equal(privateValue, "workspace private");
assert.equal(only, "workspace only");
export default "current source";
`,
  );
  writeFileSync(
    join(fixture.checkout, "scripts/crabbox-wrapper.mts"),
    `import assert from "node:assert/strict";
import value from "fixture-pkg";
import source from "../packages/fixture/index.mjs";
assert.equal(value, "qualified");
assert.equal(source, "current source");
console.log("workspace bootstrap OK");
`,
  );
  return { ...fixture, workspace, donor, installed };
}

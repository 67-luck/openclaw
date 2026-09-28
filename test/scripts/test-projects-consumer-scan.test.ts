import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hasImportGraphConsumers } from "../../scripts/test-projects.test-support.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv, writeJsonFile } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
});

it.each([
  { kind: "runtime", runtimeOnly: true, expected: true },
  { kind: "type", runtimeOnly: true, expected: false },
  { kind: "type", runtimeOnly: false, expected: true },
  { kind: "literal", runtimeOnly: false, expected: false },
])(
  "bounds broad consumer scans without changing $kind admission (runtimeOnly=$runtimeOnly)",
  ({ kind, runtimeOnly, expected }) => {
    const cwd = tempDirs.make("test-projects-consumers-");
    const targets = Array.from({ length: 350 }, (_, index) => `src/owner/subject-${index}.ts`);
    fs.mkdirSync(path.join(cwd, "src/owner"), { recursive: true });
    for (const file of [...targets, "src/owner/probe.ts"]) {
      fs.writeFileSync(
        path.join(cwd, file),
        "export const value = 1; export type Value = number;\n",
      );
    }
    writeJsonFile(path.join(cwd, "tsconfig.json"), {
      compilerOptions: { baseUrl: ".", paths: { "@fixture/*": ["src/owner/*"] } },
    });
    const consumer = (name: string) => {
      const specifier = `@fixture/${name}.js`;
      if (kind === "type") {
        return `import type { Value } from "${specifier}"; export type Result = Value;\n`;
      }
      if (kind === "literal") {
        return `export const text = 'import { value } from "${specifier}"';\n`;
      }
      return `export { value } from "${specifier}";\n`;
    };
    fs.writeFileSync(path.join(cwd, "src/narrow-consumer.ts"), consumer("probe"));
    fs.writeFileSync(path.join(cwd, "src/broad-consumer.ts"), consumer("subject-349"));
    const env = createNestedGitEnv();
    for (const key of Object.keys(process.env).filter((key) => key.startsWith("GIT_"))) {
      if (!(key in env)) {
        vi.stubEnv(key, undefined);
      }
    }
    for (const args of [
      ["init", "--quiet"],
      ["add", "."],
    ]) {
      const result = childProcess.spawnSync("git", args, { cwd, env, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
    const spawn = vi.spyOn(childProcess, "spawnSync");
    syncBuiltinESMExports();
    const grepCalls = () =>
      spawn.mock.calls.filter(([command, args]) => command === "git" && args?.[0] === "grep");
    const options = { tooling: true, resolveAliases: true, runtimeOnly };

    expect(hasImportGraphConsumers(["src/owner/probe.ts"], cwd, options)).toBe(expected);
    expect(grepCalls()).toHaveLength(1);
    spawn.mockClear();
    expect(hasImportGraphConsumers(targets, cwd, options)).toBe(expected);
    expect(grepCalls()).toHaveLength(0);
  },
);

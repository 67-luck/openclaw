import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { compileFunction } from "node:vm";
import { parse } from "acorn";
import { describe, expect, it } from "vitest";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { resolveDiagnosticProcessEnv } from "../../src/infra/process-env.js";

const routing = {
  Path: "C:\\Windows\\System32",
  PATHEXT: ".EXE;.COM",
  SystemRoot: "C:\\Windows",
  WINDIR: "C:\\Windows",
  ComSpec: "C:\\Windows\\System32\\cmd.exe",
  TEMP: "C:\\synthetic\\temp",
  TMP: "C:\\synthetic\\tmp",
  USERPROFILE: "C:\\Users\\synthetic",
  APPDATA: "C:\\Users\\synthetic\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\synthetic\\AppData\\Local",
  SYSTEMDRIVE: "C:",
  HOMEDRIVE: "C:",
  HOMEPATH: "\\Users\\synthetic",
  ProgramW6432: "C:\\Program Files",
  COMMONPROGRAMW6432: "C:\\Program Files\\Common Files",
};
const forbidden = {
  OPENAI_API_KEY: "synthetic-secret-canary",
  AWS_SECRET_ACCESS_KEY: "synthetic-cloud-secret-canary",
  NODE_OPTIONS: "--require=synthetic-injection",
  PSModulePath: "C:\\synthetic\\foreign-modules",
  UNKNOWN_ENV_CANARY: "synthetic-unknown",
  NUMBER_OF_PROCESSORS: "64",
};
const { Path: unusedPath, ...withoutPath } = routing;
void unusedPath;
const cases: Array<{ name: string; input: NodeJS.ProcessEnv; expected: Record<string, string> }> = [
  {
    name: "mixed-case module cache",
    input: { ...routing, ...forbidden, PsModuleAnalysisCachePath: "C:\\synthetic\\module-cache" },
    expected: { ...routing, PsModuleAnalysisCachePath: "C:\\synthetic\\module-cache" },
  },
  {
    name: "Windows lexical duplicate winners",
    input: {
      ...routing,
      ...forbidden,
      PATH: "C:\\synthetic\\winning-bin",
      PSModuleAnalysisCachePath: "C:\\synthetic\\losing-cache",
      psmoduleanalysiscachepath: "C:\\synthetic\\last-cache",
      PSMODULEANALYSISCACHEPATH: "C:\\synthetic\\winning-cache",
    },
    expected: {
      ...withoutPath,
      PATH: "C:\\synthetic\\winning-bin",
      PSMODULEANALYSISCACHEPATH: "C:\\synthetic\\winning-cache",
    },
  },
  {
    name: "undefined Windows winners mask later spellings",
    input: {
      ...routing,
      ...forbidden,
      PATH: undefined,
      PSMODULEANALYSISCACHEPATH: undefined,
      PSModuleAnalysisCachePath: "C:\\synthetic\\masked-cache",
    },
    expected: withoutPath,
  },
];

function readControl(name: string) {
  const source = fs.readFileSync(new URL(`../../scripts/qa/${name}`, import.meta.url), "utf8");
  return { source, ast: parse(source, { ecmaVersion: "latest", sourceType: "module" }) };
}
function declarationText(control: ReturnType<typeof readControl>, name: string) {
  const node = control.ast.body.find(
    (entry) => entry.type === "FunctionDeclaration" && entry.id?.name === name,
  );
  assert.ok(node, `Missing control boundary: ${name}`);
  return control.source.slice(node.start, node.end);
}
const integration = readControl("windows-fileio-integration-control.mjs");
const standalone = readControl("windows-fileio-control.mjs");

describe("FileIO entry environment custody", () => {
  it.each(cases)(
    "integration main preserves $name through preparation and actual launch",
    async ({ input, expected }) => {
      const original = structuredClone(input);
      const env = Object.freeze({ ...input });
      const prepareEnvironments: NodeJS.ProcessEnv[] = [];
      const launchedEnvironments: NodeJS.ProcessEnv[] = [];
      const boundaryReached = new Error("Synthetic native launch boundary reached");
      let preparedCleanups = 0;
      let lifetimeCleanups = 0;
      const processState = {
        platform: "win32",
        arch: "x64",
        version: "v26.8.2",
        execPath: "fixture-node",
        env,
        argv: [
          "fixture-node",
          "fixture-control",
          "run",
          "fixture-addon",
          "/fixture-evidence",
          "/fixture-private",
        ],
        exitCode: 0,
      };
      // Stop at the first native prerequisite after the actual main has passed its
      // environment to preparation and the actual launchManaged has admitted it.
      const dependencies = {
        assert,
        path,
        performance,
        StringDecoder,
        resolveDiagnosticProcessEnv,
        hasUnjoinedWork,
        process: processState,
        addonSha256: "a".repeat(64),
        nodeSha256: "b".repeat(64),
        helper: "/fixture-helpers",
        hash: (file: string) => (file === processState.execPath ? "b".repeat(64) : "a".repeat(64)),
        fs: {
          readFileSync: () => JSON.stringify({ source: "c".repeat(40) }),
          readdirSync: () => [],
          mkdirSync() {},
          renameSync() {},
        },
        save() {},
        safeError: (error: unknown) => ({
          name: error instanceof Error ? error.name : "Error",
          unjoined: hasUnjoinedWork(error),
        }),
        projectCensusResult: () => ({ processes: [] }),
        createFixtureLifetime: () => ({
          track: <T>(completion: Promise<T>) => completion,
          async cleanup() {
            lifetimeCleanups++;
          },
        }),
        async prepareInstalledFileIo(params: { task: { env: NodeJS.ProcessEnv } }) {
          prepareEnvironments.push(structuredClone(params.task.env));
          return {
            descriptor: {
              powerShellExe: "fixture-powershell",
              dllPath: "fixture-dll",
              dllSha256: "d".repeat(64),
              sourceSha256: "e".repeat(64),
            },
            async cleanup() {
              preparedCleanups++;
            },
          };
        },
        async runManagedCommand(options: { env: NodeJS.ProcessEnv }) {
          launchedEnvironments.push(structuredClone(options.env));
          throw boundaryReached;
        },
        inspectManagedProcessGroup() {
          throw new Error("No native process should have been created");
        },
      };
      await compileFunction(
        `${declarationText(integration, "launchManaged")}\n${declarationText(integration, "main")}\nreturn main();`,
        Object.keys(dependencies),
      )(...Object.values(dependencies));
      expect(prepareEnvironments).toHaveLength(1);
      expect(launchedEnvironments).toHaveLength(1);
      expect(preparedCleanups).toBe(1);
      expect(lifetimeCleanups).toBe(1);
      expect(processState.exitCode).toBe(1);
      expect(prepareEnvironments[0]).toStrictEqual(expected);
      expect(launchedEnvironments[0]).toStrictEqual(expected);
      expect(env).toStrictEqual(original);
    },
  );

  it.each(cases)(
    "standalone initializer preserves $name through actual launch",
    async ({ input, expected }) => {
      const original = structuredClone(input);
      const env = Object.freeze({ ...input });
      const initializer = standalone.ast.body.find(
        (node) =>
          node.type === "VariableDeclaration" &&
          node.declarations.some(
            (declaration) =>
              declaration.id.type === "Identifier" && declaration.id.name === "childEnv",
          ),
      );
      assert.ok(initializer);
      const launchedEnvironments: NodeJS.ProcessEnv[] = [];
      const boundaryReached = new Error("Synthetic native launch boundary reached");
      const dependencies = {
        assert,
        path,
        performance,
        StringDecoder,
        resolveDiagnosticProcessEnv,
        process: { env, platform: "win32" },
        commands: [],
        mode: "run",
        evidence: "/fixture-evidence",
        lifetime: { track: <T>(completion: Promise<T>) => completion },
        save() {},
        describeError: (error: unknown) => ({
          name: error instanceof Error ? error.name : "Error",
        }),
        async runManagedCommand(options: { env: NodeJS.ProcessEnv }) {
          launchedEnvironments.push(structuredClone(options.env));
          throw boundaryReached;
        },
        inspectManagedProcessGroup() {
          throw new Error("No native process should have been created");
        },
      };
      const launch = compileFunction(
        `${standalone.source.slice(initializer.start, initializer.end)}\n${declarationText(standalone, "launch")}\nreturn launch;`,
        Object.keys(dependencies),
      )(...Object.values(dependencies));
      const command = launch("environment:probe", "fixture-powershell", []);
      await expect(command.completion).rejects.toBe(boundaryReached);
      expect(launchedEnvironments).toHaveLength(1);
      expect(launchedEnvironments[0]).toStrictEqual(expected);
      expect(env).toStrictEqual(original);
    },
  );
});

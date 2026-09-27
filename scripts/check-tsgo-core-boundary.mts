#!/usr/bin/env node

// Enforces core tsgo project boundaries and sparse-checkout safety.
import { realpathSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { runTasksWithConcurrency } from "../src/utils/run-with-concurrency.ts";
import { reportLimitViolations } from "./lib/check-limits.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { resolveRepoToolBinPath } from "./lib/local-check-runtime.mts";
import { runManagedCommand, signalExitCode } from "./lib/managed-child-process.mts";
import { readProcessMemoryCapacity } from "./lib/process-memory.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import {
  findOversizedTsgoCoreTestShards,
  findTsgoCoreTestShardViolations,
  TSGO_CI_ADDITIONAL_GRAPHS,
  TSGO_CORE_GRAPHS,
  TSGO_CORE_TEST_SHARDS,
} from "./lib/tsgo-core-test-shards.mts";
const repoRoot = resolveRepoRoot(import.meta.url);
const tsgoPath = resolveRepoToolBinPath("tsgo", { cwd: repoRoot });
const canonicalCoreTestConfig = "test/tsconfig/tsconfig.core.test.json";

type QueryContext = { env: NodeJS.ProcessEnv; interrupted?: NodeJS.Signals };

async function queryGraphs<T, R>(
  graphs: readonly T[],
  query: (graph: T, context: QueryContext) => Promise<R>,
): Promise<R[]> {
  // Discovery retains complete compiler inventories while sharing a four-CPU budget.
  const queryThreads = Number(process.env.GOMAXPROCS || "2");
  const parallel =
    Number.isSafeInteger(queryThreads) &&
    queryThreads > 0 &&
    availableParallelism() >= Math.max(4, 2 * queryThreads) &&
    (readProcessMemoryCapacity({}).limitBytes ?? 0) >= 8 * 1024 ** 3;
  const context: QueryContext = {
    env: parallel && !process.env.GOMAXPROCS ? { ...process.env, GOMAXPROCS: "2" } : process.env,
  };
  const result = await runTasksWithConcurrency({
    tasks: graphs.map((graph) => async () => {
      if (context.interrupted) {
        throw new CoreTsgoBoundaryInterruptedError(context.interrupted);
      }
      return await query(graph, context);
    }),
    limit: parallel ? 2 : 1,
    errorMode: "stop",
  });
  // Stop admission on error, but join every admitted query before rejecting.
  if (result.hasError) {
    throw result.firstError;
  }
  return result.results;
}

function normalizeFilePath(filePath: string, cwd: string) {
  const normalized = filePath.trim().replaceAll("\\", "/");
  const normalizedRoot = cwd.replaceAll("\\", "/");
  if (normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  return normalized;
}

export class CoreTsgoBoundaryInterruptedError extends Error {
  readonly exitCode: number;

  constructor(signal: NodeJS.Signals) {
    super(`Core tsgo graph boundary interrupted by ${signal}`);
    this.exitCode = signalExitCode(signal);
  }
}

async function runTsgoQuery(
  config: string,
  query: string,
  label: string,
  cwd: string,
  context?: QueryContext,
): Promise<string> {
  const outputs: Buffer[][] = [[], []];
  const overflow = new AbortController();
  let outputBytes = 0;
  let receivedSignal: NodeJS.Signals | undefined;
  let code: number;
  try {
    code = await runManagedCommand({
      bin: tsgoPath,
      args: ["-p", config, "--pretty", "false", query],
      cwd,
      env: context?.env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: overflow.signal,
      requireProcessTreeExit: process.platform !== "win32",
      onSignal(signal) {
        receivedSignal = signal;
        if (context) {
          context.interrupted = signal;
        }
      },
      onReady(child) {
        for (const [index, stream] of [child.stdout!, child.stderr!].entries()) {
          stream.on("data", (chunk: Buffer) => {
            if (overflow.signal.aborted) {
              return;
            }
            outputBytes += chunk.byteLength;
            // Inventory must be complete; preserve spawnSync's bound and fail rather than truncate.
            if (outputBytes > 256 * 1024 * 1024) {
              overflow.abort();
              return;
            }
            outputs[index]!.push(chunk);
          });
        }
      },
    });
  } catch (error) {
    if (overflow.signal.aborted) {
      throw new Error(`${label} output exceeded 256 MiB`, { cause: error });
    }
    throw error;
  }
  if (receivedSignal) {
    throw new CoreTsgoBoundaryInterruptedError(receivedSignal);
  }
  const [stdout, stderr] = outputs.map((chunks) => Buffer.concat(chunks).toString("utf8"));
  if (code !== 0) {
    throw new Error(
      `${label} failed with exit code ${code}\n${[stdout, stderr].filter(Boolean).join("\n")}`,
    );
  }
  return stdout!;
}

async function readGraphConfig(
  config: string,
  cwd: string,
  context?: QueryContext,
): Promise<{
  compilerOptions?: { tsBuildInfoFile?: string };
  files?: string[];
}> {
  return JSON.parse(
    await runTsgoQuery(config, "--showConfig", `${config} config expansion`, cwd, context),
  ) as {
    compilerOptions?: { tsBuildInfoFile?: string };
    files?: string[];
  };
}

export type CoreTsgoGraph = {
  name: string;
  config: string;
  roots: readonly string[];
  files: readonly string[];
};

/** Validates all boundaries and returns this invocation's compiler-resolved inputs. */
export async function checkCoreTsgoGraphBoundary(
  options: { cwd?: string } = {},
): Promise<CoreTsgoGraph[]> {
  const cwd = realpathSync(options.cwd ?? repoRoot);
  const normalize = (file: string) => normalizeFilePath(file, cwd);
  const testRootPattern = /\.test\.(?:ts|tsx)$/u;
  const canonicalRoots = ((await readGraphConfig(canonicalCoreTestConfig, cwd)).files ?? [])
    .map(normalize)
    .filter((file) => testRootPattern.test(file));
  const shardConfigs = await queryGraphs(TSGO_CORE_TEST_SHARDS, async (shard, context) => ({
    ...shard,
    expanded: await readGraphConfig(shard.config, cwd, context),
  }));
  const shardRoots = shardConfigs.map((shard) => ({
    name: shard.name,
    roots: (shard.expanded.files ?? []).map(normalize).filter((file) => testRootPattern.test(file)),
  }));
  const oversized = reportLimitViolations(
    findOversizedTsgoCoreTestShards({ shards: shardRoots }).map((message) => ({
      file: canonicalCoreTestConfig,
      title: "Core test shard root budget",
      message,
    })),
  );
  const shardViolations = findTsgoCoreTestShardViolations({
    canonicalRoots,
    shards: shardRoots,
  });

  const buildInfoOwners = new Map<string, string[]>();
  for (const shard of shardConfigs) {
    const buildInfo = shard.expanded.compilerOptions?.tsBuildInfoFile;
    if (!buildInfo) {
      shardViolations.push(`${shard.name}: missing compilerOptions.tsBuildInfoFile`);
      continue;
    }
    const owners = buildInfoOwners.get(buildInfo) ?? [];
    owners.push(shard.name);
    buildInfoOwners.set(buildInfo, owners);
  }
  for (const [buildInfo, owners] of buildInfoOwners) {
    if (owners.length > 1) {
      shardViolations.push(`shared tsBuildInfoFile (${owners.join(", ")}): ${buildInfo}`);
    }
  }

  if (shardViolations.length > 0) {
    console.error("Core test shards must cover every canonical test root exactly once:");
    for (const violation of shardViolations) {
      console.error(`- ${violation}`);
    }
    throw new Error("Core test graph ownership validation failed");
  }
  if (oversized) {
    throw new Error("Core test shard root budget exceeded");
  }

  const violations: string[] = [];
  const graphs = await queryGraphs(TSGO_CORE_GRAPHS, async (graph, context) => {
    const files = (
      await runTsgoQuery(
        graph.config,
        "--listFilesOnly",
        `${graph.name} file listing`,
        cwd,
        context,
      )
    )
      .split(/\r?\n/u)
      .map(normalize)
      .filter(Boolean);
    return {
      ...graph,
      files,
      roots: (shardConfigs.find((shard) => shard.config === graph.config)?.expanded.files ?? [])
        .map((file) => normalize(path.resolve(cwd, path.dirname(graph.config), file)))
        .filter((file) => testRootPattern.test(file)),
    };
  });
  for (const graph of graphs) {
    const extensionFiles = graph.files.filter((file) => file.startsWith("extensions/"));
    for (const file of extensionFiles) {
      violations.push(`${graph.name}: ${file}`);
    }
  }

  if (violations.length > 0) {
    console.error("Core tsgo graphs must not include bundled extension files:");
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    console.error(
      "Move extension-owned behavior behind plugin SDK contracts, public artifacts, or extension-local tests.",
    );
    throw new Error("Core tsgo graphs include bundled extension files");
  }
  return graphs;
}

/** Reuse the core boundary admission before inspecting the remaining CI compilers. */
export async function inspectCiTsgoCheckGraphs(
  options: { cwd?: string } = {},
): Promise<CoreTsgoGraph[]> {
  const cwd = realpathSync(options.cwd ?? repoRoot);
  const graphs = await checkCoreTsgoGraphBoundary({ cwd });
  const additional = await queryGraphs(TSGO_CI_ADDITIONAL_GRAPHS, async (graph, context) => {
    const files = (
      await runTsgoQuery(
        graph.config,
        "--listFilesOnly",
        `${graph.name} file listing`,
        cwd,
        context,
      )
    )
      .split(/\r?\n/u)
      .map((file) => normalizeFilePath(file, cwd))
      .filter(Boolean);
    return { ...graph, files, roots: [] };
  });
  return [...graphs, ...additional];
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    await checkCoreTsgoGraphBoundary();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof CoreTsgoBoundaryInterruptedError ? error.exitCode : 1;
  }
}

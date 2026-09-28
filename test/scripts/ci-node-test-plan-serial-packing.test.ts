import { afterEach, expect, it, vi } from "vitest";
import { createChangedNodeTestShards } from "../../scripts/lib/ci-changed-node-test-plan.mts";
import * as nodePlan from "../../scripts/lib/ci-node-test-plan.mts";
import type { NodeTestShard, NodeTestShardGroup } from "../../scripts/lib/ci-node-test-plan.mts";
import { DATABASE_WORKER_CONFIG } from "../../scripts/lib/extension-test-plan.mts";

afterEach(() => vi.restoreAllMocks());

function job(name: string, seconds = 70): NodeTestShard & { groups: NodeTestShardGroup[] } {
  const runner = "blacksmith-8vcpu-ubuntu-2404";
  return {
    checkName: `checks-${name}`,
    shardName: name,
    configs: [],
    runner,
    requiresDist: false,
    planConcurrency: 1,
    predictedSeconds: seconds,
    predictedTestSeconds: seconds,
    groups: [
      {
        shard_name: name,
        timing_key: `${name}-measured`,
        configs: ["test/vitest/vitest.cron.config.ts"],
        includePatterns: [`src/cron/${name}.test.ts`],
        runner,
        requiresDist: false,
        env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
        fallbackMaxWorkers: 1,
        minTotalMemoryBytes: 4 * 1024 ** 3,
      },
    ],
  };
}

it("compacts independent parent tails at the changed-plan producer", () => {
  const targets = [
    "src/gateway/worker-environments/placement-dispatch.test.ts",
    "src/gateway/worker-environments/placement-dispatch-reclaim.test.ts",
  ];
  const parents = targets.map((target, index) => {
    const row = job(`parent-${index}`);
    row.groups[0]!.configs = ["test/vitest/vitest.gateway-database-workers.config.ts"];
    row.groups[0]!.includePatterns = [target];
    return row;
  });
  const children = parents.flatMap((row) => row.groups);
  vi.spyOn(nodePlan, "createSelectedNodeTestShardBundles").mockReturnValue(parents);

  const rows = createChangedNodeTestShards(targets, {
    runnerBackend: "github",
    selectedTestTargets: targets,
    dedicatedBuildArtifacts: true,
  });

  expect(rows).toHaveLength(1);
  expect(rows?.[0]?.predictedTestSeconds).toBe(140);
  expect(rows?.[0]?.groups).toEqual(children);
  expect(rows?.[0]?.groups?.flatMap((group) => group.includePatterns ?? [])).toEqual(targets);
});

it.each([
  [80, 1],
  [81, 2],
])("retains every child and the test budget with a %i-second companion", (seconds, count) => {
  const parents = [job("first"), job("second", seconds)];
  const before = structuredClone(parents);
  const children = parents.flatMap((row) => row.groups);
  const rows = nodePlan.packBoundedSerialNodeTestJobs(parents, 150);

  expect(rows).toHaveLength(count);
  expect(parents).toEqual(before);
  const actual = rows.flatMap((row) => row.groups ?? []);
  expect(actual).toHaveLength(2);
  for (const child of children) {
    expect(actual.filter((group) => group === child)).toHaveLength(1);
  }
  expect(rows.every((row) => row.predictedTestSeconds! <= 150)).toBe(true);
});

it.each<[string, Partial<NodeTestShard>]>([
  ["runner", { runner: "blacksmith-16vcpu-ubuntu-2404" }],
  ["preparation", { pretestBuildMode: "runtime" }],
  ["concurrency", { planConcurrency: 2 }],
  ["implicit concurrency", { planConcurrency: undefined }],
  ["environment", { env: { OPENCLAW_VITEST_MAX_WORKERS: "1" } }],
  ["timeout", { timeoutMinutes: 30 }],
  ["artifact", { requiresDist: true }],
  ["unknown price", { predictedSeconds: undefined, predictedTestSeconds: undefined }],
  ["nonfinite price", { predictedTestSeconds: Number.POSITIVE_INFINITY }],
  ["indivisible price", { predictedSeconds: 151, predictedTestSeconds: 151 }],
  ["direct target", { groups: undefined, includePatterns: ["src/cron/normalize.test.ts"] }],
])("does not combine a different or ineligible %s policy", (_name, override) => {
  const first = job("first");
  const second = { ...job("second"), ...override };
  expect(nodePlan.packBoundedSerialNodeTestJobs([first, second], 150)).toEqual([first, second]);
});

it("keeps exclusive process owners separate from ordinary serial rows", () => {
  const ordinary = job("ordinary");
  const exclusive = job("agentic-cli");
  expect(nodePlan.packBoundedSerialNodeTestJobs([ordinary, exclusive], 150)).toHaveLength(2);
});

it("shares preparation once while retaining the larger preparation estimate", () => {
  const first = { ...job("first"), pretestBuildMode: "runtime" as const, predictedSeconds: 170 };
  const second = { ...job("second"), pretestBuildMode: "runtime" as const, predictedSeconds: 190 };
  const rows = nodePlan.packBoundedSerialNodeTestJobs([first, second], 150);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    pretestBuildMode: "runtime",
    planConcurrency: 1,
    predictedTestSeconds: 140,
    predictedSeconds: 260,
  });
});

it("retains the ten-process limit even when every process is cheap", () => {
  const parents = Array.from({ length: 11 }, (_, index) => job(`group-${index}`, 1));
  const rows = nodePlan.packBoundedSerialNodeTestJobs(parents, 150);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => (row.groups ?? []).length).toSorted((a, b) => a - b)).toEqual([1, 10]);
  expect(rows.flatMap((row) => row.groups ?? [])).toHaveLength(11);
});

it.each([
  [10, 1],
  [11, 2],
])("retains the database-worker file limit with a %i-file companion", (files, count) => {
  const first = job("database-first", 1);
  const second = job("database-second", 1);
  for (const [row, size] of [
    [first, 10],
    [second, files],
  ] as const) {
    row.groups[0]!.configs = [DATABASE_WORKER_CONFIG];
    row.groups[0]!.includePatterns = Array.from(
      { length: size },
      (_, index) => `extensions/fixture/${row.shardName}-${index}.test.ts`,
    );
  }
  const rows = nodePlan.packBoundedSerialNodeTestJobs([first, second], 150);
  expect(rows).toHaveLength(count);
  expect(
    rows.map((row) =>
      row.groups?.reduce((sum, group) => sum + (group.includePatterns?.length ?? 0), 0),
    ),
  ).toEqual(count === 1 ? [20] : [10, 11]);
});

it("does not share an unenumerated database-worker process", () => {
  const first = job("database-first", 1);
  first.groups[0]!.configs = [DATABASE_WORKER_CONFIG];
  delete first.groups[0]!.includePatterns;
  const second = job("second", 1);
  expect(nodePlan.packBoundedSerialNodeTestJobs([first, second], 150)).toEqual([first, second]);
});

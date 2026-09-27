import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { runCiManifestFixture } from "./ci-workflow-manifest.test-support.js";
import {
  evaluateWorkflowExpression,
  evaluateWorkflowRunner,
  readCiWorkflow,
  readWorkflowOutputs,
  runWorkflowShellScript,
} from "./ci-workflow.test-support.js";

type MatrixRow = { check_name?: string; task?: string; runner?: string; targets?: string[] };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function rows(value: string | undefined): MatrixRow[] {
  assert(value !== undefined, "Required CI matrix output is missing");
  return JSON.parse(value).include;
}

describe("main push changed-set gate", () => {
  const fixture = {
    bundledPlanner: true,
    checkFamilyScope: true,
    eventName: "push" as const,
    runnerBackend: "blacksmith" as const,
    runnerProfile: "github" as const,
    nodeRunnerBackend: "github" as const,
    historicalCompatibility: false,
    scopeEnv: { OPENCLAW_CI_MAIN_PUSH_GATE: "true" },
  };

  it("preserves fork main-push opt-in without granting the canonical fast gate", () => {
    const workflow = readCiWorkflow();
    const context = {
      eventName: "push" as const,
      repository: "fork/openclaw",
      ref: "refs/heads/main",
      runAttempt: 1,
    };
    expect(evaluateWorkflowExpression(workflow.env.OPENCLAW_CI_MAIN_PUSH_GATE, context)).toBe(
      false,
    );
    for (const jobName of ["preflight", "ci-gate"]) {
      expect(evaluateWorkflowExpression(workflow.jobs[jobName].if, context), jobName).toBe(false);
      expect(
        evaluateWorkflowExpression(workflow.jobs[jobName].if, { ...context, ciOnPush: "true" }),
        jobName,
      ).toBe(true);
    }
  });

  it("resolves the push gate to hosted planning despite the repository's paid backend", () => {
    const output = path.join(tempDirs.make("ci-main-push-profile-"), "profile.out");
    const step = readCiWorkflow().jobs.preflight.steps.find(
      (candidate: { id?: string }) => candidate.id === "runner_profile",
    );
    const result = runWorkflowShellScript(step.run, {
      env: {
        ...process.env,
        OPENCLAW_CI_MAIN_PUSH_GATE: "true",
        CONFIGURED_RUNNER_PROFILE: "blacksmith",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_OUTPUT: output,
        AUTHOR_ASSOCIATION: "OWNER",
        HEAD_REPOSITORY: "openclaw/openclaw",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readWorkflowOutputs(output)).toMatchObject({
      main_push_gate: "true",
      runner_profile: "github",
      node_runner_backend: "github",
    });
  });

  it.each([
    { changedPath: "src/shared/runtime.ts", productionTypes: true },
    { changedPath: "src/agents/session.test.ts", productionTypes: false },
  ])(
    "preserves selected checks and owner tests for $changedPath",
    ({ changedPath, productionTypes }) => {
      const result = runCiManifestFixture({
        ...fixture,
        changedPaths: [changedPath],
        ciTypeGraphNames: [
          ...(productionTypes ? ["core"] : []),
          "core-test-agents-root",
          "test-root",
        ],
        changedPlannerSource: `
        export const createChangedNodeTestShards = (paths, options) => {
          if (JSON.stringify(paths) !== ${JSON.stringify(JSON.stringify([changedPath]))}) {
            throw new Error("The push range did not reach the changed-test owner");
          }
          if (options.runnerBackend !== "github") {
            throw new Error("The push gate requested a paid test runner");
          }
          return [{ checkName: "selected-owner-test", shardName: "selected-owner-test",
            configs: [], targets: ["src/agents/session.test.ts"], requiresDist: false,
            runner: "ubuntu-24.04" }];
        };
        export const createChangedExtensionFallbackShards = () => [];
        export const hasBuildArtifactAffectingChange = () => false;
      `,
      });
      expect(result.status, result.output).toBe(0);
      expect(result.outputs.main_push_gate).toBe("true");
      expect(result.outputs.run_check_plan).toBe("true");
      const tasks = rows(result.checkPlanOutputs.check_matrix).map((row) => row.task);
      expect(tasks).toEqual(expect.arrayContaining(["guards", "lint", "test-types"]));
      expect(tasks.includes("prod-types")).toBe(productionTypes);
      expect(rows(result.checkPlanOutputs.core_type_matrix)).not.toHaveLength(0);
      expect(result.checkPlanOutputs.type_graph_boundary_checked).toBe("true");
      expect(result.outputs.run_check_additional).toBe("true");
      expect(rows(result.outputs.check_additional_matrix)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ check_name: "check-additional-boundaries" }),
        ]),
      );
      expect(rows(result.outputs.checks_node_core_nondist_matrix)).toEqual([
        expect.objectContaining({
          check_name: "selected-owner-test",
          targets: ["src/agents/session.test.ts"],
          runner: "ubuntu-24.04",
        }),
      ]);
      for (const key of [
        "run_proof_tier",
        "run_qa_smoke_ci",
        "run_docker_seed_e2e",
        "run_checks_windows",
        "run_macos_node",
        "run_macos_swift",
        "run_ios_build",
        "run_android_job",
      ]) {
        expect(result.outputs[key], key).toBe("false");
      }

      const context = {
        eventName: "push" as const,
        repository: "openclaw/openclaw",
        runAttempt: 1,
        runnerBackend: "blacksmith" as const,
        env: { OPENCLAW_CI_MAIN_PUSH_GATE: "true" },
        preflightOutputs: result.outputs,
        matrix: { runner: "blacksmith-16vcpu-ubuntu-2404", task: "test-types" },
      };
      const workflow = readCiWorkflow();
      for (const job of [
        "preflight",
        "security-fast",
        "check-plan",
        "check-shard",
        "check-additional-shard",
        "check-lint-hosted-core-shard",
        "check-test-types-hosted-core-shard",
        "checks-node-core-test-nondist-shard",
        "ci-gate",
      ]) {
        expect(evaluateWorkflowRunner(workflow.jobs[job]["runs-on"], context), job).toBe(
          "ubuntu-24.04",
        );
      }
    },
  );

  it("retains complete fallback coverage when the changed-test owner cannot narrow", () => {
    const result = runCiManifestFixture({
      ...fixture,
      changedPaths: ["scripts/run-vitest.mts"],
      changedPlannerSource: `
        export const createChangedNodeTestShards = (_paths, options) => {
          options.onFallback("global execution input");
          return null;
        };
        export const createChangedExtensionFallbackShards = () => [];
        export const hasBuildArtifactAffectingChange = () => true;
      `,
    });
    expect(result.status, result.output).toBe(0);
    expect(result.outputs.main_push_gate).toBe("true");
    expect(result.outputs.run_check_plan).toBe("false");
    expect(result.outputs.narrow_check_paths_json).toBe("");
    expect(result.outputs.run_build_artifacts).toBe("true");
    expect(rows(result.outputs.check_matrix).map((row) => row.task)).toEqual(
      expect.arrayContaining(["guards", "lint", "prod-types", "test-types"]),
    );
    expect(rows(result.outputs.checks_node_core_nondist_matrix)).toEqual([
      expect.objectContaining({ check_name: "bundled-node-plan", runner: "ubuntu-24.04" }),
    ]);
    expect(result.output).toContain("Node test plan broad fallback: global execution input");
  });
});

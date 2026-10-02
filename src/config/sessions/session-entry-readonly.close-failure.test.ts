import { readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { JsonTestResults } from "vitest/node";
import { createCommandFixture } from "../../../test/helpers/command-fixture.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";

it("retains a rejected reader close for later canonical drainage", async (context) => {
  const command = createCommandFixture(context, "tree");
  const root = command.createTempDir("readonly-close-failure-");
  const repoRoot = nodePath.resolve(import.meta.dirname, "../../..");
  const childFixture = nodePath
    .relative(
      repoRoot,
      fileURLToPath(
        new URL("./session-entry-readonly-close-failure.test-support.ts", import.meta.url),
      ),
    )
    .split(nodePath.sep)
    .join("/");
  const configPath = nodePath.join(root, "vitest.config.mts");
  const reportPath = nodePath.join(root, "report.json");
  try {
    // Failed custody intentionally survives in the child until process exit.
    // The parent joins that process before removing its isolated state and report.
    await writeFile(
      configPath,
      `import { sharedVitestConfig } from ${JSON.stringify(nodePath.join(repoRoot, "test/vitest/vitest.shared.config.ts"))};
export default {
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    include: [${JSON.stringify(childFixture)}],
    setupFiles: [],
    runner: undefined,
    isolate: true,
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    passWithNoTests: false,
  },
};
`,
    );
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (
        key.startsWith("VITEST") ||
        key.startsWith("OPENCLAW_VITEST") ||
        key === "GITHUB_ACTIONS"
      ) {
        delete env[key];
      }
    }
    Object.assign(env, {
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: root,
      OPENCLAW_TEST_HOME: root,
      OPENCLAW_STATE_DIR: nodePath.join(root, "state"),
      OPENCLAW_CONFIG_PATH: nodePath.join(root, "openclaw.json"),
      XDG_CONFIG_HOME: nodePath.join(root, ".config"),
      XDG_DATA_HOME: nodePath.join(root, ".local", "share"),
      XDG_STATE_HOME: nodePath.join(root, ".local", "state"),
      XDG_CACHE_HOME: nodePath.join(root, ".cache"),
      OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: nodePath.join(root, "modules"),
      NO_COLOR: "1",
    });
    delete env.OPENCLAW_AGENT_DIR;
    delete env.PI_CODING_AGENT_DIR;
    const result = await command.run(
      resolveTestNodeExecPath(),
      [
        "scripts/run-vitest.mjs",
        "run",
        "--config",
        configPath,
        "--reporter=verbose",
        "--reporter=json",
        `--outputFile.json=${reportPath}`,
      ],
      { cwd: repoRoot, env },
    );
    expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = JSON.parse(await readFile(reportPath, "utf8")) as JsonTestResults;
    expect(report.numTotalTests).toBe(1);
    expect(report.numPassedTests).toBe(1);
    expect(report.numFailedTests).toBe(0);
    expect(report.testResults).toHaveLength(1);
    expect(report.testResults[0]?.status).toBe("passed");
  } finally {
    await command.lifetime.cleanup();
  }
});

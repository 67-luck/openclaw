import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const script = path.resolve("scripts/ci-main-push-step.sh");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runStep(contents: string, enabled: boolean) {
  const workspace = tempDirs.make("openclaw-main-push-step-");
  const step = path.join(workspace, "step.sh");
  const summary = path.join(workspace, "summary.md");
  writeFileSync(step, contents);
  const result = spawnSync("bash", [script, step], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_CI_MAIN_PUSH_GATE: String(enabled),
      OPENCLAW_CI_PUSH_BASE: "a".repeat(40),
      OPENCLAW_CI_PUSH_HEAD: "b".repeat(40),
      GITHUB_JOB: "check<types>",
      GITHUB_ACTION: "typecheck",
      GITHUB_STEP_SUMMARY: summary,
      RUNNER_TEMP: workspace,
    },
  });
  expect(result.error).toBeUndefined();
  expect(
    readdirSync(workspace).filter((name) => name.startsWith("openclaw-ci-main-push.")),
  ).toEqual([]);
  return { ...result, summary: existsSync(summary) ? readFileSync(summary, "utf8") : "" };
}

describe("main push step shell", () => {
  it.each([false, true])("preserves pipefail and errexit with capture enabled=%s", (enabled) => {
    const result = runStep(
      "printf 'src/example.ts: TS2322: <string> & <number>\\n' >&2\n(exit 23) | cat\nprintf 'must not run\\n'\n",
      enabled,
    );
    expect(result.status).toBe(23);
    expect(result.stdout + result.stderr).toContain("src/example.ts: TS2322: <string> & <number>");
    expect(result.stdout + result.stderr).not.toContain("must not run");
    if (enabled) {
      expect(result.stdout).toContain("::error title=Main push gate failed::");
      expect(result.summary).toContain("Job: check&lt;types&gt;");
      expect(result.summary).toContain("Step: typecheck");
      expect(result.summary).toContain(`${"a".repeat(40)}..${"b".repeat(40)}`);
      expect(result.summary).toContain(
        "src/example.ts: TS2322: &lt;string&gt; &amp; &lt;number&gt;",
      );
    } else {
      expect(result.stdout).toBe("");
      expect(result.summary).toBe("");
    }
  });

  it("streams successful output without a failure summary", () => {
    const result = runStep("printf 'passed\\n'\nprintf 'diagnostic\\n' >&2\n", true);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("passed\ndiagnostic\n");
    expect(result.summary).toBe("");
  });

  it("bounds the summary while retaining both ends and the complete step output", () => {
    const diagnostic = `first diagnostic\n${"x".repeat(40000)}\nlast diagnostic`;
    const result = runStep(`printf '%s\\n' '${diagnostic}'\nexit 42\n`, true);
    expect(result.status).toBe(42);
    expect(result.stdout).toContain(diagnostic);
    expect(result.summary).toContain("first diagnostic");
    expect(result.summary).toContain("last diagnostic");
    expect(result.summary).toContain("Middle of output omitted");
    expect(result.summary.length).toBeLessThan(35000);
  });
});

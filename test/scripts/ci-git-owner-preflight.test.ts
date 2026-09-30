import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { createCommandTest } from "../helpers/command-fixture.js";
import { readWorkflowOutputs } from "./ci-workflow.test-support.js";

const it = createCommandTest();

it.skipIf(process.platform === "win32")(
  "executes the manifest from a same-revision preflight harness",
  async ({ command }) => {
    const root = command.createTempDir("ci-preflight-harness-");
    const env = { PATH: process.env.PATH, HOME: root };
    const sources = [
      ".github/actions/setup-node-env/action.yml",
      ".github/actions/git-owner/test-prerequisites.mjs",
      ".github/actions/git-owner/test-prerequisites.json",
      "scripts/ci-build-manifest.mjs",
      "scripts/lib/release-context.mjs",
      "scripts/lib/release-version.mjs",
      "scripts/lib/pnpm-lockfile-documents.mjs",
    ];
    for (const source of sources) {
      const target = path.join(root, source);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    const git = async (args: string[]) => {
      const result = await command.run("git", args, { cwd: root, env });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    await git(["init", "--quiet"]);
    await git(["add", "--", ...sources]);
    await git([
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    const revision = await git(["rev-parse", "HEAD"]);
    const acquired = await command.run(
      "python3",
      ["-I", "-S", path.resolve(".github/actions/git-owner/owner.py"), "--policy", "-"],
      {
        cwd: root,
        env: { ...env, WORKFLOW_SHA: revision },
        input: [
          "import os",
          "import ci_git_owner as owner",
          'owner.kind = "preflight"',
          "owner.workspace = os.getcwd()",
          'owner.checkout_harness(os.environ["WORKFLOW_SHA"])',
          "",
        ].join("\n"),
      },
    );
    expect(acquired.status, acquired.stderr).toBe(0);

    const output = path.join(root, "manifest.out");
    const manifest = await command.run(
      process.execPath,
      [path.join(root, ".ci-harness/scripts/ci-build-manifest.mjs")],
      {
        cwd: process.cwd(),
        env: {
          ...env,
          GITHUB_OUTPUT: output,
          OPENCLAW_CI_DOCS_ONLY: "true",
          OPENCLAW_CI_EVENT_NAME: "pull_request",
        },
      },
    );
    expect(manifest.status, manifest.stderr).toBe(0);
    expect(readWorkflowOutputs(output)).toMatchObject({
      docs_only: "true",
      run_node: "false",
    });
  },
);

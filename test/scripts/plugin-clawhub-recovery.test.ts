import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  createClawHubRecoveryManifest,
  executeClawHubRecoveryManifest,
} from "../../scripts/plugin-clawhub-recovery.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const version = "2026.9.7";
const pending = {
  name: "@openclaw/example",
  version,
  publicationStatus: "pending",
  attemptId: "attempt-1",
};

function render(
  records: unknown[],
  reason = "Parent failed after staging",
  releaseVersion = version,
  separator: string[] = [],
) {
  const directory = directories.make("clawhub-recovery-");
  const paths = records.map((record, index) => {
    const path = join(directory, `${index}.json`);
    writeFileSync(path, JSON.stringify(record));
    return path;
  });
  const result = spawnSync(
    process.execPath,
    [
      "scripts/plugin-clawhub-recovery.mjs",
      ...separator,
      "--version",
      releaseVersion,
      "--reason",
      reason,
      "--clawhub-source",
      join(directory, "source checkout"),
      ...paths,
    ],
    { encoding: "utf8" },
  );
  return { directory, ...result };
}

describe("ClawHub staged publication recovery commands", () => {
  it("rejects a version that could escape the generated comment", () => {
    const releaseVersion = "2026.9.7\necho injected";
    const result = render([{ ...pending, version: releaseVersion }], "Recovery", releaseVersion);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("preserves exact attempts and safely quotes commands while skipping published packages", () => {
    const reason = "Parent's failure; $(printf INJECTED)";
    const result = render(
      [
        pending,
        { ...pending, name: "@openclaw/done", publicationStatus: "published" },
        {
          ...pending,
          name: "@openclaw/failed",
          publicationStatus: "failed",
          attemptId: "attempt-2",
        },
      ],
      reason,
      version,
      ["--"],
    );
    expect(result.status, result.stderr).toBe(0);
    const bun = join(result.directory, "bun");
    writeFileSync(
      bun,
      `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
    );
    chmodSync(bun, 0o755);
    const invoked = spawnSync("/bin/sh", ["-c", result.stdout], {
      cwd: result.directory,
      env: { ...process.env, PATH: `${result.directory}:${process.env.PATH}` },
      encoding: "utf8",
    });
    expect(invoked.status, invoked.stderr).toBe(0);
    expect(
      invoked.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(
      ["attempt-1", "attempt-2"].map((attempt) => [
        join(result.directory, "source checkout/packages/clawhub/src/cli.ts"),
        "--no-input",
        "package",
        "recover",
        attempt,
        "--manual-override-reason",
        reason,
        "--wait",
        "--wait-timeout",
        "1800",
        "--json",
      ]),
    );
  });

  it.each([
    { ...pending, name: "@openclaw/other", version: "2026.9.8" },
    { ...pending, name: "@openclaw/other", attemptId: undefined },
    { ...pending, name: "@openclaw/other", publicationStatus: "blocked" },
    pending,
  ])("rejects incomplete or mixed evidence before emitting any recovery command", (invalid) => {
    const result = render([pending, invalid]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});

const transactions = {
  schemaVersion: 1,
  identity: {
    version: 2,
    repository: "openclaw/openclaw",
    workflow: ".github/workflows/plugin-clawhub-release.yml",
    runId: "20",
    runAttempt: "1",
    ref: "release-publish/aaaaaaaaaaaa-10",
    fullRef: "refs/tags/release-publish/aaaaaaaaaaaa-10",
    sha: "a".repeat(40),
    candidateRepository: "openclaw/openclaw",
    candidateSha: "b".repeat(40),
    toolingRef: "release-publish/aaaaaaaaaaaa-10",
    toolingFullRef: "refs/tags/release-publish/aaaaaaaaaaaa-10",
    toolingSha: "a".repeat(40),
    parentRepository: "openclaw/openclaw",
    parentWorkflow: ".github/workflows/openclaw-release-publish.yml",
    parentRunId: "10",
    parentRunAttempt: "1",
  },
  packages: [
    {
      name: pending.name,
      version,
      artifactName: "clawhub-package-example",
      artifactSha256: "c".repeat(64),
      artifactSize: 123,
      inventoryDigest: "e".repeat(64),
    },
  ],
};

describe("sealed ClawHub recovery manifest", () => {
  it("seals every available attempt when the complete manifest is unavailable", () => {
    const directory = directories.make("clawhub-cleanup-snapshot-");
    const recordPath = join(directory, "package-publish.json");
    const outputPath = join(directory, "cleanup-snapshot.json");
    writeFileSync(recordPath, JSON.stringify(pending));
    const result = spawnSync(
      process.execPath,
      ["scripts/plugin-clawhub-recovery.mjs", "snapshot", "--output", outputPath, recordPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CHILD_RUN_ID: "20",
          CHILD_RUN_ATTEMPT: "1",
          COMPLETE_MANIFEST_AVAILABLE: "false",
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      childRunId: "20",
      completeManifestAvailable: false,
      packages: [{ name: pending.name, attemptId: pending.attemptId }],
    });
  });

  it("rejects an incomplete publish roster", () => {
    expect(() => createClawHubRecoveryManifest(transactions, [])).toThrow(
      "Missing ClawHub publish artifact",
    );
  });

  it("recovers only the exact staged attempts and waits for public completion", async () => {
    const manifest = createClawHubRecoveryManifest(transactions, [pending]);
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      const body = typeof init?.body === "string" ? init.body : undefined;
      requests.push({ url, method: init?.method ?? "GET", body });
      if (init?.method === "POST") {
        return Response.json({
          recoveredFromAttemptId: "attempt-1",
          attemptId: "attempt-2",
          name: pending.name,
          version,
          publicationStatus: "pending",
        });
      }
      return Response.json({
        name: pending.name,
        version,
        publicationStatus: "published",
      });
    };
    const result = await executeClawHubRecoveryManifest({
      manifest,
      reason: "Parent failed after sealed staging",
      token: "fixture-token",
      registry: "https://clawhub.example",
      fetchImpl,
      wait: async () => {},
    });
    expect(result).toMatchObject({ complete: true, recovered: [{ attemptId: "attempt-2" }] });
    expect(requests).toEqual([
      {
        url: "https://clawhub.example/api/v1/publish/attempts/attempt-1/recover",
        method: "POST",
        body: JSON.stringify({ manualOverrideReason: "Parent failed after sealed staging" }),
      },
      {
        url: "https://clawhub.example/api/v1/publish/attempts/attempt-2",
        method: "GET",
        body: undefined,
      },
    ]);
  });

  it("keeps automated recovery behind approval and preserves the manifest before cancellation", () => {
    const recovery = parse(readFileSync(".github/workflows/plugin-clawhub-recovery.yml", "utf8"));
    expect(recovery.jobs.recover.environment).toBe("clawhub-plugin-release");
    const recoveryNames = recovery.jobs.recover.steps.map((step: { name?: string }) => step.name);
    expect(
      recoveryNames.indexOf("Validate original sealed authority and exact recovery roster"),
    ).toBeLessThan(recoveryNames.indexOf("Recover every non-public exact attempt"));
    expect(
      recovery.jobs.recover.steps.find(
        (step: { name?: string }) => step.name === "Recover every non-public exact attempt",
      ).run,
    ).toContain("plugin-clawhub-recovery.mjs execute");

    const release = parse(readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8"));
    const cleanupNames = release.jobs.cleanup_clawhub.steps.map(
      (step: { name?: string }) => step.name,
    );
    expect(
      cleanupNames.indexOf("Download sealed recovery manifest before cancellation"),
    ).toBeLessThan(cleanupNames.indexOf("Cancel unfinished ClawHub children"));
    expect(cleanupNames.indexOf("Upload sealed cleanup evidence")).toBeLessThan(
      cleanupNames.indexOf("Cancel unfinished ClawHub children"),
    );
    expect(
      release.jobs.cleanup_clawhub.steps.find(
        (step: { name?: string }) =>
          step.name === "Download sealed recovery manifest before cancellation",
      )["continue-on-error"],
    ).toBe(true);
    expect(release.jobs.finalize_github_release.needs).toContain("verify_clawhub_publication");

    const child = parse(readFileSync(".github/workflows/plugin-clawhub-release.yml", "utf8"));
    expect(child.jobs.seal_clawhub_recovery_manifest.steps.at(-1).with.name).toContain(
      "openclaw-clawhub-recovery-manifest-",
    );
  });
});

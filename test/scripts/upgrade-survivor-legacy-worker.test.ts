import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import legacyPlugin from "../../scripts/e2e/lib/upgrade-survivor/fixtures/legacy-worker-provider/index.mjs";
import {
  assertLegacyBackend,
  assertLegacyDriver,
  assertLegacyEnvironment,
  assertLegacyUpdateResult,
} from "../../scripts/e2e/lib/upgrade-survivor/legacy-worker-provider.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

const baseline = {
  version: "2026.9.6",
  sha256: "published",
  cli: "/isolated/openclaw/openclaw.mjs",
  buildInfo: { commit: "published-commit", buildId: "published-build" },
  files: { "openclaw.mjs": { sha256: "published-entry" } },
};
const candidate = {
  version: "2026.9.6",
  sha256: "candidate",
  buildInfo: { commit: "candidate-commit", buildId: "candidate-build" },
};
const started = {
  postCore: false,
  version: baseline.version,
  buildInfo: baseline.buildInfo,
  relativeEntry: "openclaw.mjs",
  entrySha256: "published-entry",
  root: "/isolated/openclaw",
  pid: 321,
  parentPid: 123,
  timeOriginUnixMs: 1710000000000,
  args: ["update", "--tag", "file:/isolated/candidate.tgz", "--yes", "--json", "--no-restart"],
};
const environment = {
  id: "native-environment",
  worker: {
    profileId: "legacy-survivor",
    providerId: "survivor-legacy",
    leaseId: "legacy-lease",
    state: "ready",
    attachedSessionIds: [],
  },
};
const lease = {
  leaseId: "legacy-lease",
  allocations: 1,
  allocateCalls: 1,
  launches: 1,
  build: { commit: "published-commit" },
  destroyed: true,
  running: false,
  destructions: 1,
  destroyCalls: 1,
  groupJoined: true,
};

describe("published upgrade legacy-worker-provider oracle", () => {
  it.skipIf(process.platform === "win32").each([0, 1])(
    "keeps strict HTTPS readiness at probe exit %i",
    (probeStatus) => {
      const root = dirs.make("legacy-worker-tls-ready-");
      const log = path.join(root, "gateway.log");
      fs.writeFileSync(log, "[gateway] ready wss://0.0.0.0:18789\n");
      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -eu",
            "source scripts/lib/openclaw-e2e-instance.sh",
            "sleep() { :; }",
            "openclaw_e2e_probe_tcp() { echo unexpected-tcp; return 0; }",
            'openclaw_e2e_probe_http() { printf "probe:%s:%s:%s\\n" "$1" "$2" "$3"; return "$UNIT_PROBE_STATUS"; }',
            'openclaw_e2e_wait_gateway_ready "$$" "$UNIT_LOG" 1 18789 strict https://localhost:18789',
          ].join("\n"),
        ],
        {
          encoding: "utf8",
          timeout: 5_000,
          env: { PATH: process.env.PATH, UNIT_LOG: log, UNIT_PROBE_STATUS: String(probeStatus) },
        },
      );
      expect(result.status, result.stderr).toBe(probeStatus);
      expect(result.stdout).toContain("probe:https://localhost:18789/readyz:ok:400\n");
      expect(result.stdout).not.toContain("unexpected-tcp");
      if (probeStatus) {
        expect(result.stdout).toContain("/readyz probe never succeeded");
      }
    },
  );
  it("accepts a same-version first hop only with distinct bytes and the original driver", () => {
    expect(() =>
      assertLegacyDriver(started, { ...started, exitCode: 0 }, baseline, candidate),
    ).not.toThrow();
    for (const changed of [
      { ...candidate, sha256: baseline.sha256 },
      { ...candidate, buildInfo: baseline.buildInfo },
    ]) {
      expect(() =>
        assertLegacyDriver(started, { ...started, exitCode: 0 }, baseline, changed),
      ).toThrow();
    }
    for (const changed of [
      { ...started, buildInfo: candidate.buildInfo },
      { ...started, entrySha256: "changed" },
      { ...started, root: "/candidate" },
      { ...started, postCore: true },
      { ...started, args: ["update", "--tag", "2026.9.6", "--no-restart"] },
    ]) {
      expect(() =>
        assertLegacyDriver(changed, { ...changed, exitCode: 0 }, baseline, candidate),
      ).toThrow();
    }
    expect(() =>
      assertLegacyDriver(started, { ...started, exitCode: 1 }, baseline, candidate),
    ).toThrow();
  });

  it("does not count already-current, empty, or wrong-baseline reports as an upgrade", () => {
    const result = {
      status: "ok",
      before: { version: baseline.version },
      after: { version: candidate.version },
      steps: [{ name: "package swap", exitCode: 0 }],
    };
    expect(() => assertLegacyUpdateResult(result, baseline, candidate)).not.toThrow();
    for (const changed of [
      { ...result, status: "skipped", reason: "already-current" },
      { ...result, steps: [] },
      { ...result, before: { version: "2026.9.4" } },
      { ...result, after: { version: "2026.9.7" } },
    ]) {
      expect(() => assertLegacyUpdateResult(changed, baseline, candidate)).toThrow();
    }
  });

  it("requires native IDs, profile and lease custody, not only config presence", () => {
    expect(() => assertLegacyEnvironment(environment, environment, "ready")).not.toThrow();
    for (const key of ["profileId", "providerId", "leaseId", "state", "error"]) {
      const changed = { ...environment, worker: { ...environment.worker, [key]: "changed" } };
      expect(() => assertLegacyEnvironment(changed, environment, "ready")).toThrow();
    }
    expect(() =>
      assertLegacyEnvironment({ ...environment, id: "duplicate" }, environment, "ready"),
    ).toThrow();
  });

  it("rejects duplicate allocation, teardown, wrong installed build, or emergency-only cleanup", () => {
    const expected = [{ leaseId: lease.leaseId, commit: lease.build.commit, destroyed: true }];
    expect(() => assertLegacyBackend({ leases: [lease] }, expected)).not.toThrow();
    for (const changed of [
      { ...lease, allocations: 2 },
      { ...lease, allocateCalls: 2 },
      { ...lease, launches: 2 },
      { ...lease, destroyCalls: 2 },
      { ...lease, destructions: 0 },
      { ...lease, running: true },
      { ...lease, cleanup: true },
      { ...lease, groupJoined: false },
      { ...lease, build: { commit: "wrong" } },
    ]) {
      expect(() => assertLegacyBackend({ leases: [changed] }, expected)).toThrow();
    }
    expect(() => assertLegacyBackend({ leases: [lease, lease] }, expected)).toThrow();
    expect(() => assertLegacyBackend({ leases: [] }, expected)).toThrow();
  });

  it("keeps the external registration on the published V0 contract", () => {
    const providers: Array<Record<string, unknown>> = [];
    // Unit shape check only; acceptance installs through the real plugin CLI.
    legacyPlugin.register({
      registerWorkerProvider: (provider: Record<string, unknown>) => providers.push(provider),
    });
    expect(providers).toHaveLength(1);
    expect(providers[0]).not.toHaveProperty("liveAuthorityVersion");
    for (const method of ["resolveAllocation", "provision", "inspect", "destroy"]) {
      expect(providers[0]?.[method]).toBeTypeOf("function");
    }
    const source = fs.readFileSync(
      new URL(
        "../../scripts/e2e/lib/upgrade-survivor/fixtures/legacy-worker-provider/index.mjs",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).not.toMatch(/\bimport\s/u);
    expect(source).not.toContain("options.assertCurrent");
    const runner = fs.readFileSync(
      new URL("../../scripts/e2e/lib/upgrade-survivor/run.sh", import.meta.url),
      "utf8",
    );
    const start = runner.indexOf(
      'if [ "$LEGACY_WORKER_CELL" = "1" ]; then',
      runner.indexOf("phase initialize-state"),
    );
    const scenario = runner.slice(
      start,
      runner.indexOf('if [ "$SCENARIO" = "dreaming-cron-doctor" ]; then', start),
    );
    expect(scenario).toContain("phase legacy-worker-update update_candidate");
    expect(scenario).not.toContain("npm install");
    expect(scenario.indexOf("legacy-worker-native-before")).toBeLessThan(
      scenario.indexOf("legacy-worker-update update_candidate"),
    );
    expect(scenario.indexOf("legacy-worker-installed-identity")).toBeLessThan(
      scenario.indexOf("legacy-worker-candidate-start"),
    );
  });
});

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import {
  preflightStateMigrationMocks as preflight,
  resetStateMigrationPreflightMocks,
} from "./doctor-config-preflight.state-migration.test-harness.js";
import { startupCheckpointOptions } from "./doctor-config-preflight.state-migration.test-helpers.js";
import { cleanupStartupPluginSourceCaptures } from "./startup-plugin-source-captures.js";

const mocks = vi.hoisted(() => ({
  maintenance: vi.fn(),
  prune: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("./doctor-sqlite-maintenance-lock.js", () => ({
  withDoctorSqliteMaintenanceLock: mocks.maintenance,
}));
vi.mock("../plugins/plugin-source-capture-report.js", () => ({
  pruneUnreferencedPluginNativeCaptures: mocks.prune,
}));

const temp = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;
let authorityLive = false;
const assertCurrent = () => {
  if (!authorityLive) {
    throw new Error("maintenance authority expired");
  }
};

beforeEach(async () => {
  resetStateMigrationPreflightMocks();
  stateDir = temp.make("startup-capture-cleanup-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  await fs.mkdir(path.join(stateDir, "tmp", "plugin-captures"), { recursive: true });
  mocks.prune.mockResolvedValue({ removed: [], warnings: [] });
  mocks.maintenance.mockImplementation(async ({ run }) => {
    authorityLive = true;
    try {
      return await run({ assertCurrent });
    } finally {
      authorityLive = false;
    }
  });
  vi.spyOn(process, "emitWarning").mockImplementation(mocks.warning);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("settles capture reclamation under custody before Gateway plugin verification", async () => {
  const started = createDeferred();
  const finish = createDeferred();
  mocks.prune.mockImplementationOnce(async (_state, assertAdmission) => {
    assertAdmission();
    started.resolve();
    await finish.promise;
    assertAdmission();
    return { removed: [], warnings: [] };
  });
  preflight.runActivePluginPayloadSmokeCheck.mockImplementationOnce(async () => {
    expect(authorityLive).toBe(false);
    return { checked: [], failures: [] };
  });
  const startup = runDoctorConfigPreflight({ ...startupCheckpointOptions, migrateState: false });
  expect(
    await Promise.race([
      started.promise.then(() => "cleanup"),
      startup.then(() => "startup complete"),
    ]),
  ).toBe("cleanup");
  expect(preflight.runActivePluginPayloadSmokeCheck).not.toHaveBeenCalled();
  finish.resolve();
  await expect(startup).resolves.toHaveProperty("snapshot.valid", true);
  expect(preflight.runActivePluginPayloadSmokeCheck).toHaveBeenCalledOnce();
  expect(mocks.prune).toHaveBeenCalledWith(stateDir, expect.any(Function), expect.any(Object), {
    startup: true,
  });
});

it("cleans up only after the Gateway state-preparation guard accepts", async () => {
  const guard = vi.fn(async () => false);
  const options = {
    ...startupCheckpointOptions,
    migrateState: false,
    beforeStateMigrations: guard,
  };
  await expect(runDoctorConfigPreflight(options)).rejects.toThrow("selected config changed");
  expect(mocks.maintenance).not.toHaveBeenCalled();
  guard.mockResolvedValue(true);
  await runDoctorConfigPreflight(options);
  expect(mocks.prune).toHaveBeenCalledOnce();
});

it.each(["observe", "artifact-preserving"])(
  "leaves captures untouched during %s reads",
  async (kind) => {
    const run = () =>
      runDoctorConfigPreflight({
        ...startupCheckpointOptions,
        migrateState: false,
        ...(kind === "observe" ? { observe: false } : {}),
      });
    if (kind === "artifact-preserving") {
      await withArtifactPreservingStateReads(run);
    } else {
      await run();
    }
    expect(mocks.maintenance).not.toHaveBeenCalled();
  },
);

it.each(["busy", "cleanup"])(
  "continues startup with one warning after %s refusal",
  async (kind) => {
    const reason = "fixture capture cleanup unavailable";
    if (kind === "busy") {
      mocks.maintenance.mockRejectedValueOnce(new Error(reason));
    } else {
      mocks.prune.mockResolvedValueOnce({ removed: [], warnings: [reason] });
    }
    await expect(
      runDoctorConfigPreflight({ ...startupCheckpointOptions, migrateState: false }),
    ).resolves.toHaveProperty("snapshot.valid", true);
    expect(mocks.warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(reason));
    expect(preflight.runActivePluginPayloadSmokeCheck).toHaveBeenCalledOnce();
  },
);

it("does not acquire maintenance or create state for a profile without captures", async () => {
  const absent = path.join(stateDir, "absent");
  await cleanupStartupPluginSourceCaptures({ OPENCLAW_STATE_DIR: absent });
  expect(mocks.maintenance).not.toHaveBeenCalled();
  await expect(fs.stat(absent)).rejects.toMatchObject({ code: "ENOENT" });
});

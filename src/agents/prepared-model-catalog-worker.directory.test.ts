import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureClawInstallSchemaVersionFacts } from "../claws/provenance-runtime-read.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import "../claws/tool-policy-runtime.js";
import * as workerCpu from "../infra/worker-cpu.js";
import * as sourceCapture from "../plugins/plugin-source-capture-directory.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { unregisterResolvedAgentDir } from "./agent-dir-registry.js";
import { resolveAgentDir } from "./agent-scope-config.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import { createCatalogPool } from "./prepared-model-catalog-pool.js";
import { createPreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.js";
import {
  createCatalogFixture,
  EXTERNAL_AUTH_PATH_ENV,
  PROVIDER_ID,
  REF_ONLY_API_ENV,
  REF_ONLY_TOKEN_ENV,
} from "./prepared-model-catalog-worker.test-support.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import { createCatalogInspectionPool } from "./test-helpers/prepared-model-catalog-inspection.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();

function createFixture() {
  const fixture = createCatalogFixture(makeTempDir, 0);
  for (const name of [
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_WORKER_CATALOG_MARKER",
    EXTERNAL_AUTH_PATH_ENV,
    REF_ONLY_API_ENV,
    REF_ONLY_TOKEN_ENV,
  ] as const) {
    vi.stubEnv(name, fixture.env[name]);
  }
  return fixture;
}

describe("catalog request existing directory ownership", () => {
  beforeEach(() => {
    vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-directory-request-empty-codex-"));
  });

  it("retries unused catalog capture cleanup after a shared close attempt fails", async () => {
    const fixture = createFixture();
    const entered = createDeferredCore();
    const refusalGate = createDeferredCore();
    const failure = Object.assign(new Error("Fixture capture removal refused once"), {
      code: "EPERM",
    });
    let capture:
      | Awaited<ReturnType<typeof sourceCapture.createPluginSourceCaptureRootAsync>>
      | undefined;
    const acquire = sourceCapture.createPluginSourceCaptureRootAsync;
    const observing = vi
      .spyOn(sourceCapture, "createPluginSourceCaptureRootAsync")
      .mockImplementation(async (...args) => {
        capture = await acquire(...args);
        return capture;
      });
    const pool = await createCatalogPool(fixture.env, () => {
      throw new Error("An unused pool must not receive a worker result");
    });
    if (!capture) {
      await pool.close();
      throw new Error("Expected the catalog pool's actual source capture");
    }
    const original = capture;
    const root = path.dirname(path.dirname(original.directory));
    const release = vi.spyOn(original, "release");
    const remove = fsPromises.rm.bind(fsPromises);
    let refused = false;
    const removing = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
      if (target === path.join(root, "captures") && !refused) {
        refused = true;
        entered.resolve();
        await refusalGate.promise;
        throw failure;
      }
      await remove(target, options);
    });
    const outcomes: Array<Promise<unknown>> = [];
    try {
      expect(pool.getSnapshot().workersCreated).toBe(0);
      const first = pool.close();
      const firstFailure = first.catch((error: unknown) => error);
      outcomes.push(firstFailure);
      const phase = await Promise.race([
        entered.promise.then(() => "removal-entered"),
        firstFailure.then(() => "close-settled"),
      ]);
      expect(phase).toBe("removal-entered");
      const second = pool.close();
      const secondFailure = second.catch((error: unknown) => error);
      outcomes.push(secondFailure);
      expect(release.mock.calls.length).toBe(1);
      refusalGate.resolve();
      expect((await firstFailure) === failure).toBe(true);
      expect((await secondFailure) === failure).toBe(true);
      expect(fs.existsSync(root)).toBe(true);
      const retry = await pool.close().then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
      expect(release.mock.calls.length).toBe(2);
      expect(retry.ok).toBe(true);
      expect(pool.getSnapshot().workersCreated).toBe(0);
      expect(fs.existsSync(root)).toBe(false);
    } finally {
      refusalGate.resolve();
      await Promise.allSettled(outcomes);
      removing.mockRestore();
      release.mockRestore();
      observing.mockRestore();
      await Promise.allSettled([pool.close()]);
      await original.release();
    }
  });

  it("captures the catalog environment before lazy worker startup", async () => {
    const fixture = createFixture();
    const prepared = await prepareWorkspaceBuildGroup(
      [{ agentId: "main", agentDir: fixture.agentDir, config: fixture.config, env: fixture.env }],
      "static",
    );
    retireAfterTest(retainPreparedPluginGeneration(prepared.pluginGeneration));
    const value = createPreparedModelCatalogWorkerInput({
      agentFacts: prepared.agentFacts[0]!,
      pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
      cliBackendModels: prepared.pluginGeneration.cliBackendModels,
    });
    const expectedState = fixture.env.OPENCLAW_STATE_DIR;
    if (!expectedState) {
      throw new Error("Catalog fixture omitted its state root");
    }
    const constructorEnv = { ...fixture.env };
    const tracking = vi.mocked(workerCpu.createCpuTrackedWorker);
    const construct = tracking.getMockImplementation();
    if (!construct) {
      throw new Error("Catalog fixture worker tracking is unavailable");
    }
    const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.preparedModelCatalog).href;
    let stateAtStart: string | undefined;
    let captureDirectory: string | undefined;
    tracking.mockImplementation((...args) => {
      if (String(args[0]) === workerUrl) {
        const options = args[1];
        stateAtStart =
          typeof options?.env === "object" ? options.env.OPENCLAW_STATE_DIR : undefined;
        const data: unknown = options?.workerData;
        if (isRecord(data) && typeof data.sourceCaptureDirectory === "string") {
          captureDirectory = data.sourceCaptureDirectory;
        }
      }
      return construct(...args);
    });
    let pool: Awaited<ReturnType<typeof createCatalogPool>> | undefined;
    try {
      pool = await createCatalogPool(constructorEnv, (result) => {
        expect(result.status).toBe("ok");
      });
      expect(pool.getSnapshot().workersCreated).toBe(0);
      constructorEnv.OPENCLAW_STATE_DIR = makeTempDir("catalog-later-state-");
      const result = await pool.run(
        {
          value,
          request: {
            kind: "catalog",
            syntheticAuth: [],
            clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: fixture.env }),
          },
        },
        { timeoutMs: 30_000 },
      );
      expect(stateAtStart).toBe(expectedState);
      if (!captureDirectory) {
        throw new Error("Catalog worker did not expose its original capture directory");
      }
      expect(
        captureDirectory.startsWith(
          path.join(fs.realpathSync(expectedState), "tmp", "plugin-captures") + path.sep,
        ),
      ).toBe(true);
      expect(fs.existsSync(captureDirectory)).toBe(true);
      if (result.status !== "ok" || result.kind !== "catalog") {
        throw new Error("Catalog fixture did not complete its real request");
      }
      expect(
        result.snapshot.entries.some(
          (entry) => entry.provider === PROVIDER_ID && entry.id === "plugin-generation-v1",
        ),
      ).toBe(true);
    } finally {
      try {
        await pool?.close();
      } finally {
        tracking.mockImplementation(construct);
      }
    }
    expect(captureDirectory !== undefined && fs.existsSync(captureDirectory)).toBe(false);
  });

  it("serves repeated catalog requests from prepared provenance without copying shared state", async () => {
    const fixture = createFixture();
    const prepared = await prepareWorkspaceBuildGroup(
      [{ agentId: "main", agentDir: fixture.agentDir, config: fixture.config, env: fixture.env }],
      "static",
    );
    retireAfterTest(retainPreparedPluginGeneration(prepared.pluginGeneration));
    const value = createPreparedModelCatalogWorkerInput({
      agentFacts: prepared.agentFacts[0]!,
      pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
      cliBackendModels: prepared.pluginGeneration.cliBackendModels,
    });
    const database = openOpenClawStateDatabase({ env: fixture.env });
    const clawInstallSchemaVersions = captureClawInstallSchemaVersionFacts({ env: fixture.env });
    await closeOpenClawStateDatabaseByPathAsync(database.path);
    const { pool } = await createCatalogInspectionPool(fixture.env);
    try {
      for (let tick = 0; tick < 3; tick++) {
        const { inspection, ...result } = await pool.run(
          {
            value,
            request: { kind: "catalog", syntheticAuth: [], clawInstallSchemaVersions },
            ...(tick === 0 ? { inspection: { copyProbePath: database.path } } : {}),
          },
          { timeoutMs: 30_000 },
        );
        expect(result).toMatchObject({
          status: "ok",
          kind: "catalog",
          snapshot: {
            entries: expect.arrayContaining([
              expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
            ]),
          },
        });
        expect(inspection.sqliteCopies).toBe(0);
        if (tick === 0) {
          expect(inspection.copyHookObserved).toBe(true);
        }
      }
    } finally {
      await pool.close();
      await closeOpenClawStateDatabaseByPathAsync(database.path);
    }
  });

  it.each([
    { label: "same normalized owner", existing: ["MAIN"], conflict: false },
    { label: "foreign owner", existing: ["foreign"], conflict: true },
    { label: "ambiguous owners", existing: ["main", "foreign"], conflict: true },
  ])("preserves $label across the request", async ({ existing, conflict }) => {
    const fixture = createFixture();
    const config = {
      ...fixture.config,
      agents: {
        ...fixture.config.agents,
        entries: { main: { agentDir: path.join(fixture.root, "custom-owner", "agent") } },
      },
    } satisfies OpenClawConfig;
    const agentDir = resolveAgentDir(config, "main", fixture.env);
    retireAfterTest(() => {
      unregisterResolvedAgentDir({ agentId: "main", agentDir, env: fixture.env });
      unregisterResolvedAgentDir({ agentId: "foreign", agentDir, env: fixture.env });
    });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [`${PROVIDER_ID}:main`]: {
            type: "api_key",
            provider: PROVIDER_ID,
            key: "existing-owner-key-not-real",
          },
        },
      },
      agentDir,
    );
    const prepared = await prepareWorkspaceBuildGroup(
      [{ agentId: "main", agentDir, inheritedAuthDir: agentDir, config, env: fixture.env }],
      "static",
    );
    retireAfterTest(retainPreparedPluginGeneration(prepared.pluginGeneration));
    const value = structuredClone(
      createPreparedModelCatalogWorkerInput({
        agentFacts: prepared.agentFacts[0]!,
        pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
        cliBackendModels: prepared.pluginGeneration.cliBackendModels,
      }),
    );
    unregisterResolvedAgentDir({ agentId: "main", agentDir, env: fixture.env });
    const { pool } = await createCatalogInspectionPool(fixture.env);
    let completed: Awaited<ReturnType<typeof pool.run>>;
    try {
      completed = await pool.run(
        {
          value,
          request: {
            kind: "catalog",
            syntheticAuth: [],
            clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: fixture.env }),
          },
          inspection: { existingAgentIds: existing },
        },
        { timeoutMs: 30_000 },
      );
    } finally {
      await pool.close();
    }
    const { inspection, ...result } = completed;
    if (conflict) {
      expect(result).toEqual({
        status: "failed",
        error: `Conflicting registered agent owners for ${agentDir}`,
      });
      expect(fs.existsSync(fixture.marker)).toBe(false);
      expect(inspection.foreignReleased).toBe(true);
    } else {
      expect(result).toMatchObject({
        status: "ok",
        kind: "catalog",
        snapshot: {
          entries: expect.arrayContaining([
            expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
          ]),
        },
      });
      expect(fs.readFileSync(fixture.marker, "utf8")).toBe("start\ndone\n");
    }
    expect(inspection.registeredAgentId).toBe(
      existing.some((agentId) => agentId.toLowerCase() === "main") ? "main" : undefined,
    );
  });
});

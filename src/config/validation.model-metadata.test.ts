import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

const mockLoadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn((): PluginManifestRegistry => ({ diagnostics: [], plugins: [] })),
);

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: () => mockLoadPluginManifestRegistry(),
  resolveManifestContractPluginIds: () => [],
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: () => mockLoadPluginManifestRegistry(),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: () => ({ manifestRegistry: mockLoadPluginManifestRegistry() }),
  resolvePluginMetadataSnapshot: () => ({ manifestRegistry: mockLoadPluginManifestRegistry() }),
}));

vi.mock("../plugins/doctor-contract-registry.js", () => ({
  collectDoctorConfigRepairPluginIds: () => [],
  collectRelevantDoctorPluginIds: () => [],
  listPluginDoctorLegacyConfigRules: () => [],
  applyPluginDoctorCompatibilityMigrations: () => ({ next: null, changes: [] }),
}));

vi.mock("../secrets/target-registry-data.js", () => ({
  buildSecretTargetRegistryFromPlugins: () => [],
  getCoreSecretTargetRegistry: () => [],
  getSecretTargetRegistry: () => [],
}));

vi.mock("../channels/plugins/legacy-config.js", () => ({
  collectChannelLegacyConfigRules: () => [],
}));

vi.mock("./zod-schema.js", () => ({
  OpenClawSchema: { safeParse: (raw: unknown) => ({ success: true, data: raw }) },
}));

function createPluginManifestRecord(
  overrides: Partial<PluginManifestRecord> & Pick<PluginManifestRecord, "id">,
): PluginManifestRecord {
  return {
    channels: [],
    cliBackends: [],
    hooks: [],
    manifestPath: `/tmp/${overrides.id}/openclaw.plugin.json`,
    origin: "bundled",
    providers: [],
    rootDir: `/tmp/${overrides.id}`,
    skills: [],
    source: `/tmp/${overrides.id}/index.js`,
    ...overrides,
  };
}

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  mockLoadPluginManifestRegistry.mockReset().mockReturnValue({ diagnostics: [], plugins: [] });
});

describe("validateConfigObjectWithPlugins model metadata", () => {
  it("does not discover plugins when materialization needs no metadata", () => {
    expect(validateConfigObjectWithPlugins({ gateway: { mode: "local" } }).ok).toBe(true);
    expect(mockLoadPluginManifestRegistry).not.toHaveBeenCalled();
  });

  it.each(["full", "skip"] as const)(
    "loads catalog defaults before materialization with %s plugin validation",
    (pluginValidation) => {
      const source = {
        plugins: { enabled: true },
        models: {
          providers: {
            fixture: {
              baseUrl: "https://models.example/v1",
              models: [{ id: "vision-model", name: "Authored model", contextWindow: 64_000 }],
            },
          },
        },
      };
      const original = structuredClone(source);
      const cost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 };
      mockLoadPluginManifestRegistry.mockReturnValue({
        diagnostics: [],
        plugins: [
          createPluginManifestRecord({
            id: "fixture",
            providers: ["fixture"],
            modelCatalog: {
              providers: {
                fixture: {
                  models: [
                    {
                      id: "vision-model",
                      name: "Catalog model",
                      reasoning: true,
                      input: ["text", "image"],
                      cost,
                      contextWindow: 128_000,
                      maxTokens: 16_000,
                    },
                  ],
                },
              },
            },
          }),
        ],
      });

      const result = validateConfigObjectWithPlugins(source, { pluginValidation });

      expect(result).toMatchObject({
        ok: true,
        config: {
          models: {
            providers: {
              fixture: {
                models: [
                  {
                    id: "vision-model",
                    name: "Authored model",
                    reasoning: true,
                    input: ["text", "image"],
                    cost,
                    contextWindow: 64_000,
                    maxTokens: 16_000,
                  },
                ],
              },
            },
          },
        },
      });
      expect(source).toEqual(original);
      expect(mockLoadPluginManifestRegistry).toHaveBeenCalledOnce();
    },
  );
});

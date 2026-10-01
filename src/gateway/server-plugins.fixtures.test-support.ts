import { makeEmptyPluginMetadataOwners } from "../plugins/current-plugin-metadata.test-support.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import type { PluginDiagnostic } from "../plugins/manifest-types.js";
import type { PluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import { buildDeclaredProviderOwnerIndex } from "../plugins/provider-owner-index.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry.js";

export const createRegistry = (diagnostics: PluginDiagnostic[]): PluginRegistry => ({
  ...createEmptyPluginRegistry(),
  diagnostics,
});

export function addLoadedPlugin(
  registry: PluginRegistry,
  params: {
    id: string;
    origin?: PluginRegistry["plugins"][number]["origin"];
    trustedOfficialInstall?: boolean;
  },
): PluginRegistry {
  registry.plugins.push(
    createPluginRecord({
      id: params.id,
      name: params.id,
      source: `/tmp/${params.id}/index.js`,
      origin: params.origin ?? "bundled",
      enabled: true,
      configSchema: false,
      ...(params.trustedOfficialInstall !== undefined
        ? { trustedOfficialInstall: params.trustedOfficialInstall }
        : {}),
    }),
  );
  return registry;
}

export function createDuplexPluginRegistry(command = "image.bridge"): PluginRegistry {
  const registry = addLoadedPlugin(createRegistry([]), { id: "duplex-plugin" });
  registry.nodeHostCommands.push({
    pluginId: "duplex-plugin",
    pluginName: "Duplex plugin",
    command: { command, duplex: true, handle: async () => "{}" },
    source: "test",
  });
  return registry;
}

export function createLookUpTableForTest(params: {
  installRecords?: PluginLookUpTable["index"]["installRecords"];
  manifestRegistry?: PluginLookUpTable["manifestRegistry"];
  pluginIds?: readonly string[];
  workerProviderIds?: readonly string[];
}): PluginLookUpTable {
  const index: PluginLookUpTable["index"] = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 1,
    installRecords: params.installRecords ?? {},
    plugins: [],
    diagnostics: [],
  };
  return {
    policyHash: "test",
    index,
    registryIndex: index,
    registryDiagnostics: [],
    manifestRegistry: params.manifestRegistry ?? { plugins: [], diagnostics: [] },
    plugins: [],
    diagnostics: [],
    byPluginId: new Map(),
    normalizePluginId: (pluginId) => pluginId,
    declaredProviderOwners: buildDeclaredProviderOwnerIndex(params.manifestRegistry?.plugins ?? []),
    owners: makeEmptyPluginMetadataOwners(),
    startup: {
      channelPluginIds: [],
      pluginIds: params.pluginIds ?? [],
    },
    workerProviderIds: params.workerProviderIds ?? [],
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      startupPlanMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: 0,
      startupPluginCount: params.pluginIds?.length ?? 0,
    },
  };
}

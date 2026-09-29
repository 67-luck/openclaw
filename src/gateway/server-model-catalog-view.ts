import type { PreparedCliBackendModelIdentity } from "../plugins/cli-backend.types.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PreparedGatewayModelCatalog } from "./server-model-catalog.types.js";

// Captured facts follow their view's lifetime without widening the public Gateway context.
type PreparedGatewayModelCatalogFacts = {
  metadataSnapshot?: PluginMetadataSnapshot;
  cliBackendModels?: readonly PreparedCliBackendModelIdentity[];
};
const factsByCatalog = new WeakMap<PreparedGatewayModelCatalog, PreparedGatewayModelCatalogFacts>();

export function createPreparedGatewayModelCatalog(
  params: PreparedGatewayModelCatalog & PreparedGatewayModelCatalogFacts,
): PreparedGatewayModelCatalog {
  const catalog: PreparedGatewayModelCatalog = {
    entries: params.entries,
    routeVariants: params.routeVariants,
    pluginRegistry: params.pluginRegistry,
  };
  bindPreparedGatewayModelCatalogFacts(catalog, {
    metadataSnapshot: params.metadataSnapshot,
    cliBackendModels: params.cliBackendModels,
  });
  return catalog;
}

export function bindPreparedGatewayModelCatalogFacts(
  catalog: PreparedGatewayModelCatalog,
  facts: PreparedGatewayModelCatalogFacts,
): void {
  factsByCatalog.set(catalog, facts);
}

export function readPreparedGatewayModelCatalogMetadata(
  catalog: PreparedGatewayModelCatalog | undefined,
): PluginMetadataSnapshot | undefined {
  return catalog ? factsByCatalog.get(catalog)?.metadataSnapshot : undefined;
}

export function readPreparedGatewayCliBackendModels(
  catalog: PreparedGatewayModelCatalog | undefined,
): readonly PreparedCliBackendModelIdentity[] | undefined {
  return catalog ? factsByCatalog.get(catalog)?.cliBackendModels : undefined;
}

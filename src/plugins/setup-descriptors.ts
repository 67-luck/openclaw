// Builds setup descriptors from plugin provider and manifest metadata.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PluginManifestRecord } from "./manifest-registry.types.js";

type SetupDescriptorRecord = Pick<
  PluginManifestRecord,
  "providers" | "cliBackends" | "providerAuthAliases" | "setup"
>;

/** Lists setup provider ids and auth aliases owned by one plugin manifest. */
export function listSetupProviderIds(record: SetupDescriptorRecord): readonly string[] {
  const providerIds = record.setup?.providers?.map((entry) => entry.id) ?? record.providers;
  const normalizedProviderIds = new Set(providerIds.map(normalizeProviderId));
  const aliases = Object.entries(record.providerAuthAliases ?? {})
    .filter(
      ([, target]) =>
        typeof target === "string" && normalizedProviderIds.has(normalizeProviderId(target)),
    )
    .map(([alias]) => alias);
  return [...providerIds, ...aliases];
}

/** Lists setup CLI backend ids from setup metadata or manifest contribution ids. */
export function listSetupCliBackendIds(record: SetupDescriptorRecord): readonly string[] {
  return record.setup?.cliBackends ?? record.cliBackends;
}

type PluginSetupRegistryDiagnosticCode =
  | "setup-descriptor-runtime-disabled"
  | "setup-descriptor-provider-runtime-undeclared"
  | "setup-descriptor-cli-backend-missing-runtime"
  | "setup-descriptor-cli-backend-runtime-undeclared"
  | "setup-entry-load-failed"
  | "setup-registration-failed";

export type PluginSetupRegistryDiagnostic = {
  pluginId: string;
  code: PluginSetupRegistryDiagnosticCode;
  declaredId?: string;
  runtimeId?: string;
  message: string;
};

type SetupProviderIdentity = {
  id: string;
  aliases?: readonly string[];
  hookAliases?: readonly string[];
};

export function matchesProvider(provider: SetupProviderIdentity, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  if (normalizeProviderId(provider.id) === normalized) {
    return true;
  }
  return [...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].some(
    (alias) => normalizeProviderId(alias) === normalized,
  );
}

function mapNormalizedIds(ids: readonly string[]): Map<string, string> {
  const mapped = new Map<string, string>();
  for (const id of ids) {
    const normalized = normalizeProviderId(id);
    if (!normalized || mapped.has(normalized)) {
      continue;
    }
    mapped.set(normalized, id);
  }
  return mapped;
}

export function pushSetupDescriptorDriftDiagnostics(params: {
  record: PluginManifestRecord;
  providers: readonly SetupProviderIdentity[];
  cliBackends: readonly { id: string }[];
  diagnostics: PluginSetupRegistryDiagnostic[];
}): void {
  const declaredProviderIds = params.record.setup?.providers?.map((entry) => entry.id);
  if (declaredProviderIds) {
    for (const provider of params.providers) {
      if (!declaredProviderIds.some((declaredId) => matchesProvider(provider, declaredId))) {
        params.diagnostics.push({
          pluginId: params.record.id,
          code: "setup-descriptor-provider-runtime-undeclared",
          runtimeId: provider.id,
          message: `setup runtime registered provider "${provider.id}" but setup.providers does not declare it.`,
        });
      }
    }
  }

  const declaredCliBackendIds = params.record.setup?.cliBackends;
  if (declaredCliBackendIds) {
    const declaredCliBackends = mapNormalizedIds(declaredCliBackendIds);
    const runtimeCliBackends = mapNormalizedIds(params.cliBackends.map((backend) => backend.id));
    for (const [normalized, declaredId] of declaredCliBackends) {
      if (!runtimeCliBackends.has(normalized)) {
        params.diagnostics.push({
          pluginId: params.record.id,
          code: "setup-descriptor-cli-backend-missing-runtime",
          declaredId,
          message: `setup.cliBackends declares "${declaredId}" but setup runtime did not register a matching CLI backend.`,
        });
      }
    }
    for (const [normalized, runtimeId] of runtimeCliBackends) {
      if (!declaredCliBackends.has(normalized)) {
        params.diagnostics.push({
          pluginId: params.record.id,
          code: "setup-descriptor-cli-backend-runtime-undeclared",
          runtimeId,
          message: `setup runtime registered CLI backend "${runtimeId}" but setup.cliBackends does not declare it.`,
        });
      }
    }
  }
}

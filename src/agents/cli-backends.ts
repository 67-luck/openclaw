/**
 * Resolves CLI runtime backends registered by plugins or setup metadata.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextEngineHostCapability } from "../context-engine/types.js";
import type {
  CliBackendConfig,
  CliBackendRuntimeArtifactPolicy,
  PreparedCliBackendModelIdentity,
} from "../plugins/cli-backend.types.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  resolvePluginSetupCliBackend,
  resolvePluginSetupRegistry,
  selectPluginSetupCliBackendLookup,
} from "../plugins/setup-registry.js";
import { resolvePluginSetupCliBackendDescriptor } from "../plugins/setup-registry.runtime.js";
import { resolveRuntimeTextTransforms } from "../plugins/text-transforms.runtime.js";
import type {
  CliBackendAuthEpochMode,
  CliBackendNormalizeConfigContext,
  CliBundleMcpMode,
  CliBackendPlugin,
  CliBackendNativeToolMode,
  CliBackendSideQuestionToolMode,
  CliBackendToolAvailabilityEnforcement,
  PluginTextTransforms,
} from "../plugins/types.js";
import { mergePluginTextTransforms } from "./plugin-text-transforms.js";

type CliBackendsDeps = {
  resolvePluginSetupCliBackend: typeof resolvePluginSetupCliBackend;
  resolvePluginSetupRegistry: typeof resolvePluginSetupRegistry;
  resolveRuntimeCliBackends: typeof resolveRuntimeCliBackends;
};

const defaultCliBackendsDeps: CliBackendsDeps = {
  resolvePluginSetupCliBackend,
  resolvePluginSetupRegistry,
  resolveRuntimeCliBackends,
};

let cliBackendsDeps: CliBackendsDeps = defaultCliBackendsDeps;

/** Fully merged CLI backend definition used by agent runner execution. */
export type ResolvedCliBackend = {
  id: string;
  modelProvider?: string;
  config: CliBackendConfig;
  bundleMcp: boolean;
  bundleMcpMode?: CliBundleMcpMode;
  pluginId?: string;
  transformSystemPrompt?: CliBackendPlugin["transformSystemPrompt"];
  textTransforms?: PluginTextTransforms;
  defaultAuthProfileId?: string;
  authEpochMode?: CliBackendAuthEpochMode;
  autoSelectAuthProfile?: boolean;
  contextEngineHostCapabilities?: readonly ContextEngineHostCapability[];
  ownsNativeCompaction?: boolean;
  manualCompaction?: CliBackendPlugin["manualCompaction"];
  prepareExecution?: CliBackendPlugin["prepareExecution"];
  resolveExecutionArgs?: CliBackendPlugin["resolveExecutionArgs"];
  resolveModelId?: CliBackendPlugin["resolveModelId"];
  parseJsonlEvent?: CliBackendPlugin["parseJsonlEvent"];
  parseJsonlLifecycleEvent?: CliBackendPlugin["parseJsonlLifecycleEvent"];
  toolAvailabilityEnforcement?: CliBackendToolAvailabilityEnforcement;
  isolatesInstructionsWithExactTools?: true;
  projectNativeToolAuthority?: CliBackendPlugin["projectNativeToolAuthority"];
  nativeToolMode?: CliBackendNativeToolMode;
  sideQuestionToolMode?: CliBackendSideQuestionToolMode;
  runtimeArtifact?: CliBackendRuntimeArtifactPolicy;
};

type ResolvedCliBackendLiveTest = {
  defaultModelRef?: string;
  defaultImageProbe: boolean;
  defaultMcpProbe: boolean;
  dockerNpmPackage?: string;
  dockerBinaryName?: string;
};

/** Binding between a model provider and the CLI runtime that serves it. */
type CliRuntimeModelBackendBinding = {
  provider: string;
  runtime: string;
  pluginId?: string;
};

type CliBackendModelSource = Pick<CliBackendPlugin, "id" | "modelProvider"> & { pluginId?: string };

function normalizeBundleMcpMode(
  mode: CliBundleMcpMode | undefined,
  enabled: boolean,
): CliBundleMcpMode | undefined {
  if (!enabled) {
    return undefined;
  }
  return mode ?? "claude-config-file";
}

function resolveRegisteredBackend(provider: string) {
  const normalized = normalizeProviderId(provider);
  return cliBackendsDeps
    .resolveRuntimeCliBackends()
    .find((entry) => normalizeProviderId(entry.id) === normalized);
}

function resolveCliBackendModelProvider(
  backend: Pick<CliBackendPlugin, "modelProvider">,
): string | undefined {
  const provider = backend.modelProvider?.trim();
  return provider ? normalizeProviderId(provider) : undefined;
}

function addCliRuntimeModelBinding(
  bindings: Map<string, CliRuntimeModelBackendBinding>,
  params: { backend: Pick<CliBackendPlugin, "id" | "modelProvider">; pluginId?: string },
): void {
  const provider = resolveCliBackendModelProvider(params.backend);
  const runtime = normalizeProviderId(params.backend.id);
  if (!provider || !runtime) {
    return;
  }
  bindings.set(`${provider}:${runtime}`, {
    provider,
    runtime,
    ...(params.pluginId ? { pluginId: params.pluginId } : {}),
  });
}

/** Lists model-provider to CLI-runtime bindings from runtime and optional setup registries. */
export function listCliRuntimeModelBackendBindings(
  params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    includeSetupRegistry?: boolean;
    runtimeBackends?: readonly CliBackendModelSource[];
  } = {},
): CliRuntimeModelBackendBinding[] {
  const bindings = new Map<string, CliRuntimeModelBackendBinding>();
  for (const backend of params.runtimeBackends ??
    cliBackendsDeps.resolveRuntimeCliBackends("metadata")) {
    addCliRuntimeModelBinding(bindings, {
      backend,
      ...(backend.pluginId ? { pluginId: backend.pluginId } : {}),
    });
  }
  if (params.includeSetupRegistry === true) {
    for (const entry of cliBackendsDeps.resolvePluginSetupRegistry({
      config: params.config,
      env: params.env,
    }).cliBackends) {
      addCliRuntimeModelBinding(bindings, {
        backend: entry.backend,
        pluginId: entry.pluginId,
      });
    }
  }
  return [...bindings.values()].toSorted((left, right) =>
    left.provider === right.provider
      ? left.runtime.localeCompare(right.runtime)
      : left.provider.localeCompare(right.provider),
  );
}

/** Lists CLI runtime ids that alias canonical model providers. */
export function listCliRuntimeProviderIds(
  params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    includeSetupRegistry?: boolean;
  } = {},
): string[] {
  // Only CLI backends with a canonical modelProvider are runtime aliases that
  // should be hidden from model-provider pickers. Standalone CLI backends own
  // direct refs such as acme-cli/model and must remain selectable.
  return [
    ...new Set(listCliRuntimeModelBackendBindings(params).map((binding) => binding.runtime)),
  ].toSorted();
}

type CliCanonicalSelection =
  | { kind: "ready"; provider: string | undefined }
  | { kind: "setup"; params: Parameters<typeof resolvePluginSetupCliBackend>[0] };

function selectCliCanonicalProvider(
  params: Parameters<typeof resolveCliRuntimeCanonicalProvider>[0],
): CliCanonicalSelection {
  const runtime = normalizeProviderId(params.runtime ?? "");
  if (!runtime) {
    return { kind: "ready", provider: undefined };
  }
  if (params.preparedCliBackendModels !== undefined) {
    return {
      kind: "ready",
      provider: params.preparedCliBackendModels.find((backend) => backend.id === runtime)
        ?.modelProvider,
    };
  }
  const runtimeBinding = listCliRuntimeModelBackendBindings({
    runtimeBackends: params.runtimeBackends,
  }).find((binding) => binding.runtime === runtime);
  if (runtimeBinding) {
    return { kind: "ready", provider: runtimeBinding.provider };
  }
  if (params.includeSetupRegistry !== true) {
    return { kind: "ready", provider: undefined };
  }
  return {
    kind: "setup",
    params: {
      backend: runtime,
      config: params.config,
      env: params.env,
      metadataSnapshot: params.metadataSnapshot,
    },
  };
}

/** Resolves the canonical model provider served by a CLI runtime id. */
export function resolveCliRuntimeCanonicalProvider(params: {
  runtime: string | undefined;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  includeSetupRegistry?: boolean;
  runtimeBackends?: readonly CliBackendModelSource[];
  metadataSnapshot?: PluginMetadataSnapshot;
  preparedCliBackendModels?: readonly PreparedCliBackendModelIdentity[];
}): string | undefined {
  const selected = selectCliCanonicalProvider(params);
  if (selected.kind === "ready") {
    return selected.provider;
  }
  const setupBackend = cliBackendsDeps.resolvePluginSetupCliBackend(selected.params);
  return setupBackend ? resolveCliBackendModelProvider(setupBackend.backend) : undefined;
}

type CliBackendModelIdentityParams = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot: PluginMetadataSnapshot;
  runtimeBackends: readonly CliBackendModelSource[];
};

type SetupCliRead = () => ReturnType<typeof resolvePluginSetupCliBackend>;
type CliIdentitySelection = Generator<
  SetupCliRead,
  readonly PreparedCliBackendModelIdentity[],
  ReturnType<SetupCliRead>
>;

function* selectCliBackendModelIdentities(
  params: CliBackendModelIdentityParams,
): CliIdentitySelection {
  const runtimeIds = new Set(
    params.runtimeBackends.map((backend) => normalizeProviderId(backend.id)),
  );
  const ids = new Set([...runtimeIds, ...params.metadataSnapshot.owners.cliBackends.keys()]);
  const models: PreparedCliBackendModelIdentity[] = [];
  for (const id of [...ids].toSorted()) {
    if (
      !runtimeIds.has(id) &&
      !resolvePluginSetupCliBackendDescriptor({ ...params, backend: id })
    ) {
      continue;
    }
    const selected = selectCliCanonicalProvider({
      ...params,
      runtime: id,
      includeSetupRegistry: true,
    });
    let modelProvider: string | undefined;
    if (selected.kind === "ready") {
      modelProvider = selected.provider;
    } else {
      const read = selectPluginSetupCliBackendLookup(selected.params);
      const setup = typeof read === "function" ? yield read : read;
      modelProvider = setup ? resolveCliBackendModelProvider(setup.backend) : undefined;
    }
    models.push(Object.freeze({ id, ...(modelProvider ? { modelProvider } : {}) }));
  }
  return Object.freeze(models);
}

function finishCliIdentitySelection(
  selection: CliIdentitySelection,
  first = selection.next(),
): readonly PreparedCliBackendModelIdentity[] {
  let next = first;
  while (!next.done) {
    next = selection.next(next.value());
  }
  return next.value;
}

/** Read ready identities without source admission; prepare only at the first selected setup owner. */
export function prepareCliBackendModelIdentitiesWithSource(
  params: CliBackendModelIdentityParams,
  prepareSource: (
    read: () => readonly PreparedCliBackendModelIdentity[],
  ) => Promise<readonly PreparedCliBackendModelIdentity[]>,
):
  | readonly PreparedCliBackendModelIdentity[]
  | Promise<readonly PreparedCliBackendModelIdentity[]> {
  const selection = selectCliBackendModelIdentities(params);
  const first = selection.next();
  return first.done
    ? first.value
    : prepareSource(() => finishCliIdentitySelection(selection, first));
}

/** Resolves the binding for one provider/runtime pair when registered. */
export function resolveCliRuntimeModelBackendBinding(params: {
  provider: string | undefined;
  runtime: string | undefined;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): CliRuntimeModelBackendBinding | undefined {
  const provider = normalizeProviderId(params.provider ?? "");
  const runtime = normalizeProviderId(params.runtime ?? "");
  if (!provider || !runtime) {
    return undefined;
  }
  const runtimeBinding = listCliRuntimeModelBackendBindings().find(
    (binding) =>
      binding.runtime === runtime && (binding.provider === provider || runtime === provider),
  );
  if (runtimeBinding) {
    return runtimeBinding;
  }
  const includeSetupRegistry = params.config !== undefined || params.env !== undefined;
  if (!includeSetupRegistry) {
    return undefined;
  }
  const setupBackend = cliBackendsDeps.resolvePluginSetupCliBackend({
    backend: runtime,
    config: params.config,
    env: params.env,
  });
  if (!setupBackend) {
    return undefined;
  }
  const setupProvider = resolveCliBackendModelProvider(setupBackend.backend);
  return setupProvider && (setupProvider === provider || runtime === provider)
    ? {
        provider: setupProvider,
        runtime,
        ...(setupBackend.pluginId ? { pluginId: setupBackend.pluginId } : {}),
      }
    : undefined;
}

/** Checks whether a runtime is registered to serve a model provider. */
export function isCliRuntimeModelBackendForProvider(params: {
  provider: string | undefined;
  runtime: string | undefined;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return resolveCliRuntimeModelBackendBinding(params) !== undefined;
}

/** Resolves live-test defaults advertised by a CLI backend plugin. */
export function resolveCliBackendLiveTest(provider: string): ResolvedCliBackendLiveTest | null {
  const normalized = normalizeProviderId(provider);
  const entry =
    cliBackendsDeps.resolvePluginSetupCliBackend({ backend: normalized }) ??
    cliBackendsDeps
      .resolveRuntimeCliBackends()
      .find((backend) => normalizeProviderId(backend.id) === normalized);
  if (!entry) {
    return null;
  }
  const backend = "backend" in entry ? entry.backend : entry;
  return {
    defaultModelRef: backend.liveTest?.defaultModelRef,
    defaultImageProbe: backend.liveTest?.defaultImageProbe === true,
    defaultMcpProbe: backend.liveTest?.defaultMcpProbe === true,
    dockerNpmPackage: backend.liveTest?.docker?.npmPackage,
    dockerBinaryName: backend.liveTest?.docker?.binaryName,
  };
}

/** Resolves the executable CLI backend registered by its owning plugin. */
export function resolveCliBackendConfig(
  provider: string,
  cfg?: OpenClawConfig,
  options: { agentId?: string } = {},
): ResolvedCliBackend | null {
  const normalized = normalizeProviderId(provider);
  const normalizeContext: CliBackendNormalizeConfigContext = {
    backendId: normalized,
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(cfg ? { config: cfg } : {}),
  };
  const runtimeTextTransforms = resolveRuntimeTextTransforms();
  const registered = resolveRegisteredBackend(normalized);
  const backend =
    registered ?? cliBackendsDeps.resolvePluginSetupCliBackend({ backend: normalized })?.backend;
  if (!backend) {
    return null;
  }
  const baseConfig = registered ? { ...backend.config } : backend.config;
  const config = backend.normalizeConfig
    ? backend.normalizeConfig(baseConfig, normalizeContext)
    : baseConfig;
  const command = config.command?.trim();
  if (!command) {
    return null;
  }
  const modelProvider = resolveCliBackendModelProvider(backend);
  const bundleMcp = backend.bundleMcp === true;
  return {
    id: normalized,
    ...(modelProvider ? { modelProvider } : {}),
    config: { ...config, command },
    bundleMcp,
    bundleMcpMode: normalizeBundleMcpMode(backend.bundleMcpMode, bundleMcp),
    ...(registered ? { pluginId: registered.pluginId } : {}),
    transformSystemPrompt: backend.transformSystemPrompt,
    textTransforms: mergePluginTextTransforms(runtimeTextTransforms, backend.textTransforms),
    defaultAuthProfileId: backend.defaultAuthProfileId,
    authEpochMode: backend.authEpochMode,
    autoSelectAuthProfile: backend.autoSelectAuthProfile,
    contextEngineHostCapabilities: backend.contextEngineHostCapabilities,
    ownsNativeCompaction: backend.ownsNativeCompaction,
    manualCompaction: backend.manualCompaction,
    prepareExecution: backend.prepareExecution,
    resolveExecutionArgs: backend.resolveExecutionArgs,
    resolveModelId: backend.resolveModelId,
    parseJsonlEvent: backend.parseJsonlEvent,
    parseJsonlLifecycleEvent: backend.parseJsonlLifecycleEvent,
    toolAvailabilityEnforcement: backend.toolAvailabilityEnforcement,
    isolatesInstructionsWithExactTools: backend.isolatesInstructionsWithExactTools,
    projectNativeToolAuthority: backend.projectNativeToolAuthority,
    nativeToolMode: backend.nativeToolMode,
    sideQuestionToolMode: backend.sideQuestionToolMode,
    runtimeArtifact: backend.runtimeArtifact,
  };
}

/** Test-only dependency controls for CLI backend registry resolution. */
const testing = {
  resetDepsForTest(): void {
    cliBackendsDeps = defaultCliBackendsDeps;
  },
  setDepsForTest(deps: Partial<CliBackendsDeps>): void {
    cliBackendsDeps = {
      ...defaultCliBackendsDeps,
      ...deps,
    };
  },
} as const;

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.cliBackendsTestApi")] = testing;
}

import { vi } from "vitest";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import type { PreparedModelRuntimePluginGeneration } from "../prepared-model-runtime.types.js";

const claudeBinding = {
  provider: "anthropic",
  runtime: "claude-cli",
  pluginId: "anthropic",
};

export function captureOverflowCliBackendModels(
  pluginRegistry: PluginRegistry | null,
): PreparedModelRuntimePluginGeneration["cliBackendModels"] {
  return [
    { id: claudeBinding.runtime, modelProvider: claudeBinding.provider },
    ...(pluginRegistry?.cliBackends ?? [])
      .filter(
        ({ backend }) =>
          backend.id !== claudeBinding.runtime || backend.modelProvider !== claudeBinding.provider,
      )
      .map(({ backend }) => ({ id: backend.id, modelProvider: backend.modelProvider })),
  ];
}

export async function createOverflowCliBackendsMock() {
  const actual = await vi.importActual<typeof import("../cli-backends.js")>("../cli-backends.js");
  type ResolveBindingParams = Parameters<typeof actual.resolveCliRuntimeModelBackendBinding>[0];
  type ProviderCheckParams = Parameters<typeof actual.isCliRuntimeModelBackendForProvider>[0];
  return {
    ...actual,
    listCliRuntimeModelBackendBindings: vi.fn((params?: unknown) => [
      claudeBinding,
      ...actual
        .listCliRuntimeModelBackendBindings(
          params as Parameters<typeof actual.listCliRuntimeModelBackendBindings>[0],
        )
        .filter(
          (binding) =>
            binding.provider !== claudeBinding.provider ||
            binding.runtime !== claudeBinding.runtime,
        ),
    ]),
    listCliRuntimeProviderIds: vi.fn(() => ["claude-cli"]),
    resolveCliRuntimeModelBackendBinding: vi.fn((params: ResolveBindingParams) =>
      params.provider === claudeBinding.provider && params.runtime === claudeBinding.runtime
        ? claudeBinding
        : actual.resolveCliRuntimeModelBackendBinding(params),
    ),
    isCliRuntimeModelBackendForProvider: vi.fn((params: ProviderCheckParams) =>
      params.provider === claudeBinding.provider && params.runtime === claudeBinding.runtime
        ? true
        : actual.isCliRuntimeModelBackendForProvider(params),
    ),
  };
}

import type { Mock } from "vitest";
import { resolveAuthStorePathForDisplay } from "../../agents/auth-profiles/paths.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { prepareModelCatalogAuthLabels } from "../../agents/model-catalog-auth-labels.js";
import { bindPreparedModelRuntimeAuth } from "../../agents/prepared-model-runtime-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createModelsTestOwner } from "./commands-models.test-support.js";

export function createDirectiveModelCatalogMock(params: {
  readAuthProfileStore: () => AuthProfileStore;
  getPublishedOwner: Mock<
    typeof import("../../agents/prepared-model-catalog.js").getPublishedPreparedModelCatalogOwnerSnapshot
  >;
}) {
  const entries = [
    { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus" },
    { provider: "localai", id: "ultra-chat", name: "Ultra Chat" },
  ];
  const loadOwner = async (input: {
    config: OpenClawConfig;
    agentId?: string;
    agentDir?: string;
    workspaceDir?: string;
  }) => {
    const owner = await createModelsTestOwner(input.config, entries, input);
    const store = params.readAuthProfileStore();
    bindPreparedModelRuntimeAuth(owner, {
      store,
      labels: prepareModelCatalogAuthLabels({
        config: input.config,
        agentDir: owner.agentDir,
        authStorePath: resolveAuthStorePathForDisplay(owner.agentDir),
        workspaceDir: owner.workspaceDir,
        env: {},
        store,
        providers: [
          "openai",
          "anthropic",
          "openrouter",
          "localai",
          ...Object.keys(input.config.models?.providers ?? {}),
        ],
      }),
    });
    params.getPublishedOwner.mockReturnValue(owner);
    return owner;
  };
  return {
    readPreparedModelCatalog: async () => entries,
    loadProviderScopedThinkingCatalog: async () => entries,
    getPublishedPreparedModelCatalogOwnerSnapshot: params.getPublishedOwner,
    loadPreparedModelCatalogOwnerSnapshot: () => {
      throw new Error("Status must use the published catalog owner");
    },
    loadPublishedPreparedModelCatalogOwnerSnapshot: async (
      ownerInput: Parameters<typeof loadOwner>[0],
    ) => loadOwner(ownerInput),
    materializePreparedModelCatalogOwner: (owner: object) => owner,
  };
}

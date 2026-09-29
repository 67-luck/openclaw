import { expect, it, vi, type Mock } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import type { LoadPreparedModelCatalogParams } from "../agents/prepared-model-catalog.js";
import {
  bindPreparedModelRuntimeAuth,
  bindPreparedModelRuntimeCliBackendModels,
  readPreparedModelRuntimeCliBackendModels,
} from "../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { buildModelsListResult } from "../gateway/server-methods/models-list-result.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { EmbeddedTuiBackend } from "./embedded-backend.js";
import type { TuiModelChoice } from "./tui-backend.js";

export function registerEmbeddedModelCatalogTests({
  createBackend,
  getRuntimeConfigMock,
  loadPreparedModelCatalogMock,
  buildModelsListResultMock,
  withPreparedModelCatalogOwnerMock,
  setPublishedModelCatalog,
  projectSessionsPatchEntryMock,
  projectSessionPatchResultMock,
  applySessionPatchProjectionMock,
  deferred,
  flushMicrotasks,
}: {
  createBackend: () => EmbeddedTuiBackend;
  getRuntimeConfigMock: Mock<() => object>;
  loadPreparedModelCatalogMock: Mock<
    (_params?: LoadPreparedModelCatalogParams) => ModelCatalogEntry[]
  >;
  buildModelsListResultMock: Mock<
    (params: Parameters<typeof buildModelsListResult>[0]) => Promise<{ models: TuiModelChoice[] }>
  >;
  withPreparedModelCatalogOwnerMock: Mock<typeof withEmbeddedModelCatalogOwnerFixture>;
  setPublishedModelCatalog: (catalog: ModelCatalogEntry[]) => void;
  projectSessionsPatchEntryMock: Mock;
  projectSessionPatchResultMock: Mock;
  applySessionPatchProjectionMock: unknown;
  deferred: <T>() => {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error?: unknown) => void;
  };
  flushMicrotasks: () => Promise<void>;
}) {
  it("lists the published configured replace-mode models without a second catalog read", async () => {
    const config = {
      models: {
        mode: "replace" as const,
        providers: {
          fixture: {
            baseUrl: "https://fixture.invalid",
            models: [{ id: "configured", name: "Configured" }],
          },
        },
      },
    };
    getRuntimeConfigMock.mockReturnValue(config);
    const models = [{ id: "configured", name: "Configured", provider: "fixture", available: true }];
    buildModelsListResultMock.mockResolvedValue({ models });

    await expect(createBackend().listModels()).resolves.toEqual(models);
    expect(loadPreparedModelCatalogMock).not.toHaveBeenCalled();
    expect(withPreparedModelCatalogOwnerMock).toHaveBeenCalledWith(
      { config, agentId: "main", readOnly: true },
      expect.any(Function),
    );
  });

  it("preserves an empty published replace catalog without fallback discovery", async () => {
    getRuntimeConfigMock.mockReturnValue({ models: { mode: "replace", providers: {} } });
    await expect(createBackend().listModels()).resolves.toEqual([]);
    expect(loadPreparedModelCatalogMock).not.toHaveBeenCalled();
    expect(buildModelsListResultMock).toHaveBeenCalledOnce();
  });

  it("lists published discovered rows for a replace-mode provider wildcard", async () => {
    getRuntimeConfigMock.mockReturnValue({
      agents: { defaults: { modelPolicy: { allow: ["fixture/*"] } } },
      models: { mode: "replace", providers: { fixture: { models: [{ id: "configured" }] } } },
    });
    const models = [{ id: "discovered", name: "Discovered", provider: "fixture" }];
    buildModelsListResultMock.mockResolvedValue({ models });
    await expect(createBackend().listModels()).resolves.toEqual(models);
    expect(withPreparedModelCatalogOwnerMock).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
      expect.any(Function),
    );
    expect(loadPreparedModelCatalogMock).not.toHaveBeenCalled();
  });

  it("loads the selected agent published projection with its matching owner", async () => {
    const config = {
      agents: {
        ownership: "explicit",
        entries: {
          main: { modelPolicy: { allow: ["fixture/main-model"] } },
          work: { modelPolicy: { allow: ["fixture/work-model"] } },
        },
      },
    };
    getRuntimeConfigMock.mockReturnValue(config);
    buildModelsListResultMock.mockImplementation(async ({ source, agentId, params }) => {
      expect(source.kind).toBe("published");
      if (source.kind !== "published") {
        throw new Error("Expected published owner");
      }
      expect(source.owner.agentId).toBe(agentId);
      expect(source.owner.config).toBe(config);
      expect(params).toEqual({ includeDetails: true });
      const id = source.owner.agentId + "-model";
      return { models: [{ id, name: id, provider: "fixture" }] };
    });
    await expect(createBackend().listModels({ agentId: "work" })).resolves.toEqual([
      { id: "work-model", name: "work-model", provider: "fixture" },
    ]);
  });

  it("preserves an empty restrictive published projection for the selected agent", async () => {
    getRuntimeConfigMock.mockReturnValue({
      agents: {
        ownership: "explicit",
        entries: {
          main: { modelPolicy: { allow: ["openai/*"] } },
          work: { modelPolicy: { allow: ["openai/*"] } },
        },
      },
    });
    await expect(createBackend().listModels({ agentId: "work" })).resolves.toEqual([]);
    expect(buildModelsListResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "work" }),
    );
    expect(loadPreparedModelCatalogMock).not.toHaveBeenCalled();
  });

  it("preserves canonical unavailable and unknown published model facts", async () => {
    const models: TuiModelChoice[] = [
      {
        id: "waiting",
        name: "Waiting",
        provider: "fixture",
        available: false,
        unavailableReason: "cooldown",
      },
      { id: "unknown", name: "Unknown", provider: "fixture" },
    ];
    buildModelsListResultMock.mockResolvedValue({ models });
    await expect(createBackend().listModels()).resolves.toEqual(models);
    expect(loadPreparedModelCatalogMock).not.toHaveBeenCalled();
  });

  it("keeps the published owner alive through asynchronous model projection", async () => {
    const projection = deferred<{ models: TuiModelChoice[] }>();
    let current: (() => boolean) | undefined;
    buildModelsListResultMock.mockImplementation(async ({ source }) => {
      if (source.kind !== "published") {
        throw new Error("Expected published owner");
      }
      current = source.owner.isCurrent;
      expect(current()).toBe(true);
      const result = await projection.promise;
      expect(current()).toBe(true);
      return result;
    });
    const pending = createBackend().listModels();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(current?.()).toBe(true);
    projection.resolve({ models: [] });
    await expect(pending).resolves.toEqual([]);
    expect(current?.()).toBe(false);
  });

  it("patches wildcard sessions with raw execution catalog entries held through result projection", async () => {
    const config = {
      agents: { defaults: { modelPolicy: { allow: ["fixture/*"] } } },
      models: { mode: "replace" },
    };
    getRuntimeConfigMock.mockReturnValue(config);
    const catalog: ModelCatalogEntry[] = [
      { id: "discovered", name: "Discovered", provider: "fixture", api: "openai-completions" },
    ];
    setPublishedModelCatalog(catalog);
    const models = [{ id: "discovered", name: "Discovered", provider: "fixture", available: true }];
    buildModelsListResultMock.mockResolvedValue({ models });
    const validationStarted = deferred<void>();
    const finishValidation = deferred<void>();
    let heldSnapshot: PreparedModelRuntimeSnapshot | undefined;
    projectSessionsPatchEntryMock.mockImplementation(
      async ({
        loadGatewayModelCatalogSnapshot,
      }: {
        loadGatewayModelCatalogSnapshot: () => Promise<{
          entries: unknown[];
          routeVariants: unknown[];
        }>;
      }) => {
        expect(await loadGatewayModelCatalogSnapshot()).toEqual({
          entries: catalog,
          routeVariants: catalog,
        });
        validationStarted.resolve();
        await finishValidation.promise;
        return { ok: true, entry: {} };
      },
    );
    const backend = createBackend();
    await expect(backend.listModels()).resolves.toEqual(models);
    withPreparedModelCatalogOwnerMock.mockClear().mockImplementationOnce((params, read) =>
      withEmbeddedModelCatalogOwnerFixture(
        params,
        async (snapshot) => {
          heldSnapshot = snapshot;
          return await read(snapshot);
        },
        catalog,
      ),
    );
    const projectResult = projectSessionPatchResultMock.getMockImplementation();
    if (!projectResult) {
      throw new Error("Expected the session result projection fixture");
    }
    projectSessionPatchResultMock.mockImplementationOnce((params) => {
      if (!heldSnapshot) {
        throw new Error("Expected the validation catalog owner");
      }
      expect(heldSnapshot.isCurrent()).toBe(true);
      expect(params.metadataSnapshot).toBe(heldSnapshot.metadataSnapshot);
      const cliBackendModels = readPreparedModelRuntimeCliBackendModels(heldSnapshot);
      expect(cliBackendModels).toBeDefined();
      expect(params.preparedCliBackendModels).toBe(cliBackendModels);
      expect(heldSnapshot).not.toHaveProperty("cliBackendModels");
      return projectResult(params);
    });
    const pending = backend.patchSession({ key: "agent:main:main", model: "fixture/discovered" });
    try {
      await Promise.race([validationStarted.promise, pending]);
      expect(heldSnapshot?.isCurrent()).toBe(true);
      expect(projectSessionPatchResultMock).not.toHaveBeenCalled();
    } finally {
      finishValidation.resolve();
      await Promise.allSettled([pending]);
    }
    await expect(pending).resolves.toMatchObject({ ok: true, key: "agent:main:main" });
    expect(heldSnapshot?.isCurrent()).toBe(false);
    expect(projectSessionPatchResultMock).toHaveBeenCalledOnce();
    expect(withPreparedModelCatalogOwnerMock).toHaveBeenCalledExactlyOnceWith(
      { config, agentId: "main", readOnly: true },
      expect.any(Function),
    );
    expect(loadPreparedModelCatalogMock).not.toHaveBeenCalled();
    expect(applySessionPatchProjectionMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKeys: ["agent:main:main"] }),
    );
  });
}

export function registerEmbeddedNonmodelPatchTests({
  createBackend,
  selectedGlobalSessionCases,
  embeddedEventTimestamp,
  getRuntimeConfigMock,
  getPreparedModelCatalogOwnerSnapshotMock,
  withPreparedModelCatalogOwnerMock,
  loadPreparedModelCatalogMock,
  projectSessionsPatchEntryMock,
  projectSessionPatchResultMock,
}: {
  createBackend: () => EmbeddedTuiBackend;
  selectedGlobalSessionCases: ReadonlyArray<{
    input: { sessionKey: string; agentId?: string };
    owner: string;
  }>;
  embeddedEventTimestamp: number;
  getRuntimeConfigMock: Mock<() => object>;
  getPreparedModelCatalogOwnerSnapshotMock: Mock<
    (params: LoadPreparedModelCatalogParams) => undefined
  >;
  withPreparedModelCatalogOwnerMock: Mock<typeof withEmbeddedModelCatalogOwnerFixture>;
  loadPreparedModelCatalogMock: Mock<
    (_params?: LoadPreparedModelCatalogParams) => ModelCatalogEntry[]
  >;
  projectSessionsPatchEntryMock: Mock;
  projectSessionPatchResultMock: Mock;
}) {
  it.each(selectedGlobalSessionCases)(
    "scopes selected global nonmodel patches without an available catalog: $input.sessionKey",
    async ({ input, owner }) => {
      withPreparedModelCatalogOwnerMock.mockRejectedValue(new Error("catalog unavailable"));
      loadPreparedModelCatalogMock.mockImplementation(() => {
        throw new Error("catalog unavailable");
      });
      const sessionUtils = await import("../gateway/session-utils.js");
      const entry = { sessionId: `session-${owner}`, updatedAt: embeddedEventTimestamp };
      const target = {
        agentId: owner,
        canonicalKey: "global",
        storePath: `/tmp/openclaw-${owner}-sessions.json`,
        storeKeys: ["global"],
        store: { global: entry },
      };
      const resolveTarget = vi
        .spyOn(sessionUtils, "resolveGatewaySessionStoreTargetWithStore")
        .mockReturnValue(target);
      const resolveCanonical = vi
        .spyOn(sessionUtils, "resolveCanonicalGatewaySessionStoreKey")
        .mockReturnValue({ target, primaryKey: "global", entry });
      projectSessionsPatchEntryMock.mockResolvedValueOnce({ ok: true, entry });
      const backend = createBackend();
      const patch = {
        key: input.sessionKey,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        fastMode: true,
      };
      try {
        await expect(backend.patchSession(patch)).resolves.toMatchObject({
          ok: true,
          key: "global",
          entry,
        });
        expect.soft(projectSessionsPatchEntryMock).toHaveBeenCalledWith(
          expect.objectContaining({
            storeKey: "global",
            agentId: owner,
            patch,
          }),
        );
        expect.soft(projectSessionPatchResultMock).toHaveBeenCalledWith({
          canonicalKey: "global",
          cfg: expect.anything(),
          entry,
          storePath: target.storePath,
          targetAgentId: owner,
          metadataSnapshot: undefined,
          preparedCliBackendModels: undefined,
        });
        expect(getPreparedModelCatalogOwnerSnapshotMock).toHaveBeenCalledOnce();
        expect(getPreparedModelCatalogOwnerSnapshotMock).toHaveBeenCalledWith({
          config: getRuntimeConfigMock(),
          agentId: owner,
          readOnly: true,
        });
        expect(withPreparedModelCatalogOwnerMock).not.toHaveBeenCalled();
        expect(loadPreparedModelCatalogMock).not.toHaveBeenCalled();
      } finally {
        resolveTarget.mockRestore();
        resolveCanonical.mockRestore();
      }
    },
  );
}

export async function withEmbeddedModelCatalogOwnerFixture(
  params: LoadPreparedModelCatalogParams,
  read: (snapshot: PreparedModelRuntimeSnapshot) => Promise<unknown>,
  catalog: ModelCatalogEntry[] = [],
) {
  const config: OpenClawConfig = params.config ?? {};
  const agentId = params.agentId ?? "main";
  let active = true;
  const snapshot: PreparedModelRuntimeSnapshot = {
    catalogOwner: { agentId, workspaceDir: "/tmp/tui-catalog-workspace" },
    agentId,
    agentDir: "/tmp/tui-catalog-agent",
    activeProjectKeys: [],
    config,
    observationConfig: config,
    isCurrent: () => active,
    authModes: {},
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries: catalog, routeVariants: catalog },
    configuredRuntimeModels: [],
    findConfiguredRuntimeModel: () => undefined,
    inlineProviderModels: [],
    createStores() {
      throw new Error("Catalog projection must not create execution stores");
    },
  };
  bindPreparedModelRuntimeAuth(snapshot, { store: { version: 1, profiles: {} } });
  bindPreparedModelRuntimeCliBackendModels(snapshot, []);
  try {
    return await read(snapshot);
  } finally {
    active = false;
  }
}

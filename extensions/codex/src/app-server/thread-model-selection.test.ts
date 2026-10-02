import { afterEach, describe, expect, it } from "vitest";
import {
  createAppServerOptions,
  createParams,
  resetThreadLifecycleTestFixtures,
} from "./thread-lifecycle.test-fixtures.js";
import {
  resolveCodexAppServerRequestModelSelection,
  resolveCodexAppServerThreadModelSelection,
} from "./thread-model-selection.js";
import { buildThreadResumeParams, buildThreadStartParams } from "./thread-requests.js";
import { buildTurnStartParams } from "./turn-params.js";

const nativeModel = "vendor/native-model";

function createNativeParams(catalogId = nativeModel, providerKey = "codex") {
  const params = createParams("/tmp/native-model-session.jsonl", "/repo");
  params.modelId = nativeModel;
  params.config = {
    models: {
      providers: {
        [providerKey]: {
          baseUrl: "https://native.example.test/v1",
          models: [
            {
              id: catalogId,
              name: "Native model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 4096,
            },
          ],
        },
      },
    },
  };
  return params;
}

afterEach(resetThreadLifecycleTestFixtures);

describe("registered native Codex model selection", () => {
  it.each([
    { catalogId: nativeModel, providerKey: "codex", requestedModel: nativeModel },
    { catalogId: `codex/${nativeModel}`, providerKey: "codex", requestedModel: nativeModel },
    { catalogId: ` ${nativeModel} `, providerKey: " Codex ", requestedModel: nativeModel },
    {
      catalogId: `codex/${nativeModel}`,
      providerKey: "codex",
      requestedModel: `codex/${nativeModel}`,
    },
  ])(
    "keeps $requestedModel intact with catalog $providerKey/$catalogId",
    ({ catalogId, providerKey, requestedModel }) => {
      const params = createNativeParams(catalogId, providerKey);
      params.modelId = requestedModel;
      const appServer = createAppServerOptions();
      // Preflight and the request builders independently resolve the selected model.
      const selection = resolveCodexAppServerThreadModelSelection({
        ...params,
        model: params.modelId,
      });
      const start = buildThreadStartParams(params, { appServer, cwd: "/repo", dynamicTools: [] });
      const resume = buildThreadResumeParams(params, { appServer, threadId: "thread-1" });
      const turn = buildTurnStartParams(params, { appServer, threadId: "thread-1", cwd: "/repo" });
      for (const request of [selection, start, resume, turn]) {
        expect.soft(request.model).toBe(requestedModel);
        expect.soft(request).not.toHaveProperty("modelProvider");
      }
      expect(turn.collaborationMode?.settings.model).toBe(requestedModel);
    },
  );

  it("does not reinterpret an explicit native provider or an exact retained binding", () => {
    const params = createNativeParams();
    expect(
      resolveCodexAppServerRequestModelSelection({
        ...params,
        model: nativeModel,
        modelProvider: "native-proxy",
      }),
    ).toEqual({ model: nativeModel, modelProvider: "native-proxy" });
    expect(
      resolveCodexAppServerThreadModelSelection({
        ...params,
        model: nativeModel,
        binding: { threadId: "thread-1", model: nativeModel, modelProvider: "native-proxy" },
      }),
    ).toEqual({ model: nativeModel, modelProvider: "native-proxy" });
  });

  it("still splits an unregistered provider-qualified override", () => {
    const params = createNativeParams();
    expect(
      resolveCodexAppServerThreadModelSelection({
        ...params,
        model: nativeModel,
        requestModel: "lmstudio/other/model",
      }),
    ).toEqual({ model: "other/model", modelProvider: "lmstudio" });
  });

  it("does not borrow the codex catalog for another provider or an unscoped command", () => {
    const params = createNativeParams();
    expect(
      resolveCodexAppServerThreadModelSelection({
        ...params,
        provider: "openai",
        model: nativeModel,
      }),
    ).toEqual({ model: nativeModel, modelProvider: "openai" });
    expect(
      resolveCodexAppServerRequestModelSelection({ config: params.config, model: nativeModel }),
    ).toEqual({ model: "native-model", modelProvider: "vendor" });
  });

  it("keeps native-preserved resumes and turns free of model overrides", () => {
    const params = createNativeParams();
    const appServer = createAppServerOptions();
    expect(
      buildThreadResumeParams(params, {
        appServer,
        threadId: "thread-1",
        preserveNativeModel: true,
      }),
    ).not.toHaveProperty("model");
    const turn = buildTurnStartParams(params, {
      appServer,
      threadId: "thread-1",
      cwd: "/repo",
      preserveNativeTurnSettings: true,
    });
    expect(turn).not.toHaveProperty("model");
    expect(turn).not.toHaveProperty("collaborationMode");
  });
});

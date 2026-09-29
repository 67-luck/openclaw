import path from "node:path";
import { expect, it, type Mock } from "vitest";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import { buildCodexRuntimeModelParams } from "./model-runtime.js";
import { tempDir, threadStartResult } from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  type writeCodexAppServerBinding as writeRawCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import type { startOrResumeThread as startOrResumeThreadImpl } from "./thread-lifecycle.js";
import { createLeasedCodexLifecycleHarness } from "./thread-lifecycle.test-fixtures.js";

type StartParams = Omit<Parameters<typeof startOrResumeThreadImpl>[0], "bindingStore">;
type LifecycleRespond = (method: string, requestParams?: unknown) => Promise<unknown>;

type ModelCompatibilityFixtures = {
  createParams: (sessionFile: string, workspaceDir: string) => StartParams["params"];
  createLifecycleRequest: (respond: LifecycleRespond) => Mock<LifecycleRespond>;
  startOrResumeThread: (
    params: Pick<StartParams, "client"> & Partial<StartParams>,
  ) => ReturnType<typeof startOrResumeThreadImpl>;
  writeCodexAppServerBinding: typeof writeRawCodexAppServerBinding;
  retainThread: (
    client: StartParams["client"],
    binding: Awaited<ReturnType<typeof startOrResumeThreadImpl>>,
  ) => Promise<boolean>;
  preflightMethods: readonly string[];
  coldResumeMethods: readonly string[];
};

/** Reuse the binding suite's native lifecycle fixtures and database cleanup. */
export function registerThreadModelCompatibilityTests({
  createParams,
  createLifecycleRequest,
  startOrResumeThread,
  writeCodexAppServerBinding,
  retainThread,
  preflightMethods,
  coldResumeMethods,
}: ModelCompatibilityFixtures) {
  it.each([
    { bindingModel: "gpt-5.4-codex", requestedModel: "gpt-5.5", multiAgentVersion: undefined },
    {
      bindingModel: "synthetic-primary",
      requestedModel: "synthetic-fallback",
      multiAgentVersion: "v2",
    },
    {
      bindingModel: "synthetic-primary",
      requestedModel: "gpt-5.6-sol",
      multiAgentVersion: "v2",
    },
  ] as const)(
    "refreshes model and workspace ownership when reusing $bindingModel as $requestedModel",
    async ({ bindingModel, requestedModel, multiAgentVersion }) => {
      const sessionFile = path.join(tempDir, "warm-model-workspace.jsonl");
      const originalWorkspace = path.join(tempDir, "workspace-original");
      const currentWorkspace = path.join(tempDir, "workspace-current");
      const params = createParams(sessionFile, originalWorkspace);
      params.modelId = bindingModel;
      params.model = {
        ...params.model,
        id: bindingModel,
        params: buildCodexRuntimeModelParams(bindingModel, bindingModel, multiAgentVersion),
      };
      const request = createLifecycleRequest(async (method: string) => {
        if (method === "thread/start") {
          const response = threadStartResult("thread-warm-model-workspace", {
            cwd: originalWorkspace,
          });
          response.model = bindingModel;
          return response;
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const client = {
        getInstanceId: () => "client-warm-model-workspace",
        request,
        addNotificationHandler: () => () => undefined,
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      } as never;
      ensureCodexAppServerClientRuntime(client, { agentDir: originalWorkspace });
      const common = {
        client,
        params,
        cwd: originalWorkspace,
        userMcpServersEnabled: false,
      };
      const started = await startOrResumeThread(common);
      await retainThread(client, started);
      params.modelId = requestedModel;
      params.model = {
        ...params.model,
        id: requestedModel,
        params: buildCodexRuntimeModelParams(requestedModel, requestedModel, multiAgentVersion),
      };
      params.workspaceDir = currentWorkspace;

      const reused = await startOrResumeThread({ ...common, cwd: currentWorkspace });

      if (multiAgentVersion) {
        expect(started.nativeMultiAgentVersion).toBe(multiAgentVersion);
      }
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        ...preflightMethods,
        "thread/start",
        ...preflightMethods,
      ]);
      expect(reused).toMatchObject({
        threadId: "thread-warm-model-workspace",
        cwd: currentWorkspace,
        model: requestedModel,
        ...(multiAgentVersion ? { nativeMultiAgentVersion: multiAgentVersion } : {}),
      });
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
        cwd: currentWorkspace,
        model: requestedModel,
        ...(multiAgentVersion ? { nativeMultiAgentVersion: multiAgentVersion } : {}),
      });
    },
  );

  it.each([
    {
      bindingModel: "gpt-5.6-luna",
      requestedModel: "gpt-5.6-sol",
      bindingVersion: undefined,
      requestedVersion: undefined,
    },
    {
      bindingModel: "synthetic-v2-model",
      requestedModel: "synthetic-v1-model",
      bindingVersion: "v2",
      requestedVersion: "v1",
    },
    {
      bindingModel: "synthetic-v2-model",
      requestedModel: "synthetic-disabled-model",
      bindingVersion: "v2",
      requestedVersion: "disabled",
    },
  ] as const)(
    "starts a fresh thread when switching from $bindingModel to $requestedModel",
    async ({ bindingModel, requestedModel, bindingVersion, requestedVersion }) => {
      const sessionFile = path.join(tempDir, `${bindingModel}-${requestedModel}.jsonl`);
      const workspaceDir = path.join(tempDir, "workspace");
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-existing",
        cwd: workspaceDir,
        model: bindingModel,
        ...(bindingVersion ? { nativeMultiAgentVersion: bindingVersion } : {}),
      });
      const params = createParams(sessionFile, workspaceDir);
      params.modelId = requestedModel;
      params.model = {
        ...params.model,
        id: requestedModel,
        params: buildCodexRuntimeModelParams(requestedModel, requestedModel, requestedVersion),
      };
      const request = createLifecycleRequest(async (method: string, requestParams?: unknown) => {
        if (method === "thread/start") {
          const response = threadStartResult("thread-rebound");
          response.model = (requestParams as { model: string }).model;
          return response;
        }
        throw new Error(`unexpected method: ${method}`);
      });

      const binding = await startOrResumeThread({
        client: { request } as never,
        params,
      });

      expect(request.mock.calls.map(([method]) => method)).toEqual([
        ...preflightMethods,
        "thread/start",
      ]);
      expect(request.mock.calls.find(([method]) => method === "thread/start")?.[1]).toMatchObject({
        model: requestedModel,
      });
      expect(binding).toMatchObject({
        threadId: "thread-rebound",
        model: requestedModel,
        lifecycle: { action: "started" },
        ...(requestedVersion ? { nativeMultiAgentVersion: requestedVersion } : {}),
      });
    },
  );

  it.each([
    {
      bindingModel: "gpt-5.6-sol",
      requestedModel: "gpt-5.6-terra",
      bindingVersion: undefined,
      requestedVersion: undefined,
    },
    {
      bindingModel: "synthetic-v2-model",
      requestedModel: "synthetic-unclassified-model",
      bindingVersion: "v2",
      requestedVersion: undefined,
    },
    {
      bindingModel: "synthetic-legacy-model",
      requestedModel: "synthetic-v2-model",
      bindingVersion: undefined,
      requestedVersion: "v2",
    },
  ] as const)(
    "resumes the thread when switching from $bindingModel to $requestedModel",
    async ({ bindingModel, requestedModel, bindingVersion, requestedVersion }) => {
      const sessionFile = path.join(tempDir, `${bindingModel}-${requestedModel}.jsonl`);
      const workspaceDir = path.join(tempDir, "workspace");
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-existing",
        cwd: workspaceDir,
        model: bindingModel,
        ...(bindingVersion ? { nativeMultiAgentVersion: bindingVersion } : {}),
      });
      const params = createParams(sessionFile, workspaceDir);
      params.modelId = requestedModel;
      params.model = {
        ...params.model,
        id: requestedModel,
        params: buildCodexRuntimeModelParams(requestedModel, requestedModel, requestedVersion),
      };
      const respond = createLifecycleRequest(async (method: string, requestParams?: unknown) => {
        if (method === "thread/resume") {
          const response = threadStartResult("thread-existing");
          response.model = (requestParams as { model: string }).model;
          return response;
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond,
        persistedThreads: ["thread-existing"],
      });
      const { client, request } = fixture;

      const binding = await startOrResumeThread({
        client,
        params,
      });

      expect(request.mock.calls.map(([method]) => method)).toEqual(coldResumeMethods);
      expect(request.mock.calls.find(([method]) => method === "thread/resume")?.[1]).toMatchObject({
        threadId: "thread-existing",
        model: requestedModel,
      });
      expect(binding).toMatchObject({
        threadId: "thread-existing",
        model: requestedModel,
        lifecycle: { action: "resumed" },
      });
      expect(binding.nativeMultiAgentVersion).toBe(bindingVersion);
      expect((await readCodexAppServerBinding(sessionFile))?.nativeMultiAgentVersion).toBe(
        bindingVersion,
      );
    },
  );
}

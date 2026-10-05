import { DatabaseSync } from "node:sqlite";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { resolveAgentRunContext } from "../../agents/command/run-context.js";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
} from "../../agents/prepared-model-runtime-generation-scope.js";
import {
  retainPreparedPluginGeneration,
  retainPreparedPluginRegistry,
} from "../../agents/prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "../../agents/prepared-model-runtime.resources.js";
import type { PreparedModelRuntimePluginGeneration } from "../../agents/prepared-model-runtime.types.js";
import { retainRuntimePluginWork } from "../../agents/runtime-plugin-work.js";
import * as runtimePlugins from "../../agents/runtime-plugins.js";
import { SessionFollowupCompletion } from "../../agents/subagents/completion/session-followup-completion.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import type { SessionEntry } from "../../config/sessions.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../../plugins/registry-inspection.test-support.js";
import {
  beginSessionEffect,
  captureSessionTarget,
  getCurrentSessionControllerOwner,
} from "../../sessions/session-controller.lifecycle.js";
import {
  getRpcSourceIdentity,
  getRpcSourceProjectSessionActive,
  isRpcSourceExecuting,
} from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { isWebchatClient } from "../../utils/message-channel.js";
import { registerChatAbortController } from "../chat-abort.js";
import { readGatewayAccessRevision } from "../gateway-access-revision.js";
import { createChatAbortContext } from "../server-methods/chat.abort.test-helpers.js";
import * as sessionChange from "../server-methods/session-change-event.js";
import { prepareSessionLifecycleDrain } from "../server-methods/sessions-lifecycle-drain.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { replayAgentTurnIfCached } from "./agent-dedupe.js";
import { resolveAgentDeliveryPhase } from "./agent-delivery-phase.js";
import * as agentHandlerHelpers from "./agent-handler-helpers.js";
import { startAgentRunExecution } from "./agent-run-execution-phase.js";
import { createTestRpcSource, testRpcSourceController } from "./rpc-source.test-support.js";
import type { AgentTurnPrincipal } from "./types.js";

const { dispatchAgentRunFromGateway, agentCommand } = vi.hoisted(() => ({
  dispatchAgentRunFromGateway: vi.fn(),
  agentCommand: vi.fn(),
}));

vi.mock("../../commands/agent.js", () => ({
  agentCommandFromGatewayIngress: agentCommand,
}));

vi.mock("./agent-run-dispatch.js", () => ({
  dispatchAgentRunFromGateway,
}));

function createExecution(
  options: {
    aborted?: boolean;
    assertContextCurrent?: () => void;
    pendingInputSettlement?: () => Promise<void>;
  } = {},
) {
  const abortCleanup = vi.fn();
  let gatewayActive = true;
  const gatewayRelease = vi.fn(() => {
    gatewayActive = false;
  });
  const callerRelease = vi.fn();
  const { promise: runtimeReleased, resolve: resolveRuntimeReleased } = createDeferred();
  const runtimeRelease = vi.fn(async () => resolveRuntimeReleased());
  const controller = new AbortController();
  if (options.aborted) {
    controller.abort();
  }
  return {
    abortCleanup,
    gatewayRelease,
    callerRelease,
    runtimeRelease,
    runtimeReleased,
    params: {
      assertContextCurrent: options.assertContextCurrent,
      prepared: {
        releaseCallerAuthority: callerRelease,
        activeGatewayWorkAdmission: {
          release: gatewayRelease,
          isActive: () => gatewayActive,
          run: async (run: () => Promise<void>) => await run(),
        },
        activeRunAbort: {
          cleanup: abortCleanup,
          controller,
          registered: false,
        },
        effectiveAllowModelOverride: false,
        lifecycleStorePath: "",
        operationalRunInstance: {},
        preparedModelRuntimeLease: { [Symbol.asyncDispose]: runtimeRelease, snapshot: {} },
        replyDispatchRuntime: {
          config: { runtime: "A" },
          pluginGeneration: "generation-A",
        },
        unpersistedOffloadedRefs: [],
        userTurn: {
          recorder: options.pendingInputSettlement
            ? { waitForPendingInputSettlement: options.pendingInputSettlement }
            : undefined,
          execApprovalFollowupHandoffClaimId: "claim",
          message: "continue",
          senderIsOwner: false,
          suppressPromptPersistence: false,
        },
        workspaceOverride: "/workspace/A",
      },
      request: {},
      cfg: {},
      activeSessionAgentId: "main",
      delivery: {},
      isNewSession: false,
      isRawModelRun: true,
      isOneShotModelRun: true,
      isRestartRecoveryResumeRun: false,
      suppressVisibleSessionEffects: true,
      images: [],
      imageOrder: [],
      media: [],
      runId: "owner-test",
      agentDedupeKeys: [],
      bestEffortDeliver: false,
      lifecycleGeneration: "test",
      preserveUserFacingSessionModelState: false,
      skipAgentInitialSessionTouch: true,
      canUseInternalRuntimeHandoff: false,
      client: null,
      context: {
        getSessionEventSubscriberConnIds: () => new Set(),
        dedupe: new Map(),
        deps: {},
        logGateway: { error: vi.fn(), warn: vi.fn() },
      },
      io: {
        emitAcceptance: vi.fn(),
        emitFinal: vi.fn(),
      },
      releaseCronContinuationClaimWithRecovery: async () => true,
    } as unknown as Parameters<typeof startAgentRunExecution>[0],
  };
}

async function bindRegisteredExecution(
  execution: ReturnType<typeof createExecution>,
  sessionKey: string,
  sessionId: string,
) {
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const operationalRunInstance = createOperationalRunInstanceRef(execution.params.runId);
  const target = captureSessionTarget({
    storeScope: `/synthetic/agent-execution/${sessionId}/sessions.db`,
    sessionKey,
    incarnation: sessionId,
    agentId: "main",
  });
  const registration = registerChatAbortController({
    target,
    runId: execution.params.runId,
    sessionKey,
    sessionId,
    agentId: "main",
    operationalRunInstance,
    kind: "agent",
    lifecycleGeneration,
    timeoutMs: 60_000,
  });
  if (!registration.entry) {
    throw new Error("Expected an owned execution registration");
  }
  Object.assign(execution.params, {
    resolvedSessionKey: sessionKey,
    resolvedSessionId: sessionId,
    lifecycleGeneration,
  });
  Object.assign(execution.params.prepared, {
    activeRunAbort: registration,
    operationalRunInstance,
    lifecycleStorePath: target.storeScope,
    activeGatewayWorkAdmission: await beginSessionEffect({
      target,
      sourceInput: registration.entry.input,
      assertAllowed: () => {},
    }),
  });
  return registration;
}

function createVisibleExecution() {
  const execution = createExecution();
  const sessionKey = "agent:main:task-access-liveness";
  Object.assign(execution.params, {
    suppressVisibleSessionEffects: false,
    requestedSessionKey: sessionKey,
    resolvedSessionKey: sessionKey,
  });
  Object.assign(execution.params.context, {
    getRuntimeConfig: () => ({}),
    getSessionEventSubscriberConnIds: () => new Set(),
  });
  execution.params.prepared.activeRunAbort.markExecutionStarted = vi.fn(() => true);
  execution.params.prepared.userTurn.recorder = {
    finishPendingInput: vi.fn(),
  } as unknown as NonNullable<typeof execution.params.prepared.userTurn.recorder>;
  return execution;
}

function bindFollowupCompletion(execution: ReturnType<typeof createExecution>) {
  const { params } = execution;
  const sessionKey = "agent:main:followup-owner";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const entry = createTestRpcSource(
    {
      sessionId: "followup-session",
      sessionKey,
      operationalRunInstance: params.prepared.operationalRunInstance,
      lifecycleGeneration,
    },
    params.runId,
  );
  if (params.prepared.activeRunAbort.controller.signal.aborted) {
    testRpcSourceController(entry).abort();
  }
  params.prepared.lifecycleStorePath = entry.input.mailbox.owner.target!.storeScope;
  params.resolvedSessionKey = sessionKey;
  params.resolvedSessionId = getRpcSourceIdentity(entry).sessionId;
  params.lifecycleGeneration = lifecycleGeneration;
  rpcSourceTesting.reset([[params.runId, entry]]);
  const previousAbort = params.prepared.activeRunAbort;
  params.prepared.activeRunAbort = {
    registered: true,
    controller: testRpcSourceController(entry),
    entry,
    markExecutionStarted: previousAbort.markExecutionStarted,
    bindAgentRunDelegatedAuthority: previousAbort.bindAgentRunDelegatedAuthority,
    cleanup: previousAbort.cleanup,
  };
  params.prepared.activeGatewayWorkAdmission!.isActive = () => true;
  execution.abortCleanup.mockImplementation(() => {
    if (rpcSourceTesting.get(params.runId) === entry) {
      rpcSourceTesting.delete(params.runId);
    }
  });
  const custody = new AbortController();
  const owner = SessionFollowupCompletion.bind({
    runId: params.runId,
    requesterSessionKey: "agent:main:requester",
    requesterSessionId: "requester-session",
    requesterAgentId: "main",
    targetAgentId: "main",
    targetSessionKey: sessionKey,
    custody: {
      signal: custody.signal,
      assertCurrent: () => custody.signal.throwIfAborted(),
      run: (work) => work(),
      release: () => custody.abort(),
    },
  });
  owner.markAccepted(params.runId);
  params.prepared.followupCompletion = owner;
  return owner;
}

describe("startAgentRunExecution Gateway ownership", () => {
  beforeEach(() => {
    dispatchAgentRunFromGateway.mockReset();
    agentCommand.mockReset();
  });

  it.each(["success", "startup failure", "cleanup failure", "completed cleanup failure"] as const)(
    "retains raw disposal after its real terminal producer settles %s",
    async (outcome) => {
      const execution = createExecution();
      const registration = await bindRegisteredExecution(
        execution,
        "agent:main:composed-terminal-disposal",
        "composed-terminal-disposal",
      );
      const entry = registration.entry;
      const commandEntered = createDeferred();
      const finishCommand = createDeferred();
      const saveEntered = createDeferred();
      const finishSave = createDeferred();
      const disposalEntered = createDeferred();
      const finishDisposal = createDeferred();
      agentCommand.mockImplementationOnce(async () => {
        commandEntered.resolve();
        await finishCommand.promise;
        if (outcome === "startup failure") {
          throw new Error("Synthetic command startup failure");
        }
        return { payloads: [], meta: {} };
      });
      const actualDispatch =
        await vi.importActual<typeof import("./agent-run-dispatch.js")>("./agent-run-dispatch.js");
      dispatchAgentRunFromGateway.mockImplementationOnce(
        actualDispatch.dispatchAgentRunFromGateway,
      );
      const cleanupFault = new Error("Synthetic unfinished runtime cleanup");
      execution.runtimeRelease.mockImplementation(async () => {
        disposalEntered.resolve();
        await finishDisposal.promise;
        if (outcome === "cleanup failure") {
          throw cleanupFault;
        }
      });
      const callbackFault = new Error("Synthetic completed inspection callback failure");
      let database: DatabaseSync | undefined;
      let nativeDisposals = 0;
      if (outcome === "completed cleanup failure") {
        const registry = createEmptyPluginRegistry();
        const resources = new PluginRegistryInspectionResources(retireInspectionInstances);
        resources.attach(registry);
        const native = (database = new DatabaseSync(":memory:"));
        let releaseGeneration: (() => Promise<void>) | undefined = undefined;
        onTestFinished(async () => {
          finishDisposal.resolve();
          await releaseGeneration?.().catch(() => {});
          await resources.release().catch(() => {});
          if (native.isOpen) {
            native.close();
          }
        });
        const nativeDispose = async () => {
          nativeDisposals++;
          disposalEntered.resolve();
          await finishDisposal.promise;
          native.close();
          throw callbackFault;
        };
        resources.runRegistration("completed-cleanup", () => {
          resources.register("completed-cleanup", { id: "sqlite", dispose: nativeDispose });
        });
        const construction = new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
        const discovery = vi
          .spyOn(runtimePlugins, "acquireAgentRuntimePluginRegistry")
          .mockResolvedValueOnce({
            registry,
            primaryRegistry: registry,
            resources,
            releaseRegistry: resources.release.bind(resources),
            releaseWork: retainRuntimePluginWork([registry]),
          });
        try {
          await construction.load({ config: {} }, () => {});
        } finally {
          discovery.mockRestore();
        }
        const generation: PreparedModelRuntimePluginGeneration = {
          remoteCatalog: null,
          pluginMetadataSnapshot: createPluginMetadataSnapshot({
            config: {},
            manifestRegistry: makeRegistry([]),
          }),
          inlineProviderModels: [],
          configuredCatalogEntries: [],
          pluginRegistry: registry,
        };
        releaseGeneration = retainPreparedPluginGeneration(generation);
        await construction[Symbol.asyncDispose]();
        execution.params.prepared.preparedModelRuntimeLease = {
          ...expectDefined(
            execution.params.prepared.preparedModelRuntimeLease,
            "ready session runtime",
          ),
          pluginGeneration: generation,
          [Symbol.asyncDispose]: releaseGeneration,
        };
        execution.params.prepared.replyDispatchRuntime = {
          ...execution.params.prepared.replyDispatchRuntime,
          pluginGeneration: generation,
        };
      }
      const finished = vi.fn();
      const completion = startAgentRunExecution(execution.params).then(finished);
      const observed = completion.catch((error: unknown) => error);
      try {
        await Promise.race([
          commandEntered.promise,
          disposalEntered.promise.then(() => {
            throw new Error("Execution entered disposal before command dispatch");
          }),
        ]);
        const producer = entry.adapter.resolveTerminalProducer?.();
        expect(
          producer?.handoff(async (producerCompleted: Promise<void>) => {
            await producerCompleted;
            saveEntered.resolve();
            await finishSave.promise;
          }),
        ).toBe(true);
        finishCommand.resolve();
        await Promise.race([
          saveEntered.promise,
          disposalEntered.promise.then(() => {
            throw new Error("Execution entered disposal before its terminal save");
          }),
        ]);
        expect(execution.runtimeRelease).not.toHaveBeenCalled();
        finishSave.resolve();
        await disposalEntered.promise;
        expect(entry.adapter.resolveTerminalProducer?.()).toBeUndefined();
        expect(entry.input.retirementRequested).toBe(true);
        expect(getRpcSourceProjectSessionActive(entry)).toBe(false);
        expect(registration.markExecutionStarted()).toBe(false);
        expect(execution.callerRelease).not.toHaveBeenCalled();
        expect(finished).not.toHaveBeenCalled();
        if (database) {
          expect(database.isOpen).toBe(true);
        }
        finishDisposal.resolve();
        if (outcome === "completed cleanup failure") {
          expect(collectNestedErrorCandidates(await observed)).toContain(callbackFault);
          expect(database?.isOpen).toBe(false);
          expect(nativeDisposals).toBe(1);
        } else if (outcome === "cleanup failure") {
          expect(await observed).toBe(cleanupFault);
        } else {
          await completion;
        }
        expect(execution.callerRelease).toHaveBeenCalledOnce();
      } finally {
        finishCommand.resolve();
        finishSave.resolve();
        finishDisposal.resolve();
        await observed;
        execution.params.prepared.activeGatewayWorkAdmission?.release();
      }
    },
  );

  it("retains an inactive exact run owner after prewriter cleanup until disposal settles", async () => {
    const execution = createExecution();
    const registration = await bindRegisteredExecution(
      execution,
      "agent:main:retained-disposal",
      "retained-disposal-session",
    );
    registration.controller.abort();
    const disposalEntered = createDeferred();
    const allowDisposal = createDeferred();
    execution.runtimeRelease.mockImplementation(async () => {
      disposalEntered.resolve();
      await allowDisposal.promise;
    });
    const completion = startAgentRunExecution(execution.params);
    try {
      await disposalEntered.promise;
      expect(registration.entry.input.retirementRequested).toBe(true);
      expect(execution.params.prepared.activeGatewayWorkAdmission?.isActive()).toBe(false);
      expect(getRpcSourceProjectSessionActive(registration.entry)).toBe(false);
      expect(isRpcSourceExecuting(registration.entry)).toBe(false);
      expect(registration.markExecutionStarted()).toBe(false);
      expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
      expect(execution.callerRelease).not.toHaveBeenCalled();
      allowDisposal.resolve();
      await completion;
      expect(rpcSourceTesting.has(execution.params.runId)).toBe(false);
    } finally {
      allowDisposal.resolve();
      await completion;
      execution.params.prepared.activeGatewayWorkAdmission?.release();
    }
  });

  it("lets a disposer drain its real session without waiting on its own retained execution", async () => {
    const execution = createExecution();
    const registration = await bindRegisteredExecution(
      execution,
      "agent:main:self-disposal",
      "self-disposal-session",
    );
    registration.controller.abort();
    const context = createChatAbortContext({
      ...execution.params.context,
      sources: [[execution.params.runId, registration.entry]],
    }) as unknown as GatewayRequestContext;
    execution.params.context = context;
    const { sessionKey, sessionId } = getRpcSourceIdentity(registration.entry);
    const dispatchYield = vi
      .spyOn(agentHandlerHelpers, "yieldAfterAgentAcceptedAck")
      .mockResolvedValue(undefined);
    const disposalEntered = createDeferred();
    execution.runtimeRelease.mockImplementation(async () => {
      disposalEntered.resolve();
      const drain = await prepareSessionLifecycleDrain({
        action: "delete",
        context,
        storePath: "gateway-self-disposal",
        sessionKeys: [sessionKey],
        sessionKey,
        sessionId,
        agentId: "main",
        defaultAgentId: "main",
        lifecycleIdentities: [sessionKey, sessionId],
      });
      try {
        expect(drain.hasAuthoritativeWork()).toBe(false);
      } finally {
        drain.release();
      }
    });
    const completion = startAgentRunExecution(execution.params).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await Promise.race([
        disposalEntered.promise,
        completion.then((error) => {
          throw new Error("Execution completed before its lifecycle disposer started", {
            cause: error,
          });
        }),
      ]);
      expect(await completion).toBeUndefined();
      expect(rpcSourceTesting.has(execution.params.runId)).toBe(false);
      expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
    } finally {
      await completion;
      dispatchYield.mockRestore();
      execution.params.prepared.activeGatewayWorkAdmission?.release();
    }
  });

  it("selects the exact preparing RPC input and lends its operation to command dispatch", async () => {
    const execution = createExecution();
    const completion = bindFollowupCompletion(execution);
    const source = execution.params.prepared.activeRunAbort.entry!;
    const entered = createDeferred();
    const release = createDeferred();
    dispatchAgentRunFromGateway.mockImplementationOnce(async (dispatch) => {
      expect(source.input.claim?.inputs).toEqual([source.input]);
      expect(getCurrentSessionControllerOwner()).toBe(source.input.claim?.operation);
      expect(source.input.mailbox.entries).toContain(source.input);
      expect(source.input.mailbox.entries).toHaveLength(1);
      entered.resolve();
      await release.promise;
      dispatch.cleanupAbortController();
    });
    const running = startAgentRunExecution(execution.params);
    try {
      await Promise.race([entered.promise, running]);
      expect(dispatchAgentRunFromGateway).toHaveBeenCalledOnce();
      expect(source.input.claim?.released).toBe(false);
    } finally {
      release.resolve();
      await running;
      completion.close();
    }
    expect(source.input.claim?.released).toBe(true);
  });

  it.each([false, true])(
    "preserves access across liveness and invalidates creation (new session: %s)",
    async (isNewSession) => {
      const execution = createVisibleExecution();
      execution.params.isNewSession = isNewSession;
      const publish = sessionChange.emitSessionsChanged;
      const notices: Array<{ reason: string; accessChanges: number }> = [];
      const publisher = vi
        .spyOn(sessionChange, "emitSessionsChanged")
        .mockImplementation((...args) => {
          const before = readGatewayAccessRevision();
          publish(...args);
          notices.push({
            reason: args[1].reason,
            accessChanges: readGatewayAccessRevision() - before,
          });
        });
      dispatchAgentRunFromGateway.mockImplementationOnce(async (dispatch) => {
        await dispatch.ingressOpts.onExecutionStarted();
        dispatch.cleanupAbortController();
      });

      try {
        await startAgentRunExecution(execution.params);

        expect(dispatchAgentRunFromGateway).toHaveBeenCalledOnce();
        expect(notices).toEqual([
          ...(isNewSession ? [{ reason: "create", accessChanges: expect.any(Number) }] : []),
          { reason: "send", accessChanges: 0 },
          { reason: "agent.run.started", accessChanges: 0 },
          { reason: "agent.input.settled", accessChanges: 0 },
        ]);
        if (isNewSession) {
          expect(notices[0]?.accessChanges).toBeGreaterThan(0);
        }
      } finally {
        publisher.mockRestore();
      }
    },
  );

  it.each<{
    name: string;
    webchat?: boolean;
    sourceChannel?: string;
    replyChannel?: string;
    sessionDelivery?: SessionEntry["delivery"];
    expectedChannel?: string;
  }>([
    { name: "unbound CLI" },
    { name: "CLI with internal delivery history", sessionDelivery: { kind: "internal" } },
    { name: "WebChat client", webchat: true, expectedChannel: "webchat" },
    { name: "WebChat continuation", sourceChannel: "webchat", expectedChannel: "webchat" },
    {
      name: "channel continuation with an internal reply override",
      sourceChannel: "discord",
      replyChannel: "webchat",
      expectedChannel: "discord",
    },
    {
      name: "remembered provider without a target",
      sessionDelivery: {
        kind: "external",
        route: { channel: "discord" },
        context: { channel: "discord" },
        origin: { provider: "discord" },
      },
      expectedChannel: "discord",
    },
    { name: "explicit internal channel", replyChannel: "webchat", expectedChannel: "webchat" },
  ])("preserves $name provider context through command resolution", async (testCase) => {
    const execution = createExecution();
    const client: AgentTurnPrincipal = {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: {
          id: testCase.webchat ? "webchat-ui" : "cli",
          mode: testCase.webchat ? "webchat" : "cli",
          version: "test",
          platform: "test",
        },
      },
    };
    const delivery = await resolveAgentDeliveryPhase({
      request: {
        message: "continue",
        idempotencyKey: execution.params.runId,
        replyChannel: testCase.replyChannel,
      },
      cfg: {},
      sessionEntry: testCase.sessionDelivery
        ? { sessionId: "source-session", updatedAt: 1, delivery: testCase.sessionDelivery }
        : undefined,
      agentId: "main",
      recipientChannel: testCase.sourceChannel,
      replyTo: "",
      to: "",
      bestEffortDeliver: false,
      runId: execution.params.runId,
      client,
      context: execution.params.context,
      respond: vi.fn(),
      isWebchatConnect: (connect) => isWebchatClient(connect?.client),
    });
    expect(delivery).toBeDefined();
    if (!delivery) {
      throw new Error("delivery planning failed");
    }
    execution.params.delivery = delivery;
    execution.params.client = client;
    dispatchAgentRunFromGateway.mockResolvedValueOnce(undefined);

    await startAgentRunExecution(execution.params);

    expect(dispatchAgentRunFromGateway).toHaveBeenCalledOnce();
    const dispatch = dispatchAgentRunFromGateway.mock.calls[0]?.[0];
    const runContext = resolveAgentRunContext(dispatch.ingressOpts);
    expect(runContext.messageChannel).toBe(testCase.expectedChannel);
    expect(runContext.currentChannelId).toBeUndefined();
  });

  it.each([
    { sourceIngress: "control-ui" as const, sourceChannel: "webchat", deliveryContext: undefined },
    {
      sourceIngress: "channel" as const,
      sourceChannel: "discord",
      deliveryContext: { channel: "discord" },
    },
  ])(
    "preserves targetless $sourceChannel policy context at recovery dispatch",
    async ({ sourceIngress, sourceChannel, deliveryContext }) => {
      const execution = createExecution();
      Object.assign(execution.params, {
        canUseInternalRuntimeHandoff: true,
        isRestartRecoveryResumeRun: true,
        resolvedSessionId: "recovery-session",
        sessionEntry: {
          sessionId: "recovery-session",
          updatedAt: 1,
          restartRecoveryDeliveryRunId: execution.params.runId,
          restartRecoveryDeliverySourceRunId: "source-run",
          restartRecoveryDeliveryContext: deliveryContext,
          restartRecoverySourceIngress: sourceIngress,
        },
      });
      execution.params.request.expectedExistingSessionId = "recovery-session";
      execution.params.delivery.originMessageChannel = "slack";
      dispatchAgentRunFromGateway.mockResolvedValueOnce(undefined);

      await startAgentRunExecution(execution.params);

      expect(dispatchAgentRunFromGateway).toHaveBeenCalledOnce();
      const dispatch = dispatchAgentRunFromGateway.mock.calls[0]?.[0];
      expect(dispatch?.ingressOpts.runContext.messageChannel).toBe(sourceChannel);
      expect(dispatch?.ingressOpts.runContext.currentChannelId).toBeUndefined();
    },
  );

  it("dispatches with the runtime generation frozen at admission", async () => {
    const execution = createExecution();
    const { promise: dispatched, resolve: resolveDispatched } = createDeferred();
    const { promise: cleanupObserved, resolve: resolveCleanupObserved } = createDeferred();
    let borrowedAfterCleanup: Promise<unknown> | undefined;
    let dispatchedGeneration: unknown;
    let dispatchedSnapshot: unknown;
    dispatchAgentRunFromGateway.mockImplementationOnce(() => {
      const generation = execution.params.prepared.replyDispatchRuntime.pluginGeneration;
      dispatchedGeneration = getPreparedModelRuntimePluginGeneration();
      dispatchedSnapshot = getPreparedModelRuntimeBorrowedSnapshot(generation);
      borrowedAfterCleanup = (async () => {
        await cleanupObserved;
        return getPreparedModelRuntimeBorrowedSnapshot(generation);
      })();
      resolveDispatched();
      return cleanupObserved;
    });

    const completion = startAgentRunExecution(execution.params);

    await dispatched;
    expect(dispatchedGeneration).toBe(
      execution.params.prepared.replyDispatchRuntime.pluginGeneration,
    );
    expect(dispatchedSnapshot).toBe(
      expectDefined(execution.params.prepared.preparedModelRuntimeLease, "ready session runtime")
        .snapshot,
    );
    const dispatch = dispatchAgentRunFromGateway.mock.calls[0]?.[0];
    expect(dispatch?.commandRuntimeContext).toEqual({
      config: { runtime: "A" },
      pluginGeneration: "generation-A",
    });
    expect(dispatch?.ingressOpts.workspaceDir).toBe("/workspace/A");
    expect(execution.runtimeRelease).not.toHaveBeenCalled();

    await dispatch?.cleanupAbortController();
    await dispatch?.cleanupAbortController();
    expect(execution.callerRelease).not.toHaveBeenCalled();
    resolveCleanupObserved();
    await expect(borrowedAfterCleanup).resolves.toBeUndefined();
    await completion;
    expect(execution.runtimeRelease).toHaveBeenCalledOnce();
    expect(execution.callerRelease).toHaveBeenCalledOnce();
  });

  it.each([undefined, "/workspace/session-override"])(
    "preserves the admitted workspace with session override %s",
    async (workspaceOverride) => {
      const execution = createExecution();
      execution.params.prepared.workspaceOverride = workspaceOverride;
      execution.params.prepared.replyDispatchRuntime = {
        ...execution.params.prepared.replyDispatchRuntime,
        workspaceDir: "/workspace/admitted",
      };
      dispatchAgentRunFromGateway.mockResolvedValueOnce(undefined);

      await startAgentRunExecution(execution.params);

      const dispatch = dispatchAgentRunFromGateway.mock.calls[0]?.[0];
      expect(dispatch?.ingressOpts.workspaceDir).toBe(workspaceOverride ?? "/workspace/admitted");
      expect(execution.runtimeRelease).toHaveBeenCalledOnce();
      expect(execution.callerRelease).toHaveBeenCalledOnce();
    },
  );

  // Cancelled sources retain their captured identity through disposal. Every
  // successor is a separately reserved source with its own controller target.
  it.each([
    { ending: "aborted", registration: "current" },
    { ending: "failed", registration: "current" },
    { ending: "aborted", registration: "foreign" },
    { ending: "aborted", registration: "absent" },
    { ending: "aborted", registration: "replacement" },
    { ending: "aborted", registration: "controller successor" },
    { ending: "aborted", registration: "session incarnation successor" },
    { ending: "aborted", registration: "operational instance successor" },
    { ending: "aborted", registration: "lifecycle successor" },
  ] as const)(
    "settles an undispatched $ending followup only after cleanup (registration: $registration)",
    async ({ ending, registration }) => {
      const settlementEntered = createDeferred();
      const finishSettlement = createDeferred();
      const execution = createExecution({
        pendingInputSettlement: async () => {
          settlementEntered.resolve();
          await finishSettlement.promise;
        },
        aborted: ending === "aborted",
        ...(ending === "failed"
          ? {
              assertContextCurrent: () => {
                throw new Error("Gateway owner retired");
              },
            }
          : {}),
      });
      execution.params.agentDedupeKeys = [`agent:${execution.params.runId}`];
      const owner = bindFollowupCompletion(execution);
      const entry = execution.params.prepared.activeRunAbort.entry!;
      const identity = getRpcSourceIdentity(entry);
      const successor =
        registration !== "current" && registration !== "absent"
          ? createTestRpcSource(
              {
                ...entry.adapter,
                ...identity,
                sessionKey:
                  registration === "foreign" ? "agent:main:unrelated" : identity.sessionKey,
                sessionId:
                  registration === "session incarnation successor"
                    ? "successor-session"
                    : identity.sessionId,
                operationalRunInstance:
                  registration === "replacement" ||
                  registration === "operational instance successor"
                    ? createOperationalRunInstanceRef(execution.params.runId)
                    : entry.adapter.operationalRunInstance,
                lifecycleGeneration:
                  registration === "replacement" || registration === "lifecycle successor"
                    ? "successor-lifecycle"
                    : entry.adapter.lifecycleGeneration,
              },
              execution.params.runId,
            )
          : undefined;
      if (successor) {
        rpcSourceTesting.set(execution.params.runId, successor);
      } else if (registration === "absent") {
        rpcSourceTesting.deleteExpected(execution.params.runId, entry);
      }
      const lostRegistration = successor !== undefined && registration !== "foreign";
      const recoveryEntered = createDeferred();
      const releaseRecovery = createDeferred();
      const disposalEntered = createDeferred();
      const finishDisposal = createDeferred();
      execution.params.releaseCronContinuationClaimWithRecovery = async () => {
        recoveryEntered.resolve();
        await releaseRecovery.promise;
        return true;
      };
      execution.runtimeRelease.mockImplementation(async () => {
        disposalEntered.resolve();
        await finishDisposal.promise;
      });
      const replyObserved = vi.fn();
      const reply = owner.take().then((result) => {
        replyObserved(result);
        return result;
      });
      void reply.catch(() => {});
      const finished = vi.fn();
      const completion = startAgentRunExecution(execution.params).then(finished);
      try {
        await Promise.race([recoveryEntered.promise, completion]);
        expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
        expect(execution.params.io.emitFinal).not.toHaveBeenCalled();
        expect(execution.params.context.dedupe.size).toBe(0);
        expect(replyObserved).not.toHaveBeenCalled();
        expect(execution.abortCleanup).not.toHaveBeenCalled();
        releaseRecovery.resolve();
        await Promise.race([settlementEntered.promise, completion]);
        expect(execution.params.io.emitFinal).not.toHaveBeenCalled();
        expect(execution.params.context.dedupe.size).toBe(0);
        expect(execution.abortCleanup).not.toHaveBeenCalled();
        finishSettlement.resolve();
        await Promise.race([disposalEntered.promise, completion]);
        expect(execution.params.io.emitFinal).toHaveBeenCalledOnce();
        expect(execution.params.context.dedupe.size).toBe(1);
        expect(execution.abortCleanup).toHaveBeenCalledOnce();
        expect(execution.gatewayRelease).toHaveBeenCalledOnce();
        expect(execution.runtimeRelease).toHaveBeenCalledOnce();
        expect(execution.callerRelease).not.toHaveBeenCalled();
        expect(replyObserved).not.toHaveBeenCalled();
        expect(finished).not.toHaveBeenCalled();
        finishDisposal.resolve();
        await completion;
        expect(finished).toHaveBeenCalledOnce();
        expect(execution.callerRelease).toHaveBeenCalledOnce();
        if (successor) {
          expect(rpcSourceTesting.get(execution.params.runId)).toBe(successor);
        }
        if (lostRegistration) {
          await expect(reply).rejects.toThrow("Follow-up admission was replaced before cleanup.");
        } else {
          await expect(reply).resolves.toMatchObject(
            ending === "aborted"
              ? { status: "error", stopReason: "rpc" }
              : { status: "error", error: "Gateway owner retired" },
          );
        }
      } finally {
        releaseRecovery.resolve();
        finishSettlement.resolve();
        finishDisposal.resolve();
        await completion.catch(() => {});
        owner.close();
      }
    },
  );

  it.each([false, true])(
    "releases the admitted runtime and preserves private failure replay before dispatch (Incognito: %s)",
    async (incognito) => {
      const privateMessage = "synthetic-private-pre-dispatch-error";
      const execution = createVisibleExecution();
      const fail = () => {
        throw new Error(privateMessage);
      };
      execution.params.assertContextCurrent = fail;
      execution.params.prepared.userTurn.releaseProcessingAbortObserver = fail;
      Object.assign(execution.params.prepared.userTurn.recorder ?? {}, {
        completeProcessing: fail,
      });
      execution.params.resolvedSessionKey = "agent:main:dashboard:private-owner";
      execution.params.sessionEntry = {
        sessionId: "private-owner",
        updatedAt: Date.now(),
        ...(incognito ? { incognito: true } : {}),
      };
      execution.params.agentDedupeKeys = [`agent:${execution.params.runId}`];

      await startAgentRunExecution(execution.params);
      expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
      expect(execution.abortCleanup).toHaveBeenCalledOnce();
      expect(execution.gatewayRelease).toHaveBeenCalledOnce();
      expect(execution.runtimeRelease).toHaveBeenCalledOnce();
      const warnings = vi.mocked(execution.params.context.logGateway.warn).mock.calls;
      expect(warnings).toHaveLength(2);
      if (incognito) {
        expect.soft(JSON.stringify(warnings)).not.toContain(privateMessage);
      } else {
        expect(JSON.stringify(warnings)).toContain(privateMessage);
      }
      const [frame, metadata] = vi.mocked(execution.params.io.emitFinal).mock.calls[0] ?? [];
      expect(frame?.[2]?.message).toBe(privateMessage);
      const diagnostics = { errorMessage: frame?.[2]?.message, ...metadata };
      if (incognito) {
        expect.soft(JSON.stringify(diagnostics)).not.toContain(privateMessage);
      } else {
        expect(diagnostics).toMatchObject({ error: privateMessage, errorMessage: privateMessage });
      }

      const emitAcceptance = vi.fn();
      expect(
        replayAgentTurnIfCached({
          preflight: {
            runId: execution.params.runId,
            agentDedupeKeys: execution.params.agentDedupeKeys,
          },
          context: execution.params.context,
          io: { emitAcceptance, emitFinal: vi.fn() },
        }),
      ).toBe(true);
      const [replayFrame, replayMetadata] = emitAcceptance.mock.calls[0] ?? [];
      expect(replayFrame).toEqual(frame);
      const replayDiagnostics = { errorMessage: replayFrame?.[2]?.message, ...replayMetadata };
      if (incognito) {
        expect(JSON.stringify(replayDiagnostics)).not.toContain(privateMessage);
      } else {
        expect(replayDiagnostics).toMatchObject({ cached: true, errorMessage: privateMessage });
      }
    },
  );
});

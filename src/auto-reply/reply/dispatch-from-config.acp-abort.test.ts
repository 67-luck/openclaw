// Tests ACP dispatch abort behavior and emitted lifecycle hooks.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type {
  AcpSessionResolution,
  SessionAcpMeta,
} from "../../acp/control-plane/manager.types.js";
import { resolveAcpSessionTarget } from "../../acp/control-plane/manager.utils.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import type {
  AcpRuntime,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeTurnInput,
} from "../../plugin-sdk/acp-runtime.js";
import {
  captureSessionTarget,
  runSessionMutation,
  interruptSessionControllerEffects,
} from "../../sessions/session-controller.lifecycle.js";
import {
  captureSessionControllerSourceSettlement,
  reserveSessionControllerSource,
  claimSessionControllerTask,
  releaseSessionControllerClaim,
} from "../../sessions/session-controller.mailbox.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import { registerNativeDispatchAbortCases } from "./dispatch-from-config.native-abort.cases.js";
import {
  acpManagerRuntimeMocks,
  acpMocks,
  agentEventMocks,
  createDispatcher,
  diagnosticMocks,
  hookMocks,
  internalHookMocks,
  mocks,
  noAbortResult,
  resetPluginTtsAndThreadMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
} from "./dispatch-from-config.shared.test-harness.js";
import { createAcpRuntime } from "./dispatch-from-config.test-harness.js";
import { expectedNoQueuedReplyResult } from "./dispatch-result-expectations.test-support.js";
import {
  REPLY_OPERATION_RUN_STATE,
  resolveReplyOperationAgentTurn,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { prepareReplySourceInput } from "./reply-source-binding.js";
import { buildTestCtx } from "./test-ctx.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let tryDispatchAcpReplyHook: typeof import("../../plugin-sdk/acpx.js").tryDispatchAcpReplyHook;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let replyRunRegistry: typeof import("../../sessions/session-controller.js").replyRunRegistry;
let listActiveReplyRunSessionKeys: typeof import("../../sessions/session-controller.registry.js").listActiveReplyRunSessionKeys;
let createReplyOperation: typeof import("../../sessions/session-controller.js").createReplyOperation;
let replyRunTesting: typeof import("./reply-run-registry.test-support.js").testing;

function shouldUseAcpReplyDispatchHook(eventUnknown: unknown): boolean {
  const event = eventUnknown as {
    sessionKey?: string;
    isTailDispatch?: boolean;
    ctx?: {
      SessionKey?: string;
      CommandTargetSessionKey?: string;
      AcpDispatchTailAfterReset?: boolean;
    };
  };
  if (event.isTailDispatch === true) {
    return true;
  }
  return [event.sessionKey, event.ctx?.SessionKey, event.ctx?.CommandTargetSessionKey].some(
    (value) => {
      const key = value?.trim();
      return Boolean(key && (key.includes("acp:") || key.includes(":acp") || key.includes("-acp")));
    },
  );
}

function createDispatchConfig(diagnostics = true): OpenClawConfig {
  return {
    diagnostics: { enabled: diagnostics },
    session: { sendPolicy: { default: "allow" } },
  };
}

function expectNoReplies(dispatcher: ReturnType<typeof createDispatcher>) {
  expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
}

function setNoAbort() {
  mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
}

function createMockAcpSessionManager() {
  return {
    resolveSessionAsync: async (params: {
      cfg: OpenClawConfig;
      sessionKey: string;
      agentId?: string;
    }): Promise<AcpSessionResolution> => {
      const target = resolveAcpSessionTarget(params);
      const entry = acpMocks.readAcpSessionEntry({
        cfg: params.cfg,
        ...target,
      }) as { acp?: SessionAcpMeta } | null;
      if (entry?.acp) {
        return {
          kind: "ready",
          ...target,
          meta: entry.acp,
        };
      }
      return { kind: "none", ...target };
    },
    getObservabilitySnapshot: () => ({
      runtimeCache: { activeSessions: 0, idleTtlMs: 0, evictedTotal: 0 },
      turns: {
        active: 0,
        queueDepth: 0,
        completed: 0,
        failed: 0,
        averageLatencyMs: 0,
        maxLatencyMs: 0,
      },
      errorsByCode: {},
    }),
    runTurn: vi.fn(
      async (params: {
        cfg: OpenClawConfig;
        sessionKey: string;
        agentId?: string;
        text?: string;
        attachments?: unknown[];
        mode: string;
        requestId: string;
        signal?: AbortSignal;
        onEvent: (event: Record<string, unknown>) => Promise<void>;
      }) => {
        const entry = acpMocks.readAcpSessionEntry({
          cfg: params.cfg,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
        }) as {
          acp?: { agent?: string; mode?: string };
        } | null;
        const runtimeBackend = acpMocks.requireAcpRuntimeBackend() as {
          runtime?: AcpRuntime;
        };
        if (!runtimeBackend.runtime) {
          throw new Error("ACP runtime backend not mocked");
        }
        const handle = await runtimeBackend.runtime.ensureSession({
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          mode: (entry?.acp?.mode || "persistent") as AcpRuntimeEnsureInput["mode"],
          agent: entry?.acp?.agent || "codex",
        });
        const stream = runtimeBackend.runtime.runTurn({
          handle,
          text: params.text ?? "",
          attachments: params.attachments as AcpRuntimeTurnInput["attachments"],
          mode: params.mode as AcpRuntimeTurnInput["mode"],
          requestId: params.requestId,
          signal: params.signal,
        });
        for await (const event of stream) {
          await params.onEvent(event);
        }
      },
    ),
  };
}

describe("dispatchReplyFromConfig ACP abort", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ tryDispatchAcpReplyHook } = await import("../../plugin-sdk/acpx.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
    ({ replyRunRegistry, createReplyOperation } =
      await import("../../sessions/session-controller.js"));
    ({ listActiveReplyRunSessionKeys } =
      await import("../../sessions/session-controller.registry.js"));
    ({ testing: replyRunTesting } = await import("./reply-run-registry.test-support.js"));
  });

  beforeEach(() => {
    setDiscordTestRegistry();
    replyRunTesting.resetReplyRunRegistry();
    resetInboundDedupe();
    acpManagerRuntimeMocks.getAcpSessionManager.mockReset();
    acpManagerRuntimeMocks.getAcpSessionManager.mockReturnValue(createMockAcpSessionManager());
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "reply_dispatch",
    );
    hookMocks.runner.runBeforeDispatch.mockReset();
    hookMocks.runner.runBeforeDispatch.mockResolvedValue(undefined);
    hookMocks.runner.runReplyDispatch.mockReset();
    hookMocks.runner.runReplyDispatch.mockImplementation(async (event: unknown, ctx: unknown) => {
      if (!shouldUseAcpReplyDispatchHook(event)) {
        return undefined;
      }
      return (await tryDispatchAcpReplyHook(event as never, ctx as never)) ?? undefined;
    });
    hookMocks.runner.runInboundClaim.mockReset();
    hookMocks.runner.runInboundClaim.mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPlugin.mockReset();
    hookMocks.runner.runInboundClaimForPlugin.mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPluginOutcome.mockReset();
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "no_handler",
    });
    hookMocks.runner.runMessageReceived.mockReset();
    internalHookMocks.createInternalHookEvent.mockReset();
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockReset();
    sessionStoreMocks.currentEntry = undefined;
    sessionStoreMocks.loadSessionEntry
      .mockReset()
      .mockImplementation(() => sessionStoreMocks.currentEntry);
    sessionStoreMocks.loadSessionStoreEntry.mockReset();
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation(
      () => sessionStoreMocks.currentEntry,
    );
    sessionStoreMocks.loadSessionStore.mockReset().mockReturnValue({});
    sessionStoreMocks.readSessionEntry.mockReset().mockReturnValue(undefined);
    sessionStoreMocks.resolveSessionStorePathCore
      .mockReset()
      .mockReturnValue("/tmp/mock-sessions.json");
    sessionStoreMocks.resolveSessionStoreEntry.mockReset().mockReturnValue({ existing: undefined });
    acpMocks.listAcpSessionEntries.mockReset().mockResolvedValue([]);
    acpMocks.readAcpSessionEntry.mockReset().mockReturnValue(null);
    acpMocks.upsertAcpSessionMeta.mockReset().mockResolvedValue(null);
    acpMocks.getAcpRuntimeBackend.mockReset();
    acpMocks.requireAcpRuntimeBackend.mockReset();
    sessionBindingMocks.listBySession.mockReset().mockReturnValue([]);
    sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
    sessionBindingMocks.touch.mockReset();
    resetPluginTtsAndThreadMocks();
    diagnosticMocks.logMessageQueued.mockReset();
    diagnosticMocks.logMessageProcessed.mockReset();
    diagnosticMocks.logSessionStateChange.mockReset();
    diagnosticMocks.markDiagnosticSessionProgress.mockReset();
    agentEventMocks.emitAgentEvent.mockReset();
    agentEventMocks.emitAgentAuditEvent.mockReset();
    agentEventMocks.onAgentEvent.mockReset().mockImplementation(() => () => {});
    setNoAbort();
  });

  it("aborts ACP dispatch promptly when the caller abort signal fires", async () => {
    const turnStarted = createDeferred();
    const releaseTurn = createDeferred();
    const runtime = createAcpRuntime([]);
    runtime.runTurn.mockImplementation(async function* (params) {
      turnStarted.resolve();
      await new Promise<void>((resolve) => {
        if (params.signal?.aborted) {
          resolve();
          return;
        }
        const onAbort = () => resolve();
        params.signal?.addEventListener("abort", onAbort, { once: true });
        void releaseTurn.promise.then(() => {
          params.signal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
      // Cancellation is prompt even while the runtime's final cleanup remains pending.
      await releaseTurn.promise;
      yield { type: "done" } as AcpRuntimeEvent;
    });
    acpMocks.readAcpSessionEntry.mockReturnValue({
      sessionKey: "agent:codex-acp:session-1",
      storeSessionKey: "agent:codex-acp:session-1",
      cfg: {},
      storePath: "/tmp/mock-sessions.json",
      entry: {},
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime:1",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime,
    });

    const abortController = new AbortController();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:codex-acp:session-1",
      BodyForAgent: "write a test",
    });
    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg: {
        acp: {
          enabled: true,
          dispatch: { enabled: true },
        },
        session: {
          sendPolicy: { default: "allow" },
        },
      } as OpenClawConfig,
      dispatcher,
      replyOptions: { abortSignal: abortController.signal },
    });

    let operation: ReturnType<typeof createReplyOperation> | undefined;
    try {
      await Promise.race([
        turnStarted.promise,
        dispatchPromise.then(() => {
          throw new Error("ACP dispatch completed before its runtime turn started");
        }),
      ]);
      expect(runtime.runTurn).toHaveBeenCalledTimes(1);
      operation = replyRunRegistry.get("agent:codex-acp:session-1");
      expect(operation?.ownerSettlement).toBeDefined();
      abortController.abort();
      await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
      expect(replyRunRegistry.get("agent:codex-acp:session-1")).toBe(operation);
      expect(operation?.abortSignal.aborted).toBe(true);
      expect(runtime.runTurn.mock.calls[0]?.[0].signal?.aborted).toBe(true);
      expectNoReplies(dispatcher);

      releaseTurn.resolve();
      await operation?.ownerSettlement;
      expectNoReplies(dispatcher);
      expect(listActiveReplyRunSessionKeys()).toEqual([]);
    } finally {
      releaseTurn.resolve();
      await Promise.allSettled([dispatchPromise, operation?.ownerSettlement]);
    }
  });

  it("completes the dispatch-owned operation when ACP tail dispatch handles the turn", async () => {
    hookMocks.runner.runReplyDispatch.mockImplementation(async (eventUnknown: unknown) => {
      const event = eventUnknown as {
        isTailDispatch?: boolean;
      };
      if (event.isTailDispatch === true) {
        return {
          handled: true,
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        };
      }
      return undefined;
    });

    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:main:regular-tail",
      BodyForAgent: "/reset continue",
    });
    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: {
        acp: {
          enabled: true,
          dispatch: { enabled: true },
        },
        diagnostics: { enabled: true },
        session: {
          sendPolicy: { default: "allow" },
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver: async (resolverCtx) => {
        resolverCtx.AcpDispatchTailAfterReset = true;
        return undefined;
      },
    });

    expect(result.counts.final).toBe(0);
    expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalledTimes(2);
    expect(listActiveReplyRunSessionKeys()).toEqual([]);
  });

  it("suppresses late reply_dispatch sends when a hook ignores a dispatch abort", async () => {
    const hookStarted = createDeferred();
    const releaseHook = createDeferred();
    const lateSendResults: boolean[] = [];

    hookMocks.runner.runReplyDispatch.mockImplementation(
      async (_eventUnknown: unknown, hookCtxUnknown: unknown) => {
        const hookCtx = hookCtxUnknown as {
          dispatcher: {
            sendToolResult: (payload: { text: string }) => boolean;
            sendBlockReply: (payload: { text: string }) => boolean;
            sendFinalReply: (payload: { text: string }) => boolean;
            getQueuedCounts: () => { tool: number; block: number; final: number };
          };
        };
        hookStarted.resolve();
        await releaseHook.promise;
        lateSendResults.push(
          hookCtx.dispatcher.sendToolResult({ text: "late tool should not send" }),
          hookCtx.dispatcher.sendBlockReply({ text: "late block should not send" }),
          hookCtx.dispatcher.sendFinalReply({ text: "late final should not send" }),
        );
        return {
          handled: true,
          queuedFinal: false,
          counts: hookCtx.dispatcher.getQueuedCounts(),
        };
      },
    );

    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:main:reply-dispatch-abort",
      BodyForAgent: "hang in reply dispatch",
    });
    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg: createDispatchConfig(),
      dispatcher,
      replyResolver: vi.fn(),
    });

    let operation: ReturnType<typeof createReplyOperation> | undefined;
    try {
      await hookStarted.promise;
      operation = replyRunRegistry.get("agent:main:reply-dispatch-abort");
      expect(operation?.ownerSettlement).toBeDefined();
      expect(replyRunRegistry.abort("agent:main:reply-dispatch-abort")).toBe(true);

      await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
      expect(replyRunRegistry.get("agent:main:reply-dispatch-abort")).toBe(operation);
      expect(operation?.abortSignal.aborted).toBe(true);
      expectNoReplies(dispatcher);

      releaseHook.resolve();
      await operation?.ownerSettlement;
      expect(lateSendResults).toEqual([false, false, false]);
      expectNoReplies(dispatcher);
      expect(listActiveReplyRunSessionKeys()).toEqual([]);
    } finally {
      releaseHook.resolve();
      await Promise.allSettled([dispatchPromise, operation?.ownerSettlement]);
    }
  });

  it("keys bound ACP tail abort ownership to the source dispatch session", async () => {
    const sourceSessionKey = "agent:main:discord:channel:C1";
    const boundAcpSessionKey = "agent:codex:acp:bound-session";
    const boundConversation = {
      bindingId: "binding-acp-tail",
      targetSessionKey: boundAcpSessionKey,
      targetKind: "session" as const,
      status: "active" as const,
      boundAt: Date.now(),
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "C1",
      },
    };
    const sessionStore: Record<string, { sessionId: string; updatedAt: number }> = {
      [sourceSessionKey]: {
        sessionId: "source-session-id",
        updatedAt: Date.now(),
      },
      [boundAcpSessionKey]: {
        sessionId: "acp-session-id",
        updatedAt: Date.now(),
      },
    };
    sessionBindingMocks.resolveByConversation.mockReturnValue(boundConversation);
    sessionStoreMocks.currentEntry = sessionStore[sourceSessionKey];
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation((...args: unknown[]) => {
      const params = args[0] as { sessionKey?: string };
      const existing = params.sessionKey ? sessionStore[params.sessionKey] : undefined;
      return existing && typeof existing === "object"
        ? (existing as Record<string, unknown>)
        : undefined;
    });
    acpMocks.readAcpSessionEntry.mockImplementation((params: { sessionKey: string }) =>
      params.sessionKey === boundAcpSessionKey
        ? {
            sessionKey: boundAcpSessionKey,
            storeSessionKey: boundAcpSessionKey,
            cfg: {},
            storePath: "/tmp/mock-sessions.json",
            entry: sessionStore[boundAcpSessionKey],
            acp: {
              backend: "acpx",
              agent: "codex",
              runtimeSessionName: "runtime:bound",
              mode: "persistent",
              state: "idle",
              lastActivityAt: Date.now(),
            },
          }
        : null,
    );

    const tailDispatchStarted = createDeferred();
    const releaseTailDispatch = createDeferred();
    let tailSessionKey: string | undefined;
    let tailAbortSignal: AbortSignal | undefined;
    hookMocks.runner.runReplyDispatch.mockImplementation(
      async (eventUnknown: unknown, hookCtxUnknown: unknown) => {
        const event = eventUnknown as {
          sessionKey?: string;
          isTailDispatch?: boolean;
        };
        if (event.isTailDispatch === true) {
          const hookCtx = hookCtxUnknown as { abortSignal?: AbortSignal };
          tailSessionKey = event.sessionKey;
          tailAbortSignal = hookCtx.abortSignal;
          tailDispatchStarted.resolve();
          await releaseTailDispatch.promise;
        }
        return undefined;
      },
    );

    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      AccountId: "default",
      To: "C1",
      SessionKey: sourceSessionKey,
      BodyForAgent: "/reset continue",
    });
    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg: {
        acp: {
          enabled: true,
          dispatch: { enabled: true },
        },
        diagnostics: { enabled: true },
        session: {
          sendPolicy: { default: "allow" },
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver: async (resolverCtx) => {
        resolverCtx.AcpDispatchTailAfterReset = true;
        return undefined;
      },
    });

    let operation: ReturnType<typeof createReplyOperation> | undefined;
    try {
      await tailDispatchStarted.promise;
      operation = replyRunRegistry.get(sourceSessionKey);
      expect(operation?.ownerSettlement).toBeDefined();
      expect(tailSessionKey).toBe(boundAcpSessionKey);
      expect(tailAbortSignal).toBeDefined();
      expect(replyRunRegistry.abort(boundAcpSessionKey)).toBe(false);
      expect(replyRunRegistry.abort(sourceSessionKey)).toBe(true);

      await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
      expect(replyRunRegistry.get(sourceSessionKey)).toBe(operation);
      expect(replyRunRegistry.get(boundAcpSessionKey)).toBeUndefined();
      expect(operation?.abortSignal.aborted).toBe(true);
      expect(tailAbortSignal?.aborted).toBe(true);

      releaseTailDispatch.resolve();
      await operation?.ownerSettlement;
      expectNoReplies(dispatcher);
      expect(listActiveReplyRunSessionKeys()).toEqual([]);
    } finally {
      releaseTailDispatch.resolve();
      await Promise.allSettled([dispatchPromise, operation?.ownerSettlement]);
    }
  });

  it("registers pre-dispatch abort ownership when diagnostics are disabled", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "before_dispatch",
    );
    const beforeDispatchStarted = createDeferred();
    const releaseBeforeDispatch = createDeferred();
    hookMocks.runner.runBeforeDispatch.mockImplementation(async () => {
      beforeDispatchStarted.resolve();
      await releaseBeforeDispatch.promise;
      return undefined;
    });

    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:main:diagnostics-disabled-abort",
      BodyForAgent: "hang in before dispatch",
    });
    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg: createDispatchConfig(false),
      dispatcher,
      replyResolver: vi.fn(),
    });

    let operation: ReturnType<typeof createReplyOperation> | undefined;
    try {
      await beforeDispatchStarted.promise;
      operation = replyRunRegistry.get("agent:main:diagnostics-disabled-abort");
      expect(operation?.ownerSettlement).toBeDefined();
      expect(replyRunRegistry.abort("agent:main:diagnostics-disabled-abort")).toBe(true);

      await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
      expect(replyRunRegistry.get("agent:main:diagnostics-disabled-abort")).toBe(operation);
      expect(operation?.abortSignal.aborted).toBe(true);
      expect(diagnosticMocks.logMessageProcessed).not.toHaveBeenCalled();

      releaseBeforeDispatch.resolve();
      await operation?.ownerSettlement;
      expectNoReplies(dispatcher);
      expect(listActiveReplyRunSessionKeys()).toEqual([]);
    } finally {
      releaseBeforeDispatch.resolve();
      await Promise.allSettled([dispatchPromise, operation?.ownerSettlement]);
    }
  });

  it.each(["before_dispatch", "reply_dispatch"] as const)(
    "retains unclaimed %s source custody until abort-insensitive hook return",
    async (hook) => {
      const key = "agent:main:raw-preparation-" + hook;
      const cfg = createDispatchConfig();
      const ctx = buildTestCtx({ Provider: "discord", Surface: "discord", SessionKey: key });
      const origin = new AbortController();
      const predecessor = createReplyOperation({
        sessionKey: key,
        sessionId: "older-" + hook,
        resetTriggered: false,
      });
      const prepared = prepareReplySourceInput(ctx, cfg, { abortSignal: origin.signal });
      const input = prepared.input;
      if (!input) {
        throw new Error("missing prepared source");
      }
      const receipt = captureSessionControllerSourceSettlement(input);
      const settled = vi.fn();
      void receipt.then(settled);
      const entered = createDeferred();
      const release = createDeferred();
      const returned = createDeferred();
      hookMocks.runner.hasHooks.mockImplementation((name?: string) => name === hook);
      const heldHook = async () => {
        entered.resolve();
        await release.promise;
        returned.resolve();
        return undefined;
      };
      if (hook === "before_dispatch") {
        hookMocks.runner.runBeforeDispatch.mockImplementation(heldHook);
      } else {
        hookMocks.runner.runReplyDispatch.mockImplementation(heldHook);
      }
      const dispatcher = createDispatcher();
      const resolver = vi.fn();
      const dispatch = dispatchReplyFromConfig({
        ctx,
        cfg,
        dispatcher,
        replyOptions: prepared.options,
        replyResolver: resolver,
      });
      let mutation: Promise<void> | undefined;
      let next: ReturnType<typeof claimSessionControllerTask> | undefined;
      try {
        await entered.promise;
        expect(input.claim).toBeUndefined();
        origin.abort();
        await expect(dispatch).resolves.toMatchObject(expectedNoQueuedReplyResult());
        // The unrelated predecessor did not grant this source its cancellation authority.
        expect(predecessor.result).toBeNull();
        predecessor.complete();
        await predecessor.ownerSettlement;
        expect(settled).not.toHaveBeenCalled();
        const target = captureSessionTarget({
          storeScope: "/tmp/mock-sessions.json",
          sessionKey: key,
        });
        const mutationEntered = createDeferred();
        const mutated = vi.fn();
        mutation = runSessionMutation({
          target,
          prepare: async () => {
            mutationEntered.resolve();
            await interruptSessionControllerEffects({ target });
          },
          run: async () => {
            mutated();
          },
        });
        await mutationEntered.promise;
        const successor = reserveSessionControllerSource(key, {
          target,
          policy: { mode: "followup" },
        });
        const selected = vi.fn();
        next = claimSessionControllerTask(successor, selected);
        expect(mutated).not.toHaveBeenCalled();
        expect(selected).not.toHaveBeenCalled();
        release.resolve();
        await returned.promise;
        await receipt;
        await mutation;
        const claim = await next;
        expect(settled).toHaveBeenCalledOnce();
        expect(mutated).toHaveBeenCalledOnce();
        expect(selected).toHaveBeenCalledOnce();
        releaseSessionControllerClaim(claim);
        await claim.settlement.promise;
        expect(resolver).not.toHaveBeenCalled();
        expectNoReplies(dispatcher);
      } finally {
        release.resolve();
        predecessor.complete();
        await Promise.allSettled([dispatch, returned.promise, receipt, mutation]);
        const claim = await next;
        if (claim) {
          releaseSessionControllerClaim(claim);
          await claim.settlement.promise;
        }
      }
    },
  );

  it("suppresses handled before_dispatch final delivery after active source abort", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "before_dispatch",
    );
    mocks.routeReply.mockClear();
    const existingOperation = createReplyOperation({
      sessionKey: "agent:main:already-active-handled",
      sessionId: "already-active-session",
      resetTriggered: false,
    });
    hookMocks.runner.runBeforeDispatch.mockImplementation(async () => {
      expect(replyRunRegistry.abort("agent:main:already-active-handled")).toBe(true);
      return {
        handled: true,
        text: "handled by hook",
      };
    });
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:main:already-active-handled",
      BodyForAgent: "hook handles while an operation is already active",
    });

    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg: createDispatchConfig(),
      dispatcher,
      replyOptions: { abortSignal: existingOperation.abortSignal },
      replyResolver: vi.fn(),
    });

    await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(existingOperation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    existingOperation.complete();
    await existingOperation.ownerSettlement;
    expect(listActiveReplyRunSessionKeys()).toEqual([]);
  });

  it("wires active source operation abort into pre-dispatch reply_dispatch hooks", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "reply_dispatch",
    );
    const { promise: hookStartedPromise, resolve: hookStarted } = createDeferred();
    const { promise: releaseHookPromise, resolve: releaseHook } = createDeferred();
    const { promise: hookCompletedPromise, resolve: hookCompleted } = createDeferred();
    const lateSendResults: boolean[] = [];
    const abortStates: boolean[] = [];
    let hookAbortSignal: AbortSignal | undefined;

    hookMocks.runner.runReplyDispatch.mockImplementation(
      async (_eventUnknown: unknown, hookCtxUnknown: unknown) => {
        const hookCtx = hookCtxUnknown as {
          abortSignal?: AbortSignal;
          dispatcher: {
            sendToolResult: (payload: { text: string }) => boolean;
            sendBlockReply: (payload: { text: string }) => boolean;
            sendFinalReply: (payload: { text: string }) => boolean;
            getQueuedCounts: () => { tool: number; block: number; final: number };
          };
        };
        hookAbortSignal = hookCtx.abortSignal;
        hookStarted();
        await releaseHookPromise;
        abortStates.push(hookCtx.abortSignal?.aborted === true);
        lateSendResults.push(
          hookCtx.dispatcher.sendToolResult({ text: "late tool should not send" }),
          hookCtx.dispatcher.sendBlockReply({ text: "late block should not send" }),
          hookCtx.dispatcher.sendFinalReply({ text: "late final should not send" }),
        );
        hookCompleted();
        return {
          handled: true,
          queuedFinal: false,
          counts: hookCtx.dispatcher.getQueuedCounts(),
        };
      },
    );

    const existingOperation = createReplyOperation({
      sessionKey: "agent:main:already-active-reply-dispatch",
      sessionId: "already-active-reply-dispatch-session",
      resetTriggered: false,
    });
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:main:already-active-reply-dispatch",
      BodyForAgent: "reply dispatch while an operation is already active",
    });
    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg: createDispatchConfig(),
      dispatcher,
      replyOptions: { abortSignal: existingOperation.abortSignal },
      replyResolver: vi.fn(),
    });

    await hookStartedPromise;
    // The hook signal composes the operation signal with lifecycle/upstream
    // signals, so assert propagation instead of instance identity.
    expect(hookAbortSignal?.aborted).toBe(false);
    expect(replyRunRegistry.abort("agent:main:already-active-reply-dispatch")).toBe(true);
    expect(existingOperation.abortSignal.aborted).toBe(true);
    expect(hookAbortSignal?.aborted).toBe(true);

    await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
    expect(existingOperation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });

    releaseHook();
    await hookCompletedPromise;
    expect(abortStates).toEqual([true]);
    expect(lateSendResults).toEqual([false, false, false]);
    expectNoReplies(dispatcher);
    existingOperation.complete();
    await existingOperation.ownerSettlement;
    expect(listActiveReplyRunSessionKeys()).toEqual([]);
  });

  it("suppresses reply resolver runs after active source abort", async () => {
    const existingOperation = createReplyOperation({
      sessionKey: "agent:main:already-active-resolver",
      sessionId: "active-session",
      resetTriggered: false,
    });
    existingOperation.setPhase("running");
    const replyResolver = vi.fn(async () => undefined);
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:main:already-active-resolver",
      BodyForAgent: "resolver waits behind active operation",
    });
    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg: createDispatchConfig(),
      dispatcher,
      replyOptions: { abortSignal: existingOperation.abortSignal },
      replyResolver,
    });

    expect(replyRunRegistry.abort("agent:main:already-active-resolver")).toBe(true);

    await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
    expect(existingOperation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    existingOperation.complete();
    await existingOperation.ownerSettlement;
    expect(listActiveReplyRunSessionKeys()).toEqual([]);
  });

  it("keeps caller abort active while waiting for an active source operation", async () => {
    const existingOperation = createReplyOperation({
      sessionKey: "agent:main:already-active-caller-abort",
      sessionId: "active-session",
      resetTriggered: false,
    });
    const callerAbort = new AbortController();
    const replyResolver = vi.fn(async () => ({ text: "late final should not send" }));
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:main:already-active-caller-abort",
      BodyForAgent: "resolver should honor caller abort too",
    });
    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg: createDispatchConfig(),
      dispatcher,
      replyOptions: { abortSignal: callerAbort.signal },
      replyResolver,
    });

    callerAbort.abort();

    await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
    expect(existingOperation.result).toBeNull();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    existingOperation.abortByUser();
    existingOperation.complete();
    await existingOperation.ownerSettlement;
    expect(listActiveReplyRunSessionKeys()).toEqual([]);
  });

  it.each([
    { abort: "abortByUser", expected: "cancelled" },
    { abort: "abortForRestart", expected: "cancelled" },
    { abort: "supersede", expected: "superseded" },
  ] as const)(
    "records $abort before an abort-insensitive resolver settles",
    async ({ abort, expected }) => {
      const resolverStarted = createDeferred();
      const releaseResolver = createDeferred();
      const resolverFinished = createDeferred();
      const runState: ReplyOperationRunState = {};
      const dispatcher = createDispatcher();
      const ctx = buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:main:resolver-abort",
        BodyForAgent: "hang in resolver",
      });
      const dispatchPromise = dispatchReplyFromConfig({
        ctx,
        cfg: {
          diagnostics: { enabled: true },
          session: {
            sendPolicy: { default: "allow" },
          },
        } as OpenClawConfig,
        dispatcher,
        replyOptions: { [REPLY_OPERATION_RUN_STATE]: runState },
        replyResolver: async (_resolverCtx, options) => {
          resolverStarted.resolve();
          await releaseResolver.promise;
          try {
            await options?.onToolResult?.({ text: "late tool should not send" });
            await options?.onBlockReply?.({ text: "late block should not send" });
            const [plan] = createStructuredOutboundPayloadPlan([
              { text: "late prepared block should not send" },
            ]);
            if (!plan || !options?.onPreparedBlockReply) {
              throw new Error("Prepared block callback unavailable");
            }
            await options.onPreparedBlockReply(plan);
            return { text: "late final should not send" };
          } finally {
            resolverFinished.resolve();
          }
        },
      });

      await resolverStarted.promise;
      const operation = replyRunRegistry.get("agent:main:resolver-abort");
      try {
        expect(operation?.[abort]()).toBe(true);
        await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
        expect(runState.agentTurnOwner).toBe(operation);
        expect(resolveReplyOperationAgentTurn(runState)).toBe(expected);
        expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      } finally {
        releaseResolver.resolve();
        await resolverFinished.promise;
        await replyRunRegistry.waitForIdle("agent:main:resolver-abort");
      }

      expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
      expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      expect(listActiveReplyRunSessionKeys()).toEqual([]);
    },
  );

  it("treats a resolver AbortError after dispatch abort as a handled dispatch", async () => {
    const { promise: resolverStartedPromise, resolve: resolverStarted } = createDeferred();

    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:main:resolver-abort-error",
      BodyForAgent: "abort in resolver",
    });
    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg: createDispatchConfig(),
      dispatcher,
      replyResolver: async (_resolverCtx, options) => {
        resolverStarted();
        const abortSignal = options?.abortSignal;
        if (!abortSignal) {
          throw new Error("expected dispatch abort signal");
        }
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        const err = new Error("resolver aborted");
        err.name = "AbortError";
        throw err;
      },
    });

    await resolverStartedPromise;
    expect(replyRunRegistry.abort("agent:main:resolver-abort-error")).toBe(true);

    await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "skipped",
        reason: "reply_operation_aborted",
      }),
    );
    expect(listActiveReplyRunSessionKeys()).toEqual([]);
  });

  registerNativeDispatchAbortCases(() => ({
    dispatchReplyFromConfig,
    replyRunRegistry,
    createReplyOperation,
    listActiveReplyRunSessionKeys,
    createDispatchConfig,
    expectNoReplies,
  }));
});

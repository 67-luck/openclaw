/** Channel Stop initiates native and ACP cancellation independently of either drain. */
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "../../gateway/server-methods/chat.abort-registry.test-support.js";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { testing as acpTesting, getAcpSessionManager } from "../../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../../acp/control-plane/manager.lifecycle.js";
import { getAcpSessionResetControls } from "../../acp/control-plane/manager.reset-controls.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadExactSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import {
  beginSessionEffect,
  isSessionControllerWorkActive,
  type SessionEffectRef,
} from "../../sessions/session-controller.lifecycle.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { tryFastAbortFromMessage } from "./abort.js";
import { buildTestCtx } from "./test-ctx.js";

const fixture = useChatAbortRegistryFixture();

it.each(
  ["idle", "active", "native failure"].flatMap((scenario) =>
    ["resolve", "reject"].map((completion) => ({ scenario, completion })),
  ),
)(
  "native and bound ACP cancellation initiate before either drain ($scenario, $completion)",
  async ({ scenario, completion }) => {
    const active = scenario !== "idle";
    const nativeFailure = scenario === "native failure";
    const nativeError = new Error("native cancellation failed");
    const sourceKey = "agent:main:stop-test:direct:room";
    const acpKey = "agent:main:acp:bound-stop";
    const runningKey = "agent:main:subagent:running";
    const queuedKey = "agent:main:subagent:queued";
    for (const [runId, sessionKey] of [
      ["source", sourceKey],
      ["acp", acpKey],
      ["running", runningKey],
      ["queued", queuedKey],
    ] as const) {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey,
        defaultSessionId: `${runId}-session`,
      });
    }
    const cfg = getRuntimeConfig();
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" });
    const registry = captureActivePluginRegistrySnapshot();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "stop-test",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "stop-test" }),
            conversationBindings: { supportsCurrentConversationBinding: true },
          },
        },
      ]),
    );
    const binding = await getSessionBindingService().bind({
      targetSessionKey: acpKey,
      targetKind: "session",
      conversation: { channel: "stop-test", accountId: "default", conversationId: "room" },
      placement: "current",
    });
    const entered = createDeferred();
    const proceed = createDeferred();
    const cancelFinished = createDeferred();
    const turnStarted = createDeferred<AbortSignal>();
    const finishTurn = createDeferred();
    const nativeInterrupted = createDeferred();
    const cancel = vi.fn<AcpRuntime["cancel"]>(async () => {
      entered.resolve();
      await proceed.promise;
      cancelFinished.resolve();
      if (completion === "reject") {
        throw new Error("backend cancellation failed");
      }
    });
    const settleCancelRpc = async () => {
      expect(cancel).toHaveBeenCalledOnce();
      const result = cancel.mock.results[0];
      if (result?.type !== "return") {
        throw new Error("ACP cancellation did not return its runtime promise");
      }
      await Promise.allSettled([result.value]);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    };
    registerAcpRuntimeBackend({
      id: "stop-test",
      runtime: {
        ensureSession: async ({ sessionKey }) => ({
          sessionKey,
          backend: "stop-test",
          runtimeSessionName: "mock-runtime",
        }),
        async *runTurn({ signal }) {
          if (!signal) {
            throw new Error("ACP manager did not provide its active turn signal");
          }
          turnStarted.resolve(signal);
          await finishTurn.promise;
          yield { type: "done", status: "cancelled" };
        },
        cancel,
        close: async () => {},
      },
    });
    acpTesting.resetAcpSessionManagerForTests();
    const manager = getAcpSessionManager();
    const native = createReplyOperation({
      sessionKey: sourceKey,
      sessionId: "source-session",
      resetTriggered: false,
    });
    native.attachBackend({
      kind: "embedded",
      isStreaming: () => true,
      cancel: () => {
        queueMicrotask(() => native.complete());
        releaseSwarmRun("capacity");
        if (nativeFailure) {
          throw nativeError;
        }
      },
    });
    const runningAbort = vi.fn(() => {
      queueMicrotask(() => clearActiveEmbeddedRun("running-session", handle, runningKey));
    });
    const handle = createEmbeddedRunHandle({ runId: "running", abort: runningAbort });
    setActiveEmbeddedRun("running-session", handle, runningKey);
    const selectedDispatch = vi.fn(async () => {});
    const survivorDispatch = vi.fn(async () => {});
    let pending: ReturnType<typeof tryFastAbortFromMessage> | undefined;
    let childAdmission: SessionEffectRef | undefined;
    const preparedAdmission = prepareAgentRunAdmission({
      cfg,
      operationalRunInstance: createOperationalRunInstanceRef("acp-steer"),
      facts: {
        runId: "acp-steer",
        agentId: "main",
        ingress: { kind: "acp", boundary: "acp.command.steer", state: "absent" },
      },
    });
    let turn: Promise<void> | undefined;
    let acpSignal: AbortSignal | undefined;
    let stopSettled = false;
    try {
      await manager.initializeSession({
        cfg,
        sessionKey: acpKey,
        agent: "main",
        mode: "persistent",
        backendId: "stop-test",
      });
      if (active) {
        const admittedRunContext = await preparedAdmission.admit("acp");
        // Match /acp steer: the manager owns the only cancellation signal.
        turn = manager
          .runTurn({
            cfg,
            admittedRunContext,
            sessionKey: acpKey,
            requestId: "acp-steer",
            mode: "steer",
            provenance: "agent",
            text: "keep working",
          })
          .finally(() => preparedAdmission.close());
        acpSignal = await Promise.race([
          turnStarted.promise,
          turn.then(() => {
            throw new Error("ACP steer completed before the active-turn gate");
          }),
        ]);
        expect(acpSignal.aborted).toBe(false);
        expect(manager.getObservabilitySnapshot().turns.active).toBe(1);
        childAdmission = await beginSessionEffect({
          scope: storePath,
          identities: [runningKey, "running-session"],
          assertAllowed: () => {},
          onInterrupt: () => nativeInterrupted.resolve(),
        });
      }
      for (const [runId, childSessionKey] of [
        ["running", runningKey],
        ["queued", queuedKey],
      ] as const) {
        await registerSubagentRun({
          runId,
          childSessionKey,
          requesterSessionKey: sourceKey,
          requesterAgentId: "main",
          requesterDisplayKey: sourceKey,
          task: runId,
          cleanup: "keep",
          collect: true,
          queued: runId === "queued",
          expectsCompletionMessage: false,
        });
      }
      for (const [runId, start] of [
        ["queued", selectedDispatch],
        ["survivor", survivorDispatch],
      ] as const) {
        enqueueSwarmRun({
          groupId: "bound-acp",
          runId,
          maxConcurrent: 1,
          activeRunIds: ["capacity"],
          start,
          onStartFailure: () => true,
        });
      }
      pending = tryFastAbortFromMessage({
        cfg,
        ctx: buildTestCtx({
          SessionKey: sourceKey,
          CommandBody: "/stop",
          RawBody: "/stop",
          CommandAuthorized: true,
          Provider: "stop-test",
          Surface: "stop-test",
          From: "stop-test:room",
          To: "stop-test:room",
          MessageSid: "77",
          Timestamp: 1234567890000,
        }),
      }).finally(() => {
        stopSettled = true;
      });
      const outcome = pending.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      if (nativeFailure) {
        await Promise.race([
          entered.promise,
          outcome.then(() => {
            throw new Error("Native failure escaped before ACP cancellation started");
          }),
        ]);
        expect(native.abortSignal.aborted).toBe(true);
        expect(acpSignal?.aborted).toBe(true);
        expect(stopSettled).toBe(false);
        proceed.resolve();
        await settleCancelRpc();
        expect(stopSettled).toBe(false);
        finishTurn.resolve();
        expect(await outcome).toEqual({ error: nativeError });
        expect(cancel).toHaveBeenCalledOnce();
        return;
      }
      if (active) {
        await nativeInterrupted.promise;
        expect(native.abortSignal.aborted).toBe(true);
        expect(isSessionControllerWorkActive(storePath, [runningKey, "running-session"])).toBe(
          true,
        );
        await vi.waitFor(() => expect(acpSignal?.aborted).toBe(true));
        expect(cancel).toHaveBeenCalledOnce();
        expect(stopSettled).toBe(false);
        expect(selectedDispatch).not.toHaveBeenCalled();
        if (completion === "reject") {
          proceed.resolve();
          await cancelFinished.promise;
          // Let rejection observers run while the native admission is still retained.
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(stopSettled).toBe(false);
        }
        childAdmission?.release();
      }
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("Stop missed the bound ACP backend");
        }),
      ]);
      expect(native.abortSignal.aborted).toBe(true);
      // Synchronize on native terminal state, never on the still-held ACP completion.
      await vi.waitFor(() => expect(runningAbort).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(survivorDispatch).toHaveBeenCalledOnce());
      expect(selectedDispatch).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(loadExactSessionEntryReadOnly({ sessionKey: sourceKey })?.entry).toMatchObject({
          abortedLastRun: true,
          abortCutoffMessageSid: "77",
          abortCutoffTimestamp: 1234567890000,
        }),
      );
      if (!active || completion !== "reject") {
        expect(stopSettled).toBe(false);
      }
      proceed.resolve();
      if (active) {
        await settleCancelRpc();
        expect(stopSettled).toBe(false);
      }
      finishTurn.resolve();
      expect(await pending).toEqual({
        handled: true,
        aborted: true,
        stoppedSubagents: 2,
        failedSubagents: 0,
      });
      for (const key of [runningKey, queuedKey]) {
        expect(getSubagentRunByChildSessionKey(key)?.endedReason).toBe("subagent-killed");
      }
      expect(cancel).toHaveBeenCalledExactlyOnceWith({
        handle: expect.objectContaining({ sessionKey: acpKey }),
        reason: "fast-abort",
      });
      await turn;
      expect(readAcpSessionMeta({ cfg, sessionKey: acpKey })?.state).toBe(
        !active && completion === "reject" ? "error" : "idle",
      );
    } finally {
      childAdmission?.release();
      proceed.resolve();
      finishTurn.resolve();
      await pending?.catch(() => undefined);
      await turn?.catch(() => undefined);
      preparedAdmission.close();
      native.complete();
      clearActiveEmbeddedRun("running-session", handle, runningKey);
      releaseSwarmRun("capacity");
      releaseSwarmRun("queued");
      releaseSwarmRun("survivor");
      await disposeAcpSessionManagerInstance(manager, "test-cleanup");
      acpTesting.resetAcpSessionManagerForTests();
      unregisterAcpRuntimeBackend("stop-test");
      await getSessionBindingService().unbind({
        bindingId: binding.bindingId,
        reason: "test-cleanup",
      });
      restoreActivePluginRegistrySnapshot(registry);
    }
  },
);

it.each(["accepted", "replaced", "idle-replaced", "idle-rotated", "idle-cold", "revoked"] as const)(
  "delayed binding Stop retains its original ACP owners (%s)",
  async (scenario) => {
    const sourceKey = "agent:main:stop-test:direct:delayed";
    const acpKey = "agent:main:acp:delayed-stop";
    for (const [sessionKey, sessionId] of [
      [sourceKey, "source-session"],
      [acpKey, "acp-session"],
    ] as const) {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey,
        defaultSessionId: sessionId,
      });
    }
    const cfg = getRuntimeConfig();
    const registry = captureActivePluginRegistrySnapshot();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "stop-test",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "stop-test" }),
            conversationBindings: { supportsCurrentConversationBinding: true },
          },
        },
      ]),
    );
    const service = getSessionBindingService();
    const binding = await service.bind({
      targetSessionKey: acpKey,
      targetKind: "session",
      conversation: { channel: "stop-test", accountId: "default", conversationId: "delayed" },
      placement: "current",
    });
    const lookupEntered = createDeferred();
    const releaseLookup = createDeferred();
    const resolveBinding = service.resolveByConversationAsync.bind(service);
    const lookup = vi
      .spyOn(service, "resolveByConversationAsync")
      .mockImplementationOnce(async (ref) => {
        lookupEntered.resolve();
        await releaseLookup.promise;
        return await resolveBinding(ref);
      });
    const startedTexts: string[] = [];
    const firstStarted = createDeferred<AbortSignal>();
    const secondStarted = createDeferred<AbortSignal>();
    const finishFirst = createDeferred();
    const finishSecond = createDeferred();
    const cancelled = createDeferred();
    const nativeCancelled = createDeferred();
    const cancel = vi.fn<AcpRuntime["cancel"]>(async () => {
      cancelled.resolve();
    });
    registerAcpRuntimeBackend({
      id: "stop-test",
      runtime: {
        ensureSession: async ({ sessionKey }) => ({
          sessionKey,
          backend: "stop-test",
          runtimeSessionName: "delayed-runtime",
        }),
        async *runTurn({ signal, text }) {
          if (!signal) {
            throw new Error("Missing ACP signal");
          }
          startedTexts.push(text);
          (text === "first" ? firstStarted : secondStarted).resolve(signal);
          await (text === "first" ? finishFirst : finishSecond).promise;
          yield { type: "done", status: signal.aborted ? "cancelled" : "completed" };
        },
        cancel,
        close: async () => {},
      },
    });
    acpTesting.resetAcpSessionManagerForTests();
    let manager = getAcpSessionManager();
    const admissions: ReturnType<typeof prepareAgentRunAdmission>[] = [];
    const turns: Promise<void>[] = [];
    const start = async (text: string) => {
      const admission = prepareAgentRunAdmission({
        cfg,
        operationalRunInstance: createOperationalRunInstanceRef("same-request"),
        facts: {
          runId: "same-request",
          agentId: "main",
          ingress: { kind: "acp", boundary: "acp.command.steer", state: "absent" },
        },
      });
      admissions.push(admission);
      const admittedRunContext = await admission.admit("acp");
      const turn = manager
        .runTurn({
          cfg,
          admittedRunContext,
          sessionKey: acpKey,
          requestId: "same-request",
          mode: "steer",
          provenance: "agent",
          text,
        })
        .finally(() => admission.close());
      turns.push(turn);
    };
    const source = createReplyOperation({
      sessionKey: sourceKey,
      sessionId: "source-session",
      resetTriggered: false,
    });
    source.attachBackend({
      kind: "embedded",
      isStreaming: () => true,
      cancel: () => {
        nativeCancelled.resolve();
        queueMicrotask(() => source.complete());
      },
    });
    const original = createReplyOperation({
      sessionKey: acpKey,
      sessionId: "acp-session",
      resetTriggered: false,
    });
    original.attachBackend({
      kind: "embedded",
      isStreaming: () => true,
      cancel: () => queueMicrotask(() => original.complete()),
    });
    let replacement: ReturnType<typeof createReplyOperation> | undefined;
    let pending: ReturnType<typeof tryFastAbortFromMessage> | undefined;
    let current = true;
    let stopSettled = false;
    try {
      await manager.initializeSession({
        cfg,
        sessionKey: acpKey,
        agent: "main",
        mode: "persistent",
        backendId: "stop-test",
      });
      const initiallyActive =
        scenario === "accepted" || scenario === "replaced" || scenario === "revoked";
      if (initiallyActive) {
        await start("first");
        await firstStarted.promise;
      }
      if (scenario === "accepted") {
        await start("queued-original");
      }
      if (scenario === "idle-cold") {
        await disposeAcpSessionManagerInstance(manager, "simulate-process-retirement");
        acpTesting.resetAcpSessionManagerForTests();
        manager = getAcpSessionManager();
      }
      pending = tryFastAbortFromMessage({
        cfg,
        isCommandTargetCurrent: () => current,
        ctx: buildTestCtx({
          SessionKey: sourceKey,
          CommandBody: "/stop",
          RawBody: "/stop",
          CommandAuthorized: true,
          Provider: "stop-test",
          Surface: "stop-test",
          From: "stop-test:delayed",
          To: "stop-test:delayed",
        }),
      }).finally(() => {
        stopSettled = true;
      });
      const outcome = pending.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await lookupEntered.promise;
      let successorSignal: AbortSignal | undefined;
      if (scenario === "replaced" || scenario === "idle-replaced" || scenario === "idle-rotated") {
        if (initiallyActive) {
          finishFirst.resolve();
          await turns[0];
        }
        original.complete();
        replacement = createReplyOperation({
          sessionKey: acpKey,
          sessionId: "acp-session",
          resetTriggered: false,
        });
        replacement.attachBackend({
          kind: "embedded",
          isStreaming: () => true,
          cancel: () => queueMicrotask(() => replacement?.complete()),
        });
        if (scenario === "idle-rotated") {
          await getAcpSessionResetControls(manager).forceDiscardSessionRuntime({
            cfg,
            sessionKey: acpKey,
            reason: "replace-idle-owner",
          });
          await manager.initializeSession({
            cfg,
            sessionKey: acpKey,
            agent: "main",
            mode: "persistent",
            backendId: "stop-test",
          });
        } else {
          await start("second");
          successorSignal = await secondStarted.promise;
        }
      } else if (scenario === "accepted") {
        // Same public run ID, distinct admitted instance, queued behind the captured turn.
        await start("second");
      } else if (scenario === "revoked") {
        current = false;
      }
      releaseLookup.resolve();
      if (scenario === "accepted" || scenario === "idle-cold") {
        await Promise.race([
          cancelled.promise,
          outcome.then(() => {
            throw new Error("Stop missed original ACP owner");
          }),
        ]);
        expect(original.abortSignal.aborted).toBe(true);
        if (scenario === "accepted") {
          expect((await firstStarted.promise).aborted).toBe(true);
          expect(stopSettled).toBe(false);
          const queuedOriginal = turns[1];
          const successor = turns[2];
          if (!queuedOriginal || !successor) {
            throw new Error("Missing admitted queued turns");
          }
          await queuedOriginal;
          expect(startedTexts).toEqual(["first"]);
          finishFirst.resolve();
          successorSignal = await Promise.race([
            secondStarted.promise,
            successor.then(() => {
              throw new Error("Stop cancelled the later queued instance");
            }),
          ]);
          expect(successorSignal.aborted).toBe(false);
        }
        expect(await pending).toMatchObject({ handled: true, aborted: true });
        expect(cancel).toHaveBeenCalledOnce();
      } else if (scenario === "revoked") {
        expect(await outcome).toMatchObject({ error: expect.any(Error) });
        expect((await firstStarted.promise).aborted).toBe(false);
        expect(source.abortSignal.aborted).toBe(false);
        expect(cancel).not.toHaveBeenCalled();
      } else {
        await nativeCancelled.promise;
        await Promise.race([
          pending,
          cancelled.promise.then(() => {
            throw new Error("Stop cancelled the replacement ACP runtime");
          }),
        ]);
        expect(replacement?.abortSignal.aborted).toBe(false);
        if (scenario !== "idle-rotated") {
          expect(successorSignal?.aborted).toBe(false);
        }
        expect(cancel).not.toHaveBeenCalled();
        expect(await pending).toMatchObject({ handled: true, aborted: true });
      }
    } finally {
      releaseLookup.resolve();
      finishFirst.resolve();
      finishSecond.resolve();
      original.complete();
      replacement?.complete();
      source.complete();
      await pending?.catch(() => undefined);
      await Promise.allSettled(turns);
      for (const admission of admissions) {
        admission.close();
      }
      lookup.mockRestore();
      await disposeAcpSessionManagerInstance(manager, "test-cleanup");
      acpTesting.resetAcpSessionManagerForTests();
      unregisterAcpRuntimeBackend("stop-test");
      await service.unbind({ bindingId: binding.bindingId, reason: "test-cleanup" });
      restoreActivePluginRegistrySnapshot(registry);
    }
  },
);

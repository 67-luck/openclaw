import { describe, expect, it, vi } from "vitest";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  bindSubagentSpawnCleanup,
  cleanupProvisionalSession,
  terminateAcceptedCollectorRun,
} from "./subagent-spawn-cleanup.js";

function sessionChangedError(): Error {
  return Object.assign(new Error("session changed"), {
    name: "GatewayClientRequestError",
    gatewayCode: "INVALID_REQUEST",
    details: { reason: "session-changed" },
  });
}

describe("subagent spawn cleanup identity", () => {
  it("retains the captured RPC source across an awaited cleanup and refuses a same-ID successor", async () => {
    const childSessionKey = "agent:main:subagent:cleanup-child";
    const runId = "cleanup-run";
    const response = createDeferredCore<{ aborted: boolean; runIds: string[] }>();
    const dispatchSessionMethod = vi.fn(() => response.promise);
    const context = Object.assign({} as GatewayRequestContext, {
      rpcSources: new Map(),
      recoveryRuntime: { dispatchSessionMethod },
    });
    const register = () =>
      registerChatAbortController({
        rpcSources: context.rpcSources,
        target: captureSessionTarget({
          storeScope: "/synthetic/spawn-cleanup.db",
          sessionKey: childSessionKey,
          incarnation: "child-session",
        }),
        runId,
        sessionId: "child-session",
        sessionKey: childSessionKey,
        timeoutMs: 60_000,
      });
    const original = register();
    const cleanup = bindSubagentSpawnCleanup({
      childSessionKey,
      resolveGatewayContext: () => context,
      isCurrent: () => true,
      getSessionIdentity: () => ({
        expectedSessionId: "child-session",
        expectedLifecycleRevision: "revision",
      }),
    });
    cleanup.bindAcceptedRun(runId);
    expect(cleanup.isCurrent()).toBe(true);
    const request = cleanup.callGateway({
      method: "chat.abort",
      params: { sessionKey: childSessionKey, runId },
    });
    original.cleanup();
    const successor = register();
    try {
      expect(cleanup.isCurrent()).toBe(false);
      response.resolve({ aborted: true, runIds: [runId] });
      await expect(request).rejects.toThrow("Subagent spawn no longer owns this cleanup");
      expect(dispatchSessionMethod).toHaveBeenCalledOnce();
      expect(successor.controller.signal.aborted).toBe(false);
      await expect(
        cleanup.callGateway({
          method: "chat.abort",
          params: { sessionKey: childSessionKey, runId },
        }),
      ).rejects.toThrow("Subagent spawn no longer owns this cleanup");
      expect(dispatchSessionMethod).toHaveBeenCalledOnce();
    } finally {
      response.resolve({ aborted: false, runIds: [] });
      await request.catch(() => {});
      original.cleanup();
      successor.cleanup();
    }
  });

  it("requires both frozen session identities before deletion", async () => {
    const callGateway = vi.fn();

    await expect(
      cleanupProvisionalSession("agent:main:subagent:child", {
        expectedSessionId: "session-id",
        callGateway,
      }),
    ).resolves.toBe(false);

    expect(callGateway).not.toHaveBeenCalled();
  });

  it("accepts chat.abort only when it confirms the exact run", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, aborted: false, runIds: [] })
      .mockResolvedValueOnce({ deleted: true });

    await terminateAcceptedCollectorRun({
      childSessionKey: "agent:main:subagent:child",
      gatewayRunId: "gateway-run",
      expectedSessionId: "session-id",
      expectedLifecycleRevision: "session-revision",
      callGateway,
    });

    expect(callGateway).toHaveBeenNthCalledWith(2, {
      method: "sessions.delete",
      params: {
        key: "agent:main:subagent:child",
        emitLifecycleHooks: false,
        deleteTranscript: true,
        expectedSessionId: "session-id",
        expectedLifecycleRevision: "session-revision",
      },
      timeoutMs: 60_000,
    });
  });

  it("does not delete after chat.abort confirms the matching run", async () => {
    const callGateway = vi.fn(async () => ({
      ok: true,
      aborted: true,
      runIds: ["gateway-run"],
    }));

    await terminateAcceptedCollectorRun({
      childSessionKey: "agent:main:subagent:child",
      gatewayRunId: "gateway-run",
      expectedSessionId: "session-id",
      expectedLifecycleRevision: "session-revision",
      callGateway,
    });

    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("stops without deleting a durable session when the accepted run already ended", async () => {
    const callGateway = vi.fn(async () => ({
      ok: true,
      aborted: false,
      runIds: [],
    }));

    await terminateAcceptedCollectorRun({
      childSessionKey: "agent:main:subagent:child",
      gatewayRunId: "gateway-run",
      sessionCleanup: "preserve",
      callGateway,
    });

    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("retries abort without deleting a durable session after a gateway error", async () => {
    const callGateway = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValueOnce({ ok: true, aborted: false, runIds: [] });

    await terminateAcceptedCollectorRun({
      childSessionKey: "agent:main:subagent:child",
      gatewayRunId: "gateway-run",
      sessionCleanup: "preserve",
      callGateway,
    });

    expect(callGateway).toHaveBeenCalledTimes(2);
    expect(callGateway).toHaveBeenNthCalledWith(2, {
      method: "chat.abort",
      params: {
        sessionKey: "agent:main:subagent:child",
        runId: "gateway-run",
      },
      timeoutMs: 60_000,
    });
  });

  it("stops accepted-run cleanup when its Gateway request owner is retired", async () => {
    const callGateway = vi
      .fn()
      .mockRejectedValueOnce(new Error("Gateway request owner is retired"))
      .mockResolvedValue({ aborted: false, runIds: [] });

    await withPluginRuntimeGatewayRequestScope(
      { resolveGatewayContext: () => undefined, isWebchatConnect: () => false },
      () =>
        terminateAcceptedCollectorRun({
          childSessionKey: "agent:main:subagent:child",
          gatewayRunId: "gateway-run",
          sessionCleanup: "preserve",
          callGateway,
        }),
    );

    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("stops cleanup when guarded deletion observes a successor lifecycle", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, aborted: true, runIds: ["different-run"] })
      .mockRejectedValueOnce(sessionChangedError());

    await expect(
      terminateAcceptedCollectorRun({
        childSessionKey: "agent:main:subagent:child",
        gatewayRunId: "gateway-run",
        expectedSessionId: "session-id",
        expectedLifecycleRevision: "session-revision",
        callGateway,
      }),
    ).resolves.toBeUndefined();

    expect(callGateway).toHaveBeenCalledTimes(2);
  });
});

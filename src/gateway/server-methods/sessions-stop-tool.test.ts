// Preserve the cancellation fixture's module setup before its consumers.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { createSessionsStopTool } from "../../agents/tools/sessions-stop-tool.js";
import {
  createQueueSettings,
  createQueueTestRun,
} from "../../auto-reply/reply/queue.test-helpers.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import { FOLLOWUP_QUEUES } from "../../auto-reply/reply/queue/state.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createActiveRun } from "./chat.abort.test-helpers.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import { sessionAbortHandlers } from "./sessions-abort.js";
import {
  disposeSessionReadContexts,
  initializeSessionReadContext,
  sessionReadHandlers,
} from "./sessions-read-cache.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

useChatAbortRegistryFixture();

const requesterKey = "agent:main:dashboard:stop-requester";
const targetKey = "agent:main:dashboard:stop-target";
const sessionId = "stop-target-session";
const runId = "browser-owned-target-run";

async function setup() {
  const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
  setRuntimeConfigSnapshot(cfg);
  const client = roleClient("view", "stop-requester");
  client.connId = "requesting-operator-connection";
  const profileId = expectDefined(client.authenticatedUserProfile, "requester identity").profileId;
  const createdActor = { type: "human" as const, source: "profile" as const, id: profileId };
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: requesterKey },
    { sessionId: "stop-requester-session", updatedAt: 1, createdActor },
  );
  const targetScope = { agentId: "main", sessionKey: targetKey };
  await upsertSessionEntryCore(targetScope, {
    sessionId,
    updatedAt: 1,
    label: "Keep conversation",
    createdActor,
  });
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  context.resolveGatewayContext = () => context;
  const beforeAbort = vi.fn(async () => {});
  const abortOwner = expectDefined(sessionAbortHandlers["sessions.abort"], "Stop owner");
  const abortHandler = vi.fn(async (options: GatewayRequestHandlerOptions) => {
    // Observe real router admission before entering the cancellation owner.
    expect(options.client?.internal?.syntheticClient).toBe(true);
    expect(options.client?.connect.scopes).toEqual(["operator.write"]);
    expect(options.client?.connId).toBeUndefined();
    expect(options.client?.connect.device).toBeUndefined();
    expect(options.client?.internal?.operatorRoleActor).toEqual({ kind: "operator", profileId });
    expect(options.client?.internal?.agentToolCaller).toMatchObject({
      agentId: "main",
      sessionKey: requesterKey,
      assertCurrent: expect.any(Function),
    });
    expect(options.sessionMutationAuthorization?.admittedTarget).toEqual({
      agentId: "main",
      sessionKey: targetKey,
      sessionId,
    });
    await beforeAbort();
    await abortOwner(options);
  });
  const registry = createGatewayMethodRegistry([
    {
      name: "sessions.resolve",
      scope: "operator.read",
      owner: { kind: "core", area: "sessions" },
      handler: expectDefined(sessionReadHandlers["sessions.resolve"], "target resolver"),
    },
    {
      name: "sessions.abort",
      scope: "operator.write",
      owner: { kind: "core", area: "sessions" },
      handler: abortHandler,
    },
  ]);
  context.getGatewayMethodRegistry = () => registry;
  await initializeSessionReadContext(context);
  const sourceController = new AbortController();
  const captured = expectDefined(
    await captureGatewayOperatorRunAuthority({
      client,
      context,
      sourceAuthority: {
        signal: sourceController.signal,
        assertCurrent: () => sourceController.signal.throwIfAborted(),
      },
    }),
    "original operator authority",
  );
  const admission = prepareSystemAgentRunAdmission(
    cfg,
    "stop-requester-run",
    "main",
    "test",
    undefined,
    captured.authority,
  );
  const admitted = await admission.admit("embedded");
  bindGatewayContextResolver(admitted, () => context);
  const caller = expectDefined(
    createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: admitted,
      agentId: "main",
      sessionKey: requesterKey,
      approvalSignals: [sourceController.signal],
    }),
    "admitted agent caller",
  );
  const tool = createSessionsStopTool({ agentSessionKey: requesterKey, config: cfg });
  const active = createActiveRun(targetKey, {
    agentId: "main",
    sessionId,
    owner: { connId: "target-browser-connection", deviceId: "target-browser-device" },
  });
  context.chatAbortControllers.set(runId, active);
  const followup = createQueueTestRun({ prompt: "Retain until an authorized Stop" });
  Object.assign(followup.run, { agentId: "main", sessionKey: targetKey, sessionId });
  enqueueFollowupRun(targetKey, followup, createQueueSettings(), "none", undefined, false);
  const queue = expectDefined(FOLLOWUP_QUEUES.get(targetKey), "pending follow-up queue");
  return {
    client,
    context,
    active,
    targetScope,
    beforeAbort,
    abortHandler,
    stop: (key = targetKey) =>
      withGatewayToolCallerIdentity(caller, () => tool.execute("stop-target", { sessionKey: key })),
    revoke: () => sourceController.abort(new Error("original Stop caller revoked")),
    assertUntouched: async () => {
      await flushPendingSessionsChangedEvents(context);
      expect(active.controller.signal.aborted).toBe(false);
      expect(context.chatAbortControllers.get(runId)).toBe(active);
      expect(FOLLOWUP_QUEUES.get(targetKey)).toBe(queue);
      expect(queue.items).toEqual([followup]);
      expect(queue.abortController.signal.aborted).toBe(false);
      expect(context.dedupe.size).toBe(0);
      expect(context.broadcast).not.toHaveBeenCalled();
      expect(context.nodeSendToSession).not.toHaveBeenCalled();
    },
    close: async () => {
      admission.close();
      captured.release();
      clearSessionQueues([targetKey, sessionId]);
      await disposeSessionReadContexts();
    },
  };
}

it("lets an authorized agent stop browser-owned work without granting a foreign device the same power", async () => {
  const fixture = await setup();
  try {
    const respond = vi.fn();
    // The identical human/session permission is not itself a transport-owner bypass.
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "external-stop",
        method: "sessions.abort",
        params: { key: targetKey },
      },
      client: fixture.client,
      context: fixture.context,
      respond,
      isWebchatConnect: () => false,
      extraHandlers: {
        "sessions.abort": expectDefined(sessionAbortHandlers["sessions.abort"], "Stop owner"),
      },
    });
    expect(respond.mock.calls[0]?.slice(0, 3)).toEqual([
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST", message: "unauthorized" }),
    ]);
    await fixture.assertUntouched();

    const stale = createActiveRun(targetKey, {
      agentId: "main",
      sessionId: "previous-target-incarnation",
      owner: { connId: "target-browser-connection" },
    });
    fixture.context.chatAbortControllers.set("stale-target-run", stale);
    const result = await fixture.stop();
    await flushPendingSessionsChangedEvents(fixture.context);
    expect(result.details).toEqual({ ok: true, abortedRunId: runId, status: "aborted" });
    expect(fixture.abortHandler).toHaveBeenCalledOnce();
    expect(fixture.active.controller.signal.aborted).toBe(true);
    expect(stale.controller.signal.aborted).toBe(false);
    expect(fixture.context.chatAbortControllers.get("stale-target-run")).toBe(stale);
    expect(FOLLOWUP_QUEUES.get(targetKey)?.items ?? []).toEqual([]);
    expect(loadSessionEntry(fixture.targetScope)).toMatchObject({
      sessionId,
      label: "Keep conversation",
    });
    expect(loadSessionEntry(fixture.targetScope)?.archivedAt).toBeUndefined();
  } finally {
    await fixture.close();
  }
});

it("keeps unrelated and private sessions outside an identified caller's Stop authority", async () => {
  const fixture = await setup();
  try {
    const foreign = roleClient("view", "unrelated-session-owner");
    const foreignProfileId = expectDefined(
      foreign.authenticatedUserProfile,
      "foreign owner",
    ).profileId;
    for (const visibility of ["shared", "draft"] as const) {
      const key = "agent:main:dashboard:foreign-" + visibility;
      const foreignSessionId = "foreign-" + visibility + "-session";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        {
          sessionId: foreignSessionId,
          updatedAt: 1,
          visibility,
          createdActor: { type: "human", source: "profile", id: foreignProfileId },
        },
      );
      const active = createActiveRun(key, {
        agentId: "main",
        sessionId: foreignSessionId,
        owner: { connId: "foreign-browser" },
      });
      fixture.context.chatAbortControllers.set("foreign-" + visibility + "-run", active);
      await expect(fixture.stop(key)).rejects.toThrow();
      expect(active.controller.signal.aborted).toBe(false);
    }
    expect(fixture.abortHandler).not.toHaveBeenCalled();
    await fixture.assertUntouched();
  } finally {
    await fixture.close();
  }
});

it("rechecks the admitted caller after router admission and before any cancellation effects", async () => {
  const fixture = await setup();
  try {
    fixture.beforeAbort.mockImplementationOnce(async () => {
      await Promise.resolve();
      fixture.revoke();
    });
    await expect(fixture.stop()).rejects.toThrow(/revoked|no longer active/);
    expect(fixture.abortHandler).toHaveBeenCalledOnce();
    await fixture.assertUntouched();
  } finally {
    await fixture.close();
  }
});

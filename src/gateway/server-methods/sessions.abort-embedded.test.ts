/** Exact recovered-parent Stop owns its descendants, not other turns or queues. */
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expect, it, vi } from "vitest";
import { resolveActiveEmbeddedRunOwnerByRunId } from "../../agents/embedded-agent-runner/runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { resolveAgentRunAbortLifecycleFields } from "../../agents/run-termination.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  enqueueSwarmRun,
  releaseSwarmRun,
  isSwarmRunActive,
} from "../../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
} from "../../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { createActiveRun, createChatAbortContext } from "./chat.abort.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";

const fixture = useChatAbortRegistryFixture();
const parentKey = "agent:main:direct:embedded-parent";
const parentId = "embedded-parent-session";
const childKey = (id: string) => `agent:main:subagent:${id}`;

it.each(["matched", "old-incarnation", "foreign-key", "missing-row"] as const)(
  "narrow sessions.abort qualifies the exact %s embedded producer before effects",
  async (target) => {
    const client = roleClient("view", "embedded-stop-owner");
    client.connect.scopes = ["operator.sessions.write"];
    const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
    setRuntimeConfigSnapshot(cfg);
    if (target !== "missing-row") {
      await sessions.upsertSessionEntryCore(
        { agentId: "main", sessionKey: parentKey },
        {
          sessionId: parentId,
          updatedAt: 1,
          createdActor: {
            type: "human",
            source: "profile",
            id: client.authenticatedUserProfile!.profileId,
          },
        },
      );
    }
    const selectedId = target === "old-incarnation" ? "previous-parent" : parentId;
    const selectedKey = target === "foreign-key" ? "agent:main:foreign" : parentKey;
    let handle!: ReturnType<typeof createEmbeddedRunHandle>;
    const abort = vi.fn(() => clearActiveEmbeddedRun(selectedId, handle, selectedKey));
    handle = createEmbeddedRunHandle({ runId: "selected-embedded", abort });
    setActiveEmbeddedRun(selectedId, handle, selectedKey);
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const respond = vi.fn();
    try {
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "embedded-stop",
          method: "sessions.abort",
          params: { key: parentKey, runId: "selected-embedded" },
        },
        client,
        context,
        respond,
        isWebchatConnect: () => false,
        extraHandlers: { "sessions.abort": sessionAbortHandlers["sessions.abort"]! },
      });
      expect(abort).toHaveBeenCalledTimes(target === "matched" ? 1 : 0);
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[0]).toBe(target === "matched");
      if (target === "matched") {
        expect(respond.mock.calls[0]?.[1]).toEqual({
          ok: true,
          abortedRunId: "selected-embedded",
          status: "aborted",
        });
      } else {
        expect(context.dedupe.size).toBe(0);
        expect(context.rpcSources.size).toBe(0);
        expect(context.rpcSources.size).toBe(0);
      }
    } finally {
      clearActiveEmbeddedRun(selectedId, handle, selectedKey);
    }
  },
);

it.each([false, true])(
  "session-wide Stop does not retarget a successor created during cancellation (broad=%s)",
  async (broad) => {
    const client = roleClient("write", "late-embedded-stop-owner");
    client.connId = "late-embedded-stop";
    client.connect.scopes = broad
      ? ["operator.write", "operator.sessions.write"]
      : ["operator.sessions.write"];
    const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
    setRuntimeConfigSnapshot(cfg);
    await sessions.upsertSessionEntryCore(
      { agentId: "main", sessionKey: parentKey },
      {
        sessionId: parentId,
        updatedAt: 1,
        createdActor: {
          type: "human",
          source: "profile",
          id: client.authenticatedUserProfile!.profileId,
        },
      },
    );
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const queued = createActiveRun(parentKey, {
      queued: true,
      sessionId: parentId,
      agentId: "main",
      owner: { connId: client.connId },
    });
    context.rpcSources.set("original-queued", queued);
    const abort = vi.fn();
    const successor = createEmbeddedRunHandle({ runId: "late-successor", abort });
    let successorRegistration = Promise.resolve();
    let successorRegistered = false;
    queued.input.abortSignal.addEventListener(
      "abort",
      () => {
        successorRegistration = Promise.resolve().then(() => {
          setActiveEmbeddedRun(parentId, successor, parentKey);
          successorRegistered = true;
        });
      },
      { once: true },
    );
    const respond = vi.fn();
    try {
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "late-embedded",
          method: "sessions.abort",
          params: { key: parentKey },
        },
        client,
        context,
        respond,
        isWebchatConnect: () => false,
        extraHandlers: { "sessions.abort": sessionAbortHandlers["sessions.abort"]! },
      });
      await successorRegistration;
      expect(queued.input.abortSignal.aborted).toBe(true);
      expect(abort).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[1]).toEqual({
        ok: true,
        abortedRunId: "original-queued",
        status: "aborted",
      });
    } finally {
      if (successorRegistered) {
        clearActiveEmbeddedRun(parentId, successor, parentKey);
      }
    }
  },
);

async function stopParent(runId = "parent") {
  const context = createChatAbortContext({
    getRuntimeConfig,
    getSessionEventSubscriberConnIds: () => new Set(),
  });
  expect(context.rpcSources.size).toBe(0);
  const respond = vi.fn();
  await sessionAbortHandlers["sessions.abort"]!({
    req: { type: "req", id: "stop", method: "sessions.abort" },
    params: { key: parentKey, runId },
    respond,
    context: context as never,
    client: {
      connId: "operator",
      connect: { scopes: ["operator.read", "operator.write"] },
    } as never,
    isWebchatConnect: () => false,
  });
  return respond;
}

async function seedChild(id: string, turn: string, queued = true, requester = parentKey) {
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: childKey(id),
    defaultSessionId: id,
  });
  await registerSubagentRun({
    runId: id,
    childSessionKey: childKey(id),
    requesterSessionKey: requester,
    requesterAgentId: "main",
    requesterDisplayKey: requester,
    requesterTurnRunId: turn,
    task: id,
    collect: true,
    queued,
    cleanup: "keep",
    expectsCompletionMessage: false,
  });
}

it("exact embedded Stop cancels running and queued collectors without dispatching the queued sibling", async () => {
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: parentKey,
    defaultSessionId: parentId,
  });
  await seedChild("running", "parent", false);
  await seedChild("queued", "parent");
  await seedChild("other-turn", "other-parent");
  await seedChild("other-session", "parent", true, "agent:main:direct:other");
  const queuedDispatch = vi.fn(async () => {});
  const otherTurnDispatch = vi.fn(async () => {});
  const otherSessionDispatch = vi.fn(async () => {});
  for (const [runId, start] of [
    ["queued", queuedDispatch],
    ["other-turn", otherTurnDispatch],
  ] as const) {
    enqueueSwarmRun({
      groupId: "selected",
      runId,
      start,
      activeRunIds: ["running"],
      maxConcurrent: 1,
      onStartFailure: () => true,
    });
  }
  enqueueSwarmRun({
    groupId: "unrelated",
    runId: "other-session",
    start: otherSessionDispatch,
    activeRunIds: ["unrelated-capacity"],
    maxConcurrent: 1,
    onStartFailure: () => true,
  });
  const parentAbort = vi.fn(() => {
    emitAgentEvent({
      runId: "parent",
      sessionKey: parentKey,
      sessionId: parentId,
      stream: "lifecycle",
      data: { phase: "end", ...resolveAgentRunAbortLifecycleFields(AbortSignal.abort()) },
    });
    clearActiveEmbeddedRun(parentId, parent, parentKey);
  });
  const childAbort = vi.fn(() => {
    // The real lifecycle listener/cleanup releases the active collector slot.
    emitAgentEvent({
      runId: "running",
      sessionKey: childKey("running"),
      sessionId: "running",
      stream: "lifecycle",
      data: { phase: "end", ...resolveAgentRunAbortLifecycleFields(AbortSignal.abort()) },
    });
    clearActiveEmbeddedRun("running", child, childKey("running"));
  });
  const parent = createEmbeddedRunHandle({ runId: "parent", abort: parentAbort });
  const child = createEmbeddedRunHandle({ runId: "running", abort: childAbort });
  setActiveEmbeddedRun(parentId, parent, parentKey);
  setActiveEmbeddedRun("running", child, childKey("running"));
  try {
    const respond = await stopParent();
    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      abortedRunId: "parent",
      status: "aborted",
    });
    expect(parentAbort).toHaveBeenCalledOnce();
    await fixture.settle();
    for (const id of ["running", "queued"]) {
      expect(getSubagentRunByChildSessionKey(childKey(id)), id).toMatchObject({
        endedReason: "subagent-killed",
      });
    }
    expect(childAbort).toHaveBeenCalledOnce();
    expect(queuedDispatch).not.toHaveBeenCalled();
    expect(isSwarmRunActive("running")).toBe(false);
    await vi.waitFor(() => expect(otherTurnDispatch).toHaveBeenCalledOnce());
    for (const id of ["other-turn", "other-session"]) {
      expect(getSubagentRunByChildSessionKey(childKey(id))?.endedReason).toBeUndefined();
    }
    expect(otherSessionDispatch).not.toHaveBeenCalled();
    expect(releaseSwarmRun("unrelated-capacity")).toBe(true);
    await vi.waitFor(() => expect(otherSessionDispatch).toHaveBeenCalledOnce());
  } finally {
    clearActiveEmbeddedRun(parentId, parent, parentKey);
    clearActiveEmbeddedRun("running", child, childKey("running"));
  }
});

it.each(["missing", "replaced", "finalizing", "throwing", "unreadable child"])(
  "%s embedded Stop applies parent acceptance to descendants",
  async (state) => {
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: parentKey,
      defaultSessionId: parentId,
    });
    await seedChild("queued", "parent");
    const dispatch = vi.fn(async () => {});
    enqueueSwarmRun({
      groupId: "declined",
      runId: "queued",
      start: dispatch,
      activeRunIds: ["capacity"],
      maxConcurrent: 1,
      onStartFailure: () => true,
    });
    const abort = vi.fn(() => {
      if (state === "throwing") {
        clearActiveEmbeddedRun(parentId, parent, parentKey);
      }
      throw new Error("parent refused Stop");
    });
    const parent = createEmbeddedRunHandle({
      runId: "parent",
      abort,
      isAbortable: state !== "finalizing" && state !== "unreadable child",
    });
    const replacementAbort = vi.fn();
    const replacement = createEmbeddedRunHandle({ runId: "replacement", abort: replacementAbort });
    if (state !== "missing") {
      setActiveEmbeddedRun(parentId, parent, parentKey);
    }
    if (state === "replaced") {
      setActiveEmbeddedRun(parentId, replacement, parentKey);
    }
    const exactRead = sessions.loadExactSessionEntryReadOnly;
    const failedRead = vi.fn();
    const reader = vi
      .spyOn(sessions, "loadExactSessionEntryReadOnly")
      .mockImplementation((scope) => {
        if (state === "unreadable child" && scope.sessionKey === childKey("queued")) {
          failedRead();
          throw new Error("preparatory child read failed");
        }
        return exactRead(scope);
      });
    try {
      const respond = await stopParent();
      if (state === "unreadable child") {
        expect(failedRead).toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "UNAVAILABLE",
            message: expect.stringContaining("descendant cancellation was incomplete"),
          }),
        );
      } else {
        expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
          true,
          {
            ok: true,
            abortedRunId: state === "throwing" ? "parent" : null,
            status: state === "throwing" ? "aborted" : "no-active-run",
          },
        ]);
      }
      expect(abort).toHaveBeenCalledTimes(state === "throwing" ? 1 : 0);
      expect(replacementAbort).not.toHaveBeenCalled();
      if (state === "finalizing" || state === "throwing") {
        expect(getSubagentRunByChildSessionKey(childKey("queued"))).toMatchObject({
          endedReason: "subagent-killed",
        });
        expect(dispatch).not.toHaveBeenCalled();
        expect(releaseSwarmRun("capacity")).toBe(true);
        expect(dispatch).not.toHaveBeenCalled();
      } else {
        expect(getSubagentRunByChildSessionKey(childKey("queued"))).toMatchObject({
          execution: { status: "queued" },
        });
        expect(getSubagentRunByChildSessionKey(childKey("queued"))?.killIntent).toBeUndefined();
        expect(dispatch).not.toHaveBeenCalled();
        expect(releaseSwarmRun("capacity")).toBe(true);
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      }
    } finally {
      reader.mockRestore();
      clearActiveEmbeddedRun(parentId, state === "replaced" ? replacement : parent, parentKey);
    }
  },
);

it.each([
  { method: "chat.abort", finalizing: true },
  { method: "sessions.abort", finalizing: true },
  { method: "chat.abort", finalizing: false },
  { method: "sessions.abort", finalizing: false },
] as const)(
  "$method controller-backed Stop respects parent acceptance (finalizing=$finalizing)",
  async ({ method, finalizing }) => {
    const parentStorePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: parentKey,
      defaultSessionId: parentId,
    });
    await seedChild("running", "parent", false);
    await seedChild("queued", "parent");
    const dispatch = vi.fn(async () => {});
    enqueueSwarmRun({
      groupId: "controller-backed",
      runId: "queued",
      start: dispatch,
      activeRunIds: ["running"],
      maxConcurrent: 1,
      onStartFailure: () => true,
    });
    const context = createChatAbortContext({
      getRuntimeConfig,
      getSessionEventSubscriberConnIds: () => new Set(),
    });
    const registration = registerChatAbortController({
      rpcSources: context.rpcSources,
      target: captureSessionTarget({
        storeScope: parentStorePath,
        sessionKey: parentKey,
        incarnation: parentId,
        agentId: "main",
      }),
      runId: "parent",
      sessionId: parentId,
      sessionKey: parentKey,
      agentId: "main",
      ownerConnId: "operator",
      kind: "agent",
      timeoutMs: 30_000,
    });
    expect(registration.registered).toBe(true);
    if (!registration.registered) {
      throw new Error("Expected the parent abort controller to register");
    }
    let claim!: Parameters<typeof releaseSessionControllerClaim>[0];
    let operation!: ReturnType<typeof createReplyOperation>;
    await claimSessionControllerTask(registration.entry.input, (capturedClaim) => {
      claim = capturedClaim;
      operation = createReplyOperation({
        sessionKey: parentKey,
        sessionId: parentId,
        agentId: "main",
        resetTriggered: false,
        mailboxClaim: capturedClaim,
      });
    });
    const parentAbort = vi.fn(() => {
      clearActiveEmbeddedRun(parentId, parent, parentKey);
      operation.complete();
      releaseSessionControllerClaim(claim);
    });
    const parent = createEmbeddedRunHandle({ runId: "parent", abort: parentAbort });
    const childAbort = vi.fn(() => {
      emitAgentEvent({
        runId: "running",
        sessionKey: childKey("running"),
        sessionId: "running",
        stream: "lifecycle",
        data: { phase: "end", ...resolveAgentRunAbortLifecycleFields(AbortSignal.abort()) },
      });
      clearActiveEmbeddedRun("running", child, childKey("running"));
    });
    const child = createEmbeddedRunHandle({ runId: "running", abort: childAbort });
    setActiveEmbeddedRun(parentId, parent, parentKey, undefined, "main", operation);
    setActiveEmbeddedRun("running", child, childKey("running"));
    try {
      if (finalizing) {
        operation.freezeAbort();
      }
      expect(resolveActiveEmbeddedRunOwnerByRunId("parent")).toBeDefined();
      expect(context.rpcSources.get("parent")).toBe(registration.entry);
      const respond = vi.fn();
      const handler =
        method === "chat.abort" ? handleChatAbortRequest : sessionAbortHandlers[method]!;
      await handler({
        req: { type: "req", id: "stop", method },
        params: {
          ...(method === "chat.abort" ? { sessionKey: parentKey } : { key: parentKey }),
          runId: "parent",
        },
        respond,
        context: context as never,
        client: {
          connId: "operator",
          connect: { scopes: ["operator.read", "operator.write"] },
        } as never,
        isWebchatConnect: () => false,
      });
      expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
        true,
        method === "chat.abort"
          ? { ok: true, aborted: !finalizing, runIds: finalizing ? [] : ["parent"] }
          : {
              ok: true,
              abortedRunId: finalizing ? null : "parent",
              status: finalizing ? "no-active-run" : "aborted",
            },
      ]);
      expect(registration.controller.signal.aborted).toBe(!finalizing);
      expect(parentAbort).toHaveBeenCalledTimes(finalizing ? 0 : 1);
      await fixture.settle();
      expect.soft(childAbort).toHaveBeenCalledOnce();
      expect(dispatch).not.toHaveBeenCalled();
      for (const id of ["running", "queued"]) {
        const run = getSubagentRunByChildSessionKey(childKey(id));
        expect(run, id).toMatchObject({ endedReason: "subagent-killed" });
      }
      expect(isSwarmRunActive("running")).toBe(false);
    } finally {
      clearActiveEmbeddedRun(parentId, parent, parentKey);
      clearActiveEmbeddedRun("running", child, childKey("running"));
      operation.complete();
      releaseSessionControllerClaim(claim);
      registration.cleanup();
    }
  },
);

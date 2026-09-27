import path from "node:path";
import { inspect } from "node:util";
import { assert, expect, vi } from "vitest";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  bindSessionPendingInputWorkerAuthority,
  joinSessionPendingInputReceipt,
} from "../../config/sessions/session-accessor.pending-input-receipt.js";
import { stageSessionPendingInput } from "../../config/sessions/session-accessor.pending-inputs.js";
import { readTranscriptEventRows } from "../../config/sessions/session-accessor.sqlite-read.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureGatewayDeviceRevocation } from "../../gateway/device-revocation.js";
import { createExpectedProfileBinding } from "../../gateway/expected-profile.js";
import { createChatSendWorkAdmission } from "../../gateway/server-methods/chat-send-work-admission.js";
import {
  bindGatewayRequestHandlerMutationAuthority,
  bindWebSocketRequestMutationAuthority,
  prepareGatewayPendingInputWorkerAuthority,
} from "../../gateway/server-methods/session-mutation-guards.js";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../gateway/server-methods/types.js";
import { SharedGatewaySessionGenerationState } from "../../gateway/server-shared-auth-generation.js";
import { createOperatorWsClient } from "../../gateway/server/ws-connection/authenticated-request-dispatch.test-support.js";
import { resolveSessionMutationAuthorization } from "../../gateway/session-sharing.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { installSessionToolResultGuard } from "../session-tool-result-guard.js";
import {
  createSessionToolResultPending,
  sessionToolResultPending,
} from "../session-tool-result-pending.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { createSessionManagerMessageRuntime } from "./session-manager-message-runtime.js";
import type { SessionManager } from "./session-manager.js";
import type { SessionMessageAppendOutcome } from "./session-message-append-operation.js";

export const assistant = (name = "read") =>
  makeAgentAssistantMessage({
    content: [{ type: "toolCall", id: "shared", name, arguments: {} }],
  });
export const result = (text = "result") => ({
  ...makeTextToolResult("shared", "read", text, false, 1),
  idempotencyKey: "message-worker-result",
});

export function assertPendingNavigation(
  manager: SessionManager,
  navigation: "branch" | "resetLeaf",
) {
  const observed = vi.fn();
  const guard = installSessionToolResultGuard(manager, { onMessagePersisted: observed });
  const root = manager.appendMessage({ role: "user", content: "branch root", timestamp: 1 });
  const originalEntry = manager.appendMessage(assistant("original"));
  const { pending, owner } = manager[sessionToolResultPending];
  const original = pending.calls(owner)[0];
  assert(original);
  expect(original).toMatchObject({ originId: originalEntry, id: "shared", name: "original" });
  if (navigation === "branch") {
    manager.branch(root);
  } else {
    manager.resetLeaf();
  }
  // This is the operator-visible baseline failure: inactive custody must not
  // synthesize a result onto the newly selected branch before this user append.
  const user = manager.appendMessage({ role: "user", content: "new branch", timestamp: 2 });
  expect(manager.getEntry(user)).toMatchObject({ message: { content: "new branch" } });
  expect(guard.getPendingIds()).toEqual([]);
  expect(guard.hasPendingToolResults()).toBe(false);
  expect(pending.calls(owner)).toEqual([original]);
  expect(pending.calls(owner)[0]).toBe(original);
  expect(
    manager
      .getEntries()
      .filter((entry) => entry.type === "message" && entry.message.role === "toolResult"),
  ).toEqual([]);
  const nextEntry = manager.appendMessage(assistant("new-path"));
  manager.appendMessage({ ...result(), toolName: "" });
  expect(manager.getLeafEntry()).toMatchObject({
    parentId: nextEntry,
    message: { toolCallId: "shared", toolName: "new-path", isError: false },
  });
  expect(pending.calls(owner)[0]).toBe(original);
  expect(guard.getPendingIds()).toEqual([]);
  manager.branch(originalEntry);
  expect(guard.getPendingIds()).toEqual(["shared"]);
  expect(guard.hasPendingToolResults()).toBe(true);
  expect(pending.calls(owner)[0]).toBe(original);
  guard.flushPendingToolResults();
  expect(manager.getLeafEntry()).toMatchObject({
    parentId: originalEntry,
    message: { toolCallId: "shared", toolName: "original", isError: true },
  });
  expect(guard.getPendingIds()).toEqual([]);
  expect(pending.calls(owner)).toEqual([]);
  guard.flushPendingToolResults();
  const results = manager
    .getEntries()
    .flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
    );
  expect(results).toHaveLength(2);
  expect(results.filter((message) => message.isError)).toHaveLength(1);
  return observed;
}

export function assertPendingDiscardNavigation(
  manager: SessionManager,
  navigation: "branch" | "resetLeaf",
  boundary: "user" | "flush",
) {
  const observed = vi.fn();
  const guard = installSessionToolResultGuard(manager, {
    allowSyntheticToolResults: false,
    onMessagePersisted: observed,
  });
  const root = manager.appendMessage({ role: "user", content: "branch root", timestamp: 1 });
  const originalEntry = manager.appendMessage(assistant("original"));
  const { pending, owner } = manager[sessionToolResultPending];
  const original = pending.calls(owner)[0];
  assert(original);
  if (navigation === "branch") {
    manager.branch(root);
  } else {
    manager.resetLeaf();
  }
  const nextEntry = manager.appendMessage(assistant("new-path"));
  expect(guard.getPendingIds()).toEqual(["shared"]);
  expect(pending.calls(owner)).toHaveLength(2);
  if (boundary === "user") {
    manager.appendMessage({ role: "user", content: "retire selected calls", timestamp: 2 });
  } else {
    guard.flushPendingToolResults();
  }
  expect(guard.getPendingIds()).toEqual([]);
  expect(pending.calls(owner)).toEqual([original]);
  expect(pending.calls(owner)[0]).toBe(original);
  expect(pending.calls(owner).some((call) => call.originId === nextEntry)).toBe(false);
  expect(
    manager
      .getEntries()
      .filter((entry) => entry.type === "message" && entry.message.role === "toolResult"),
  ).toEqual([]);
  manager.branch(originalEntry);
  expect(guard.getPendingIds()).toEqual(["shared"]);
  manager.appendMessage({ ...result(), toolName: "" });
  expect(manager.getLeafEntry()).toMatchObject({
    parentId: originalEntry,
    message: { toolCallId: "shared", toolName: "original", isError: false },
  });
  expect(pending.calls(owner)).toEqual([]);
  expect(guard.getPendingIds()).toEqual([]);
  guard.flushPendingToolResults();
  expect(
    manager
      .getEntries()
      .filter((entry) => entry.type === "message" && entry.message.role === "toolResult"),
  ).toHaveLength(1);
  return observed;
}

export function committed(
  outcome: SessionMessageAppendOutcome,
  diagnostic?: { phase: string; native?: number[] },
) {
  expect(
    outcome.kind,
    diagnostic && outcome.kind !== "committed"
      ? inspect(
          { ...diagnostic, outcome },
          { depth: null, maxArrayLength: null, maxStringLength: null },
        )
      : undefined,
  ).toBe("committed");
  if (outcome.kind !== "committed") {
    throw new Error("Expected a retained native commit");
  }
  expect(outcome.facts.kind).toBe("manager");
  if (outcome.facts.kind !== "manager") {
    throw new Error("Expected the retained manager reservation");
  }
  return { ...outcome, facts: outcome.facts };
}

export async function setup(
  state: OpenClawTestState,
  agentId = "main",
  pending = createSessionToolResultPending(),
  assertCurrent = () => {},
  options: {
    initialize?: boolean;
    scopePath?: "default" | "mismatched";
    initialEntry?: Pick<Parameters<typeof replaceSessionEntry>[1], "createdActor" | "visibility">;
  } = {},
) {
  const scope = {
    agentId,
    sessionId: `message-${agentId}`,
    sessionKey: `agent:${agentId}:message-worker`,
    storePath: path.join(state.agentDir(agentId), "openclaw-agent.sqlite"),
    env: state.env,
  };
  if (options.initialize !== false) {
    await replaceSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      ...options.initialEntry,
    });
  }
  const execution = captureOpenClawAgentDatabaseExecution({
    agentId,
    path: scope.storePath,
    env: state.env,
  });
  const owner = { databasePath: execution.path, sessionId: scope.sessionId };
  const runtime = createSessionManagerMessageRuntime({
    execution,
    scope: {
      ...scope,
      storePath:
        options.scopePath === "default"
          ? undefined
          : options.scopePath === "mismatched"
            ? path.join(state.agentDir("foreign"), "openclaw-agent.sqlite")
            : scope.storePath,
    },
    pending,
    assertCurrent,
  });
  return {
    scope,
    owner,
    execution,
    runtime,
    pending,
    rows: () =>
      readTranscriptEventRows(
        openOpenClawAgentDatabase({ agentId, path: scope.storePath, env: state.env }),
        scope.sessionId,
      ),
  };
}

export async function queuedInput(
  fixture: Awaited<ReturnType<typeof setup>>,
  cfg: OpenClawConfig,
  runId: string,
  text = "accepted input",
  trackCompletion = false,
  client = createOperatorWsClient(),
  sessionScope?: Parameters<typeof resolveSessionMutationAuthorization>[0]["sessionScope"],
) {
  const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
  const device = captureGatewayDeviceRevocation(
    context,
    { deviceId: runId, role: "operator" },
    () => !client.invalidated,
  );
  let work: ReturnType<typeof createChatSendWorkAdmission> | undefined;
  let authority: Awaited<ReturnType<typeof prepareGatewayPendingInputWorkerAuthority>>;
  let receipt: Awaited<ReturnType<typeof stageSessionPendingInput>>;
  let bound = false;
  try {
    const params = { sessionKey: fixture.scope.sessionKey, message: text, idempotencyKey: runId };
    const request: GatewayRequestOptions = {
      req: { type: "req", id: runId, method: "chat.send", params },
      client,
      context,
      isWebchatConnect: () => true,
      respond: vi.fn(),
      hasCurrentClientAuthority: device.isCurrent,
    };
    bindWebSocketRequestMutationAuthority(
      request,
      client,
      new SharedGatewaySessionGenerationState({ current: undefined, required: null }).reader,
    );
    const resolved = resolveSessionMutationAuthorization({
      client,
      context,
      method: "chat.send",
      requestParams: params,
      sessionScope,
    });
    expect(resolved.error).toBeNull();
    if (!resolved.authorization) {
      throw new Error("Missing real session authorization");
    }
    const expectedProfileBinding = await createExpectedProfileBinding(
      client.authenticatedUserProfile?.profileId,
      client,
    );
    expectedProfileBinding?.assertCurrent();
    const handler = bindGatewayRequestHandlerMutationAuthority(
      request,
      {
        ...request,
        params,
        sessionMutationAuthorization: resolved.authorization,
      },
      expectedProfileBinding,
      sessionScope,
    );
    const admission = await beginSessionWorkAdmission({
      scope: fixture.scope.storePath,
      identities: [fixture.scope.sessionKey, fixture.scope.sessionId],
      assertAllowed: () => resolved.authorization!.assertCurrent(),
    });
    work = createChatSendWorkAdmission({
      admission,
      logGateway: { warn: vi.fn() },
      releaseCallerAuthority: device.release,
    });
    const controller = new AbortController();
    const lifetime = work.captureInputLifetime({
      controller,
      queuedTurns: new Map(),
      runId,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    });
    authority = await prepareGatewayPendingInputWorkerAuthority(handler, lifetime);
    if (!authority) {
      throw new Error("Ordinary Gateway source was not certified for its worker");
    }
    const prepare = vi.fn((message: PersistedUserTurnMessage) => ({ ...message, content: text }));
    receipt = await stageSessionPendingInput(fixture.scope, {
      runId,
      trackCompletion,
      message: {
        role: "user",
        content: "unapproved",
        timestamp: 1,
        idempotencyKey: `${runId}:user`,
      },
      assertCurrent: () => resolved.authorization!.assertCurrent(),
      prepareMessageAfterIdempotencyCheck: prepare,
    });
    if (!receipt) {
      throw new Error("Missing original pending input receipt");
    }
    const original = receipt;
    work.setPendingInputCleanup(() => {
      original.finish("interrupted");
      return joinSessionPendingInputReceipt(original);
    });
    bound = bindSessionPendingInputWorkerAuthority(receipt, authority);
    if (!bound) {
      throw new Error("Missing original pending input receipt");
    }
    return {
      receipt,
      prepare,
      authority,
      handler,
      client,
      controller,
      lifetime,
      expectedProfileBinding,
      work,
      admission,
      device,
    };
  } catch (error) {
    const failures = [error];
    if (!bound) {
      try {
        authority?.release();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    try {
      if (work) {
        await work.release();
      } else {
        device.release();
      }
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    throw failures.length === 1
      ? error
      : new AggregateError(failures, "Input fixture setup failed");
  }
}

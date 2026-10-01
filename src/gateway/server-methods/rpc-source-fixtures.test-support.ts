import { randomUUID } from "node:crypto";
import { onTestFinished } from "vitest";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import type { RpcSourceAdapter } from "../../sessions/session-controller.rpc-sources.js";
import { registerChatAbortController } from "../chat-abort.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { claimRpcSourceForTest, createRpcSourceForTest } from "../test-helpers.rpc-source.js";

/** Use the fixture's physical partition, not a logical key as a store owner. */
export function captureRpcTargetForTest(scope: {
  sessionKey: string;
  sessionId: string;
  agentId?: string;
  storeScope?: string;
}) {
  return captureSessionTarget({
    storeScope:
      scope.storeScope ??
      loadGatewaySessionEntryReadOnly(scope.sessionKey, { agentId: scope.agentId }).storePath,
    sessionKey: scope.sessionKey,
    incarnation: scope.sessionId,
    agentId: scope.agentId,
  });
}

/** Isolated dispatch-edge tests still use the real registration and forwarding signal. */
export function registerRpcSourceForTest(
  params: Omit<Parameters<typeof registerChatAbortController>[0], "target" | "timeoutMs"> & {
    storeScope?: string;
  },
) {
  const registration = registerChatAbortController({
    ...params,
    timeoutMs: 60_000,
    target: captureSessionTarget({
      storeScope: params.storeScope ?? "/synthetic/rpc-registration/" + randomUUID(),
      sessionKey: params.sessionKey ?? "agent:main:fixture",
      incarnation: params.sessionId,
      agentId: params.agentId,
    }),
  });
  if (!registration.registered) {
    throw new Error("Expected a registered fixture source");
  }
  onTestFinished(() => {
    registration.entry?.input.claim?.operation?.complete();
    registration.cleanup();
  });
  return registration;
}

/** Projection-only fixtures still acquire an actual selector claim and operation. */
export async function createActiveRpcSourceForTest(
  metadata: Partial<RpcSourceAdapter> & { projectSessionActive?: boolean } = {},
) {
  const ref = createRpcSourceForTest(metadata);
  await claimRpcSourceForTest(ref);
  return ref;
}

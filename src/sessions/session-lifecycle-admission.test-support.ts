import { vi } from "vitest";
import { captureSessionTarget } from "./session-controller.lifecycle.js";
import * as sessionLifecycle from "./session-controller.lifecycle.js";
import type { RpcSourceIdentity, RpcSourceRef } from "./session-controller.rpc-sources.js";
import {
  rpcSourceByRunId,
  rpcSourceRemovalByRef,
  sessionControllers,
} from "./session-controller.storage.js";

export function observeSessionWorkAdmissionDrain(
  afterDrain: (
    params: Parameters<typeof sessionLifecycle.startSessionControllerInterruption>[0],
    released: boolean,
  ) => Promise<void> | void,
): () => void {
  const startInterruption = sessionLifecycle.startSessionControllerInterruption;
  const waitForRelease = sessionLifecycle.waitForSessionControllerSettlement;
  const interruptions = new WeakMap<Promise<void>, Parameters<typeof startInterruption>[0]>();
  const start = vi
    .spyOn(sessionLifecycle, "startSessionControllerInterruption")
    .mockImplementation((params) => {
      const interruption = startInterruption(params);
      interruptions.set(interruption.released, params);
      return interruption;
    });
  const wait = vi
    .spyOn(sessionLifecycle, "waitForSessionControllerSettlement")
    .mockImplementation(async (pending, timeoutMs) => {
      const released = await waitForRelease(pending, timeoutMs);
      const params = interruptions.get(pending);
      if (params) {
        interruptions.delete(pending);
        // Fixture pauses follow the real drain, outside its production deadline.
        await afterDrain(params, released);
      }
      return released;
    });
  return () => {
    wait.mockRestore();
    start.mockRestore();
  };
}

type RunExclusiveSessionLifecycleParams<T> = {
  scope: string;
  identities: Iterable<string | undefined>;
  signal?: AbortSignal;
  run: () => Promise<T>;
};

/** Holds real effect validation for boundary race fixtures; no production test API. */
export async function runExclusiveSessionLifecycle<T>(
  params: RunExclusiveSessionLifecycleParams<T>,
): Promise<T> {
  let result: { value: T } | undefined;
  const effect = await sessionLifecycle.beginSessionEffect({
    scope: params.scope,
    identities: params.identities,
    signal: params.signal,
    assertAllowed: async () => {
      result = { value: await params.run() };
    },
    revalidateAllowed: () => {},
  });
  effect.release();
  if (!result) {
    throw new Error("Effect validator did not execute");
  }
  return result.value;
}

/** Rebinds a fixture through controller-owned target and operation identity. */
export function setRpcSourceIdentityForTest(
  source: RpcSourceRef,
  identity: Partial<RpcSourceIdentity>,
): void {
  const current = source.input.target;
  if (!current) {
    throw new Error("Test RPC source has no captured target");
  }
  const operation = source.input.claim?.operation;
  if (operation && (identity.sessionKey !== undefined || identity.agentId !== undefined)) {
    operation.updateSessionKey(
      identity.sessionKey ?? operation.key,
      identity.agentId ?? operation.agentId,
      source.input.claim,
    );
  }
  source.input.target = captureSessionTarget({
    storeScope: current.storeScope,
    sessionKey: identity.sessionKey ?? current.sessionKey,
    incarnation: identity.sessionId ?? source.input.sourceSessionId ?? current.incarnation,
    agentId: identity.agentId ?? current.agentId,
  });
  if (identity.sessionId !== undefined) {
    source.input.sourceSessionId = identity.sessionId;
    operation?.updateSessionId(identity.sessionId);
  }
}

/** Drops test-owned controller singletons after their operations have been completed. */
export function resetSessionControllerStateForTest(): void {
  rpcSourceByRunId.clear();
  sessionControllers.clear();
}

/** Test-only access to controller-owned protocol correlation. */
export const rpcSourceTesting = Object.assign(rpcSourceByRunId, {
  deleteExpected(runId: string, expected: RpcSourceRef): boolean {
    if (rpcSourceByRunId.get(runId) !== expected) {
      return false;
    }
    rpcSourceByRunId.delete(runId);
    const onRemoved = rpcSourceRemovalByRef.get(expected);
    rpcSourceRemovalByRef.delete(expected);
    onRemoved?.();
    return true;
  },
  reset(entries: Iterable<readonly [string, RpcSourceRef]> = []): void {
    rpcSourceByRunId.clear();
    for (const [runId, ref] of entries) {
      rpcSourceByRunId.set(runId, ref);
    }
  },
});

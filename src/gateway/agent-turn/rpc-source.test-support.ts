import { afterEach } from "vitest";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import {
  requestRpcSourceCancellation,
  type RpcSourceAdapter,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";

const sources = new Set<RpcSourceRef>();
let storeSequence = 0;
afterEach(() => {
  for (const source of sources) {
    retireSessionControllerInput(source.input);
  }
  sources.clear();
});

export function createTestRpcSource(adapter: RpcSourceAdapter, runId = "test-run"): RpcSourceRef {
  const input = reserveSessionControllerSource(adapter.sessionKey, {
    protocolRunId: runId,
    sourceTurnId: runId,
    target: captureSessionTarget({
      storeScope: `/synthetic/agent-rpc/${++storeSequence}/sessions.db`,
      sessionKey: adapter.sessionKey,
      incarnation: adapter.sessionId,
      agentId: adapter.agentId,
    }),
    policy: { mode: "followup" },
    adapter,
  });
  const source = { input, adapter };
  sources.add(source);
  return source;
}

export function testRpcSourceController(source: RpcSourceRef): AbortController {
  return {
    signal: source.input.abortSignal,
    abort: (reason?: unknown) => {
      requestRpcSourceCancellation(source, reason);
    },
  };
}

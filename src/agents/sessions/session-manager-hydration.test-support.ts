import path from "node:path";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";

export function canonicalTarget(
  state: OpenClawTestState,
  sessionId: string,
  sessionKey = `agent:main:${sessionId}`,
) {
  return {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
  };
}

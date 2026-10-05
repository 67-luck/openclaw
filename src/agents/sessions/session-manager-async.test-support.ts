import path from "node:path";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { SessionManager } from "../../plugin-sdk/agent-sessions.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";

export async function openAsyncSessionFixture(
  state: OpenClawTestState,
  name: string,
  incognito = false,
) {
  const target = {
    agentId: "main",
    sessionId: name,
    sessionKey: incognito ? `agent:main:dashboard:incognito-${name}` : `agent:main:${name}`,
    storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
  };
  await replaceSessionEntry(target, {
    sessionId: name,
    updatedAt: 1,
    ...(incognito ? { incognito: true } : {}),
  });
  return { target, manager: await SessionManager.openAsync(target, state.workspaceDir) };
}

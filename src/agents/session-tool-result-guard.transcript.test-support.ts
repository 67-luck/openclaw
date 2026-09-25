// Verifies guarded session managers emit transcript update events with stable sequence ids.
import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

export function createTranscriptEventFixture() {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let fixtureId = 0;

  async function openPersistedSessionManager(lifecycleRevision?: string) {
    const root = tempDirs.make("openclaw-transcript-events-");
    const sessionId = `session-${fixtureId++}`;
    const target = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
    };
    const sessionEntry = { sessionId, updatedAt: Date.now(), lifecycleRevision };
    await upsertSessionEntry({
      ...target,
      entry: sessionEntry,
    });
    return { root, sessionManager: SessionManager.open(target, root), target, sessionEntry };
  }
  return { openPersistedSessionManager };
}

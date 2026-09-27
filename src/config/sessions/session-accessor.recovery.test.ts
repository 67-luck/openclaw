import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  resumeSessionEntryFromRestartTombstone,
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "./session-accessor.js";
import type { InternalSessionEntry } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createFixture() {
  const root = tempDirs.make("openclaw-session-recovery-");
  const storePath = path.join(root, "sessions.json");
  const sourceKey = "agent:main:dashboard:tombstoned";
  const successorKey = "agent:main:dashboard:recovered";
  const sourceSessionId = "source-session";
  await replaceSessionEntry({ agentId: "main", sessionKey: sourceKey, storePath }, {
    sessionId: sourceSessionId,
    updatedAt: 10,
    pinnedAt: 5,
    pluginOwnerId: "codex",
    mainRestartRecovery: {
      cycleId: "cycle-1",
      revision: 4,
      chargedAttempts: 3,
      tombstone: { reason: "automatic recovery exhausted" },
    },
  } as InternalSessionEntry);
  await replaceTranscriptEvents(
    { agentId: "main", sessionId: sourceSessionId, sessionKey: sourceKey, storePath },
    [
      {
        type: "session",
        version: 3,
        id: sourceSessionId,
        timestamp: "2026-08-12T00:00:00.000Z",
        cwd: root,
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-08-12T00:00:01.000Z",
        message: { role: "user", content: "finish this" },
      },
      {
        type: "message",
        id: "side-branch",
        parentId: "user-1",
        timestamp: "2026-08-12T00:00:02.000Z",
        message: { role: "assistant", content: "preserve the whole transcript" },
      },
      {
        type: "leaf",
        id: "leaf-1",
        parentId: "side-branch",
        timestamp: "2026-08-12T00:00:03.000Z",
        targetId: "user-1",
      },
    ],
  );
  return { root, sourceKey, sourceSessionId, storePath, successorKey };
}

describe("resumeSessionEntryFromRestartTombstone", () => {
  it("preserves the transcript and metadata while clearing failed execution ownership", async () => {
    const fixture = await createFixture();
    const scope = { agentId: "main", sessionKey: fixture.sourceKey, storePath: fixture.storePath };
    const expected = loadSessionEntry(scope)!;
    const transcriptScope = { ...scope, sessionId: fixture.sourceSessionId };
    const before = await loadTranscriptEvents(transcriptScope);
    const resumed = await resumeSessionEntryFromRestartTombstone({
      ...scope,
      expected,
      commitGuard: () => {},
    });
    expect(resumed).toMatchObject({
      sessionId: fixture.sourceSessionId,
      pinnedAt: 5,
      pluginOwnerId: "codex",
    });
    expect(resumed.mainRestartRecovery).toBeUndefined();
    expect(resumed.archivedAt).toBeUndefined();
    expect(resumed.restartRecoveryResumeRunId).toBeTruthy();
    await expect(loadTranscriptEvents(transcriptScope)).resolves.toEqual(before);
    expect(loadSessionEntry({ ...scope, sessionKey: fixture.successorKey })).toBeUndefined();
  });

  it.each(["recovery", "lifecycle", "archive", "authority"] as const)(
    "leaves the session unchanged after a %s conflict",
    async (conflict) => {
      const fixture = await createFixture();
      const scope = {
        agentId: "main",
        sessionKey: fixture.sourceKey,
        storePath: fixture.storePath,
      };
      const expected = loadSessionEntry(scope)!;
      const current = {
        ...expected,
        ...(conflict === "lifecycle" ? { lifecycleRevision: "new-lifecycle" } : {}),
        ...(conflict === "archive" ? { archivedAt: 100 } : {}),
        ...(conflict === "recovery"
          ? { mainRestartRecovery: { ...expected.mainRestartRecovery!, revision: 5 } }
          : {}),
      };
      await replaceSessionEntry(scope, current);
      const before = loadSessionEntry(scope);
      await expect(
        resumeSessionEntryFromRestartTombstone({
          ...scope,
          expected,
          commitGuard: () => {
            if (conflict === "authority") {
              throw new Error("revoked");
            }
          },
        }),
      ).rejects.toThrow(conflict === "authority" ? "revoked" : "changed before recovery");
      expect(loadSessionEntry(scope)).toEqual(before);
    },
  );
});

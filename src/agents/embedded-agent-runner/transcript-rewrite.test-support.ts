import path from "node:path";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "../../config/sessions/session-transcript-reconcile.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import type { SessionManager } from "../sessions/session-manager.js";

export function useTranscriptRewriteFixtures(
  registerCleanup: (cleanup: () => Promise<void>) => unknown,
) {
  const lifetime = createFixtureLifetime();
  const tempDirs = useAutoCleanupTempDirTracker((removeDirectories) => {
    registerCleanup(async () => {
      void lifetime.verifyCleanup(async () => {
        const failures: unknown[] = [];
        for (const directory of tempDirs.dirs) {
          for (const settle of [
            () => waitForSessionTranscriptIndexReconcilesInStateDir(directory),
            () => closeOpenClawAgentDatabasesAsync(directory),
          ]) {
            try {
              await settle();
            } catch (error) {
              failures.push(error);
            }
          }
        }
        if (failures.length) {
          throw new AggregateError(failures, "Transcript rewrite fixture cleanup failed");
        }
        removeDirectories();
      });
      await lifetime.cleanup();
    });
  });
  return {
    tempDirs,
    createPersistedRewriteTarget: async (sessionId: string) => {
      const directory = tempDirs.make(`openclaw-${sessionId}-`);
      const target = {
        agentId: "main",
        sessionId,
        sessionKey: `agent:main:${sessionId}`,
        storePath: path.join(directory, "sessions.json"),
      };
      await replaceSessionEntry(target, { sessionId, updatedAt: 1 });
      return { directory, target };
    },
  };
}

export function getBranchMessages(sessionManager: SessionManager) {
  return sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
}

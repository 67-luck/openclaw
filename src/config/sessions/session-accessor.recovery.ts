import { buildMainSessionRecoveryClearPatch } from "../../agents/main-session-recovery/main-session-recovery-clear.js";
import { buildRestartRecoveryClaimCleanupPatch } from "./restart-recovery-state.js";
import { applySessionEntryReplacements } from "./session-accessor.lifecycle.js";
import type { InternalSessionEntry } from "./types.js";

/** Releases a failed automatic cycle without replacing the conversation or its workspace. */
export async function resumeSessionEntryFromRestartTombstone(params: {
  agentId: string;
  sessionKey: string;
  storePath: string;
  expected: InternalSessionEntry;
  commitGuard: () => void;
}): Promise<InternalSessionEntry> {
  return await applySessionEntryReplacements({
    agentId: params.agentId,
    sessionKeys: [params.sessionKey],
    storePath: params.storePath,
    requireWriteSuccess: true,
    assertCommitAllowed: params.commitGuard,
    update: (entries) => {
      const current = entries.find(({ sessionKey }) => sessionKey === params.sessionKey)?.entry;
      const recovery = current?.mainRestartRecovery;
      if (
        !current ||
        current.sessionId !== params.expected.sessionId ||
        current.lifecycleRevision !== params.expected.lifecycleRevision ||
        recovery?.cycleId !== params.expected.mainRestartRecovery?.cycleId ||
        recovery?.revision !== params.expected.mainRestartRecovery?.revision ||
        !recovery?.tombstone ||
        recovery.tombstone.recoveredSessionKey ||
        recovery.tombstone.recoveredSessionId ||
        current.archivedAt !== undefined
      ) {
        throw new Error("Session changed before recovery; refresh and retry.");
      }
      const entry: InternalSessionEntry = {
        ...current,
        ...buildMainSessionRecoveryClearPatch(current),
        ...buildRestartRecoveryClaimCleanupPatch({ entry: current, recordTerminalSource: true }),
        // Correlation only: retries still require current session and continuation authorization.
        restartRecoveryResumeRunId: `restart-recovery-resume:${current.sessionId}:${recovery.cycleId}`,
        activeWriterRunId: undefined,
        lifecycleRunId: undefined,
        updatedAt: Date.now(),
      };
      return { result: entry, replacements: [{ sessionKey: params.sessionKey, entry }] };
    },
  });
}

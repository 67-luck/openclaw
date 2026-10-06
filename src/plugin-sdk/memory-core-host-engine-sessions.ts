/** Private-local SDK subpath for memory session transcript helpers. */
import {
  buildSessionEntry as buildSessionEntryFromHost,
  listSessionTranscriptCorpusEntriesForAgent as listSessionTranscriptCorpusEntriesFromHost,
  readSessionResetRecallCutoff as readSessionResetRecallCutoffFromHost,
} from "../../packages/memory-host-sdk/src/engine-sessions.js";
import {
  readMemorySessionMetadata,
  readMemorySessionTargets,
} from "../config/sessions/session-memory-targets.js";
import type {
  MemorySessionSelectors,
  MemorySessionTarget,
} from "../config/sessions/session-memory-targets.types.js";

export type {
  MemorySessionSelectors,
  MemorySessionTarget,
} from "../config/sessions/session-memory-targets.types.js";

/** @deprecated Use loadArchivedSessionsAsync; removed at the next Plugin SDK major. */
export { listSessionTranscriptArchivesReadOnly as loadArchivedSessions } from "../config/sessions/session-accessor.js";
export {
  listSessionTranscriptArchivesInWorker as loadArchivedSessionsAsync,
  readMemorySessionMetadataInWorker as loadMemorySessionMetadataAsync,
  resolveMemorySessionTargetsInWorker as resolveMemorySessionTargetsAsync,
} from "../config/sessions/session-transcript-inventory-runtime.js";

export {
  extractKeywords,
  isCronRunSessionKey,
  isDreamingNarrativeSessionStoreKey,
  matchesSessionEntryPrefixHash,
  parseUsageCountedSessionIdFromFileName,
  readTranscriptStatsBatchReadOnlySync,
  sessionPathForFile,
  sessionPathForSessionIdentity,
  statSessionEntrySync,
} from "../../packages/memory-host-sdk/src/engine-sessions.js";

// Internal actor sources are not part of the released plugin call signatures.
export const buildSessionEntry: (
  absPath: string,
  options?: Parameters<typeof buildSessionEntryFromHost>[1],
) => ReturnType<typeof buildSessionEntryFromHost> = buildSessionEntryFromHost;
export const listSessionTranscriptCorpusEntriesForAgent: (
  agentId: string,
  options?: Parameters<typeof listSessionTranscriptCorpusEntriesFromHost>[1],
) => ReturnType<typeof listSessionTranscriptCorpusEntriesFromHost> =
  listSessionTranscriptCorpusEntriesFromHost;
export const readSessionResetRecallCutoff: (
  scope: Parameters<typeof readSessionResetRecallCutoffFromHost>[0],
) => ReturnType<typeof readSessionResetRecallCutoffFromHost> = readSessionResetRecallCutoffFromHost;

export type {
  SessionFileEntry,
  SessionFileState,
  SessionTranscriptCorpusEntry,
} from "../../packages/memory-host-sdk/src/engine-sessions.js";

/** @deprecated Use loadMemorySessionMetadataAsync; removed at the next Plugin SDK major. */
export function loadMemorySessionMetadata(params: {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}): MemorySessionTarget | undefined {
  return readMemorySessionMetadata(params);
}

/** @deprecated Use resolveMemorySessionTargetsAsync; removed at the next Plugin SDK major. */
export function resolveMemorySessionTargets(params: MemorySessionSelectors): MemorySessionTarget[] {
  return readMemorySessionTargets(params);
}

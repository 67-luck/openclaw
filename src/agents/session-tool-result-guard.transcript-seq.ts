import type { SessionManager } from "./sessions/index.js";
import { sessionManagerResolveTranscriptSeq } from "./sessions/session-manager-transcript-seq.js";

export function resolveAppendedMessageSeq(params: {
  sessionManager: SessionManager;
  entryId: string;
  parentEntryId: string | null | undefined;
  preparedParentSeq?: number;
}): number | undefined {
  const committedSeq = params.sessionManager[sessionManagerResolveTranscriptSeq](params.entryId);
  if (committedSeq !== undefined) {
    return committedSeq;
  }
  const parentSeq =
    params.sessionManager[sessionManagerResolveTranscriptSeq](params.parentEntryId) ??
    params.preparedParentSeq;
  return parentSeq === undefined ? undefined : parentSeq + 1;
}

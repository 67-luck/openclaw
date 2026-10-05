/** Runtime rewrites leave source acquisition and suffix preparation with the transcript owner. */
import type { TranscriptRewriteResult } from "../../context-engine/types.js";
import {
  sessionManagerRewriteTranscript,
  type SessionTranscriptMessageRewrite,
} from "../sessions/session-manager-rewrite.js";
import type { SessionManager } from "../sessions/session-manager.js";

export function rewriteTranscriptEntriesInSessionManager(
  params: SessionTranscriptMessageRewrite & { sessionManager: SessionManager },
): Promise<TranscriptRewriteResult> {
  return params.sessionManager[sessionManagerRewriteTranscript]({
    replacements: params.replacements,
    preserveReplacementCompactionReplay: params.preserveReplacementCompactionReplay,
  });
}

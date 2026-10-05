import type { TranscriptRewriteReplacement } from "../../context-engine/types.js";

/** @internal Runtime rewrites acquire their source in the persistence owner. */
export const sessionManagerRewriteTranscript: unique symbol = Symbol.for(
  "openclaw.session-manager.rewrite-transcript",
);

export type SessionTranscriptMessageRewrite = {
  replacements: TranscriptRewriteReplacement[];
  preserveReplacementCompactionReplay?: boolean;
};

export type SessionTranscriptRewriteRetention = {
  retainedEntryIds: readonly string[];
  retainedCustomDataIds: readonly string[];
  contextStartEntryId?: string | null;
};

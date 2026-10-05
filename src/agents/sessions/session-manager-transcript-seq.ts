/** @internal Canonical ordinals share the resident transcript view's publication lifecycle. */
export const sessionManagerResolveTranscriptSeq: unique symbol = Symbol.for(
  "openclaw.session-manager.resolve-transcript-seq",
);

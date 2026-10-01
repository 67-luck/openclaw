import { readSessionTitleFieldsFromTranscript } from "../../gateway/session-transcript-title-reader.js";
import type {
  SessionTranscriptWorkerInput,
  SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";

// Keep transcript readers outside worker startup. The dispatcher retains the
// database and admission fence; this operation owns the read-only title policy.
export function readSessionTranscriptTitleInWorker(
  request: Extract<SessionTranscriptWorkerInput, { kind: "session-title-fields" }>,
): SessionTranscriptWorkerValues["session-title-fields"] {
  return {
    kind: "session-title-fields",
    fields: readSessionTitleFieldsFromTranscript(request.scope, {
      includeInterSession: request.includeInterSession,
      readOnly: true,
    }),
  };
}

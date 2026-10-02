import type { TranscriptEntryAnchor } from "../../config/sessions/session-accessor.js";
import type { appendTranscriptMessageSnapshotSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import {
  type AppendPersistenceOptions,
  sessionTranscriptAppendPublication,
} from "./session-manager-types.js";
import type { PreparedSessionTranscriptReload } from "./session-manager-view-types.js";

export type PersistRecordResult =
  | undefined
  | {
      anchor?: TranscriptEntryAnchor;
      lifecycleRevision?: string;
      appended: boolean;
      adoptedMessageId?: string;
      effectiveParentId: string | null;
      reloadAfterAppend?: boolean;
      reload?: PreparedSessionTranscriptReload;
      [sessionTranscriptAppendPublication]?: (observer: () => void) => void;
    };

export type NativeMessageAppendContinuation = {
  enter: (
    ...args: [
      ...Parameters<
        NonNullable<
          NonNullable<Parameters<typeof appendTranscriptMessageSnapshotSync>[4]>["continuation"]
        >["enter"]
      >,
      initialized: boolean,
    ]
  ) => () => void;
  assertCurrent: () => void;
  enterPublicFresh: () => () => void;
  complete: (result: PersistRecordResult) => void;
  retainPublication: (publish: () => void) => void;
};

export type PersistRecordOptions = AppendPersistenceOptions & {
  /** Retry fence captured from the durable snapshot that passed validation. */
  expectedMutationAt?: number | null;
};

export function isSqliteTranscriptMutationConflict(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    if (current.name === "SqliteTranscriptMutationConflictError") {
      return true;
    }
    current = current.cause;
  }
  return false;
}

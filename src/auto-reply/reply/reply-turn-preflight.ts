import type { SessionEntry } from "../../config/sessions.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import { readPendingUserTurnTranscriptAdmission } from "../../sessions/user-turn-transcript-admission.js";
import { runMemoryFlushIfNeeded, runSessionCompactionIfNeeded } from "./agent-runner-memory.js";

type CompactionParams = Parameters<typeof runSessionCompactionIfNeeded>[0];
type MemoryFlushParams = Parameters<typeof runMemoryFlushIfNeeded>[0];

type ReplyTurnPreflightParams = Omit<
  CompactionParams,
  | "abortSignal"
  | "beforeCompaction"
  | "pendingUserEntryId"
  | "onCompactionStart"
  | "onSessionIdChanged"
> &
  Pick<MemoryFlushParams, "opts" | "resolvedVerboseLevel" | "onVisibleErrorPayloads"> & {
    replyOperation: ReplyOperation;
    publishCheckpoint: (entry: SessionEntry | undefined) => void;
    trace?: <T>(phase: string, run: () => Promise<T>) => Promise<T>;
  };

/** First and queued turns checkpoint memory through the same required-compaction path. */
export async function prepareReplyTurnContext(
  params: ReplyTurnPreflightParams,
): Promise<SessionEntry | undefined> {
  const { replyOperation, publishCheckpoint, trace, ...preparation } = params;
  const preflightAdmission = readPendingUserTurnTranscriptAdmission(
    preparation.followupRun.userTurnTranscriptRecorder,
  );
  const tracePhase = <T>(phase: string, run: () => Promise<T>) =>
    trace ? trace(phase, run) : run();
  return await tracePhase("reply.preflight_compaction", () =>
    runSessionCompactionIfNeeded({
      ...preparation,
      pendingUserEntryId: preflightAdmission?.entryId,
      abortSignal: replyOperation.abortSignal,
      // Compaction decides whether work is needed, then replans from the
      // checkpoint result. A queued source must not bypass this memory write.
      beforeCompaction: async (entry) => {
        const flushed = await tracePhase("reply.memory_flush", () =>
          runMemoryFlushIfNeeded({
            ...preparation,
            preflightAdmission,
            replyOperation,
            abortSignal: replyOperation.abortSignal,
            sessionEntry: entry,
          }),
        );
        publishCheckpoint(flushed.sessionEntry);
        replyOperation.abortSignal.throwIfAborted();
        if (flushed.outcome === "exhausted") {
          await preparation.onCompactionNotice?.("memory_flush_degraded");
        }
        return flushed.sessionEntry;
      },
      onCompactionStart: () => replyOperation.setPhase("preflight_compacting"),
      onSessionIdChanged: (sessionId) => replyOperation.updateSessionId(sessionId),
    }),
  );
}

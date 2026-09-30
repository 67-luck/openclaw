import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { readGroupParticipationRun } from "./group-participation-run.js";

/** Commit observed input and refresh its assessment before the caller accepts silence. */
export async function prepareGroupParticipationObservation(params: AgentTurnParams) {
  const participation = readGroupParticipationRun(params.replyOperation);
  if (participation?.mode !== "observe") {
    return undefined;
  }
  const recorder = params.followupRun.userTurnTranscriptRecorder;
  if (recorder && !recorder.hasPersisted()) {
    const persisted = await recorder.persistApproved({
      expectedSessionId: params.followupRun.run.sessionId,
      ...(params.sessionKey
        ? {
            target: {
              agentId: params.followupRun.run.agentId,
              sessionId: params.followupRun.run.sessionId,
              sessionKey: params.sessionKey,
              storePath: params.storePath,
              sessionEntry: params.getActiveSessionEntry(),
              sessionStore: params.activeSessionStore,
              config: params.followupRun.run.config,
              cwd: params.followupRun.run.workspaceDir,
            },
          }
        : {}),
    });
    if (!persisted) {
      throw new Error("The group source could not be committed to its session");
    }
  }
  params.replyOperation?.abortSignal.throwIfAborted();
  // Persistence can yield to a consent/config change or accepted group input.
  // Silence is valid only while the assessed conversation still owns it.
  const revision = participation.snapshot?.revision;
  if (revision === undefined || !participation.isCurrent(revision)) {
    // The owner restores ordinary policy only if assistance is unavailable.
    await participation.refresh();
  }
  return participation;
}

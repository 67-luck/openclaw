// Public embedded-agent barrel. Re-export the runner API used by gateway,
// command, and plugin surfaces without exposing internal runner file layout.
export type {
  EmbeddedAgentCompactResult,
  EmbeddedAgentMeta,
  EmbeddedAgentRunMeta,
  EmbeddedAgentRunResult,
} from "./embedded-agent-runner.js";
export {
  abortAndDrainEmbeddedAgentRun,
  abortEmbeddedAgentRun,
  preemptAndDrainEmbeddedHeartbeatRun,
  compactEmbeddedAgentSession,
  isEmbeddedAgentRunHandleActive,
  isEmbeddedAgentRunStreaming,
  queueEmbeddedAgentMessageWithOutcome,
  resolveActiveEmbeddedRunSessionIdBySessionFile,
  resolveEmbeddedSessionLane,
  runEmbeddedAgent,
  waitForEmbeddedAgentRunEnd,
} from "./embedded-agent-runner.js";
export {
  isSessionRunCompactionBlocked as isEmbeddedAgentRunAbortableForCompaction,
  isSessionRunActive as isEmbeddedAgentRunActive,
  resolveActiveSessionRunId as resolveActiveEmbeddedRunSessionId,
} from "../sessions/session-controller.queries.js";

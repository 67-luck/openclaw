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
  queueEmbeddedAgentMessageWithOutcome,
  resolveActiveEmbeddedRunSessionIdBySessionFile,
  runEmbeddedAgent,
} from "./embedded-agent-runner.js";

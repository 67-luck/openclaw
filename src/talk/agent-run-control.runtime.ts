import {
  abortEmbeddedAgentRun,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  queueGuardedEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunOwnerByRunId,
} from "../agents/embedded-agent-runner/runs.js";
import { getDiagnosticSessionActivitySnapshot } from "../logging/diagnostic-run-activity.js";
import { resolveActiveSessionRunId } from "../sessions/session-controller.queries.js";
import { resolveActiveReplyRunOwnerForSignal } from "../sessions/session-controller.state.js";

export const realtimeVoiceControlRuntime = {
  abortEmbeddedAgentRun,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  queueGuardedEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunOwnerByRunId,
  resolveActiveSessionRunId,
  resolveActiveReplyRunOwnerForSignal,
  getDiagnosticSessionActivitySnapshot,
};

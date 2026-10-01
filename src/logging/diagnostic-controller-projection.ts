import type { SessionWatchdogSnapshot } from "../sessions/session-controller.watchdog-state.js";
import type { DiagnosticSessionActivitySnapshot } from "./diagnostic-run-activity-snapshot.js";

/** Diagnostic events may be disabled, delayed or dropped; progress comes from the owner. */
export function projectControllerDiagnosticActivity(
  state: SessionWatchdogSnapshot,
  now: number,
): DiagnosticSessionActivitySnapshot {
  if (!state.current) {
    return {};
  }
  const oldestTool = state.tools.reduce<SessionWatchdogSnapshot["tools"][number] | undefined>(
    (oldest, tool) => (!oldest || tool.startedAtMs < oldest.startedAtMs ? tool : oldest),
    undefined,
  );
  const deadline = (kind: "backend" | "retry") => {
    const values = state.waits
      .filter((wait) => wait.kind === kind && wait.deadlineAtMs !== undefined)
      .map((wait) => wait.deadlineAtMs!);
    return values.length ? Math.max(...values) : undefined;
  };
  const toolDeadline = state.tools.length
    ? Math.max(...state.tools.map((tool) => tool.deadlineAtMs))
    : undefined;
  const requestTimeouts = (state.requests ?? [])
    .map((request) => request.requestTimeoutMs)
    .filter((timeout): timeout is number => timeout !== undefined);
  return {
    hasActiveEmbeddedRun: state.hasActiveAttempt || undefined,
    activeWorkKind: oldestTool
      ? "tool_call"
      : state.requests?.length
        ? "model_call"
        : state.hasActiveAttempt
          ? "embedded_run"
          : undefined,
    activeModelCallRequestTimeoutMs: requestTimeouts.length
      ? Math.max(...requestTimeouts)
      : undefined,
    lastProgressAgeMs: Math.max(0, now - state.semanticProgressAtMs),
    lastProgressReason: state.lastProgressReason,
    activeToolName: oldestTool?.toolName,
    activeToolCallId: oldestTool?.toolCallId,
    activeToolAgeMs: oldestTool ? Math.max(0, now - oldestTool.startedAtMs) : undefined,
    activeToolDeadlineAtMs: toolDeadline,
    activeToolRecoveryDeadlineAtMs: toolDeadline,
    activeBackendLivenessDeadlineAtMs: deadline("backend"),
    activeRetryWaitDeadlineAtMs: deadline("retry"),
  };
}

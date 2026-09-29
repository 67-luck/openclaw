import type { ExecEventPayload, ExecFinishedEventParams } from "./invoke-types.js";

export function buildExecFinishedEventPayload(params: ExecFinishedEventParams): ExecEventPayload {
  const output = [params.result.stdout, params.result.stderr, params.result.error]
    .filter(Boolean)
    .join("\n");
  return {
    sessionKey: params.sessionKey,
    runId: params.runId,
    host: "node",
    command: params.commandText,
    exitCode: params.result.exitCode ?? undefined,
    timedOut: params.result.timedOut,
    success: params.result.success,
    output,
    suppressNotifyOnExit: params.suppressNotifyOnExit,
    notifyOnExit: params.notifyOnExit,
    invokeResultSentFirst: params.invokeResultSentFirst,
  };
}

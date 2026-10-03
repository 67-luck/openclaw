import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ExecFinishedEventParams } from "./invoke-system-run-completion.js";
import type { ExecEventPayload } from "./invoke-types.js";

const OUTPUT_EVENT_TAIL = 20_000;

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
    output: !output.trim()
      ? output
      : output.trim().length <= OUTPUT_EVENT_TAIL
        ? output.trim()
        : `... (truncated) ${sliceUtf16Safe(output.trim(), output.trim().length - OUTPUT_EVENT_TAIL)}`,
    suppressNotifyOnExit: params.suppressNotifyOnExit,
    notifyOnExit: params.notifyOnExit,
    invokeResultSentFirst: params.invokeResultSentFirst,
  };
}

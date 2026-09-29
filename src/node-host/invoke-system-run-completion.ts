import type { ExecFinishedEventParams, ExecFinishedResult } from "./invoke-types.js";

export type SystemRunExecutionContext = {
  sessionKey: string;
  runId: string;
  commandText: string;
  suppressNotifyOnExit: boolean;
  notifyOnExit: boolean;
};

type CompletionSenders = {
  sendInvokeResult: (params: { ok: true; payloadJSON: string }) => Promise<unknown>;
  sendExecFinishedEvent: (params: ExecFinishedEventParams) => Promise<unknown>;
};

export async function publishSystemRunCompletion(
  senders: CompletionSenders,
  execution: SystemRunExecutionContext,
  result: ExecFinishedResult,
  payloadJSON: string,
): Promise<void> {
  try {
    await senders.sendInvokeResult({ ok: true, payloadJSON });
  } catch {
    // The authenticated terminal event recovers a missing invoke result.
  }
  await senders.sendExecFinishedEvent({
    sessionKey: execution.sessionKey,
    runId: execution.runId,
    commandText: execution.commandText,
    result,
    suppressNotifyOnExit: execution.suppressNotifyOnExit,
    notifyOnExit: execution.notifyOnExit,
    invokeResultSentFirst: true,
  });
}

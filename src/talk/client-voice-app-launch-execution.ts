import { AsyncLocalStorage } from "node:async_hooks";
import type { InstalledAppLaunchRequest } from "../infra/installed-app-launch.js";
import type { ClientVoiceRunBinding } from "./client-voice-session-store.js";

// This carrier is host-only. No node.invoke/Talk wire field can establish it.
export type ClientVoiceAppLaunchExecution = Readonly<{
  runId: string;
  toolCallId: string;
  nodeId: string;
  request: InstalledAppLaunchRequest;
  /** Captured before target-resolution awaits; absence is an explicitly non-voice source. */
  voiceRun: ClientVoiceRunBinding | undefined;
}>;
const executions = new AsyncLocalStorage<ClientVoiceAppLaunchExecution>();
export function withClientVoiceAppLaunchExecution<T>(
  execution: ClientVoiceAppLaunchExecution,
  run: () => Promise<T>,
): Promise<T> {
  return executions.run(
    Object.freeze({ ...execution, request: Object.freeze({ ...execution.request }) }),
    run,
  );
}
export function getClientVoiceAppLaunchExecution(): ClientVoiceAppLaunchExecution | undefined {
  return executions.getStore();
}

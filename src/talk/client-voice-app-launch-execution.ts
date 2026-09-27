import { AsyncLocalStorage } from "node:async_hooks";
import type { InstalledAppLaunchRequest } from "../infra/installed-app-launch.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { captureClientVoiceAppLaunchPolicyRecord } from "./client-voice-app-launch-policy-record.js";
import type { ClientVoiceRunBinding } from "./client-voice-session-store.js";

// This carrier is host-only. No node.invoke/Talk wire field can establish it.
export type ClientVoiceAppLaunchExecution = Readonly<{
  runId: string;
  toolCallId: string;
  nodeId: string;
  request: InstalledAppLaunchRequest;
  /** Captured before target-resolution awaits; absence is an explicitly non-voice source. */
  voiceRun: ClientVoiceRunBinding | undefined;
  /** Only the final Gateway permit owner supplies this fact; no wire/model metadata is read. */
  recordPolicyAuthorization: (policyId: string) => void;
}>;
const executions = new AsyncLocalStorage<ClientVoiceAppLaunchExecution>();
const log = createSubsystemLogger("talk/app-launch");
export async function withClientVoiceAppLaunchExecution<T>(
  execution: Omit<ClientVoiceAppLaunchExecution, "recordPolicyAuthorization">,
  run: () => Promise<T>,
): Promise<T> {
  let accepting = true;
  let policyId: string | undefined;
  let recordPolicy: ReturnType<typeof captureClientVoiceAppLaunchPolicyRecord> | undefined;
  if (execution.voiceRun) {
    try {
      recordPolicy = captureClientVoiceAppLaunchPolicyRecord({
        agentId: execution.voiceRun.agentId,
        voiceSessionId: execution.voiceRun.voiceSessionId,
        sessionKey: execution.voiceRun.sessionKey,
        runId: execution.runId,
        toolCallId: execution.toolCallId,
      });
    } catch {
      // An unavailable evidence store cannot alter the source action's outcome.
    }
  }
  try {
    return await executions.run(
      Object.freeze({
        ...execution,
        request: Object.freeze({ ...execution.request }),
        recordPolicyAuthorization: (selectedPolicyId: string) => {
          if (accepting) {
            policyId ??= selectedPolicyId;
          }
        },
      }),
      run,
    );
  } finally {
    accepting = false;
    // Join evidence before the source terminal event, separately from its success/failure.
    try {
      if (recordPolicy) {
        await recordPolicy(policyId);
      } else if (policyId) {
        log.warn("Installed-app policy attribution source is unavailable");
      }
    } catch {
      try {
        log.warn("Installed-app policy attribution is unavailable");
      } catch {
        // Even diagnostic failure cannot turn an admitted spawn into a retryable refusal.
      }
    }
  }
}
export function getClientVoiceAppLaunchExecution(): ClientVoiceAppLaunchExecution | undefined {
  return executions.getStore();
}

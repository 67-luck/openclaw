import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import type { ClientVoiceAppLaunchPolicyUse } from "./client-voice-session-store.js";

const log = createSubsystemLogger("talk/app-launch");

/** Retain the source store before dispatch; settle only a final permit fact, never infer an outcome. */
export function captureClientVoiceAppLaunchPolicyRecord(
  params: Omit<ClientVoiceAppLaunchPolicyUse, "policyId">,
): (policyId?: string) => Promise<void> {
  const input = Object.freeze({ ...params });
  const options = { agentId: input.agentId };
  const execution = captureOpenClawAgentDatabaseExecution(options);
  return async (policyId) => {
    try {
      if (!policyId) {
        return;
      }
      const recorded = await runOpenClawAgentWorkerWrite(options, () =>
        execution.runExisting(
          {
            assertCurrent: () => execution.assertCurrent(),
            createAdmission(binding) {
              return () => ({
                nativeLocations: binding.nativeLocations,
                admission: createSqliteWorkerOperationAdmission((request, grant) => {
                  binding.authorize(request);
                  execution.assertCurrent();
                  if (!grant()) {
                    throw new Error("Voice policy attribution lost its database admission");
                  }
                }, binding.attachment),
              });
            },
          },
          async (worker) => {
            await worker.execute({
              type: "talk.appLaunch.recordPolicy",
              input: { ...input, policyId },
            });
            return true;
          },
        ),
      );
      if (!recorded) {
        throw new Error("Voice policy attribution database is absent");
      }
    } catch {
      // Like ordinary effect evidence, unavailable persistence must not relabel an OS outcome.
      // An uncertain worker write is never replayed or redirected to a replacement store.
      log.warn("Installed-app policy attribution could not be persisted");
    } finally {
      try {
        await execution.release();
      } catch {
        log.warn("Installed-app policy attribution database cleanup remains incomplete");
      }
    }
  };
}

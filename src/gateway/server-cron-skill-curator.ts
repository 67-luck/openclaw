// Runs the weekly Skill Workshop curator for its system-owned cron job.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  CronIsolatedAgentJobRequest,
  CronIsolatedAgentJobResult,
} from "../cron/service/state.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveSkillWorkshopConfig } from "../skills/workshop/config.js";

/**
 * The curator is a Workshop run, not a cron agent turn: fresh context, locked embedded
 * harness, and only skill_workshop executes. The runner loads only when the job is due.
 */
export async function runSkillWorkshopCuratorJob(params: {
  request: CronIsolatedAgentJobRequest;
  agentId: string;
  config: OpenClawConfig;
}): Promise<CronIsolatedAgentJobResult> {
  const { request, agentId, config } = params;
  if (resolveSkillWorkshopConfig(config).autonomous.mode !== "auto") {
    return { status: "skipped", summary: "Skill Workshop is off." };
  }
  const jobId = request.job.id;
  const { runSkillWorkshopCurator } = await import("../skills/workshop/review-run.js");
  try {
    const { ran, changes } = await runSkillWorkshopCurator({
      config,
      agentId,
      abortSignal: request.abortSignal,
      // Cron's watchdog needs runner progress to tell a live curator from a stuck setup.
      onExecutionStarted: () =>
        request.onExecutionStarted?.({ jobId, agentId, phase: "runner_entered" }),
      onExecutionPhase: (info) => request.onExecutionPhase?.({ ...info, jobId, agentId }),
      onLaneWait: request.onLaneWait,
    });
    if (!ran) {
      return { status: "ok", summary: "Fewer than two learned skills; nothing to curate." };
    }
    const plural = changes.length === 1 ? "" : "s";
    return {
      status: "ok",
      summary: `Skill Workshop curator made ${changes.length} change${plural}.`,
    };
  } catch (error) {
    return { status: "error", error: formatErrorMessage(error) };
  }
}

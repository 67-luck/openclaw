import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import {
  createSkillExperienceReviewScheduler,
  type SkillExperienceReviewParams,
} from "./experience-review-scheduler.js";

const log = createSubsystemLogger("skills/workshop");

const defaultScheduler = createSkillExperienceReviewScheduler({
  isSystemActive: async () => {
    const { getActiveEmbeddedRunCount } =
      await import("../../agents/embedded-agent-runner/active-run-projections.js");
    return getActiveEmbeddedRunCount() > 0;
  },
  runReview: async (candidate) => {
    const { getRuntimeConfig } = await import("../../config/config.js");
    const { prepareSkillExperienceReviewCandidate, runSkillExperienceReview } =
      await import("./experience-review.js");
    const prepared = await prepareSkillExperienceReviewCandidate(candidate, getRuntimeConfig());
    if (prepared) {
      await runSkillExperienceReview(prepared);
    }
  },
});

/** Counts the finished turn toward a background review; never affects the turn's result. */
export function scheduleSkillExperienceReview(
  params: Omit<SkillExperienceReviewParams, "workshopMutated">,
): void {
  const runId = params.ctx.runId?.trim();
  if (resolveSkillWorkshopConfig(params.config).autonomous.mode !== "auto" || !runId) {
    defaultScheduler.schedule(params);
    return;
  }
  // The change feed records the run that made each edit; a foreground turn that saved
  // its own learning resets the session's review counter.
  void import("./library.js")
    .then(({ listWorkshopChanges }) =>
      listWorkshopChanges(params.ctx.foregroundPromptContext.agentId, { runId, limit: 1 }),
    )
    .then((changes) =>
      defaultScheduler.schedule({ ...params, workshopMutated: changes.length > 0 }),
    )
    .catch((error: unknown) => {
      log.warn(`skill experience review scheduling failed: ${formatErrorMessage(error)}`);
    });
}

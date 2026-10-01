import {
  createSkillExperienceReviewScheduler,
  type SkillExperienceReviewParams,
} from "./experience-review-scheduler.js";

const defaultScheduler = createSkillExperienceReviewScheduler({
  isSystemActive: async () => {
    const { getActiveSessionRunCount } =
      await import("../../sessions/session-controller.queries.js");
    return getActiveSessionRunCount() > 0;
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

/** Queues a conservative, post-run learning review after the agent system becomes idle. */
export function scheduleSkillExperienceReview(params: SkillExperienceReviewParams): void {
  defaultScheduler.schedule(params);
}

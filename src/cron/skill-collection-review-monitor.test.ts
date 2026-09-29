import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSkillCollectionReviewMonitorSpecs } from "./skill-collection-review-monitor.js";

describe("resolveSkillCollectionReviewMonitorSpecs", () => {
  it("creates one stable weekly curator job per agent that runs only skill_workshop", () => {
    const cfg = {
      agents: {
        list: [
          { id: "main", default: true },
          {
            id: "ops",
            model: "openai/gpt-5.5",
            models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
      skills: { workshop: { autonomous: { mode: "auto" } } },
    } as OpenClawConfig;

    const specs = Array.from(
      resolveSkillCollectionReviewMonitorSpecs(cfg, { schedulerSeed: "test-seed" }),
    );

    // The curator always runs on the embedded openclaw harness, so a Codex agent is not excluded.
    expect(
      specs.map(({ agentId, input }) => [agentId, input.declarationKey, input.enabled]),
    ).toEqual([
      ["main", "skill-collection-review:main", true],
      ["ops", "skill-collection-review:ops", true],
    ]);
    expect(specs[0]?.input).toMatchObject({
      name: "skill-collection-review-main",
      payload: { kind: "agentTurn", toolsAllow: ["skill_workshop"] },
      schedule: { kind: "every", everyMs: 7 * 24 * 60 * 60_000, anchorMs: expect.any(Number) },
      sessionTarget: "isolated",
      delivery: { mode: "none" },
    });
    const repeated = Array.from(
      resolveSkillCollectionReviewMonitorSpecs(cfg, { schedulerSeed: "test-seed" }),
    );
    expect(repeated.map(({ input }) => input.schedule)).toEqual(
      specs.map(({ input }) => input.schedule),
    );
  });

  it("keeps the job but disables it when Workshop is off", () => {
    const cfg = {
      agents: { list: [{ id: "main" }] },
      skills: { workshop: { autonomous: { mode: "off" } } },
    } as OpenClawConfig;
    const [spec] = resolveSkillCollectionReviewMonitorSpecs(cfg);
    expect(spec?.input.enabled).toBe(false);
  });
});

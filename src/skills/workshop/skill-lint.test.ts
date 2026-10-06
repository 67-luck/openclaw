import { describe, expect, it } from "vitest";
import { lintSkillMarkdown, skillWriteAdvisories } from "./skill-lint.js";

const skill = (description: string, body: string) =>
  `---\nname: demo\ndescription: ${description}\n---\n\n${body}\n`;
const CLEAN_DESCRIPTION = "Deploying the web app to staging; runs make deploy and checks health.";
const CLEAN_BODY = "1. Run `make deploy`.\n2. Check `/healthz` returns 200.";

describe("lintSkillMarkdown", () => {
  it.each([
    ["description-length", skill("x".repeat(161), CLEAN_BODY), skill("x".repeat(160), CLEAN_BODY)],
    [
      "description-identity",
      skill("This skill deploys staging.", CLEAN_BODY),
      skill("Deploying staging; uses this skill set.", CLEAN_BODY),
    ],
    [
      "sprawl",
      skill(CLEAN_DESCRIPTION, "step\n".repeat(251)),
      skill(CLEAN_DESCRIPTION, "step\n".repeat(200)),
    ],
    [
      "no-op",
      skill(CLEAN_DESCRIPTION, "1. IMPORTANT: Make sure to run the deploy."),
      skill(CLEAN_DESCRIPTION, "1. Run the deploy; `important` flags stay in code."),
    ],
    [
      "negation",
      skill(CLEAN_DESCRIPTION, "- Never push.\n- Don't skip tests.\n1. Do not deploy Fridays."),
      skill(CLEAN_DESCRIPTION, "- Never push.\n- Don't skip tests.\n- Deploy midweek."),
    ],
    [
      "narrative",
      skill(CLEAN_DESCRIPTION, `${CLEAN_BODY}\nUPDATE: health moved to /ready on 2026-09-01.`),
      skill(CLEAN_DESCRIPTION, `${CLEAN_BODY}\nNote: run \`date -d 2026-09-01\` in UTC.`),
    ],
  ])("%s fires only on the bad shape", (rule, bad, good) => {
    expect(lintSkillMarkdown(bad).map((finding) => finding.rule)).toEqual([rule]);
    expect(lintSkillMarkdown(good)).toEqual([]);
  });
});

describe("skillWriteAdvisories", () => {
  it("reports only rules the write introduced, capped at three", () => {
    const sprawling = skill(CLEAN_DESCRIPTION, "step\n".repeat(300));
    expect(skillWriteAdvisories(sprawling, sprawling.replace("step", "IMPORTANT step"))).toEqual([
      expect.stringMatching(/^Advisory \(not blocking\): cut no-op emphasis \(IMPORTANT\)/),
    ]);
    const noisy = skill(
      `This skill is a powerful ${"x".repeat(160)}`,
      "- Never a.\n- Never b.\n- Never c.\nUPDATE: changed.",
    );
    expect(skillWriteAdvisories("", noisy)).toHaveLength(3);
  });
});

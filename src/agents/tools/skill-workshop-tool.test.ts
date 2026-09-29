import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consumeRunSkillUsage } from "../../skills/runtime/run-usage.js";
import { createWorkshopSkill, listWorkshopChanges } from "../../skills/workshop/library.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
  await createWorkshopSkill(
    { config: {}, agentId: "main", actor: "agent" },
    {
      name: "deploy",
      content: "---\nname: deploy\ndescription: Deploy staging\n---\n\n1. Run make deploy.\n",
    },
  );
});

afterEach(async () => {
  await state.cleanup();
});

function text(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((part) => part.text ?? "").join("");
}

describe("skill_workshop review guard", () => {
  it("requires viewing an existing skill before a background run edits or archives it", async () => {
    const tool = createSkillWorkshopTool({
      config: {},
      agentId: "main",
      runId: "review-run",
      reviewGuard: true,
      actor: "review",
    });
    const patch = {
      action: "patch",
      name: "deploy",
      old_text: "make deploy",
      new_text: "make ship",
    };

    await expect(tool.execute("1", patch)).rejects.toThrow(
      "View it first: call skill_workshop action=view name=deploy, then retry once.",
    );
    // Retries rebuild the tool inside the same run; the read must carry over.
    await tool.execute("2", { action: "view", name: "deploy" });
    const retried = createSkillWorkshopTool({
      config: {},
      agentId: "main",
      runId: "review-run",
      reviewGuard: true,
      actor: "review",
    });
    expect(text(await retried.execute("3", { ...patch, reason: "renamed target" }))).toBe(
      'Patched "deploy" (renamed target). Saved previous version; undo with action=restore name=deploy.',
    );
    await expect(retried.execute("4", { action: "archive", name: "deploy" })).rejects.toThrow(
      /archive needs absorbed_into .* or a reason/,
    );

    expect(consumeRunSkillUsage("review-run")).toEqual([
      expect.objectContaining({ name: "deploy", source: "workspace", activation: "read" }),
    ]);
    expect(await listWorkshopChanges("main", { runId: "review-run" })).toEqual([
      expect.objectContaining({ action: "patch", actor: "review", summary: "renamed target" }),
    ]);
  });

  it("lets foreground runs patch without a prior view", async () => {
    const tool = createSkillWorkshopTool({ config: {}, agentId: "main", runId: "fg-run" });
    await tool.execute("1", {
      action: "patch",
      name: "deploy",
      old_text: "make deploy",
      new_text: "make ship",
    });
    expect(await listWorkshopChanges("main", { runId: "fg-run" })).toEqual([
      expect.objectContaining({ action: "patch", actor: "agent", summary: "patched SKILL.md" }),
    ]);
  });
});

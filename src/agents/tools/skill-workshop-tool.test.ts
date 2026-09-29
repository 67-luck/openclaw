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
    });
    expect(text(await retried.execute("3", { ...patch, reason: "renamed target" }))).toBe(
      'Patched "deploy" (renamed target). Saved previous version; undo with action=restore name=deploy.',
    );
    await expect(retried.execute("4", { action: "archive", name: "deploy" })).rejects.toThrow(
      /archive needs absorbed_into .* or a reason/,
    );

    // The reviewer reading a skill is not use; only foreground views count.
    expect(consumeRunSkillUsage("review-run")).toEqual([]);
    expect(await listWorkshopChanges("main", { runId: "review-run" })).toEqual([
      expect.objectContaining({ action: "patch", actor: "review", summary: "renamed target" }),
    ]);
  });

  it("gates remove_file behind a prior view in background runs", async () => {
    await createSkillWorkshopTool({ config: {}, agentId: "main" }).execute("0", {
      action: "write_file",
      name: "deploy",
      file_path: "references/old.md",
      content: "stale notes\n",
    });
    const tool = createSkillWorkshopTool({
      config: {},
      agentId: "main",
      runId: "review-remove-run",
      reviewGuard: true,
    });
    const remove = { action: "remove_file", name: "deploy", file_path: "references/old.md" };
    await expect(tool.execute("1", remove)).rejects.toThrow("View it first");
    await tool.execute("2", { action: "view", name: "deploy" });
    expect(text(await tool.execute("3", remove))).toBe(
      'Updated "deploy" (removed references/old.md). Saved previous version; undo with action=restore name=deploy.',
    );
  });

  it("lets foreground runs patch without a prior view and counts their views as use", async () => {
    const tool = createSkillWorkshopTool({ config: {}, agentId: "main", runId: "fg-run" });
    await tool.execute("1", {
      action: "patch",
      name: "deploy",
      old_text: "make deploy",
      new_text: "make ship",
    });
    await tool.execute("2", { action: "view", name: "deploy" });
    expect(await listWorkshopChanges("main", { runId: "fg-run" })).toEqual([
      expect.objectContaining({ action: "patch", actor: "agent", summary: "patched SKILL.md" }),
    ]);
    expect(consumeRunSkillUsage("fg-run")).toEqual([
      expect.objectContaining({ name: "deploy", source: "workspace", activation: "read" }),
    ]);
  });
});

describe("skill_workshop remove_file", () => {
  it("removes one support file as an undoable change and never removes SKILL.md", async () => {
    const tool = createSkillWorkshopTool({ config: {}, agentId: "main", runId: "fg-run" });
    await tool.execute("1", {
      action: "write_file",
      name: "deploy",
      file_path: "references/old.md",
      content: "stale notes\n",
    });

    await expect(
      tool.execute("2", { action: "remove_file", name: "deploy", file_path: "SKILL.md" }),
    ).rejects.toThrow("SKILL.md cannot be removed. Archive the skill");
    await expect(
      tool.execute("3", { action: "remove_file", name: "deploy", file_path: "references/nope.md" }),
    ).rejects.toThrow("references/nope.md does not exist");

    await tool.execute("4", {
      action: "remove_file",
      name: "deploy",
      file_path: "references/old.md",
    });
    expect(text(await tool.execute("5", { action: "view", name: "deploy" }))).not.toContain(
      "references/old.md",
    );

    await tool.execute("6", { action: "restore", name: "deploy" });
    expect(
      text(
        await tool.execute("7", {
          action: "view",
          name: "deploy",
          file_path: "references/old.md",
        }),
      ),
    ).toContain("stale notes\n");
    expect((await listWorkshopChanges("main", { runId: "fg-run" })).map((c) => c.action)).toEqual([
      "restore",
      "remove_file",
      "write_file",
    ]);
  });
});

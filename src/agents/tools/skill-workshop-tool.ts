import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitTrustedSkillUsedDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { pathExists } from "../../infra/fs-safe.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { recordRunSkillUsage } from "../../skills/runtime/run-usage.js";
import {
  archiveWorkshopSkill,
  createWorkshopSkill,
  listWorkshopArchive,
  listWorkshopSkills,
  patchWorkshopSkill,
  restoreWorkshopSkill,
  viewWorkshopSkill,
  WorkshopWriteError,
  writeWorkshopSkillFile,
  type WorkshopActor,
  type WorkshopChange,
  type WorkshopMutationContext,
} from "../../skills/workshop/library.js";
import { SKILL_AUTHORING_STANDARDS_PROMPT } from "../../skills/workshop/skill-authoring-standards.js";
import { resolveWorkshopSkillsDir } from "../../skills/workshop/skills-root.js";
import { SKILL_WORKSHOP_TOOL_DISPLAY_SUMMARY } from "../tool-description-presets.js";
import { canonicalizePath } from "../utils/paths.js";
import {
  asToolParamsRecord,
  readToolStringParam,
  ToolInputError,
  type AnyAgentTool,
} from "./common.js";
import { SkillWorkshopToolSchema } from "./skill-workshop-tool-schema.js";
import { textResult } from "./tool-results.js";

const SKILL_WORKSHOP_DESCRIPTION = `Your learned skills: reusable procedures saved as <name>/SKILL.md that load in future sessions. Changes apply immediately, are versioned, and are shown to the user.
Actions: list | view name [file_path] [version] | create name content | patch name old_text new_text [file_path] | write_file name file_path content | archive name (absorbed_into or reason) | restore name [version].
- create: content is the full SKILL.md: frontmatter name (= name) and description (≤160 bytes, triggers first), then the procedure.
- patch: replaces one exact, unique old_text; view first and copy the text exactly. Prefer patch over rewrites.
- file_path: SKILL.md or files under references/, templates/, scripts/, assets/.
- reason: one short line saying what changed; shown to the user.
- restore without version undoes the last change.

${SKILL_AUTHORING_STANDARDS_PROMPT}`;

const GUARDED_ACTIONS = new Set(["patch", "write_file", "archive"]);
const MAX_TRACKED_RUNS = 256;
// Retries and fallbacks rebuild tools within one run; reads must survive that.
const viewedSkillsByRun = new Map<string, Set<string>>();

export type SkillWorkshopToolOptions = {
  config: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  runId?: string;
  /** Background runs: edits of existing skills require a prior view; archive needs a why. */
  reviewGuard?: boolean;
  actor?: WorkshopActor;
};

function formatChange(verb: string, change: WorkshopChange): string {
  const undo = change.versionId
    ? `Saved previous version; undo with action=restore name=${change.skillName}.`
    : `Undo with action=archive name=${change.skillName}.`;
  return `${verb} "${change.skillName}" (${change.summary}). ${undo}`;
}

export function createSkillWorkshopTool(options: SkillWorkshopToolOptions): AnyAgentTool {
  let viewed = new Set<string>();
  if (options.runId) {
    viewed = viewedSkillsByRun.get(options.runId) ?? viewed;
    viewedSkillsByRun.set(options.runId, viewed);
    pruneMapToMaxSize(viewedSkillsByRun, MAX_TRACKED_RUNS);
  }
  const ctx: WorkshopMutationContext = {
    config: options.config,
    agentId: options.agentId,
    actor: options.actor ?? "agent",
    ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
  };
  const skillsRoot = resolveWorkshopSkillsDir(options.config, options.agentId);

  const execute = async (params: Record<string, unknown>) => {
    const action = readToolStringParam(params, "action", { required: true });
    if (action === "list") {
      const [skills, archive] = await Promise.all([
        listWorkshopSkills(options.config, options.agentId),
        listWorkshopArchive(options.config, options.agentId),
      ]);
      const archived = archive.filter((entry) => !entry.live);
      const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`);
      if (archived.length > 0) {
        lines.push(
          "Archived (restore with action=restore):",
          ...archived.map((entry) => `- ${entry.name}`),
        );
      }
      return textResult(
        lines.length > 0 ? lines.join("\n") : "No learned skills yet. Add one with action=create.",
        { skills, archived },
      );
    }

    const name = readToolStringParam(params, "name", { required: true });
    const filePath = readToolStringParam(params, "file_path");
    const reason = readToolStringParam(params, "reason");
    const version = readToolStringParam(params, "version");

    if (action === "view") {
      const view = await viewWorkshopSkill(
        options.config,
        options.agentId,
        name,
        filePath,
        version,
      );
      viewed.add(name);
      if (!version) {
        const skillFile = canonicalizePath(path.join(skillsRoot, name, "SKILL.md"));
        recordRunSkillUsage({
          runId: options.runId,
          name,
          source: "workspace",
          activation: "read",
          skillFile,
        });
        emitTrustedSkillUsedDiagnosticEvent(
          {
            type: "skill.used",
            ...(options.runId ? { runId: options.runId } : {}),
            ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
            agentId: options.agentId,
            skillName: name,
            skillSource: "workspace",
            activation: "read",
            toolName: "skill_workshop",
          },
          { skillUsage: { skillFile } },
        );
      }
      const others = view.files.filter((file) => file !== view.filePath);
      return textResult(
        others.length > 0 ? `${view.content}\n\n[Other files: ${others.join(", ")}]` : view.content,
        { name, filePath: view.filePath, files: view.files, ...(version ? { version } : {}) },
      );
    }

    if (
      options.reviewGuard &&
      GUARDED_ACTIONS.has(action) &&
      !viewed.has(name) &&
      (await pathExists(path.join(skillsRoot, name, "SKILL.md")))
    ) {
      throw new ToolInputError(
        `View it first: call skill_workshop action=view name=${name}, then retry once.`,
      );
    }

    let change: WorkshopChange;
    let verb: string;
    switch (action) {
      case "create":
        change = await createWorkshopSkill(ctx, {
          name,
          content: readToolStringParam(params, "content", { required: true, trim: false }),
          ...(reason ? { summary: reason } : {}),
        });
        viewed.add(name);
        verb = "Created";
        break;
      case "patch":
        change = await patchWorkshopSkill(ctx, {
          name,
          oldText: readToolStringParam(params, "old_text", { required: true, trim: false }),
          newText: readToolStringParam(params, "new_text", { trim: false, allowEmpty: true }) ?? "",
          ...(filePath ? { filePath } : {}),
          ...(reason ? { summary: reason } : {}),
        });
        verb = "Patched";
        break;
      case "write_file":
        change = await writeWorkshopSkillFile(ctx, {
          name,
          filePath: readToolStringParam(params, "file_path", { required: true }),
          content: readToolStringParam(params, "content", { required: true, trim: false }),
          ...(reason ? { summary: reason } : {}),
        });
        verb = "Updated";
        break;
      case "archive": {
        const absorbedInto = readToolStringParam(params, "absorbed_into");
        if (options.reviewGuard && !absorbedInto && !reason) {
          throw new ToolInputError(
            "archive needs absorbed_into (the live skill that now covers this one) or a reason.",
          );
        }
        change = await archiveWorkshopSkill(ctx, {
          name,
          ...(absorbedInto ? { absorbedInto } : {}),
          ...(reason ? { reason } : {}),
        });
        verb = "Archived";
        break;
      }
      case "restore":
        change = await restoreWorkshopSkill(ctx, {
          name,
          ...(version ? { versionId: version } : {}),
          ...(reason ? { summary: reason } : {}),
        });
        verb = "Restored";
        break;
      default:
        throw new ToolInputError(
          `Unknown action "${action}". Use list, view, create, patch, write_file, archive, or restore.`,
        );
    }
    return textResult(formatChange(verb, change), { change });
  };

  return {
    label: "Skill Workshop",
    name: "skill_workshop",
    displaySummary: SKILL_WORKSHOP_TOOL_DISPLAY_SUMMARY,
    description: SKILL_WORKSHOP_DESCRIPTION,
    parameters: SkillWorkshopToolSchema,
    execute: async (_toolCallId, args) => {
      try {
        return await execute(asToolParamsRecord(args));
      } catch (error) {
        if (error instanceof WorkshopWriteError) {
          throw new ToolInputError(error.message);
        }
        throw error;
      }
    },
  };
}

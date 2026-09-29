import { randomUUID } from "node:crypto";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection-config.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { resolveInternalSessionEffectsIdentity } from "../../config/sessions/internal-session-key.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { createBackgroundWorkOwner } from "../../process/background-work.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { listWorkshopChanges, listWorkshopSkills, type WorkshopChange } from "./library.js";
import { SKILL_WORKSHOP_CURATOR_PROMPT } from "./maintenance-prompt.js";
import { assertSkillReviewRunSucceeded } from "./review-outcome.js";

const reviews = createBackgroundWorkOwner({ owner: "core:skill-workshop", maxConcurrent: 1 });

/** Only skill_workshop executes in a background Workshop run; other calls get a redirect. */
export const SKILL_WORKSHOP_REVIEW_TOOLS = ["skill_workshop"] as const;

/**
 * The one embedded run path for background Workshop work (experience review and curator):
 * the openclaw harness on a locked model, executing only skill_workshop behind the review guard.
 */
export async function runSkillWorkshopReview(
  params: RunEmbeddedAgentParams & {
    agentId: string;
    config: OpenClawConfig;
    skillWorkshopActor: "review" | "curator";
  },
) {
  const restartSignal = getGatewayRestartDrainSignal();
  const abortSignal = params.abortSignal
    ? AbortSignal.any([restartSignal, params.abortSignal])
    : restartSignal;
  abortSignal.throwIfAborted();
  const preparedRunAdmission =
    params.preparedRunAdmission ??
    prepareSystemAgentRunAdmission(
      params.config,
      params.runId,
      params.agentId,
      `skill-workshop.${params.skillWorkshopActor}`,
    );
  // Background runs stay out of the Control UI and never project into a user session.
  registerAgentRunContext(params.runId, {
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    isControlUiVisible: false,
    projectSessionActive: false,
    projectSessionLifecycle: false,
    projectSessionMessages: false,
  });
  try {
    const { runEmbeddedAgent } = await import("../../agents/embedded-agent.js");
    return await runEmbeddedAgent({
      ...params,
      preparedRunAdmission,
      abortSignal,
      lane: reviews.lane,
      agentHarnessId: "openclaw",
      agentHarnessRuntimeOverride: "openclaw",
      // Review prompts and cloned prefixes are sized for this exact model.
      modelSelectionLocked: true,
      modelFallbacksOverride: [],
      requestedRouteResolution: "resolved",
      sessionPersistence: "detached",
      toolExecutionAllow: SKILL_WORKSHOP_REVIEW_TOOLS,
      skillWorkshopReviewGuard: true,
      disableTrajectory: true,
      silentExpected: true,
      allowEmptyAssistantReplyAsSilent: true,
      terminalReplyExpectation: "optional",
      cleanupBundleMcpOnRunEnd: true,
      verboseLevel: "off",
    });
  } finally {
    preparedRunAdmission.close();
    clearAgentRunContext(params.runId);
  }
}

/**
 * Weekly curator pass: a fresh-context run over the agent's Workshop skills. Returns the
 * changes it made; a library with fewer than two skills has nothing to consolidate.
 */
export async function runSkillWorkshopCurator(
  params: {
    config: OpenClawConfig;
    agentId: string;
  } & Pick<
    RunEmbeddedAgentParams,
    "abortSignal" | "onExecutionStarted" | "onExecutionPhase" | "onLaneWait"
  >,
): Promise<{ ran: boolean; changes: WorkshopChange[] }> {
  const { config, agentId } = params;
  if ((await listWorkshopSkills(config, agentId)).length < 2) {
    return { ran: false, changes: [] };
  }
  const runId = `skill-workshop-curator:${randomUUID()}`;
  const session = resolveInternalSessionEffectsIdentity({ agentId, runId });
  const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
  const model = resolveDefaultModelForAgent({ cfg: config, agentId });
  const result = await runSkillWorkshopReview({
    config,
    agentId,
    agentDir: resolveAgentDir(config, agentId),
    runId,
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    workspaceDir,
    cwd: workspaceDir,
    prompt: SKILL_WORKSHOP_CURATOR_PROMPT,
    provider: model.provider,
    model: model.model,
    timeoutMs: resolveAgentTimeoutMs({ cfg: config }),
    trigger: "manual",
    // Fresh context has no cache prefix to preserve, so advertise only the tool it can run.
    toolsAllow: [...SKILL_WORKSHOP_REVIEW_TOOLS],
    disableMessageTool: true,
    skillWorkshopActor: "curator",
    abortSignal: params.abortSignal,
    onExecutionStarted: params.onExecutionStarted,
    onExecutionPhase: params.onExecutionPhase,
    onLaneWait: params.onLaneWait,
  });
  assertSkillReviewRunSucceeded(result);
  return { ran: true, changes: await listWorkshopChanges(agentId, { runId }) };
}

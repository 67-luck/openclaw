import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import { runSkillWorkshopCuratorJob } from "./server-cron-skill-curator.js";

const runSkillWorkshopCurator = vi.hoisted(() => vi.fn());
vi.mock("../skills/workshop/review-run.js", () => ({ runSkillWorkshopCurator }));

const job = { id: "curator-job" } as CronJob;
const auto: OpenClawConfig = { skills: { workshop: { autonomous: { mode: "auto" } } } };

describe("runSkillWorkshopCuratorJob", () => {
  it("skips without starting a run when Workshop is off", async () => {
    const result = await runSkillWorkshopCuratorJob({
      request: { job, message: "curate" },
      agentId: "main",
      config: { skills: { workshop: { autonomous: { mode: "off" } } } },
    });

    expect(result).toEqual({ status: "skipped", summary: "Skill Workshop is off." });
    expect(runSkillWorkshopCurator).not.toHaveBeenCalled();
  });

  it("reports runner progress to the cron watchdog and summarizes changes", async () => {
    runSkillWorkshopCurator.mockImplementationOnce(async (params) => {
      params.onExecutionStarted();
      params.onExecutionPhase({ phase: "model_call_started" });
      return { ran: true, changes: [{}, {}] };
    });
    const onExecutionStarted = vi.fn();
    const onExecutionPhase = vi.fn();

    const result = await runSkillWorkshopCuratorJob({
      request: { job, message: "curate", onExecutionStarted, onExecutionPhase },
      agentId: "main",
      config: auto,
    });

    expect(result).toEqual({ status: "ok", summary: "Skill Workshop curator made 2 changes." });
    expect(onExecutionStarted).toHaveBeenCalledWith({
      jobId: "curator-job",
      agentId: "main",
      phase: "runner_entered",
    });
    expect(onExecutionPhase).toHaveBeenCalledWith({
      phase: "model_call_started",
      jobId: "curator-job",
      agentId: "main",
    });
  });

  it("turns a failed curator run into a cron error instead of throwing", async () => {
    runSkillWorkshopCurator.mockRejectedValueOnce(new Error("model unavailable"));

    const result = await runSkillWorkshopCuratorJob({
      request: { job, message: "curate" },
      agentId: "main",
      config: auto,
    });

    expect(result).toEqual({ status: "error", error: "model unavailable" });
  });
});

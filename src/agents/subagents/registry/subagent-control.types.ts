import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { SessionControllerInput } from "../../../sessions/session-controller.mailbox.js";

/** Exact source/target references retained across a kill's admission cleanup. */
export type SubagentKillInputSnapshot = {
  input: SessionControllerInput;
  source: SessionControllerInput["source"];
  target: SessionControllerInput["target"];
  mailbox: SessionControllerInput["mailbox"];
};

export type SubagentCancellationControl = {
  assertCurrent: () => void;
  prepareRead?: () => Promise<void> | undefined;
};

export const SUBAGENT_KILL_TASK_ERROR = "Subagent run killed.";
export type SubagentTerminalState = {
  status: "succeeded" | "failed" | "timed_out" | "cancelled";
  endedAt: number;
  error?: string;
};
export type SubagentKillTargetState =
  | { state: "finalizing" }
  | { state: "terminal"; task: SubagentTerminalState };
export type SubagentAdminKillResult =
  | { found: false; killed: false }
  | {
      found: true;
      killed: boolean;
      runId: string;
      sessionKey: string;
      cascadeKilled: number;
      cascadeLabels?: string[];
      targetState?: SubagentKillTargetState;
      error?: string;
    };
export type SubagentAdminKillParams = {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  expectedRunId?: string;
  expectedTaskRunId?: string;
  expectedGeneration?: number;
  expectedOwnerKey?: string;
  onResult?: (result: SubagentAdminKillResult) => undefined;
};

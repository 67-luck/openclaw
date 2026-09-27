import type { AgentRunTerminalDeliverySnapshot } from "../../agents/agent-run-terminal-delivery.js";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import type { AgentRunTerminalReceipt } from "../../agents/agent-run-terminal-receipt.js";
import type { AgentRunTerminalReplySnapshot } from "../../agents/agent-run-terminal-reply.types.js";
import type { PreparedAgentCommandRuntimeContext } from "../../agents/command/prepare.js";
import type { MainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import type { agentCommandFromGatewayIngress } from "../../commands/agent.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import type { GatewayCronCreatorAuthorityAdmission } from "../server-methods/cron-creator-authority-admission.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  RespondFn,
} from "../server-methods/shared-types.js";
import type { GatewayAgentDispatchTaskTracking } from "./agent-run-task-tracking.js";

type TaskSettlementAdmission =
  | { taskTrackingMode: "none"; assertSettlementCurrent?: () => void }
  | {
      taskTrackingMode: Exclude<GatewayAgentDispatchTaskTracking, "none">;
      assertSettlementCurrent: () => void;
    };

export type AgentRunDispatchParams = {
  assertCurrent?: () => void;
  admittedRunEntry: ChatAbortControllerEntry | undefined;
  ingressOpts: Parameters<typeof agentCommandFromGatewayIngress>[0];
  runId: string;
  cronCreatorAuthority?: GatewayCronCreatorAuthorityAdmission;
  dedupeKeys: readonly string[];
  /**
   * Controller whose signal is wired into `ingressOpts.abortSignal`. Used on
   * completion to drop the matching `chatAbortControllers` entry without
   * touching a same-runId entry owned by a concurrent chat.send.
   */
  abortController: AbortController;
  cleanupAbortController: () => void | Promise<void>;
  io: AgentTurnIo;
  context: AgentTurnContext;
  canonicalSkillWorkspaceDir?: string;
  restoreAdmittedRecovery?: () => Promise<MainSessionRecoveryPendingTarget | undefined>;
  commandRuntimeContext?: PreparedAgentCommandRuntimeContext;
  /** Privacy classification carried from the resolved session entry. */
  isIncognito?: boolean;
  onSettled?: (outcome: {
    terminalOutcome: AgentRunTerminalOutcome;
    onRecovered?: () => void;
  }) => Promise<boolean> | boolean;
} & TaskSettlementAdmission;

export type AgentTurnFrame = readonly [
  ok: Parameters<RespondFn>[0],
  payload: Parameters<RespondFn>[1],
  error: Parameters<RespondFn>[2],
];

export type AgentTurnIo = {
  emitAcceptance: (acceptance: AgentTurnFrame, meta?: Parameters<RespondFn>[3]) => void;
  /** Publishes the exact controller before asynchronous runtime preparation. */
  emitStartOwner?: (runId: string, entry: ChatAbortControllerEntry) => void;
  /** Internal lifecycle observer; public transports do not expose this callback. */
  emitExecutionStarted?: () => void;
  emitFinal: (final: AgentTurnFrame, meta?: Parameters<RespondFn>[3]) => void;
};

export type AgentTurnPrincipal = Pick<
  GatewayClient,
  | "authenticatedUserId"
  | "authenticatedUserProfile"
  | "connId"
  | "connect"
  | "internal"
  | "isDeviceTokenAuth"
>;

export type AgentTurnContext = Pick<
  GatewayRequestContext,
  | "addChatRun"
  | "agentRunSeq"
  | "broadcast"
  | "broadcastToConnIds"
  | "cancelRunBoundApprovals"
  | "chatAbortControllers"
  | "chatQueuedTurns"
  | "chatRunState"
  | "dedupe"
  | "deps"
  | "getRuntimeConfig"
  | "getSessionEventSubscriberConnIds"
  | "loadGatewayModelCatalog"
  | "loadGatewayModelCatalogSnapshot"
  | "logGateway"
  | "nodeSendToSession"
  | "removeChatRun"
  | "requestEntryLifetime"
  | "resolveGatewayContext"
  | "trackExecution"
  | "validateAgentRuntimeApprovalAuthority"
>;

export type AgentJobTerminalSnapshot = {
  status: "ok" | "error" | "timeout";
  startedAt?: number;
  endedAt?: number;
  error?: string;
  stopReason?: string;
  livenessState?: string;
  yielded?: boolean;
  pendingError?: boolean;
  timeoutPhase?: AgentRunTerminalOutcome["timeoutPhase"];
  providerStarted?: boolean;
  terminalDelivery?: AgentRunTerminalDeliverySnapshot;
  terminalReceipt?: AgentRunTerminalReceipt;
  terminalReply?: AgentRunTerminalReplySnapshot;
};

export type AgentJobSession = {
  sessionKey: string;
  sessionId: string;
  agentId?: string;
  lifecycleGeneration: string;
};

export type AgentJobObservation = AgentJobTerminalSnapshot & {
  readonly session?: Readonly<AgentJobSession>;
};

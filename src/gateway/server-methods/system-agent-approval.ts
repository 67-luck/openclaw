import { randomUUID } from "node:crypto";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  getActiveAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  SYSTEM_AGENT_APPROVAL_DECISIONS,
  SYSTEM_AGENT_APPROVAL_TIMEOUT_MS,
  type SystemAgentApprovalApplicationStatus,
  type SystemAgentApprovalResolved,
  type SystemAgentApprovalRequestPayload,
} from "../../infra/system-agent-approvals.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import type { SystemAgentChatReply } from "../../system-agent/chat-wizard-host.js";
import { describeSystemAgentPersistentOperation } from "../../system-agent/operations.js";
import type { AgentRuntimeDelegatedAuthority } from "../agent-runtime-identity-token.js";
import { sameWorkerSessionTurnClaim } from "../worker-environments/placement-record.js";
import {
  broadcastApprovalResolvedEvent,
  buildRequestedApprovalEvent,
  handlePendingApprovalRequest,
} from "./approval-shared.js";
import { runSystemAgentGatewayTask } from "./system-agent-execution.js";
import type { GatewayRequestContext } from "./types.js";

type SystemAgentChatSession =
  GatewayRequestContext["systemAgentSessions"] extends Map<string, infer Session> ? Session : never;

function sameApprovalAuthority(
  left: AgentRuntimeDelegatedAuthority,
  right: AgentRuntimeDelegatedAuthority,
): boolean {
  if (
    left.kind !== right.kind ||
    left.claimId !== right.claimId ||
    left.lifecycleGeneration !== right.lifecycleGeneration ||
    left.operationalRunInstance.instanceId !== right.operationalRunInstance.instanceId ||
    left.operationalRunInstance.runId !== right.operationalRunInstance.runId
  ) {
    return false;
  }
  return left.kind === "worker" && right.kind === "worker"
    ? sameWorkerSessionTurnClaim(left.turnClaim, right.turnClaim)
    : true;
}

function isSystemAgentChatReply(value: unknown): value is SystemAgentChatReply {
  return (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof value.text === "string" &&
    "action" in value &&
    typeof value.action === "string"
  );
}

export function queueDelegatedApproval(params: {
  context: GatewayRequestContext;
  sessions: Map<string, SystemAgentChatSession>;
  session: SystemAgentChatSession;
  sessionId: string;
  delegation: {
    agentId?: string;
    sessionKey?: string;
    turnSourceChannel?: string;
    turnSourceTo?: string;
    turnSourceAccountId?: string;
    turnSourceThreadId?: string | number;
  };
  proposal: NonNullable<ReturnType<SystemAgentChatSession["engine"]["getPendingOperatorProposal"]>>;
}): string {
  const callerIdentity = getGatewayToolCallerIdentity();
  const approvalAuthority = callerIdentity?.operationalRunInstance
    ? getActiveAgentRunDelegatedAuthority(callerIdentity.operationalRunInstance)
    : undefined;
  if (!callerIdentity || !approvalAuthority) {
    throw new Error("delegated OpenClaw approval requires an active run authority");
  }
  const runtimeApprovalAuthority: AgentRuntimeDelegatedAuthority = callerIdentity.workerTurnClaim
    ? { kind: "worker", ...approvalAuthority, turnClaim: callerIdentity.workerTurnClaim }
    : { kind: "local", ...approvalAuthority };
  const isAuthorityActive = () => {
    if (
      !validateAgentRunDelegatedAuthority(approvalAuthority) ||
      callerIdentity.receiptAuthority?.() === false ||
      callerIdentity.approvalSignals?.some((signal) => signal.aborted) ||
      (callerIdentity.gatewayContextResolver && !callerIdentity.gatewayContextResolver())
    ) {
      return false;
    }
    return (
      runtimeApprovalAuthority.kind === "local" ||
      params.context.validateAgentRuntimeApprovalAuthority?.({
        kind: "agentRuntime",
        agentId: callerIdentity.agentId,
        sessionKey: callerIdentity.sessionKey,
        operationalRunInstance: runtimeApprovalAuthority.operationalRunInstance,
        delegatedAuthority: runtimeApprovalAuthority,
      }) === true
    );
  };
  const assertLiveApprovalAuthority = () => {
    if (!isAuthorityActive() || params.sessions.get(params.sessionId) !== params.session) {
      throw new Error(
        "OpenClaw change cancelled: system-agent approval authority is no longer active. Retry the request if it is still needed.",
      );
    }
  };
  assertLiveApprovalAuthority();
  const manager = params.context.systemAgentApprovalManager;
  if (!manager) {
    throw new Error("OpenClaw approval registry unavailable");
  }
  const pending = params.session.pendingApproval;
  if (pending) {
    const closed = manager.forceDenyIfDelegatedAuthorityClosed(pending.id);
    const snapshot = manager.getSnapshot(pending.id);
    if (
      pending.proposalHash === params.proposal.hash &&
      !closed &&
      snapshot &&
      (snapshot.resolvedAtMs === undefined || snapshot.decision === "allow-once") &&
      snapshot.agentRuntimeDelegatedAuthority &&
      sameApprovalAuthority(snapshot.agentRuntimeDelegatedAuthority, runtimeApprovalAuthority)
    ) {
      return pending.id;
    }
    manager.expire(pending.id, "system-agent:replaced");
    if (params.session.pendingApproval?.id === pending.id) {
      params.session.pendingApproval = undefined;
    }
  }
  const description = describeSystemAgentPersistentOperation(params.proposal.operation);
  const request: SystemAgentApprovalRequestPayload = {
    title: "OpenClaw change",
    description,
    command: description,
    proposalHash: params.proposal.hash,
    allowedDecisions: SYSTEM_AGENT_APPROVAL_DECISIONS,
    agentId: params.delegation.agentId ?? null,
    sessionKey: params.delegation.sessionKey ?? null,
    sessionId: params.sessionId,
    runId: callerIdentity.operationalRunInstance?.runId ?? null,
    turnSourceChannel: params.delegation.turnSourceChannel ?? null,
    turnSourceTo: params.delegation.turnSourceTo ?? null,
    turnSourceAccountId: params.delegation.turnSourceAccountId ?? null,
    turnSourceThreadId: params.delegation.turnSourceThreadId ?? null,
  };
  const record = manager.create(
    request,
    SYSTEM_AGENT_APPROVAL_TIMEOUT_MS,
    `system-agent:${randomUUID()}`,
  );
  record.agentRuntimeDelegatedAuthority = runtimeApprovalAuthority;
  const decisionPromise = manager.register(record, SYSTEM_AGENT_APPROVAL_TIMEOUT_MS);
  params.session.pendingApproval = { id: record.id, proposalHash: params.proposal.hash };
  const requestEvent = buildRequestedApprovalEvent(record);
  const publishApplicationResult = (
    decision: "allow-once" | "allow-always" | "deny",
    applicationStatus: SystemAgentApprovalApplicationStatus,
  ) => {
    const resolvedEvent = {
      id: record.id,
      decision,
      resolvedBy: record.resolvedBy ?? null,
      ts: Date.now(),
      request,
      applicationStatus,
    } satisfies SystemAgentApprovalResolved;
    broadcastApprovalResolvedEvent({
      approvalKind: "system-agent",
      context: params.context,
      record,
      event: resolvedEvent,
    });
    params.context.approvalEvents?.publishResolved("system-agent", resolvedEvent);
  };
  void handlePendingApprovalRequest({
    manager,
    record,
    decisionPromise,
    respond: () => undefined,
    context: params.context,
    requestEventName: "openclaw.approval.requested",
    requestEvent,
    approvalKind: "system-agent",
    twoPhase: true,
    deliverRequest: () => false,
    keepPendingWithoutRoute: true,
    requireDeliveryRoute: false,
    afterDecision: async (decision) => {
      if (!decision) {
        return;
      }
      try {
        const reply = await runWithGatewayIndependentRootWorkContinuation(
          () =>
            runSystemAgentGatewayTask(async (): Promise<SystemAgentChatReply | null> => {
              // The original request has returned; keep approval, audit, and restart drain-visible.
              if (params.sessions.get(params.sessionId) !== params.session) {
                return null;
              }
              if (params.session.pendingApproval?.id === record.id) {
                params.session.pendingApproval = undefined;
              }
              let applyAuthorized = false;
              const approvalReply = await params.session.engine.resolveOperatorApproval(
                decision,
                params.proposal.hash,
                () => {
                  assertLiveApprovalAuthority();
                  applyAuthorized = true;
                },
              );
              if (approvalReply !== null && !isSystemAgentChatReply(approvalReply)) {
                throw new Error("OpenClaw approval returned an invalid application result");
              }
              return decision !== "deny" && !applyAuthorized ? null : approvalReply;
            }),
          "system-agent:task",
        );
        publishApplicationResult(decision, reply?.applied === true ? "applied" : "not-applied");
      } catch (error) {
        publishApplicationResult(decision, "not-applied");
        throw error;
      }
    },
    afterDecisionErrorLabel: "OpenClaw approval apply failed",
  });
  return record.id;
}

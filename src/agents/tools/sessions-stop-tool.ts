import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { resolveCanonicalMainSessionKey } from "../../config/sessions/main-session-key.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readToolStringParam,
  ToolAuthorizationError,
  ToolInputError,
} from "./common.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  hasInProcessGatewayToolContext,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import { resolveSessionToolTargetAgentId } from "./scoped-session-access.js";
import {
  formatSessionToolAccessDenial,
  resolveSessionReference,
  resolveSessionToolAccess,
  resolveSessionToolContext,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";

const SessionsStopToolSchema = Type.Object(
  {
    sessionKey: Type.String({
      description: "Target session key from sessions_list. Cannot stop the caller's own session.",
    }),
    agentId: Type.Optional(
      Type.String({
        description:
          "Target agent for an unscoped key such as global; use the sessions_list row’s agentId.",
      }),
    ),
    runId: Type.Optional(
      Type.String({
        description:
          "Stop only this run and its controlled descendants. Omit to stop the session's active work.",
      }),
    ),
    clearQueued: Type.Optional(
      Type.Boolean({
        description:
          "Discard queued follow-ups too. Defaults to true for a session-wide stop; unavailable with runId.",
      }),
    ),
  },
  { additionalProperties: false },
);

type SessionsStopToolOptions = {
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: AgentToolGatewayRequestCaller;
};

export function createSessionsStopTool(opts: SessionsStopToolOptions = {}): AnyAgentTool {
  return {
    name: "sessions_stop",
    label: "Session Stop",
    description:
      "Stop active work in another visible session without resetting, archiving, or deleting its conversation. Uses the Gateway stop path and its access checks; session visibility and agent-to-agent policy still apply. Optional runId narrows the stop to that run. Session-wide stops clear queued follow-ups unless clearQueued=false. Does not require browser login.",
    parameters: SessionsStopToolSchema,
    execute: async (_toolCallId, args, signal) => {
      if (!isRecord(args)) {
        throw new ToolInputError("Session stop requires an argument object");
      }
      const params = args;
      const sessionKey = readToolStringParam(params, "sessionKey", { required: true });
      const runId = readToolStringParam(params, "runId");
      const targetAgentId = readToolStringParam(params, "agentId");
      if (params.clearQueued !== undefined && typeof params.clearQueued !== "boolean") {
        throw new ToolInputError("clearQueued must be boolean");
      }
      if (runId && params.clearQueued === true) {
        throw new ToolInputError("clearQueued cannot be combined with runId");
      }
      const caller = getGatewayToolCallerIdentity();
      const assertCallerCurrent = captureGatewayToolCallerAssertion();
      // Cancellation authority stays in the admitted Gateway; never strip it
      // into a transport fallback using a different host credential.
      if (!caller || !assertCallerCurrent) {
        throw new ToolAuthorizationError("Session stop requires a live admitted Gateway caller");
      }
      assertCallerCurrent();
      if (!hasInProcessGatewayToolContext()) {
        throw new ToolAuthorizationError("Session stop requires its admitted Gateway");
      }
      const agentToolCaller = {
        agentId: caller.agentId,
        sessionKey: caller.sessionKey,
        assertCurrent: assertCallerCurrent,
      };
      const callGateway = opts.callGateway ?? callAgentToolGatewayRequest;
      const context = resolveSessionToolContext(opts);
      const requesterAgentId = resolveSessionAgentId({
        config: context.cfg,
        sessionKey: context.effectiveRequesterKey,
        agentId: opts.requesterAgentIdOverride,
      });
      const resolved = await resolveSessionReference({
        action: "stop",
        sessionKey,
        agentId: targetAgentId,
        keyAgentId: targetAgentId ?? requesterAgentId,
        alias: context.alias,
        mainKey: context.mainKey,
        requesterInternalKey: context.effectiveRequesterKey,
        restrictToSpawned: context.restrictToSpawned,
        callGateway,
      });
      if (!resolved.ok) {
        throw new ToolInputError(resolved.error);
      }
      const target = await resolveVisibleSessionReference({
        action: "stop",
        resolvedSession: resolved,
        requesterSessionKey: context.effectiveRequesterKey,
        requesterAgentId,
        restrictToSpawned: context.restrictToSpawned,
        visibilitySessionKey: sessionKey,
        callGateway,
      });
      if (!target.ok) {
        throw new ToolAuthorizationError(target.error);
      }
      const agentId = resolveSessionToolTargetAgentId({
        cfg: context.cfg,
        targetSessionKey: target.key,
        resolvedAgentId: target.agentId,
        requesterAgentId,
      });
      const canonicalKey = (key: string) =>
        key === context.alias || key === context.mainKey
          ? resolveCanonicalMainSessionKey({
              agentId,
              mainKey: context.mainKey,
              sessionScope: context.cfg.session?.scope,
            })
          : key;
      if (
        agentId === requesterAgentId &&
        canonicalKey(target.key) === canonicalKey(context.effectiveRequesterKey)
      ) {
        throw new ToolInputError("Cannot stop the session running this tool");
      }
      const access = await resolveSessionToolAccess({
        action: "stop",
        requesterAgentId,
        requesterSessionKey: context.effectiveRequesterKey,
        mainSessionKey: context.mainSessionKey,
        authorizationTargetSessionKey:
          agentId !== requesterAgentId && !parseAgentSessionKey(target.key)
            ? "agent:" + agentId + ":" + target.key
            : target.key,
        targetAgentId: agentId,
        targetSessionKey: target.key,
        requesterOwned: target.requesterOwned,
        visibility: context.sessionVisibility,
        a2aPolicy: context.a2aPolicy,
        callGateway,
      });
      if (!access.allowed) {
        throw new ToolAuthorizationError(
          formatSessionToolAccessDenial(access, {
            action: "stop",
            targetSessionKey: target.displayKey,
          }),
        );
      }
      return jsonResult(
        await callGateway({
          method: "sessions.abort",
          agentToolCaller,
          params: {
            key: target.key,
            agentId,
            ...(runId ? { runId } : { clearQueued: params.clearQueued ?? true }),
          },
          signal,
        }),
      );
    },
  };
}

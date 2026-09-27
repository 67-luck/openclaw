import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import {
  InstalledAppLaunchRequestSchema,
  InstalledAppLaunchReadySchema,
} from "../../infra/installed-app-launch.js";
import { getClientVoiceAppLaunchExecution } from "../../talk/client-voice-app-launch-execution.js";
import {
  checkClientVoiceToolConfirmationPolicy,
  consumeClientVoiceToolConfirmationPolicy,
} from "../../talk/client-voice-confirmation.js";
import {
  isClientVoiceSessionConfirmable,
  resolveClientVoiceRunBinding,
} from "../../talk/client-voice-session.js";
import { resolveNodeInvokeRuntimeAuthorityError } from "../server-methods/nodes.invoke-authority.js";
import type { GatewayClient, GatewayRequestContext } from "../server-methods/types.js";

/** Compose with normal node authorization at the final dispatch and each readiness retry. */
function prepareTalkAppLaunchDispatch(nodeId: string, rawParams: unknown) {
  const action = InstalledAppLaunchRequestSchema.parse(rawParams);
  const caller = getGatewayToolCallerIdentity();
  const execution = getClientVoiceAppLaunchExecution();
  if (
    !caller?.operationalRunInstance ||
    !execution ||
    execution.runId !== caller.operationalRunInstance.runId ||
    execution.nodeId !== nodeId ||
    execution.request.appId !== action.appId ||
    execution.request.appRevision !== action.appRevision
  ) {
    throw new Error("Installed-app launch lost its exact host-prepared effect binding");
  }
  const assertCallerCurrent = captureGatewayToolCallerAssertion();
  const voice = execution.voiceRun;
  if (voice && voice.agentId !== caller.agentId) {
    throw new Error("Voice app launch agent does not match its admitted caller");
  }
  let spokenGrantConsumed = false;
  let reason: string | undefined;
  let validForMs = 5000;
  let authorizedPolicyId: string | undefined;
  return {
    dispatchParams: { ...action, agentId: caller.agentId },
    validityMs: () => validForMs,
    reason: () => reason,
    recordPermitAuthorization: () => {
      if (authorizedPolicyId) {
        execution.recordPolicyAuthorization(authorizedPolicyId);
      }
    },
    isCurrent: (effectBoundary = false) => {
      try {
        assertCallerCurrent?.("node.invoke");
      } catch (error) {
        reason = error instanceof Error ? error.message : "Installed-app caller authority closed";
        return false;
      }
      if (!voice || !execution) {
        return true;
      }
      if (resolveClientVoiceRunBinding(execution.runId) !== voice) {
        reason = "Voice app launch run binding changed";
        return false;
      }
      // A one-shot grant remains attached to the same dispatch across explicit not-ready retries.
      if (spokenGrantConsumed) {
        return true;
      }
      const confirmationParams = {
        agentId: voice.agentId,
        voiceSessionId: voice.voiceSessionId,
        originAuthority: voice.originAuthority,
        runId: execution.runId,
        toolCallId: execution.toolCallId,
        toolName: "nodes",
        toolParams: { action: "app_launch", node: nodeId, ...action },
        isConfirmable: () => isClientVoiceSessionConfirmable(voice),
        appLaunchEffectBoundary: true,
      };
      const decide = effectBoundary
        ? consumeClientVoiceToolConfirmationPolicy
        : checkClientVoiceToolConfirmationPolicy;
      const decision = decide(confirmationParams);
      if (!decision.allowed) {
        reason = decision.reason;
        return false;
      }
      if (decision.policyId) {
        // The policy is never converted into a one-shot grant. Every readiness
        // check reads current configuration and origin; the permit cannot outlive expiry.
        validForMs = Math.min(5000, (decision.policyExpiresAtMs ?? 0) - Date.now());
        if (validForMs <= 0) {
          reason = "Voice app-launch policy expired";
          return false;
        }
      } else if (effectBoundary) {
        spokenGrantConsumed = true;
      }
      if (effectBoundary) {
        authorizedPolicyId = decision.policyId;
      }
      return true;
    },
  };
}

/** Node preparation and its invocation-bound permit stay with the Talk effect owner. */
export function prepareTalkAppLaunchInvocation(params: {
  nodeId: string;
  rawParams: unknown;
  connId: string;
  context: Pick<
    GatewayRequestContext,
    "nodeRegistry" | "execApprovalManager" | "validateAgentRuntimeApprovalAuthority"
  >;
  client: GatewayClient | null;
  approvalAuthority?: Parameters<
    typeof resolveNodeInvokeRuntimeAuthorityError
  >[0]["approvalAuthority"];
}) {
  const { nodeId, context, client, connId, approvalAuthority } = params;
  const launch = prepareTalkAppLaunchDispatch(nodeId, params.rawParams);
  let invokeId: string | undefined;
  let permitSent = false;
  return {
    ...launch,
    onDispatchReady: (id: string) => {
      invokeId = id;
    },
    onReady: (chunk: string) => {
      if (!chunk || !invokeId || permitSent) {
        return;
      }
      let ready: ReturnType<typeof InstalledAppLaunchReadySchema.safeParse>;
      try {
        ready = InstalledAppLaunchReadySchema.safeParse(JSON.parse(chunk));
      } catch {
        ready = InstalledAppLaunchReadySchema.safeParse(null);
      }
      const authorized =
        ready.success &&
        ready.data.appId === launch.dispatchParams.appId &&
        ready.data.appRevision === launch.dispatchParams.appRevision &&
        context.nodeRegistry.isInvokeCurrent(invokeId, nodeId, connId) &&
        resolveNodeInvokeRuntimeAuthorityError({ context, client, approvalAuthority }) ===
          undefined &&
        launch.isCurrent(true);
      permitSent = true;
      if (authorized) {
        launch.recordPermitAuthorization();
      }
      context.nodeRegistry.sendInvokeInput(
        invokeId,
        authorized
          ? { type: "installed-app-launch.allow", validForMs: launch.validityMs() }
          : { type: "installed-app-launch.deny" },
      );
    },
  };
}

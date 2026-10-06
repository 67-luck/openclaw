import {
  type AdmittedRunContext,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../agents/admitted-run-context.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import type { ScheduledToolPolicyContext } from "../../agents/scheduled-tool-policy.js";
import { isRuntimeToolAllowed } from "../../agents/tool-policy-match.js";
import { withPostAdmissionExecutionOwnerBinding } from "../../audit/execution-owner-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronAuthenticatedChannelRequester } from "../../gateway/cron-creator-authority-grant.types.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import {
  captureCronJobMessageActionAuthority,
  captureCronJobMessageSourceAuthority,
} from "../active-jobs.js";
import type { CronCompletionDeliveryFence } from "../delivery-attempt-fence.js";
import type { CronRuntimeAuthority } from "../runtime-authority.js";
import type { CronExecutionIdentityAdmission } from "../service/state.js";

export function assertCronRuntimeAuthorityCandidate(params: {
  authority?: CronRuntimeAuthority;
  candidateRuntime: string;
  cliExecution: boolean;
}): void {
  const authority = params.authority;
  if (!authority) {
    return;
  }
  if (params.candidateRuntime !== authority.runtimeId || params.cliExecution) {
    throw new AgentHarnessPreflightError(
      `This automation carries ${authority.namespace} authority captured for the ${authority.runtimeId} runtime, but the selected execution runtime is ${params.candidateRuntime}. Restore that runtime and auth profile, or explicitly replace the automation's toolsAllow cap from an authenticated creator turn.`,
    );
  }
}

/** Owns one prompt admission and its private message grant through settlement. */
export function prepareCronPromptRunAdmission(params: {
  admissionSource?: AdmittedRunContext["admissionSource"];
  cfg: OpenClawConfig;
  agentId: string;
  runId: string;
  sessionId?: string;
  sessionKey: string;
  jobId: string;
  deliveryAttemptFence?: CronCompletionDeliveryFence | null;
  channelRequester?: CronAuthenticatedChannelRequester;
  toolsAllow?: string[];
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  executionIdentity?: CronExecutionIdentityAdmission;
  ingressBoundary?: "cron.isolated-agent" | "cron.script";
  resolveGatewayContext?: GatewayContextResolver;
}) {
  const { runId, scheduledToolPolicy } = params;
  const operationalRunInstance = createOperationalRunInstanceRef(runId);
  const resolveGatewayContext =
    params.resolveGatewayContext ?? getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  let assertAdmitted: (() => void) | undefined;
  const basePreparedRunAdmission = prepareAgentRunAdmission({
    operationalRunInstance,
    admissionSource: params.admissionSource,
    cfg: params.cfg,
    facts: {
      runId,
      agentId: params.agentId,
      ingress: params.executionIdentity?.ingress ?? {
        kind: "schedule",
        boundary: params.ingressBoundary ?? "cron.isolated-agent",
        state: "present",
      },
      ...(params.executionIdentity?.invoker ? { invoker: params.executionIdentity.invoker } : {}),
    },
    onAdmitted: (admitted) => {
      bindGatewayContextResolver(admitted, resolveGatewayContext);
      assertAdmitted = resolveAdmittedRunActiveAssertion(admitted);
    },
  });
  const preparedRunAdmission = params.executionIdentity?.onPostAdmission
    ? withPostAdmissionExecutionOwnerBinding(
        basePreparedRunAdmission,
        params.executionIdentity.onPostAdmission,
      )
    : basePreparedRunAdmission;
  const scheduledMessageAuthority =
    scheduledToolPolicy && isRuntimeToolAllowed("message", params.toolsAllow)
      ? captureCronJobMessageActionAuthority({ jobId: params.jobId, operationalRunInstance })
      : undefined;
  const scheduledMessageSourceAuthority = scheduledMessageAuthority
    ? captureCronJobMessageSourceAuthority({ jobId: params.jobId, operationalRunInstance })
    : undefined;
  const deliveryAttemptFence = params.deliveryAttemptFence;
  if (scheduledMessageAuthority && deliveryAttemptFence === null) {
    preparedRunAdmission.close();
    throw new Error("scheduled message authority requires its occurrence delivery fence");
  }
  // This opaque token remains unusable until this exact operational instance
  // is admitted by the live occurrence. Both runners redeem the same host grant.
  const messageActionTurnCapability =
    deliveryAttemptFence || (scheduledMessageAuthority && scheduledToolPolicy)
      ? mintMessageActionTurnCapability({
          agentId: params.agentId,
          runId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          requesterAccountId:
            scheduledMessageAuthority && scheduledToolPolicy?.mode === "account"
              ? scheduledToolPolicy.ownerAccountId
              : undefined,
          ...(deliveryAttemptFence
            ? {
                deliveryAttempt: {
                  beforeAttempt: () => deliveryAttemptFence.beforeAttempt(),
                  assertCurrent: () => {
                    if (!assertAdmitted) {
                      throw new Error("cron message delivery requires its admitted run");
                    }
                    assertAdmitted();
                    deliveryAttemptFence.assertCurrent();
                  },
                },
              }
            : {}),
          ...(scheduledMessageAuthority && scheduledToolPolicy
            ? {
                scheduled: {
                  policy: scheduledToolPolicy,
                  assertCurrent: scheduledMessageAuthority,
                  ...(scheduledMessageSourceAuthority
                    ? { assertSourceCurrent: scheduledMessageSourceAuthority }
                    : {}),
                  ...(params.channelRequester ? { channelRequester: params.channelRequester } : {}),
                },
              }
            : {}),
          expiresWithRun: true,
        })
      : undefined;
  return {
    preparedRunAdmission,
    messageActionTurnCapability,
    close: () => {
      revokeMessageActionTurnCapability(messageActionTurnCapability);
      preparedRunAdmission.close();
    },
  };
}

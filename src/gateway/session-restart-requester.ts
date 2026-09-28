import path from "node:path";
import { assertAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { readOperatorModelPolicyMembership } from "../agents/operator-model-policy.js";
import {
  normalizeRestartRecoveryRequester,
  type RestartRecoveryRequester,
} from "../config/sessions/restart-recovery-requester.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import type { AgentTurnPrincipal } from "./agent-turn/types.js";
import { resolveGatewayAuthPolicyGeneration } from "./auth-policy.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";
import { sourceRolePolicy } from "./operator-role-source-policy.js";

/** Capture an accepted self-continuation's original operator, never the receiver's privileges. */
export async function captureRestartRecoveryRequester(params: {
  client: AgentTurnPrincipal | null;
  inputProvenance?: InputProvenance;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  storePath: string;
  lifecycleRevision?: string;
  runId: string;
  getConfig: () => OpenClawConfig;
  assertCurrent: () => void;
}): Promise<RestartRecoveryRequester | undefined> {
  const internal = params.client?.internal;
  const identity = internal?.agentRuntimeIdentity;
  const source = internal?.operatorRunAuthority;
  const provenance = params.inputProvenance;
  if (
    !identity ||
    !source ||
    internal?.runtimePluginToolGrant !== undefined ||
    internal?.pluginSubagentRequester !== undefined ||
    internal?.pluginSubagentToolsAllow !== undefined ||
    internal?.delegatedToolPolicyHandoffId !== undefined ||
    internal?.cronRunContinuation === true ||
    identity.agentId !== params.agentId ||
    identity.sessionKey !== params.sessionKey ||
    provenance?.kind !== "inter_session" ||
    provenance.sourceTool !== "sessions_send" ||
    provenance.sourceSessionKey !== params.sessionKey ||
    isIncognitoSessionKey(params.sessionKey)
  ) {
    return undefined;
  }
  assertAdmittedRunOperatorAuthority(source);
  params.assertCurrent();
  source.assertCurrent();
  // An absent basis is unknown, not an unrestricted grant. Custom model
  // predicates likewise cannot be reconstructed from their visible choices.
  if (
    source.restartAccessGrant === undefined ||
    source.restartDevice === undefined ||
    source.restartAuthPolicy === undefined ||
    source.restartAuthMode === undefined ||
    source.restartBrowserOrigin === undefined ||
    !source.readCurrentRoleAssignment
  ) {
    return undefined;
  }
  const modelPolicyMembership = readOperatorModelPolicyMembership(source.modelPolicy);
  if (modelPolicyMembership === undefined) {
    return undefined;
  }
  const profile = await prepareUserProfileIdentity(source.profileId);
  try {
    params.assertCurrent();
    source.assertCurrent();
    const current = profile.readCurrentFacts();
    const role = source.readCurrentRoleAssignment();
    if (current.profile.profileId !== source.profileId || current.profile.assignedRole !== role) {
      throw new Error("Restart continuation requester changed during admission.");
    }
    const admissionConfig = params.getConfig();
    if (
      source.restartAuthPolicy !==
        resolveGatewayAuthPolicyGeneration(admissionConfig, source.restartAuthIdentity) ||
      source.restartAuthMode !== (admissionConfig.gateway?.auth?.mode ?? null)
    ) {
      throw new Error("Restart continuation authentication policy changed during admission.");
    }
    const policy = resolveOperatorRolePolicyForAssignment(source.profileId, role, admissionConfig);
    const snapshot = normalizeRestartRecoveryRequester({
      version: 1,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      storePath: path.resolve(params.storePath),
      lifecycleRevision: params.lifecycleRevision ?? null,
      sourceRunId: params.runId,
      profileId: source.profileId,
      scopes: intersectOperatorScopes(source.scopes, params.client?.connect.scopes ?? []),
      grant: source.restartAccessGrant,
      device: source.restartDevice,
      browserOrigin: source.restartBrowserOrigin,
      aliasBindingIds: profile.emailBindingIds,
      role,
      rolePolicy: JSON.stringify(sourceRolePolicy(policy) ?? null),
      authPolicy: source.restartAuthPolicy,
      authMode: source.restartAuthMode,
      ...(source.restartAuthIdentity === undefined
        ? {}
        : { authIdentity: source.restartAuthIdentity }),
      modelPolicyMembership,
    });
    params.assertCurrent();
    source.assertCurrent();
    if (readOperatorModelPolicyMembership(source.modelPolicy) !== modelPolicyMembership) {
      throw new Error("Restart continuation model policy changed during admission.");
    }
    return snapshot;
  } finally {
    profile.release();
  }
}

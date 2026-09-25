import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import {
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { prepareSessionCreatorProfile } from "./session-creator.js";
import {
  SessionMutationAuthorizationChangedError,
  sessionMutationTargetChanged,
} from "./session-mutation-authorization-error.js";
import {
  prepareSessionInputCapability,
  type PreparedSessionInputAuthorization,
} from "./session-sharing-input-capability.js";
import {
  authorizeOwnSessionMutation,
  authorizePreparedSessionMutation,
  type PreparedSessionMutationFacts,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
export function prepareSessionMutationInputAuthorization(
  resolveInput: () => Parameters<typeof prepareSessionMutationInputFacts>[0] | undefined,
): Promise<PreparedSessionInputAuthorization | undefined> {
  return prepareSessionInputCapability(() => {
    const params = resolveInput();
    return params ? prepareSessionMutationInputFacts(params) : undefined;
  });
}

async function prepareSessionMutationInputFacts(params: {
  client: GatewayClient | null;
  context: Pick<GatewayRequestContext, "getRuntimeConfig" | "getCommittedRuntimeConfig">;
  method: string;
  expected: { sessionKey: string; lifecycleRevision?: string };
  originalTarget: Omit<SessionSharingTarget, "entry" | "storeKeys"> & { sessionId: string };
  bindsProgressLifecycle: boolean;
  bindsOwnProfile: boolean;
  ownSessionProfileId?: string;
}) {
  const { expected, originalTarget, bindsProgressLifecycle, bindsOwnProfile, ownSessionProfileId } =
    params;
  const targetChanged = (sessionKey: string) =>
    sessionMutationTargetChanged(params.method, sessionKey);
  const originalActor = resolveGatewayOperatorRoleActor(params.client);
  const profileId = originalActor?.kind === "operator" ? originalActor.profileId : undefined;
  const selection = await prepareSessionMutationFacts({
    cfg: params.context.getRuntimeConfig(),
    sessionKey: expected.sessionKey,
    agentId: originalTarget.agentId,
  });
  let profile: Awaited<ReturnType<typeof prepareUserProfileIdentity>> | undefined;
  let active = true;
  const release = () => {
    if (!active) {
      return;
    }
    active = false;
    try {
      profile?.release();
    } finally {
      selection.release();
    }
  };
  try {
    if (!selection.workerRead) {
      release();
      return undefined;
    }
    profile = profileId ? await prepareUserProfileIdentity(profileId) : undefined;
    const assertCurrent = (facts: PreparedSessionMutationFacts) => {
      const currentCfg = params.context.getRuntimeConfig();
      const policyConfig = params.context.getCommittedRuntimeConfig?.() ?? currentCfg;
      const actor = resolveGatewayOperatorRoleActor(params.client);
      const current = facts.target;
      if (
        !active ||
        actor?.kind !== originalActor?.kind ||
        (actor?.kind === "operator" && actor.profileId !== profileId) ||
        !current ||
        current.agentId !== originalTarget.agentId ||
        current.canonicalKey !== originalTarget.canonicalKey ||
        current.storeKey !== originalTarget.storeKey ||
        current.storePath !== originalTarget.storePath ||
        current.entry.sessionId !== originalTarget.sessionId ||
        ((bindsProgressLifecycle || bindsOwnProfile) &&
          current.entry.lifecycleRevision !== expected.lifecycleRevision)
      ) {
        throw targetChanged(expected.sessionKey);
      }
      // This retains logical selection/lifetime only. The worker reselects
      // every searched store after the final grant, immediately before COMMIT.
      selection.readCurrentFacts(currentCfg);
      const identity = profile?.readCurrentFacts();
      const aliases = identity?.aliases ?? new Set<string>();
      const error =
        authorizeOwnSessionMutation({
          client: params.client,
          target: current,
          expectedProfileId: ownSessionProfileId,
          isCreator: prepareSessionCreatorProfile(ownSessionProfileId, aliases),
        }) ??
        authorizePreparedSessionMutation(
          {
            cfg: policyConfig,
            client: params.client,
            sessionKey: expected.sessionKey,
            agentId: originalTarget.agentId,
          },
          facts,
          {
            aliases,
            policy: resolveOperatorRolePolicyForAssignment(
              profileId,
              identity?.profile.assignedRole ?? null,
              policyConfig,
            ),
          },
        );
      if (error) {
        throw new SessionMutationAuthorizationChangedError(error);
      }
    };
    assertCurrent(selection.readCurrentFacts(params.context.getRuntimeConfig()));
    return { workerRead: selection.workerRead, assertCurrent, release };
  } catch (error) {
    release();
    throw error;
  }
}

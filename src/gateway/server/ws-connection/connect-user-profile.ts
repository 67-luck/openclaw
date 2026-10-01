import { isDeepStrictEqual } from "node:util";
import { getRuntimeConfig } from "../../../config/io.js";
import { resolveHostAccountName } from "../../../infra/host-account-name.js";
import { prepareUserProfileIdentity } from "../../../state/user-profile-list.js";
import {
  ensureCanonicalGatewayOwnerProfile,
  ensureCanonicalUserProfileForEmail,
  ensureCanonicalUserProfileForTailscaleIdentity,
} from "../../../state/user-profile-writes.js";
import type { GatewayAuthResult } from "../../auth.js";
import { prepareGatewayRecipientProfile } from "../../expected-profile.js";
import type { createAuthenticatedGitHubIdentitySync } from "../../github-user-identity.js";
import {
  attachGatewayLocalUserIngress,
  type prepareGatewayLocalUserIngress,
} from "../../local-user-ingress.js";
import { hasGatewayOperatorAccessPolicies } from "../../operator-access-policy.js";
import { WEBSOCKET_OPEN_READY_STATE } from "../../server-constants.js";
import { formatForLog } from "../../ws-log.js";
import type { GatewayWsClient } from "../ws-types.js";
import {
  rejectUnavailableProfileConnect,
  resolveGatewayConnectPolicyFailure,
} from "./connect-admission.js";
import type {
  DeviceAuthorizedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

type PreparedConnectProfile = Awaited<ReturnType<typeof resolveAuthenticatedProfile>>;

/** One connection retains its profile authority through admission and later identity refreshes. */
export function createGatewayConnectProfileLifecycle(
  context: GatewayConnectPhaseContext,
  state: DeviceAuthorizedGatewayConnect,
) {
  const { handler } = context;
  let client: GatewayWsClient | undefined;
  let retained: PreparedConnectProfile | undefined;
  const release = () => {
    retained?.identity.release();
    retained = undefined;
  };
  const rolesCurrent = () =>
    isDeepStrictEqual(context.configSnapshot.gateway?.roles, getRuntimeConfig().gateway?.roles);
  const clientCurrent = () =>
    !handler.isClosed() &&
    handler.socket.readyState === WEBSOCKET_OPEN_READY_STATE &&
    (!client || (handler.getClient() === client && !client.invalidated));
  const assertCurrent = () => {
    handler.connectionWork.signal.throwIfAborted();
    if (!clientCurrent() || resolveGatewayConnectPolicyFailure(context, state) || !rolesCurrent()) {
      throw new Error("Gateway profile acquisition authority expired");
    }
  };
  return {
    assertCurrent,
    [Symbol.dispose]() {
      if (!client) {
        release();
      }
    },
    retain(prepared: PreparedConnectProfile | undefined) {
      release();
      retained = prepared;
    },
    isCurrent: (prepared: PreparedConnectProfile | undefined) => {
      try {
        return (
          (!prepared ||
            prepared.identity.readCurrentProfile().assignedRole === prepared.recipient.role) &&
          rolesCurrent()
        );
      } catch {
        return false;
      }
    },
    bind: (registered: GatewayWsClient) => {
      client = registered;
      handler.socket.once("close", release);
    },
    async attach(
      profileId: string,
      prepareIngress: (
        profile: PreparedConnectProfile["profile"],
      ) => ReturnType<typeof prepareGatewayLocalUserIngress>,
    ) {
      if (!client || !clientCurrent()) {
        return;
      }
      const registered = client;
      assertCurrent();
      const prepared = await resolveAuthenticatedProfile(profileId, assertCurrent);
      using _pending = {
        [Symbol.dispose]: () => {
          if (retained !== prepared) prepared.identity.release();
        },
      };
      assertCurrent();
      if (
        client !== registered ||
        prepared.identity.readCurrentProfile().assignedRole !== prepared.recipient.role
      ) {
        throw new Error("Gateway profile changed before attachment");
      }
      const { profile } = prepared;
      release();
      retained = prepared;
      registered.preparedProfileIdentity = prepared.identity;
      registered.preparedRecipientProfileId = undefined;
      if (registered.authenticatedUserProfile) {
        Object.assign(registered.authenticatedUserProfile, profile);
      } else {
        registered.authenticatedUserProfile = profile;
      }
      prepareGatewayRecipientProfile(registered, { identity: prepared.recipient });
      attachGatewayLocalUserIngress(registered, prepareIngress(profile));
      const { profileId: id, ...display } = profile;
      handler.buildRequestContext().refreshConnectedUserProfile?.({ id, ...display });
    },
  };
}

async function resolveAuthenticatedProfile(profileId: string, assertCurrent?: () => void) {
  assertCurrent?.();
  const identity = await prepareUserProfileIdentity(profileId, { resolveAliases: true });
  try {
    assertCurrent?.();
    const { profile, aliases } = identity.readCurrentFacts();
    const { id, ...display } = identity.readCurrentDisplay();
    return {
      profile: { profileId: id, ...display },
      identity,
      recipient: { profileId: profile.profileId, role: profile.assignedRole, aliases },
    };
  } catch (error) {
    identity.release();
    throw error;
  }
}

async function resolveGatewayConnectUserProfile(params: {
  ownerProfileExpected: boolean;
  authenticatedUserId: string | undefined;
  authResult: GatewayAuthResult;
  resolveAuthenticatedGitHubIdentity: ReturnType<typeof createAuthenticatedGitHubIdentitySync>;
  assertCurrent?: () => void;
}) {
  params.assertCurrent?.();
  const options = { assertCurrent: params.assertCurrent };
  const ownerDisplayName = params.ownerProfileExpected ? await resolveHostAccountName() : undefined;
  params.assertCurrent?.();
  const profile = params.ownerProfileExpected
    ? await ensureCanonicalGatewayOwnerProfile(ownerDisplayName ?? null, options)
    : params.resolveAuthenticatedGitHubIdentity
      ? await params.resolveAuthenticatedGitHubIdentity()
      : params.authResult.tailscaleIdentity
        ? await ensureCanonicalUserProfileForTailscaleIdentity(
            params.authResult.tailscaleIdentity,
            options,
          )
        : await ensureCanonicalUserProfileForEmail(params.authenticatedUserId!, options);
  params.assertCurrent?.();
  const profileId = "profileId" in profile ? profile.profileId : profile.id;
  return resolveAuthenticatedProfile(profileId, params.assertCurrent);
}

/** Role and access policies need verified identity before admission; attribution alone may defer it. */
export async function resolveGatewayConnectProfileAdmission(params: {
  context: Pick<GatewayConnectPhaseContext, "configSnapshot"> &
    Parameters<typeof rejectUnavailableProfileConnect>[0] & {
      handler: Pick<GatewayConnectPhaseContext["handler"], "connId" | "logWsControl">;
    };
  state: Pick<DeviceAuthorizedGatewayConnect, "authResult" | "role" | "authMethod">;
  ownerProfileExpected: boolean;
  authenticatedUserId: string | undefined;
  resolveAuthenticatedGitHubIdentity: ReturnType<typeof createAuthenticatedGitHubIdentitySync>;
  assertCurrent?: () => void;
}): Promise<{ ok: true; prepared?: PreparedConnectProfile } | { ok: false }> {
  const { context, state, ownerProfileExpected, authenticatedUserId } = params;
  const profileRequired =
    Boolean(context.configSnapshot.gateway?.roles) ||
    hasGatewayOperatorAccessPolicies(context.configSnapshot);
  if (
    !ownerProfileExpected &&
    (!authenticatedUserId || (params.resolveAuthenticatedGitHubIdentity && !profileRequired))
  ) {
    return { ok: true };
  }
  let prepared: PreparedConnectProfile | undefined;
  try {
    prepared = await resolveGatewayConnectUserProfile({
      ownerProfileExpected,
      authenticatedUserId,
      authResult: state.authResult,
      resolveAuthenticatedGitHubIdentity: params.resolveAuthenticatedGitHubIdentity,
      assertCurrent: params.assertCurrent,
    });
    params.assertCurrent?.();
    prepared.identity.readCurrentProfile();
    return { ok: true, prepared };
  } catch (error) {
    prepared?.identity.release();
    context.handler.logWsControl.warn(
      `user profile resolution failed conn=${context.handler.connId} user=${formatForLog(authenticatedUserId)}: ${formatForLog(error)}`,
    );
    if (
      !ownerProfileExpected &&
      profileRequired &&
      state.role === "operator" &&
      state.authMethod !== "token" &&
      state.authMethod !== "password"
    ) {
      await rejectUnavailableProfileConnect(context, error);
      return { ok: false };
    }
    return { ok: true };
  }
}

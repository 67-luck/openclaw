import type { IncomingMessage, ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHostAccountName } from "../infra/host-account-name.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import {
  ensureCanonicalGatewayOwnerProfile,
  ensureCanonicalUserProfileForEmail,
  ensureCanonicalUserProfileForTailscaleIdentity,
} from "../state/user-profile-writes.js";
import type { PreparedUserProfileIdentity } from "../state/user-profiles.types.js";
import type { GatewayAuthResult } from "./auth.js";
import { shouldUseGatewayOwnerProfile } from "./gateway-owner-profile.js";
import { createAuthenticatedGitHubIdentitySync } from "./github-user-identity.js";
import {
  GatewayOperatorAccessDeniedError,
  hasGatewayOperatorAccessPolicies,
  resolveGatewayOperatorAccessAuthority,
} from "./operator-access-policy.js";
import type { GatewayOperatorAccessAuthority } from "./operator-access-policy.types.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";
import { resolveBrowserOriginPolicy } from "./origin-check.js";
import type { GatewayClient } from "./server-methods/shared-types.js";
import { formatForLog } from "./ws-log.js";

const profileLog = createSubsystemLogger("gateway/user-profiles");

export type AuthenticatedHttpUserProfile = {
  preparedProfileIdentity?: PreparedUserProfileIdentity;
  authenticatedUserProfile?: GatewayClient["authenticatedUserProfile"];
  operatorRolePolicy?: GatewayOperatorRoleDefinition;
  operatorAccessAuthority?: GatewayOperatorAccessAuthority | null;
};

type HttpUserProfileAuthResult =
  | { ok: true; profile: AuthenticatedHttpUserProfile }
  | { ok: false; authResult: GatewayAuthResult };

function failedHttpProfileAuthentication(error?: unknown): HttpUserProfileAuthResult {
  return {
    ok: false,
    authResult: {
      ok: false,
      reason:
        error instanceof GatewayOperatorAccessDeniedError
          ? "operator_access_denied"
          : "user_profile_unavailable",
    },
  };
}

export async function checkAuthenticatedHttpUserProfile(
  params: Parameters<typeof resolveAuthenticatedHttpUserProfile>[0],
): Promise<HttpUserProfileAuthResult> {
  try {
    return { ok: true, profile: await resolveAuthenticatedHttpUserProfile(params) };
  } catch (error) {
    return failedHttpProfileAuthentication(error);
  }
}

/** A signed cookie retains one exact profile reference; current policy still governs its admission. */
export async function checkHttpCookieUserProfile(
  cfg: OpenClawConfig,
  profileIds: readonly (string | undefined)[],
  assertCurrent: () => void,
  lifetime: ServerResponse | IncomingMessage["socket"],
  identity?: PreparedUserProfileIdentity,
): Promise<HttpUserProfileAuthResult> {
  const profileId = profileIds[0];
  if (
    profileIds.some((candidate) => candidate !== profileId) ||
    (!profileId && (cfg.gateway?.roles || hasGatewayOperatorAccessPolicies(cfg)))
  ) {
    return failedHttpProfileAuthentication();
  }
  // A signed viewer still narrows session sharing when named roles are disabled.
  if (!profileId) {
    return { ok: true, profile: {} };
  }
  try {
    const profile = identity
      ? resolveHttpProfile(identity, cfg)
      : await prepareHttpProfile(profileId, assertCurrent, cfg, lifetime);
    assertCurrent();
    return { ok: true, profile };
  } catch (error) {
    return failedHttpProfileAuthentication(error);
  }
}

export function usesSharedSecretGatewayMethod(
  method: GatewayAuthResult["method"] | undefined,
): boolean {
  return method === "token" || method === "password";
}

export async function resolveAuthenticatedHttpUserProfile(params: {
  authResult: GatewayAuthResult;
  cfg: OpenClawConfig;
  getRuntimeConfig?: () => OpenClawConfig;
  req: IncomingMessage;
  res?: ServerResponse;
}): Promise<AuthenticatedHttpUserProfile> {
  const readAdmissionPolicy = (cfg: OpenClawConfig) => {
    return {
      // HTTP admission never consumes WebSocket identity grants.
      auth: { ...cfg.gateway?.auth, identityScopes: undefined },
      roles: cfg.gateway?.roles,
      trustedProxies: cfg.gateway?.trustedProxies,
      allowRealIpFallback: cfg.gateway?.allowRealIpFallback,
      browserOrigin: resolveBrowserOriginPolicy({ req: params.req, cfg }),
    };
  };
  const admissionPolicy = structuredClone(readAdmissionPolicy(params.cfg));
  const assertCurrent = () => {
    if (
      params.req.aborted ||
      params.req.socket?.destroyed ||
      params.res?.destroyed ||
      params.res?.writableEnded ||
      !isDeepStrictEqual(
        admissionPolicy,
        readAdmissionPolicy(params.getRuntimeConfig?.() ?? getRuntimeConfig()),
      )
    ) {
      throw new Error("HTTP profile acquisition authority expired");
    }
  };
  assertCurrent();
  const options = { assertCurrent };
  const authenticatedUserId = normalizeOptionalString(params.authResult.user);
  const rolesConfigured = Boolean(params.cfg.gateway?.roles);
  const accessPoliciesConfigured = hasGatewayOperatorAccessPolicies(params.cfg);
  if (!authenticatedUserId) {
    if (
      shouldUseGatewayOwnerProfile({
        role: "operator",
        authenticatedUserId,
        authMethod: params.authResult.method,
        rolesConfigured,
      })
    ) {
      try {
        const displayName = await resolveHostAccountName();
        assertCurrent();
        const profile = await ensureCanonicalGatewayOwnerProfile(displayName, options);
        // Shared-secret operators retain their existing authority, regardless of profile roles.
        return await prepareHttpProfile(
          profile.id,
          assertCurrent,
          undefined,
          params.res ?? params.req.socket,
        );
      } catch (error) {
        assertCurrent();
        profileLog.warn(`owner profile resolution failed: ${formatForLog(error)}`);
        return {};
      }
    }
    throw new Error("operator role policies require a verified durable user profile");
  }
  try {
    const syncGitHubIdentity = createAuthenticatedGitHubIdentitySync({
      authResult: params.authResult,
      authConfig: params.cfg.gateway?.auth,
      requestHeaders: params.req.headers,
      assertCurrent,
    });
    const profile = syncGitHubIdentity
      ? await syncGitHubIdentity()
      : params.authResult.tailscaleIdentity
        ? await ensureCanonicalUserProfileForTailscaleIdentity(
            params.authResult.tailscaleIdentity,
            options,
          )
        : await ensureCanonicalUserProfileForEmail(authenticatedUserId, options);
    const profileId = "profileId" in profile ? profile.profileId : profile.id;
    return await prepareHttpProfile(
      profileId,
      assertCurrent,
      usesSharedSecretGatewayMethod(params.authResult.method) ? undefined : params.cfg,
      params.res ?? params.req.socket,
    );
  } catch (error) {
    assertCurrent();
    // Attribution enriches authenticated requests; configured role/access policies
    // make durable profile resolution a prerequisite for authorization.
    if (rolesConfigured || accessPoliciesConfigured) {
      throw error;
    }
    return {};
  }
}

export async function prepareHttpProfile(
  profileId: string,
  assertCurrent: () => void,
  cfg: OpenClawConfig | undefined,
  lifetime: ServerResponse | IncomingMessage["socket"],
): Promise<AuthenticatedHttpUserProfile> {
  assertCurrent();
  const identity = await prepareUserProfileIdentity(profileId, { resolveAliases: true });
  try {
    assertCurrent();
    const profile = resolveHttpProfile(identity, cfg);
    assertCurrent();
    identity.readCurrentProfile();
    const release = () => {
      lifetime.off("finish", release);
      lifetime.off("close", release);
      identity.release();
    };
    lifetime.once("finish", release);
    lifetime.once("close", release);
    return profile;
  } catch (error) {
    identity.release();
    throw error;
  }
}

/** Final disclosure consumes the request owner's retained identity without yielding. */
export function resolveHttpProfile(identity: PreparedUserProfileIdentity, cfg?: OpenClawConfig) {
  const display = identity.readCurrentDisplay();
  const { assignedRole } = identity.readCurrentProfile();
  const operatorRolePolicy = cfg
    ? resolveOperatorRolePolicyForAssignment(display.id, assignedRole, cfg)
    : undefined;
  const operatorAccessAuthority = cfg
    ? resolveGatewayOperatorAccessAuthority(identity, cfg)
    : undefined;
  identity.readCurrentProfile();
  return {
    preparedProfileIdentity: identity,
    authenticatedUserProfile: {
      profileId: display.id,
      displayName: display.displayName,
      avatarRevision: display.avatarRevision,
      hasAvatar: display.hasAvatar,
      updatedAt: display.updatedAt,
    },
    ...(operatorRolePolicy ? { operatorRolePolicy } : {}),
    ...(operatorAccessAuthority !== undefined ? { operatorAccessAuthority } : {}),
  };
}

export function applyHttpOperatorRoleScopeCeiling(
  scopes: string[],
  auth: Pick<AuthenticatedHttpUserProfile, "operatorRolePolicy"> | undefined,
): string[] {
  const allowedScopes = auth?.operatorRolePolicy?.scopes;
  return allowedScopes ? intersectOperatorScopes(scopes, allowedScopes) : scopes;
}

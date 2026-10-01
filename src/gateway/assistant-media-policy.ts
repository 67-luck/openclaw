import type { IncomingMessage, ServerResponse } from "node:http";
import { isCloudWorkerPlacementState } from "../../packages/gateway-protocol/src/schema/session-placement-state.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { resolveSessionPermissionCoreToolPolicy } from "../agents/session-permission-exec-mode.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../agents/tool-fs-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { FsSafeError } from "../infra/fs-safe.js";
import { getAgentScopedMediaLocalRoots, getDefaultMediaLocalRoots } from "../media/local-roots.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import type { PreparedUserProfileIdentity } from "../state/user-profiles.types.js";
import {
  applyHttpOperatorRoleScopeCeiling,
  prepareHttpProfile,
  resolveHttpProfile,
} from "./http-auth-user-profile.js";
import type { AuthorizedControlUiReadRequest } from "./http-auth-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { createProfileSessionEntryFilter } from "./session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import { resolveSessionWorkerPlacementContext } from "./session-worker-placement-context.js";
import { resolveSessionWorkspaceRoots } from "./session-workspace-roots.js";

export type AssistantMediaSession = {
  sessionKey: string;
  agentId: string;
  sessionId: string;
};

export type AssistantMediaReader = Pick<
  AuthorizedControlUiReadRequest,
  "authMethod" | "operatorScopes"
> & {
  profileId?: string;
};

function resolveAssistantMediaReaderAuth(
  reader: AssistantMediaReader,
  config: OpenClawConfig,
  identity?: PreparedUserProfileIdentity,
): AuthorizedControlUiReadRequest | undefined {
  try {
    if (reader.profileId && !identity) {
      return undefined;
    }
    const currentProfile = identity ? resolveHttpProfile(identity, config) : undefined;
    const operatorScopes = applyHttpOperatorRoleScopeCeiling(reader.operatorScopes, currentProfile);
    if (!authorizeOperatorScopesForMethod("assistant.media.get", operatorScopes).allowed) {
      return undefined;
    }
    return { authMethod: reader.authMethod, operatorScopes, ...currentProfile };
  } catch {
    return undefined;
  }
}

function resolveAssistantMediaPolicy(params: {
  config: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  requestAuth?: AuthorizedControlUiReadRequest;
  reader?: AssistantMediaReader;
  preparedProfileIdentity?: PreparedUserProfileIdentity;
}) {
  let loaded: ReturnType<typeof loadGatewaySessionEntryReadOnly> | undefined;
  if (params.sessionKey) {
    const owner = resolveRequestedSessionAgentId(params.config, params.sessionKey, params.agentId);
    if (!owner.ok) {
      return undefined;
    }
    loaded = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId: owner.agentId });
    if (!loaded.entry?.sessionId) {
      return undefined;
    }
  }
  // Session storage reads the committed runtime config, including a reload during file preparation.
  const config = loaded?.cfg ?? params.config;
  const reader =
    params.reader ??
    (params.requestAuth
      ? {
          authMethod: params.requestAuth.authMethod,
          operatorScopes: params.requestAuth.operatorScopes,
          ...(params.requestAuth.authenticatedUserProfile
            ? { profileId: params.requestAuth.authenticatedUserProfile.profileId }
            : {}),
        }
      : undefined);
  const auth =
    params.requestAuth ??
    (reader
      ? resolveAssistantMediaReaderAuth(reader, config, params.preparedProfileIdentity)
      : undefined);
  if (!auth || !reader) {
    return undefined;
  }
  const agentId = loaded?.agentId ?? params.agentId;
  const entry = loaded?.entry;
  const remote = Boolean(entry?.execNode || entry?.repositoryWorkspaceId);
  let session: AssistantMediaSession | undefined;
  let sessionRoot: string | undefined;
  let executionCwd: string | undefined;
  if (loaded && entry && agentId) {
    if (!auth.operatorScopes.includes("operator.admin")) {
      const profileId = auth.authenticatedUserProfile?.profileId;
      if (profileId && profileId !== GATEWAY_OWNER_PROFILE_ID) {
        // Match artifact reads: named people cannot read incognito; named roles
        // additionally apply the session catalog's creator/visibility ceiling.
        if (entry.incognito || isIncognitoSessionKey(loaded.canonicalKey)) {
          return undefined;
        }
        if (
          auth.operatorRolePolicy &&
          !createProfileSessionEntryFilter({
            profileId,
            sessionCap: auth.operatorRolePolicy.sessions.others,
          })(loaded.canonicalKey, entry)
        ) {
          return undefined;
        }
      } else if (!profileId && config.gateway?.roles) {
        return undefined;
      }
    }
    session = { sessionKey: loaded.canonicalKey, agentId, sessionId: entry.sessionId };
    if (!remote) {
      const workspace = resolveSessionWorkspaceRoots(config, agentId, entry);
      sessionRoot = entry.sessionRoot ?? workspace.root;
      executionCwd = workspace.diffCwd;
    }
  }
  const workspaceOnly =
    !session ||
    (entry?.permissionMode
      ? resolveSessionPermissionCoreToolPolicy({ mode: entry.permissionMode }).workspaceOnly
      : resolveEffectiveToolFsWorkspaceOnly({ cfg: config, agentId }));
  const localRoots = [
    ...(remote
      ? getDefaultMediaLocalRoots()
      : getAgentScopedMediaLocalRoots(config, agentId, workspaceOnly ? sessionRoot : undefined)),
  ];
  // Full Access retains established agent-workspace downloads alongside the selected project.
  if (sessionRoot && !localRoots.includes(sessionRoot)) {
    localRoots.push(sessionRoot);
  }
  // Cloud placement owns its filesystem independently of the session exec-node setting.
  const placement = session
    ? resolveSessionWorkerPlacementContext()
        .workerSessionPlacementService?.getMany([session.sessionId])
        .get(session.sessionId)
    : undefined;
  return {
    session,
    operatorAccessAuthority: auth.operatorAccessAuthority,
    executionCwd,
    remote: remote || isCloudWorkerPlacementState(placement?.state),
    localRoots,
    workspaceOnly,
    reader,
    canAllow: auth.operatorScopes.includes("operator.admin"),
  };
}

export async function prepareAssistantMediaPolicy(
  params: Parameters<typeof resolveAssistantMediaPolicy>[0],
  req: IncomingMessage,
  res: ServerResponse,
) {
  const assertRequestCurrent = () => {
    if (req.aborted || req.socket?.destroyed || res.destroyed || res.writableEnded) {
      throw new FsSafeError("path-mismatch", "Media access changed");
    }
  };
  let preparedProfileIdentity = params.requestAuth?.preparedProfileIdentity;
  if (!params.requestAuth && params.reader?.profileId) {
    try {
      preparedProfileIdentity = (
        await prepareHttpProfile(params.reader.profileId, assertRequestCurrent, params.config, res)
      ).preparedProfileIdentity;
    } catch {
      return undefined;
    }
  }
  const policyParams = { ...params, preparedProfileIdentity };
  const policy = resolveAssistantMediaPolicy(policyParams);
  if (!policy) {
    return undefined;
  }
  return {
    ...policy,
    assertCurrent(allowance: boolean) {
      assertRequestCurrent();
      policy.operatorAccessAuthority?.assertCurrent();
      const current = resolveAssistantMediaPolicy({
        ...policyParams,
        requestAuth: undefined,
        reader: policy.reader,
      });
      if (
        params.requestAuth?.hasCurrentClientAuthority?.() === false ||
        !current ||
        current.session?.sessionKey !== policy.session?.sessionKey ||
        current.session?.agentId !== policy.session?.agentId ||
        current.session?.sessionId !== policy.session?.sessionId ||
        current.remote !== policy.remote ||
        current.executionCwd !== policy.executionCwd ||
        current.workspaceOnly !== policy.workspaceOnly ||
        current.localRoots.length !== policy.localRoots.length ||
        current.localRoots.some((root, index) => root !== policy.localRoots[index]) ||
        (allowance && policy.workspaceOnly && !current.canAllow)
      ) {
        throw new FsSafeError("path-mismatch", "Media access changed");
      }
      return current;
    },
  };
}

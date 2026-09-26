import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { UserProfileNotFoundError } from "../state/user-profiles-schema.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  hasOperatorBoundary,
  operatorSessionCap,
  resolveGatewayOperatorRoleActor,
} from "./operator-role-policy.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  sharingIdentity,
  type PreparedSessionMutationFacts,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import {
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
  type SessionFactsRead,
} from "./session-sharing-preparation.js";
import { prepareSessionSharing } from "./session-sharing-read.js";
import {
  authorizeIncognitoSessionTarget,
  authorizeSessionSharingTarget,
  createSessionListEntryFilter,
  isGatewayAdmin,
  resolveSessionSharingTarget,
  resolveSessionSharingTargets,
} from "./session-sharing.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";

export function resolveTaskRequesterSessionTarget(
  task: Pick<TaskRecord, "ownerKey" | "requesterAgentId" | "requesterSessionKey">,
): { sessionKey: string; agentId?: string } | undefined {
  const sessionKey = normalizeOptionalString(task.requesterSessionKey);
  if (!sessionKey) {
    return undefined;
  }
  const agentId =
    normalizeOptionalString(task.requesterAgentId) ??
    parseAgentSessionKey(sessionKey)?.agentId ??
    parseAgentSessionKey(task.ownerKey)?.agentId;
  return { sessionKey, ...(agentId ? { agentId } : {}) };
}

export function canAccessTaskRequesterSession(params: {
  access?: "read" | "write";
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  task: Pick<TaskRecord, "ownerKey" | "requesterAgentId" | "requesterSessionKey">;
}): boolean {
  const target = resolveTaskRequesterSessionTarget(params.task);
  if (!target || isGatewayAdmin(params.client)) {
    return true;
  }
  return canAccessResolvedTaskSession(
    params,
    target,
    resolveSessionSharingTarget({ cfg: params.cfg, ...target }),
  );
}

function canAccessResolvedTaskSession(
  params: Pick<Parameters<typeof canAccessTaskRequesterSession>[0], "cfg" | "client" | "access">,
  target: ReturnType<typeof resolveTaskRequesterSessionTarget>,
  sharingTarget: SessionSharingTarget | null,
  prepared?: ReturnType<typeof prepareSessionSharing>,
): boolean {
  if (!target || isGatewayAdmin(params.client)) {
    return true;
  }
  if (
    authorizeIncognitoSessionTarget({
      client: params.client,
      sessionKey: target.sessionKey,
      target: sharingTarget,
    })
  ) {
    return false;
  }
  if (!hasOperatorBoundary(params.client, params.cfg, prepared)) {
    return true;
  }
  if (!sharingTarget) {
    return false;
  }
  if (params.access === "write") {
    return !(prepared
      ? prepared.authorizeTarget(sharingTarget)
      : authorizeSessionSharingTarget({
          cfg: params.cfg,
          client: params.client,
          target: sharingTarget,
        }));
  }
  const visibilityFilter = prepared
    ? prepared.entryFilter
    : createSessionListEntryFilter({ cfg: params.cfg, client: params.client });
  return visibilityFilter?.(sharingTarget.storeKey, sharingTarget.entry) ?? true;
}

/** Retain storage facts; each admission still evaluates the current caller and policy. */
export async function prepareTaskSessionAccess(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  task: Pick<TaskRecord, "ownerKey" | "requesterAgentId" | "requesterSessionKey">;
}) {
  const { client } = params;
  const target = resolveTaskRequesterSessionTarget(params.task);
  const initialActor = resolveGatewayOperatorRoleActor(client);
  const actor = initialActor && { ...initialActor };
  const identityId = sharingIdentity(client, actor)?.id;
  let active = true;
  let facts: SessionFactsRead<PreparedSessionMutationFacts> | undefined;
  let profiles: Awaited<ReturnType<typeof prepareUserProfileCatalog>> | undefined;
  const canonicalProfiles = new Map<string, string>();
  const release = () => {
    active = false;
    try {
      facts?.release();
    } finally {
      profiles?.release();
    }
  };
  const readIdentity = (profileId: string) => {
    if (!profiles) {
      throw new SessionMutationFactsUnavailableError();
    }
    const current = profiles.readCurrentIdentity(profileId);
    if ((current?.profileId ?? profileId) !== canonicalProfiles.get(profileId)) {
      throw new SessionMutationFactsUnavailableError();
    }
    return current;
  };
  try {
    if (target && !isGatewayAdmin(client)) {
      const { agentId } = resolveSessionStoreIdentity({ cfg: params.cfg, ...target });
      facts = await prepareSessionMutationFacts({
        cfg: params.cfg,
        sessionKey: target.sessionKey,
        agentId,
        allowMissing: true,
      });
      if (
        (identityId || actor?.kind === "operator") &&
        (params.cfg.gateway?.roles ||
          hasOperatorBoundary(client, params.cfg, { sessionCap: undefined }))
      ) {
        profiles = await prepareUserProfileCatalog();
        for (const id of new Set([
          ...(identityId ? [identityId] : []),
          ...(actor?.kind === "operator" ? [actor.profileId] : []),
        ])) {
          canonicalProfiles.set(id, profiles.readCurrentIdentity(id)?.profileId ?? id);
        }
      }
    }
    return {
      canAccess(cfg: OpenClawConfig, access: "read" | "write" = "read") {
        const currentActor = resolveGatewayOperatorRoleActor(client);
        if (
          !active ||
          currentActor?.kind !== actor?.kind ||
          (currentActor?.kind === "operator" &&
            (actor?.kind !== "operator" || currentActor.profileId !== actor.profileId)) ||
          sharingIdentity(client, currentActor)?.id !== identityId
        ) {
          throw new SessionMutationFactsUnavailableError();
        }
        if (!target || isGatewayAdmin(client)) {
          return true;
        }
        if (!facts) {
          return false;
        }
        const current = facts.readCurrent(cfg);
        if (
          authorizeIncognitoSessionTarget({
            client,
            sessionKey: target.sessionKey,
            target: current.target,
          })
        ) {
          return false;
        }
        const sessionCap = operatorSessionCap(client, cfg, {
          readCurrentRole(profileId) {
            const profile = readIdentity(profileId);
            if (!profile) {
              throw new UserProfileNotFoundError(profileId);
            }
            return profile.role ?? null;
          },
        });
        const aliases =
          identityId && hasOperatorBoundary(client, cfg, { sessionCap })
            ? new Set([identityId, ...(readIdentity(identityId)?.aliases ?? [])])
            : new Set<string>();
        const sharing = prepareSessionSharing(
          { cfg, client },
          {
            aliases,
            sessionCap,
            isMember: (_target, profileId) => current.membership.has(profileId),
          },
        );
        return canAccessResolvedTaskSession(
          { cfg, client, access },
          target,
          current.target,
          sharing,
        );
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

/** Prepare only this slice's entries; the registry drops this filter before yielding. */
export function prepareTaskSessionReadFilter(
  params: { cfg: OpenClawConfig; client: GatewayClient | null },
  tasks: readonly Readonly<TaskRecord>[],
): (task: Readonly<TaskRecord>) => boolean {
  if (isGatewayAdmin(params.client)) {
    return (task) => canAccessTaskRequesterSession({ ...params, task });
  }
  const requests: Array<{
    task: Readonly<TaskRecord>;
    target: ReturnType<typeof resolveTaskRequesterSessionTarget>;
    sharingTarget: SessionSharingTarget | null;
  }> = tasks.map((task) => ({
    task,
    target: resolveTaskRequesterSessionTarget(task),
    sharingTarget: null,
  }));
  const lookups = requests.flatMap((request) =>
    request.target ? [{ request, target: request.target }] : [],
  );
  for (const [index, sharingTarget] of resolveSessionSharingTargets({
    cfg: params.cfg,
    targets: lookups.map((lookup) => lookup.target),
  }).entries()) {
    expectDefined(lookups[index], "prepared task session lookup").request.sharingTarget =
      sharingTarget;
  }
  const prepared = new Map(requests.map((request) => [request.task, request]));
  return (task) => {
    const request = expectDefined(
      prepared.get(task),
      "task belongs to the synchronous access slice",
    );
    return canAccessResolvedTaskSession(params, request.target, request.sharingTarget);
  };
}

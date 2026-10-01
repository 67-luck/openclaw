import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { assertAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { SessionCreatedActor } from "../config/sessions/session-entry-provenance.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { bumpGatewayAccessRevision } from "./gateway-access-revision.js";
import {
  resolveOperatorSessionCreation,
  type TrustedSessionCreation,
} from "./server-methods/session-creation-provenance.js";
import type { GatewayClient, GatewayOperatorRoleActor } from "./server-methods/shared-types.js";

const operatorRoleLog = createSubsystemLogger("gateway/operator-roles");
const reportedUnknownAssignments = new Set<string>();
type OperatorRolePolicyChange =
  | { kind: "assignment"; profileId: string }
  | { kind: "config"; context: object };
const policyListeners = new Set<(change: OperatorRolePolicyChange) => void>();
let assignmentRevision = 0;
const deniedOperatorRole: GatewayOperatorRoleDefinition = {
  sessions: { others: "none" },
  agents: [],
  scopes: [],
};

type GatewaySessionAgentAuthorization = {
  cfg: OpenClawConfig;
  agentId: string;
  preparedProfileIdentity?: GatewayClient["preparedProfileIdentity"];
} & (
  | { actor: GatewayOperatorRoleActor; profileId?: never; client?: never }
  | { actor?: never; profileId: string | undefined; client?: never }
  | { actor?: never; profileId?: never; client: GatewayClient | null | undefined }
);

type OperatorRoleSource = Pick<GatewayClient, "preparedProfileIdentity" | "internal">;

export async function prepareOperatorRoleSource(
  cfg: OpenClawConfig,
  subject?: string | GatewayOperatorRoleActor | SessionCreatedActor,
) {
  const profileId =
    typeof subject === "string"
      ? subject
      : subject && "kind" in subject
        ? subject.kind === "operator"
          ? subject.profileId
          : undefined
        : subject?.type === "human"
          ? subject.id
          : undefined;
  const preparedProfileIdentity =
    cfg.gateway?.roles && profileId && profileId !== GATEWAY_OWNER_PROFILE_ID
      ? await prepareUserProfileIdentity(profileId, { resolveAliases: true })
      : undefined;
  return {
    preparedProfileIdentity,
    [Symbol.dispose]: () => preparedProfileIdentity?.release(),
  };
}

export async function prepareSessionCreationAuthority(
  cfg: OpenClawConfig,
  input: { operatorRoleActor?: GatewayOperatorRoleActor; requestingOperatorProfileId?: string },
) {
  const source = {
    requestingOperatorProfileId: input.requestingOperatorProfileId,
    operatorRoleActor: input.operatorRoleActor && { ...input.operatorRoleActor },
  };
  const prepared = await prepareOperatorRoleSource(
    cfg,
    source.operatorRoleActor ?? source.requestingOperatorProfileId,
  );
  return {
    [Symbol.dispose]: prepared[Symbol.dispose],
    authorize: (agentId: string) =>
      authorizeGatewaySessionCreation({
        cfg,
        agentId,
        preparedProfileIdentity: prepared.preparedProfileIdentity,
        ...(source.operatorRoleActor
          ? { actor: source.operatorRoleActor }
          : { profileId: source.requestingOperatorProfileId }),
      }),
  };
}

export function invalidateOperatorRolePolicy(profileId: string): void {
  assignmentRevision += 1;
  bumpGatewayAccessRevision();
  for (const reported of reportedUnknownAssignments) {
    if (reported.startsWith(`${profileId}:`)) {
      reportedUnknownAssignments.delete(reported);
    }
  }
  notifyListeners([...policyListeners], { kind: "assignment", profileId });
}

export function onOperatorRolePolicyChanged(
  listener: (change: OperatorRolePolicyChange) => void,
): () => void {
  return registerListener(policyListeners, listener);
}

/** Called after this Gateway's committed runtime reader advances, never at tentative activation. */
export function publishOperatorRoleConfigChange(context: object | undefined): void {
  if (context) {
    notifyListeners([...policyListeners], { kind: "config", context });
  }
}

export function readOperatorRolePolicyRevision(): number {
  return assignmentRevision;
}

/** An enabled role boundary denies missing identity and unresolvable assignments. */
export function resolveOperatorRolePolicyForProfile(
  profileId: string | undefined,
  cfg: OpenClawConfig,
  source?: OperatorRoleSource,
): GatewayOperatorRoleDefinition | undefined {
  // The owner attributes the shared-secret system actor; roles govern identified people only.
  if (!cfg.gateway?.roles || profileId === GATEWAY_OWNER_PROFILE_ID) {
    return undefined;
  }
  const authority = source?.internal?.operatorRunAuthority;
  let role: string | null = null;
  let roleProfileId = profileId;
  if (profileId && authority) {
    assertAdmittedRunOperatorAuthority(authority);
    authority.assertCurrent();
    if (authority.profileId !== profileId || !authority.readCurrentRoleAssignment) {
      throw new Error("Gateway requester profile changed");
    }
    role = authority.readCurrentRoleAssignment();
  } else if (profileId) {
    const identity = source?.preparedProfileIdentity;
    const profile = identity?.readCurrentProfile();
    if (
      !profile ||
      (profile.profileId !== profileId && !identity?.readCurrentFacts().aliases.has(profileId))
    ) {
      throw new Error("Operator profile authority was not prepared");
    }
    roleProfileId = profile.profileId;
    role = profile.assignedRole;
  }
  return resolveOperatorRolePolicyForAssignment(roleProfileId, role, cfg);
}

/** Transaction and retained identity owners supply the current assignment. */
export function resolveOperatorRolePolicyForAssignment(
  profileId: string | undefined,
  assignedRole: string | null,
  cfg: OpenClawConfig,
): GatewayOperatorRoleDefinition | undefined {
  const roles = cfg.gateway?.roles;
  if (!roles || profileId === GATEWAY_OWNER_PROFILE_ID) {
    return undefined;
  }
  if (!profileId) {
    return deniedOperatorRole;
  }
  if (assignedRole && Object.hasOwn(roles.definitions, assignedRole)) {
    return roles.definitions[assignedRole];
  }
  if (assignedRole) {
    const reportKey = `${profileId}:${assignedRole}`;
    if (!reportedUnknownAssignments.has(reportKey)) {
      if (reportedUnknownAssignments.size >= 1_024) {
        reportedUnknownAssignments.clear();
      }
      reportedUnknownAssignments.add(reportKey);
      operatorRoleLog.warn(
        `User profile ${profileId} references unknown Gateway role "${assignedRole}"; ${
          roles.default ? `applying default role "${roles.default}"` : "denying access"
        }. Update gateway.roles.definitions or clear the assignment with users.setRole.`,
      );
    }
  }
  return (roles.default ? roles.definitions[roles.default] : undefined) ?? deniedOperatorRole;
}

/** Preserve human-derived restrictions, including ambiguous historical actors; this is not identity proof. */
export function resolveCreatorSandbox(
  cfg: OpenClawConfig,
  creation: { actor?: SessionCreatedActor } | undefined,
  source?: OperatorRoleSource,
): "required" | undefined {
  const actor = creation?.actor;
  return actor?.type === "human" &&
    actor.id &&
    resolveOperatorRolePolicyForProfile(actor.id, cfg, source)?.sandbox === "required"
    ? "required"
    : undefined;
}

/** Resolves the current named policy from the connection's verified profile identity. */
export function resolveGatewayOperatorRoleActor(
  client: GatewayClient | null | undefined,
): GatewayOperatorRoleActor | undefined {
  const actor = client?.internal?.operatorRoleActor;
  if (actor) {
    return actor;
  }
  const profileId = client?.authenticatedUserProfile?.profileId;
  return profileId && profileId !== GATEWAY_OWNER_PROFILE_ID
    ? { kind: "operator", profileId }
    : undefined;
}

/** Resolves the current named policy from an authoritative operator or system actor. */
export function resolveOperatorRolePolicy(
  client: GatewayClient | null,
  cfg: OpenClawConfig,
): GatewayOperatorRoleDefinition | undefined {
  const actor = resolveGatewayOperatorRoleActor(client);
  if (actor?.kind === "system") {
    return undefined;
  }
  return resolveOperatorRolePolicyForProfile(actor?.profileId, cfg, client ?? undefined);
}

/** A retained caller cannot keep grants removed by the current named role. */
export function authorizeCurrentOperatorRoleScopes(
  client: GatewayClient | null,
  cfg: OpenClawConfig,
): ErrorShape | undefined {
  const policy = resolveOperatorRolePolicy(client, cfg);
  if (
    policy &&
    !roleScopesAllow({
      role: "operator",
      requestedScopes: client?.connect.scopes ?? [],
      allowedScopes: policy.scopes,
    })
  ) {
    return errorShape(
      ErrorCodes.FORBIDDEN,
      "Your operator role changed; reconnect before continuing.",
    );
  }
  return undefined;
}

export function operatorSessionCap(client: GatewayClient | null, cfg: OpenClawConfig) {
  return resolveOperatorRolePolicy(client, cfg)?.sessions.others;
}

export function hasOperatorBoundary(client: GatewayClient | null, cfg: OpenClawConfig): boolean {
  if (operatorSessionCap(client, cfg) !== undefined) {
    return true;
  }
  if (resolveGatewayOperatorRoleActor(client)?.kind === "system") {
    return false;
  }
  const scopes = client?.connect?.scopes ?? [];
  return (
    roleScopesAllow({
      role: "operator",
      requestedScopes: ["operator.sessions.read"],
      allowedScopes: scopes,
    }) &&
    !roleScopesAllow({
      role: "operator",
      requestedScopes: ["operator.read"],
      allowedScopes: scopes,
    })
  );
}

/** Enforces the owning agent ceiling for session creation and run-start targets. */
export function authorizeGatewaySessionCreation(
  params: GatewaySessionAgentAuthorization,
  prepared?: { policy: GatewayOperatorRoleDefinition | undefined },
): ErrorShape | undefined {
  const actor =
    params.actor ??
    ("client" in params ? resolveGatewayOperatorRoleActor(params.client) : undefined);
  if (actor?.kind === "system") {
    return undefined;
  }
  const profileId = actor?.profileId ?? params.profileId;
  const role = prepared
    ? prepared.policy
    : "client" in params
      ? resolveOperatorRolePolicy(params.client ?? null, params.cfg)
      : resolveOperatorRolePolicyForProfile(profileId, params.cfg, params);
  if (!role || role.agents === "*" || role.agents.includes(params.agentId)) {
    return undefined;
  }
  return errorShape(
    ErrorCodes.FORBIDDEN,
    `Your operator role cannot create sessions for agent "${params.agentId}"; choose an allowed agent or ask a gateway administrator to update your role.`,
  );
}

/** Leave ordinary creation attribution unchanged unless the authenticated person requires isolation. */
export function resolveSandboxedSessionCreation(
  client:
    | (Parameters<typeof resolveOperatorSessionCreation>[0] & OperatorRoleSource)
    | null
    | undefined,
  cfg: OpenClawConfig,
): TrustedSessionCreation | undefined {
  const creation = resolveOperatorSessionCreation(client);
  return resolveCreatorSandbox(cfg, creation, client ?? undefined) === "required"
    ? { ...creation, sandbox: "required" }
    : undefined;
}

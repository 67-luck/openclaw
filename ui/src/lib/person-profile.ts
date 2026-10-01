import type {
  UserProfile,
  UsersListResult,
} from "../../../packages/gateway-protocol/src/schema/users.js";
import type { ApplicationGateway } from "../app/gateway.ts";
import { canCallGatewayMethod } from "./gateway-methods.ts";

/** Follow only merge edges returned by the authorized profile directory. */
export function canonicalPersonProfile(
  profiles: readonly UserProfile[],
  profileId: string,
): UserProfile | null {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const visited = new Set<string>();
  let profile = byId.get(profileId);
  while (profile?.mergedInto && !visited.has(profile.id)) {
    visited.add(profile.id);
    profile = byId.get(profile.mergedInto);
  }
  return profile && !profile.mergedInto ? profile : null;
}

export function canReadPersonProfile(gateway: ApplicationGateway, profileId: string): boolean {
  const snapshot = gateway.snapshot;
  const self = snapshot.selfUser?.identity;
  return (
    canCallGatewayMethod(snapshot, "users.list", "operator.read") ||
    (self?.type === "profile" &&
      self.id === profileId &&
      canCallGatewayMethod(snapshot, "users.self", "operator.sessions.read"))
  );
}

/** Self reads stay with the connection owner; other people require broad directory access. */
export async function readPersonProfile(
  gateway: ApplicationGateway,
  profileId: string,
): Promise<UserProfile | null> {
  if (!canReadPersonProfile(gateway, profileId)) {
    return null;
  }
  const snapshot = gateway.snapshot;
  if (
    snapshot.selfUser?.identity?.id === profileId &&
    canCallGatewayMethod(snapshot, "users.self", "operator.sessions.read")
  ) {
    return gateway.loadSelfProfile();
  }
  if (!snapshot.client || !canCallGatewayMethod(snapshot, "users.list", "operator.read")) {
    return null;
  }
  const result = await snapshot.client.request<UsersListResult>("users.list", {});
  return canonicalPersonProfile(result.profiles, profileId);
}

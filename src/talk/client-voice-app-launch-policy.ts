import type { TalkRealtimeConfig } from "../config/types.gateway.js";
import type { InstalledAppLaunchRequest } from "../infra/installed-app-launch.js";

type ClientVoiceAppLaunchPolicy = NonNullable<TalkRealtimeConfig["appLaunchPolicies"]>[number];

/** Ingress-owned authority; never accepted from Talk/tool arguments or restored from storage. */
export type ClientVoiceAppLaunchOrigin = Readonly<{
  deviceId: string;
  isCurrent: () => boolean;
  release: () => void;
  retain: () => ClientVoiceAppLaunchOrigin;
}>;

/** A match satisfies only Talk confirmation, not any other execution permission. */
export function resolveClientVoiceAppLaunchPolicy(params: {
  agentId: string;
  origin?: Pick<ClientVoiceAppLaunchOrigin, "deviceId" | "isCurrent">;
  nodeId: string;
  action: InstalledAppLaunchRequest;
  policies: readonly ClientVoiceAppLaunchPolicy[];
  nowMs?: number;
}): ClientVoiceAppLaunchPolicy | undefined {
  if (!params.origin) {
    return undefined;
  }
  try {
    if (!params.origin.isCurrent()) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const now = params.nowMs ?? Date.now();
  return params.policies.find(
    (policy) =>
      policy.expiresAtMs > now &&
      policy.agentId === params.agentId &&
      policy.originatingDeviceId === params.origin!.deviceId &&
      policy.nodeId === params.nodeId &&
      policy.appId === params.action.appId &&
      policy.appRevision === params.action.appRevision,
  );
}

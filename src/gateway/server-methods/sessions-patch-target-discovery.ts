import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { resolveGatewaySessionStoreTargetWithStore } from "../session-utils.js";
import type { MutationTarget } from "./sessions-patch-types.js";

/** Resolve the full batch before mutation, sharing only target-discovery facts. */
export function discoverSessionPatchTargets(
  cfg: OpenClawConfig,
  targets: readonly MutationTarget[],
) {
  const targetDiscoveryCache = new Map();
  const preflightTargets = targets.map((input) => {
    const key = input.key.trim();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, input.agentId);
    return {
      input,
      key,
      requestedAgent,
      resolved: requestedAgent.ok
        ? resolveGatewaySessionStoreTargetWithStore({
            cfg,
            key,
            agentId: requestedAgent.agentId,
            exactRead: true,
            targetDiscoveryCache,
          })
        : undefined,
    };
  });

  const logicalTargets = new Set<string>();
  for (const { key, resolved } of preflightTargets) {
    if (!resolved) {
      continue;
    }
    const logicalId = `${resolved.storePath}\0${resolved.canonicalKey ?? key}`;
    if (logicalTargets.has(logicalId)) {
      return undefined;
    }
    logicalTargets.add(logicalId);
  }
  return preflightTargets;
}

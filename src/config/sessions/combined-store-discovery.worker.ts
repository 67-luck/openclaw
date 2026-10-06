import type {
  GatewaySessionDiscoveryRequest,
  GatewaySessionDiscoveryResult,
  ResolvedGatewaySessionStoreTargets,
} from "./combined-store-discovery.types.js";
import { prepareGatewaySessionStoreTopology } from "./combined-store-gateway.js";
import { discoveryReadOptions } from "./combined-store-paths.js";
import {
  listConfiguredSessionStoreAgentIds,
  listKnownSessionStoreAgentIds,
  resolveConfiguredAgentDatabaseTargets,
} from "./targets.js";

/** Discovery kernel run by the existing session reader worker. */
export function readGatewaySessionDiscovery(
  request: GatewaySessionDiscoveryRequest,
): GatewaySessionDiscoveryResult {
  const { config, env, candidates } = request;
  if (request.operation === "owners") {
    return {
      kind: "gateway-session-discovery",
      operation: "owners",
      agentIds: listKnownSessionStoreAgentIds(config, {
        env,
        registeredDatabases: request.registeredDatabases,
        readCandidates: candidates,
      }),
    };
  }
  const discovery = { ...request.discovery, env, readCandidates: candidates };
  if (request.operation === "scopes") {
    const scopes = new Map<string, ResolvedGatewaySessionStoreTargets | Error>();
    const owners = new Set([...request.agentIds, ...listConfiguredSessionStoreAgentIds(config)]);
    const queries = [
      ["all", {}],
      ["configured", { configuredAgentsOnly: true }],
      ...[...owners].map((agentId) => [`agent:${agentId}`, { agentId }] as const),
    ] as const;
    for (const [key, query] of queries) {
      try {
        scopes.set(
          key,
          prepareGatewaySessionStoreTopology(config, {
            discovery,
            includeIncognito: false,
            ...query,
            preserveSentinelOwners: undefined,
          }),
        );
      } catch (error) {
        scopes.set(key, error instanceof Error ? error : new Error(String(error)));
      }
    }
    return { kind: "gateway-session-discovery", operation: "scopes", scopes };
  }
  const retainedDeletions = discovery.snapshot?.retainedDeletions;
  const configuredDatabaseTargets =
    retainedDeletions?.status === "present" ||
    (retainedDeletions?.status === "unavailable" && retainedDeletions.known)
      ? resolveConfiguredAgentDatabaseTargets(config, { env, ...discoveryReadOptions(discovery) })
      : [];
  const targets = prepareGatewaySessionStoreTopology(config, {
    ...request.options,
    discovery,
    includeIncognito: false,
  });
  return {
    kind: "gateway-session-discovery",
    operation: "topology",
    targets,
    configuredDatabaseTargets,
  };
}

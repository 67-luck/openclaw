import type { OpenClawConfig } from "../types.openclaw.js";
import type { GatewaySessionStoreDiscovery } from "./combined-store-paths.js";
import type { SessionStoreRegistryRead } from "./session-sqlite-target.js";
import type { SessionStoreReadCandidate } from "./session-store-read-candidates.js";
import type { SessionStoreTarget } from "./targets-collision.js";

export type GatewaySessionTopologyOptions = {
  agentId?: string;
  configuredAgentsOnly?: boolean;
  /** Keep per-agent sentinels distinct internally; public reads restore their raw key. */
  preserveSentinelOwners?: boolean | "physical";
};

export type ResolvedGatewaySessionStoreTargets = {
  groupDiscovery?: ReadonlyMap<string, { agentId: string; order: number }>;
  configuredAgentIds?: ReadonlySet<string>;
  defaultAgentId: string;
  diagnostics: readonly string[];
  durableStorePath?: string;
  durableTargets: ReadonlyArray<{ agentId: string; storePath: string }>;
  incognitoTargets: ReadonlyArray<{ agentId: string; storePath: string }>;
  physicalTargets: ReadonlyMap<string, SessionStoreTarget>;
  requestedAgentId?: string;
  preparedAgentIds?: Set<string>;
  sharedStoreRowOwner?: { agentId: string; target: SessionStoreTarget };
  storeConfig?: string;
};

export type GatewaySessionDiscoveryRequest = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  candidates: readonly SessionStoreReadCandidate[];
} & (
  | { operation: "owners"; registeredDatabases: SessionStoreRegistryRead }
  | {
      operation: "topology";
      discovery: GatewaySessionStoreDiscovery;
      options: GatewaySessionTopologyOptions;
    }
  | { operation: "scopes"; discovery: GatewaySessionStoreDiscovery; agentIds: readonly string[] }
);

export type GatewaySessionTopologyFacts = {
  targets: ResolvedGatewaySessionStoreTargets;
  configuredDatabaseTargets: readonly { agentId: string; path: string }[];
};

export type GatewaySessionScopeFacts = Map<string, ResolvedGatewaySessionStoreTargets | Error>;

export type GatewaySessionDiscoveryResult = { kind: "gateway-session-discovery" } & (
  | { operation: "owners"; agentIds: string[] }
  | ({ operation: "topology" } & GatewaySessionTopologyFacts)
  | { operation: "scopes"; scopes: GatewaySessionScopeFacts }
);

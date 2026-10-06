import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { prepareAgentDatabaseDeletionSnapshotRead } from "../../state/agent-deletion-journal.read.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../../state/openclaw-agent-db-registry-listing.js";
import {
  listOpenIncognitoAgentDatabases,
  readOpenClawAgentDatabaseRegistryToken,
  readOpenIncognitoAgentDatabaseGeneration,
} from "../../state/openclaw-agent-db.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { GatewaySessionScopeFacts } from "./combined-store-discovery.types.js";
import {
  admitGatewaySessionStoreTargets,
  mergeCombinedSessionStore,
  prepareCombinedSessionStore,
  type GatewayCombinedSessionStore,
  type GatewaySessionStoreOptions,
  type ResolvedGatewaySessionStoreTargets,
} from "./combined-store-gateway.js";
import {
  retainSessionLineageReadSource,
  withCombinedSessionLineage,
} from "./combined-store-lineage-read.js";
import { storeTargetKey, type GatewaySessionStoreDiscovery } from "./combined-store-paths.js";
import type { SessionEntrySummary } from "./session-accessor.types.js";
import {
  captureIncognitoSessionTopology,
  withIncognitoSessionStoreEntries,
} from "./session-incognito-binding.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
  captureSessionStoreReadCandidate,
} from "./session-store-read-candidates.js";
import { prepareSessionStoreTargetInventory } from "./session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabases } from "./session-transcript-worker-runtime.js";
import { listConfiguredSessionStoreAgentIds } from "./targets.js";

function captureDiscoveryCandidates(
  configured: ReturnType<typeof prepareSessionStoreTargetInventory>["candidates"],
  discovery?: GatewaySessionStoreDiscovery,
) {
  const candidates = [...configured];
  for (const row of discovery?.snapshot?.registeredAgentDatabases ?? []) {
    const candidate = captureSessionStoreReadCandidate(row.path);
    if (
      !candidates.some(
        (existing) => existing.path === candidate.path && existing.scope === candidate.scope,
      )
    ) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

export async function readKnownSessionStoreAgentIdsInWorker(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const inventory = prepareSessionStoreTargetInventory(
    cfg,
    listConfiguredSessionStoreAgentIds(cfg),
    env,
    "recovery",
  );
  const registry = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env: inventory.env });
  const identities = captureSessionStoreCandidateIdentities(inventory.candidates);
  return withSessionHistoryWorkerReadCandidates(inventory.candidates, async (owner) => {
    const snapshot = await registry.read();
    snapshot.assertCurrent();
    owner.assertCurrent();
    const result = await owner.readGatewayDiscovery({
      operation: "owners",
      config: inventory.config,
      env: inventory.env,
      candidates: inventory.candidates,
      registeredDatabases:
        snapshot.result.status === "available"
          ? snapshot.result.entries
          : { status: "unavailable" },
    });
    snapshot.assertCurrent();
    owner.assertCurrent();
    for (const [pathname, identity] of identities) {
      if (!isDeepStrictEqual(readDatabasePathIdentitySync(pathname), identity)) {
        throw new Error("Session owner discovery changed its physical source");
      }
    }
    if (result.operation !== "owners") {
      throw new Error("Session reader returned topology instead of owners");
    }
    return result.agentIds;
  });
}

/** Hold discovered physical sources until their prepared topology is consumed. */
export async function withPreparedGatewaySessionTopology<T>(
  cfg: OpenClawConfig,
  options: Omit<GatewaySessionStoreOptions, "loadEntries" | "onStoreLoaded"> & {
    discovery: GatewaySessionStoreDiscovery;
  },
  consume: (
    prepared: ReturnType<typeof prepareCombinedSessionStore>,
    discovery: GatewaySessionStoreDiscovery,
    prepareScopes: (agentIds: readonly string[]) => Promise<GatewaySessionScopeFacts>,
    assertCurrent: () => void,
  ) => Promise<T>,
  inventory = prepareSessionStoreTargetInventory(
    cfg,
    listConfiguredSessionStoreAgentIds(cfg),
    options.discovery.env,
    "recovery",
  ),
  capturedIdentities = captureSessionStoreCandidateIdentities(inventory.candidates),
): Promise<T> {
  const config = inventory.config;
  const candidates = captureDiscoveryCandidates(inventory.candidates, options.discovery);
  const identities = new Map(capturedIdentities);
  for (const [pathname, identity] of captureSessionStoreCandidateIdentities(candidates)) {
    if (!identities.has(pathname)) {
      identities.set(pathname, identity);
    }
  }
  const incognitoGeneration =
    options.includeIncognito === false ? undefined : readOpenIncognitoAgentDatabaseGeneration();
  const incognito = options.includeIncognito === false ? [] : listOpenIncognitoAgentDatabases();
  return withSessionHistoryWorkerReadCandidates(candidates, async (owner) => {
    const assertCurrent = () => {
      owner.assertCurrent();
      if (!isDeepStrictEqual(cfg, config)) {
        throw new Error("Session listing changed its configuration");
      }
      if (
        incognitoGeneration !== undefined &&
        incognitoGeneration !== readOpenIncognitoAgentDatabaseGeneration()
      ) {
        throw new Error("Session listing changed its incognito owner");
      }
      for (const candidate of candidates) {
        assertSessionStoreReadCandidate(candidate.path, candidates);
        const expected = identities.get(candidate.physicalPath);
        if (
          expected &&
          !isDeepStrictEqual(readDatabasePathIdentitySync(candidate.path), expected)
        ) {
          throw new Error("Session listing changed its captured physical owner");
        }
      }
    };
    const facts = await owner.readGatewayDiscovery({
      operation: "topology",
      config,
      candidates,
      env: inventory.env,
      discovery: { ...options.discovery, env: inventory.env },
      options: {
        agentId: options.agentId,
        configuredAgentsOnly: options.configuredAgentsOnly,
        preserveSentinelOwners: options.preserveSentinelOwners,
      },
    });
    assertCurrent();
    if (facts.operation !== "topology") {
      throw new Error("Session reader returned owner IDs instead of topology");
    }
    const discovery = {
      ...options.discovery,
      configuredDatabaseTargets: facts.configuredDatabaseTargets,
    };
    const readOptions = { ...options, discovery };
    const targets = admitGatewaySessionStoreTargets(cfg, readOptions, {
      ...facts.targets,
      incognitoTargets: incognito.filter(
        (target) =>
          !facts.targets.requestedAgentId || target.agentId === facts.targets.requestedAgentId,
      ),
    });
    const prepareScopes = async (agentIds: readonly string[]) => {
      assertCurrent();
      const scopeFacts = await owner.readGatewayDiscovery({
        operation: "scopes",
        config,
        env: inventory.env,
        candidates,
        discovery,
        agentIds,
      });
      assertCurrent();
      if (scopeFacts.operation !== "scopes") {
        throw new Error("Session reader returned topology instead of scopes");
      }
      return new Map<string, Error | ResolvedGatewaySessionStoreTargets>(
        [...scopeFacts.scopes].map(([key, result]) => {
          if (result instanceof Error) {
            return [key, result] as const;
          }
          try {
            return [
              key,
              admitGatewaySessionStoreTargets(
                cfg,
                {
                  discovery,
                  includeIncognito: false,
                  ...(key === "configured"
                    ? { configuredAgentsOnly: true }
                    : key.startsWith("agent:")
                      ? { agentId: key.slice(6) }
                      : {}),
                },
                result,
              ),
            ] as const;
          } catch (error) {
            return [key, error instanceof Error ? error : new Error(String(error))] as const;
          }
        }),
      );
    };
    return consume(
      prepareCombinedSessionStore(cfg, readOptions, targets),
      discovery,
      prepareScopes,
      assertCurrent,
    );
  });
}

/** Descriptive listings retain federation policy while durable rows are read by its worker. */
export async function loadCombinedSessionStoreForGatewayCoreAsync(
  cfg: OpenClawConfig,
  opts: GatewaySessionStoreOptions = {},
  prepareEntries?: () => Promise<void>,
): Promise<GatewayCombinedSessionStore> {
  const ambientStateDir = resolveStateDir(process.env);
  const topology = opts.includeIncognito === false ? undefined : captureIncognitoSessionTopology();
  const env = cloneEnvWithPlatformSemantics(opts.discovery?.env ?? topology?.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  if (topology && env.OPENCLAW_STATE_DIR !== resolveStateDir(topology.env)) {
    throw new Error("Combined discovery belongs to another incognito state root");
  }
  const options = { ...opts, ...(opts.discovery && { discovery: { ...opts.discovery, env } }) };
  const inventory = prepareSessionStoreTargetInventory(
    cfg,
    listConfiguredSessionStoreAgentIds(cfg),
    env,
    "recovery",
  );
  inventory.candidates = captureDiscoveryCandidates(inventory.candidates, options.discovery);
  const identities = captureSessionStoreCandidateIdentities(inventory.candidates);
  for (const candidate of inventory.candidates) {
    const identity = identities.get(candidate.physicalPath);
    if (identity && !candidate.scope) {
      identities.set(candidate.path, identity);
    }
  }
  const captured = {
    env,
    ambientStateDir,
    inventory,
    identities,
    discovery: options.discovery
      ? undefined
      : prepareAgentDatabaseDeletionSnapshotRead({ env }, "runtime"),
  };
  const result = topology
    ? withIncognitoSessionStoreEntries(
        (stores) => loadCombinedSessionStore(cfg, options, captured, stores, prepareEntries),
        options.projection ?? "list",
      )
    : loadCombinedSessionStore(cfg, options, captured, undefined, prepareEntries);
  return result.then((value) => {
    if (resolveStateDir(process.env) !== ambientStateDir) {
      throw new Error("Session stores changed while preparing the listing. Retry the request.");
    }
    return value;
  });
}

/** Descriptive listings retain federation policy while durable rows are read by its worker. */
async function loadCombinedSessionStore(
  cfg: OpenClawConfig,
  options: GatewaySessionStoreOptions,
  captured: {
    env: NodeJS.ProcessEnv;
    ambientStateDir: string;
    inventory: ReturnType<typeof prepareSessionStoreTargetInventory>;
    identities: ReturnType<typeof captureSessionStoreCandidateIdentities>;
    discovery: ReturnType<typeof prepareAgentDatabaseDeletionSnapshotRead> | undefined;
  },
  incognitoStores?: readonly {
    agentId: string;
    storePath: string;
    entries: SessionEntrySummary[];
  }[],
  prepareEntries?: () => Promise<void>,
): Promise<GatewayCombinedSessionStore> {
  const { env, ambientStateDir, inventory, identities } = captured;
  const read = async (
    config: OpenClawConfig,
    readOptions: typeof options,
    capturedIdentities: ReturnType<typeof captureSessionStoreCandidateIdentities>,
  ): Promise<GatewayCombinedSessionStore> => {
    if (!readOptions.discovery) {
      throw new Error("Session listing requires its captured discovery facts");
    }
    return withPreparedGatewaySessionTopology(
      config,
      {
        ...readOptions,
        discovery: readOptions.discovery,
        ...(incognitoStores && { includeIncognito: false }),
      },
      async (prepared, discovery, _scopes, assertTopologyCurrent) => {
        if (incognitoStores) {
          prepared.targets = {
            ...prepared.targets,
            incognitoTargets: incognitoStores.filter(
              (store) =>
                !prepared.targets.requestedAgentId ||
                store.agentId === prepared.targets.requestedAgentId,
            ),
          };
        }
        const identities = prepared.reads.map(
          ({ storeTarget }) =>
            capturedIdentities.get(storeTarget.storePath) ??
            readDatabasePathIdentitySync(storeTarget.storePath),
        );
        // Preparation can refresh registry discovery; retain its resulting topology generation.
        const registryToken = readOpenClawAgentDatabaseRegistryToken();
        const incognitoGeneration = readOpenIncognitoAgentDatabaseGeneration();
        // Windows environment proxies cannot cross the worker boundary.
        const transferEnv = { ...env, OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR };
        return await withSessionHistoryWorkerDatabases(
          prepared.reads.map(({ storeTarget }) => ({
            agentId: storeTarget.agentId,
            path: storeTarget.storePath,
            env,
          })),
          async (owners) => {
            const captureRoots = () =>
              prepared.reads.map(({ storeTarget }, index) =>
                retainSessionLineageReadSource(
                  { agentId: storeTarget.agentId, path: storeTarget.storePath },
                  undefined,
                  () => owners[index]!.assertCurrent(),
                ),
              );
            const rootReads = readOptions.loadEntries ? [] : captureRoots();
            try {
              const entries = new Map<string, SessionEntrySummary[]>();
              for (const [index, { storeTarget }] of prepared.reads.entries()) {
                if (readOptions.loadEntries) {
                  continue;
                }
                const owner = expectDefined(owners[index], "retained session store");
                const rows = await owner.readEntries(
                  {
                    ...storeTarget,
                    env: transferEnv,
                    projection: prepared.projection,
                    clone: false,
                  },
                  undefined,
                  identities[index],
                );
                rootReads.forEach((source) => source.assertCurrent());
                entries.set(storeTargetKey(storeTarget), rows);
              }
              if (prepareEntries) {
                await prepareEntries();
              }
              if (readOptions.loadEntries) {
                rootReads.push(...captureRoots());
                for (const { storeTarget } of prepared.reads) {
                  entries.set(
                    storeTargetKey(storeTarget),
                    readOptions.loadEntries(storeTarget, prepared.projection),
                  );
                }
              }
              const readEntries = (
                target: Parameters<NonNullable<GatewaySessionStoreOptions["loadEntries"]>>[0],
              ) => expectDefined(entries.get(storeTargetKey(target)), "prepared session entries");
              const roots = prepared.reads.flatMap(({ target, storeTarget }) =>
                readEntries(storeTarget).map(({ sessionKey, entry }) => ({
                  sessionKey,
                  entry,
                  agentId:
                    parseAgentSessionKey(sessionKey)?.agentId ??
                    (prepared.targets.sharedStoreRowOwner?.target.storePath === target.storePath &&
                    prepared.targets.sharedStoreRowOwner.target.agentId === target.agentId
                      ? prepared.targets.sharedStoreRowOwner.agentId
                      : target.agentId),
                })),
              );
              for (const store of incognitoStores ?? []) {
                roots.push(
                  ...store.entries.map(({ sessionKey, entry }) => ({
                    sessionKey,
                    entry,
                    agentId: parseAgentSessionKey(sessionKey)?.agentId ?? store.agentId,
                  })),
                );
              }
              return await withCombinedSessionLineage(
                config,
                env,
                roots,
                prepared.targets.preparedAgentIds,
                prepared.targets.requestedAgentId,
                (lineage) => {
                  rootReads.forEach((source) => source.assertCurrent());
                  for (const [index, owner] of owners.entries()) {
                    owner.assertCurrent();
                    if (
                      !isDeepStrictEqual(
                        readDatabasePathIdentitySync(prepared.reads[index]!.storeTarget.storePath),
                        identities[index],
                      )
                    ) {
                      throw new Error("Session listing changed its captured physical owner");
                    }
                  }
                  assertTopologyCurrent();
                  if (
                    resolveStateDir(process.env) !== ambientStateDir ||
                    registryToken !== readOpenClawAgentDatabaseRegistryToken() ||
                    (!incognitoStores &&
                      incognitoGeneration !== readOpenIncognitoAgentDatabaseGeneration())
                  ) {
                    throw new Error(
                      "Session stores changed while preparing the listing. Retry the request.",
                    );
                  }
                  // The merger rechecks admission while the outer reader retains incognito custody.
                  return mergeCombinedSessionStore(
                    config,
                    { ...readOptions, discovery },
                    prepared,
                    readEntries,
                    lineage,
                    incognitoStores &&
                      ((target) =>
                        expectDefined(
                          incognitoStores.find((store) => store.storePath === target.storePath),
                          "captured actor",
                        ).entries),
                  );
                },
              );
            } finally {
              rootReads.forEach((source) => source.release());
            }
          },
        );
      },
      inventory,
      capturedIdentities,
    );
  };
  if (!options.discovery) {
    const discovery = expectDefined(captured.discovery, "captured deletion discovery");
    return withSessionHistoryWorkerReadCandidates(inventory.candidates, async (owner) => {
      const assertCaptured = () => {
        owner.assertCurrent();
        for (const candidate of inventory.candidates) {
          if (
            captureSessionStoreReadCandidate(candidate.path, candidate.scope).physicalPath !==
            candidate.physicalPath
          ) {
            throw new Error(
              `Session database target changed outside captured discovery custody: ${candidate.path}`,
            );
          }
          assertSessionStoreReadCandidate(candidate.path, inventory.candidates);
          const identity = identities.get(candidate.physicalPath);
          if (
            identity &&
            !isDeepStrictEqual(readDatabasePathIdentitySync(candidate.path), identity)
          ) {
            throw new Error("Session listing changed its captured physical owner");
          }
        }
      };
      const result = await discovery.withCurrentSnapshot((snapshot) => {
        assertCaptured();
        return read(inventory.config, { ...options, discovery: { env, snapshot } }, identities);
      });
      assertCaptured();
      return result;
    });
  }

  return read(cfg, options, identities);
}

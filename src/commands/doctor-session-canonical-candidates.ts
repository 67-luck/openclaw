import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { SessionStoreMigrationRequiredError } from "../config/sessions/migration-required.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  readCanonicalSessionRepairInventory,
  loadCanonicalSessionRepairEntries,
  type CanonicalSessionRepairFact,
  type CanonicalSessionRepairInventory,
  type SessionEntryLifecycleRemoval,
} from "../config/sessions/session-accessor.js";
import { preserveCreationStamp } from "../config/sessions/session-entry-provenance.js";
import { mergeRetainedHistoryReferences } from "../config/sessions/session-retained-history.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "../config/sessions/store-entry.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveSessionStoreAgentId,
  resolveStoredSessionKeyForAgentStore,
} from "../gateway/session-store-key.js";
import {
  projectExistingAgentDatabaseTargets,
  resolveTargetSqlitePath,
  type ExistingAgentDatabaseTarget,
} from "../infra/session-sqlite-migration-readers.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { applyCanonicalOwnerEvidence } from "./doctor-session-canonical-owner-evidence.js";

export type CanonicalSessionCandidate = {
  agentId: string;
  canonicalKey: string;
  entry: SessionEntry;
  expectedEntry: SessionEntry;
  ownerEvidenceOnly: boolean;
  sessionKey: string;
  sqlitePath: string;
  storePath: string;
} & (
  | { rawEntryJson: string; rawSnapshotRevision: number }
  | { rawEntryJson?: never; rawSnapshotRevision?: never }
);

export type CanonicalSessionCandidateFact = Omit<
  CanonicalSessionCandidate,
  "entry" | "expectedEntry" | "rawEntryJson" | "rawSnapshotRevision"
> & {
  inventoryFact: CanonicalSessionRepairFact;
  lineageRepairRequired: boolean;
  normalizedForkSourceSessionKey?: string;
  normalizedParentSessionKey?: string;
  normalizedSpawnedBy?: string;
};

type CanonicalSessionRepairGroup = {
  candidates: CanonicalSessionCandidateFact[];
  removedRows: number;
};

type CanonicalSessionStoreInventory = {
  target: ExistingAgentDatabaseTarget;
  inventory: CanonicalSessionRepairInventory;
};

export function listCanonicalSessionStores(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ExistingAgentDatabaseTarget[] {
  return projectExistingAgentDatabaseTargets(
    resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env }),
    params.env,
    params.cfg,
  );
}

function collectCanonicalSessionCandidateFacts(
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
  inventories: readonly CanonicalSessionStoreInventory[],
): CanonicalSessionCandidateFact[] {
  const defaultAgentRemoved = !listAgentIds(params.cfg).includes(DEFAULT_AGENT_ID);
  const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
  const resolveStoredKey = (agentId: string, sessionKey: string) => {
    const parsed = parseAgentSessionKey(sessionKey);
    const rest = normalizeLowercaseStringOrEmpty(parsed?.rest);
    const repairLegacyMainHead =
      defaultAgentRemoved &&
      parsed?.agentId === DEFAULT_AGENT_ID &&
      normalizeAgentId(agentId) !== DEFAULT_AGENT_ID &&
      (rest === "main" || rest === mainKey);
    return resolveStoredSessionKeyForAgentStore({
      cfg: params.cfg,
      agentId,
      sessionKey,
      // Only Doctor moves a removed default-agent head into its recorded store owner.
      preserveQualifiedAddress: !repairLegacyMainHead,
    });
  };
  const facts = inventories.flatMap(({ target, inventory }) =>
    inventory.facts.map((inventoryFact) => {
      const { canonicalOwnerSessionKey, sessionKey } = inventoryFact;
      const storedKey = resolveStoredKey(target.agentId, sessionKey);
      return {
        canonicalKey: storedKey
          ? resolveDeliveryProvenCanonicalSessionKey(storedKey, inventoryFact)
          : resolveAgentMainSessionKey({ cfg: params.cfg, agentId: target.agentId }),
        canonicalOwnerSessionKey,
        inventoryFact,
        sessionKey,
        storedKey,
        target,
      };
    }),
  );
  const canonicalKeysByStoredKey = applyCanonicalOwnerEvidence(facts);
  return facts.map(
    ({ canonicalKey, canonicalOwnerSessionKey, inventoryFact, sessionKey, target }) => {
      const canonicalAgentId =
        canonicalKey === "global" || canonicalKey === "unknown"
          ? target.agentId
          : resolveSessionStoreAgentId(params.cfg, canonicalKey);
      const canonicalizeLineageKey = (value: string | undefined) => {
        if (!value) {
          return undefined;
        }
        const storedKey = resolveStoredKey(canonicalAgentId, value);
        const ownerAgentId = parseAgentSessionKey(storedKey)?.agentId ?? canonicalAgentId;
        for (const sqlitePath of [target.sqlitePath, "*"]) {
          for (const key of [value, storedKey]) {
            const mapped = canonicalKeysByStoredKey.get(`${sqlitePath}\0${ownerAgentId}\0${key}`);
            if (mapped?.size === 1) {
              return [...mapped][0];
            }
          }
        }
        return storedKey;
      };
      const parentSessionKey = canonicalizeLineageKey(inventoryFact.parentSessionKey);
      const spawnedBy = canonicalizeLineageKey(inventoryFact.spawnedBy);
      const forkSourceSessionKey = canonicalizeLineageKey(inventoryFact.forkSourceSessionKey);
      if (inventoryFact.forkSourceSessionKey !== undefined && !forkSourceSessionKey) {
        throw new SessionStoreMigrationRequiredError(
          `Cannot repair forkSource.sessionKey for ${sessionKey}: the stored source key is empty after normalization. Restore a verified source session key, then rerun openclaw doctor --fix; the original fork provenance has been preserved.`,
        );
      }
      return Object.assign(
        {
          agentId: target.agentId,
          canonicalKey,
          inventoryFact,
          lineageRepairRequired:
            parentSessionKey !== inventoryFact.parentSessionKey ||
            spawnedBy !== inventoryFact.spawnedBy ||
            forkSourceSessionKey !== inventoryFact.forkSourceSessionKey,
          ownerEvidenceOnly: canonicalOwnerSessionKey !== undefined,
          sessionKey,
          sqlitePath: target.sqlitePath,
          storePath: target.storePath,
        },
        forkSourceSessionKey ? { normalizedForkSourceSessionKey: forkSourceSessionKey } : {},
        parentSessionKey ? { normalizedParentSessionKey: parentSessionKey } : {},
        spawnedBy ? { normalizedSpawnedBy: spawnedBy } : {},
      );
    },
  );
}

export function resolveCanonicalSessionDestination(params: {
  canonicalKey: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  sourceAgentId?: string;
}) {
  const agentId =
    params.canonicalKey === "global" || params.canonicalKey === "unknown"
      ? normalizeAgentId(
          params.sourceAgentId ?? resolveSessionStoreAgentId(params.cfg, params.canonicalKey),
        )
      : resolveSessionStoreAgentId(params.cfg, params.canonicalKey);
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId,
    env: params.env,
  });
  return {
    agentId,
    storePath,
    sqlitePath: resolveTargetSqlitePath({ agentId, storePath }),
  };
}

function groupRepairCandidates(
  candidates: readonly CanonicalSessionCandidateFact[],
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
): CanonicalSessionRepairGroup[] {
  const byCanonicalKey = new Map<string, CanonicalSessionCandidateFact[]>();
  for (const candidate of candidates) {
    const sentinelOwner =
      candidate.canonicalKey === "global" || candidate.canonicalKey === "unknown"
        ? candidate.agentId
        : "";
    const groupKey = `${candidate.canonicalKey}\0${sentinelOwner}`;
    const group = byCanonicalKey.get(groupKey) ?? [];
    group.push(candidate);
    byCanonicalKey.set(groupKey, group);
  }
  return [...byCanonicalKey.values()].flatMap((group) => {
    const first = group[0]!;
    const destination = resolveCanonicalSessionDestination({
      canonicalKey: first.canonicalKey,
      cfg: params.cfg,
      env: params.env,
      sourceAgentId: first.agentId,
    });
    const repairRequired =
      group.length > 1 ||
      group.some(
        (candidate) =>
          candidate.inventoryFact.rawCompareRequired ||
          candidate.lineageRepairRequired ||
          candidate.sessionKey !== candidate.canonicalKey ||
          candidate.sqlitePath !== destination.sqlitePath,
      );
    if (!repairRequired) {
      return [];
    }
    const canonicalRowSurvives = group.some(
      (candidate) =>
        candidate.sqlitePath === destination.sqlitePath &&
        candidate.sessionKey === candidate.canonicalKey,
    );
    return [{ candidates: group, removedRows: group.length - (canonicalRowSurvives ? 1 : 0) }];
  });
}

export function collectCanonicalSessionRepairs(
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
  stores: readonly ExistingAgentDatabaseTarget[],
): { groups: CanonicalSessionRepairGroup[]; inventories: CanonicalSessionStoreInventory[] } {
  const inventories = stores.map((target) => ({
    target,
    inventory: readCanonicalSessionRepairInventory({
      agentId: target.agentId,
      storePath: target.storePath,
      env: params.env,
    }),
  }));
  return {
    groups: groupRepairCandidates(
      collectCanonicalSessionCandidateFacts(params, inventories),
      params,
    ),
    inventories,
  };
}

function mergeCanonicalSessionEntryCandidates<T>(
  candidates: readonly { entry: SessionEntry; preferred?: boolean; value: T }[],
): { entry: SessionEntry; winner: T } | undefined {
  let selected: { entry: SessionEntry; preferred: boolean; winner: T } | undefined;
  for (const candidate of candidates) {
    const incomingUpdatedAt =
      typeof candidate.entry.updatedAt === "number" && Number.isFinite(candidate.entry.updatedAt)
        ? candidate.entry.updatedAt
        : 0;
    const selectedUpdatedAt =
      typeof selected?.entry.updatedAt === "number" && Number.isFinite(selected.entry.updatedAt)
        ? selected.entry.updatedAt
        : 0;
    if (
      !selected ||
      incomingUpdatedAt > selectedUpdatedAt ||
      (incomingUpdatedAt === selectedUpdatedAt &&
        (candidate.preferred === true
          ? !selected.preferred
          : !selected.preferred &&
            Buffer.compare(
              Buffer.from(JSON.stringify(candidate.entry), "utf8"),
              Buffer.from(JSON.stringify(selected.entry), "utf8"),
            ) > 0))
    ) {
      selected = {
        entry: structuredClone(candidate.entry),
        preferred: candidate.preferred === true,
        winner: candidate.value,
      };
    }
  }
  return selected;
}

export function selectCanonicalSessionCandidate(
  candidates: readonly CanonicalSessionCandidate[],
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
) {
  const first = candidates[0];
  if (!first) {
    return undefined;
  }
  const destination = resolveCanonicalSessionDestination({
    canonicalKey: first.canonicalKey,
    cfg: params.cfg,
    env: params.env,
    sourceAgentId: first.agentId,
  });
  const rankedCandidates = candidates
    .toSorted((left, right) =>
      Buffer.compare(
        Buffer.from(`${left.sqlitePath}\0${left.sessionKey}`, "utf8"),
        Buffer.from(`${right.sqlitePath}\0${right.sessionKey}`, "utf8"),
      ),
    )
    .map((candidate) => ({
      entry: candidate.entry,
      preferred:
        candidate.sqlitePath === destination.sqlitePath &&
        candidate.sessionKey === candidate.canonicalKey,
      value: candidate,
    }));
  const metadataCandidates = rankedCandidates.filter(({ value }) => !value.ownerEvidenceOnly);
  const selected = mergeCanonicalSessionEntryCandidates(
    metadataCandidates.length > 0 ? metadataCandidates : rankedCandidates,
  );
  if (!selected) {
    return undefined;
  }
  // Metadata follows recency, but an existing canonical isolation identity wins
  // even over a newer required alias. Otherwise retain the newest required alias.
  const requiredCandidates = rankedCandidates.filter(({ entry }) => entry.sandbox === "required");
  const authoritativeStamp =
    requiredCandidates.find(({ preferred }) => preferred)?.entry ??
    mergeCanonicalSessionEntryCandidates(requiredCandidates)?.entry;
  const entry = preserveCreationStamp(selected.entry, authoritativeStamp);
  if (candidates.every((candidate) => candidate.sqlitePath === destination.sqlitePath)) {
    entry.retainedHistoryReferences = mergeRetainedHistoryReferences(
      candidates.map((candidate) => candidate.entry.retainedHistoryReferences),
    );
  }
  return {
    ...selected,
    entry,
    destination,
  };
}

function hydrateCanonicalSessionCandidate(
  fact: CanonicalSessionCandidateFact,
  loaded: ReturnType<typeof loadCanonicalSessionRepairEntries>[number],
): CanonicalSessionCandidate {
  const entry = { ...loaded.entry };
  if (fact.normalizedParentSessionKey) {
    entry.parentSessionKey = fact.normalizedParentSessionKey;
  } else {
    delete entry.parentSessionKey;
  }
  if (fact.normalizedSpawnedBy) {
    entry.spawnedBy = fact.normalizedSpawnedBy;
  } else {
    delete entry.spawnedBy;
  }
  if (entry.forkSource && fact.normalizedForkSourceSessionKey) {
    entry.forkSource = {
      ...entry.forkSource,
      sessionKey: fact.normalizedForkSourceSessionKey,
    };
  }
  const candidate = {
    agentId: fact.agentId,
    canonicalKey: fact.canonicalKey,
    entry,
    expectedEntry: loaded.entry,
    ownerEvidenceOnly: fact.ownerEvidenceOnly,
    sessionKey: fact.sessionKey,
    sqlitePath: fact.sqlitePath,
    storePath: fact.storePath,
  };
  return loaded.rawEntryJson !== undefined
    ? {
        ...candidate,
        rawEntryJson: loaded.rawEntryJson,
        rawSnapshotRevision: loaded.rawSnapshotRevision,
      }
    : candidate;
}

export function hydrateCanonicalSessionCandidates(
  facts: readonly CanonicalSessionCandidateFact[],
): CanonicalSessionCandidate[] {
  const loaded = new Map<
    CanonicalSessionCandidateFact,
    ReturnType<typeof loadCanonicalSessionRepairEntries>[number]
  >();
  const byStore = new Map<string, CanonicalSessionCandidateFact[]>();
  for (const fact of facts) {
    const key = `${fact.agentId}\0${fact.storePath}`;
    byStore.set(key, [...(byStore.get(key) ?? []), fact]);
  }
  for (const group of byStore.values()) {
    const first = group[0]!;
    const entries = loadCanonicalSessionRepairEntries(
      { agentId: first.agentId, storePath: first.storePath },
      group.map((fact) => fact.inventoryFact),
    );
    group.forEach((fact, index) => loaded.set(fact, entries[index]!));
  }
  return facts.map((fact) => hydrateCanonicalSessionCandidate(fact, loaded.get(fact)!));
}

export type SingleDatabaseCanonicalRepairGroup = {
  candidates: readonly CanonicalSessionCandidate[];
  selected: NonNullable<ReturnType<typeof selectCanonicalSessionCandidate>>;
};

export function resolveSingleDatabaseCanonicalRepairGroup(
  candidates: readonly CanonicalSessionCandidate[],
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
): SingleDatabaseCanonicalRepairGroup | undefined {
  const selected = selectCanonicalSessionCandidate(candidates, params);
  if (
    !selected ||
    selected.winner.sqlitePath !== selected.destination.sqlitePath ||
    candidates.some((candidate) => candidate.sqlitePath !== selected.destination.sqlitePath)
  ) {
    return undefined;
  }
  return { candidates, selected };
}

export function createCanonicalRepairRemoval(
  candidate: CanonicalSessionCandidate,
  params: {
    archiveRemovedTranscript: boolean;
    deleteOwnedWindows: boolean;
    deliveryCleanupKeys?: readonly string[];
  },
): SessionEntryLifecycleRemoval {
  const removal = {
    archiveRemovedTranscript: params.archiveRemovedTranscript,
    deleteOwnedWindows: params.deleteOwnedWindows,
    ...(params.deliveryCleanupKeys ? { deliveryCleanupKeys: params.deliveryCleanupKeys } : {}),
    exactStoredKey: true,
    expectedEntry: candidate.expectedEntry,
    sessionKey: candidate.sessionKey,
  } satisfies SessionEntryLifecycleRemoval;
  return candidate.rawEntryJson === undefined
    ? removal
    : Object.assign(removal, {
        expectedRawEntryJson: candidate.rawEntryJson,
        expectedSnapshotRevision: candidate.rawSnapshotRevision,
      });
}

export function createCanonicalDestinationRemovals(
  candidates: readonly CanonicalSessionCandidate[],
  selected: NonNullable<ReturnType<typeof selectCanonicalSessionCandidate>>,
): SessionEntryLifecycleRemoval[] {
  const relatedSessionIds = new Set(
    [selected.entry.sessionId, selected.entry.previousSessionId].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  return candidates
    .filter(
      (candidate) =>
        candidate.sessionKey !== selected.winner.canonicalKey ||
        candidate.rawEntryJson !== undefined,
    )
    .map((candidate) =>
      createCanonicalRepairRemoval(candidate, {
        archiveRemovedTranscript: !relatedSessionIds.has(candidate.entry.sessionId),
        deleteOwnedWindows: false,
      }),
    );
}

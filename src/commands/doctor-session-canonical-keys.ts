import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { note } from "../../packages/terminal-core/src/note.js";
import { SessionStoreMigrationRequiredError } from "../config/sessions/migration-required.js";
import { resolveSessionArtifactDirectory } from "../config/sessions/paths.js";
import {
  applySessionEntryLifecycleMutation,
  copySessionOwnedStateForCanonicalRepair,
  ensureTranscriptGenerationsForCanonicalRepair,
  listSessionGenerationIdsForCanonicalRepair,
  loadCanonicalSessionRepairEntries,
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
  rehomeSessionDeliveryReferencesForCanonicalRepair,
  rehomeSessionDeliveryReferencesForCanonicalRepairBatch,
} from "../config/sessions/session-accessor.js";
import { writeTranscriptArchive } from "../config/sessions/session-accessor.sqlite-archive-artifact.js";
import { loadCanonicalRepairEntriesFromDatabase } from "../config/sessions/session-accessor.sqlite-canonical-inventory.js";
import {
  readSqliteSessionGenerationClaim,
  readSqliteSessionGenerationWindows,
} from "../config/sessions/session-accessor.sqlite-generation-copy.js";
import type { SqliteSessionGenerationClaim } from "../config/sessions/session-accessor.sqlite-generation.types.js";
import {
  copySessionNodeArtifactsForRepair,
  deleteSessionMembersForRepair,
} from "../config/sessions/session-accessor.sqlite-node-artifacts.js";
import { replaceSessionOwnerInTransaction } from "../config/sessions/session-accessor.sqlite-owner.js";
import { collectSessionStateIdsForEntry } from "../config/sessions/session-accessor.sqlite-references.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptArchiveDirectory,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { setCanonicalSqliteSessionMainKey } from "../config/sessions/session-canonical-key.js";
import {
  assertRetainedHistoryArtifactTransfer,
  mergeRetainedHistoryReferences,
} from "../config/sessions/session-retained-history.js";
import { serializeJsonlLines } from "../config/sessions/transcript-jsonl.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { iterateSqliteQuerySync, sqliteStringSet } from "../infra/kysely-sync.js";
import { resolveTargetSqliteOptions } from "../infra/session-sqlite-migration-readers.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { ensureSessionEntryValidityProjection } from "../state/openclaw-agent-db-session-migrations.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { backupDoctorSqliteDatabases } from "./doctor-migration-backup.js";
import {
  collectCanonicalSessionRepairs,
  createCanonicalDestinationRemovals,
  createCanonicalRepairRemoval,
  hydrateCanonicalSessionCandidates,
  listCanonicalSessionStores,
  resolveCanonicalSessionDestination,
  resolveSingleDatabaseCanonicalRepairGroup,
  selectCanonicalSessionCandidate,
  type CanonicalSessionCandidate,
  type SingleDatabaseCanonicalRepairGroup,
} from "./doctor-session-canonical-candidates.js";
import {
  resolveDoctorSessionSqliteMaintenancePaths,
  resolveDoctorSessionSqliteMaintenanceRoots,
} from "./doctor-session-sqlite-targets.js";
import {
  assertDoctorSqliteMaintenancePathsNotAliased,
  withDoctorSqliteMaintenanceLock,
  type DoctorSqliteMaintenanceAuthority,
} from "./doctor-sqlite-maintenance-lock.js";

export type CanonicalSessionKeyRepairReport = {
  archivedTranscriptDirectories: string[];
  foundGroups: number;
  repairBatches: number;
  removedRows: number;
  repairedGroups: number;
  scannedStores: number;
};

const CANONICAL_SESSION_REPAIR_BATCH_GROUP_LIMIT = 64;

function assertCanonicalHistoryCustody(
  candidates: readonly CanonicalSessionCandidate[],
  selected: NonNullable<ReturnType<typeof selectCanonicalSessionCandidate>>,
  env: NodeJS.ProcessEnv,
  destinationCommitted = false,
): void {
  const { winner, destination } = selected;
  if (candidates.every((candidate) => candidate.sqlitePath === destination.sqlitePath)) {
    return;
  }
  for (const candidate of candidates) {
    if (candidate.sqlitePath !== destination.sqlitePath) {
      assertRetainedHistoryArtifactTransfer(
        candidate.entry.retainedHistoryReferences,
        resolveSessionArtifactDirectory(candidate.storePath),
        resolveSessionArtifactDirectory(destination.storePath),
      );
    }
  }
  const references = mergeRetainedHistoryReferences(
    candidates.map((candidate) => candidate.entry.retainedHistoryReferences),
  );
  if (
    destinationCommitted &&
    references &&
    (references.sessionIds.length > 0 || references.artifactPaths.length > 0)
  ) {
    const committed = loadExactSessionEntryReadOnly({
      agentId: destination.agentId,
      env,
      sessionKey: winner.canonicalKey,
      storePath: destination.storePath,
    })?.entry;
    if (
      committed?.sessionId !== selected.entry.sessionId ||
      committed.lifecycleRevision !== selected.entry.lifecycleRevision ||
      references.sessionIds.some(
        (id) => !committed.retainedHistoryReferences?.sessionIds.includes(id),
      ) ||
      references.artifactPaths.some(
        (artifact) => !committed.retainedHistoryReferences?.artifactPaths.includes(artifact),
      )
    ) {
      throw new SessionStoreMigrationRequiredError(
        `The destination owner for ${winner.canonicalKey} no longer protects its migrated history. Preserve the source owners and rerun Doctor after resolving the concurrent session change.`,
      );
    }
  }
  const ids = references?.sessionIds ?? [];
  if (ids.length === 0) {
    selected.entry.retainedHistoryReferences = references;
    return;
  }
  const stores = new Map<string, Map<string, SqliteSessionGenerationClaim | null>>();
  const inspect = (store: { agentId: string; storePath: string; sqlitePath: string }) => {
    const cached = stores.get(store.sqlitePath);
    if (cached) {
      return cached;
    }
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => {
        const claims = new Map<string, SqliteSessionGenerationClaim | null>(
          readSqliteSessionGenerationWindows(database, [], ids).map((window) => [
            window.session_id,
            readSqliteSessionGenerationClaim(database, window),
          ]),
        );
        for (const row of iterateSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .selectFrom("transcript_events")
            .select("session_id")
            .where("session_id", "in", sqliteStringSet(ids))
            .groupBy("session_id"),
        )) {
          if (!claims.has(row.session_id)) {
            claims.set(row.session_id, null);
          }
        }
        return claims;
      },
      resolveTargetSqliteOptions(store, env),
    );
    if (
      !result.found &&
      (result.reason !== "database-missing" ||
        candidates.some((candidate) => candidate.sqlitePath === store.sqlitePath))
    ) {
      throw new SessionStoreMigrationRequiredError(
        `Cannot verify retained history in ${store.sqlitePath}: ${result.reason}; preserve the store and repair its admission before moving sessions.`,
      );
    }
    const claims = result.found
      ? result.value
      : new Map<string, SqliteSessionGenerationClaim | null>();
    stores.set(store.sqlitePath, claims);
    return claims;
  };
  const destinationClaims = inspect(destination);
  const winnerClaims = inspect(winner);
  const copiedIds = new Set([
    ...collectSessionStateIdsForEntry(winner.entry),
    ...[...winnerClaims.values()].flatMap((claim) =>
      claim?.window.session_key === winner.sessionKey ? [claim.window.session_id] : [],
    ),
  ]);
  for (const candidate of candidates) {
    const sourceClaims = inspect(candidate);
    for (const id of candidate.entry.retainedHistoryReferences?.sessionIds ?? []) {
      if (!sourceClaims.has(id)) {
        continue;
      }
      const source = sourceClaims.get(id);
      const retained =
        !destinationCommitted && winner.sqlitePath !== destination.sqlitePath && copiedIds.has(id)
          ? winnerClaims.get(id)
          : destinationClaims.get(id);
      if (!source || !retained || source.contentFingerprint !== retained.contentFingerprint) {
        throw new SessionStoreMigrationRequiredError(
          `Protected transcript ${id} in ${candidate.sqlitePath} would not retain its exact content when moving ${candidate.sessionKey} to ${destination.sqlitePath}. Preserve both stores and reconcile this history before retrying Doctor; the original owners remain required.`,
        );
      }
    }
  }
  selected.entry.retainedHistoryReferences = references;
}

function listCanonicalDestinationAliasKeys(
  destinationStore: readonly CanonicalSessionCandidate[],
  winner: CanonicalSessionCandidate,
): string[] {
  return destinationStore
    .map((candidate) => candidate.sessionKey)
    .filter((sessionKey) => sessionKey !== winner.canonicalKey);
}

function applyCanonicalDestinationArtifacts(params: {
  copyWinnerAlias: boolean;
  database: OpenClawAgentDatabase;
  destinationStore: readonly CanonicalSessionCandidate[];
  rehomeDeliveries: boolean;
  winner: CanonicalSessionCandidate;
}): void {
  replaceSessionOwnerInTransaction(
    params.database,
    params.winner.canonicalKey,
    params.winner.entry.owner,
  );
  const destinationAliasKeys = listCanonicalDestinationAliasKeys(
    params.destinationStore,
    params.winner,
  );
  if (destinationAliasKeys.length > 0) {
    if (params.rehomeDeliveries) {
      rehomeSessionDeliveryReferencesForCanonicalRepair(
        params.database,
        params.winner.canonicalKey,
        destinationAliasKeys,
      );
    }
    copySessionNodeArtifactsForRepair(
      params.database,
      params.database,
      destinationAliasKeys,
      params.winner.canonicalKey,
      { includeMembers: false },
    );
  }
  if (!params.copyWinnerAlias || params.winner.sessionKey === params.winner.canonicalKey) {
    return;
  }
  deleteSessionMembersForRepair(params.database, params.winner.canonicalKey);
  copySessionNodeArtifactsForRepair(
    params.database,
    params.database,
    [params.winner.sessionKey],
    params.winner.canonicalKey,
    { includeParticipants: false },
  );
}

async function repairCanonicalSessionGroupsInSingleDatabase(
  groups: readonly SingleDatabaseCanonicalRepairGroup[],
): Promise<string[]> {
  const first = groups[0];
  if (!first) {
    return [];
  }
  await ensureTranscriptGenerationsForCanonicalRepair(groups.flatMap((group) => group.candidates));
  const destination = first.selected.destination;
  const result = await applySessionEntryLifecycleMutation({
    agentId: destination.agentId,
    allowCanonicalRepair: true,
    afterUpsertsInTransaction: (database) => {
      rehomeSessionDeliveryReferencesForCanonicalRepairBatch(
        database,
        groups.map((group) => ({
          canonicalKey: group.selected.winner.canonicalKey,
          previousKeys: listCanonicalDestinationAliasKeys(group.candidates, group.selected.winner),
        })),
      );
      for (const group of groups) {
        applyCanonicalDestinationArtifacts({
          copyWinnerAlias: true,
          database,
          destinationStore: group.candidates,
          rehomeDeliveries: false,
          winner: group.selected.winner,
        });
      }
    },
    removals: groups.flatMap((group) =>
      createCanonicalDestinationRemovals(group.candidates, group.selected),
    ),
    skipMaintenance: true,
    storePath: destination.storePath,
    upserts: groups.map((group) => ({
      entry: group.selected.entry,
      sessionKey: group.selected.winner.canonicalKey,
    })),
  });
  return result.archivedTranscriptDirectories;
}

async function repairCanonicalSessionGroup(
  candidates: readonly CanonicalSessionCandidate[],
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
): Promise<string[]> {
  const selected = selectCanonicalSessionCandidate(candidates, params);
  if (!selected) {
    return [];
  }
  assertCanonicalHistoryCustody(candidates, selected, params.env);
  await ensureTranscriptGenerationsForCanonicalRepair(candidates);
  const winner = selected.winner;
  const destination = selected.destination;
  const byDatabase = new Map<string, CanonicalSessionCandidate[]>();
  for (const candidate of candidates) {
    const group = byDatabase.get(candidate.sqlitePath) ?? [];
    group.push(candidate);
    byDatabase.set(candidate.sqlitePath, group);
  }

  const destinationStore = byDatabase.get(destination.sqlitePath) ?? [];
  const preArchivedDirectories: string[] = [];
  if (winner.sqlitePath !== destination.sqlitePath) {
    const generationIds = new Set([
      ...listSessionGenerationIdsForCanonicalRepair({
        agentId: winner.agentId,
        canonicalKey: winner.canonicalKey,
        sourceKeys: [winner.sessionKey],
        storePath: winner.storePath,
      }),
      ...collectSessionStateIdsForEntry(winner.entry),
    ]);
    for (const sessionId of generationIds) {
      if (!sessionId) {
        continue;
      }
      const destinationCollision = destinationStore.find(
        (candidate) => candidate.entry.sessionId === sessionId,
      );
      const [destinationEvents, sourceEvents] = await Promise.all([
        loadTranscriptEvents({
          agentId: destinationCollision?.agentId ?? destination.agentId,
          sessionId,
          sessionKey: destinationCollision?.sessionKey ?? winner.canonicalKey,
          storePath: destinationCollision?.storePath ?? destination.storePath,
        }),
        loadTranscriptEvents({
          agentId: winner.agentId,
          sessionId,
          sessionKey: winner.sessionKey,
          storePath: winner.storePath,
        }),
      ]);
      const destinationContent = serializeJsonlLines(
        destinationEvents.map((event) => JSON.stringify(event)),
      );
      const sourceContent = serializeJsonlLines(sourceEvents.map((event) => JSON.stringify(event)));
      if (!destinationContent || destinationContent === sourceContent) {
        continue;
      }
      const archiveDirectory = resolveSqliteTranscriptArchiveDirectory({
        agentId: destination.agentId,
        env: params.env,
        path: destination.sqlitePath,
      });
      writeTranscriptArchive({
        archiveDirectory,
        content: destinationContent,
        reason: "deleted",
        sessionId,
      });
      if (!preArchivedDirectories.includes(archiveDirectory)) {
        preArchivedDirectories.push(archiveDirectory);
      }
    }
  }
  assertCanonicalHistoryCustody(candidates, selected, params.env);
  setCanonicalSqliteSessionMainKey(
    openOpenClawAgentDatabase(resolveTargetSqliteOptions(destination, params.env)),
    params.cfg.session?.mainKey,
  );
  const winnerResult = await applySessionEntryLifecycleMutation({
    agentId: destination.agentId,
    allowCanonicalRepair: true,
    beforeCommitInTransaction: () =>
      assertCanonicalHistoryCustody(candidates, selected, params.env),
    afterUpsertsInTransaction: (destinationDatabase) => {
      applyCanonicalDestinationArtifacts({
        copyWinnerAlias: winner.sqlitePath === destination.sqlitePath,
        database: destinationDatabase,
        destinationStore,
        rehomeDeliveries: true,
        winner,
      });
      if (winner.sqlitePath !== destination.sqlitePath) {
        copySessionOwnedStateForCanonicalRepair({
          canonicalKey: winner.canonicalKey,
          destinationDatabase,
          preferredEntry: selected.entry,
          preferredSessionKey: winner.sessionKey,
          source: winner,
          sourceEntries: [winner.entry],
          sourceKeys: [winner.sessionKey],
        });
      }
    },
    removals: createCanonicalDestinationRemovals(destinationStore, selected),
    skipMaintenance: true,
    storePath: destination.storePath,
    upserts: [{ entry: selected.entry, sessionKey: winner.canonicalKey }],
  });
  const archivedDirectories = new Set([
    ...preArchivedDirectories,
    ...winnerResult.archivedTranscriptDirectories,
  ]);

  for (const [sqlitePath, storeCandidates] of byDatabase) {
    if (sqlitePath === destination.sqlitePath) {
      continue;
    }
    const storeCandidate = storeCandidates[0]!;
    const result = await applySessionEntryLifecycleMutation({
      agentId: storeCandidate.agentId,
      allowCanonicalRepair: true,
      beforeCommitInTransaction: () =>
        assertCanonicalHistoryCustody(candidates, selected, params.env, true),
      removals: storeCandidates.map((candidate) =>
        createCanonicalRepairRemoval(candidate, {
          archiveRemovedTranscript: true,
          deleteOwnedWindows: true,
          deliveryCleanupKeys: [winner.canonicalKey],
        }),
      ),
      skipMaintenance: true,
      storePath: storeCandidate.storePath,
    });
    // Only the selected winner is copied. Stale loser data survives solely in its
    // verified archive, avoiding an ambiguous cross-store merge contract.
    for (const directory of result.archivedTranscriptDirectories) {
      archivedDirectories.add(directory);
    }
  }
  return [...archivedDirectories];
}

/** Doctor-owned durable repair; process-held incognito databases are intentionally excluded. */
export async function repairCanonicalSessionKeys(params: {
  apply: boolean;
  authority?: DoctorSqliteMaintenanceAuthority;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<CanonicalSessionKeyRepairReport> {
  const env = params.env ?? process.env;
  const stores = listCanonicalSessionStores({
    cfg: params.cfg,
    env,
  });
  const archivedTranscriptDirectories = new Set<string>();
  let repairBatches = 0;
  let repairedGroups = 0;
  const repairs = collectCanonicalSessionRepairs({ cfg: params.cfg, env }, stores);
  let repairGroups = repairs.groups;
  const mutationTargets = [...stores];
  if (params.apply) {
    for (const group of repairGroups) {
      const first = group.candidates[0]!;
      const destination = resolveCanonicalSessionDestination({
        canonicalKey: first.canonicalKey,
        cfg: params.cfg,
        env,
        sourceAgentId: first.agentId,
      });
      mutationTargets.push(destination);
      if (group.candidates.every((candidate) => candidate.sqlitePath === destination.sqlitePath)) {
        continue;
      }
      const candidates = hydrateCanonicalSessionCandidates(group.candidates);
      const selected = selectCanonicalSessionCandidate(candidates, { cfg: params.cfg, env });
      if (selected) {
        assertCanonicalHistoryCustody(candidates, selected, env);
      }
    }
  }
  const assertPaths = () =>
    assertDoctorSqliteMaintenancePathsNotAliased(
      "canonical session-key repair",
      resolveDoctorSessionSqliteMaintenancePaths(mutationTargets),
      resolveDoctorSessionSqliteMaintenanceRoots(mutationTargets, env),
    );
  if (params.apply) {
    assertPaths();
  }
  const pendingPaths = new Set([
    ...repairGroups.flatMap((group) => group.candidates.map((candidate) => candidate.sqlitePath)),
    ...repairs.inventories
      .filter(({ inventory }) => inventory.pendingAdmission)
      .map(({ target }) => target.sqlitePath),
  ]);
  if (params.apply && pendingPaths.size > 0 && !params.authority) {
    return await withDoctorSqliteMaintenanceLock({
      env,
      operation: "canonical session-key repair",
      run: (authority) => repairCanonicalSessionKeys({ ...params, env, authority }),
    });
  }
  const identities = params.apply
    ? repairs.inventories.map(({ target, inventory }) => ({
        target,
        identity: readDatabasePathIdentitySync(target.sqlitePath),
        pendingAdmission: inventory.pendingAdmission,
      }))
    : [];
  const assertCurrent = () => {
    params.authority?.assertCurrent();
    assertPaths();
    for (const { target, identity } of identities) {
      assertExistingDatabaseIdentity(target.sqlitePath, identity.key, identity.birthtime);
    }
  };
  if (params.apply && pendingPaths.size > 0) {
    assertCurrent();
    const inventoriesByPath = new Map(
      repairs.inventories.map(({ target, inventory }) => [
        fs.realpathSync(target.sqlitePath),
        inventory,
      ]),
    );
    const backup = await backupDoctorSqliteDatabases({
      env,
      pendingDatabasePaths: [...pendingPaths],
      databasePaths: stores.map((target) => target.sqlitePath),
      authority: { assertCurrent },
      repair: {
        key: `canonical-session-keys-${randomUUID()}`,
        validate: (database, sourcePath) => {
          const expected = inventoriesByPath.get(sourcePath);
          if (expected) {
            loadCanonicalRepairEntriesFromDatabase({ db: database }, [], expected.inventoryToken);
          }
        },
      },
    });
    assertCurrent();
    // Revalidate the backed-up inventory before admission changes derived entry validity.
    for (const store of stores) {
      const expected = inventoriesByPath.get(fs.realpathSync(store.sqlitePath));
      if (expected) {
        loadCanonicalSessionRepairEntries(
          { agentId: store.agentId, storePath: store.storePath, env },
          [],
          expected.inventoryToken,
        );
      }
    }
    note(
      [...backup.changes, ...backup.warnings].map((message) => `- ${message}`).join("\n"),
      "Session SQLite backups",
    );
  }
  if (params.apply) {
    for (const { target, identity, pendingAdmission } of identities) {
      const options = resolveTargetSqliteOptions(target, env);
      // Cached handles still need the admission owner's pending validity repair.
      const database = pendingAdmission
        ? runOpenClawAgentWriteTransaction(
            (admittedDatabase) => {
              assertCurrent();
              ensureSessionEntryValidityProjection(admittedDatabase.db);
              return admittedDatabase;
            },
            options,
            {
              operationLabel: "doctor.canonical-session-validity",
              repairAdmission: { assertCurrent, expectedIdentity: identity },
            },
          )
        : openOpenClawAgentDatabase(options);
      setCanonicalSqliteSessionMainKey(database, params.cfg.session?.mainKey);
    }
    // Admission settles pending validity; hydrate only its committed inventory.
    const admitted = collectCanonicalSessionRepairs({ cfg: params.cfg, env }, stores);
    if (
      admitted.inventories.some(({ inventory }) => inventory.pendingAdmission) ||
      (admitted.groups.length > 0 && (!params.authority || pendingPaths.size === 0))
    ) {
      throw new Error("Canonical session repair inputs changed during admission; rerun Doctor");
    }
    repairGroups = admitted.groups;
  }
  const foundGroups = repairGroups.length;
  const removedRows = repairGroups.reduce((total, group) => total + group.removedRows, 0);
  if (params.apply) {
    while (repairGroups.length > 0) {
      const candidateGroups = repairGroups.slice(0, CANONICAL_SESSION_REPAIR_BATCH_GROUP_LIMIT);
      const hydrated = hydrateCanonicalSessionCandidates(
        candidateGroups.flatMap((candidateGroup) => candidateGroup.candidates),
      );
      let hydratedOffset = 0;
      const hydratedGroups = candidateGroups.map((candidateGroup) => {
        const candidates = hydrated.slice(
          hydratedOffset,
          hydratedOffset + candidateGroup.candidates.length,
        );
        hydratedOffset += candidateGroup.candidates.length;
        return candidates;
      });
      const candidates = hydratedGroups[0]!;
      const singleDatabaseGroup = resolveSingleDatabaseCanonicalRepairGroup(candidates, {
        cfg: params.cfg,
        env,
      });
      if (!singleDatabaseGroup) {
        for (const directory of await repairCanonicalSessionGroup(candidates, {
          cfg: params.cfg,
          env,
        })) {
          archivedTranscriptDirectories.add(directory);
        }
        repairBatches += 1;
        repairedGroups += 1;
        repairGroups = collectCanonicalSessionRepairs({ cfg: params.cfg, env }, stores).groups;
        continue;
      }
      const batch = [singleDatabaseGroup];
      // Keep commits bounded and preserve the original order around cross-store moves, while
      // collapsing the repeated whole-store projections for the common same-database path.
      for (const nextCandidates of hydratedGroups.slice(1)) {
        const nextSingleDatabaseGroup = resolveSingleDatabaseCanonicalRepairGroup(nextCandidates, {
          cfg: params.cfg,
          env,
        });
        if (
          !nextSingleDatabaseGroup ||
          nextSingleDatabaseGroup.selected.destination.sqlitePath !==
            singleDatabaseGroup.selected.destination.sqlitePath
        ) {
          break;
        }
        batch.push(nextSingleDatabaseGroup);
      }
      for (const directory of await repairCanonicalSessionGroupsInSingleDatabase(batch)) {
        archivedTranscriptDirectories.add(directory);
      }
      repairBatches += 1;
      repairedGroups += batch.length;
      repairGroups = collectCanonicalSessionRepairs({ cfg: params.cfg, env }, stores).groups;
    }
  }
  return {
    archivedTranscriptDirectories: [...archivedTranscriptDirectories].toSorted(),
    foundGroups,
    repairBatches,
    removedRows,
    repairedGroups,
    scannedStores: stores.length,
  };
}

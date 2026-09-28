// Storage-neutral session registry maintenance for cron run cleanup.
import fs from "node:fs";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  applySessionEntryLifecycleMutation,
  type SessionEntryLifecycleRemoval,
} from "./session-accessor.js";
import { withSessionRegistryEntriesInWorker } from "./session-entry-read-runtime.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { collectActiveSessionWorkAdmissionKeys } from "./store-maintenance-preserve.js";
import { pruneStaleEntries } from "./store-maintenance.js";
import type { SessionStoreTarget } from "./targets.js";
import type { SessionEntry } from "./types.js";

type SessionRegistryMaintenanceStoreSummary = {
  afterCount: number;
  beforeCount: number;
  preservedRunning: number;
  pruned: number;
};

type SessionRegistryMaintenanceStoreOptions = SessionStoreTarget & {
  /** Apply pruning to the backing store; false only previews the owned read result. */
  apply: boolean;
  /** Retention window for cron-run session entries. */
  retentionMs: number;
  /** Currently running cron job ids, normalized to lowercase. */
  runningCronJobIds: ReadonlySet<string>;
  assertCurrent?: () => void;
};

function parseCronRunSessionJobId(sessionKey: string): string | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return undefined;
  }
  return /^cron:([^:]+):run:[^:]+(?:$|:)/u.exec(parsed.rest)?.[1];
}

function buildSessionRegistryPreserveKeys(params: {
  runningCronJobIds: ReadonlySet<string>;
  storePath: string;
  store: Record<string, SessionEntry>;
}): { preserveKeys: Set<string>; preservedRunning: number } {
  const preserveKeys =
    collectActiveSessionWorkAdmissionKeys({
      storePath: params.storePath,
      store: params.store,
    }) ?? new Set<string>();
  let preservedRunning = 0;
  for (const key of Object.keys(params.store)) {
    const jobId = parseCronRunSessionJobId(key);
    if (!jobId) {
      // This sweep owns only cron-run rows; all ordinary sessions are preserved.
      preserveKeys.add(key);
      continue;
    }
    if (params.runningCronJobIds.has(jobId)) {
      preserveKeys.add(key);
      preservedRunning += 1;
    }
  }
  return { preserveKeys, preservedRunning };
}

function pruneSessionRegistryStore(params: {
  retentionMs: number;
  removals?: SessionEntryLifecycleRemoval[];
  runningCronJobIds: ReadonlySet<string>;
  storePath: string;
  store: Record<string, SessionEntry>;
}): Omit<SessionRegistryMaintenanceStoreSummary, "beforeCount"> {
  const { preserveKeys, preservedRunning } = buildSessionRegistryPreserveKeys({
    runningCronJobIds: params.runningCronJobIds,
    storePath: params.storePath,
    store: params.store,
  });
  const pruned = pruneStaleEntries(params.store, params.retentionMs, {
    log: false,
    onPruned: params.removals
      ? ({ key, entry }) => {
          params.removals?.push({
            sessionKey: key,
            expectedEntry: entry,
            archiveRemovedTranscript: true,
          });
        }
      : undefined,
    preserveKeys,
  });
  return {
    afterCount: Object.keys(params.store).length,
    preservedRunning,
    pruned,
  };
}

/**
 * Runs session-registry maintenance for one resolved agent store.
 * Preview prunes the owned worker result; apply uses one store-sized write transaction and
 * skips generic session maintenance so non-cron rows stay outside this sweep.
 */
export async function runSessionRegistryMaintenanceForStore(
  params: SessionRegistryMaintenanceStoreOptions,
): Promise<SessionRegistryMaintenanceStoreSummary> {
  params.assertCurrent?.();
  const { agentId, storePath } = params;
  const sqliteTarget = resolveSqliteTargetFromSessionStorePath(storePath, { agentId });
  if (sqliteTarget.path && !fs.existsSync(sqliteTarget.path)) {
    return {
      beforeCount: 0,
      afterCount: 0,
      preservedRunning: 0,
      pruned: 0,
    };
  }
  return await withSessionRegistryEntriesInWorker(
    { agentId, storePath },
    async (entries, assertReaderCurrent) => {
      const assertCurrent = () => {
        params.assertCurrent?.();
        assertReaderCurrent();
      };
      assertCurrent();
      // Worker transport already isolates these entries from the reader's state.
      const store = Object.fromEntries(entries.map(({ sessionKey, entry }) => [sessionKey, entry]));
      const beforeCount = Object.keys(store).length;
      const removals: SessionEntryLifecycleRemoval[] | undefined = params.apply ? [] : undefined;
      const applied = pruneSessionRegistryStore({
        retentionMs: params.retentionMs,
        removals,
        runningCronJobIds: params.runningCronJobIds,
        storePath,
        store,
      });
      if (removals && removals.length > 0) {
        const mutation = await applySessionEntryLifecycleMutation({
          agentId,
          storePath,
          removals,
          skipMaintenance: true,
          beforeCommitInTransaction: assertCurrent,
        });
        assertCurrent();
        return {
          afterCount: mutation.afterCount,
          beforeCount,
          preservedRunning: applied.preservedRunning,
          pruned: mutation.removedEntries,
        };
      }
      return {
        beforeCount,
        ...applied,
      };
    },
  );
}

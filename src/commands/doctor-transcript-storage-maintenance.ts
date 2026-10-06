import { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/host/sqlite-vec.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  enableNodeSqliteKyselyStatementCache,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import { configureSqliteMaintenanceCache } from "../infra/sqlite-maintenance-cache.js";
import { resolveSqliteInspectionSignal } from "../infra/sqlite-readonly-worker.js";
import { configureSqliteConnectionPragmas } from "../infra/sqlite-wal.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { assertAgentDatabaseMaintenanceAuthority } from "../state/openclaw-agent-db-lease.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { assertOpenClawAgentDatabaseForMaintenance } from "../state/openclaw-agent-db-maintenance.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  migrateDoctorTranscriptStorage,
  readDoctorTranscriptStoragePhase,
} from "./doctor-transcript-storage.js";

type TranscriptStorageTarget = { agentId: string; path: string; realPath?: string };

/** Schema-25 retries still finish their ledger before Doctor returns startup permission. */
export async function migrateDoctorTranscriptStorageDatabases(params: {
  env: NodeJS.ProcessEnv;
  targets: readonly TranscriptStorageTarget[];
  log: (message: string) => void;
}): Promise<void> {
  if (params.targets.length === 0) {
    return;
  }
  const owner = getOpenClawDatabaseMaintenanceScope();
  if (!owner?.ownsSchemaMaintenance) {
    throw new Error("Transcript storage migration requires Doctor maintenance ownership");
  }
  const sharedPath = resolveOpenClawStateSqlitePath(params.env);
  await withAgentDatabaseMaintenanceLease(
    { env: params.env, processBound: true },
    async (maintenance) => {
      const signal = resolveSqliteInspectionSignal(maintenance.signal) ?? maintenance.signal;
      const visited = new Set<string>();
      for (const target of params.targets) {
        owner.assertDatabaseAccess(sharedPath);
        const identity = readDatabasePathIdentitySync(target.path);
        if (visited.has(identity.key)) {
          continue;
        }
        visited.add(identity.key);
        const assertCurrent = () => {
          signal.throwIfAborted();
          owner.assertAdmission();
          // Shared-state custody and the live agent lease protect different database owners.
          owner.assertDatabaseAccess(sharedPath);
          assertAgentDatabaseMaintenanceAuthority(maintenance);
          assertExistingDatabaseIdentity(target.path, identity.key, identity.birthtime);
        };
        assertCurrent();
        const database = openNodeSqliteDatabase(resolveExistingSqliteFileUri(target.path), {
          allowExtension: true,
        });
        let wal: ReturnType<typeof configureSqliteConnectionPragmas> | undefined;
        try {
          await loadSqliteVecExtension({ db: database });
          assertCurrent();
          assertOpenClawAgentDatabaseForMaintenance(database, {
            agentId: target.agentId,
            pathname: target.path,
          });
          if (readDoctorTranscriptStoragePhase(database) === "complete") {
            continue;
          }
          configureSqliteMaintenanceCache(database);
          enableNodeSqliteKyselyStatementCache(database);
          wal = configureSqliteConnectionPragmas(database, {
            busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
            databaseLabel: `doctor-agent:${target.agentId}`,
            databasePath: target.path,
            foreignKeys: true,
            synchronous: "NORMAL",
            checkpointIntervalMs: 0,
          });
          params.log(`Migrating transcript metadata while writers are stopped: ${target.path}`);
          let reportedAt = 0;
          await migrateDoctorTranscriptStorage(database, {
            signal,
            assertCurrent,
            onProgress(progress) {
              if (
                progress.phase !== progress.result.phase ||
                progress.elapsedMs - reportedAt >= 10_000
              ) {
                params.log(
                  `Transcript metadata ${target.agentId}: ${progress.result.phase}, ${progress.batches} batches, ${Math.round(progress.elapsedMs)} ms elapsed.`,
                );
                reportedAt = progress.elapsedMs;
              }
            },
          });
        } finally {
          try {
            await wal?.stop();
          } finally {
            wal?.close();
            clearNodeSqliteKyselyCacheForDatabase(database);
            database.close();
          }
        }
      }
    },
  );
}

/** Recovery may restart a compatible Gateway only after the offline migration owner finishes. */
export function assertDoctorTranscriptStorageComplete(
  targets: readonly TranscriptStorageTarget[],
): void {
  for (const target of targets) {
    const database = openNodeSqliteDatabase(target.path, {
      readOnly: true,
    });
    try {
      const phase = readDoctorTranscriptStoragePhase(database);
      if (phase !== "complete") {
        throw new DoctorMaintenanceRefusalError(
          `Transcript metadata migration is pending (${phase}) for ${target.path}. Keep writers stopped and rerun openclaw doctor --fix with this build to resume.`,
          { kind: "data-at-risk", reason: "incomplete-migration" },
        );
      }
    } finally {
      database.close();
    }
  }
}

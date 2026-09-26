import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { drainAgentDatabaseResources } from "../state/openclaw-agent-db-resources.js";
import { acquireOpenClawStateDatabaseFileExclusion } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { pinDirectory, requireDirectorySync, sha256File } from "./directory-durability.js";
import { hasErrnoCode } from "./errno.js";
import { sameFileIdentity, type FileIdentityStat } from "./fs-safe-advanced.js";
import { root } from "./fs-safe.js";
import { assertLegacyGatewayStoppedForMaintenance } from "./gateway-lock-legacy.js";
import { publishVerifiedSqliteFile } from "./sqlite-snapshot.js";
import {
  acquireGatewayMaintenanceCoordinator,
  acquireStateDatabaseCoordinator,
  acquireStateDatabaseHandleExclusion,
} from "./state-database-coordinator.js";
import type { UpdateDatabaseBackup } from "./update-database-backup.js";
import type { UpdateDatabaseGenerations } from "./update-database-generations.js";
import { readUpdateDatabaseGenerationsIsolated } from "./update-database-inspection.js";
import { createUpdateDatabaseAbsenceCustody } from "./update-database-restore-absence.js";
import { acquireUpdateDatabaseRestoreCustody } from "./update-database-restore-custody.js";
import { createUpdateDatabasePublishedCustody } from "./update-database-restore-published.js";

async function existingFile(file: string) {
  try {
    const info = await fs.lstat(file, { bigint: true });
    if (!info.isFile() || info.nlink !== 1n) {
      throw new Error(`Database recovery requires a regular, unaliased file: ${file}`);
    }
    return info;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function withDatabaseExclusion<T>(
  shared: string,
  env: NodeJS.ProcessEnv,
  paths: string[],
  sourcePaths: string[],
  assertCurrent: () => void,
  operation: (assertOwned: () => void) => Promise<T>,
): Promise<T> {
  using owners = new DisposableStack();
  const retain = (owner: { release: () => void }) => owners.defer(() => owner.release());
  const exclusions: Array<{ assertCurrent: () => void }> = [];
  const assertOwned = () => {
    assertCurrent();
    for (const exclusion of exclusions) {
      exclusion.assertCurrent();
    }
  };
  assertCurrent();
  // These coordinators live outside the replaced databases. Keep every owner
  // and local admission seal until the complete family, including the ledger, is restored.
  retain(
    acquireGatewayMaintenanceCoordinator({
      databasePath: shared,
      busyTimeoutMs: 0,
      excludeGateway: true,
    }),
  );
  await assertLegacyGatewayStoppedForMaintenance(env);
  assertOwned();
  const canonicalShared = resolvePathViaExistingAncestorSync(shared);
  for (const databasePath of paths) {
    retain(acquireStateDatabaseCoordinator({ databasePath, busyTimeoutMs: 0 }));
  }
  const acquire = async (index: number): Promise<T> => {
    const databasePath = paths[index];
    if (databasePath === undefined) {
      return operation(assertOwned);
    }
    if (databasePath === canonicalShared) {
      const exclusion = await acquireOpenClawStateDatabaseFileExclusion(shared);
      retain(exclusion);
      exclusions.push(exclusion);
      assertOwned();
      return acquire(index + 1);
    }
    const exclusion = acquireStateDatabaseHandleExclusion({ databasePath, busyTimeoutMs: 0 });
    retain(exclusion);
    exclusions.push(exclusion);
    return acquire(index + 1);
  };
  const drain = async (index: number): Promise<T> => {
    const pathname = sourcePaths[index];
    if (pathname === undefined) {
      return acquire(0);
    }
    // Local handles retain lexical ownership even when discovery canonicalizes a directory link.
    return drainAgentDatabaseResources({ path: pathname }, async () => {
      await closeOpenClawAgentDatabaseByPathAsync(pathname);
      assertOwned();
      return drain(index + 1);
    });
  };
  return await drain(0);
}

/** The caller owns a settled failed candidate that has never been allowed to serve. */
export async function restoreUpdateDatabaseBackup(params: {
  backup: UpdateDatabaseBackup;
  runId: string;
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
  expectedGenerations?: UpdateDatabaseGenerations;
}): Promise<string[] | null> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(params.runId)) {
    throw new Error("Database rollback requires its original update run identity.");
  }
  const { backup, assertCurrent } = params;
  const shared = resolveOpenClawStateSqlitePath(params.env);
  const paths = [
    ...new Set([...backup.databases.map((entry) => entry.path), ...backup.missingPaths]),
  ].toSorted();
  const displaced: string[] = [];
  const missing = new Set(backup.missingPaths);
  // Keep absence owned through publication AND the awaited outer resource
  // drainage. Its final synchronous cleanup is the absence handback boundary.
  using absence = createUpdateDatabaseAbsenceCustody();
  // Dispose published handles first; absence is the final synchronous handback.
  using published = createUpdateDatabasePublishedCustody(params.env);
  return await withDatabaseExclusion(
    shared,
    params.env,
    paths,
    [...new Set([...backup.sourcePaths, ...paths])],
    assertCurrent,
    async (assertExclusion) => {
      const assertOwned = () => {
        assertExclusion();
        absence.assertCurrent();
        published.assertCurrent();
      };
      // Verify the entire backup before moving any live file. Publication verifies
      // these exact digests again, so a changed backup never authorizes replacement.
      for (const entry of backup.databases) {
        const source = await fs.open(entry.snapshotPath, "r");
        try {
          const content = await sha256File(source);
          if (content.digest !== entry.sha256 || content.bytes !== entry.sizeBytes) {
            throw new Error(`Database snapshot changed: ${entry.snapshotPath}`);
          }
        } finally {
          await source.close();
        }
        assertOwned();
      }
      using native = acquireUpdateDatabaseRestoreCustody(paths);
      // A raw close in this process would silently discard SQLite POSIX locks.
      // The existing isolated physical reader, not a final unlocked read, owns IO.
      if (
        params.expectedGenerations &&
        !isDeepStrictEqual(
          await readUpdateDatabaseGenerationsIsolated(paths, { env: params.env }),
          params.expectedGenerations,
        )
      ) {
        return null;
      }
      assertOwned();
      native.assertHeld();
      for (const pathname of missing) {
        if (!native.hasSource(pathname)) {
          await absence.reserve(pathname, assertOwned);
        }
      }
      native.settleJournal();
      const moves: Array<{
        source: string;
        target: string;
        identity: NonNullable<Awaited<ReturnType<typeof existingFile>>>;
      }> = [];
      for (const databasePath of paths) {
        // A creator-owned file at a missing ancestor certifies that neither
        // the source nor its recovery siblings can exist below that boundary.
        if (absence.has(databasePath) && absence.coversParent(databasePath)) {
          continue;
        }
        // Retire old sidecar names before freeing the main-file name for a new opener.
        for (const suffix of ["-wal", "-shm", "-journal", ""]) {
          const source = `${databasePath}${suffix}`;
          const target = `${databasePath}.migrated-${params.runId}${suffix}`;
          if (await existingFile(target)) {
            throw new Error(`Migrated database recovery file already exists: ${target}`);
          }
          // These names have creator-owned reservations, not unchecked absence.
          if (absence.has(databasePath)) {
            absence.assertCurrent();
            continue;
          }
          const identity = await existingFile(source);
          if (identity) {
            moves.push({ source, target, identity });
          }
        }
      }
      for (const move of moves) {
        assertOwned();
        // Root.move's native no-replace path opens only directory descriptors.
        // publishFileExclusive opens/closes the source inode and would unlock it.
        const directory = path.dirname(move.source);
        const pinnedDirectory = await pinDirectory(directory);
        await using directoryCleanup = new AsyncDisposableStack();
        directoryCleanup.defer(() => pinnedDirectory.close());
        const directoryRoot = await root(directory);
        await directoryRoot.move(path.basename(move.source), path.basename(move.target), {
          overwrite: false,
          assertBeforeMutation: () => {
            assertOwned();
            native.assertSource(move.source, move.identity);
          },
        });
        displaced.push(move.target);
        requireDirectorySync(await pinnedDirectory.sync(), "Migrated database recovery directory");
        const retained = await existingFile(move.target);
        if (!retained || !sameFileIdentity(retained, move.identity)) {
          throw new Error("Displaced database identity changed: " + move.target);
        }
        // A store created by the failed candidate must return to real absence.
        // If a raw creator wins this handover, exclusive reservation refuses;
        // neither the foreign file nor its retained predecessor is overwritten.
        if (missing.has(move.source)) {
          await absence.reserve(move.source, assertOwned);
        }
        assertOwned();
      }
      // Every native connection has settled BEFORE any replacement is published.
      // A failed close leaves recovery pending, never a replacement pretending success.
      native.release();
      for (const entry of backup.databases) {
        assertOwned();
        const sourceIdentity = await fs.lstat(entry.snapshotPath);
        published.assertDistinctSource(sourceIdentity);
        let publishedIdentity: FileIdentityStat | undefined;
        await publishVerifiedSqliteFile({
          sourcePath: entry.snapshotPath,
          sourceIdentity,
          targetPath: entry.path,
          expectedContent: { sha256: entry.sha256, sizeBytes: entry.sizeBytes },
          requireAtomicPublication: true,
          beforePublish: assertOwned,
          afterPublish: (guard) =>
            guard.assertTargetMatchesExpectedContent(() => {
              assertOwned();
              publishedIdentity = fsSync.lstatSync(entry.path, { bigint: true });
            }),
        });
        if (!publishedIdentity) {
          throw new Error("Database publication omitted its identity");
        }
        await published.retain(entry, publishedIdentity, assertOwned);
        assertOwned();
      }
      return displaced;
    },
  );
}

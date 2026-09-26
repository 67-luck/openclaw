import { sameFileIdentity, type FileIdentityStat } from "./fs-safe-advanced.js";
import { throwSqliteLifecycleErrors } from "./sqlite-coordinator.js";
import type { UpdateDatabaseBackup } from "./update-database-backup.js";
import { readUpdateDatabasePostimagesIsolated } from "./update-database-inspection.js";
import { acquireUpdateDatabaseRestoreCustody } from "./update-database-restore-custody.js";

/** Completion custody is separate from old-source custody: publication owns raw
 * descriptors until it returns. Only then can SQLite's process locks survive.
 * The exact published identity and captured bytes are verified under that lock,
 * including commits in the publication-to-admission window. */
export function createUpdateDatabasePublishedCustody(env: NodeJS.ProcessEnv) {
  const owners = new DisposableStack();
  const verified: Array<{
    path: string;
    identity: FileIdentityStat;
    owner: ReturnType<typeof acquireUpdateDatabaseRestoreCustody>;
  }> = [];
  const assertCurrent = () => {
    for (const entry of verified) {
      entry.owner.assertSource(entry.path, entry.identity);
    }
  };
  return {
    assertCurrent,
    assertDistinctSource(identity: FileIdentityStat) {
      if (verified.some((entry) => sameFileIdentity(entry.identity, identity))) {
        throw new Error("Snapshot source aliases a held published database");
      }
    },
    async retain(
      entry: UpdateDatabaseBackup["databases"][number],
      identity: FileIdentityStat,
      assertAuthority: () => void,
    ) {
      assertAuthority();
      const owner = acquireUpdateDatabaseRestoreCustody([entry.path]);
      owners.defer(() => owner.release());
      owner.assertSource(entry.path, identity);
      const images = await readUpdateDatabasePostimagesIsolated([entry.path], { env });
      assertAuthority();
      owner.assertSource(entry.path, identity);
      const image = images[entry.path];
      if (
        !image ||
        image.sha256 !== entry.sha256 ||
        image.sizeBytes !== entry.sizeBytes ||
        image.sidecars
      ) {
        throw new Error("Published database changed before native handback custody: " + entry.path);
      }
      // Verified data only. Settle native journal bookkeeping without SQL data
      // changes, while EXCLUSIVE mode retains exclusion. This is the same close
      // safety owner used before displacement, now retained through handback.
      owner.settleJournal();
      owner.assertSource(entry.path, identity);
      verified.push({ path: entry.path, identity, owner });
    },
    [Symbol.dispose]() {
      const errors: unknown[] = [];
      try {
        assertCurrent();
      } catch (error) {
        errors.push(error);
      }
      try {
        owners.dispose();
      } catch (error) {
        errors.push(error);
      }
      throwSqliteLifecycleErrors(errors, "Published database handback settlement failed");
    },
  };
}

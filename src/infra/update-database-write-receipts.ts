import fs from "node:fs";
import path from "node:path";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import {
  runOutsideSqliteTransactionReceiptObserver,
  type SqliteTransactionReceiptObserver,
  type SqliteCreatedFileIdentity,
} from "./sqlite-transaction-receipt.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { readUpdateDatabaseImage, readUpdateDatabaseLeaseImage } from "./update-database-image.js";

export type UpdateDatabaseTransactionImage = {
  path: string;
  component?: "leases";
  order: bigint;
  before: string | null;
  after: string | null;
};
export type UpdateDatabaseTransactionEvidence = {
  verified: boolean;
  transactions: UpdateDatabaseTransactionImage[];
};

/** Scoped to admitted Doctor work, including its native cleanup. Observation
 * failures refuse rollback proof, not the actual repair or its original error. */
export function createUpdateDatabaseTransactionCollector(
  paths: readonly string[],
  component?: "leases",
  sequence = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT),
) {
  const clock = new BigInt64Array(sequence);
  const inventory = new Set(paths.map((pathname) => path.resolve(pathname)));
  const evidence: UpdateDatabaseTransactionEvidence = { verified: true, transactions: [] };
  const created = new Map<string, { identity: SqliteCreatedFileIdentity; image?: string }>();
  const readImage = component === "leases" ? readUpdateDatabaseLeaseImage : readUpdateDatabaseImage;
  const observe: SqliteTransactionReceiptObserver = (database) => {
    try {
      const location = database.location();
      if (!location) {
        return undefined;
      }
      const pathname = fs.realpathSync.native(location);
      if (!inventory.has(pathname)) {
        return undefined;
      }
      // BEGIN IMMEDIATE serializes this database. Stamp BEFORE its commit can
      // release the lock; async reply delivery cannot reorder native history.
      const order = Atomics.add(clock, 0, 1n);
      let before: string | null = readImage(database);
      const creation = created.get(pathname);
      if (creation) {
        const current = fs.lstatSync(pathname, { bigint: true });
        if (
          current.dev !== creation.identity.dev ||
          current.ino !== creation.identity.ino ||
          current.birthtimeNs !== creation.identity.birthtimeNs ||
          current.nlink !== 1n ||
          before !== creation.image
        ) {
          evidence.verified = false;
        } else {
          before = null;
        }
      }
      let after: string | null | undefined;
      return {
        beforeCommit() {
          try {
            after = readImage(database);
          } catch {
            evidence.verified = false;
          }
        },
        committed() {
          if (after !== undefined) {
            evidence.transactions.push({
              path: pathname,
              order,
              before,
              after,
              ...(component ? { component } : {}),
            });
            if (creation) {
              created.delete(pathname);
            }
          }
        },
      };
    } catch {
      evidence.verified = false;
      return undefined;
    }
  };
  observe.prepareOpen = (pathname, reserve) => {
    if (component || !pathname || pathname === ":memory:" || pathname.startsWith("file:")) {
      return;
    }
    try {
      const canonical = resolvePathViaExistingAncestorSync(pathname);
      if (!inventory.has(canonical)) {
        return;
      }
      const identity = reserve();
      if (identity) {
        created.set(canonical, { identity });
      }
    } catch {
      evidence.verified = false;
    }
  };
  observe.opened = (database) => {
    try {
      const location = database.location();
      if (!location) {
        return;
      }
      const pathname = fs.realpathSync.native(location);
      const creation = created.get(pathname);
      if (!creation || creation.image !== undefined) {
        return;
      }
      // Capture this runtime's actual initial metadata before caller PRAGMAs.
      // A foreign durable header before admission makes this creation unprovable.
      // The native transaction helper owns rollback/unsafe-connection cleanup.
      runOutsideSqliteTransactionReceiptObserver(() =>
        runSqliteImmediateTransactionSync(database, () => {
          const current = fs.lstatSync(pathname, { bigint: true });
          if (
            current.dev !== creation.identity.dev ||
            current.ino !== creation.identity.ino ||
            current.birthtimeNs !== creation.identity.birthtimeNs ||
            current.nlink !== 1n ||
            current.size !== 0n
          ) {
            throw new Error("Created database changed before initial metadata admission");
          }
          creation.image = readUpdateDatabaseImage(database);
        }),
      );
    } catch {
      evidence.verified = false;
    }
  };
  return { evidence, observe, sequence };
}

function imageParts(value: unknown): [string | null, string | null] | undefined {
  if (value === null) {
    return [null, null];
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parts = value.split(":");
  const data = parts[0];
  const leases = parts[1];
  return parts.length === 2 &&
    typeof data === "string" &&
    typeof leases === "string" &&
    /^[a-f0-9]{64}$/u.test(data) &&
    /^[a-f0-9]{64}$/u.test(leases)
    ? [data, leases]
    : undefined;
}

/** Every component must follow the actual native transaction order. A gap is
 * permanently unaccounted even if later Doctor writes recreate an earlier image.
 * Ordinals are observation only: SQLite locks and writer owners grant authority. */
export function areUpdateDatabaseImagesAccounted(
  before: string | null,
  after: string | null,
  transactions: readonly UpdateDatabaseTransactionImage[],
): boolean {
  let current = imageParts(before);
  const end = imageParts(after);
  if (
    !current ||
    !end ||
    transactions.some((entry) => typeof entry.order !== "bigint" || entry.order < 0n)
  ) {
    return false;
  }
  const ordered = transactions.toSorted((left, right) =>
    left.order < right.order ? -1 : left.order > right.order ? 1 : 0,
  );
  let previousOrder: bigint | undefined;
  for (const transaction of ordered) {
    if (transaction.order === previousOrder) {
      return false;
    }
    previousOrder = transaction.order;
    if (transaction.component === "leases") {
      if (
        typeof transaction.before !== "string" ||
        typeof transaction.after !== "string" ||
        !/^[a-f0-9]{64}$/u.test(transaction.after) ||
        current[1] !== transaction.before
      ) {
        return false;
      }
      current = [current[0], transaction.after];
    } else if (transaction.component === undefined) {
      const first = imageParts(transaction.before);
      const last = imageParts(transaction.after);
      if (!first || !last || current[0] !== first[0] || current[1] !== first[1]) {
        return false;
      }
      current = last;
    } else {
      return false;
    }
  }
  return current[0] === end[0] && current[1] === end[1];
}

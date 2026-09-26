import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { formatErrorMessage } from "./errors.js";
import { withSqliteTransactionReceiptObserver } from "./sqlite-transaction-receipt.js";
import type {
  UpdateDatabaseGenerations,
  UpdateDatabaseWriteReceipt,
} from "./update-database-generations.js";
import {
  areUpdateDatabaseImagesAccounted,
  createUpdateDatabaseTransactionCollector,
} from "./update-database-write-receipts.js";

/** The maintenance owner supplies admission and joins its writers. This observer
 * only advances rollback evidence for native, confirmed transaction pre/postimages. */
export function createUpdateDoctorDatabaseWriteCapture(
  input: UpdateDatabaseGenerations | undefined,
  options: {
    env: NodeJS.ProcessEnv;
    root?: string;
    signal: AbortSignal;
    assertCurrent?: () => void;
    warn: (message: string) => void;
  },
) {
  if (!input) {
    return undefined;
  }
  const paths = Object.keys(input);
  const collector = createUpdateDatabaseTransactionCollector(paths);
  let expected: UpdateDatabaseGenerations | undefined = { ...input };
  let expectedImages: UpdateDatabaseGenerations | undefined;
  let unchanged = true;
  let active = false;
  let receipt: UpdateDatabaseWriteReceipt | undefined;
  const read = async () => {
    if (!expected) {
      return undefined;
    }
    try {
      const { readUpdateDatabaseWriteInspectionIsolated } =
        await import("./update-database-inspection.js");
      const generations = await readUpdateDatabaseWriteInspectionIsolated(paths, options);
      options.assertCurrent?.();
      return generations;
    } catch (error) {
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      options.assertCurrent?.();
      expected = undefined;
      receipt = undefined;
      options.warn(
        "Database write verification is unavailable; automatic database restoration cannot be confirmed: " +
          formatErrorMessage(error),
      );
      return undefined;
    }
  };
  return {
    paths,
    sequence: collector.sequence,
    record(evidence: unknown) {
      if (!active) {
        unchanged = false;
        receipt = undefined;
      }
      if (
        !isRecord(evidence) ||
        typeof evidence.verified !== "boolean" ||
        !Array.isArray(evidence.transactions)
      ) {
        collector.evidence.verified = false;
        return;
      }
      collector.evidence.verified &&= evidence.verified;
      for (const transaction of evidence.transactions) {
        if (
          !isRecord(transaction) ||
          typeof transaction.path !== "string" ||
          typeof transaction.order !== "bigint" ||
          !(transaction.before === null || typeof transaction.before === "string") ||
          !(transaction.after === null || typeof transaction.after === "string") ||
          !(transaction.component === undefined || transaction.component === "leases")
        ) {
          collector.evidence.verified = false;
          continue;
        }
        collector.evidence.transactions.push({
          path: transaction.path,
          order: transaction.order,
          before: transaction.before,
          after: transaction.after,
          ...(transaction.component ? { component: transaction.component } : {}),
        });
      }
    },
    run<T>(operation: () => T): T {
      if (!active) {
        throw new Error("Doctor database write capture is not admitted");
      }
      return withSqliteTransactionReceiptObserver(collector.observe, operation);
    },
    get receipt() {
      return receipt;
    },
    async admit() {
      receipt = undefined;
      const inspection = await read();
      if (inspection && expected) {
        const previous = expected;
        unchanged &&= paths.every(
          (pathname) => inspection.generations[pathname] === previous[pathname],
        );
        expectedImages = inspection.images;
      }
      active = true;
    },
    async settle() {
      try {
        const inspection = await read();
        if (inspection && expectedImages) {
          const generations = inspection.generations;
          const images = inspection.images;
          const previous = expectedImages;
          unchanged &&=
            collector.evidence.verified &&
            paths.every((pathname) => {
              const before = previous[pathname];
              const after = images[pathname];
              return (
                before !== undefined &&
                after !== undefined &&
                areUpdateDatabaseImagesAccounted(
                  before,
                  after,
                  collector.evidence.transactions.filter(
                    (transaction) => transaction.path === pathname,
                  ),
                )
              );
            });
          receipt = { unchanged, generations };
          expected = generations;
          expectedImages = images;
          collector.evidence.transactions.length = 0;
        }
      } finally {
        active = false;
      }
    },
  };
}

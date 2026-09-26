import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withSqliteTransactionReceiptObserver } from "./sqlite-transaction-receipt.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { readUpdateDatabaseWriteInspection } from "./update-database-generations.js";
import {
  areUpdateDatabaseImagesAccounted,
  createUpdateDatabaseTransactionCollector,
} from "./update-database-write-receipts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function fixture() {
  const pathname = path.join(tempDirs.make("doctor-image-receipt-"), "db.sqlite");
  const seed = new DatabaseSync(pathname);
  seed.exec(
    "CREATE TABLE payload(value); INSERT INTO payload(rowid,value) VALUES (42,CAST(X'80' AS TEXT)), (77,9223372036854775807), (99,1.0000000000000002); CREATE TABLE keyed(a TEXT PRIMARY KEY,b BLOB) WITHOUT ROWID; INSERT INTO keyed VALUES ('a',X'0080')",
  );
  seed.exec(
    'CREATE VIRTUAL TABLE "USING external(" USING "fts5"(body); INSERT INTO "USING external("(body) VALUES (\'witness\');',
  );
  seed.close();
  return pathname;
}

it("captures exact images while the native transaction excludes a second SQLite writer", () => {
  const pathname = fixture();
  const before = readUpdateDatabaseWriteInspection([pathname]).images[pathname]!;
  const database = new DatabaseSync(pathname);
  const foreign = new DatabaseSync(pathname);
  const capture = createUpdateDatabaseTransactionCollector([pathname]);
  try {
    // Read inspection must have settled its transaction, not just closed a
    // connection with still-live prepared statements retaining native locks.
    database.exec("PRAGMA journal_mode=WAL");
    withSqliteTransactionReceiptObserver(capture.observe, () =>
      runSqliteImmediateTransactionSync(database, () => {
        expect(() => foreign.exec("INSERT INTO payload VALUES ('foreign')")).toThrow("locked");
        database.exec(
          "ALTER TABLE payload ADD COLUMN migrated TEXT; UPDATE payload SET migrated='doctor'; PRAGMA user_version=23",
        );
      }),
    );
  } finally {
    foreign.close();
    database.close();
  }
  const after = readUpdateDatabaseWriteInspection([pathname]).images[pathname]!;
  expect(capture.evidence).toEqual({
    verified: true,
    transactions: [{ path: pathname, order: 0n, before, after }],
  });
  expect(areUpdateDatabaseImagesAccounted(before, after, capture.evidence.transactions)).toBe(true);
});

it.each([
  "PRAGMA missing_image_setting",
  "SELECT 321 AS default_cache_size",
  "SELECT '321' AS cache_size",
])("refuses unknown persistent metadata evidence (%s)", (query) => {
  const pathname = fixture();
  const database = new DatabaseSync(pathname);
  const capture = createUpdateDatabaseTransactionCollector([pathname]);
  const prepare = database.prepare.bind(database);
  const unavailable = vi
    .spyOn(database, "prepare")
    .mockImplementation((sql) => prepare(sql === "PRAGMA main.default_cache_size" ? query : sql));
  try {
    withSqliteTransactionReceiptObserver(capture.observe, () =>
      runSqliteImmediateTransactionSync(database, () => database.exec("PRAGMA user_version=23")),
    );
    expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(23);
    expect(capture.evidence).toEqual({ verified: false, transactions: [] });
  } finally {
    unavailable.mockRestore();
    database.close();
  }
});

it("does not publish rolled-back or authority-refused transactions", () => {
  const pathname = fixture();
  const before = readUpdateDatabaseWriteInspection([pathname]).images[pathname]!;
  const database = new DatabaseSync(pathname);
  const capture = createUpdateDatabaseTransactionCollector([pathname]);
  try {
    expect(() =>
      withSqliteTransactionReceiptObserver(capture.observe, () =>
        runSqliteImmediateTransactionSync(database, () => database.exec("DELETE FROM payload"), {
          withCommit() {
            throw new Error("owner revoked");
          },
        }),
      ),
    ).toThrow("owner revoked");
  } finally {
    database.close();
  }
  expect(capture.evidence.transactions).toEqual([]);
  expect(readUpdateDatabaseWriteInspection([pathname]).images[pathname]).toBe(before);
});

it("retires inherited receipt observation when its accepted operation finishes", async () => {
  const pathname = fixture();
  const capture = createUpdateDatabaseTransactionCollector([pathname]);
  const gate = createDeferred();
  let delayed: Promise<void> | undefined;
  await withSqliteTransactionReceiptObserver(capture.observe, async () => {
    delayed = gate.promise.then(() => {
      const database = new DatabaseSync(pathname);
      try {
        runSqliteImmediateTransactionSync(database, () => database.exec("DELETE FROM payload"));
      } finally {
        database.close();
      }
    });
  });
  gate.resolve();
  await delayed;
  expect(capture.evidence.transactions).toEqual([]);
});

const image = (data: string, lease = "0") => data.repeat(64) + ":" + lease.repeat(64);
const histories: Array<{
  edges: Array<[bigint, string, string]>;
  start: string;
  end: string;
  valid: boolean;
}> = [
  {
    edges: [
      [2n, "b", "c"],
      [1n, "a", "b"],
    ],
    start: "a",
    end: "c",
    valid: true,
  },
  {
    edges: [
      [1n, "a", "b"],
      [2n, "b", "a"],
      [3n, "a", "c"],
    ],
    start: "a",
    end: "c",
    valid: true,
  },
  { edges: [[1n, "a", "a"]], start: "a", end: "a", valid: true },
  { edges: [[1n, "f", "c"]], start: "a", end: "c", valid: false },
  {
    edges: [
      [1n, "a", "b"],
      [2n, "a", "c"],
    ],
    start: "a",
    end: "c",
    valid: false,
  },
  {
    edges: [
      [1n, "a", "b"],
      [2n, "e", "e"],
    ],
    start: "a",
    end: "b",
    valid: false,
  },
  { edges: [[1n, "a", "b"]], start: "a", end: "f", valid: false },
  // Reordering these as 1,3,2 would hide a foreign gap. Actual native order wins.
  {
    edges: [
      [1n, "a", "b"],
      [2n, "c", "d"],
      [3n, "b", "c"],
    ],
    start: "a",
    end: "d",
    valid: false,
  },
  {
    edges: [
      [1n, "a", "b"],
      [1n, "b", "c"],
    ],
    start: "a",
    end: "c",
    valid: false,
  },
];
it.each(histories)("requires a complete native history: $edges", ({ edges, start, end, valid }) => {
  const receipts = edges.map(([order, before, after]) => ({
    path: "db",
    order,
    before: image(before),
    after: image(after),
  }));
  expect(areUpdateDatabaseImagesAccounted(image(start), image(end), receipts)).toBe(valid);
});

it("cannot charge unrelated data or foreign lease rows to an owned heartbeat", () => {
  const receipt = {
    path: "db",
    order: 1n,
    component: "leases" as const,
    before: "a".repeat(64),
    after: "b".repeat(64),
  };
  expect(areUpdateDatabaseImagesAccounted(image("a", "a"), image("a", "b"), [receipt])).toBe(true);
  expect(areUpdateDatabaseImagesAccounted(image("a", "a"), image("f", "b"), [receipt])).toBe(false);
  expect(areUpdateDatabaseImagesAccounted(image("a", "f"), image("a", "b"), [receipt])).toBe(false);
});

it("revalidates the live commit owner after preparing the postimage", () => {
  const pathname = fixture();
  const before = readUpdateDatabaseWriteInspection([pathname]).images[pathname];
  const db = new DatabaseSync(pathname);
  let current = true;
  let committed = false;
  try {
    expect(() =>
      withSqliteTransactionReceiptObserver(
        () => ({
          beforeCommit() {
            current = false;
          },
          committed() {
            committed = true;
          },
        }),
        () =>
          runSqliteImmediateTransactionSync(db, () => db.exec("DELETE FROM payload"), {
            withCommit(commit) {
              if (!current) {
                throw new Error("owner revoked during image inspection");
              }
              commit();
            },
          }),
      ),
    ).toThrow("owner revoked during image inspection");
  } finally {
    db.close();
  }
  expect(committed).toBe(false);
  expect(readUpdateDatabaseWriteInspection([pathname]).images[pathname]).toBe(before);
});

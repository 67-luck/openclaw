import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireUpdateDatabaseRestoreCustody } from "./update-database-restore-custody.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const supported = process.platform !== "win32" && !process.versions.bun;
function seed() {
  const directory = tempDirs.make("restore-custody-admission-");
  const pathname = path.join(directory, "db.sqlite");
  const db = new DatabaseSync(pathname);
  db.exec("CREATE TABLE witness(value);INSERT INTO witness VALUES(42)");
  db.close();
  return { directory, pathname, original: fs.readFileSync(pathname) };
}
it.runIf(supported).each(["hardlink", "symlink"])(
  "refuses %s sidecars before native open",
  (kind) => {
    const { directory, pathname, original } = seed();
    const sentinel = path.join(directory, "sentinel");
    const bytes = Buffer.from("unrelated file must not be touched by SQLite");
    fs.writeFileSync(sentinel, bytes);
    if (kind === "hardlink") {
      fs.linkSync(sentinel, pathname + "-wal");
    } else {
      fs.symlinkSync(sentinel, pathname + "-shm");
    }
    expect(() => acquireUpdateDatabaseRestoreCustody([pathname])).toThrow("unaliased regular file");
    expect(fs.readFileSync(sentinel)).toEqual(bytes);
    expect(fs.readFileSync(pathname)).toEqual(original);
  },
);
it.runIf(supported)("refuses a nonempty journal without triggering SQLite recovery", () => {
  const { pathname, original } = seed();
  const journal = Buffer.alloc(4096, 7);
  fs.writeFileSync(pathname + "-journal", journal);
  expect(() => acquireUpdateDatabaseRestoreCustody([pathname])).toThrow(
    "settled journal artifacts",
  );
  expect(fs.readFileSync(pathname)).toEqual(original);
  expect(fs.readFileSync(pathname + "-journal")).toEqual(journal);
});
it.each(["win32", "bun"])(
  "fails safe before opening source data on unsupported %s custody",
  (runtime) => {
    const { pathname, original } = seed();
    const target = runtime === "win32" ? process : process.versions;
    const key = runtime === "win32" ? "platform" : "bun";
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    try {
      Object.defineProperty(target, key, {
        value: runtime === "win32" ? "win32" : "1.4.2",
        configurable: true,
      });
      expect(() => acquireUpdateDatabaseRestoreCustody([pathname])).toThrow(
        "preserve databases and snapshots",
      );
    } finally {
      if (descriptor) {
        Object.defineProperty(target, key, descriptor);
      } else {
        Reflect.deleteProperty(target, key);
      }
    }
    expect(fs.readFileSync(pathname)).toEqual(original);
  },
);

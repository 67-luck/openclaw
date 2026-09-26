import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as durability from "./directory-durability.js";
import * as fsSafe from "./fs-safe.js";
import * as sqlite from "./node-sqlite.js";
import type { UpdateDatabaseBackup } from "./update-database-backup.js";
import { readUpdateDatabaseGenerations } from "./update-database-generations.js";
import * as inspection from "./update-database-inspection.js";
import { restoreUpdateDatabaseBackup } from "./update-database-restore.js";

let writer: ChildProcess;
beforeAll(async () => {
  writer = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import { DatabaseSync } from 'node:sqlite';
    const held = new Map();
    process.on('message', ({path,sql,keep,close}) => {
      if(close) { held.get(path)?.close(); held.delete(path); process.send({ok:true}); return; }
      const db = held.get(path) ?? new DatabaseSync(path); let reply;
      try { db.exec('PRAGMA busy_timeout=0;'+sql); reply={ok:true}; }
      catch(error) { reply={error:error.message}; }
      finally { if(keep) held.set(path,db); else {db.close(); held.delete(path);} }
      process.send(reply);
    }); process.send({ready:true});
  `,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  expect((await once(writer, "message"))[0]).toEqual({ ready: true });
});
afterAll(async () => {
  await stopChildProcess(writer, 5_000);
});
async function foreign(pathname: string, sql: string, keep = false) {
  const reply = once(writer, "message");
  writer.send({ path: pathname, sql, keep });
  return (await reply)[0];
}

async function closeForeign(pathname: string) {
  const reply = once(writer, "message");
  writer.send({ path: pathname, close: true });
  expect((await reply)[0]).toEqual({ ok: true });
}

async function fixture(
  run: (params: Parameters<typeof restoreUpdateDatabaseBackup>[0]) => Promise<void>,
) {
  await withOpenClawTestState(
    { layout: "state-only", scenario: "minimal", prefix: "restore-native-" },
    async (state) => {
      const pathname = state.path("db.sqlite");
      const snapshotPath = state.path("baseline.sqlite");
      const seed = new DatabaseSync(pathname);
      seed.exec("CREATE TABLE witness(value); INSERT INTO witness VALUES ('baseline')");
      seed.close();
      await fs.copyFile(pathname, snapshotPath);
      const bytes = await fs.readFile(snapshotPath);
      expect(
        await foreign(pathname, "PRAGMA journal_mode=WAL; UPDATE witness SET value='candidate'"),
      ).toEqual({ ok: true });
      const sourceGenerations = readUpdateDatabaseGenerations([pathname]);
      const backup: UpdateDatabaseBackup = {
        directory: state.stateDir,
        databases: [
          {
            path: pathname,
            snapshotPath,
            userVersion: 0,
            sizeBytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
        missingPaths: [],
        sourcePaths: [pathname],
        sourceGenerations,
        warnings: [],
      };
      await run({
        backup,
        runId: "native-proof",
        env: state.env,
        assertCurrent() {},
        expectedGenerations: sourceGenerations,
      });
    },
  );
}

it("preserves a raw foreign commit after generation admission during backup verification", async () => {
  await fixture(async (params) => {
    const pathname = params.backup.databases[0]!.path;
    const hash = durability.sha256File;
    let wrote = false;
    const verify = vi.spyOn(durability, "sha256File").mockImplementation(async (...args) => {
      const result = await hash(...args);
      if (!wrote) {
        wrote = true;
        expect(await foreign(pathname, "UPDATE witness SET value='foreign'")).toEqual({ ok: true });
      }
      return result;
    });
    try {
      expect(await restoreUpdateDatabaseBackup(params)).toBeNull();
      const db = new DatabaseSync(pathname, { readOnly: true });
      try {
        expect(db.prepare("SELECT value FROM witness").get()?.value).toBe("foreign");
      } finally {
        db.close();
      }
      await expect(fs.lstat(pathname + ".migrated-native-proof")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      verify.mockRestore();
    }
  });
});

it("retains native exclusion through the real no-replace rename without raw descriptor closes", async () => {
  await fixture(async (params) => {
    const pathname = params.backup.databases[0]!.path;
    const open = fsSafe.root;
    let attempted = false;
    const hook = vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
      const directory = await open(...args);
      const move = directory.move.bind(directory);
      vi.spyOn(directory, "move").mockImplementation(async (...moveArgs) => {
        attempted = true;
        expect(await foreign(pathname, "UPDATE witness SET value='lost'")).toEqual({
          error: "database is locked",
        });
        await move(...moveArgs);
        expect(
          await foreign(pathname + ".migrated-native-proof", "UPDATE witness SET value='lost'"),
        ).toEqual({ error: "database is locked" });
      });
      return directory;
    });
    try {
      expect(await restoreUpdateDatabaseBackup(params)).toContain(
        pathname + ".migrated-native-proof",
      );
      expect(attempted).toBe(true);
      const restored = new DatabaseSync(pathname, { readOnly: true });
      try {
        expect(restored.prepare("SELECT value FROM witness").get()?.value).toBe("baseline");
      } finally {
        restored.close();
      }
      expect(
        await foreign(
          pathname + ".migrated-native-proof",
          "UPDATE witness SET value='after-close'",
        ),
      ).toEqual({ ok: true });
    } finally {
      hook.mockRestore();
    }
  });
});

it("does not unlink a new live WAL when closing the displaced native owner", async () => {
  await fixture(async (params) => {
    const pathname = params.backup.databases[0]!.path;
    const open = fsSafe.root;
    let wal: Buffer | undefined;
    const hook = vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
      const directory = await open(...args);
      const move = directory.move.bind(directory);
      vi.spyOn(directory, "move").mockImplementation(async (...moveArgs) => {
        await move(...moveArgs);
        expect(
          await foreign(
            pathname,
            "PRAGMA journal_mode=WAL; CREATE TABLE foreign_rows(value); INSERT INTO foreign_rows VALUES(99)",
            true,
          ),
        ).toEqual({ ok: true });
        wal = await fs.readFile(pathname + "-wal");
        expect(wal.length).toBeGreaterThan(0);
      });
      return directory;
    });
    try {
      await expect(restoreUpdateDatabaseBackup(params)).rejects.toThrow();
      expect(await fs.readFile(pathname + "-wal")).toEqual(wal);
      const current = new DatabaseSync(pathname, { readOnly: true });
      try {
        expect(current.prepare("SELECT value FROM foreign_rows").get()?.value).toBe(99);
      } finally {
        current.close();
      }
      const displaced = new DatabaseSync(pathname + ".migrated-native-proof", { readOnly: true });
      try {
        expect(displaced.prepare("SELECT value FROM witness").get()?.value).toBe("candidate");
      } finally {
        displaced.close();
      }
    } finally {
      hook.mockRestore();
      await closeForeign(pathname);
    }
  });
});

it("never publishes a replacement after a native close failure", async () => {
  await fixture(async (params) => {
    const pathname = params.backup.databases[0]!.path;
    const open = sqlite.openNodeSqliteDatabase;
    const hook = vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
      const database = open(...args);
      if (database.location() === pathname) {
        const close = database.close.bind(database);
        vi.spyOn(database, "close").mockImplementation(() => {
          close();
          throw new Error("native close failed");
        });
      }
      return database;
    });
    try {
      await expect(restoreUpdateDatabaseBackup(params)).rejects.toThrow("native close failed");
      await expect(fs.stat(pathname)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.stat(pathname + ".migrated-native-proof")).isFile()).toBe(true);
      expect((await fs.stat(params.backup.databases[0]!.snapshotPath)).isFile()).toBe(true);
    } finally {
      hook.mockRestore();
    }
  });
});

it("checkpoints an admitted committed WAL under exclusive custody before retaining its main file", async () => {
  await fixture(async (params) => {
    const pathname = params.backup.databases[0]!.path;
    // An actual process exit without SQLite close leaves a committed WAL. No
    // in-process imitation can prove retention of that native crash boundary.
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(" +
          JSON.stringify(pathname) +
          ");db.exec(\"PRAGMA journal_mode=WAL;UPDATE witness SET value='wal-tail'\");process.exit(0);",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    try {
      expect(await once(child, "close")).toEqual([0, null]);
    } finally {
      await stopChildProcess(child, 5_000);
    }
    expect((await fs.stat(pathname + "-wal")).size).toBeGreaterThan(0);
    params.expectedGenerations = readUpdateDatabaseGenerations([pathname]);
    const open = fsSafe.root;
    const order: string[] = [];
    const hook = vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
      const directory = await open(...args);
      const move = directory.move.bind(directory);
      vi.spyOn(directory, "move").mockImplementation(async (...moveArgs) => {
        order.push(moveArgs[0]);
        if (moveArgs[0] === path.basename(pathname)) {
          await expect(fs.stat(pathname + "-shm")).rejects.toMatchObject({ code: "ENOENT" });
        }
        await move(...moveArgs);
      });
      return directory;
    });
    try {
      expect(await restoreUpdateDatabaseBackup(params)).toContain(
        pathname + ".migrated-native-proof",
      );
    } finally {
      hook.mockRestore();
    }
    expect(order).toEqual([path.basename(pathname) + "-shm", path.basename(pathname)]);
    const moved = new DatabaseSync(pathname + ".migrated-native-proof", { readOnly: true });
    try {
      expect(moved.prepare("SELECT value FROM witness").get()?.value).toBe("wal-tail");
    } finally {
      moved.close();
    }
    expect(
      (await fs.readdir(path.dirname(pathname))).filter(
        (name) => name.endsWith("-wal") || name.endsWith("-journal"),
      ),
    ).toEqual([]);
  });
});

it("settles native custody without displacement after authority is revoked during held verification", async () => {
  await fixture(async (params) => {
    const pathname = params.backup.databases[0]!.path;
    const read = inspection.readUpdateDatabaseGenerationsIsolated;
    let current = true;
    params.assertCurrent = () => {
      if (!current) {
        throw new Error("native restore revoked");
      }
    };
    const hook = vi
      .spyOn(inspection, "readUpdateDatabaseGenerationsIsolated")
      .mockImplementation(async (...args) => {
        const result = await read(...args);
        current = false;
        return result;
      });
    try {
      await expect(restoreUpdateDatabaseBackup(params)).rejects.toThrow("native restore revoked");
      await expect(fs.stat(pathname + ".migrated-native-proof")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await foreign(pathname, "UPDATE witness SET value='after-refusal'")).toEqual({
        ok: true,
      });
    } finally {
      hook.mockRestore();
    }
  });
});

it("never displaces a formerly missing store created after the held generation inspection", async () => {
  await fixture(async (params) => {
    const missing = path.join(path.dirname(params.backup.databases[0]!.path), "aaa-missing.sqlite");
    params.backup.missingPaths.push(missing);
    params.backup.sourcePaths.push(missing);
    params.expectedGenerations = { ...params.expectedGenerations, [missing]: null };
    const read = inspection.readUpdateDatabaseGenerationsIsolated;
    const hook = vi
      .spyOn(inspection, "readUpdateDatabaseGenerationsIsolated")
      .mockImplementation(async (...args) => {
        const result = await read(...args);
        expect(
          await foreign(missing, "CREATE TABLE new_rows(value);INSERT INTO new_rows VALUES(99)"),
        ).toEqual({ ok: true });
        return result;
      });
    try {
      await expect(restoreUpdateDatabaseBackup(params)).rejects.toThrow("native custody");
      await expect(fs.stat(missing + ".migrated-native-proof")).rejects.toMatchObject({
        code: "ENOENT",
      });
      const db = new DatabaseSync(missing, { readOnly: true });
      try {
        expect(db.prepare("SELECT value FROM new_rows").get()?.value).toBe(99);
      } finally {
        db.close();
      }
    } finally {
      hook.mockRestore();
    }
  });
});

it("keeps post-release foreign writes live when a delayed native handle closes", async () => {
  await fixture(async (params) => {
    const pathname = params.backup.databases[0]!.path;
    expect(await foreign(pathname, "PRAGMA journal_mode=DELETE", true)).toEqual({ ok: true });
    params.expectedGenerations = readUpdateDatabaseGenerations([pathname]);
    try {
      expect(await restoreUpdateDatabaseBackup(params)).toContain(
        pathname + ".migrated-native-proof",
      );
      const live = new DatabaseSync(pathname);
      try {
        live.exec("PRAGMA journal_mode=WAL;UPDATE witness SET value='new-live'");
        const wal = await fs.readFile(pathname + "-wal");
        // Native exclusion ends at settled close. SQLite may follow the live
        // WAL after that point; a successful later commit must remain live, not
        // disappear into the displaced file or lose its WAL during peer close.
        expect(await foreign(pathname, "UPDATE witness SET value='late-old-handle'")).toEqual({
          ok: true,
        });
        expect((await fs.readFile(pathname + "-wal")).length).toBeGreaterThan(wal.length);
        expect(live.prepare("SELECT value FROM witness").get()?.value).toBe("late-old-handle");
      } finally {
        live.close();
      }
      const old = new DatabaseSync(pathname + ".migrated-native-proof", { readOnly: true });
      try {
        expect(old.prepare("SELECT value FROM witness").get()?.value).toBe("candidate");
      } finally {
        old.close();
      }
    } finally {
      await closeForeign(pathname);
    }
  });
});

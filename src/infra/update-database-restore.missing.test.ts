import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as creation from "@openclaw/fs-safe/advanced";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
vi.mock("@openclaw/fs-safe/advanced", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/advanced")>();
  return { ...actual, createFileSync: vi.fn(actual.createFileSync) };
});
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as fsSafe from "./fs-safe.js";
import * as sqlite from "./node-sqlite.js";
import * as snapshot from "./sqlite-snapshot.js";
import * as coordinators from "./state-database-coordinator.js";
import type { UpdateDatabaseBackup } from "./update-database-backup.js";
import { readUpdateDatabaseGenerations } from "./update-database-generations.js";
import { restoreUpdateDatabaseBackup } from "./update-database-restore.js";

let writer: ChildProcess;
beforeAll(async () => {
  writer = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import {DatabaseSync} from 'node:sqlite';
    process.on('message',({path,sql})=>{let db,reply;
      try {db=new DatabaseSync(path);db.exec('PRAGMA busy_timeout=0;'+sql);reply={ok:true,version:db.prepare('PRAGMA user_version').get().user_version};}
      catch(error){reply={error:error.message,code:error.errcode};}
      finally {db?.close();} process.send(reply);
    });process.send({ready:true});
  `,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  expect((await once(writer, "message"))[0]).toEqual({ ready: true });
});
afterAll(async () => {
  await stopChildProcess(writer, 5_000);
});
async function foreign(pathname: string) {
  const reply = once(writer, "message");
  writer.send({
    path: pathname,
    sql: "CREATE TABLE foreign_rows(value);INSERT INTO foreign_rows VALUES(99);PRAGMA user_version=99",
  });
  return (await reply)[0];
}

type RestoreParams = Parameters<typeof restoreUpdateDatabaseBackup>[0];
async function fixture(
  run: (params: RestoreParams, missing: string) => Promise<void>,
  nested = false,
) {
  await withOpenClawTestState(
    { layout: "state-only", scenario: "minimal", prefix: "restore-missing-" },
    async (state) => {
      const pathname = state.path("db.sqlite"),
        snapshotPath = state.path("snapshot.sqlite");
      const missing = state.path(nested ? "new-agent/state/absent.sqlite" : "aaa-absent.sqlite");
      const db = new DatabaseSync(pathname);
      db.exec("CREATE TABLE witness(value);INSERT INTO witness VALUES('baseline')");
      db.close();
      await fs.copyFile(pathname, snapshotPath);
      const bytes = await fs.readFile(snapshotPath);
      const current = new DatabaseSync(pathname);
      current.exec("UPDATE witness SET value='candidate'");
      current.close();
      const sourceGenerations = readUpdateDatabaseGenerations([pathname, missing]);
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
        missingPaths: [missing],
        sourcePaths: [pathname, missing],
        sourceGenerations,
        warnings: [],
      };
      await run(
        {
          backup,
          runId: "missing-proof",
          env: state.env,
          assertCurrent() {},
          expectedGenerations: sourceGenerations,
        },
        missing,
      );
    },
  );
}

it.each(["displacement", "publication"])(
  "reserves missing paths after their scan through other-file %s",
  async (seam) => {
    await fixture(async (params, missing) => {
      let attempt: unknown;
      const open = fsSafe.root,
        publish = snapshot.publishVerifiedSqliteFile;
      const moveHook = vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
        const directory = await open(...args),
          move = directory.move.bind(directory);
        vi.spyOn(directory, "move").mockImplementation(async (...moveArgs) => {
          await move(...moveArgs);
          if (
            seam === "displacement" &&
            attempt === undefined &&
            moveArgs[0] === path.basename(params.backup.databases[0]!.path)
          ) {
            attempt = await foreign(missing);
          }
        });
        return directory;
      });
      const publishHook = vi
        .spyOn(snapshot, "publishVerifiedSqliteFile")
        .mockImplementation(async (...args) => {
          const result = await publish(...args);
          if (seam === "publication") {
            attempt = await foreign(missing);
          }
          return result;
        });
      try {
        expect(await restoreUpdateDatabaseBackup(params)).toContain(
          params.backup.databases[0]!.path + ".migrated-missing-proof",
        );
        expect(attempt).toMatchObject({ code: 5 });
        await expect(fs.lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        moveHook.mockRestore();
        publishHook.mockRestore();
      }
    });
  },
);

async function expectAbsent(pathname: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    await expect(fs.lstat(pathname + suffix)).rejects.toMatchObject({ code: "ENOENT" });
  }
}
async function seedCreated(params: RestoreParams, missing: string) {
  const db = new DatabaseSync(missing);
  db.exec("CREATE TABLE candidate(value);INSERT INTO candidate VALUES(23);PRAGMA user_version=23");
  db.close();
  params.expectedGenerations = readUpdateDatabaseGenerations(params.backup.sourcePaths);
}
it("owns nested missing parents without leaving new directories after successful rollback", async () => {
  await fixture(async (params, missing) => {
    const publish = snapshot.publishVerifiedSqliteFile;
    const hook = vi
      .spyOn(snapshot, "publishVerifiedSqliteFile")
      .mockImplementation(async (...args) => {
        expect((await fs.lstat(path.dirname(path.dirname(missing)))).isFile()).toBe(true);
        expect(await foreign(missing)).toMatchObject({ code: 14 });
        return publish(...args);
      });
    try {
      await expect(restoreUpdateDatabaseBackup(params)).resolves.toBeInstanceOf(Array);
      await expectAbsent(missing);
      await expect(fs.lstat(path.dirname(path.dirname(missing)))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      hook.mockRestore();
    }
  }, true);
});
it("keeps a newly created store absent through publication after its old native handle closes", async () => {
  await fixture(async (params, missing) => {
    await seedCreated(params, missing);
    let old: DatabaseSync | undefined;
    const open = sqlite.openNodeSqliteDatabase,
      publish = snapshot.publishVerifiedSqliteFile;
    const openHook = vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
      const db = open(...args);
      if (db.location() === missing) {
        old = db;
      }
      return db;
    });
    const hook = vi
      .spyOn(snapshot, "publishVerifiedSqliteFile")
      .mockImplementation(async (...args) => {
        expect(old?.isOpen).toBe(false);
        expect(await foreign(missing)).toMatchObject({ code: 5 });
        return publish(...args);
      });
    try {
      expect(await restoreUpdateDatabaseBackup(params)).toContain(
        missing + ".migrated-missing-proof",
      );
      await expectAbsent(missing);
      const retained = new DatabaseSync(missing + ".migrated-missing-proof", { readOnly: true });
      try {
        expect(retained.prepare("SELECT value FROM candidate").get()?.value).toBe(23);
      } finally {
        retained.close();
      }
    } finally {
      hook.mockRestore();
      openHook.mockRestore();
    }
  });
});
it("fails without clobbering a raw creator that wins the displaced-name reservation", async () => {
  await fixture(async (params, missing) => {
    await seedCreated(params, missing);
    const open = fsSafe.root;
    const hook = vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
      const dir = await open(...args),
        move = dir.move.bind(dir);
      vi.spyOn(dir, "move").mockImplementation(async (...moveArgs) => {
        await move(...moveArgs);
        if (moveArgs[0] === path.basename(missing)) {
          expect(await foreign(missing)).toMatchObject({ ok: true, version: 99 });
        }
      });
      return dir;
    });
    try {
      await expect(restoreUpdateDatabaseBackup(params)).rejects.toThrow(
        "cannot reserve missing path",
      );
      const db = new DatabaseSync(missing, { readOnly: true });
      try {
        expect(db.prepare("SELECT value FROM foreign_rows").get()?.value).toBe(99);
      } finally {
        db.close();
      }
      expect((await fs.stat(missing + ".migrated-missing-proof")).isFile()).toBe(true);
    } finally {
      hook.mockRestore();
    }
  });
});
it.each(["refused-publication", "revoked"])(
  "settles only owned reservations after %s",
  async (scenario) => {
    await fixture(async (params, missing) => {
      const failure = new Error(scenario);
      let current = true;
      params.assertCurrent = () => {
        if (!current) {
          throw failure;
        }
      };
      const publish = snapshot.publishVerifiedSqliteFile;
      const hook = vi
        .spyOn(snapshot, "publishVerifiedSqliteFile")
        .mockImplementation(async (...args) => {
          expect((await fs.lstat(missing)).isFile()).toBe(true);
          if (scenario === "refused-publication") {
            throw failure;
          }
          const result = await publish(...args);
          current = false;
          return result;
        });
      try {
        await expect(restoreUpdateDatabaseBackup(params)).rejects.toBe(failure);
        await expectAbsent(missing);
      } finally {
        hook.mockRestore();
      }
    });
  },
);
it("joins native close failure before releasing absence and never publishes a replacement", async () => {
  await fixture(async (params, missing) => {
    const pathname = params.backup.databases[0]!.path,
      open = sqlite.openNodeSqliteDatabase;
    const hook = vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
      const db = open(...args);
      if (db.location() === pathname) {
        const close = db.close.bind(db);
        vi.spyOn(db, "close").mockImplementation(() => {
          expect(fsSync.lstatSync(missing).isFile()).toBe(true);
          close();
          throw new Error("native close refused");
        });
      }
      return db;
    });
    const publish = vi.spyOn(snapshot, "publishVerifiedSqliteFile");
    try {
      await expect(restoreUpdateDatabaseBackup(params)).rejects.toThrow("native close refused");
      expect(publish).not.toHaveBeenCalled();
      await expectAbsent(missing);
    } finally {
      publish.mockRestore();
      hook.mockRestore();
    }
  });
});
it.each(["replaced", "foreign-child", "foreign-content"])(
  "preserves foreign content when reservation cleanup is %s",
  async (scenario) => {
    await fixture(async (params, missing) => {
      const publish = snapshot.publishVerifiedSqliteFile;
      const foreignPath =
        scenario === "foreign-child" ? path.join(missing, "foreign.sqlite") : missing;
      const hook = vi
        .spyOn(snapshot, "publishVerifiedSqliteFile")
        .mockImplementation(async (...args) => {
          const result = await publish(...args);
          if (scenario !== "foreign-content") {
            for (const suffix of ["", "-wal", "-shm", "-journal"]) {
              await fs.unlink(missing + suffix);
            }
          }
          if (scenario === "foreign-child") {
            await fs.mkdir(missing);
          }
          if (scenario === "foreign-content") {
            await fs.writeFile(missing, "foreign bytes");
          } else {
            expect(await foreign(foreignPath)).toMatchObject({ ok: true, version: 99 });
          }
          return result;
        });
      try {
        await expect(restoreUpdateDatabaseBackup(params)).rejects.toThrow();
        if (scenario === "foreign-content") {
          expect(await fs.readFile(missing, "utf8")).toBe("foreign bytes");
          return;
        }
        const db = new DatabaseSync(foreignPath, { readOnly: true });
        try {
          expect(db.prepare("SELECT value FROM foreign_rows").get()?.value).toBe(99);
        } finally {
          db.close();
        }
      } finally {
        hook.mockRestore();
      }
    });
  },
);
it("does not report success when a retained reservation descriptor fails to close", async () => {
  await fixture(async (params, missing) => {
    const create = vi.mocked(creation.createFileSync).getMockImplementation();
    if (!create) {
      throw new Error("Missing real creation implementation");
    }
    const publish = snapshot.publishVerifiedSqliteFile;
    let armed = false,
      failed = false;
    const createHook = vi.spyOn(creation, "createFileSync").mockImplementation((...args) => {
      const owner = create(...args);
      return {
        fd: owner.fd,
        close() {
          owner.close();
          if (armed && !failed) {
            failed = true;
            throw new Error("reservation close failed");
          }
        },
        [Symbol.dispose]() {
          this.close();
        },
      };
    });
    const hook = vi
      .spyOn(snapshot, "publishVerifiedSqliteFile")
      .mockImplementation(async (...args) => {
        const result = await publish(...args);
        armed = true;
        return result;
      });
    try {
      await expect(restoreUpdateDatabaseBackup(params)).rejects.toThrow("reservation close failed");
      expect(failed).toBe(true);
      await expectAbsent(missing);
    } finally {
      hook.mockRestore();
      createHook.mockRestore();
    }
  });
});

it("keeps missing namespaces reserved until outer source fences have settled", async () => {
  await fixture(async (params, missing) => {
    const acquire = coordinators.acquireGatewayMaintenanceCoordinator;
    let released = false;
    const hook = vi
      .spyOn(coordinators, "acquireGatewayMaintenanceCoordinator")
      .mockImplementation((...args) => {
        const owner = acquire(...args),
          release = owner.release.bind(owner);
        vi.spyOn(owner, "release").mockImplementation((...releaseArgs) => {
          try {
            expect(fsSync.lstatSync(missing).isFile()).toBe(true);
            const raw = new DatabaseSync(missing);
            try {
              expect(() => raw.exec("CREATE TABLE forbidden(value)")).toThrow("database is locked");
            } finally {
              raw.close();
            }
            released = true;
          } finally {
            release(...releaseArgs);
          }
        });
        return owner;
      });
    try {
      await restoreUpdateDatabaseBackup(params);
      expect(released).toBe(true);
      await expectAbsent(missing);
    } finally {
      hook.mockRestore();
    }
  });
});

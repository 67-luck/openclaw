import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as sqlite from "./node-sqlite.js";
import * as publication from "./sqlite-snapshot.js";
import * as coordinators from "./state-database-coordinator.js";
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
    import {DatabaseSync} from 'node:sqlite';process.on('message',({path})=>{let db,reply;
      try{db=new DatabaseSync(path);db.exec("PRAGMA busy_timeout=0;UPDATE witness SET value='foreign';PRAGMA user_version=99");reply={ok:true};}
      catch(error){reply={code:error.errcode,error:error.message};}finally{db?.close();}process.send(reply);
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
async function foreign(path: string) {
  const reply = once(writer, "message");
  writer.send({ path });
  return (await reply)[0];
}
async function fixture(
  run: (params: Parameters<typeof restoreUpdateDatabaseBackup>[0]) => Promise<void>,
  walSnapshot = false,
) {
  await withOpenClawTestState(
    { layout: "state-only", scenario: "minimal", prefix: "restore-published-" },
    async (state) => {
      const databases: UpdateDatabaseBackup["databases"] = [];
      for (const name of ["first", "second"]) {
        const pathname = state.path(name + ".sqlite"),
          snapshotPath = state.path(name + ".snapshot");
        const db = new DatabaseSync(pathname);
        db.exec("CREATE TABLE witness(value);INSERT INTO witness VALUES('baseline')");
        if (walSnapshot) {
          db.exec("PRAGMA journal_mode=WAL");
        }
        db.close();
        await fs.copyFile(pathname, snapshotPath);
        const bytes = await fs.readFile(snapshotPath);
        const changed = new DatabaseSync(pathname);
        changed.exec("UPDATE witness SET value='candidate'");
        changed.close();
        databases.push({
          path: pathname,
          snapshotPath,
          userVersion: 0,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sizeBytes: bytes.length,
        });
      }
      const sourcePaths = databases.map((d) => d.path),
        sourceGenerations = readUpdateDatabaseGenerations(sourcePaths);
      await run({
        backup: {
          directory: state.stateDir,
          databases,
          sourcePaths,
          sourceGenerations,
          missingPaths: [],
          warnings: [],
        },
        env: state.env,
        runId: "published-proof",
        assertCurrent() {},
        expectedGenerations: sourceGenerations,
      });
    },
  );
}
it("holds the first restored store while a second store is published", async () => {
  await fixture(async (params) => {
    const first = params.backup.databases[0]!.path,
      second = params.backup.databases[1]!.path;
    const publish = publication.publishVerifiedSqliteFile;
    let attempt: unknown;
    const hook = vi
      .spyOn(publication, "publishVerifiedSqliteFile")
      .mockImplementation(async (options) => {
        if (options.targetPath === second) {
          attempt = await foreign(first);
        }
        return publish(options);
      });
    try {
      await expect(restoreUpdateDatabaseBackup(params)).resolves.toHaveLength(2);
      expect(attempt).toMatchObject({ code: 5 });
      for (const entry of params.backup.databases) {
        const db = new DatabaseSync(entry.path, { readOnly: true });
        try {
          expect(db.prepare("SELECT value FROM witness").get()?.value).toBe("baseline");
        } finally {
          db.close();
        }
      }
    } finally {
      hook.mockRestore();
    }
  });
});
it("detects a foreign commit in the publication-to-custody handover without overwriting it", async () => {
  await fixture(async (params) => {
    const first = params.backup.databases[0]!.path,
      publish = publication.publishVerifiedSqliteFile;
    const hook = vi
      .spyOn(publication, "publishVerifiedSqliteFile")
      .mockImplementation(async (options) => {
        await publish(options);
        if (options.targetPath === first) {
          expect(await foreign(first)).toEqual({ ok: true });
        }
      });
    try {
      await expect(restoreUpdateDatabaseBackup(params)).rejects.toThrow();
      const db = new DatabaseSync(first, { readOnly: true });
      try {
        expect(db.prepare("SELECT value FROM witness").get()?.value).toBe("foreign");
      } finally {
        db.close();
      }
    } finally {
      hook.mockRestore();
    }
  });
});
it("retains every published native owner through outer source-fence settlement", async () => {
  await fixture(async (params) => {
    const acquire = coordinators.acquireGatewayMaintenanceCoordinator;
    let observed = false;
    const hook = vi
      .spyOn(coordinators, "acquireGatewayMaintenanceCoordinator")
      .mockImplementation((...args) => {
        const owner = acquire(...args),
          release = owner.release.bind(owner);
        vi.spyOn(owner, "release").mockImplementation((...releaseArgs) => {
          try {
            for (const { path } of params.backup.databases) {
              const peer = new DatabaseSync(path);
              try {
                expect(() => peer.exec("BEGIN IMMEDIATE")).toThrow("locked");
              } finally {
                peer.close();
              }
            }
            observed = true;
          } finally {
            release(...releaseArgs);
          }
        });
        return owner;
      });
    try {
      await restoreUpdateDatabaseBackup(params);
      expect(observed).toBe(true);
      expect(await foreign(params.backup.databases[0]!.path)).toEqual({ ok: true });
    } finally {
      hook.mockRestore();
    }
  });
});

it("preserves an orphan committed WAL in the publish-to-acquire window", async () => {
  await fixture(async (params) => {
    const first = params.backup.databases[0]!,
      publish = publication.publishVerifiedSqliteFile;
    const hook = vi
      .spyOn(publication, "publishVerifiedSqliteFile")
      .mockImplementation(async (options) => {
        await publish(options);
        if (options.targetPath === first.path) {
          const child = spawn(
            process.execPath,
            [
              "--input-type=module",
              "--eval",
              "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(" +
                JSON.stringify(first.path) +
                ");db.exec(\"UPDATE witness SET value='foreign'\");process.exit(0);",
            ],
            { stdio: ["ignore", "ignore", "pipe"] },
          );
          try {
            expect(await once(child, "close")).toEqual([0, null]);
          } finally {
            await stopChildProcess(child, 5_000);
          }
          expect(
            createHash("sha256")
              .update(await fs.readFile(first.path))
              .digest("hex"),
          ).toBe(first.sha256);
          expect((await fs.stat(first.path + "-wal")).size).toBeGreaterThan(0);
        }
      });
    try {
      await expect(restoreUpdateDatabaseBackup(params)).rejects.toThrow();
      const db = new DatabaseSync(first.path, { readOnly: true });
      try {
        expect(db.prepare("SELECT value FROM witness").get()?.value).toBe("foreign");
      } finally {
        db.close();
      }
    } finally {
      hook.mockRestore();
    }
  }, true);
});
it("cannot report success after a published native owner fails to settle", async () => {
  await fixture(async (params) => {
    const first = params.backup.databases[0]!.path,
      publish = publication.publishVerifiedSqliteFile,
      open = sqlite.openNodeSqliteDatabase;
    let appeared = false;
    const pub = vi
      .spyOn(publication, "publishVerifiedSqliteFile")
      .mockImplementation(async (options) => {
        await publish(options);
        if (options.targetPath === first) {
          appeared = true;
        }
      });
    const hook = vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
      const db = open(...args);
      if (appeared && db.location() === first) {
        const close = db.close.bind(db);
        vi.spyOn(db, "close").mockImplementation(() => {
          close();
          throw new Error("published close failure");
        });
      }
      return db;
    });
    try {
      await expect(restoreUpdateDatabaseBackup(params)).rejects.toThrow("published close failure");
    } finally {
      hook.mockRestore();
      pub.mockRestore();
    }
  });
});
it("settles a newly published lock when authority expires during postimage inspection", async () => {
  await fixture(async (params) => {
    const read = inspection.readUpdateDatabasePostimagesIsolated;
    let current = true;
    const failure = new Error("published authority revoked");
    params.assertCurrent = () => {
      if (!current) {
        throw failure;
      }
    };
    const hook = vi
      .spyOn(inspection, "readUpdateDatabasePostimagesIsolated")
      .mockImplementation(async (...args) => {
        const result = await read(...args);
        current = false;
        return result;
      });
    try {
      await expect(restoreUpdateDatabaseBackup(params)).rejects.toBe(failure);
      expect(await foreign(params.backup.databases[0]!.path)).toEqual({ ok: true });
    } finally {
      hook.mockRestore();
    }
  });
});

it("hands over WAL-formatted snapshots after owned journal settlement", async () => {
  await fixture(async (params) => {
    await expect(restoreUpdateDatabaseBackup(params)).resolves.toHaveLength(2);
    for (const entry of params.backup.databases) {
      const db = new DatabaseSync(entry.path, { readOnly: true });
      try {
        expect(db.prepare("SELECT value FROM witness").get()?.value).toBe("baseline");
        expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(0);
      } finally {
        db.close();
      }
    }
  }, true);
});

it("keeps absent names reserved until published native handles settle", async () => {
  await fixture(async (params) => {
    const first = params.backup.databases[0]!.path;
    const missing = params.backup.directory + "/handback-missing.sqlite";
    params.backup.missingPaths.push(missing);
    params.backup.sourcePaths.push(missing);
    params.backup.sourceGenerations[missing] = null;
    const publish = publication.publishVerifiedSqliteFile;
    const open = sqlite.openNodeSqliteDatabase;
    let appeared = false;
    let attempted = false;
    let outcome: unknown;
    const pub = vi
      .spyOn(publication, "publishVerifiedSqliteFile")
      .mockImplementation(async (options) => {
        await publish(options);
        if (options.targetPath === first) {
          appeared = true;
        }
      });
    const hook = vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
      const db = open(...args);
      if (appeared && db.location() === first) {
        const close = db.close.bind(db);
        vi.spyOn(db, "close").mockImplementation(() => {
          try {
            if (!attempted) {
              attempted = true;
              let raw: DatabaseSync | undefined;
              try {
                raw = new DatabaseSync(missing);
                raw.exec(
                  "PRAGMA busy_timeout=0; CREATE TABLE foreign_commit(value); PRAGMA user_version=99",
                );
                outcome = "committed";
              } catch (error) {
                outcome = error;
              } finally {
                raw?.close();
              }
            }
          } finally {
            close();
          }
        });
      }
      return db;
    });
    try {
      await expect(restoreUpdateDatabaseBackup(params)).resolves.toHaveLength(2);
      expect(attempted).toBe(true);
      expect(outcome).toMatchObject({ errcode: 5 });
      await expect(fs.lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      hook.mockRestore();
      pub.mockRestore();
    }
  });
});

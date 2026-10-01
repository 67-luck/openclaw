import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as gatewayLock from "../../infra/gateway-lock.js";
import * as sqlite from "../../infra/node-sqlite.js";
import * as snapshots from "../../infra/update-database-backup.js";
import { restoreUpdateDatabaseBackup } from "../../infra/update-database-restore.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureUpdateDatabases } from "./update-command-database-backup.js";

type CaptureParams = Parameters<typeof captureUpdateDatabases>[0];

async function withCaptureFixture(
  run: (fixture: {
    params: CaptureParams;
    database: ReturnType<typeof openOpenClawStateDatabase>;
    owner: () => NonNullable<Awaited<ReturnType<typeof gatewayLock.acquireGatewayLock>>>;
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    { layout: "state-only", scenario: "minimal", prefix: "update-snapshot-settlement-" },
    async (state) => {
      const database = openOpenClawStateDatabase({ env: state.env });
      database.db.exec(
        "CREATE TABLE snapshot_witness(value TEXT); INSERT INTO snapshot_witness VALUES ('original')",
      );
      const update = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const owner: { current: Awaited<ReturnType<typeof gatewayLock.acquireGatewayLock>> } = {
        current: null,
      };
      const acquire = gatewayLock.acquireGatewayLock;
      vi.spyOn(gatewayLock, "acquireGatewayLock").mockImplementation(async (options) => {
        owner.current = await acquire(options);
        return owner.current;
      });
      const params: CaptureParams = {
        transaction: {
          backupRoot: state.path("package-backup"),
          rollback: async () => {
            throw new Error("Snapshot fixture must not roll back packages");
          },
          complete: async () => undefined,
        },
        execution: {
          root: state.path("package"),
          installKind: "package",
          updateInstallKind: "package",
          switchToGit: false,
          timeoutMs: 30_000,
          updateStepTimeoutMs: 30_000,
          startedAt: Date.now(),
          progress: {},
          stop: () => undefined,
          channel: "stable",
          tag: "1.0.1",
          opts: { run: { runId: update.runId, env: state.env } },
          shouldRestart: false,
          packageInstallSpec: "openclaw@1.0.1",
          packageUpdateNodeRunner: process.execPath,
          managedServiceRootRedirect: null,
          recoveryState: { triageTarget: { env: state.env } },
          prepareMutableUpdate: async () => undefined,
        },
        context: undefined,
        assertCurrent: () => undefined,
      };
      try {
        await run({
          params,
          database,
          owner: () => {
            if (!owner.current) {
              throw new Error("Expected snapshot maintenance owner");
            }
            return owner.current;
          },
        });
      } finally {
        vi.restoreAllMocks();
        await owner.current?.release();
        await closeOpenClawStateDatabaseAsync();
      }
    },
  );
}

it.each([false, true])(
  "captures a settled native generation without allowing later writes to be restored (foreignWrite=%s)",
  async (foreignWrite) => {
    await withCaptureFixture(async ({ params, database }) => {
      const { backup } = await captureUpdateDatabases(params);
      expect(backup).toBeDefined();
      if (!backup) {
        throw new Error("Expected restorable snapshot");
      }
      expect(database.db.isOpen).toBe(false);
      await expect(fs.stat(`${database.path}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
      if (foreignWrite) {
        const writer = new DatabaseSync(database.path);
        try {
          writer.exec("UPDATE snapshot_witness SET value = 'later'");
        } finally {
          writer.close();
        }
      }
      const before = await fs.readFile(database.path);
      const restored = await restoreUpdateDatabaseBackup({
        backup,
        env: params.execution.opts.run!.env,
        runId: params.execution.opts.run!.runId,
        assertCurrent: params.assertCurrent,
        expectedGenerations: backup.sourceGenerations,
      });
      if (foreignWrite) {
        expect(restored).toBeNull();
        expect(backup.restoreRefusal).toContain(database.path);
        expect(await fs.readFile(database.path)).toEqual(before);
      } else {
        expect(restored).not.toBeNull();
      }
      const reader = new DatabaseSync(database.path, { readOnly: true });
      try {
        expect(reader.prepare("SELECT value FROM snapshot_witness").get()).toEqual({
          value: foreignWrite ? "later" : "original",
        });
      } finally {
        reader.close();
      }
    });
  },
);

it.each([false, true])(
  "releases snapshot admission only after worker custody settles (uncertain=%s)",
  async (uncertain) => {
    await withCaptureFixture(async ({ params, database, owner }) => {
      const failure = uncertain ? new CommandProcessCleanupError() : new Error("Snapshot failed");
      vi.spyOn(snapshots, "createUpdateDatabaseBackup").mockImplementation(async () => {
        expect(database.db.isOpen).toBe(false);
        expect(() => openOpenClawStateDatabase({ path: database.path })).toThrow(
          "read admission is closed",
        );
        // A separate native reader must not encounter the probe's exclusive lock.
        const reader = new DatabaseSync(database.path, { readOnly: true });
        try {
          expect(reader.prepare("SELECT value FROM snapshot_witness").get()).toEqual({
            value: "original",
          });
        } finally {
          reader.close();
        }
        throw failure;
      });
      await expect(captureUpdateDatabases(params)).rejects.toBe(failure);
      if (uncertain) {
        await fs.access(owner().stateLockPath);
        expect(() => owner().run(() => openOpenClawStateDatabase({ path: database.path }))).toThrow(
          "read admission is closed",
        );
      } else {
        await expect(fs.access(owner().stateLockPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(openOpenClawStateDatabase({ path: database.path }).db.isOpen).toBe(true);
      }
    });
  },
);

it.each(["cached", "probe"] as const)(
  "keeps capture and reopening blocked until the %s native close succeeds",
  async (stage) => {
    await withCaptureFixture(async ({ params, database, owner }) => {
      const failure = new Error("Native close failed");
      const snapshot = vi.spyOn(snapshots, "createUpdateDatabaseBackup");
      if (stage === "cached") {
        vi.spyOn(database.db, "close").mockImplementation(() => {
          throw failure;
        });
      } else {
        const open = sqlite.openNodeSqliteDatabase;
        vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((filename, options) => {
          const handle = open(filename, options);
          if (filename === sqlite.resolveExistingSqliteFileUri(database.path)) {
            vi.spyOn(handle, "close").mockImplementation(() => {
              throw failure;
            });
          }
          return handle;
        });
      }
      await expect(captureUpdateDatabases(params)).rejects.toThrow();
      expect(snapshot).not.toHaveBeenCalled();
      await expect(owner().release()).rejects.toThrow();
      await fs.access(owner().stateLockPath);
      expect(() => owner().run(() => openOpenClawStateDatabase({ path: database.path }))).toThrow(
        "read admission is closed",
      );
      vi.restoreAllMocks();
      await owner().release();
      await expect(fs.access(owner().stateLockPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(openOpenClawStateDatabase({ path: database.path }).db.isOpen).toBe(true);
    });
  },
);

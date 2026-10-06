import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqliteLibrary from "./bun-sqlite-library.js";
import {
  openNodeSqliteDatabase,
  requireNodeSqlite,
  resolveImmutableSqliteFileUri,
} from "./node-sqlite.js";
import * as checkpointWorkers from "./sqlite-wal-checkpoint-worker.js";
import { runSqliteWalWorkerMaintenance } from "./sqlite-wal-maintenance-driver.js";
import {
  bindSqliteWalPeriodicAdmission,
  startSqliteWalWorkerMaintenance,
} from "./sqlite-wal-periodic.js";
import { SQLITE_WAL_RECYCLING_BYTES, SQLITE_WAL_RESTART_BYTES } from "./sqlite-wal-policy.js";
import { configureSqliteWalMaintenance } from "./sqlite-wal.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";
import {
  createSqliteWorkerWalContext,
  type SqliteWorkerWalLease,
} from "./sqlite-worker-wal-context.js";
import { createSqliteWorkerWalRegistry } from "./sqlite-worker-wal-registry.js";
import { captureRetainedNativeWorkerSource } from "./worker-native-lifecycle.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const registry = createSqliteWorkerWalRegistry();
afterAll(() => registry.close());
afterEach(() => vi.restoreAllMocks());

function fixture(owner = registry) {
  const databasePath = path.join(tempDirs.make("openclaw-checkpoint-worker-"), "state.sqlite");
  const { DatabaseSync } = requireNodeSqlite();
  // oxlint-disable-next-line typescript/unbound-method -- The guard supplies the original database receiver with .call below.
  const nativePrepare = DatabaseSync.prototype.prepare;
  let rejectInline = true;
  const guard = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (rejectInline && /\bwal_checkpoint\s*\((?!\s*NOOP\b)/i.test(sql)) {
      throw new Error("Checkpoint I/O reached the owning writer thread");
    }
    return nativePrepare.call(this, sql);
  });
  const actors = new Set([1, 2]);
  const failures: Error[] = [];
  const host = owner.createSlot({
    assertCurrent(actor) {
      if (!actors.has(actor)) {
        throw new Error("Fixture actor retired");
      }
    },
    onFailure: (error) => failures.push(error),
  });
  const context = createSqliteWorkerWalContext(host.port);
  const first = context.forActor(1);
  let lease: SqliteWorkerWalLease | undefined;
  const register = first.register.bind(first);
  // Capture the real native-handle lease to exercise another actor borrowing that same handle.
  vi.spyOn(first, "register").mockImplementation((...args) => {
    lease = register(...args);
    return lease;
  });
  const writer = openNodeSqliteDatabase(databasePath);
  const maintenance = first.run(() => configureSqliteWalMaintenance(writer, { databasePath }));
  writer.exec("CREATE TABLE events(value TEXT); INSERT INTO events VALUES('committed')");
  let granted: number | undefined;
  const admit = (actor: number) => {
    if (granted !== actor) {
      throw new Error("Vacuum did not retain its current actor grant");
    }
  };
  const runAdmitted = <T>(actor: number, operation: () => T): T => {
    const previous = granted;
    granted = actor;
    try {
      return context.forActor(actor).run(operation);
    } finally {
      granted = previous;
    }
  };
  const bind = (actor: number) =>
    context
      .forActor(actor)
      .run(() => bindSqliteWalPeriodicAdmission(maintenance, () => admit(actor)));
  bind(1);
  const runPass = (actor: number, receipt: Parameters<typeof host.runPass>[1]) =>
    host.runPass(actor, receipt, async (unit) => {
      runAdmitted(actor, () => context.runUnit(actor, unit));
    });
  const checkpoint = async (actor = 1) => {
    await context.joinTransitions();
    const dispatched = context
      .forActor(actor)
      .run(() =>
        startSqliteWalWorkerMaintenance(
          maintenance,
          { maxPages: 0, checkpointMode: "PASSIVE" },
          () => admit(actor),
        ),
      );
    return dispatched.kind === "complete" ? dispatched.result : runPass(actor, dispatched.receipt);
  };
  return {
    databasePath,
    writer,
    maintenance,
    context,
    actors,
    failures,
    bind,
    checkpoint,
    runAdmitted,
    runPass,
    get lease() {
      if (!lease) {
        throw new Error("Native WAL handle did not register its lease");
      }
      return lease;
    },
    async close() {
      rejectInline = false;
      try {
        await maintenance.stop();
        maintenance.close();
      } finally {
        writer.close();
        await host.close();
        await context.close();
        guard.mockRestore();
      }
    },
  };
}

it("backfills committed WAL through the native maintenance owner without checkpointing on the writer thread", async () => {
  const f = fixture();
  try {
    expect(f.writer.prepare("PRAGMA wal_autocheckpoint").get()?.wal_autocheckpoint).toBe(0);
    const result = await f.checkpoint();
    expect(result.checkpoint?.health.state).toBe("complete");
    expect(result.checkpoint?.health.logFrames).toBeGreaterThan(0);
    expect(result.checkpoint?.health.checkpointedFrames).toBe(result.checkpoint?.health.logFrames);
    // Immutable reads ignore the WAL, proving backfill reached the main database bytes.
    const backfilled = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(f.databasePath), {
      readOnly: true,
    });
    try {
      expect(backfilled.prepare("SELECT value FROM events").get()?.value).toBe("committed");
    } finally {
      backfilled.close();
    }
    expect(f.failures).toEqual([]);
  } finally {
    await f.close();
  }
});

it("joins stopped and refused admissions without poisoning a live checkpoint connection", async () => {
  const f = fixture();
  const cancelledPath = path.join(path.dirname(f.databasePath), "cancelled.sqlite");
  const refusedPath = path.join(path.dirname(f.databasePath), "refused.sqlite");
  const cancelledDb = openNodeSqliteDatabase(cancelledPath);
  const refusedDb = openNodeSqliteDatabase(refusedPath);
  let cancelled: SqliteWorkerWalLease | undefined;
  let refused: SqliteWorkerWalLease | undefined;
  const register = (databasePath: string) => {
    const identity = readDatabasePathIdentitySync(databasePath);
    return f.context.forActor(2).register(
      {
        databasePath: identity.canonicalPath,
        identity: identity.key,
        birthtime: identity.birthtime,
      },
      () => {},
    );
  };
  try {
    expect((await f.checkpoint()).checkpoint?.health.state).toBe("complete");
    await f.context.joinTransitions();
    cancelledDb.exec("PRAGMA journal_mode=WAL; CREATE TABLE entries(value TEXT)");
    cancelled = register(cancelledPath);
    const stopped = cancelled.stop();
    await expect(cancelled.ready).rejects.toThrow("revoked");
    await stopped;
    await expect(f.context.joinTransitions()).resolves.toBeUndefined();

    // A real worker handler refuses this rollback-journal target after opening it.
    refusedDb.exec("CREATE TABLE entries(value TEXT)");
    refused = register(refusedPath);
    await expect(refused.ready).rejects.toThrow("admitted WAL database");
    await refused.stop();
    await expect(f.context.joinTransitions()).resolves.toBeUndefined();
    f.writer.exec("INSERT INTO events VALUES('survived refusal')");
    expect((await f.checkpoint()).checkpoint?.health.state).toBe("complete");
    expect(f.writer.prepare("SELECT count(*) AS count FROM events").get()?.count).toBe(2);
    expect(f.failures).toEqual([]);
  } finally {
    try {
      await Promise.all([cancelled?.stop(), refused?.stop()]);
    } finally {
      cancelledDb.close();
      refusedDb.close();
      await f.close();
    }
  }
});

it("retains reader-pinned oversized WAL and recycles it after reader release and the next commit", async () => {
  const f = fixture();
  const reader = openNodeSqliteDatabase(f.databasePath, { readOnly: true });
  try {
    // Pin uncheckpointed frames before yielding to the carrier's first native admission.
    reader.exec("BEGIN");
    expect(reader.prepare("SELECT value FROM events").get()?.value).toBe("committed");
    // Only allocation changes: the live WAL header and shared-memory frame count stay native-owned.
    fs.truncateSync(`${f.databasePath}-wal`, SQLITE_WAL_RESTART_BYTES + 4096);
    const pinned = await f.checkpoint();
    expect(pinned.checkpoint?.health.state).toBe("blocked");
    expect(pinned.checkpoint?.health.logFrames).toBeGreaterThan(0);
    expect(pinned.checkpoint?.health.checkpointedFrames).toBe(pinned.checkpoint?.health.logFrames);
    expect(fs.statSync(`${f.databasePath}-wal`).size).toBeGreaterThan(SQLITE_WAL_RESTART_BYTES);
    expect(reader.prepare("SELECT value FROM events").get()?.value).toBe("committed");
    reader.exec("ROLLBACK");
    const released = await f.checkpoint();
    expect(released.checkpoint?.health.state).toBe("complete");
    f.writer.exec("INSERT INTO events VALUES('after reader')");
    expect(fs.statSync(`${f.databasePath}-wal`).size).toBeLessThanOrEqual(
      SQLITE_WAL_RECYCLING_BYTES,
    );
    expect(f.writer.prepare("SELECT count(*) AS count FROM events").get()?.count).toBe(2);
    expect(f.writer.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
    expect(f.failures).toEqual([]);
  } finally {
    if (reader.isTransaction) {
      reader.exec("ROLLBACK");
    }
    reader.close();
    await f.close();
  }
});

it("keeps a shared native lease after its first actor retires and cancels that actor's queued maintenance", async ({
  signal,
}) => {
  const f = fixture();
  try {
    await f.lease.ready;
    const queued = createDeferred();
    const stale = f.lease.startPass(async () => {
      const unit = f.lease.schedule(() =>
        f.writer.exec("INSERT INTO events VALUES('stale actor')"),
      );
      queued.resolve();
      await unit;
      return { reclaimedPages: 0 };
    }, false);
    await withinTest(queued.promise, signal);
    f.bind(2);
    await expect(stale.result).rejects.toThrow("lost its actor");
    f.context.retireActor(1);
    f.actors.delete(1);
    const current = f.lease.startPass(async () => {
      await f.lease.schedule(() => f.writer.exec("INSERT INTO events VALUES('current actor')"));
      return { reclaimedPages: 0 };
    }, true);
    await f.runPass(2, current.receipt);
    const checkpoint = await f.checkpoint(2);
    expect(checkpoint.checkpoint?.health.state).toBe("complete");
    expect(
      f.writer.prepare("SELECT group_concat(value, ',') AS valuesText FROM events").get()
        ?.valuesText,
    ).toBe("committed,current actor");
    await f.maintenance.stop();
    expect(() => f.lease.assertCurrent()).toThrow("closed");
    expect(() => f.context.forActor(2).run(() => f.lease.bind())).toThrow("closed");
    await expect(f.context.forActor(2).run(() => f.lease.checkpoint())).rejects.toThrow("closed");
    expect(f.failures).toEqual([]);
  } finally {
    await f.close();
  }
});

it.for([true, false])(
  "shares one replacement checkpoint connection across native close (explicit: %s)",
  async (explicitClose, { signal }) => {
    vi.spyOn(sqliteLibrary, "captureSqliteWorkerClosePolicy").mockReturnValue(explicitClose);
    const retainedOwners = vi.spyOn(
      captureRetainedNativeWorkerSource({ runtimeGeneration: undefined }),
      "retain",
    );
    const entered = createDeferred();
    const resume = createDeferred();
    const retired = vi.fn();
    const create = checkpointWorkers.createSqliteWalCheckpointWorker;
    vi.spyOn(checkpointWorkers, "createSqliteWalCheckpointWorker").mockImplementation((options) => {
      const carrier = create(options);
      const close = carrier.close;
      vi.spyOn(carrier, "close").mockImplementation(async (owner) => {
        await close(owner);
        // Hold the close receipt so both slots await the same registry entry after native cleanup.
        entered.resolve();
        await resume.promise;
      });
      const stop = carrier.stop;
      vi.spyOn(carrier, "stop").mockImplementation(async () => {
        await stop();
        retired();
      });
      return carrier;
    });
    const owner = createSqliteWorkerWalRegistry();
    const f = fixture(owner);
    const peers = [1, 2].map(() => {
      const admitted = createDeferred();
      const host = owner.createSlot({
        assertCurrent: () => admitted.resolve(),
        onFailure: (error) => f.failures.push(error),
      });
      return { host, admitted, context: createSqliteWorkerWalContext(host.port) };
    });
    let stopped: Promise<void> | undefined;
    try {
      await f.lease.ready;
      stopped = f.maintenance.stop();
      await withinTest(entered.promise, signal);
      const identity = readDatabasePathIdentitySync(f.databasePath);
      const leases = peers.map(({ context }) =>
        context.forActor(1).register(
          {
            databasePath: identity.canonicalPath,
            identity: identity.key,
            birthtime: identity.birthtime,
          },
          () => {},
        ),
      );
      await withinTest(Promise.all(peers.map(({ admitted }) => admitted.promise)), signal);
      resume.resolve();
      await stopped;
      if (!explicitClose) {
        expect(retired).toHaveBeenCalled();
      }
      await Promise.all(leases.map((lease) => lease.ready));
      expect(retainedOwners).toHaveBeenCalledTimes(1);
      for (const lease of leases) {
        expect((await lease.checkpoint())?.health.state).toBe("complete");
      }
      await leases[0]!.stop();
      f.writer.exec("INSERT INTO events VALUES('replacement survived')");
      expect((await leases[1]!.checkpoint())?.health.state).toBe("complete");
      expect(f.failures).toEqual([]);
    } finally {
      resume.resolve();
      await stopped;
      await owner.close();
      for (const peer of peers) {
        await peer.context.close();
        await peer.host.close();
      }
      await f.close();
    }
  },
);

it("continues recovery for a live database when another lease stops during readmission", async ({
  signal,
}) => {
  const entered = createDeferred();
  const resume = createDeferred();
  const create = checkpointWorkers.createSqliteWalCheckpointWorker;
  let generation = 0;
  let fail = (_error: unknown): void => {
    throw new Error("Initial checkpoint carrier did not open");
  };
  vi.spyOn(checkpointWorkers, "createSqliteWalCheckpointWorker").mockImplementation((options) => {
    const carrier = create(options);
    generation++;
    if (generation === 1) {
      fail = options.onFailure;
    }
    if (generation === 2) {
      const open = carrier.open;
      vi.spyOn(carrier, "open").mockImplementationOnce(async (facts) => {
        entered.resolve();
        await resume.promise;
        await open(facts);
      });
    }
    return carrier;
  });
  const owner = createSqliteWorkerWalRegistry();
  const f = fixture(owner);
  const peerPath = path.join(path.dirname(f.databasePath), "peer.sqlite");
  const peerDatabase = openNodeSqliteDatabase(peerPath);
  let peer: SqliteWorkerWalLease | undefined;
  let stopped: Promise<void> | undefined;
  try {
    await f.lease.ready;
    peerDatabase.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE events(value TEXT)",
    );
    const identity = readDatabasePathIdentitySync(peerPath);
    peer = f.context.forActor(2).register(
      {
        databasePath: identity.canonicalPath,
        identity: identity.key,
        birthtime: identity.birthtime,
      },
      () => {},
    );
    await peer.ready;
    fail(new Error("Fixture checkpoint transport loss"));
    await withinTest(entered.promise, signal);
    stopped = f.maintenance.stop();
    resume.resolve();
    await withinTest(stopped, signal);
    peerDatabase.exec("INSERT INTO events VALUES('survived recovery')");
    expect((await withinTest(peer.checkpoint(), signal))?.health.state).toBe("complete");
    expect(f.failures).toEqual([]);
  } finally {
    resume.resolve();
    await stopped;
    await owner.close();
    await peer?.stop();
    peerDatabase.close();
    await f.close();
  }
});

it("keeps writer queues available across checkpoints and joins idle maintenance and cancelled close", async ({
  signal,
}) => {
  let gate:
    | {
        entered: ReturnType<typeof createDeferred<void>>;
        resume: ReturnType<typeof createDeferred<void>>;
      }
    | undefined;
  let target: string | undefined;
  const create = checkpointWorkers.createSqliteWalCheckpointWorker;
  vi.spyOn(checkpointWorkers, "createSqliteWalCheckpointWorker").mockImplementation((options) => {
    const carrier = create(options);
    const checkpoint = carrier.checkpoint.bind(carrier);
    vi.spyOn(carrier, "checkpoint").mockImplementation(async (owner) => {
      const waiting = owner.identity === target ? gate : undefined;
      if (waiting) {
        waiting.entered.resolve();
        await waiting.resume.promise;
      }
      return checkpoint(owner);
    });
    return carrier;
  });
  const broker = new SqliteWorkerBroker();
  const root = tempDirs.make("openclaw-checkpoint-fifo-");
  const file = path.join(root, "writer.sqlite");
  const peerFile = path.join(root, "peer.sqlite");
  const moduleUrl = new URL("./sqlite-worker-store.test-support.ts", import.meta.url);
  const cancelled = new AbortController();
  const pending: Promise<unknown>[] = [];
  try {
    const writer = await broker.open<FixtureOperations>({
      databasePath: file,
      moduleUrl,
      input: { type: "wal" },
    });
    const peer = await broker.open<FixtureOperations>({
      databasePath: peerFile,
      moduleUrl,
      input: { type: "wal" },
    });
    if (!writer || !peer) {
      throw new Error("WAL fixture writers did not open");
    }
    const admit = createSqliteWorkerWriteAdmission(() => {}, [file]);
    const admitPeer = createSqliteWorkerWriteAdmission(() => {}, [peerFile]);
    target = readDatabasePathIdentitySync(file).key;
    gate = { entered: createDeferred(), resume: createDeferred() };
    const maintenance = broker.runOperation(
      writer,
      (scope) => runSqliteWalWorkerMaintenance(scope, { maxPages: 8, checkpointMode: "PASSIVE" }),
      undefined,
      () => {},
      admit,
    );
    pending.push(maintenance);
    await withinTest(
      awaitGateBeforeSettlement(
        gate.entered.promise,
        maintenance,
        "Maintenance finished before its checkpoint gate",
      ),
      signal,
    );
    const writes = await withinTest(
      Promise.all([
        broker.runOperation(
          writer,
          (scope) => scope.execute({ type: "append", input: { value: "same slot" } }),
          undefined,
          () => {},
          admit,
        ),
        broker.runOperation(
          peer,
          (scope) => scope.execute({ type: "append", input: { value: "other slot" } }),
          undefined,
          () => {},
          admitPeer,
        ),
      ]),
      signal,
    );
    expect(writes[0].threadId).not.toBe(writes[1].threadId);
    gate.resume.resolve();
    const completed = await withinTest(maintenance, signal);
    expect(completed.reclaimedPages).toBeGreaterThan(0);
    expect(completed.checkpoint?.health.state).toBe("complete");

    gate = { entered: createDeferred(), resume: createDeferred() };
    const interrupted = broker.runOperation(
      writer,
      (scope) =>
        runSqliteWalWorkerMaintenance(
          scope,
          { maxPages: 8, checkpointMode: "PASSIVE" },
          { signal: cancelled.signal },
        ),
      undefined,
      () => {},
      admit,
    );
    pending.push(interrupted);
    await withinTest(
      awaitGateBeforeSettlement(
        gate.entered.promise,
        interrupted,
        "Cancelled pass did not reach its checkpoint",
      ),
      signal,
    );
    cancelled.abort(new Error("Fixture cancelled maintenance"));
    let closed = false;
    const closing = writer.close().then(() => {
      closed = true;
    });
    pending.push(closing);
    await broker.runOperation(
      peer,
      (scope) => scope.execute({ type: "append", input: { value: "close remains pending" } }),
      undefined,
      () => {},
      admitPeer,
    );
    expect(closed).toBe(false);
    gate.resume.resolve();
    await expect(withinTest(interrupted, signal)).rejects.toThrow("cancelled maintenance");
    await withinTest(closing, signal);
    const committed = openNodeSqliteDatabase(file, { readOnly: true });
    try {
      expect(committed.prepare("SELECT value FROM entries ORDER BY id").all()).toEqual([
        { value: "same slot" },
      ]);
    } finally {
      committed.close();
    }
  } finally {
    gate?.resume.resolve();
    cancelled.abort();
    await Promise.allSettled(pending);
    await broker.close();
  }
});

it("starts fresh backfill after a consumed receipt while the previous finish acknowledgement is delayed", async ({
  signal,
}) => {
  const f = fixture();
  await f.lease.ready;
  let finishId: number | undefined;
  let acknowledge: (() => void) | undefined;
  const withheld = createDeferred();
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply keeps the captured port receiver for delayed delivery.
  const postMessage = MessagePort.prototype.postMessage;
  const transport = vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(function (
    this: MessagePort,
    ...args: Parameters<MessagePort["postMessage"]>
  ) {
    const message: unknown = args[0];
    if (isRecord(message)) {
      if (
        message.type === "finishPass" &&
        finishId === undefined &&
        typeof message.id === "number"
      ) {
        finishId = message.id;
      }
      if (
        message.type === "result" &&
        message.id === finishId &&
        message.ok === true &&
        Object.hasOwn(message, "checkpoint") &&
        !acknowledge
      ) {
        acknowledge = () => Reflect.apply(postMessage, this, args);
        withheld.resolve();
        return;
      }
    }
    Reflect.apply(postMessage, this, args);
  });
  const start = () =>
    f.context
      .forActor(1)
      .run(() =>
        startSqliteWalWorkerMaintenance(f.maintenance, { maxPages: 0, checkpointMode: "PASSIVE" }),
      );
  try {
    const first = start();
    if (first.kind !== "pending") {
      throw new Error("Native maintenance did not return its pass receipt");
    }
    await withinTest(f.runPass(1, first.receipt), signal);
    await withinTest(withheld.promise, signal);
    f.writer.exec("INSERT INTO events VALUES('after first receipt')");
    const second = start();
    if (second.kind !== "pending") {
      throw new Error("Second native maintenance did not return its pass receipt");
    }
    expect(second.receipt.pass).not.toBe(first.receipt.pass);
    expect((await withinTest(f.runPass(1, second.receipt), signal)).checkpoint?.health.state).toBe(
      "complete",
    );
    const backfilled = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(f.databasePath), {
      readOnly: true,
    });
    try {
      expect(backfilled.prepare("SELECT value FROM events ORDER BY rowid").all()).toEqual([
        { value: "committed" },
        { value: "after first receipt" },
      ]);
    } finally {
      backfilled.close();
    }
  } finally {
    acknowledge?.();
    transport.mockRestore();
    await f.close();
  }
});

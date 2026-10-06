import { MessageChannel, type MessagePort } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { captureSqliteWorkerClosePolicy } from "./bun-sqlite-library.js";
import type { RuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import { throwSqliteLifecycleErrors } from "./sqlite-lifecycle-errors.js";
import { createSqliteWalCheckpointWorker } from "./sqlite-wal-checkpoint-worker.js";
import type { SqliteWalCheckpointSnapshot } from "./sqlite-wal-checkpoint.js";
import type { SqliteWalPeriodicResult } from "./sqlite-wal-write-admission.js";
import { assertExistingDatabaseIdentity } from "./sqlite-worker-identity.js";
import type {
  SqliteWorkerWalFacts,
  SqliteWalMaintenanceReceipt,
  SqliteWorkerWalReply,
  SqliteWorkerWalRequest,
} from "./sqlite-worker-wal.types.js";
import { SqliteWorkerWalAdmissionRefusedError } from "./sqlite-worker-wal.types.js";
import { captureRetainedNativeWorkerSource } from "./worker-native-lifecycle.js";
import { WorkerTaskError } from "./worker-task-pool.js";

type Carrier = ReturnType<typeof createSqliteWalCheckpointWorker>;
type Lease = {
  physical: Physical;
  authority: Int32Array<SharedArrayBuffer>;
  observe(snapshot: SqliteWalCheckpointSnapshot): void;
};
type Physical = {
  facts: SqliteWorkerWalFacts;
  revision: number;
  authority: Int32Array<SharedArrayBuffer>;
  group: Group;
  leases: Set<Lease>;
  ready: Promise<void>;
  closing?: Promise<void>;
};
type Group = {
  key: string;
  bucket: Bucket;
  sealed: boolean;
  closing?: Promise<void>;
  entries: Map<string, Physical>;
  carrier?: Carrier;
  recovery?: Promise<void>;
};
type Bucket = {
  generation?: RuntimeWorkerGeneration;
  groups: Map<string, Group>;
  sealed: boolean;
  closing?: Promise<void>;
};
type Pass = {
  receipt: SqliteWalMaintenanceReceipt;
  actor: number;
  claims: number;
  consumers: number;
  completed: boolean;
  result: Deferred<SqliteWalPeriodicResult>;
  drivers: Set<(unit: number) => Promise<void>>;
};
type Unit = { id: number; pass: Pass; claimed: boolean };
export type SqliteWorkerWalSlot = {
  port: MessagePort;
  runPass(
    actor: number,
    receipt: SqliteWalMaintenanceReceipt,
    executeUnit: (unit: number) => Promise<void>,
  ): Promise<SqliteWalPeriodicResult>;
  takeUnits(actor: number): number[];
  ackUnit(unit: number, error?: Error): void;
  revoke(): void;
  close(): Promise<void>;
};
const log = createSubsystemLogger("infra/sqlite-wal");

/** Checkpoint leases belong to the existing broker's physical actors, including their participants. */
export function createSqliteWorkerWalRegistry() {
  const buckets = new Map<RuntimeWorkerGeneration | undefined, Bucket>();
  const explicitClose = captureSqliteWorkerClosePolicy();
  let sealed = false;
  let revision = 0;
  const live = (entry: Physical) =>
    [...entry.leases].some((lease) => Atomics.load(lease.authority, 0) === 1);
  const closeGroup = (group: Group): Promise<void> => {
    group.sealed = true;
    for (const entry of group.entries.values()) {
      Atomics.store(entry.authority, 0, 0);
      for (const lease of entry.leases) {
        Atomics.store(lease.authority, 0, 0);
      }
    }
    return (group.closing ??= (async () => {
      await group.recovery?.catch(() => {});
      await group.carrier?.stop();
      const carriers = group.bucket.groups;
      if (carriers.get(group.key) === group) {
        carriers.delete(group.key);
      }
    })().catch((error: unknown) => {
      group.closing = undefined;
      throw error;
    }));
  };
  const closeBucket = (bucket: Bucket): Promise<void> => {
    bucket.sealed = true;
    return (bucket.closing ??= (async () => {
      const results = await Promise.allSettled([...bucket.groups.values()].map(closeGroup));
      throwSqliteLifecycleErrors(
        results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        "SQLite checkpoint generation cleanup failed",
      );
      if (buckets.get(bucket.generation) === bucket) {
        buckets.delete(bucket.generation);
      }
    })().catch((error: unknown) => {
      bucket.closing = undefined;
      throw error;
    }));
  };
  const openEntry = (entry: Physical, carrier: Carrier) => {
    entry.revision = ++revision;
    entry.authority = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    Atomics.store(entry.authority, 0, 1);
    return (entry.ready = carrier.open({
      ...entry.facts,
      revision: entry.revision,
      authority: entry.authority.buffer,
      leases: [...entry.leases].map((lease) => lease.authority.buffer),
    }));
  };
  const createCarrier = (group: Group): Carrier =>
    createSqliteWalCheckpointWorker({
      runtimeGeneration: group.bucket.generation,
      onObservation(observation) {
        const entry = group.entries.get(observation.identity);
        if (entry?.revision !== observation.revision || entry.closing) {
          return;
        }
        for (const lease of entry.leases) {
          if (Atomics.load(lease.authority, 0) === 1) {
            lease.observe(observation.checkpoint);
          }
        }
      },
      onFailure(error) {
        if (group.sealed || group.recovery) {
          return;
        }
        const carrier = group.carrier!;
        // Never reuse a failed native generation or let an old result publish into its replacement.
        for (const entry of group.entries.values()) {
          Atomics.store(entry.authority, 0, 0);
        }
        const recovery = runInDetachedAsyncContext(async () => {
          await carrier.stop();
          if (group.sealed || group.carrier !== carrier) {
            return;
          }
          group.carrier = createCarrier(group);
          for (const entry of group.entries.values()) {
            if (!group.sealed && !entry.closing && live(entry)) {
              assertExistingDatabaseIdentity(
                entry.facts.databasePath,
                entry.facts.identity,
                entry.facts.birthtime,
              );
              try {
                await openEntry(entry, group.carrier);
              } catch (admissionError) {
                // open() joins refused-admission cleanup; release() cannot join until recovery ends.
                if (
                  (!entry.closing && live(entry)) ||
                  !(
                    admissionError instanceof SqliteWorkerWalAdmissionRefusedError ||
                    (admissionError instanceof WorkerTaskError && admissionError.code === "failed")
                  )
                ) {
                  throw admissionError;
                }
              }
            }
          }
        });
        group.recovery = recovery;
        void recovery.then(
          () => {
            if (group.recovery === recovery) {
              group.recovery = undefined;
            }
          },
          (cleanupError: unknown) => {
            log.error("SQLite checkpoint recovery remains unsettled", {
              error: String(error),
              cleanupError: String(cleanupError),
            });
          },
        );
      },
    });
  const groupFor = (generation: RuntimeWorkerGeneration | undefined, identity: string) => {
    if (sealed) {
      throw new Error("SQLite checkpoint registry is closing");
    }
    let bucket = buckets.get(generation);
    if (!bucket) {
      const created: Bucket = { generation, groups: new Map(), sealed: false };
      captureRetainedNativeWorkerSource({ runtimeGeneration: generation }).retain(created, () =>
        closeBucket(created),
      );
      bucket = created;
      buckets.set(generation, bucket);
    }
    if (bucket.sealed) {
      throw new Error("SQLite checkpoint generation is closing");
    }
    const carriers = bucket.groups;
    const key = explicitClose ? "shared" : identity;
    let group = carriers.get(key);
    if (!group) {
      group = { key, bucket, sealed: false, entries: new Map() };
      group.carrier = createCarrier(group);
      carriers.set(key, group);
    }
    return group;
  };
  const ready = async (entry: Physical) => {
    await entry.group.recovery;
    try {
      await entry.ready;
    } catch (error) {
      if (!entry.group.recovery) {
        throw error;
      }
      await entry.group.recovery;
      await entry.ready;
    }
    if (entry.group.sealed || entry.closing || !live(entry)) {
      throw new Error("SQLite checkpoint leases have been revoked");
    }
    return entry.group.carrier!;
  };
  const release = async (lease: Lease) => {
    const entry = lease.physical;
    Atomics.store(lease.authority, 0, 0);
    entry.leases.delete(lease);
    if (entry.leases.size > 0) {
      // The revoked latch is already visible to native I/O; the next admission prunes it.
      return;
    }
    Atomics.store(entry.authority, 0, 0);
    await (entry.closing ??= (async () => {
      await entry.group.recovery?.catch(() => {});
      await entry.ready.catch(() => {});
      await entry.group.carrier!.close({
        identity: entry.facts.identity,
        revision: entry.revision,
      });
      entry.group.entries.delete(entry.facts.identity);
      if (!explicitClose && entry.group.entries.size === 0) {
        await closeGroup(entry.group);
      }
    })().catch((error: unknown) => {
      entry.closing = undefined;
      throw error;
    }));
  };
  return {
    createSlot(options: {
      runtimeGeneration?: RuntimeWorkerGeneration;
      assertCurrent(actor: number): void;
      onFailure(error: Error): void;
    }): SqliteWorkerWalSlot {
      const { port1: host, port2: port } = new MessageChannel();
      const leases = new Map<number, Lease>();
      const passes = new Map<number, Pass>();
      const units = new Map<number, Unit>();
      let revoked = false;
      let tail = Promise.resolve();
      let closing: Promise<void> | undefined;
      const reply = (message: SqliteWorkerWalReply) => host.postMessage(message, []);
      const assertCurrent = (actor: number) => {
        if (revoked) {
          throw new Error("SQLite WAL slot is retired");
        }
        options.assertCurrent(actor);
      };
      const passFor = (actor: number, receipt: SqliteWalMaintenanceReceipt) => {
        let pass = passes.get(receipt.pass);
        if (pass && (pass.actor !== actor || pass.receipt.lease !== receipt.lease)) {
          throw new Error("SQLite WAL maintenance receipt changed its owner");
        }
        if (!pass) {
          pass = {
            receipt,
            actor,
            claims: 0,
            consumers: 0,
            completed: false,
            result: createDeferredCore(),
            drivers: new Set(),
          };
          void pass.result.promise.catch(() => {});
          passes.set(receipt.pass, pass);
        }
        return pass;
      };
      const forgetPass = (pass: Pass) => {
        if (pass.completed && pass.consumers >= pass.claims && pass.drivers.size === 0) {
          passes.delete(pass.receipt.pass);
        }
      };
      const ackUnit = (id: number, error?: Error) => {
        if (!units.delete(id)) {
          return;
        }
        if (!revoked) {
          try {
            reply(
              error
                ? { type: "unitAck", unit: id, ok: false, error: String(error) }
                : { type: "unitAck", unit: id, ok: true },
            );
          } catch (transportError) {
            options.onFailure(
              toErrorObject(transportError, "SQLite maintenance acknowledgement failed"),
            );
          }
        }
      };
      const driveUnit = (unit: Unit) => {
        const driver = unit.pass.drivers.values().next().value;
        if (unit.claimed || !driver) {
          return;
        }
        unit.claimed = true;
        void Promise.resolve()
          .then(() => driver(unit.id))
          .then(
            () => ackUnit(unit.id),
            (error: unknown) =>
              ackUnit(unit.id, toErrorObject(error, "SQLite maintenance unit failed")),
          );
      };
      const execute = async (request: SqliteWorkerWalRequest) => {
        if (request.type === "finishPass") {
          const pass = passes.get(request.pass);
          if (pass && pass.actor === request.actor && pass.receipt.lease === request.lease) {
            pass.completed = true;
            for (const unit of units.values()) {
              if (unit.pass === pass) {
                ackUnit(unit.id, new Error("SQLite maintenance pass settled"));
              }
            }
            if (request.ok) {
              pass.result.resolve(request.result);
            } else {
              pass.result.reject(new Error(request.error));
            }
            forgetPass(pass);
          }
          return undefined;
        }
        if (request.type === "close") {
          const lease = leases.get(request.lease);
          if (lease) {
            await release(lease);
            leases.delete(request.lease);
            for (const unit of units.values()) {
              if (unit.pass.receipt.lease === request.lease) {
                ackUnit(unit.id, new Error("SQLite maintenance lease closed"));
              }
            }
            for (const pass of passes.values()) {
              if (pass.receipt.lease === request.lease) {
                pass.result.reject(new Error("SQLite maintenance lease closed"));
                passes.delete(pass.receipt.pass);
              }
            }
          }
          return undefined;
        }
        if (request.type === "open" && Atomics.load(new Int32Array(request.authority), 0) !== 1) {
          throw new SqliteWorkerWalAdmissionRefusedError(
            "SQLite WAL lease was revoked before admission",
          );
        }
        assertCurrent(request.actor);
        if (request.type === "open") {
          if (leases.has(request.lease)) {
            throw new Error("SQLite WAL lease is already registered");
          }
          assertExistingDatabaseIdentity(
            request.facts.databasePath,
            request.facts.identity,
            request.facts.birthtime,
          );
          const authority = new Int32Array(request.authority);
          if (Atomics.load(authority, 0) !== 1) {
            throw new SqliteWorkerWalAdmissionRefusedError(
              "SQLite WAL lease was revoked before admission",
            );
          }
          let group: Group;
          let entry: Physical | undefined;
          for (;;) {
            assertCurrent(request.actor);
            group = groupFor(options.runtimeGeneration, request.facts.identity);
            await group.recovery;
            if (group.closing) {
              await group.closing;
              continue;
            }
            if (group.sealed) {
              throw new Error("SQLite checkpoint generation is closing");
            }
            entry = group.entries.get(request.facts.identity);
            if (!entry?.closing) {
              break;
            }
            await entry.closing;
          }
          assertCurrent(request.actor);
          if (group.sealed) {
            throw new Error("SQLite checkpoint generation is closing");
          }
          if (Atomics.load(authority, 0) !== 1) {
            throw new SqliteWorkerWalAdmissionRefusedError(
              "SQLite WAL lease was revoked during admission",
            );
          }
          const created = !entry;
          if (!entry) {
            entry = {
              facts: request.facts,
              revision: 0,
              authority: new Int32Array(new SharedArrayBuffer(4)),
              group,
              leases: new Set(),
              ready: Promise.resolve(),
            };
            group.entries.set(request.facts.identity, entry);
          }
          const lease: Lease = {
            physical: entry,
            authority,
            observe: (checkpoint) =>
              reply({ type: "observation", lease: request.lease, checkpoint }),
          };
          leases.set(request.lease, lease);
          entry.leases.add(lease);
          if (created) {
            void openEntry(entry, group.carrier!).catch(() => {});
            await ready(entry);
          } else {
            const carrier = await ready(entry);
            await carrier.setLeases(
              { identity: entry.facts.identity, revision: entry.revision },
              [...entry.leases].map((other) => other.authority.buffer),
            );
          }
          assertCurrent(request.actor);
          return undefined;
        }
        const lease = leases.get(request.lease);
        if (!lease || Atomics.load(lease.authority, 0) !== 1) {
          return undefined;
        }
        if (request.type === "beginPass" || request.type === "claimPass") {
          const pass = passFor(request.actor, { lease: request.lease, pass: request.pass });
          if (request.type === "claimPass" || request.claim) {
            pass.claims++;
          }
          return undefined;
        }
        if (request.type === "schedule") {
          const pass = passFor(request.actor, { lease: request.lease, pass: request.pass });
          if (units.has(request.unit) || pass.completed) {
            throw new Error("SQLite maintenance unit is no longer current");
          }
          const unit: Unit = { id: request.unit, pass, claimed: false };
          units.set(unit.id, unit);
          driveUnit(unit);
          return undefined;
        }
        const carrier = await ready(lease.physical);
        assertCurrent(request.actor);
        const checkpoint = await carrier.checkpoint({
          identity: lease.physical.facts.identity,
          revision: lease.physical.revision,
        });
        assertCurrent(request.actor);
        return Atomics.load(lease.authority, 0) === 1 ? checkpoint : undefined;
      };
      host.on("message", (request: SqliteWorkerWalRequest) => {
        const operation = tail.then(() => execute(request));
        tail = operation.then(
          () => {},
          () => {},
        );
        void operation
          .then(
            (checkpoint) => reply({ type: "result", id: request.id, ok: true, checkpoint }),
            (error: unknown) =>
              reply({
                type: "result",
                id: request.id,
                ok: false,
                error: String(error),
                ...(request.type === "open" &&
                (error instanceof SqliteWorkerWalAdmissionRefusedError ||
                  (error instanceof WorkerTaskError && error.code === "failed"))
                  ? { admissionRefused: true as const }
                  : {}),
              }),
          )
          .catch((error: unknown) => {
            if (!revoked) {
              options.onFailure(error instanceof Error ? error : new Error(String(error)));
            }
          });
      });
      host.on("messageerror", (error) => options.onFailure(error));
      host.on("close", () => {
        if (!revoked) {
          options.onFailure(new Error("SQLite WAL slot lifecycle channel closed"));
        }
      });
      host.unref();
      const actor = {
        port,
        async runPass(
          id: number,
          receipt: SqliteWalMaintenanceReceipt,
          executeUnit: (unit: number) => Promise<void>,
        ) {
          assertCurrent(id);
          const lease = leases.get(receipt.lease);
          if (!lease || Atomics.load(lease.authority, 0) !== 1) {
            throw new Error("SQLite maintenance lease is no longer current");
          }
          const pass = passFor(id, receipt);
          pass.consumers++;
          pass.drivers.add(executeUnit);
          for (const unit of units.values()) {
            if (unit.pass === pass) {
              driveUnit(unit);
            }
          }
          try {
            const result = await pass.result.promise;
            assertCurrent(id);
            if (Atomics.load(lease.authority, 0) !== 1) {
              throw new Error("SQLite maintenance lease stopped before completion");
            }
            return result;
          } finally {
            pass.drivers.delete(executeUnit);
            forgetPass(pass);
          }
        },
        takeUnits(id: number) {
          const selected: number[] = [];
          for (const unit of units.values()) {
            if (unit.pass.actor === id && !unit.claimed) {
              assertCurrent(id);
              unit.claimed = true;
              selected.push(unit.id);
              break;
            }
          }
          return selected;
        },
        ackUnit,
        revoke() {
          revoked = true;
          for (const lease of leases.values()) {
            Atomics.store(lease.authority, 0, 0);
          }
          for (const pass of passes.values()) {
            pass.result.reject(new Error("SQLite maintenance slot retired"));
          }
          passes.clear();
          units.clear();
        },
        close(): Promise<void> {
          actor.revoke();
          return (closing ??= (async () => {
            await tail;
            const results = await Promise.allSettled([...leases.values()].map(release));
            throwSqliteLifecycleErrors(
              results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
              "SQLite WAL actor cleanup failed",
            );
            leases.clear();
            host.close();
            port.close();
          })().catch((error: unknown) => {
            closing = undefined;
            throw error;
          }));
        },
      };
      return actor;
    },
    async close(): Promise<void> {
      sealed = true;
      const results = await Promise.allSettled([...buckets.values()].map(closeBucket));
      throwSqliteLifecycleErrors(
        results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        "SQLite checkpoint registry cleanup failed",
      );
      buckets.clear();
    },
  };
}

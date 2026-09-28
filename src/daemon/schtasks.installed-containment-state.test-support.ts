import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SQLOutputValue } from "node:sqlite";
import { hasErrnoCode } from "../infra/errno.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import { collectStateDatabasePaths } from "../infra/update-candidate-state.js";
import {
  inspectUpdateRecovery,
  isUpdateRecoveryPending,
} from "../infra/update-run-recovery-schema.js";
import { UpdateRunRecordSchema } from "../infra/update-run-schema.js";
import { resolveOpenClawRegisteredAgentDatabasePath } from "../state/openclaw-state-db.paths.js";
import type { InstalledTask } from "./schtasks.installed-diagnostics.test-support.js";

type Row = Record<string, SQLOutputValue>;
type HashedRow = { digest: string; key?: string; stable?: string; clocks?: bigint[] };
type Table = { name: string; rows: HashedRow[]; digest: string };
export type ContainmentDatabase = {
  identity: string;
  present: boolean;
  userVersion?: number;
  contentVersion?: number;
  schema?: string;
  tables: Table[];
  runs: Array<{
    runId: string;
    phase: string;
    status: string;
    beforeVersion: string | undefined;
    activated: boolean;
  }>;
  recoveries: Array<{
    identity: string;
    format: "current" | "legacy-serving";
    revision: number;
    pending: boolean;
    terminalStatus: "succeeded" | "rolled-back" | null;
    preparationAborted: boolean;
    effectCount: number;
    packageActivationEffects: number;
  }>;
};
export type ContainmentState = ContainmentDatabase[];
const limits = {
  databases: 32,
  tables: 512,
  rows: 100_000,
  rowBytes: 8_388_608,
  evidenceBytes: 262_144,
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
function encode(row: Row): string {
  const encoded = JSON.stringify(
    Object.entries(row)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [
        key,
        value === null
          ? ["null"]
          : value instanceof Uint8Array
            ? ["blob", Buffer.from(value).toString("base64")]
            : [typeof value, String(value)],
      ]),
  );
  assert.ok(Buffer.byteLength(encoded) <= limits.rowBytes, "Containment row exceeds capture bound");
  return encoded;
}
function text(row: Row, key: string): string {
  const value = row[key];
  assert.equal(typeof value, "string", "Containment scalar shape differs");
  return value as string;
}
function integer(value: SQLOutputValue | undefined): number {
  assert.ok(typeof value === "bigint" || typeof value === "number");
  const number = Number(value);
  assert.ok(Number.isSafeInteger(number));
  return number;
}

/** The only SQLite handle opened here points at the owner's private, disposable snapshot. */
export async function captureContainmentDatabase(
  filename: string,
  identity: string,
  shared: boolean,
  budget: { rows: number },
  signal?: AbortSignal,
): Promise<{ database: ContainmentDatabase; registered: string[] }> {
  const database: ContainmentDatabase = {
    identity,
    present: false,
    tables: [],
    runs: [],
    recoveries: [],
  };
  try {
    assert.ok((await fs.lstat(filename)).isFile(), "Containment database is not a regular file");
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return { database, registered: [] };
    }
    throw error;
  }
  const prepared = await prepareSqliteReadOnlyLocation(filename, {
    preserveSourceArtifacts: true,
    signal,
  });
  const registered: string[] = [];
  try {
    const db = openNodeSqliteDatabase(prepared.location, { readOnly: true });
    try {
      database.present = true;
      database.userVersion = integer(db.prepare("PRAGMA user_version").get()?.user_version);
      database.contentVersion = database.userVersion;
      // Dynamic schema/row inspection is a diagnostic primitive, never a live runtime query.
      const schema = db
        .prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name LIMIT 2049",
        )
        .all();
      assert.ok(schema.length <= limits.tables * 4, "Containment schema exceeds capture bound");
      database.schema = digest(schema.map(encode).join("\n"));
      for (const object of schema) {
        if (object.type !== "table") {
          continue;
        }
        assert.ok(
          database.tables.length < limits.tables,
          "Containment table count exceeds capture bound",
        );
        const name = text(object, "name");
        const rows: HashedRow[] = [];
        const statement = db.prepare(`SELECT * FROM ${quote(name)}`);
        statement.setReadBigInts(true);
        for (const row of statement.iterate()) {
          signal?.throwIfAborted();
          assert.ok(++budget.rows <= limits.rows, "Containment row count exceeds capture bound");
          const encoded = encode(row);
          const hashed: HashedRow = { digest: digest(encoded) };
          if (shared && name === "update_runs") {
            hashed.key = digest(text(row, "run_id"));
            const before = UpdateRunRecordSchema.shape.before.parse(
              JSON.parse(text(row, "before_json")),
            );
            const steps = UpdateRunRecordSchema.shape.steps.parse(
              JSON.parse(text(row, "steps_json")),
            );
            database.runs.push({
              runId: text(row, "run_id"),
              phase: UpdateRunRecordSchema.shape.phase.parse(row.phase),
              status: UpdateRunRecordSchema.shape.status.parse(row.status),
              beforeVersion: before.version === "2026.9.4" ? before.version : undefined,
              activated: steps.some((step) => step.step === "activating"),
            });
          } else if (shared && name === "config_machine_state") {
            const key = text(row, "state_key");
            hashed.key = digest(key);
            if (key === "state.schema.contentVersion") {
              const version: unknown = JSON.parse(text(row, "value_json"));
              assert.ok(
                typeof version === "number" && Number.isSafeInteger(version) && version >= 0,
              );
              database.contentVersion = Math.max(database.userVersion, version);
            }
            if (key.startsWith("update.recovery.")) {
              const runId = key.slice("update.recovery.".length);
              // Decode only for historical inspection; never carry the raw record into evidence.
              const inspected = inspectUpdateRecovery(text(row, "value_json"), runId);
              database.recoveries.push({
                identity: digest(runId),
                format: inspected.format,
                revision: inspected.record.revision,
                pending: isUpdateRecoveryPending(inspected.record),
                terminalStatus: inspected.record.terminal?.status ?? null,
                preparationAborted: inspected.record.preparationAborted !== undefined,
                effectCount: inspected.record.effects.length,
                packageActivationEffects: inspected.record.effects.filter(
                  (effect) => effect.kind === "package-activation",
                ).length,
              });
            }
          } else if (shared && name === "state_leases") {
            hashed.key = digest(
              encode({
                scope: text(row, "scope"),
                lease_key: text(row, "lease_key"),
                owner: text(row, "owner"),
              }),
            );
            const { expires_at, heartbeat_at, updated_at, ...stable } = row;
            hashed.stable = digest(encode(stable));
            const clocks = [expires_at, heartbeat_at, updated_at];
            if (clocks.every((value) => typeof value === "bigint")) {
              hashed.clocks = clocks;
            }
          } else if (shared && name === "agent_databases") {
            registered.push(text(row, "path"));
          }
          rows.push(hashed);
        }
        rows.sort((a, b) => a.digest.localeCompare(b.digest));
        database.tables.push({
          name,
          rows,
          digest: digest(rows.map((row) => row.digest).join("\n")),
        });
      }
      return { database, registered };
    } finally {
      db.close();
    }
  } finally {
    assert.equal(await prepared.cleanupAsync(), true, "Containment snapshot cleanup failed");
  }
}

export async function captureContainmentState(
  task: InstalledTask,
  signal: AbortSignal,
): Promise<ContainmentState> {
  const config = JSON.parse(await fs.readFile(task.configPath, "utf8"));
  const discovered = await collectStateDatabasePaths({
    stateDir: task.stateDir,
    config,
    env: task.env,
  });
  const shared = path.join(task.stateDir, "state", "openclaw.sqlite");
  const files = new Set([shared, ...[...discovered.values()].flatMap((item) => item.spellings)]);
  const captured = new Map<string, ContainmentDatabase>();
  const budget = { rows: 0 };
  for (const filename of files) {
    signal.throwIfAborted();
    const relative = path.relative(task.stateDir, filename);
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
      "Database escaped fixture state root",
    );
    const identity = relative.replaceAll(path.sep, "/").toLowerCase();
    if (captured.has(identity)) {
      continue;
    }
    assert.ok(captured.size < limits.databases, "Containment database count exceeds capture bound");
    const result = await captureContainmentDatabase(
      filename,
      digest(identity),
      filename === shared,
      budget,
      signal,
    );
    captured.set(identity, result.database);
    for (const registered of result.registered) {
      files.add(resolveOpenClawRegisteredAgentDatabasePath(shared, registered));
    }
  }
  assert.equal(captured.get("state/openclaw.sqlite")?.present, true);
  return [...captured.values()].toSorted((a, b) => a.identity.localeCompare(b.identity));
}

/** Exact row exceptions reflect released writers, not authority to modify or restore any state. */
export function compareContainmentState(
  before: ContainmentState,
  after: ContainmentState,
  runId?: string,
) {
  assert.deepEqual(
    before.map((db) => db.identity),
    after.map((db) => db.identity),
    "Containment database inventory changed",
  );
  let updateRows = 0;
  let recoveryRows = 0;
  let leaseRenewals = 0;
  const databases = before.map((prior, index) => {
    const current = after[index]!;
    assert.equal(current.present, prior.present, "Containment database presence changed");
    assert.equal(current.userVersion, prior.userVersion, "Containment schema version changed");
    assert.equal(
      current.contentVersion,
      prior.contentVersion,
      "Containment content version changed",
    );
    assert.equal(current.schema, prior.schema, "Containment schema changed");
    assert.deepEqual(
      current.tables.map((table) => table.name),
      prior.tables.map((table) => table.name),
    );
    const tables = prior.tables.map((table, tableIndex) => {
      const next = current.tables[tableIndex]!;
      if (table.digest !== next.digest) {
        const excludedKey =
          runId &&
          (table.name === "update_runs"
            ? digest(runId)
            : table.name === "config_machine_state"
              ? digest(`update.recovery.${runId}`)
              : undefined);
        if (excludedKey) {
          assert.equal(
            table.rows.some((row) => row.key === excludedKey),
            false,
            "Update identity already existed before command",
          );
          const added = next.rows.filter((row) => row.key === excludedKey);
          assert.equal(
            added.length,
            1,
            "Changed operational table lacks exactly one command-owned row",
          );
          assert.deepEqual(
            next.rows.filter((row) => row.key !== excludedKey),
            table.rows,
            "Unrelated operational row changed",
          );
          if (table.name === "update_runs") {
            updateRows++;
          } else {
            recoveryRows++;
          }
        } else if (table.name === "state_leases") {
          assert.equal(next.rows.length, table.rows.length, "Lease was added or removed");
          for (const oldRow of table.rows) {
            const row = next.rows.find((entry) => entry.key === oldRow.key);
            assert.ok(row, "Lease identity changed");
            if (row.digest === oldRow.digest) {
              continue;
            }
            assert.equal(row.stable, oldRow.stable, "Lease payload or creation changed");
            assert.ok(row.clocks && oldRow.clocks, "Lease renewal lacks complete clocks");
            assert.ok(
              row.clocks.every((clock, i) => clock >= oldRow.clocks![i]!),
              "Lease clock went backwards",
            );
            leaseRenewals++;
          }
        } else {
          assert.equal(next.digest, table.digest, "Logical user data changed");
        }
      }
      return {
        table: digest(table.name),
        rowsBefore: table.rows.length,
        rowsAfter: next.rows.length,
        before: table.digest,
        after: next.digest,
      };
    });
    return {
      identity: prior.identity,
      present: prior.present,
      userVersion: prior.userVersion,
      contentVersion: prior.contentVersion,
      schema: prior.schema,
      tables,
    };
  });
  if (runId) {
    assert.equal(updateRows, 1, "Expected exactly one newly admitted update run");
    const run = after.flatMap((db) => db.runs).find((entry) => entry.runId === runId);
    assert.ok(
      run && run.beforeVersion === "2026.9.4" && run.phase !== "activating" && !run.activated,
      "Update advanced beyond copied-state validation",
    );
  }
  const result = { databases, updateRows, recoveryRows, leaseRenewals };
  assert.ok(
    Buffer.byteLength(JSON.stringify(result)) <= limits.evidenceBytes,
    "Containment evidence exceeds capture bound",
  );
  return result;
}

export function summarizeContainmentState(state: ContainmentState) {
  const facts = state.map((db) => ({
    identity: db.identity,
    present: db.present,
    userVersion: db.userVersion,
    contentVersion: db.contentVersion,
    schema: db.schema,
    tables: db.tables.map((table) => ({
      table: digest(table.name),
      rows: table.rows.length,
      digest: table.digest,
    })),
    runs: db.runs.map((run) => ({
      identity: digest(run.runId),
      phase: run.phase,
      status: run.status,
      beforeVersion: run.beforeVersion,
      activated: run.activated,
    })),
    recoveries: db.recoveries,
  }));
  assert.ok(
    Buffer.byteLength(JSON.stringify(facts)) <= limits.evidenceBytes,
    "Containment evidence exceeds capture bound",
  );
  return facts;
}

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { updateRunLedgerSchema } from "../infra/update-run-write.js";
import { run, type CommandRecord } from "./schtasks.installed-command.test-support.js";
import {
  captureContainmentDatabase,
  compareContainmentState,
  summarizeContainmentState,
} from "./schtasks.installed-containment-state.test-support.js";
import * as stateObservations from "./schtasks.installed-containment-state.test-support.js";
import {
  assertContainmentRefusal,
  observeInstalledContainment,
  seedContainmentCanaries,
} from "./schtasks.installed-containment.test-support.js";
import type { InstalledTask } from "./schtasks.installed-diagnostics.test-support.js";
import * as nativeObservations from "./schtasks.integration-observation.test-support.js";

const processCapture = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawnSync: (...args: Parameters<typeof original.spawnSync>) =>
      processCapture.getMockImplementation()
        ? processCapture(...args)
        : original.spawnSync(...args),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const refusalLine =
  "[openclaw] Reason: Doctor refused update-time schema repair driven by OpenClaw 2026.9.4: this updater reopens the ledger with old code after migration, and version publication could not be deferred safely.";
const runId = "e5bd046f-91b1-4820-8645-15b33359c71f";

it("retains only complete producer-specific refusal lines from failed pre-validation steps", async () => {
  const cwd = tempDirs.make("installed-containment-command-");
  const records: CommandRecord[] = [];
  const rawReason = refusalLine.replace("[openclaw] Reason: ", "");
  const cases = [
    ["candidate migration rehearsal", 1, refusalLine, true],
    ["global update", 1, `npm error ${rawReason}`, true],
    ["global update (omit optional)", 1, `npm error ${rawReason}`, true],
    ["npm package postinstall", 1, rawReason, true],
    ["unrelated step", 1, refusalLine, false],
    ["global update", 0, `npm error ${rawReason}`, false],
    ["candidate migration rehearsal", 0, refusalLine, false],
    ["candidate migration rehearsal", 1, "schema-version", false],
    ["package update", 1, `npm error ${rawReason}`, false],
    ["npm package postinstall", 1, `npm error ${rawReason}`, false],
    ["global update", 1, `npm error prefix ${rawReason}`, false],
    ["global update", 1, `npm error ${rawReason} extra`, false],
    ["global update", 1, rawReason, false],
  ] as const;
  const payload = JSON.stringify({
    status: "error",
    runId,
    steps: cases.map(([name, exitCode, line]) => ({
      name,
      exitCode,
      stderrTail: line + "\n" + Array(4).fill("x".repeat(500)).join("\n"),
    })),
  });
  await expect(
    run(
      ["-e", `console.log(${JSON.stringify(payload)}); process.exitCode = 1`],
      { PATH: path.dirname(process.execPath) },
      cwd,
      records,
      0,
      undefined,
      { commandBudget: "published-update" },
    ),
  ).rejects.toThrow();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    code: 1,
    managedResult: 1,
    signal: null,
    joined: true,
    beforeCleanup: "dead",
    publishedUpdate: {
      status: "error",
      runId,
      steps: cases.map((entry) => ({ containmentRefusalReasonWitness: entry[3] })),
    },
  });
});

it("compares all logical data while admitting only the command row and exact lease renewals", async () => {
  const root = tempDirs.make("installed-containment-state-");
  const filename = path.join(root, "state.sqlite");
  const db = openNodeSqliteDatabase(filename);
  try {
    db.exec(`
      PRAGMA user_version=17;
      CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER);
      INSERT INTO config_machine_state VALUES('state.schema.contentVersion','17',1);
      CREATE TABLE update_runs(run_id TEXT PRIMARY KEY, phase TEXT, status TEXT, before_json TEXT, steps_json TEXT);
      INSERT INTO update_runs VALUES('prior','finished','failed','{}','[]');
      CREATE TABLE state_leases(scope TEXT, lease_key TEXT, owner TEXT, payload_json TEXT, created_at INTEGER, expires_at INTEGER, heartbeat_at INTEGER, updated_at INTEGER);
      INSERT INTO state_leases VALUES('gateway','serving','same-owner','{"canary":"lease-payload"}',1,100,10,10);
      CREATE TABLE user_notes(id INTEGER PRIMARY KEY, content TEXT, attachment BLOB);
      INSERT INTO user_notes VALUES(1,'synthetic-private-user-canary',X'000180FF');
    `);
    const capture = async () =>
      (await captureContainmentDatabase(filename, "synthetic-state", true, { rows: 0 })).database;
    const before = await capture();
    db.prepare("INSERT INTO update_runs VALUES(?,?,?,?,?)").run(
      runId,
      "finished",
      "failed",
      '{"version":"2026.9.4"}',
      '[{"step":"finalize:exit","status":"completed"}]',
    );
    db.exec("UPDATE state_leases SET expires_at=200, heartbeat_at=20, updated_at=20");
    // Terminal cleanup is not activation, and pending historical metadata is retained as data.
    db.prepare("UPDATE update_runs SET phase='validating',status='running' WHERE run_id=?").run(
      runId,
    );
    const after = await capture();
    const result = compareContainmentState([before], [after], runId);
    expect(result).toMatchObject({ updateRows: 1, recoveryRows: 0, leaseRenewals: 1 });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-user-canary");
    expect(JSON.stringify(result)).not.toContain("lease-payload");
    expect(JSON.stringify(result)).not.toContain("same-owner");
    const controls = [
      [
        "captured activating phase",
        "UPDATE update_runs SET phase='activating' WHERE run_id='e5bd046f-91b1-4820-8645-15b33359c71f'",
        "Update advanced beyond copied-state validation",
      ],
      ["user data", "UPDATE user_notes SET content='changed'", "Logical user data changed"],
      [
        "prior update row",
        "UPDATE update_runs SET before_json='{\"version\":\"changed\"}' WHERE run_id='prior'",
        "Unrelated operational row changed",
      ],
      ["blob", "UPDATE user_notes SET attachment=X'FF'", "Logical user data changed"],
      [
        "unrelated run",
        "INSERT INTO update_runs VALUES('other','finished','failed','{}','[]')",
        "Unrelated operational row changed",
      ],
      [
        "machine state",
        "INSERT INTO config_machine_state VALUES('unrelated','{}',1)",
        "Changed operational table lacks exactly one command-owned row",
      ],
      [
        "content version",
        "UPDATE config_machine_state SET value_json='18'",
        "Containment content version changed",
      ],
      ["published version", "PRAGMA user_version=18", "Containment schema version changed"],
      ["lease identity", "UPDATE state_leases SET owner='new-owner'", "Lease identity changed"],
      [
        "lease payload",
        "UPDATE state_leases SET payload_json='changed'",
        "Lease payload or creation changed",
      ],
      ["lease clock", "UPDATE state_leases SET updated_at=0", "Lease clock went backwards"],
      ["schema", "CREATE TABLE unobserved(value TEXT)", "Containment schema changed"],
    ];
    for (const [name, sql, expected] of controls) {
      try {
        db.exec(sql!);
        const changed = await capture();
        expect(() => compareContainmentState([before], [changed], runId), name).toThrow(expected);
      } finally {
        // Restore from fixture-owned SQL, not by editing a live product database.
        db.exec("DROP TABLE IF EXISTS unobserved; PRAGMA user_version=17;");
        db.exec(
          "UPDATE user_notes SET content='synthetic-private-user-canary', attachment=X'000180FF'; DELETE FROM update_runs WHERE run_id='other'; UPDATE update_runs SET before_json='{}' WHERE run_id='prior'; UPDATE update_runs SET phase='validating' WHERE run_id='e5bd046f-91b1-4820-8645-15b33359c71f'; DELETE FROM config_machine_state WHERE state_key='unrelated'; UPDATE config_machine_state SET value_json='17'; UPDATE state_leases SET owner='same-owner',payload_json='{\"canary\":\"lease-payload\"}',updated_at=20;",
        );
      }
    }
    // These are synthetic retained bytes, never a live claim or restoration grant.
    const recovery = {
      runId,
      transactionId: randomUUID(),
      revision: 0,
      claimId: randomUUID(),
      claimKind: "initial",
      handoff: null,
      from: { root, nodePath: process.execPath, version: "2026.9.4", buildId: null },
      to: { root, nodePath: process.execPath, version: "2026.9.6", buildId: null },
      createdAtMs: 1,
      updatedAtMs: 1,
      effects: [],
      restore: null,
      verification: null,
      primaryFailure: null,
    };
    const putRecovery = db.prepare(
      "INSERT INTO config_machine_state VALUES(?,?,1) ON CONFLICT(state_key) DO UPDATE SET value_json=excluded.value_json",
    );
    putRecovery.run(`update.recovery.${runId}`, JSON.stringify(recovery));
    const preparedRecovery = await capture();
    expect(compareContainmentState([before], [preparedRecovery], runId)).toMatchObject({
      recoveryRows: 1,
    });
    putRecovery.run(
      `update.recovery.${runId}`,
      JSON.stringify({
        ...recovery,
        effects: [
          {
            effectId: randomUUID(),
            kind: "package-activation",
            resourceId: root,
            runtime: "candidate",
            state: "intent",
            observedIdentity: null,
          },
        ],
      }),
    );
    const activationIntent = await capture();
    expect(activationIntent.recoveries).toMatchObject([{ packageActivationEffects: 1 }]);
    expect(() => compareContainmentState([before], [activationIntent], runId)).toThrow(
      "Recovery recorded package activation before containment",
    );
    await expect(
      captureContainmentDatabase(filename, "bounded", true, { rows: 100_000 }),
    ).rejects.toThrow("Containment row count exceeds capture bound");
    expect(() => compareContainmentState([before], [], runId)).toThrow(
      "Containment database inventory changed",
    );
    expect(() => compareContainmentState([after], [after], runId)).toThrow(
      "Expected exactly one newly admitted update run",
    );
  } finally {
    db.close();
  }
  expect(fs.readdirSync(root).toSorted()).toEqual(["state.sqlite"]);
});

it("admits only the released first-update ledger bootstrap and exact command row", async () => {
  const cases = [
    ["bootstrap", ""],
    ["unrelated table", "CREATE TABLE foreign_feature(value TEXT)"],
    ["unrelated index", "CREATE INDEX foreign_index ON update_runs(trigger)"],
    [
      "existing definition",
      "DROP INDEX user_note_index; CREATE INDEX user_note_index ON user_notes(id)",
    ],
    ["existing removal", "DROP TABLE user_notes"],
    ["incomplete ledger", "DROP INDEX idx_update_runs_active"],
    [
      "wrong index definition",
      "DROP INDEX idx_update_runs_active; CREATE INDEX idx_update_runs_active ON update_runs(status)",
    ],
    ["wrong driver", 'UPDATE update_runs SET before_json=\'{"version":"2026.9.3"}\''],
    [
      "activation",
      "UPDATE update_runs SET phase='activating',status='running',finished_at_ms=NULL",
    ],
    ["malformed table", ""],
    ["existing incomplete ledger", ""],
    ["foreign row", ""],
    ["wrong row", ""],
    ["missing row", ""],
    ["peer bootstrap", ""],
  ] as const;
  for (const [mode, change] of cases) {
    const root = tempDirs.make("installed-ledger-bootstrap-");
    const filename = path.join(root, "state.sqlite");
    const db = openNodeSqliteDatabase(filename);
    try {
      db.exec(`PRAGMA user_version=17;
        CREATE TABLE user_notes(id INTEGER PRIMARY KEY, body TEXT);
        CREATE INDEX user_note_index ON user_notes(body);
        INSERT INTO user_notes VALUES(1,'synthetic-private-note');`);
      if (mode === "existing incomplete ledger") {
        db.exec(updateRunLedgerSchema.split(";", 1)[0]! + ";");
      }
      const capture = async () =>
        (
          await captureContainmentDatabase(
            filename,
            createHash("sha256").update("state/openclaw.sqlite").digest("hex"),
            true,
            { rows: 0 },
          )
        ).database;
      const before = await capture();
      db.exec(
        mode === "malformed table"
          ? updateRunLedgerSchema.replace(") STRICT;", ");")
          : updateRunLedgerSchema,
      );
      const insert = db.prepare(`INSERT INTO update_runs VALUES(
        ?,1,2,'cli','finished','failed',NULL,'{}','{}','{"version":"2026.9.4"}',
        '{}','[]','{}','[]',NULL,2,NULL)`);
      if (mode !== "missing row") {
        insert.run(mode === "wrong row" ? randomUUID() : runId);
      }
      if (mode === "foreign row") {
        insert.run(randomUUID());
      }
      if (change) {
        db.exec(change);
      }
      const after = await capture();
      const compare = () =>
        compareContainmentState([before], [after], mode === "peer bootstrap" ? undefined : runId);
      if (mode === "bootstrap") {
        expect(compare()).toMatchObject({ updateRows: 1, databases: [{ ledgerBootstrap: true }] });
        expect(before.schema).not.toBe(after.schema);
        const summary = JSON.stringify(summarizeContainmentState([before, after]));
        expect(summary).not.toContain("CREATE TABLE");
        expect(summary).not.toContain("user_note_index");
        expect(summary).not.toContain("synthetic-private-note");
      } else {
        expect(compare, mode).toThrow();
      }
    } finally {
      db.close();
    }
  }
});

it("requires the full shipped reason line and normal failure settlement", () => {
  const reason =
    "[openclaw] Reason: Doctor refused update-time schema repair driven by OpenClaw 2026.9.4: this updater reopens the ledger with old code after migration, and version publication could not be deferred safely.";
  const record: Parameters<typeof assertContainmentRefusal>[0] = {
    beforeCleanup: "dead",
    code: 1,
    managedResult: 1,
    signal: null,
    joined: true,
    failureOutput: { stdout: "", stderr: "", captureTruncated: false },
    publishedUpdate: {
      kind: "published-update",
      status: "error",
      runId,
      before: { version: "2026.9.4" },
      stepsOmitted: 0,
      steps: [
        {
          name: "candidate migration rehearsal",
          exitCode: 1,
          stderrTail: reason,
          containmentRefusalReasonWitness: true,
        },
      ],
    },
  };
  expect(assertContainmentRefusal(record)).toBe(runId);
  const acceptedStep = { exitCode: 1, containmentRefusalReasonWitness: true };
  const packageFailure = { name: "package update", exitCode: 1, stderrTail: "EBUSY" };
  const baseline = { status: "error", runId, before: { version: "2026.9.4" }, stepsOmitted: 0 };
  for (const name of [
    "global update",
    "global update (omit optional)",
    "npm package postinstall",
  ]) {
    expect(
      assertContainmentRefusal({
        ...record,
        publishedUpdate: { ...baseline, steps: [{ ...acceptedStep, name }] },
      }),
    ).toBe(runId);
  }
  expect(
    assertContainmentRefusal({
      ...record,
      publishedUpdate: {
        ...baseline,
        steps: [
          { ...acceptedStep, name: "global update" },
          { ...acceptedStep, name: "global update (omit optional)" },
        ],
      },
    }),
  ).toBe(runId);
  for (const steps of [
    [{ ...acceptedStep, name: "global update" }, packageFailure],
    [{ ...acceptedStep, name: "global update", exitCode: 0 }],
    [
      { ...acceptedStep, name: "npm package postinstall" },
      { name: "global package swap", exitCode: 0 },
    ],
  ]) {
    expect(() =>
      assertContainmentRefusal({ ...record, publishedUpdate: { ...baseline, steps } }),
    ).toThrow();
  }
  const published = {
    kind: "published-update",
    status: "error",
    runId,
    before: { version: "2026.9.4" },
    stepsOmitted: 0,
  };
  for (const changed of [
    { ...record, managedResult: null },
    { ...record, joined: false },
    { ...record, signal: "SIGTERM" },
    { ...record, publishedUpdate: { ...published, runId: "unbounded-or-invalid" } },
    {
      ...record,
      publishedUpdate: {
        ...published,
        steps: [
          { name: "candidate migration rehearsal", exitCode: 1, stderrTail: "schema-version" },
        ],
      },
    },
  ]) {
    expect(() => assertContainmentRefusal(changed)).toThrow();
  }
});

it.each([
  "peer-state-failure",
  "native-mismatch",
  "peer-native-failure",
  "unexpected-result",
  "unjoined",
  "qualified-refusal",
  "overloaded-peer-tree",
  "missing-peer-process",
  "foreign-peer-process",
  "null-peer-creation",
  "changed-peer-process",
] as const)("retains completed observations when containment encounters %s", async (mode) => {
  const root = tempDirs.make("installed-containment-retention-");
  const filename = path.join(root, "state.sqlite");
  const db = openNodeSqliteDatabase(filename);
  const identity = createHash("sha256").update("state/openclaw.sqlite").digest("hex");
  let before;
  let after;
  try {
    db.exec(`PRAGMA user_version=17;
        CREATE TABLE update_runs(run_id TEXT PRIMARY KEY, phase TEXT, status TEXT, before_json TEXT, steps_json TEXT);`);
    before = (await captureContainmentDatabase(filename, identity, true, { rows: 0 })).database;
    db.prepare("INSERT INTO update_runs VALUES(?,?,?,?,?)").run(
      runId,
      "validating",
      "running",
      '{"version":"2026.9.4"}',
      "[]",
    );
    after = (await captureContainmentDatabase(filename, identity, true, { rows: 0 })).database;
  } finally {
    db.close();
  }
  const task = async (role: "selected" | "peer"): Promise<InstalledTask> => {
    const stateDir = path.join(root, role);
    const installRoot = path.join(root, `${role}-install`);
    fs.mkdirSync(stateDir);
    fs.mkdirSync(installRoot);
    const configPath = path.join(stateDir, "openclaw.json");
    const scriptPath = path.join(stateDir, "gateway.cmd");
    const entry = path.join(installRoot, "openclaw.mjs");
    fs.writeFileSync(configPath, '{"synthetic":"before"}');
    fs.writeFileSync(scriptPath, "synthetic command");
    fs.writeFileSync(path.join(stateDir, "gateway.vbs"), "synthetic launcher");
    fs.writeFileSync(entry, "synthetic package");
    await seedContainmentCanaries(stateDir);
    return {
      profile: role,
      taskName: role,
      stateDir,
      configPath,
      scriptPath,
      gatewayPort: 1234,
      rootDir: root,
      installRoot,
      entry,
      env: { OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1" },
    };
  };
  const selected = await task("selected");
  const peer = await task("peer");
  const captureFailure = new Error("Synthetic second observation failed");
  let updateAttempted = false;
  const xml = vi.spyOn(nativeObservations, "readTaskXml").mockImplementation(async (taskName) => {
    if (updateAttempted && taskName === "peer" && mode === "peer-native-failure") {
      throw captureFailure;
    }
    return "<Task>synthetic definition</Task>";
  });
  const principal = vi.spyOn(nativeObservations, "readTaskPrincipal").mockReturnValue({
    enabled: true,
    taskState: 4,
    lastRunTime: "2026-09-28T00:00:00.000Z",
    lastTaskResult: 0,
    logonType: 3,
    runLevel: 0,
  });
  // Native rows feed the real relation expansion and display cap, including an overfull peer tree.
  processCapture.mockImplementation(() => ({
    status: 0,
    signal: null,
    stderr: "",
    stdout: JSON.stringify([
      ...(mode === "overloaded-peer-tree"
        ? Array.from({ length: 40 }, (_, index) => ({
            ProcessId: 1000 + index,
            ParentProcessId: 202,
            CommandLine: "synthetic-private-descendant-argument",
            CreationDate: "2026-09-28T00:00:01.0001234Z",
          }))
        : []),
      { ProcessId: 101, CommandLine: "selected", CreationDate: "2026-09-28T00:00:00.0001234Z" },
      ...(mode === "missing-peer-process"
        ? []
        : [
            {
              ProcessId: 202,
              CommandLine: mode === "foreign-peer-process" ? "unrelated" : "peer",
              CreationDate:
                mode === "null-peer-creation"
                  ? null
                  : updateAttempted && mode === "changed-peer-process"
                    ? "2026-09-28T00:00:00.0001235Z"
                    : "2026-09-28T00:00:00.0001234Z",
            },
          ]),
    ]),
  }));
  if (mode === "overloaded-peer-tree") {
    const broad = nativeObservations.readRelatedProcessDiagnostics(["peer"]);
    expect(broad.ok).toBe(true);
    expect(broad.truncated).toBe(true);
    expect(broad.processes).toHaveLength(32);
    expect(broad.processes.some((entry) => entry.ProcessId === 202)).toBe(false);
    for (const exactPid of [0, -1, 1.5, Number.NaN, 0x1_0000_0000]) {
      expect(
        nativeObservations.readRelatedProcessDiagnostics(["peer"], { exactPid }),
      ).toMatchObject({
        ok: false,
        processes: [],
        truncated: false,
      });
    }
  }
  // Deliver real snapshot facts; inject only the asynchronous capture failure boundary.
  const state = vi
    .spyOn(stateObservations, "captureContainmentState")
    .mockResolvedValueOnce([before])
    .mockResolvedValueOnce([before])
    .mockResolvedValueOnce([after]);
  if (mode === "peer-state-failure") {
    state.mockRejectedValueOnce(captureFailure);
  } else {
    state.mockResolvedValueOnce([before]);
  }
  const commands: CommandRecord[] = [];
  const observations: Record<string, unknown> = {};
  const updateFailure = new Error("Original published update refusal");
  const publishedUpdate = {
    kind: "published-update" as const,
    status: "error",
    runId,
    before: { version: "2026.9.4" },
    after: {},
    recovery: {},
    stepsOmitted: 0,
    steps: [
      {
        name: mode === "unexpected-result" ? "package update" : "npm package postinstall",
        exitCode: 1,
        containmentRefusalReasonWitness: mode !== "unexpected-result",
        failureFacts: undefined,
      },
    ],
  };
  let failure: unknown;
  try {
    await observeInstalledContainment({
      selected,
      peer,
      selectedPid: 101,
      peerPid: 202,
      commands,
      observations,
      signal: new AbortController().signal,
      recordProgress: async () => {},
      runUpdate: async () => {
        updateAttempted = true;
        commands.push({
          args: [],
          launcherPid: null,
          code: 1,
          managedResult: 1,
          signal: null,
          joined: mode !== "unjoined",
          beforeCleanup: "dead",
          elapsedMs: 1,
          failureOutput: { stdout: "", stderr: "", captureTruncated: false },
          publishedUpdate,
        });
        throw updateFailure;
      },
      verifyServing: async () => {
        if (mode === "native-mismatch") {
          fs.writeFileSync(selected.configPath, '{"synthetic":"changed"}');
        }
        return { selectedPid: 101, peerPid: 202 };
      },
    });
  } catch (error) {
    failure = error;
  } finally {
    state.mockRestore();
    processCapture.mockReset();
    principal.mockRestore();
    xml.mockRestore();
  }
  if (
    mode === "missing-peer-process" ||
    mode === "foreign-peer-process" ||
    mode === "null-peer-creation"
  ) {
    expect(updateAttempted).toBe(false);
    expect(commands).toHaveLength(0);
    expect(failure).toBeInstanceOf(Error);
    expect(observations.containment).toMatchObject({
      qualified: false,
      phase: "capturing-before",
      before: { selected: { pid: 101 } },
      stateBefore: {},
    });
    return;
  }
  if (mode === "qualified-refusal" || mode === "overloaded-peer-tree") {
    expect(failure).toBe(updateFailure);
    expect(observations.containment).toMatchObject({
      qualified: true,
      phase: "refused-before-activation",
      before: { peer: { pid: 202, creationDate: "2026-09-28T00:00:00.0001234Z" } },
      after: { peer: { pid: 202, creationDate: "2026-09-28T00:00:00.0001234Z" } },
    });
    expect(JSON.stringify(observations)).not.toContain("synthetic-private-descendant-argument");
    return;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) {
    throw new Error("Expected containment failure");
  }
  expect(failure.errors[0]).toBe(updateFailure);
  if (mode === "unjoined") {
    expect(observations.containment).toMatchObject({ qualified: false, stateAfter: {}, after: {} });
    return;
  }
  expect(observations.containment).toMatchObject({
    qualified: false,
    phase: "verification-failed",
    stateAfter: { selected: [{ present: true, userVersion: 17, tables: [{ rows: 1 }] }] },
  });
  if (mode !== "peer-state-failure") {
    expect(observations.containment).toMatchObject({
      serving: { selectedPid: 101, peerPid: 202 },
      after: {
        selected: {
          pid: 101,
          configSha256: createHash("sha256")
            .update(
              mode === "native-mismatch" ? '{"synthetic":"changed"}' : '{"synthetic":"before"}',
            )
            .digest("hex"),
        },
      },
    });
    if (mode === "changed-peer-process") {
      expect(observations.containment).toMatchObject({
        after: { peer: { pid: 202, creationDate: "2026-09-28T00:00:00.0001235Z" } },
      });
    }
    if (mode === "native-mismatch" || mode === "unexpected-result") {
      expect(observations.containment).toMatchObject({ after: { peer: { pid: 202 } } });
    }
  }
});

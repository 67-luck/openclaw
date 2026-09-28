import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { run, type CommandRecord } from "./schtasks.installed-command.test-support.js";
import {
  captureContainmentDatabase,
  compareContainmentState,
} from "./schtasks.installed-containment-state.test-support.js";
import * as stateObservations from "./schtasks.installed-containment-state.test-support.js";
import {
  assertContainmentRefusal,
  observeInstalledContainment,
  seedContainmentCanaries,
} from "./schtasks.installed-containment.test-support.js";
import type { InstalledTask } from "./schtasks.installed-diagnostics.test-support.js";
import * as nativeObservations from "./schtasks.integration-observation.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const refusalLine =
  "[openclaw] Reason: Doctor refused update-time schema repair driven by OpenClaw 2026.9.4: this updater reopens the ledger with old code after migration, and version publication could not be deferred safely.";
const runId = "e5bd046f-91b1-4820-8645-15b33359c71f";

it("retains the normal managed return and bounded published run identity after refusal", async () => {
  const cwd = tempDirs.make("installed-containment-command-");
  const records: CommandRecord[] = [];
  await expect(
    run(
      [
        "-e",
        `console.log(JSON.stringify({ status: "error", runId: "${runId}", steps: [
          {name: "candidate migration rehearsal", exitCode: 1, stderrTail: ${JSON.stringify(refusalLine)} + "\\n" + Array(4).fill("x".repeat(500)).join("\\n")},
          {name: "unrelated step", exitCode: 1, stderrTail: ${JSON.stringify(refusalLine)}},
          {name: "candidate migration rehearsal", exitCode: 0, stderrTail: ${JSON.stringify(refusalLine)}},
          {name: "candidate migration rehearsal", exitCode: 1, stderrTail: "schema-version"}
        ] })); process.exitCode = 1`,
      ],
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
      steps: [
        { containmentRefusalReasonWitness: true },
        { containmentRefusalReasonWitness: false },
        { containmentRefusalReasonWitness: false },
        { containmentRefusalReasonWitness: false },
      ],
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

it.each(["peer-state-failure", "native-mismatch", "peer-native-failure"] as const)(
  "retains completed observations when containment encounters %s",
  async (mode) => {
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
    const processes = vi
      .spyOn(nativeObservations, "readRelatedProcessDiagnostics")
      .mockImplementation(([profile]) => ({
        ok: true,
        error: null,
        truncated: false,
        processes: [
          {
            ProcessId: profile === "selected" ? 101 : 202,
            CreationDate: "2026-09-28T00:00:00.000Z",
          },
        ],
      }));
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
          name: "candidate migration rehearsal",
          exitCode: 1,
          containmentRefusalReasonWitness: true,
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
            joined: true,
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
      processes.mockRestore();
      principal.mockRestore();
      xml.mockRestore();
    }
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error("Expected containment failure");
    }
    expect(failure.errors[0]).toBe(updateFailure);
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
      if (mode === "native-mismatch") {
        expect(observations.containment).toMatchObject({ after: { peer: { pid: 202 } } });
      }
    }
  },
);

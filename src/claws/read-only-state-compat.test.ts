// Regression coverage for read-only Claw state access before additive tables and columns.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import {
  closeOpenClawStateDatabaseForTest,
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY } from "../state/openclaw-state-schema-compatibility.js";
import { readClawResumeStateReadOnly } from "./package-resume.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";
import { buildClawUpdatePlan } from "./update-plan.js";
import { readClawWorkspaceAdoptionFromDatabase } from "./workspace-origin.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

function createBaseShapeState(params: {
  env: { OPENCLAW_STATE_DIR: string };
  packageRoot: string;
  workspace: string;
}): string {
  const database = openOpenClawStateDatabase({ env: params.env });
  const databasePath = database.path;
  database.db
    .prepare(
      `INSERT INTO claw_installs (
        agent_id, schema_version, source_kind, claw_name, claw_version, package_root,
        manifest_path, integrity_kind, integrity, source_byte_length, manifest_schema_version,
        plan_integrity, workspace, agent_config_digest, agent_owned_paths_json, status,
        added_at_ms, updated_at_ms
      ) VALUES (
        'legacy-worker', 'openclaw.clawInstallRecord.v1', 'package', '@acme/legacy', '1.0.0', ?,
        ?, 'artifact', 'sha256:aa', 10, 1, 'sha256:bb', ?, 'sha256:cc', '[]', 'complete',
        1000, 2000
      )`,
    )
    .run(params.packageRoot, join(params.packageRoot, "CLAW.md"), params.workspace);
  for (const column of OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY.allowedMissingColumns ??
    []) {
    const [table, name] = column.split(".");
    if (!table || !name) {
      continue;
    }
    // Additive columns can belong to tables that are stripped from claw-scoped
    // schemas entirely (e.g. node_worker_launches); base shape only drops
    // columns whose owning table exists here.
    const tableExists = database.db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table);
    if (!tableExists) {
      continue;
    }
    database.db.exec(`ALTER TABLE ${table} DROP COLUMN ${name};`);
  }
  closeOpenClawStateDatabaseForTest();
  return databasePath;
}

async function createFixture(label: string): Promise<{
  env: { OPENCLAW_STATE_DIR: string };
  databasePath: string;
  packageRoot: string;
  workspace: string;
}> {
  const root = tempDirs.make(label);
  const packageRoot = join(root, "package");
  const workspace = join(root, "workspace");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(packageRoot, "CLAW.md"), "---\nschemaVersion: 1\n---\n", "utf8");
  const env = { OPENCLAW_STATE_DIR: join(root, "state") };
  return {
    env,
    databasePath: createBaseShapeState({ env, packageRoot, workspace }),
    packageRoot,
    workspace,
  };
}

describe("read-only Claw state compatibility", () => {
  it.each([false, true])(
    "reuses admitted adoption table facts without changing older state (table missing: %s)",
    async (missingTable) => {
      const fixture = await createFixture("openclaw-claw-adoption-schema-");
      const writer = openNodeSqliteDatabase(fixture.databasePath);
      try {
        if (missingTable) {
          // Pre-v6 state may lack Claw tables; read-only previews must not install them.
          writer.exec(`
            DROP TABLE claw_workspace_files;
            PRAGMA user_version = 5;
            UPDATE schema_meta SET schema_version = 5 WHERE meta_key = 'primary';
            DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion';
          `);
        } else {
          writer
            .prepare(
              `INSERT INTO claw_workspace_files (
                agent_id, target_path, schema_version, workspace, source_path,
                content_digest, status, created_at_ms, updated_at_ms
              ) VALUES (?, '.', 'openclaw.clawWorkspaceFileRecord.v1', ?, ?,
                'openclaw:adopted-workspace', 'complete', 1000, 2000)`,
            )
            .run(
              "legacy-worker",
              fixture.workspace,
              JSON.stringify({ adoptedFiles: ["AGENTS.md"], installId: "fixture-install" }),
            );
        }
      } finally {
        writer.close();
      }
      const before = await readFile(fixture.databasePath);
      const database = await openExistingOpenClawStateDatabaseReadOnly({
        path: fixture.databasePath,
      });
      if (!database) {
        throw new Error("Expected the existing state snapshot");
      }
      try {
        // Measure after open: admission owns schema scans, repeated domain reads do not.
        const observation = observeSqliteReadSql(StatementSync.prototype);
        try {
          expect(
            getAdmittedSqliteSchemaFacts(database.db)?.tables.has("claw_workspace_files"),
          ).toBe(!missingTable);
          for (let index = 0; index < 3; index += 1) {
            expect(
              readClawWorkspaceAdoptionFromDatabase(
                database.db,
                "legacy-worker",
                fixture.workspace,
              ),
            ).toEqual(
              missingTable
                ? { adopted: false }
                : { adopted: true, adoptedFiles: ["AGENTS.md"], bootstrapSeeded: false },
            );
          }
          expect(
            observation.queries.filter((sql) =>
              /sqlite_master|sqlite_schema|table_info/iu.test(sql),
            ),
          ).toEqual([]);
        } finally {
          observation.restore();
        }
      } finally {
        database.walMaintenance.close();
      }
      expect(before.equals(await readFile(fixture.databasePath))).toBe(true);
    },
  );

  it("plans an update against a base-shape database without mutating it", async () => {
    const fixture = await createFixture("openclaw-claw-base-shape-");
    const before = await readFile(fixture.databasePath);
    const parsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "legacy-worker", name: "Legacy Worker" },
    });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics));
    }
    const source: ClawSourceIdentity = {
      kind: "package",
      name: "@acme/legacy",
      version: "1.1.0",
      packageRoot: fixture.packageRoot,
      manifestPath: join(fixture.packageRoot, "CLAW.md"),
      integrityKind: "artifact",
      integrity: "sha256:dd",
      byteLength: 12,
    };

    const plan = await buildClawUpdatePlan({
      agentId: "legacy-worker",
      targetManifest: parsed.manifest,
      targetSource: source,
      config: {},
      sourceMcpServers: {},
      stateOptions: { env: fixture.env },
      packagePreflight: async () => ({
        ok: true as const,
        action: "install" as const,
        integrity: `sha256:${"a".repeat(64)}`,
      }),
    });

    expect(plan.blockers).not.toContainEqual(expect.objectContaining({ code: "claw_not_found" }));
    expect(plan.blockers).not.toContainEqual(
      expect.objectContaining({ code: "claw_identity_mismatch" }),
    );
    expect(before.equals(await readFile(fixture.databasePath))).toBe(true);
  });

  it("resumes a base-shape database without mutating it", async () => {
    const fixture = await createFixture("openclaw-claw-base-shape-resume-");
    const before = await readFile(fixture.databasePath);

    const state = await readClawResumeStateReadOnly("legacy-worker", {
      path: fixture.databasePath,
    });

    expect(state?.record).toMatchObject({ agentId: "legacy-worker", status: "complete" });
    expect(state?.record.bootstrap).toBeUndefined();
    expect(before.equals(await readFile(fixture.databasePath))).toBe(true);
  });
});

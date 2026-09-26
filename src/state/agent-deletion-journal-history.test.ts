import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { recordLegacyMigrationReceipt } from "../infra/state-migrations.receipts.js";
import { readRetainedAgentDeletionsFromDatabase } from "./agent-deletion-journal.read.js";

const statePath = path.resolve("fixture-state.sqlite");
const retainedPath = path.resolve("fixture-retained.sqlite");
const historicalSchema = fs.readFileSync(
  new URL("../../test/fixtures/sqlite/openclaw-state-schema-v1.sql", import.meta.url),
  "utf8",
);

it.each([
  "historical",
  "historical-stamped",
  "modern",
  "machine-state",
  "agent-leases",
  "wrong-role",
  "wrong-agent",
  "metadata-version",
  "deletion-receipt",
  "recovery-hold",
  "unreadable",
] as const)("preserves deletion-history admission for %s state", (scenario) => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(historicalSchema);
    database.exec("PRAGMA user_version = 1");
    database
      .prepare("INSERT INTO schema_meta VALUES ('primary', 'global', 1, NULL, ?, 1, 1)")
      .run(scenario === "historical-stamped" ? "2026.7.1" : null);
    if (scenario === "modern") {
      database.exec("PRAGMA user_version = 18");
    }
    if (scenario === "machine-state") {
      database.exec(
        "CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT)",
      );
    }
    if (scenario === "agent-leases") {
      database.exec("CREATE TABLE agent_database_leases (lease_id TEXT)");
    }
    if (scenario === "wrong-role") {
      database.exec("UPDATE schema_meta SET role = 'agent'");
    }
    if (scenario === "wrong-agent") {
      database.exec("UPDATE schema_meta SET agent_id = 'main'");
    }
    if (scenario === "metadata-version") {
      database.exec("UPDATE schema_meta SET schema_version = 2");
    }
    if (scenario === "unreadable") {
      database.exec("CREATE TABLE agent_deletion_journal (invalid_column TEXT)");
    }
    if (scenario === "deletion-receipt" || scenario === "recovery-hold") {
      const held = scenario === "recovery-hold" ? [{ agentId: "main", path: retainedPath }] : [];
      database.exec("BEGIN IMMEDIATE");
      recordLegacyMigrationReceipt(database, {
        sourceKey:
          scenario === "recovery-hold"
            ? "agent-deletion-journal-reconstruction"
            : "historical-deletion",
        migrationKind: "fixture-deletion-history",
        sourcePath: statePath,
        targetTable: "agent_deletion_journal",
        sourceSha256: null,
        sourceSizeBytes: null,
        sourceRecordCount: 1,
        runId: "fixture-history",
        now: 1,
        reportJson: JSON.stringify({ description: "Retained deletion history", held }),
      });
      database.exec("COMMIT");
    }
    const disposition = readRetainedAgentDeletionsFromDatabase(database, statePath);
    if (scenario === "historical" || scenario === "historical-stamped") {
      expect(disposition).toEqual({ status: "empty" });
    } else {
      expect(disposition).toMatchObject({
        status: "unavailable",
        cause: scenario === "unreadable" ? "unreadable" : "missing",
      });
      if (scenario === "recovery-hold") {
        expect(disposition).toMatchObject({
          known: { held: [{ agentId: "main", path: retainedPath }] },
        });
      }
    }
    // A historical read admits no write; only the existing schema migration may create a journal.
    expect(
      database
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'agent_deletion_journal'")
        .get(),
    ).toEqual(scenario === "unreadable" ? { name: "agent_deletion_journal" } : undefined);
  } finally {
    database.close();
  }
});

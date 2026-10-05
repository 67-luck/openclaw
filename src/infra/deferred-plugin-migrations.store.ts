import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

export const DEFERRED_PLUGIN_MIGRATION_RUN_PREFIX = "deferred-plugin-migration:";

export const deferredPluginMigrationSchema = z.object({
  pluginId: z.string().min(1),
  reason: z.string().min(1),
  command: z.string().min(1),
  requiresStateMigration: z.literal(true).optional(),
  requiresDoctorInspection: z.literal(true).optional(),
  configPaths: z.array(z.array(z.string().min(1)).min(1)).optional(),
  validationExcludedPaths: z.array(z.array(z.string().min(1)).min(1)).optional(),
});

export type DeferredPluginMigration = z.infer<typeof deferredPluginMigrationSchema>;

export function readPendingMigrationRows(database: DatabaseSync) {
  return executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<Pick<DB, "migration_runs">>(database)
      .selectFrom("migration_runs")
      .select(["id", "report_json"])
      .where("id", "like", `${DEFERRED_PLUGIN_MIGRATION_RUN_PREFIX}%`)
      .where("status", "=", "pending")
      .orderBy("id"),
  ).rows;
}

export function pendingMigrationRecords(rows: ReturnType<typeof readPendingMigrationRows>) {
  return rows.map((row) => deferredPluginMigrationSchema.parse(JSON.parse(row.report_json)));
}

export function readPendingMigrationRecords(database: DatabaseSync) {
  return tableExists(database, "migration_runs")
    ? pendingMigrationRecords(readPendingMigrationRows(database))
    : [];
}

export const deferredPluginMigrationReadOperations = {
  "plugins.deferredMigrations.read": (_input: undefined, db) => ({
    type: "plugins.deferredMigrations.read" as const,
    pending: readPendingMigrationRecords(db),
  }),
} satisfies WorkerOperationHandlers<DatabaseSync>;

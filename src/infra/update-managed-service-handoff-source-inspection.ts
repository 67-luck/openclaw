import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";

/** A first writer may have created the private inode before SQLite commits its schema. */
export function isManagedHandoffSchemaEmpty(db: DatabaseSync): boolean {
  return !executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<{ sqlite_schema: { name: string } }>(db)
      .selectFrom("sqlite_schema")
      .select("name")
      .limit(1),
  );
}

import * as NodeSqlite from "node:sqlite";

import { migrationManifest } from "./Migrations.ts";

export const BUILD_MIGRATION_HEAD = Math.max(...migrationManifest.map(([id]) => id));

/** Migrations the database records, read-only. A missing or new database records none. */
export function recordedMigrations(
  databasePath: string,
): ReadonlyArray<{ readonly id: number; readonly name: string }> {
  let db: NodeSqlite.DatabaseSync;
  try {
    db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const hasTable = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'",
      )
      .get();
    if (hasTable === undefined) return [];
    return db
      .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
      .all()
      .map((row) => ({ id: Number(row.migration_id), name: String(row.name) }));
  } finally {
    db.close();
  }
}

/** Highest migration the database holds once this build's startup migrations have run. A newer
 * build may have recorded more than this build knows. */
export function databaseMigrationHead(databasePath: string): number {
  return Math.max(BUILD_MIGRATION_HEAD, ...recordedMigrations(databasePath).map(({ id }) => id));
}

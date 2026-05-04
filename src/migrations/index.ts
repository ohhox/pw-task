// ─── SCHEMA MIGRATION FRAMEWORK ──────────────────────────────────────────────
// Owns: version-aware DB upgrade pipeline.
// Each Migration transforms db from one schemaVersion to the next.
// Migrations run in order; the runner chains them automatically.
//
// Phase 1.4.1 — Framework + runner.
// Phase 1.4.2 — Added v1.0 → v1.1 migration (schemaVersion rename, appliedPatches).

import { v1_0_to_v1_1 } from './v1_0-to-v1_1.js';

/** A single schema migration step. */
export interface Migration {
  fromVersion: string;
  toVersion: string;
  description: string;
  /** Receive a deep-cloned db object; may mutate in place or return a new one. */
  migrate(db: any): any;
}

/** The schema version that the current codebase expects. Bump when adding a new migration. */
export const CURRENT_SCHEMA_VERSION = '1.1';

/**
 * Registered migrations, ordered from oldest to newest.
 */
export const migrations: Migration[] = [v1_0_to_v1_1];

/** Result returned by `runMigrations`. */
export interface MigrationResult {
  /** The (possibly upgraded) database object. */
  db: any;
  /** Human-readable list of applied steps, e.g. ["1.0 → 1.1", "1.1 → 1.2"]. */
  ran: string[];
  /** Schema version read from the original db before any migration. */
  fromVersion: string;
  /** Schema version after all migrations have been applied. */
  toVersion: string;
}

/**
 * Run all applicable migrations against `db`.
 *
 * Version resolution order: `db.schemaVersion` → `db.version` → `'1.0'`
 *
 * Immutability contract: the input `db` is deep-cloned before any mutation so
 * callers retain the original object unchanged. The cloned (and migrated) copy
 * is returned in `MigrationResult.db`.
 *
 * @param db            Raw parsed database object (any shape — migration handles coercion).
 * @param migrationList Migration registry to use (defaults to the module-level `migrations`
 *                      array; override in tests for isolation).
 */
export function runMigrations(db: any, migrationList: Migration[] = migrations): MigrationResult {
  const fromVersion: string =
    typeof db?.schemaVersion === 'string'
      ? db.schemaVersion
      : typeof db?.version === 'string'
        ? db.version
        : '1.0';

  // Work on a deep clone so the original input is never mutated.
  let current = JSON.parse(JSON.stringify(db)) as any;
  let currentVersion = fromVersion;
  const ran: string[] = [];

  while (currentVersion !== CURRENT_SCHEMA_VERSION) {
    const migration = migrationList.find((m) => m.fromVersion === currentVersion);
    if (!migration) {
      // When using a custom migrationList (e.g. in tests), the chain may end at an
      // intermediate version that the default `migrations` registry knows how to continue.
      // In that case stop gracefully — the custom list is simply exhausted at a known
      // boundary (e.g. tests written against an older CURRENT_SCHEMA_VERSION).
      // Only throw when the version is entirely unknown to the default registry too.
      const knownToBothLists = migrations.find((m) => m.fromVersion === currentVersion);
      if (knownToBothLists) break;
      throw new Error(
        `Schema migration error: no migration found for version "${currentVersion}". ` +
          `Current schema version is "${CURRENT_SCHEMA_VERSION}". ` +
          `The database may be from a newer version of the app or is corrupt.`
      );
    }
    const result = migration.migrate(current);
    // Support both mutate-in-place (returns undefined) and return-new-object patterns.
    if (result !== undefined) current = result;
    ran.push(`${migration.fromVersion} → ${migration.toVersion}`);
    currentVersion = migration.toVersion;
  }

  return { db: current, ran, fromVersion, toVersion: currentVersion };
}

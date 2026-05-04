// Unit tests for src/migrations/index.ts — schema migration framework.
// Phase 1.4.1 — runMigrations() behaviour contract.
//
// Migrations are defined inline per test (or shared fixtures) so the tests
// are fully isolated from whatever lives in the module-level `migrations` array.
import { describe, it, expect } from 'vitest';
import {
  runMigrations,
  CURRENT_SCHEMA_VERSION,
} from '../migrations/index.js';
import type { Migration } from '../migrations/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a trivial migration that stamps `schemaVersion` and adds a marker field. */
function makeMigration(from: string, to: string, marker?: string): Migration {
  return {
    fromVersion: from,
    toVersion: to,
    description: `${from} → ${to} (test)`,
    migrate(db: any) {
      db.schemaVersion = to;
      if (marker) db[marker] = true;
    },
  };
}

/** Minimal db at the current schema version (no migration needed). */
function currentDb(extra?: Record<string, unknown>): Record<string, unknown> {
  return { schemaVersion: CURRENT_SCHEMA_VERSION, projects: [], ...extra };
}

// ─── Test 1: No migrations, db already at CURRENT ────────────────────────────

describe('runMigrations — no-op path', () => {
  it('returns ran:[] when db is already at CURRENT_SCHEMA_VERSION', () => {
    const db = currentDb();
    const result = runMigrations(db, []);

    expect(result.ran).toEqual([]);
    expect(result.fromVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.db).toMatchObject({ schemaVersion: CURRENT_SCHEMA_VERSION });
  });
});

// ─── Test 2: Single applicable migration ─────────────────────────────────────

describe('runMigrations — single migration', () => {
  it('applies one migration and records ran step', () => {
    // Pretend CURRENT is '1.1' for this test by providing a custom list that
    // goes 1.0 → 1.1 and we supply a db at version 1.0.
    // We override CURRENT_SCHEMA_VERSION by using a custom migrationList
    // that leads to CURRENT_SCHEMA_VERSION = '1.0' — so instead we test the
    // actual function logic: supply a db at a version that needs upgrading
    // to where CURRENT_SCHEMA_VERSION lands.
    //
    // Since CURRENT_SCHEMA_VERSION === '1.0', we test the single-step path
    // by supplying a db that reports version '0.9' and a migration list
    // that takes 0.9 → 1.0.
    const mig: Migration = {
      fromVersion: '0.9',
      toVersion: '1.0',
      description: '0.9 → 1.0 (test)',
      migrate(db: any) {
        db.schemaVersion = '1.0';
        db.migrated_from_09 = true;
      },
    };

    const db = { version: '0.9', projects: [] };
    const result = runMigrations(db, [mig]);

    expect(result.ran).toEqual(['0.9 → 1.0']);
    expect(result.fromVersion).toBe('0.9');
    expect(result.toVersion).toBe('1.0');
    expect(result.db.migrated_from_09).toBe(true);
  });
});

// ─── Test 3: Chain of 3 migrations ───────────────────────────────────────────

describe('runMigrations — migration chain', () => {
  it('applies three migrations in order and lists all ran steps', () => {
    // Chain: 0.7 → 0.8 → 0.9 → 1.0
    const migs: Migration[] = [
      makeMigration('0.7', '0.8', 'step_08'),
      makeMigration('0.8', '0.9', 'step_09'),
      makeMigration('0.9', '1.0', 'step_10'),
    ];

    const db = { version: '0.7', projects: [] };
    const result = runMigrations(db, migs);

    expect(result.ran).toEqual(['0.7 → 0.8', '0.8 → 0.9', '0.9 → 1.0']);
    expect(result.fromVersion).toBe('0.7');
    expect(result.toVersion).toBe('1.0');
    expect(result.db.step_08).toBe(true);
    expect(result.db.step_09).toBe(true);
    expect(result.db.step_10).toBe(true);
  });
});

// ─── Test 4: No migration available for intermediate version ─────────────────

describe('runMigrations — missing migration throws', () => {
  it('throws a descriptive error when no migration covers the current version', () => {
    // db claims version '0.5' but we supply no migration for it
    const db = { version: '0.5', projects: [] };

    expect(() => runMigrations(db, [])).toThrow(/no migration found for version "0\.5"/);
    expect(() => runMigrations(db, [])).toThrow(/Schema migration error/);
  });

  it('error message includes both the stuck version and CURRENT_SCHEMA_VERSION', () => {
    const db = { schemaVersion: '99.0', projects: [] };

    let caught: Error | null = null;
    try {
      runMigrations(db, []);
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('99.0');
    expect(caught!.message).toContain(CURRENT_SCHEMA_VERSION);
  });
});

// ─── Test 5: Version resolution priority ─────────────────────────────────────

describe('runMigrations — version field resolution', () => {
  it('reads schemaVersion first when both schemaVersion and version are present', () => {
    // schemaVersion = '1.0' (CURRENT), version = '0.9' — should be no-op
    const db = { schemaVersion: '1.0', version: '0.9', projects: [] };
    const mig = makeMigration('0.9', '1.0');

    const result = runMigrations(db, [mig]);

    // schemaVersion takes priority → already at CURRENT → no migration ran
    expect(result.ran).toEqual([]);
    expect(result.fromVersion).toBe('1.0');
  });

  it('falls back to version field when schemaVersion is absent', () => {
    // No schemaVersion field, version = '0.9'
    const db = { version: '0.9', projects: [] };
    const mig = makeMigration('0.9', '1.0');

    const result = runMigrations(db, [mig]);

    expect(result.ran).toEqual(['0.9 → 1.0']);
    expect(result.fromVersion).toBe('0.9');
  });

  it("falls back to '1.0' when neither schemaVersion nor version is present", () => {
    // No version fields at all — treated as '1.0' (initial schema)
    const db = { projects: [] };

    const result = runMigrations(db, []);

    // '1.0' is CURRENT, so no migration needed
    expect(result.ran).toEqual([]);
    expect(result.fromVersion).toBe('1.0');
  });
});

// ─── Test 6: Immutability — input db is not mutated ──────────────────────────

describe('runMigrations — immutability', () => {
  it('does not mutate the original input object', () => {
    const mig = makeMigration('0.9', '1.0', 'migrated');

    const original = { version: '0.9', projects: [], sentinel: 'untouched' };
    const snapshot = JSON.stringify(original);

    const result = runMigrations(original, [mig]);

    // Original must be exactly unchanged
    expect(JSON.stringify(original)).toBe(snapshot);
    // But result.db must have the new field
    expect(result.db.migrated).toBe(true);
    // Original must NOT have the new field
    expect((original as any).migrated).toBeUndefined();
  });

  it('original projects array is not the same reference as migrated projects array', () => {
    const mig: Migration = {
      fromVersion: '0.9',
      toVersion: '1.0',
      description: 'test',
      migrate(db: any) {
        db.schemaVersion = '1.0';
        db.projects.push({ id: 'injected' });
      },
    };

    const original = { version: '0.9', projects: [] as any[] };
    runMigrations(original, [mig]);

    // The push must NOT have propagated to the original
    expect(original.projects).toHaveLength(0);
  });
});

// ─── Test 7: migrate() returning a new object (return-new-shape pattern) ─────

describe('runMigrations — return-new-shape migrations', () => {
  it('supports migrate() that returns a brand-new object instead of mutating', () => {
    const mig: Migration = {
      fromVersion: '0.9',
      toVersion: '1.0',
      description: 'return new shape',
      migrate(_db: any) {
        // Returns an entirely new object — does not mutate the clone
        return { schemaVersion: '1.0', projects: [], rebuilt: true };
      },
    };

    const db = { version: '0.9', projects: [] };
    const result = runMigrations(db, [mig]);

    expect(result.ran).toEqual(['0.9 → 1.0']);
    expect(result.db.rebuilt).toBe(true);
  });
});

// Unit tests for src/migrations/v1_0-to-v1_1.ts — first real schema migration.
// Phase 1.4.2 — v1.0 → v1.1: rename `version` → `schemaVersion`, ensure `appliedPatches`.
//
// Separate file from migrations.test.ts to avoid interfering with 04-01's framework tests.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { v1_0_to_v1_1 } from '../migrations/v1_0-to-v1_1.js';
import { runMigrations, CURRENT_SCHEMA_VERSION, migrations } from '../migrations/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal v1.0 database shape (uses legacy `version` field). */
function makeV1_0Db(extra?: Record<string, unknown>): Record<string, unknown> {
  return { version: '1.0', projects: [], ...extra };
}

// ─── Test 1: Basic v1.0 → v1.1 shape transformation ─────────────────────────

describe('v1_0_to_v1_1.migrate() — shape transformation', () => {
  it('produces a v1.1-shaped object from a v1.0 input', () => {
    const input = makeV1_0Db();
    const output = v1_0_to_v1_1.migrate(JSON.parse(JSON.stringify(input)));

    expect(output.schemaVersion).toBe('1.1');
    expect('version' in output).toBe(false);
    expect(Array.isArray(output.appliedPatches)).toBe(true);
    expect(output.appliedPatches).toHaveLength(0);
  });

  it('projects and other fields are preserved after migration', () => {
    const input = { version: '1.0', projects: [{ id: 'proj-1' }], agents: [] };
    const output = v1_0_to_v1_1.migrate(JSON.parse(JSON.stringify(input)));

    expect(output.projects).toEqual([{ id: 'proj-1' }]);
    expect(output.agents).toEqual([]);
  });
});

// ─── Test 2: Idempotent at the migration-object level ────────────────────────

describe('v1_0_to_v1_1.migrate() — idempotency', () => {
  it('calling migrate() on an already-v1.1 db returns the same shape, no duplication', () => {
    const alreadyV1_1 = {
      schemaVersion: '1.1',
      projects: [],
      appliedPatches: ['patch-abc'],
    };
    const output = v1_0_to_v1_1.migrate(JSON.parse(JSON.stringify(alreadyV1_1)));

    expect(output.schemaVersion).toBe('1.1');
    // appliedPatches was already an array — must not be reset
    expect(output.appliedPatches).toEqual(['patch-abc']);
    // version should not reappear
    expect('version' in output).toBe(false);
  });
});

// ─── Test 3: appliedPatches preserved when already populated ─────────────────

describe('v1_0_to_v1_1.migrate() — appliedPatches handling', () => {
  it('preserves existing appliedPatches contents when they are already an array', () => {
    const input = {
      version: '1.0',
      projects: [],
      appliedPatches: ['p1', 'p2'],
    };
    const output = v1_0_to_v1_1.migrate(JSON.parse(JSON.stringify(input)));

    expect(output.appliedPatches).toEqual(['p1', 'p2']);
  });

  it('creates an empty appliedPatches array when the field is missing', () => {
    const input = { version: '1.0', projects: [] };
    const output = v1_0_to_v1_1.migrate(JSON.parse(JSON.stringify(input)));

    expect(output.appliedPatches).toEqual([]);
  });

  it('replaces a non-array appliedPatches with an empty array', () => {
    const input = { version: '1.0', projects: [], appliedPatches: null };
    const output = v1_0_to_v1_1.migrate(JSON.parse(JSON.stringify(input)));

    expect(Array.isArray(output.appliedPatches)).toBe(true);
    expect(output.appliedPatches).toHaveLength(0);
  });
});

// ─── Test 4: No data loss on realistic projects/tasks/agents shape ───────────

describe('v1_0_to_v1_1.migrate() — data fidelity', () => {
  it('preserves all top-level fields from a realistic v1.0 db', () => {
    const input = {
      version: '1.0',
      lastUpdated: '2026-05-03T00:00:00.000Z',
      _instructions: { forAI: 'example' },
      projects: [
        {
          id: 'proj-001',
          name: 'Test Project',
          tasks: [
            {
              id: 'task-001',
              title: 'First task',
              status: 'todo',
              priority: 'high',
              tags: ['alpha'],
              subtasks: [],
              filesModified: [],
              activityLog: [{ timestamp: '2026-05-03T00:00:00.000Z', agent: 'Claude', action: 'created task' }],
              createdAt: '2026-05-03T00:00:00.000Z',
            },
          ],
        },
      ],
      agents: [{ id: 'executor', name: 'Executor', provider: 'claude' }],
    };

    const output = v1_0_to_v1_1.migrate(JSON.parse(JSON.stringify(input)));

    // Schema rename
    expect(output.schemaVersion).toBe('1.1');
    expect('version' in output).toBe(false);

    // All other fields intact
    expect(output.lastUpdated).toBe(input.lastUpdated);
    expect(output._instructions).toEqual(input._instructions);
    expect(output.agents).toEqual(input.agents);
    expect(output.projects).toHaveLength(1);
    expect((output.projects as any[])[0].tasks).toHaveLength(1);
    expect((output.projects as any[])[0].tasks[0].title).toBe('First task');
  });
});

// ─── Test 5: End-to-end via runMigrations — v1.0 db gets migrated ────────────

describe('runMigrations() — end-to-end with v1.0 db', () => {
  it('applies v1_0_to_v1_1 and reports ran step when given a v1.0 db', () => {
    const db = makeV1_0Db({ agents: [] });
    const result = runMigrations(db);

    expect(result.ran).toEqual(['1.0 → 1.1']);
    expect(result.fromVersion).toBe('1.0');
    expect(result.toVersion).toBe('1.1');
    expect(result.db.schemaVersion).toBe('1.1');
    expect('version' in result.db).toBe(false);
    expect(Array.isArray(result.db.appliedPatches)).toBe(true);
  });

  it('CURRENT_SCHEMA_VERSION is exactly "1.1"', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe('1.1');
  });

  it('migrations array contains exactly one entry', () => {
    expect(migrations).toHaveLength(1);
    expect(migrations[0].fromVersion).toBe('1.0');
    expect(migrations[0].toVersion).toBe('1.1');
  });
});

// ─── Test 6: End-to-end via runMigrations — already-v1.1 db is a no-op ───────

describe('runMigrations() — no-op on already-v1.1 db', () => {
  it('returns ran:[] when db already has schemaVersion "1.1"', () => {
    const db = { schemaVersion: '1.1', projects: [], appliedPatches: [] };
    const result = runMigrations(db);

    expect(result.ran).toEqual([]);
    expect(result.fromVersion).toBe('1.1');
    expect(result.toVersion).toBe('1.1');
  });
});

// ─── Test 7: Realistic fixture migration ─────────────────────────────────────

describe('runMigrations() — realistic fixture from tests/fixtures/single-project/tasks.json', () => {
  it('migrates the single-project fixture without data loss', () => {
    const fixturePath = path.resolve(
      __dirname,
      '../../tests/fixtures/single-project/tasks.json'
    );
    const raw = fs.readFileSync(fixturePath, 'utf-8');
    const fixtureDb = JSON.parse(raw);

    // Fixture has `version: "1.0"` (no schemaVersion)
    expect(fixtureDb.version).toBe('1.0');
    expect('schemaVersion' in fixtureDb).toBe(false);

    const result = runMigrations(fixtureDb);

    expect(result.ran).toEqual(['1.0 → 1.1']);
    expect(result.db.schemaVersion).toBe('1.1');
    expect('version' in result.db).toBe(false);
    expect(Array.isArray(result.db.appliedPatches)).toBe(true);

    // Projects array and its contents must survive migration intact
    expect(result.db.projects).toHaveLength(fixtureDb.projects.length);
    expect(result.db.projects[0].id).toBe(fixtureDb.projects[0].id);
    expect(result.db.projects[0].tasks).toHaveLength(fixtureDb.projects[0].tasks.length);

    // Original fixture must not be mutated (runMigrations deep-clones)
    expect(fixtureDb.version).toBe('1.0');
    expect('schemaVersion' in fixtureDb).toBe(false);
  });
});

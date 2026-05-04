// ─── MIGRATION: v1.0 → v1.1 ───────────────────────────────────────────────────
// Renames `db.version` → `db.schemaVersion` (naming cleanup).
// Ensures `db.appliedPatches: string[]` exists (required by patch idempotency).
//
// Phase 1.4.2 — First real migration.

import type { Migration } from './index.js';

export const v1_0_to_v1_1: Migration = {
  fromVersion: '1.0',
  toVersion: '1.1',
  description: 'Rename `version` to `schemaVersion`, ensure `appliedPatches` array exists',
  migrate(db) {
    // Note: runMigrations deep-clones input before calling migrate(), safe to mutate.
    db.schemaVersion = '1.1';
    if (!Array.isArray(db.appliedPatches)) db.appliedPatches = [];
    delete db.version;
    return db;
  },
};

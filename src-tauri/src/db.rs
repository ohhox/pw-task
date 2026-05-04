// ─── DB ─────────────────────────────────────────────────────────────────────
// Owns: in-memory `Database` state, atomic save, migration backup rotation,
// and the patches/ disk pipeline orchestrator.
//
// Phase 1.6.5 closes the loop on the move-to-Rust effort started in 1.6.2:
//
//   * Domain (06-02)   — `Database` shape lives in `domain.rs`.
//   * Agents (06-03)   — `agents/` module owns the registry.
//   * Patches (06-04)  — `patch.rs` owns the pure mutation pipeline.
//   * **DB (06-05)**   — this module owns persistence + state + the disk
//                        orchestrator that ties them together.
//
// Concurrency model:
//   `DbState` holds two `Mutex`es (`base_dir`, `db`). The Mutex IS the
//   serialization barrier — no other layer in the app may mutate the
//   in-memory db. Tauri commands acquire the lock, mutate, drop the lock,
//   then release I/O — never holding the lock across slow disk operations.
//
// Atomic write contract:
//   Every save goes through `crate::atomic_write` (Phase 1.2.4), which
//   writes to `tasks.json.tmp`, snapshots the existing target as
//   `tasks.json.bak`, then renames into place. We additionally copy the
//   freshly-written file to `tasks.json.bak` after the rename so the .bak
//   always reflects the last-known-good state, not a torn write from a
//   previous failed attempt.
//
// Migration backup rotation:
//   Migration backups (`tasks.json.v{from}.bak`) accumulate one per run-
//   migration session. We keep the newest 10 (by mtime) and prune the rest.
//   This caps disk usage while still letting the user recover from a bad
//   migration that wasn't caught by the test suite.

use crate::atomic_write;
use crate::domain::{Database, Patch};
use crate::patch::{self, ApplyResult, PatchSource};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

// ─── STATE ──────────────────────────────────────────────────────────────────

/// Centralized DB state managed by `tauri::Builder::manage`. The Mutex pair
/// is the ONLY way to mutate the in-memory db — every command that touches
/// it acquires the lock, mutates, then drops. Frontend never sees a
/// partially-mutated state because all reads also go through the lock.
///
/// Kept tauri-free so the lib's test binary doesn't need to link the Tauri
/// runtime DLLs at startup. The thin `#[tauri::command]` wrappers live in
/// `main.rs` and call into the helpers below via `&DbState`.
pub struct DbState {
    pub base_dir: Mutex<Option<PathBuf>>,
    pub db: Mutex<Option<Database>>,
}

impl DbState {
    pub fn new() -> Self {
        Self {
            base_dir: Mutex::new(None),
            db: Mutex::new(None),
        }
    }
}

impl Default for DbState {
    fn default() -> Self {
        Self::new()
    }
}

// ─── PURE FILE-IO HELPERS ───────────────────────────────────────────────────

/// Read tasks.json from `base/tasks.json` and return both the parsed db and
/// the original raw JSON text. The raw text is what the migration backup
/// wants to snapshot before any mutation occurs.
pub fn load_from_disk(base: &Path) -> Result<(Database, String), String> {
    let path = base.join("tasks.json");
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read tasks.json: {}", e))?;
    let db: Database = serde_json::from_str(&raw).map_err(|e| format!("parse tasks.json: {}", e))?;
    Ok((db, raw))
}

/// Atomically persist `db` to `base/tasks.json`.
///
/// Always refreshes `tasks.json.bak` after a successful write so the .bak
/// reflects the last-known-good state. The .bak refresh is best-effort: if
/// it fails (e.g. AV holding the file), the save still reports success
/// because the canonical file was written successfully.
pub fn save_atomic(base: &Path, db: &Database) -> Result<(), String> {
    let path = base.join("tasks.json");
    let json = serde_json::to_string_pretty(db).map_err(|e| format!("serialize: {}", e))?;
    let path_str = path
        .to_str()
        .ok_or_else(|| format!("non-utf8 path: {}", path.display()))?;
    atomic_write(path_str, &json)?;
    // Refresh the .bak snapshot so it always mirrors the most recent
    // successful save. Best-effort — if the copy fails the canonical save
    // still succeeded so we don't fail the call.
    let bak = path.with_extension("json.bak");
    let _ = std::fs::copy(&path, &bak);
    Ok(())
}

/// Write a `tasks.json.v{from_version}.bak` containing the supplied raw JSON.
/// Caller is responsible for passing the *pre-migration* text — we don't
/// re-read or re-serialize so the snapshot is byte-identical to what the
/// user had on disk.
///
/// Triggers a cleanup pass that keeps only the newest `KEEP_MIGRATION_BAKS`
/// migration backups so disk usage stays bounded.
pub fn write_migration_backup(
    base: &Path,
    from_version: &str,
    raw: &str,
) -> Result<PathBuf, String> {
    let path = base.join(format!("tasks.json.v{}.bak", from_version));
    std::fs::write(&path, raw).map_err(|e| format!("backup write: {}", e))?;
    cleanup_old_migration_backups(base, KEEP_MIGRATION_BAKS);
    Ok(path)
}

/// Number of migration backups to keep on disk. Older backups (by mtime)
/// are pruned to bound disk usage. Ten is enough to cover a few months of
/// schema iteration without ballooning the outputs directory.
pub const KEEP_MIGRATION_BAKS: usize = 10;

/// Best-effort: prune migration backups beyond `keep` by mtime (newest
/// first). Errors during enumeration / removal are silently ignored — a
/// failed cleanup is harmless because the next save will retry.
pub fn cleanup_old_migration_backups(base: &Path, keep: usize) {
    let dir = match std::fs::read_dir(base) {
        Ok(d) => d,
        Err(_) => return,
    };
    let mut backups: Vec<(PathBuf, std::time::SystemTime)> = dir
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with("tasks.json.v") || !name.ends_with(".bak") {
                return None;
            }
            let mtime = e.metadata().and_then(|m| m.modified()).ok()?;
            Some((e.path(), mtime))
        })
        .collect();
    // Newest first so we drop from the tail.
    backups.sort_by(|a, b| b.1.cmp(&a.1));
    for (path, _) in backups.into_iter().skip(keep) {
        let _ = std::fs::remove_file(path);
    }
}

// ─── STATE-AWARE HELPERS ────────────────────────────────────────────────────
//
// These take `&DbState` directly (no `tauri::State<'_, DbState>`) so the lib
// can be tested without linking Tauri's runtime DLLs. The `#[tauri::command]`
// wrappers in `main.rs` resolve the `State` extractor and delegate here.

/// Load tasks.json from the supplied base dir and store it in `DbState`.
/// Returns the parsed `Database` so the TS side can immediately render
/// without a follow-up `db_get` round-trip.
///
/// Migration is intentionally NOT run here. The TS migration framework
/// (`src/migrations/index.ts`) stays canonical for now — TS calls `db_load`,
/// runs migrations, then calls `db_replace` + `db_save` if anything changed.
/// Moving migrations to Rust is a separate decision (would need to port
/// every step from TS) and is out of scope for 06-05.
pub fn db_load_into(base_dir: &str, state: &DbState) -> Result<Database, String> {
    let base = PathBuf::from(base_dir);
    let (db, _raw) = load_from_disk(&base)?;
    *state
        .base_dir
        .lock()
        .map_err(|e| format!("base_dir lock: {}", e))? = Some(base);
    *state
        .db
        .lock()
        .map_err(|e| format!("db lock: {}", e))? = Some(db.clone());
    Ok(db)
}

/// Persist the current in-memory db to disk via `save_atomic`. Both locks
/// are released before the I/O hop so a long-running disk write doesn't
/// block other commands.
pub fn db_save_current(state: &DbState) -> Result<(), String> {
    let base = {
        let g = state
            .base_dir
            .lock()
            .map_err(|e| format!("base_dir lock: {}", e))?;
        g.as_ref().ok_or("no base dir set")?.clone()
    };
    let db = {
        let g = state.db.lock().map_err(|e| format!("db lock: {}", e))?;
        g.as_ref().ok_or("no db loaded")?.clone()
    };
    save_atomic(&base, &db)
}

/// Snapshot the current in-memory db. Useful for the TS side after Rust
/// mutated the canonical copy (e.g. after `patches_apply_pending`) and the
/// frontend needs to refresh its render cache.
pub fn db_get_current(state: &DbState) -> Result<Database, String> {
    let g = state.db.lock().map_err(|e| format!("db lock: {}", e))?;
    g.as_ref().cloned().ok_or_else(|| "no db loaded".to_string())
}

/// Replace the in-memory db wholesale. Used by the TS migration pipeline:
/// after `runMigrations` produces an upgraded db, the TS side calls
/// `db_replace` + `db_save` to commit it.
pub fn db_replace_current(new_db: Database, state: &DbState) -> Result<(), String> {
    *state.db.lock().map_err(|e| format!("db lock: {}", e))? = Some(new_db);
    Ok(())
}

/// Set the base dir without loading. Used when the TS side wants to bind a
/// freshly-created in-memory db (no tasks.json on disk yet) to a folder so
/// the next `db_save` knows where to write.
pub fn db_set_base_dir(base_dir: &str, state: &DbState) -> Result<(), String> {
    *state
        .base_dir
        .lock()
        .map_err(|e| format!("base_dir lock: {}", e))? = Some(PathBuf::from(base_dir));
    Ok(())
}

/// Snapshot the current tasks.json (pre-migration) into
/// `tasks.json.v{from_version}.bak` and prune older migration backups.
/// Returns the absolute path of the snapshot for logging/toast purposes.
pub fn db_migration_backup(
    from_version: &str,
    raw_text: &str,
    state: &DbState,
) -> Result<String, String> {
    let base = {
        let g = state
            .base_dir
            .lock()
            .map_err(|e| format!("base_dir lock: {}", e))?;
        g.as_ref().ok_or("no base dir set")?.clone()
    };
    write_migration_backup(&base, from_version, raw_text)
        .map(|p| p.to_string_lossy().to_string())
}

// ─── PATCHES PIPELINE (DISK ORCHESTRATOR) ───────────────────────────────────

/// Pure (Tauri-free) implementation of the patches/ disk pipeline.
///
/// 1. Reads every `*.json` from `base/patches/`.
/// 2. Parses each into a `Patch`, recording read/parse failures as soft
///    errors (they don't abort the batch).
/// 3. Skips marker files (`_applied: true`) and best-effort removes them.
/// 4. Hands the queue to `patch::apply_batch` for in-place db mutation.
/// 5. Persists `db` to disk via `save_atomic`.
/// 6. Deletes consumed patch files. Patches whose ids appear in
///    `result.errors` stay on disk for manual inspection.
///
/// Extracted from the Tauri command wrapper so integration tests can
/// exercise the full pipeline against a tempdir without spinning up a
/// runtime.
pub fn run_patches_pipeline(base: &Path, db: &mut Database) -> Result<ApplyResult, String> {
    let patches_dir = base.join("patches");
    if !patches_dir.exists() {
        return Ok(ApplyResult {
            applied: 0,
            skipped: 0,
            errors: Vec::new(),
            applied_patch_ids: Vec::new(),
        });
    }

    // Phase 1: read + parse every .json file. Bad files (read failure /
    // invalid JSON) are recorded in `parse_errors` so the caller surfaces
    // them, but they don't abort the batch.
    let mut sources: Vec<(PatchSource, PathBuf)> = Vec::new();
    let mut parse_errors: Vec<String> = Vec::new();
    let entries = std::fs::read_dir(&patches_dir).map_err(|e| format!("read patches dir: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") {
            continue;
        }
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) => {
                parse_errors.push(format!("{}: read failed: {}", name, e));
                continue;
            }
        };
        let patch: Patch = match serde_json::from_str(&text) {
            Ok(p) => p,
            Err(e) => {
                parse_errors.push(format!("{}: invalid JSON: {}", name, e));
                continue;
            }
        };
        // Marker files (`_applied: true`) — written when a previous run
        // could not delete a consumed patch. Skip silently before queueing
        // so they never reach `apply_batch`. Best-effort delete to keep the
        // dir clean — `db.applied_patches` is the durable record now.
        if patch.applied.unwrap_or(false) {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        // Source id mirrors the legacy TS `patchIdentity` so durable
        // dedupe across the TS/Rust boundary works (the TS side previously
        // populated `db.appliedPatches` with this exact format).
        let id = format!("{}|{}", patch.timestamp, name);
        sources.push((PatchSource { id, patch }, path));
    }

    // Phase 2: apply via the pure pipeline.
    let only_sources: Vec<PatchSource> = sources.iter().map(|(s, _)| s.clone()).collect();
    let mut result = patch::apply_batch(db, only_sources);
    // Re-attach parse-time errors so the caller sees them in the same
    // summary. Keep the prefix shape (`{filename}: ...`) consistent with
    // apply-time errors so the deletion pass below can match either kind.
    result.errors.extend(parse_errors);

    // Phase 3: persist the mutated db before deleting any files. If save
    // fails we leave every patch file on disk — better to re-run than to
    // silently lose work.
    save_atomic(base, db).map_err(|e| format!("save after apply failed: {}", e))?;

    // Phase 4: delete consumed patch files. A patch file is deleted unless
    // its source id appears in `result.errors`. Marker-only files were
    // already removed during phase 1.
    let errored: std::collections::HashSet<String> = result
        .errors
        .iter()
        .filter_map(|e| {
            // Apply-time errors look like `"<id>: <msg>"`; parse-time
            // errors look like `"<filename>: <msg>"`. Both prefixes end at
            // the first `": "` (colon-space).
            e.find(": ").map(|i| e[..i].to_string())
        })
        .collect();

    for (source, path) in sources {
        if errored.contains(&source.id) {
            continue;
        }
        // Best-effort delete; if the file is locked we leave it and let
        // the next sweep retry. We don't write an `_applied` marker
        // anymore — `db.applied_patches` is the durable record of what
        // ran, and the TS pipeline used markers only to compensate for
        // the lack of a durable list.
        let _ = std::fs::remove_file(&path);
    }

    Ok(result)
}

/// Read every `*.json` file from `base/patches/`, hand them to
/// `patch::apply_batch`, persist the mutated db, then delete the consumed
/// patch files. Patches that errored are kept on disk for manual inspection.
///
/// This is the Rust-side replacement for the legacy TS
/// `_applyPatchesUnlocked` orchestrator. The pure mutation pipeline still
/// lives in `patch.rs`; this function only handles disk I/O + mutex
/// orchestration. The actual disk work happens in `run_patches_pipeline`
/// so integration tests can exercise it without a Tauri runtime.
pub fn patches_apply_pending_for(state: &DbState) -> Result<ApplyResult, String> {
    let base = {
        let g = state
            .base_dir
            .lock()
            .map_err(|e| format!("base_dir lock: {}", e))?;
        g.as_ref().ok_or("no base dir set")?.clone()
    };
    let mut g = state.db.lock().map_err(|e| format!("db lock: {}", e))?;
    let db = g.as_mut().ok_or("no db loaded")?;
    run_patches_pipeline(&base, db)
}

// ─── LOAD RESULT (TYPE EXPORT) ──────────────────────────────────────────────

/// Result wrapper used for richer load APIs. Currently only `db_load`
/// returns the bare `Database` for simplicity, but this struct is exported
/// so the TS side can construct a similar shape from its own
/// pre/post-migration state if needed.
#[derive(Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LoadResult {
    pub db: Database,
    pub migrated: bool,
    pub backup_path: Option<String>,
    pub patches_applied: u32,
}

// ─── UNIT TESTS ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn empty_db() -> Database {
        Database {
            version: Some("1.0".into()),
            schema_version: Some("1.1".into()),
            last_updated: "2026-01-01T00:00:00.000Z".into(),
            projects: vec![],
            agents: None,
            applied_patches: None,
            instructions: None,
        }
    }

    #[test]
    fn save_atomic_writes_file_and_creates_bak() {
        let dir = tempdir().unwrap();
        let db = empty_db();
        save_atomic(dir.path(), &db).unwrap();
        let main = dir.path().join("tasks.json");
        let bak = dir.path().join("tasks.json.bak");
        assert!(main.exists(), "main file should exist after save");
        assert!(bak.exists(), "bak should be created after save");
    }

    #[test]
    fn cleanup_keeps_only_newest_backups() {
        let dir = tempdir().unwrap();
        // Create 12 migration backups; cleanup keeps the newest 10.
        for i in 0..12 {
            let path = dir.path().join(format!("tasks.json.v0.{}.bak", i));
            std::fs::write(&path, format!("snap {}", i)).unwrap();
            // Stagger the sleeps would be slow; rely on creation order +
            // mtime resolution. On Windows mtime resolution is plenty
            // sharp for 12 sequential writes.
        }
        cleanup_old_migration_backups(dir.path(), 10);
        let kept: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                n.starts_with("tasks.json.v") && n.ends_with(".bak")
            })
            .collect();
        assert_eq!(kept.len(), 10, "should keep exactly 10 backups");
    }
}

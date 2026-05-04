// Integration tests for `ai_task_flow::db`.
//
// Phase 1.6.5 — moves the DB layer (load/save/migration backup/patches
// orchestrator) from TS into Rust. These tests exercise the public
// surface of `db.rs` against tempdirs so disk-side behaviour (atomic
// write, .bak rotation, patches/ pipeline, save-after-apply contract)
// is verified end-to-end without spinning up a Tauri runtime.
//
// The Tauri command wrappers themselves are trivial passthroughs into
// these helpers — once the helpers are correct, the wrappers can only
// fail on State plumbing, which the existing manual smoke test covers.

use ai_task_flow::db::{
    cleanup_old_migration_backups, load_from_disk, run_patches_pipeline, save_atomic,
    write_migration_backup, KEEP_MIGRATION_BAKS,
};
use ai_task_flow::domain::{
    Change, Database, Patch, Project, Task, TaskPriority, TaskStatus,
};
use ai_task_flow::patch::_reset_tracker_for_test;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use tempfile::tempdir;

// ─── FIXTURES ──────────────────────────────────────────────────────────────

/// Serialize tests that touch the global APPLIED_TRACKER. The patch module
/// owns it; we reset before each test that goes through `apply_batch` so
/// session state doesn't leak between cases.
static TRACKER_LOCK: Mutex<()> = Mutex::new(());

fn lock_tracker() -> std::sync::MutexGuard<'static, ()> {
    TRACKER_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn task(id: &str, status: TaskStatus) -> Task {
    Task {
        id: id.into(),
        title: id.into(),
        description: String::new(),
        status,
        priority: TaskPriority::Medium,
        agent_id: None,
        ai_agent: None,
        model: None,
        prompt: None,
        tags: vec![],
        subtasks: vec![],
        files_modified: vec![],
        last_session_id: None,
        run_history: None,
        last_note: None,
        reviews: None,
        activity_log: None,
        created_at: "2026-01-01T00:00:00.000Z".into(),
        updated_at: None,
        completed_at: None,
    }
}

fn project(id: &str, tasks: Vec<Task>) -> Project {
    Project {
        id: id.into(),
        name: id.into(),
        description: None,
        goal: None,
        working_dir: None,
        run_command: None,
        color: "#60a5fa".into(),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        tasks,
        agent_defaults: None,
    }
}

fn make_db() -> Database {
    let r1 = task("r1", TaskStatus::Todo);
    Database {
        version: Some("1.0".into()),
        schema_version: Some("1.1".into()),
        last_updated: "2026-01-01T00:00:00.000Z".into(),
        projects: vec![project("p1", vec![r1])],
        agents: None,
        applied_patches: Some(vec![]),
        instructions: None,
    }
}

fn write_patch_file(dir: &Path, name: &str, patch: &Patch) {
    let path = dir.join(name);
    fs::write(&path, serde_json::to_string_pretty(patch).unwrap()).unwrap();
}

fn make_patch(changes: Vec<Change>, ts: &str) -> Patch {
    Patch {
        version: "1.0".into(),
        timestamp: ts.into(),
        agent: "Claude".into(),
        changes,
        applied: None,
    }
}

// ─── save_atomic ───────────────────────────────────────────────────────────

#[test]
fn save_atomic_writes_main_file_and_creates_bak() {
    let dir = tempdir().unwrap();
    let db = make_db();
    save_atomic(dir.path(), &db).expect("save_atomic ok");

    let main = dir.path().join("tasks.json");
    let bak = dir.path().join("tasks.json.bak");
    assert!(main.exists(), "main tasks.json should exist");
    assert!(bak.exists(), "tasks.json.bak should be created on every save");
}

#[test]
fn save_atomic_overwrites_existing_main_file() {
    let dir = tempdir().unwrap();
    let mut db = make_db();
    save_atomic(dir.path(), &db).unwrap();

    // Mutate the in-memory db and re-save: the main file should reflect
    // the new content (atomic_write does tmp + rename).
    db.last_updated = "2099-12-31T23:59:59.000Z".into();
    save_atomic(dir.path(), &db).unwrap();

    let raw = fs::read_to_string(dir.path().join("tasks.json")).unwrap();
    assert!(raw.contains("2099-12-31"), "main file should contain new ts");
}

#[test]
fn save_then_load_roundtrip_preserves_db_shape() {
    let dir = tempdir().unwrap();
    let mut original = make_db();
    original.applied_patches = Some(vec!["x|a.json".into(), "y|b.json".into()]);

    save_atomic(dir.path(), &original).unwrap();
    let (reloaded, _raw) = load_from_disk(dir.path()).unwrap();

    assert_eq!(reloaded.last_updated, original.last_updated);
    assert_eq!(reloaded.projects.len(), 1);
    assert_eq!(reloaded.projects[0].id, "p1");
    assert_eq!(reloaded.projects[0].tasks[0].id, "r1");
    assert_eq!(reloaded.applied_patches.as_deref().unwrap().len(), 2);
}

// ─── load_from_disk ────────────────────────────────────────────────────────

#[test]
fn load_from_disk_returns_err_for_missing_file() {
    let dir = tempdir().unwrap();
    let err = load_from_disk(dir.path()).expect_err("should err on missing tasks.json");
    assert!(err.contains("read tasks.json"), "err = {}", err);
}

#[test]
fn load_from_disk_returns_err_for_malformed_json() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("tasks.json"), "{not json").unwrap();
    let err = load_from_disk(dir.path()).expect_err("should err on bad JSON");
    assert!(err.contains("parse tasks.json"), "err = {}", err);
}

#[test]
fn load_from_disk_returns_raw_text_unmodified() {
    let dir = tempdir().unwrap();
    let db = make_db();
    save_atomic(dir.path(), &db).unwrap();

    let on_disk = fs::read_to_string(dir.path().join("tasks.json")).unwrap();
    let (_db, raw) = load_from_disk(dir.path()).unwrap();
    assert_eq!(raw, on_disk, "load helper should return the byte-identical raw text");
}

// ─── write_migration_backup + cleanup ──────────────────────────────────────

#[test]
fn write_migration_backup_creates_versioned_file() {
    let dir = tempdir().unwrap();
    let raw = r#"{"version":"1.0","projects":[]}"#;
    let path = write_migration_backup(dir.path(), "1.0", raw).unwrap();

    assert!(path.exists(), "backup file should be created");
    assert_eq!(
        path.file_name().unwrap().to_string_lossy(),
        "tasks.json.v1.0.bak"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), raw);
}

#[test]
fn cleanup_keeps_only_newest_n_backups() {
    let dir = tempdir().unwrap();
    // Create more backups than the retention limit. mtime ordering is
    // determined by creation order (Windows mtime resolution is plenty
    // sharp for sequential writes).
    for i in 0..15 {
        write_migration_backup(dir.path(), &format!("0.{}", i), &format!("snap {}", i)).unwrap();
    }

    let kept: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            n.starts_with("tasks.json.v") && n.ends_with(".bak")
        })
        .collect();
    assert_eq!(
        kept.len(),
        KEEP_MIGRATION_BAKS,
        "cleanup should leave exactly {} backups",
        KEEP_MIGRATION_BAKS
    );
}

#[test]
fn cleanup_does_not_delete_non_migration_files() {
    let dir = tempdir().unwrap();
    // Put a regular tasks.json + a regular .bak in the dir.
    fs::write(dir.path().join("tasks.json"), "{}").unwrap();
    fs::write(dir.path().join("tasks.json.bak"), "{}").unwrap();
    fs::write(dir.path().join("readme.txt"), "hi").unwrap();
    // Add a few migration backups too.
    for i in 0..5 {
        write_migration_backup(dir.path(), &format!("9.{}", i), "x").unwrap();
    }
    cleanup_old_migration_backups(dir.path(), 2);

    // Non-migration files must survive the cleanup.
    assert!(dir.path().join("tasks.json").exists());
    assert!(dir.path().join("tasks.json.bak").exists());
    assert!(dir.path().join("readme.txt").exists());
    let migration_count = fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            n.starts_with("tasks.json.v") && n.ends_with(".bak")
        })
        .count();
    assert_eq!(migration_count, 2, "migration backups capped at retention");
}

// ─── patches pipeline ──────────────────────────────────────────────────────

#[test]
fn patches_pipeline_applies_and_consumes_files() {
    let _g = lock_tracker();
    _reset_tracker_for_test();

    let dir = tempdir().unwrap();
    let patches = dir.path().join("patches");
    fs::create_dir(&patches).unwrap();

    let mut db = make_db();
    save_atomic(dir.path(), &db).unwrap();

    write_patch_file(
        &patches,
        "a.json",
        &make_patch(
            vec![Change::FilesModified {
                project_id: "p1".into(),
                task_id: "r1".into(),
                files: vec!["one.ts".into()],
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    );
    write_patch_file(
        &patches,
        "b.json",
        &make_patch(
            vec![Change::FilesModified {
                project_id: "p1".into(),
                task_id: "r1".into(),
                files: vec!["two.ts".into()],
            }],
            "2026-05-03T10:01:00.000Z",
        ),
    );

    let result = run_patches_pipeline(dir.path(), &mut db).unwrap();
    assert_eq!(result.applied, 2);
    assert_eq!(result.skipped, 0);
    assert!(result.errors.is_empty(), "errors = {:?}", result.errors);
    assert!(!patches.join("a.json").exists(), "a.json should be deleted");
    assert!(!patches.join("b.json").exists(), "b.json should be deleted");

    // db was mutated in place AND saved to disk.
    let (reloaded, _) = load_from_disk(dir.path()).unwrap();
    let task = &reloaded.projects[0].tasks[0];
    assert_eq!(task.files_modified, vec!["one.ts", "two.ts"]);
}

#[test]
fn patches_pipeline_skips_already_applied() {
    let _g = lock_tracker();
    _reset_tracker_for_test();

    let dir = tempdir().unwrap();
    let patches = dir.path().join("patches");
    fs::create_dir(&patches).unwrap();

    let mut db = make_db();
    // Pre-populate the durable applied list with the id we expect this
    // patch to generate (`{timestamp}|{filename}` per legacy format).
    db.applied_patches = Some(vec!["2026-05-03T10:00:00.000Z|a.json".into()]);
    save_atomic(dir.path(), &db).unwrap();

    write_patch_file(
        &patches,
        "a.json",
        &make_patch(
            vec![Change::FilesModified {
                project_id: "p1".into(),
                task_id: "r1".into(),
                files: vec!["x.ts".into()],
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    );

    let result = run_patches_pipeline(dir.path(), &mut db).unwrap();
    assert_eq!(result.applied, 0);
    assert_eq!(result.skipped, 1);
    // Already-applied patches still have their files removed (they
    // weren't in the errors set), keeping the dir clean.
    assert!(!patches.join("a.json").exists());
    // db wasn't mutated.
    assert!(db.projects[0].tasks[0].files_modified.is_empty());
}

#[test]
fn patches_pipeline_keeps_errored_files_on_disk() {
    let _g = lock_tracker();
    _reset_tracker_for_test();

    let dir = tempdir().unwrap();
    let patches = dir.path().join("patches");
    fs::create_dir(&patches).unwrap();

    let mut db = make_db();
    save_atomic(dir.path(), &db).unwrap();

    // Put a malformed JSON file alongside a good patch. The malformed one
    // should be reported in errors and stay on disk; the good one applies
    // and gets deleted.
    fs::write(patches.join("broken.json"), "{not json").unwrap();
    write_patch_file(
        &patches,
        "good.json",
        &make_patch(
            vec![Change::FilesModified {
                project_id: "p1".into(),
                task_id: "r1".into(),
                files: vec!["good.ts".into()],
            }],
            "2026-05-03T11:00:00.000Z",
        ),
    );

    let result = run_patches_pipeline(dir.path(), &mut db).unwrap();
    assert_eq!(result.applied, 1);
    assert!(
        result.errors.iter().any(|e| e.starts_with("broken.json:")),
        "errors = {:?}",
        result.errors
    );
    assert!(patches.join("broken.json").exists(), "errored file kept");
    assert!(!patches.join("good.json").exists(), "good file deleted");
}

#[test]
fn patches_pipeline_empty_dir_returns_zero_counts() {
    let _g = lock_tracker();
    _reset_tracker_for_test();

    let dir = tempdir().unwrap();
    let patches = dir.path().join("patches");
    fs::create_dir(&patches).unwrap();

    let mut db = make_db();
    save_atomic(dir.path(), &db).unwrap();

    let result = run_patches_pipeline(dir.path(), &mut db).unwrap();
    assert_eq!(result.applied, 0);
    assert_eq!(result.skipped, 0);
    assert!(result.errors.is_empty());
    assert!(result.applied_patch_ids.is_empty());
}

#[test]
fn patches_pipeline_missing_dir_returns_zero_counts() {
    let _g = lock_tracker();
    _reset_tracker_for_test();

    let dir = tempdir().unwrap();
    // Note: no patches/ subdir created.

    let mut db = make_db();
    let result = run_patches_pipeline(dir.path(), &mut db).unwrap();
    assert_eq!(result.applied, 0);
    assert_eq!(result.skipped, 0);
    assert!(result.errors.is_empty());
}

#[test]
fn patches_pipeline_consumes_marker_files() {
    let _g = lock_tracker();
    _reset_tracker_for_test();

    let dir = tempdir().unwrap();
    let patches = dir.path().join("patches");
    fs::create_dir(&patches).unwrap();

    let mut db = make_db();
    save_atomic(dir.path(), &db).unwrap();

    // A marker-only file (`_applied: true`). Should be silently removed
    // and NOT count as applied or skipped.
    fs::write(patches.join("marker.json"), r#"{"version":"1.0","timestamp":"","agent":"","changes":[],"_applied":true}"#).unwrap();

    let result = run_patches_pipeline(dir.path(), &mut db).unwrap();
    assert_eq!(result.applied, 0);
    assert_eq!(result.skipped, 0, "markers don't count as skips");
    assert!(!patches.join("marker.json").exists(), "marker file removed");
}

#[test]
fn patches_pipeline_persists_db_after_apply() {
    let _g = lock_tracker();
    _reset_tracker_for_test();

    let dir = tempdir().unwrap();
    let patches = dir.path().join("patches");
    fs::create_dir(&patches).unwrap();

    let mut db = make_db();
    // No initial save: pipeline must do it. (run_patches_pipeline calls
    // save_atomic internally, which is what creates tasks.json.)

    write_patch_file(
        &patches,
        "a.json",
        &make_patch(
            vec![Change::StatusChange {
                project_id: "p1".into(),
                task_id: "r1".into(),
                from: None,
                to: TaskStatus::InProgress,
                note: Some("started".into()),
            }],
            "2026-05-03T12:00:00.000Z",
        ),
    );

    let result = run_patches_pipeline(dir.path(), &mut db).unwrap();
    assert_eq!(result.applied, 1);

    // Reload from disk and confirm the status change persisted.
    let (reloaded, _) = load_from_disk(dir.path()).unwrap();
    assert_eq!(reloaded.projects[0].tasks[0].status, TaskStatus::InProgress);
}

#[test]
fn patches_pipeline_applies_in_timestamp_order() {
    let _g = lock_tracker();
    _reset_tracker_for_test();

    let dir = tempdir().unwrap();
    let patches = dir.path().join("patches");
    fs::create_dir(&patches).unwrap();

    let mut db = make_db();
    save_atomic(dir.path(), &db).unwrap();

    // Two status changes — the later one should win. Files are written in
    // reverse alphabetical order to prove sort happens by timestamp, not
    // by filesystem iteration order.
    write_patch_file(
        &patches,
        "z.json",
        &make_patch(
            vec![Change::StatusChange {
                project_id: "p1".into(),
                task_id: "r1".into(),
                from: None,
                to: TaskStatus::InProgress,
                note: None,
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    );
    write_patch_file(
        &patches,
        "a.json",
        &make_patch(
            vec![Change::StatusChange {
                project_id: "p1".into(),
                task_id: "r1".into(),
                from: None,
                to: TaskStatus::PendingReview,
                note: None,
            }],
            "2026-05-03T11:00:00.000Z",
        ),
    );

    let result = run_patches_pipeline(dir.path(), &mut db).unwrap();
    assert_eq!(result.applied, 2);
    assert_eq!(
        db.projects[0].tasks[0].status,
        TaskStatus::PendingReview,
        "later patch wins"
    );
}

#[test]
fn patches_pipeline_records_ids_in_applied_patches() {
    let _g = lock_tracker();
    _reset_tracker_for_test();

    let dir = tempdir().unwrap();
    let patches = dir.path().join("patches");
    fs::create_dir(&patches).unwrap();

    let mut db = make_db();
    save_atomic(dir.path(), &db).unwrap();

    write_patch_file(
        &patches,
        "a.json",
        &make_patch(
            vec![Change::FilesModified {
                project_id: "p1".into(),
                task_id: "r1".into(),
                files: vec!["a.ts".into()],
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    );

    run_patches_pipeline(dir.path(), &mut db).unwrap();
    let durable = db.applied_patches.as_ref().expect("durable list set");
    assert_eq!(durable.len(), 1);
    assert!(durable[0].ends_with("|a.json"));
}

// ─── Concurrency ───────────────────────────────────────────────────────────

#[test]
fn concurrent_save_does_not_corrupt() {
    use std::sync::Arc;
    use std::thread;

    let dir = tempdir().unwrap();
    let base: Arc<std::path::PathBuf> = Arc::new(dir.path().to_path_buf());
    let db = Arc::new(make_db());

    // Spawn 8 threads all racing to save the same db. atomic_write uses
    // tmp + rename, so even if writes interleave the final tasks.json
    // must always parse cleanly and reflect ONE complete save (not a
    // torn merge of multiple).
    let mut handles = Vec::new();
    for _ in 0..8 {
        let base = Arc::clone(&base);
        let db = Arc::clone(&db);
        handles.push(thread::spawn(move || {
            // Many writers race; each call should succeed or fail cleanly
            // (no partial state left behind).
            let _ = save_atomic(&base, &db);
        }));
    }
    for h in handles {
        h.join().unwrap();
    }

    // After the storm: tasks.json must exist and parse to a valid db.
    let (loaded, _) = load_from_disk(&base).expect("final state should be loadable");
    assert_eq!(loaded.projects.len(), 1);
    assert_eq!(loaded.projects[0].id, "p1");
}

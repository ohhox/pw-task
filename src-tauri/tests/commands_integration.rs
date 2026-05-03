// Integration tests for Tauri command behaviors.
// Tauri commands in main.rs are thin wrappers around std::fs — we test
// the same filesystem operations with the same logic here.

use std::fs;
use std::path::PathBuf;
use tempfile::tempdir;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent dir")
        .join("tests/fixtures")
}

// ── read_text_file ──────────────────────────────────────────────────────────

#[test]
fn read_text_file_happy_path() {
    let path = fixtures_dir().join("single-project/tasks.json");
    let text = fs::read_to_string(&path).expect("should read fixture");
    let json: serde_json::Value = serde_json::from_str(&text).expect("should be valid JSON");
    assert_eq!(json["version"], "1.0");
    assert!(json["projects"].as_array().unwrap().len() > 0);
}

#[test]
fn read_text_file_missing_returns_error() {
    let result = fs::read_to_string(fixtures_dir().join("nonexistent.json"));
    assert!(result.is_err());
}

#[test]
fn read_text_file_preserves_unicode() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("thai.json");
    let content = r#"{"title":"สวัสดี","note":"ทดสอบ unicode ภาษาไทย"}"#;
    fs::write(&path, content).unwrap();
    let read_back = fs::read_to_string(&path).unwrap();
    assert_eq!(read_back, content);
}

// ── write_text_file ─────────────────────────────────────────────────────────

#[test]
fn write_text_file_creates_and_reads_back() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("output.json");
    let content = r#"{"version":"1.0","projects":[]}"#;
    fs::write(&path, content).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), content);
}

#[test]
fn write_text_file_overwrites_existing() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("data.json");
    fs::write(&path, "old content").unwrap();
    fs::write(&path, "new content").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "new content");
}

#[test]
fn write_text_file_missing_parent_returns_error() {
    let result = fs::write("/nonexistent_dir_xyz/file.json", "data");
    assert!(result.is_err());
}

// ── read_dir ────────────────────────────────────────────────────────────────

#[test]
fn read_dir_lists_all_fixture_scenarios() {
    let dir = fixtures_dir();
    let mut names: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();

    for expected in &[
        "corrupted",
        "empty",
        "legacy-schema",
        "mixed-status",
        "nested-subtasks",
        "single-project",
        "with-pending-patches",
    ] {
        assert!(names.contains(&expected.to_string()), "missing fixture: {}", expected);
    }
}

#[test]
fn read_dir_returns_name_and_path_for_each_entry() {
    let dir = fixtures_dir().join("with-pending-patches/patches");
    let entries: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .collect();
    assert!(entries.len() >= 3, "should have at least 3 patch files");
    for entry in &entries {
        assert!(!entry.file_name().is_empty());
        assert!(entry.path().exists());
    }
}

#[test]
fn read_dir_missing_returns_error() {
    let result = fs::read_dir(fixtures_dir().join("does_not_exist"));
    assert!(result.is_err());
}

// ── remove_file ─────────────────────────────────────────────────────────────

#[test]
fn remove_file_deletes_existing() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("to_delete.json");
    fs::write(&path, "{}").unwrap();
    assert!(path.exists());
    fs::remove_file(&path).unwrap();
    assert!(!path.exists());
}

#[test]
fn remove_file_missing_returns_error() {
    let result = fs::remove_file("/nonexistent_file_xyz.json");
    assert!(result.is_err());
}

#[test]
fn remove_file_does_not_affect_siblings() {
    let dir = tempdir().unwrap();
    let keep = dir.path().join("keep.json");
    let del = dir.path().join("delete.json");
    fs::write(&keep, "keep").unwrap();
    fs::write(&del, "delete").unwrap();
    fs::remove_file(&del).unwrap();
    assert!(keep.exists());
    assert!(!del.exists());
}

// ── create_dir ──────────────────────────────────────────────────────────────

#[test]
fn create_dir_creates_nested_path() {
    let dir = tempdir().unwrap();
    let nested = dir.path().join("a/b/c/patches");
    fs::create_dir_all(&nested).unwrap();
    assert!(nested.exists());
    assert!(nested.is_dir());
}

#[test]
fn create_dir_is_idempotent() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("mydir");
    fs::create_dir_all(&path).unwrap();
    // second call must not error
    fs::create_dir_all(&path).unwrap();
    assert!(path.is_dir());
}

#[test]
fn create_dir_allows_writing_files_inside() {
    let dir = tempdir().unwrap();
    let patches = dir.path().join("patches");
    fs::create_dir_all(&patches).unwrap();
    let patch_file = patches.join("2026-05-02T10-00-00_Claude.json");
    fs::write(&patch_file, r#"{"version":"1.0","changes":[]}"#).unwrap();
    assert!(patch_file.exists());
}

// ── config read/write ────────────────────────────────────────────────────────

#[test]
fn config_roundtrip_tasks_dir() {
    let dir = tempdir().unwrap();
    let config_path = dir.path().join("config.json");
    let tasks_dir = r"D:\DEV\MyProject\outputs";

    // same logic as set_config
    let cfg = serde_json::json!({ "tasksDir": tasks_dir });
    fs::write(&config_path, serde_json::to_string_pretty(&cfg).unwrap()).unwrap();

    // same logic as get_config
    let text = fs::read_to_string(&config_path).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["tasksDir"].as_str().unwrap(), tasks_dir);
}

#[test]
fn config_missing_returns_io_error() {
    let dir = tempdir().unwrap();
    let result = fs::read_to_string(dir.path().join("config.json"));
    assert!(result.is_err());
}

#[test]
fn config_invalid_json_is_parse_error() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("config.json");
    fs::write(&path, "not json {{{").unwrap();
    let text = fs::read_to_string(&path).unwrap();
    let result = serde_json::from_str::<serde_json::Value>(&text);
    assert!(result.is_err());
}

// ── fixture integrity ────────────────────────────────────────────────────────

#[test]
fn all_fixture_tasks_json_are_parseable() {
    let scenarios = [
        "single-project",
        "empty",
        "nested-subtasks",
        "legacy-schema",
        "corrupted",
        "mixed-status",
        "with-pending-patches",
    ];
    for scenario in &scenarios {
        let path = fixtures_dir().join(scenario).join("tasks.json");
        let text = fs::read_to_string(&path)
            .unwrap_or_else(|_| panic!("cannot read {}/tasks.json", scenario));
        let json: serde_json::Value = serde_json::from_str(&text)
            .unwrap_or_else(|e| panic!("{}/tasks.json parse error: {}", scenario, e));
        assert_eq!(json["version"], "1.0", "{}/tasks.json missing version", scenario);
        assert!(json["projects"].is_array(), "{}/tasks.json missing projects array", scenario);
    }
}

#[test]
fn patch_fixture_files_have_required_fields() {
    let patches_dir = fixtures_dir().join("with-pending-patches/patches");
    let entries: Vec<_> = fs::read_dir(&patches_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
        .collect();
    assert!(!entries.is_empty(), "patch fixture dir should have .json files");

    for entry in &entries {
        let text = fs::read_to_string(entry.path()).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text)
            .unwrap_or_else(|_| panic!("{:?} is invalid JSON", entry.file_name()));
        assert_eq!(json["version"], "1.0", "{:?} missing version", entry.file_name());
        assert!(json["changes"].is_array(), "{:?} missing changes array", entry.file_name());
        assert!(json["timestamp"].is_string(), "{:?} missing timestamp", entry.file_name());
    }
}

#[test]
fn corrupted_fixture_loads_despite_bad_data() {
    // corrupted/tasks.json is valid JSON but has semantic issues (unknown status,
    // null fields, duplicate ids) — we just verify it parses without panicking
    let path = fixtures_dir().join("corrupted/tasks.json");
    let text = fs::read_to_string(&path).unwrap();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    let tasks = json["projects"][0]["tasks"].as_array().unwrap();
    assert!(tasks.len() >= 4);
    // unknown_status should be preserved as-is (no mapping)
    assert_eq!(tasks[0]["status"], "unknown_status");
    // null priority should be preserved
    assert!(tasks[1]["priority"].is_null());
}

#[test]
fn patch_changes_reference_valid_types() {
    let valid_types = ["status_change", "add_task", "add_project", "files_modified", "add_log"];
    let patches_dir = fixtures_dir().join("with-pending-patches/patches");

    for entry in fs::read_dir(&patches_dir).unwrap().filter_map(|e| e.ok()) {
        if !entry.file_name().to_string_lossy().ends_with(".json") { continue; }
        let text = fs::read_to_string(entry.path()).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        for change in json["changes"].as_array().unwrap() {
            let t = change["type"].as_str().unwrap_or("");
            assert!(valid_types.contains(&t), "unknown change type '{}' in {:?}", t, entry.file_name());
        }
    }
}

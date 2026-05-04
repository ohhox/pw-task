// Integration tests for Tauri command helpers.
//
// These tests exercise the pure functions in `ai_task_flow::*` (the library
// crate) — the same helpers that the `#[tauri::command]` wrappers in
// `main.rs` delegate to. No Tauri runtime is started and no test touches
// real `%APPDATA%`; everything goes through `tempfile::TempDir`.

use ai_task_flow::{
    atomic_write, config_path_for, create_dir, delete_file, exe_dir, list_dir, parse_claude_line,
    read_config_from, read_config_with_fallback, read_file, write_config_to, write_file,
    ParsedClaudeLine,
};
use std::fs;
use std::path::PathBuf;
use tempfile::tempdir;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent dir")
        .join("tests/fixtures")
}

// ── read_text_file / write_text_file roundtrip ──────────────────────────────

#[test]
fn read_write_roundtrip_basic_ascii() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("data.json").to_string_lossy().to_string();
    let content = r#"{"version":"1.0","projects":[]}"#;
    write_file(&path, content).expect("write should succeed");
    let got = read_file(&path).expect("read should succeed");
    assert_eq!(got, content);
}

#[test]
fn read_write_roundtrip_preserves_unicode_and_whitespace() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("thai.json").to_string_lossy().to_string();
    // Mix Thai unicode, leading/trailing whitespace, multiple newlines, tabs
    let content = "  \n{\n\t\"title\": \"สวัสดี\",\n\t\"note\": \"ทดสอบ unicode ภาษาไทย 中文\"\n}\n  \n";
    write_file(&path, content).unwrap();
    let got = read_file(&path).unwrap();
    assert_eq!(got, content, "roundtrip must preserve every byte");
}

#[test]
fn write_file_overwrites_existing() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("d.json").to_string_lossy().to_string();
    write_file(&path, "old").unwrap();
    write_file(&path, "new").unwrap();
    assert_eq!(read_file(&path).unwrap(), "new");
}

#[test]
fn read_file_missing_returns_err_string() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("nope.json").to_string_lossy().to_string();
    let err = read_file(&path).expect_err("missing file should error");
    assert!(!err.is_empty(), "error should describe the failure");
}

#[test]
fn write_file_to_missing_parent_returns_err_string() {
    let dir = tempdir().unwrap();
    let bad = dir
        .path()
        .join("does_not_exist_subdir")
        .join("file.json")
        .to_string_lossy()
        .to_string();
    let err = write_file(&bad, "data").expect_err("missing parent should error");
    assert!(!err.is_empty());
}

// ── get_config / set_config roundtrip ───────────────────────────────────────

#[test]
fn config_roundtrip_returns_same_tasks_dir() {
    let dir = tempdir().unwrap();
    let cfg_path = config_path_for(dir.path());
    let tasks_dir = r"D:\DEV\MyProject\outputs";

    write_config_to(&cfg_path, tasks_dir).expect("write_config_to ok");
    let got = read_config_from(&cfg_path);

    assert_eq!(got, tasks_dir);
}

#[test]
fn config_roundtrip_preserves_unicode_path() {
    let dir = tempdir().unwrap();
    let cfg_path = config_path_for(dir.path());
    let tasks_dir = r"D:\DEV\โปรเจกต์\outputs";

    write_config_to(&cfg_path, tasks_dir).unwrap();
    let got = read_config_from(&cfg_path);
    assert_eq!(got, tasks_dir);
}

#[test]
fn config_roundtrip_preserves_whitespace_in_value() {
    let dir = tempdir().unwrap();
    let cfg_path = config_path_for(dir.path());
    // Path with spaces and trailing whitespace must roundtrip exactly
    let tasks_dir = "C:\\My Project Files\\outputs ";

    write_config_to(&cfg_path, tasks_dir).unwrap();
    let got = read_config_from(&cfg_path);
    assert_eq!(got, tasks_dir);

    // And the on-disk file should be valid pretty JSON
    let raw = fs::read_to_string(&cfg_path).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).expect("must be valid JSON");
    assert_eq!(parsed["tasksDir"].as_str().unwrap(), tasks_dir);
    assert!(raw.contains('\n'), "set_config should write pretty JSON with newlines");
}

#[test]
fn read_config_missing_file_returns_empty_string() {
    let dir = tempdir().unwrap();
    let cfg_path = config_path_for(dir.path());
    assert_eq!(read_config_from(&cfg_path), "");
}

#[test]
fn read_config_invalid_json_returns_empty_string() {
    let dir = tempdir().unwrap();
    let cfg_path = config_path_for(dir.path());
    fs::write(&cfg_path, "not json {{{ broken").unwrap();
    assert_eq!(read_config_from(&cfg_path), "");
}

#[test]
fn read_config_missing_tasks_dir_key_returns_empty_string() {
    let dir = tempdir().unwrap();
    let cfg_path = config_path_for(dir.path());
    fs::write(&cfg_path, r#"{"otherKey": "value"}"#).unwrap();
    assert_eq!(read_config_from(&cfg_path), "");
}

#[test]
fn read_config_with_fallback_prefers_primary() {
    let dir = tempdir().unwrap();
    let primary = dir.path().join("primary.json");
    let legacy = dir.path().join("legacy.json");

    write_config_to(&primary, "C:\\primary").unwrap();
    write_config_to(&legacy, "C:\\legacy").unwrap();

    assert_eq!(read_config_with_fallback(&primary, &legacy), "C:\\primary");
}

#[test]
fn read_config_with_fallback_uses_legacy_when_primary_missing() {
    let dir = tempdir().unwrap();
    let primary = dir.path().join("primary.json");
    let legacy = dir.path().join("legacy.json");

    write_config_to(&legacy, "C:\\legacy").unwrap();

    assert_eq!(read_config_with_fallback(&primary, &legacy), "C:\\legacy");
}

#[test]
fn read_config_with_fallback_empty_when_neither_present() {
    let dir = tempdir().unwrap();
    let primary = dir.path().join("primary.json");
    let legacy = dir.path().join("legacy.json");

    assert_eq!(read_config_with_fallback(&primary, &legacy), "");
}

// ── config_path_for / exe_dir ───────────────────────────────────────────────

#[test]
fn config_path_for_appends_config_json() {
    let dir = tempdir().unwrap();
    let cfg = config_path_for(dir.path());
    assert_eq!(cfg.file_name().unwrap(), "config.json");
    assert_eq!(cfg.parent().unwrap(), dir.path());
}

#[test]
fn exe_dir_returns_existing_directory() {
    // Should always succeed because the test binary itself has a parent dir.
    let dir = exe_dir();
    assert!(dir.is_dir() || dir == PathBuf::from("."), "exe_dir should resolve to a real dir, got {:?}", dir);
}

// ── read_dir / list_dir ─────────────────────────────────────────────────────

#[test]
fn list_dir_returns_expected_entries_with_name_and_path() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("a.json"), "{}").unwrap();
    fs::write(dir.path().join("b.json"), "{}").unwrap();
    fs::write(dir.path().join("c.json"), "{}").unwrap();

    let entries = list_dir(&dir.path().to_string_lossy()).expect("list_dir ok");
    assert_eq!(entries.len(), 3);

    let mut names: Vec<String> = entries
        .iter()
        .map(|e| e["name"].as_str().unwrap().to_string())
        .collect();
    names.sort();
    assert_eq!(names, vec!["a.json", "b.json", "c.json"]);

    for entry in &entries {
        assert!(entry["path"].is_string());
        assert!(entry["name"].is_string());
        let path_str = entry["path"].as_str().unwrap();
        assert!(PathBuf::from(path_str).exists(), "{} should exist", path_str);
    }
}

#[test]
fn list_dir_missing_path_returns_err() {
    let dir = tempdir().unwrap();
    let bad = dir.path().join("does_not_exist").to_string_lossy().to_string();
    let err = list_dir(&bad).expect_err("missing dir should error");
    assert!(!err.is_empty());
}

#[test]
fn list_dir_empty_directory_returns_empty_vec() {
    let dir = tempdir().unwrap();
    let entries = list_dir(&dir.path().to_string_lossy()).unwrap();
    assert!(entries.is_empty());
}

// ── delete_file ─────────────────────────────────────────────────────────────

#[test]
fn delete_file_removes_existing_file() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("victim.json").to_string_lossy().to_string();
    write_file(&path, "{}").unwrap();
    assert!(PathBuf::from(&path).exists());
    delete_file(&path).unwrap();
    assert!(!PathBuf::from(&path).exists());
}

#[test]
fn delete_file_missing_returns_err() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("ghost.json").to_string_lossy().to_string();
    assert!(delete_file(&path).is_err());
}

// ── create_dir ──────────────────────────────────────────────────────────────

#[test]
fn create_dir_makes_nested_path_and_is_idempotent() {
    let dir = tempdir().unwrap();
    let nested = dir.path().join("a/b/c/patches");
    let nested_str = nested.to_string_lossy().to_string();
    create_dir(&nested_str).unwrap();
    assert!(nested.is_dir());
    // Calling again must not error
    create_dir(&nested_str).unwrap();
    assert!(nested.is_dir());
}

// ── atomic_write ────────────────────────────────────────────────────────────

#[test]
fn atomic_write_creates_target_when_absent() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("t.json").to_string_lossy().to_string();
    atomic_write(&path, "hello").unwrap();
    assert_eq!(read_file(&path).unwrap(), "hello");
}

#[test]
fn atomic_write_overwrites_and_creates_bak_snapshot() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("t.json").to_string_lossy().to_string();
    write_file(&path, "v1").unwrap();
    atomic_write(&path, "v2").unwrap();
    assert_eq!(read_file(&path).unwrap(), "v2");
    // .bak should hold the previous content
    let bak_path = format!("{}.bak", path);
    assert!(PathBuf::from(&bak_path).exists(), ".bak snapshot should exist");
    assert_eq!(read_file(&bak_path).unwrap(), "v1");
}

// ── parse_claude_line ───────────────────────────────────────────────────────

#[test]
fn parse_claude_line_empty_returns_default_no_plain_text() {
    let parsed = parse_claude_line("");
    assert_eq!(parsed, ParsedClaudeLine::default());
    assert!(!parsed.is_plain_text);
    assert!(parsed.chunks.is_empty());
    assert!(parsed.session_id.is_none());
}

#[test]
fn parse_claude_line_malformed_marks_plain_text() {
    let parsed = parse_claude_line("not json at all { broken");
    assert!(parsed.is_plain_text);
    assert!(parsed.chunks.is_empty());
    assert!(parsed.session_id.is_none());
    assert!(parsed.fallback_result.is_none());
}

#[test]
fn parse_claude_line_assistant_text_splits_on_newlines() {
    let line = serde_json::json!({
        "type": "assistant",
        "session_id": "sess-abc-123",
        "message": {
            "content": [
                { "type": "text", "text": "line one\nline two\nline three" }
            ]
        }
    })
    .to_string();

    let parsed = parse_claude_line(&line);
    assert!(!parsed.is_plain_text);
    assert_eq!(parsed.session_id.as_deref(), Some("sess-abc-123"));
    assert_eq!(parsed.chunks, vec!["line one", "line two", "line three"]);
    assert!(parsed.fallback_result.is_none());
    assert!(!parsed.is_result);
}

#[test]
fn parse_claude_line_assistant_ignores_non_text_blocks() {
    let line = serde_json::json!({
        "type": "assistant",
        "message": {
            "content": [
                { "type": "tool_use", "id": "x", "name": "Bash", "input": {} },
                { "type": "text", "text": "hello" }
            ]
        }
    })
    .to_string();

    let parsed = parse_claude_line(&line);
    assert_eq!(parsed.chunks, vec!["hello"]);
}

#[test]
fn parse_claude_line_result_captures_session_and_fallback() {
    let line = serde_json::json!({
        "type": "result",
        "session_id": "sess-final",
        "result": "the final answer"
    })
    .to_string();

    let parsed = parse_claude_line(&line);
    assert!(parsed.is_result);
    assert_eq!(parsed.session_id.as_deref(), Some("sess-final"));
    assert_eq!(parsed.fallback_result.as_deref(), Some("the final answer"));
    assert!(parsed.chunks.is_empty());
}

#[test]
fn parse_claude_line_unknown_type_yields_only_session_id() {
    let line = serde_json::json!({
        "type": "system",
        "session_id": "sess-sys",
        "subtype": "init"
    })
    .to_string();

    let parsed = parse_claude_line(&line);
    assert_eq!(parsed.session_id.as_deref(), Some("sess-sys"));
    assert!(parsed.chunks.is_empty());
    assert!(parsed.fallback_result.is_none());
    assert!(!parsed.is_result);
    assert!(!parsed.is_plain_text);
}

#[test]
fn parse_claude_line_assistant_no_session_id_field_is_none() {
    let line = serde_json::json!({
        "type": "assistant",
        "message": { "content": [ { "type": "text", "text": "hi" } ] }
    })
    .to_string();

    let parsed = parse_claude_line(&line);
    assert!(parsed.session_id.is_none());
    assert_eq!(parsed.chunks, vec!["hi"]);
}

// ── parse_claude_line — token usage tracking ────────────────────────────────

#[test]
fn parse_claude_line_result_captures_usage_and_cost() {
    let line = serde_json::json!({
        "type": "result",
        "subtype": "success",
        "session_id": "sess-cost-001",
        "result": "done",
        "total_cost_usd": 0.00312,
        "usage": {
            "input_tokens": 1024,
            "output_tokens": 256,
            "cache_creation_input_tokens": 512,
            "cache_read_input_tokens": 128
        }
    })
    .to_string();

    let parsed = parse_claude_line(&line);
    assert!(parsed.is_result, "should be marked as a result line");

    let usage = parsed.usage.expect("usage should be Some on a result line");
    assert_eq!(usage.input_tokens, 1024);
    assert_eq!(usage.output_tokens, 256);
    assert_eq!(usage.cache_creation_input_tokens, 512);
    assert_eq!(usage.cache_read_input_tokens, 128);
    // Float comparison with a small epsilon
    assert!(
        (usage.total_cost_usd - 0.00312).abs() < 1e-9,
        "total_cost_usd should match the server value, got {}",
        usage.total_cost_usd
    );
}

#[test]
fn parse_claude_line_assistant_has_no_usage() {
    let line = serde_json::json!({
        "type": "assistant",
        "session_id": "sess-asst",
        "message": {
            "content": [{ "type": "text", "text": "hello world" }],
            "usage": {
                "input_tokens": 50,
                "output_tokens": 10
            }
        }
    })
    .to_string();

    let parsed = parse_claude_line(&line);
    assert!(!parsed.is_result, "assistant line is not a result");
    assert!(
        parsed.usage.is_none(),
        "usage should be None for non-result lines"
    );
    assert_eq!(parsed.chunks, vec!["hello world"]);
}

#[test]
fn parse_claude_line_result_missing_usage_field_returns_zeros() {
    // A result line with total_cost_usd but no usage sub-object.
    // Policy: still produce Some(TokenUsage) with all-zero token counts
    // so callers can still read the cost without special-casing None.
    let line = serde_json::json!({
        "type": "result",
        "subtype": "success",
        "session_id": "sess-nousage",
        "result": "done",
        "total_cost_usd": 0.001
    })
    .to_string();

    let parsed = parse_claude_line(&line);
    assert!(parsed.is_result);

    let usage = parsed.usage.expect("usage should be Some even without usage sub-object");
    assert_eq!(usage.input_tokens, 0, "missing field defaults to 0");
    assert_eq!(usage.output_tokens, 0, "missing field defaults to 0");
    assert_eq!(usage.cache_creation_input_tokens, 0, "missing field defaults to 0");
    assert_eq!(usage.cache_read_input_tokens, 0, "missing field defaults to 0");
    assert!(
        (usage.total_cost_usd - 0.001).abs() < 1e-9,
        "cost should still be captured"
    );
}

// ── existing fixture sanity checks (kept) ───────────────────────────────────

#[test]
fn fixtures_dir_contains_expected_scenarios() {
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
fn list_dir_against_fixture_returns_patches() {
    let patches = fixtures_dir().join("with-pending-patches/patches");
    let entries = list_dir(&patches.to_string_lossy()).expect("list_dir ok");
    assert!(entries.len() >= 3, "expected ≥3 patch files in fixture");
    for entry in &entries {
        let name = entry["name"].as_str().unwrap();
        assert!(name.ends_with(".json"), "patch fixture file {} should be .json", name);
    }
}

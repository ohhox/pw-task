// Pure helper functions for Tauri commands.
//
// All filesystem and JSON-stream parsing logic lives here so it can be
// unit-tested without spawning a Tauri runtime. The `#[tauri::command]`
// wrappers in `main.rs` are thin shells that resolve OS-level inputs
// (current_exe, env vars) and delegate to these helpers.

// Domain types + tree helpers live in their own modules so siblings 06-04
// (patch system) and 06-05 (db layer) can `use ai_task_flow::domain::*;`
// directly without pulling in the unrelated filesystem helpers.
pub mod agents;
pub mod db;
pub mod domain;
pub mod patch;
pub mod tree;

use std::path::{Path, PathBuf};

// ── path resolution ─────────────────────────────────────────────────────────

/// Resolve the directory containing the current executable, falling back to
/// `"."` if the path can't be determined (e.g. during tests).
pub fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Resolve the writable config directory for the app.
///
/// Prefers `%APPDATA%\ai-task-flow` (created on first call) so the config is
/// writable even when the exe lives in `Program Files`. Falls back to the exe
/// directory if APPDATA is missing or unwritable.
pub fn config_dir() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let dir = PathBuf::from(appdata).join("ai-task-flow");
        if std::fs::create_dir_all(&dir).is_ok() {
            return dir;
        }
    }
    exe_dir()
}

/// Pure helper: given a directory, return the path to `config.json` inside it.
/// Used by `get_config` / `set_config` so the path-resolution policy is
/// testable without touching the real filesystem.
pub fn config_path_for(dir: &Path) -> PathBuf {
    dir.join("config.json")
}

// ── config read/write ───────────────────────────────────────────────────────

/// Read `tasksDir` from a specific `config.json` path.
/// Returns an empty string for any error (missing file, bad JSON, missing key)
/// so the caller can treat it as "not configured yet".
pub fn read_config_from(config_path: &Path) -> String {
    let text = match std::fs::read_to_string(config_path) {
        Ok(t) => t,
        Err(_) => return String::new(),
    };
    let cfg: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    cfg.get("tasksDir")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Write `tasksDir` to a specific `config.json` path as pretty JSON.
pub fn write_config_to(config_path: &Path, tasks_dir: &str) -> Result<(), String> {
    let cfg = serde_json::json!({ "tasksDir": tasks_dir });
    std::fs::write(config_path, serde_json::to_string_pretty(&cfg).unwrap())
        .map_err(|e| e.to_string())
}

/// Resolve the effective tasksDir by checking the new APPDATA-based location
/// first, then the legacy exe-dir location. Pure: takes both candidates as
/// arguments so it can be tested with tempdirs.
pub fn read_config_with_fallback(primary: &Path, legacy: &Path) -> String {
    let primary_value = read_config_from(primary);
    if !primary_value.is_empty() {
        return primary_value;
    }
    read_config_from(legacy)
}

// ── filesystem helpers (thin wrappers) ──────────────────────────────────────

pub fn read_file(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

pub fn write_file(path: &str, contents: &str) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

/// List directory entries as JSON objects with `path` and `name` fields,
/// matching the shape the frontend expects from the `read_dir` Tauri command.
pub fn list_dir(path: &str) -> Result<Vec<serde_json::Value>, String> {
    let entries = std::fs::read_dir(path).map_err(|e| e.to_string())?;
    let result = entries
        .filter_map(|e| e.ok())
        .map(|entry| {
            serde_json::json!({
                "path": entry.path().to_string_lossy().to_string(),
                "name": entry.file_name().to_string_lossy().to_string()
            })
        })
        .collect();
    Ok(result)
}

pub fn delete_file(path: &str) -> Result<(), String> {
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

pub fn create_dir(path: &str) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())
}

/// Atomically write `contents` to `path`:
///   1. write to `<path>.tmp`
///   2. if target exists, snapshot it as `<path>.bak`
///   3. rename `<path>.tmp` → `<path>`
///
/// On rename failure, attempt to restore from `.bak` and remove the `.tmp`.
pub fn atomic_write(path: &str, contents: &str) -> Result<(), String> {
    let target = Path::new(path);
    let tmp_path = format!("{}.tmp", path);
    let bak_path = format!("{}.bak", path);

    std::fs::write(&tmp_path, contents).map_err(|e| format!("write tmp failed: {}", e))?;

    if target.exists() {
        let _ = std::fs::rename(path, &bak_path);
    }

    if let Err(e) = std::fs::rename(&tmp_path, path) {
        if Path::new(&bak_path).exists() {
            let _ = std::fs::rename(&bak_path, path);
        }
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("rename failed: {}", e));
    }
    Ok(())
}

// ── run_claude streaming JSON parser ────────────────────────────────────────

/// Token usage + cost captured from the `result` line of a Claude stream.
/// All fields default to zero when absent so callers don't have to special-case
/// missing sub-fields.
///
/// Token counts use `u32` (not `u64`) because specta maps `u64` to TS BigInt
/// which breaks JSON serialization. `u32` supports up to ~4 billion tokens,
/// far beyond any realistic single invocation.
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cache_creation_input_tokens: u32,
    pub cache_read_input_tokens: u32,
    /// Authoritative cost as returned by Anthropic — do NOT recompute
    /// from token counts because model rates change over time.
    pub total_cost_usd: f64,
}

/// Result of parsing one line of `claude --output-format stream-json` output.
#[derive(Debug, Default, PartialEq)]
pub struct ParsedClaudeLine {
    /// Text chunks to emit to the frontend via `run-line:{runId}`.
    /// Each chunk corresponds to one `\n`-split segment of an assistant text
    /// block. May be empty if the line has no displayable text.
    pub chunks: Vec<String>,
    /// Session id discovered on this line, if any.
    pub session_id: Option<String>,
    /// True if this was a `type: "result"` line — its `session_id` should
    /// overwrite any previously-captured session id, not just fill it in.
    pub is_result: bool,
    /// Final result text from a `type: "result"` line, only populated when
    /// the assistant produced no streamed output (used as a fallback).
    pub fallback_result: Option<String>,
    /// True if the line was not valid JSON; the raw line should be treated
    /// as plain text and emitted verbatim.
    pub is_plain_text: bool,
    /// Token usage and cost, populated only from `type: "result"` lines.
    /// `None` for all other line types.
    pub usage: Option<TokenUsage>,
}

/// Parse one line of streaming JSON output from `claude`.
///
/// Pure: no IO, no allocations beyond the returned strings. The caller is
/// responsible for emitting events and updating its own state.
pub fn parse_claude_line(line: &str) -> ParsedClaudeLine {
    let mut out = ParsedClaudeLine::default();

    if line.is_empty() {
        // Empty line: nothing to do, not plain text either.
        return out;
    }

    let json: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => {
            // Not JSON — caller should emit the raw line as plain text.
            out.is_plain_text = true;
            return out;
        }
    };

    if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
        out.session_id = Some(sid.to_string());
    }

    match json.get("type").and_then(|t| t.as_str()).unwrap_or("") {
        "assistant" => {
            if let Some(arr) = json
                .pointer("/message/content")
                .and_then(|c| c.as_array())
            {
                for item in arr {
                    if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                            for chunk in text.split('\n') {
                                out.chunks.push(chunk.to_string());
                            }
                        }
                    }
                }
            }
        }
        "result" => {
            out.is_result = true;
            if let Some(r) = json.get("result").and_then(|v| v.as_str()) {
                out.fallback_result = Some(r.to_string());
            }
            // Capture authoritative usage from the result line.
            // Fields default to 0 when absent — we always produce Some(TokenUsage)
            // so callers can distinguish "result line seen" from "no result yet".
            // Cast u64 → u32: token counts in a single run safely fit in u32
            // (u64 is forbidden by specta's TS bindings generator).
            let usage_obj = json.get("usage");
            let input_tokens = usage_obj
                .and_then(|u| u.get("input_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            let output_tokens = usage_obj
                .and_then(|u| u.get("output_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            let cache_creation_input_tokens = usage_obj
                .and_then(|u| u.get("cache_creation_input_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            let cache_read_input_tokens = usage_obj
                .and_then(|u| u.get("cache_read_input_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            let total_cost_usd = json
                .get("total_cost_usd")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            out.usage = Some(TokenUsage {
                input_tokens,
                output_tokens,
                cache_creation_input_tokens,
                cache_read_input_tokens,
                total_cost_usd,
            });
        }
        _ => {}
    }

    out
}

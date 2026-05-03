#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Emitter;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn exe_dir() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

// [P1 fix] Use %APPDATA%\ai-task-flow so config is writable even when exe is in Program Files
fn config_dir() -> std::path::PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let dir = std::path::PathBuf::from(appdata).join("ai-task-flow");
        if std::fs::create_dir_all(&dir).is_ok() {
            return dir;
        }
    }
    exe_dir()
}

#[tauri::command]
fn get_config() -> String {
    // Check new location first, fall back to legacy exe-dir location
    for path in [config_dir().join("config.json"), exe_dir().join("config.json")] {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(dir) = cfg.get("tasksDir").and_then(|v| v.as_str()) {
                    return dir.to_string();
                }
            }
        }
    }
    String::new()
}

#[tauri::command]
fn set_config(tasks_dir: String) -> Result<(), String> {
    let path = config_dir().join("config.json");
    let cfg = serde_json::json!({ "tasksDir": tasks_dir });
    std::fs::write(&path, serde_json::to_string_pretty(&cfg).unwrap())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

// [P1 fix] Atomic write: write tmp + rename to target. If target exists, snapshot
// it as .bak first so a crash mid-rename leaves a recoverable copy on disk.
#[tauri::command]
fn write_text_file_atomic(path: String, contents: String) -> Result<(), String> {
    let target = std::path::Path::new(&path);
    let tmp_path = format!("{}.tmp", path);
    let bak_path = format!("{}.bak", path);

    std::fs::write(&tmp_path, contents).map_err(|e| format!("write tmp failed: {}", e))?;

    if target.exists() {
        // Best-effort backup; failure here shouldn't block the save.
        let _ = std::fs::rename(&path, &bak_path);
    }

    if let Err(e) = std::fs::rename(&tmp_path, &path) {
        // Try to restore .bak if rename failed
        if std::path::Path::new(&bak_path).exists() {
            let _ = std::fs::rename(&bak_path, &path);
        }
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("rename failed: {}", e));
    }
    Ok(())
}

#[tauri::command]
fn read_dir(path: String) -> Result<Vec<serde_json::Value>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let result = entries
        .filter_map(|e| e.ok())
        .map(|entry| serde_json::json!({
            "path": entry.path().to_string_lossy().to_string(),
            "name": entry.file_name().to_string_lossy().to_string()
        }))
        .collect();
    Ok(result)
}

#[tauri::command]
fn remove_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_in_vscode(path: String) -> Result<(), String> {
    std::process::Command::new("code")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("VS Code not found (add 'code' to PATH): {}", e))?;
    Ok(())
}

#[tauri::command]
fn run_project_command(cmd: String, working_dir: String) -> Result<(), String> {
    let mut command = std::process::Command::new("cmd");
    command.args(["/C", &cmd]).current_dir(&working_dir);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_log_folder() -> Result<(), String> {
    let log_dir = config_dir().join("logs");
    // Ensure dir exists so explorer doesn't error on first run
    let _ = std::fs::create_dir_all(&log_dir);
    let path_string = log_dir.to_string_lossy().to_string();
    let mut command = std::process::Command::new("cmd");
    command.args(["/C", "explorer", &path_string]);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command.spawn().map_err(|e| {
        tracing::error!(error = %e, "failed to open log folder");
        e.to_string()
    })?;
    Ok(())
}

// [Phase 1.5.1] Best-effort cleanup of log files older than 7 days.
// Filenames look like `app.log.YYYY-MM-DD` (tracing-appender daily rolling).
// All errors are silently ignored — this is a best-effort housekeeping pass.
fn cleanup_old_logs(log_dir: &std::path::Path) {
    let entries = match std::fs::read_dir(log_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    // Compute cutoff: now - 7 days, expressed as a SystemTime.
    let cutoff = match std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(7 * 24 * 60 * 60))
    {
        Some(t) => t,
        None => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };

        // Expect prefix "app.log." followed by a YYYY-MM-DD-style date.
        let date_part = match name.strip_prefix("app.log.") {
            Some(d) => d,
            None => continue,
        };

        // Quick shape check: at least 10 chars and the first 10 look like a date
        if date_part.len() < 10 {
            continue;
        }
        let prefix10 = &date_part[..10];
        let bytes = prefix10.as_bytes();
        let looks_like_date = bytes.len() == 10
            && bytes[4] == b'-'
            && bytes[7] == b'-'
            && bytes[..4].iter().all(|c| c.is_ascii_digit())
            && bytes[5..7].iter().all(|c| c.is_ascii_digit())
            && bytes[8..10].iter().all(|c| c.is_ascii_digit());
        if !looks_like_date {
            continue;
        }

        // Use file modification time as the authoritative age signal.
        // Filename date is sanity-checked above but mtime is what we compare.
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if modified < cutoff {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
}

#[derive(serde::Serialize)]
struct RunResult {
    output: String,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

#[tauri::command]
async fn run_claude(
    app: tauri::AppHandle,
    prompt: String,
    model: String,
    session_id: Option<String>,
    working_dir: Option<String>,
    run_id: String,
    allowed_tools: Option<Vec<String>>,
    skip_permissions: Option<bool>,
) -> Result<RunResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::BufRead;

        let mut args: Vec<String> = Vec::new();
        if let Some(ref sid) = session_id {
            if !sid.is_empty() {
                args.push("--resume".into());
                args.push(sid.clone());
            }
        }
        args.push("-p".into());
        args.push(prompt);
        args.push("--model".into());
        args.push(model);
        args.push("--output-format".into());
        args.push("stream-json".into());
        args.push("--verbose".into());

        // [P1 fix] Permission model: only allow --dangerously-skip-permissions
        // when caller explicitly opts in. Otherwise pass --allowedTools list
        // (default: read-only tools only) so Claude cannot modify the system.
        if skip_permissions.unwrap_or(false) {
            args.push("--dangerously-skip-permissions".into());
        } else {
            let tools = allowed_tools.unwrap_or_else(|| {
                // Conservative default: read-only operations
                vec!["Read".into(), "Glob".into(), "Grep".into(), "WebFetch".into()]
            });
            if !tools.is_empty() {
                args.push("--allowedTools".into());
                args.push(tools.join(","));
            }
        }

        let mut cmd = std::process::Command::new("claude");
        cmd.args(&args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        if let Some(dir) = working_dir {
            if !dir.is_empty() {
                cmd.current_dir(&dir);
            }
        }

        let mut child = cmd.spawn()
            .map_err(|e| format!("claude CLI not found: {}", e))?;

        let stdout = child.stdout.take().unwrap();
        let stderr_handle = child.stderr.take();

        // [P1 fix] Spawn a thread to drain stderr concurrently. If stderr buffer
        // fills (~4KB on Windows) while we read stdout, the child blocks on
        // stderr write → wait() deadlocks → app freezes. Draining concurrently
        // prevents that.
        let stderr_thread = stderr_handle.map(|s| {
            std::thread::spawn(move || {
                use std::io::Read;
                let mut buf = String::new();
                std::io::BufReader::new(s).read_to_string(&mut buf).ok();
                buf
            })
        });

        let reader = std::io::BufReader::new(stdout);
        let mut text_output = String::new();
        let mut captured_sid: Option<String> = None;

        for line in reader.lines().flatten() {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if captured_sid.is_none() {
                    if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
                        captured_sid = Some(sid.to_string());
                    }
                }

                match json.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                    "assistant" => {
                        if let Some(arr) = json.pointer("/message/content").and_then(|c| c.as_array()) {
                            for item in arr {
                                if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                                    if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                                        for chunk in text.split('\n') {
                                            text_output.push_str(chunk);
                                            text_output.push('\n');
                                            let _ = app.emit(&format!("run-line:{}", run_id), chunk);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    "result" => {
                        if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
                            captured_sid = Some(sid.to_string());
                        }
                        if text_output.trim().is_empty() {
                            if let Some(r) = json.get("result").and_then(|v| v.as_str()) {
                                text_output = r.to_string();
                                let _ = app.emit(&format!("run-line:{}", run_id), r);
                            }
                        }
                    }
                    _ => {}
                }
            } else {
                // Plain text fallback
                text_output.push_str(&line);
                text_output.push('\n');
                let _ = app.emit(&format!("run-line:{}", run_id), &line);
            }
        }

        // [P1 fix] Check exit code — non-zero means claude failed
        let status = child.wait().map_err(|e| e.to_string())?;
        let stderr_text = stderr_thread
            .and_then(|t| t.join().ok())
            .unwrap_or_default();
        if !status.success() {
            let code = status.code().unwrap_or(-1);
            let detail = if !stderr_text.trim().is_empty() {
                stderr_text.trim().chars().take(400).collect::<String>()
            } else if !text_output.trim().is_empty() {
                text_output.trim().chars().take(400).collect::<String>()
            } else {
                "no output".to_string()
            };
            return Err(format!("claude exited with code {}: {}", code, detail));
        }

        Ok::<RunResult, String>(RunResult { output: text_output, session_id: captured_sid })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn main() {
    // [Phase 1.5.1] Structured JSON logging via tracing.
    // Logs go to %APPDATA%\ai-task-flow\logs\app.log.YYYY-MM-DD (daily rolling).
    // The non-blocking writer uses a background thread; its `_guard` MUST stay
    // alive for the lifetime of main() — dropping it would flush + shut down
    // the writer thread, losing in-flight log records.
    let log_dir = config_dir().join("logs");
    let _ = std::fs::create_dir_all(&log_dir);

    let file_appender = tracing_appender::rolling::daily(&log_dir, "app.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    tracing_subscriber::fmt()
        .json()
        .with_writer(non_blocking)
        .with_env_filter(env_filter)
        .init();

    // Best-effort retention: drop log files older than 7 days.
    cleanup_old_logs(&log_dir);

    tracing::info!(log_dir = %log_dir.display(), "ai-task-flow starting");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_config, set_config,
            read_text_file, write_text_file, write_text_file_atomic,
            read_dir, remove_file, create_dir,
            open_in_vscode, run_project_command,
            open_log_folder,
            run_claude
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

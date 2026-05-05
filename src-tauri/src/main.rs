#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use ai_task_flow::{
    agents, atomic_write, config_dir, config_path_for, create_dir as lib_create_dir, db, delete_file,
    domain, exe_dir, list_dir, parse_claude_line, patch, read_config_with_fallback, read_file,
    tree, write_config_to, write_file, TokenUsage,
};
use ai_task_flow::db::DbState;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use tauri_specta::{collect_commands, Builder};

// ── Active child-process tracker ─────────────────────────────────────────────
// Stores PIDs of every running AI CLI subprocess. On app exit every PID is
// force-killed so the process exits cleanly instead of hanging on child.wait().
#[derive(Default)]
struct ActiveRuns(Arc<Mutex<Vec<u32>>>);

// ── Workspace scope ───────────────────────────────────────────────────────────
// Canonical root directory that the user opened.  All mutating FS commands
// (write / delete / create_dir) must stay inside this boundary so a crafted
// patch file cannot reach outside the project folder.
#[derive(Default)]
struct WorkspaceRoot(Mutex<Option<String>>);

fn kill_pid(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .spawn();
    }
}

fn existing_file(path: PathBuf) -> Option<PathBuf> {
    path.is_file().then_some(path)
}

fn common_cli_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "windows")]
    {
        if let Some(user_profile) = std::env::var_os("USERPROFILE") {
            let user_profile = PathBuf::from(user_profile);
            dirs.push(user_profile.join(".local").join("bin"));
            dirs.push(user_profile.join(".cargo").join("bin"));
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
        if let Some(local_appdata) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local_appdata).join("Programs").join("nodejs"));
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            dirs.push(PathBuf::from(program_files).join("nodejs"));
        }
    }
    dirs
}

fn find_in_path(names: &[String]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in names {
            if let Some(found) = existing_file(dir.join(name)) {
                return Some(found);
            }
        }
    }
    None
}

fn cli_candidate_names(command: &str) -> Vec<String> {
    let trimmed = command.trim();
    #[cfg(target_os = "windows")]
    {
        let lower = trimmed.to_lowercase();
        if lower.ends_with(".exe") || lower.ends_with(".cmd") || lower.ends_with(".bat") {
            vec![trimmed.to_string()]
        } else {
            vec![
                format!("{trimmed}.exe"),
                format!("{trimmed}.cmd"),
                format!("{trimmed}.bat"),
                trimmed.to_string(),
            ]
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec![trimmed.to_string()]
    }
}

fn resolve_cli_command(command: &str) -> Option<PathBuf> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }
    let direct = PathBuf::from(trimmed);
    if direct.components().count() > 1 {
        return existing_file(direct);
    }
    let names = cli_candidate_names(trimmed);
    // Packaged Tauri apps often start with a trimmed PATH and therefore miss
    // per-user CLI install locations even when `where claude` works in a shell.
    for dir in common_cli_dirs() {
        for name in &names {
            if let Some(found) = existing_file(dir.join(name)) {
                return Some(found);
            }
        }
    }

    find_in_path(&names)
}

fn resolve_claude_cli() -> Option<PathBuf> {
    resolve_cli_command("claude")
}

fn claude_cli_not_found_message() -> String {
    #[cfg(target_os = "windows")]
    {
        "claude CLI not found. Searched PATH plus %USERPROFILE%\\.local\\bin, %APPDATA%\\npm, %USERPROFILE%\\.cargo\\bin, and Node.js install folders. Install Claude Code or add claude.exe/claude.cmd to one of those locations.".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        "claude CLI not found in PATH. Install Claude Code or add `claude` to PATH.".to_string()
    }
}

fn prepare_cli_command(program: &PathBuf, args: &[String]) -> std::process::Command {
    #[cfg(target_os = "windows")]
    {
        let ext = program
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if ext == "cmd" || ext == "bat" {
            let mut command = std::process::Command::new("cmd");
            command.arg("/C").arg(program).args(args);
            command.creation_flags(CREATE_NO_WINDOW);
            return command;
        }
    }

    let mut command = std::process::Command::new(program);
    command.args(args);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[tauri::command]
#[specta::specta]
fn get_config() -> String {
    // Check new APPDATA-based location first, fall back to legacy exe-dir location.
    let primary = config_path_for(&config_dir());
    let legacy = config_path_for(&exe_dir());
    read_config_with_fallback(&primary, &legacy)
}

#[tauri::command]
#[specta::specta]
fn set_config(tasks_dir: String, root: tauri::State<WorkspaceRoot>) -> Result<(), String> {
    // Persist config file
    let path = config_path_for(&config_dir());
    write_config_to(&path, &tasks_dir)?;
    // Update in-memory workspace scope
    *root.0.lock().unwrap() = Some(tasks_dir.clone());
    tracing::info!(action = "workspace_opened", path = %tasks_dir);
    Ok(())
}

// ── Path safety guard ────────────────────────────────────────────────────────
// Rejects paths that traverse outside the caller's intended directory or
// target known system locations.  Applied to every file-system command so
// a malicious task file cannot reach outside the workspace.
fn assert_safe_path(path: &str) -> Result<(), String> {
    use std::path::Component;
    if path.trim().is_empty() {
        return Err("Empty path denied".into());
    }
    // Block parent-directory traversal regardless of OS
    for comp in std::path::Path::new(path).components() {
        if comp == Component::ParentDir {
            return Err(format!("Path traversal (..) denied: {path}"));
        }
    }
    // Block Windows system directories
    #[cfg(target_os = "windows")]
    {
        let lower = path.to_lowercase().replace('/', "\\");
        for prefix in &[
            "c:\\windows\\", "c:\\program files\\",
            "c:\\program files (x86)\\", "c:\\windows\\system32",
        ] {
            if lower.starts_with(prefix) {
                return Err(format!("System path denied: {path}"));
            }
        }
    }
    // Block Unix system directories
    #[cfg(not(target_os = "windows"))]
    for prefix in &["/etc/", "/usr/", "/bin/", "/sbin/", "/sys/", "/proc/", "/boot/"] {
        if path.starts_with(prefix) {
            return Err(format!("System path denied: {path}"));
        }
    }
    Ok(())
}

// Ensure `path` is inside the workspace root that the user opened.
// Uses canonical paths to defeat symlink-based escapes.
fn assert_within_workspace(path: &str, root: &tauri::State<WorkspaceRoot>) -> Result<(), String> {
    let guard = root.0.lock().unwrap();
    let Some(ref root_str) = *guard else { return Ok(()); }; // no root set yet (startup)
    let canon_root = std::fs::canonicalize(root_str)
        .unwrap_or_else(|_| std::path::PathBuf::from(root_str));
    // For not-yet-created paths, canonicalize the parent and reconstruct
    let target = std::path::Path::new(path);
    let canon_target = std::fs::canonicalize(target).unwrap_or_else(|_| {
        if let Some(parent) = target.parent() {
            std::fs::canonicalize(parent)
                .unwrap_or_else(|_| parent.to_path_buf())
                .join(target.file_name().unwrap_or_default())
        } else {
            target.to_path_buf()
        }
    });
    if !canon_target.starts_with(&canon_root) {
        return Err(format!(
            "Access denied: path is outside the workspace.\n  path: {path}\n  workspace: {root_str}"
        ));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
fn read_text_file(path: String) -> Result<String, String> {
    assert_safe_path(&path)?;
    read_file(&path)
}

#[tauri::command]
#[specta::specta]
fn write_text_file(path: String, contents: String, root: tauri::State<WorkspaceRoot>) -> Result<(), String> {
    assert_safe_path(&path)?;
    assert_within_workspace(&path, &root)?;
    tracing::info!(audit = true, action = "write", path = %path);
    write_file(&path, &contents)
}

// [P1 fix] Atomic write: write tmp + rename to target. If target exists, snapshot
// it as .bak first so a crash mid-rename leaves a recoverable copy on disk.
#[tauri::command]
#[specta::specta]
fn write_text_file_atomic(path: String, contents: String, root: tauri::State<WorkspaceRoot>) -> Result<(), String> {
    assert_safe_path(&path)?;
    assert_within_workspace(&path, &root)?;
    tracing::info!(audit = true, action = "write_atomic", path = %path);
    atomic_write(&path, &contents)
}

#[tauri::command]
#[specta::specta]
fn read_dir(path: String) -> Result<Vec<serde_json::Value>, String> {
    assert_safe_path(&path)?;
    list_dir(&path)
}

#[tauri::command]
#[specta::specta]
fn remove_file(path: String, root: tauri::State<WorkspaceRoot>) -> Result<(), String> {
    assert_safe_path(&path)?;
    assert_within_workspace(&path, &root)?;
    tracing::info!(audit = true, action = "delete", path = %path);
    delete_file(&path)
}

#[tauri::command]
#[specta::specta]
fn create_dir(path: String, root: tauri::State<WorkspaceRoot>) -> Result<(), String> {
    assert_safe_path(&path)?;
    assert_within_workspace(&path, &root)?;
    lib_create_dir(&path)
}

#[tauri::command]
#[specta::specta]
fn open_terminal(path: String) -> Result<(), String> {
    // Validate the directory exists before attempting to open a terminal there.
    if !std::path::Path::new(&path).is_dir() {
        return Err(format!("Directory not found: {}", path));
    }

    #[cfg(target_os = "windows")]
    {
        // Use `cmd /C start powershell` — guaranteed to open exactly ONE window.
        // If the user has Windows Terminal set as the default terminal handler
        // (Windows 11 default), Windows routes `start powershell` there automatically.
        // cmd.exe absolute path is always valid regardless of Tauri's restricted PATH.
        std::process::Command::new(r"C:\Windows\System32\cmd.exe")
            .args(["/C", "start", "powershell.exe", "-NoExit", "-NoLogo"])
            .current_dir(&path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;

        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        // Check .app bundles in order of preference; use `open -a <App> <path>`.
        let candidates: &[(&str, &str)] = &[
            ("Warp",     "/Applications/Warp.app"),
            ("iTerm",    "/Applications/iTerm.app"),
            ("Terminal", "/System/Applications/Utilities/Terminal.app"),
            ("Terminal", "/Applications/Utilities/Terminal.app"), // older macOS path
        ];
        let mut tried: Vec<&str> = Vec::new();
        for (name, bundle) in candidates {
            if !std::path::Path::new(bundle).exists() {
                continue;
            }
            tried.push(name);
            match std::process::Command::new("open")
                .args(["-a", name, &path])
                .spawn()
            {
                Ok(_) => return Ok(()),
                Err(e) => return Err(format!("{} found but failed to launch: {}", name, e)),
            }
        }
        if tried.is_empty() {
            return Err("No terminal app found. Install iTerm2 or Warp, or check that Terminal.app is present.".to_string());
        }
        return Err(format!("Failed to open any terminal. Tried: {}", tried.join(", ")));
    }

    #[cfg(target_os = "linux")]
    {
        // Try common Linux terminals; each has its own flag for working directory.
        let candidates: &[(&str, &[&str])] = &[
            ("gnome-terminal", &["--working-directory"]),
            ("konsole",        &["--workdir"]),
            ("xfce4-terminal", &["--working-directory"]),
            ("alacritty",      &["--working-directory"]),
            ("kitty",          &[]),
            ("xterm",          &[]),
        ];
        let mut tried: Vec<&str> = Vec::new();
        for (program, dir_flag) in candidates {
            tried.push(program);
            // kitty / xterm use current_dir; others take an explicit flag + value.
            let mut cmd = std::process::Command::new(program);
            if dir_flag.is_empty() {
                cmd.current_dir(&path);
            } else {
                cmd.args(*dir_flag).arg(&path);
            }
            match cmd.spawn() {
                Ok(_) => return Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(format!("{} found but failed to launch: {}", program, e)),
            }
        }
        return Err(format!("No terminal found. Tried: {}", tried.join(", ")));
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Err("Opening a terminal is not supported on this platform.".to_string())
}

#[tauri::command]
#[specta::specta]
fn run_project_command(cmd: String, working_dir: String) -> Result<(), String> {
    let mut command = std::process::Command::new("cmd");
    command.args(["/C", &cmd]).current_dir(&working_dir);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
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

// [Phase 1.5.2] JS logger bridge — forwards structured log entries from the
// frontend into the same tracing pipeline used by Rust code, so all logs
// (both Rust and JS-originated) land in the same daily log file.
#[derive(Debug, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct LogEntry {
    timestamp: String,
    level: String, // "debug" | "info" | "warn" | "error"
    module: String,
    message: String,
    #[serde(default)]
    context: Option<serde_json::Value>,
}

#[tauri::command]
#[specta::specta]
fn write_log_entry(entry: LogEntry) -> Result<(), String> {
    let ctx_str = entry
        .context
        .as_ref()
        .map(|v| v.to_string())
        .unwrap_or_default();
    match entry.level.as_str() {
        "error" => tracing::error!(module = %entry.module, ts = %entry.timestamp, ctx = %ctx_str, "{}", entry.message),
        "warn"  => tracing::warn!(module = %entry.module, ts = %entry.timestamp, ctx = %ctx_str, "{}", entry.message),
        "info"  => tracing::info!(module = %entry.module, ts = %entry.timestamp, ctx = %ctx_str, "{}", entry.message),
        "debug" => tracing::debug!(module = %entry.module, ts = %entry.timestamp, ctx = %ctx_str, "{}", entry.message),
        other   => tracing::warn!("unknown log level '{}', falling back to info: {}", other, entry.message),
    }
    Ok(())
}

#[derive(serde::Serialize, specta::Type)]
struct RunResult {
    output: String,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    /// Token usage and cost from Anthropic's `result` line. `None` when the
    /// stream ended without producing a result line (e.g. process killed).
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<TokenUsage>,
}

#[tauri::command]
#[specta::specta]
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

        let claude_program = resolve_claude_cli().ok_or_else(claude_cli_not_found_message)?;
        tracing::info!(action = "run_claude", cli = %claude_program.display());

        let mut cmd = prepare_cli_command(&claude_program, &args);
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        if let Some(dir) = working_dir {
            if !dir.is_empty() {
                cmd.current_dir(&dir);
            }
        }

        let mut child = cmd.spawn()
            .map_err(|e| format!("failed to start claude CLI at {}: {}", claude_program.display(), e))?;

        // Track PID so we can kill the child if the window closes mid-run.
        let pid = child.id();
        let runs = app.state::<ActiveRuns>().inner().0.clone();
        runs.lock().unwrap().push(pid);

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
        let mut captured_usage: Option<TokenUsage> = None;

        for line in reader.lines().flatten() {
            // Pure parse + side-effects (emit + buffer accumulation) are kept
            // separate so the parser can be unit-tested in isolation.
            let parsed = parse_claude_line(&line);

            // Mirror the original semantics: any line's session_id fills in if
            // we don't have one yet, but a "result" line always overwrites.
            if let Some(sid) = parsed.session_id.as_ref() {
                if captured_sid.is_none() || parsed.is_result {
                    captured_sid = Some(sid.clone());
                }
            }

            // Capture usage from the result line (authoritative, server-computed).
            if parsed.usage.is_some() {
                captured_usage = parsed.usage;
            }

            if parsed.is_plain_text {
                text_output.push_str(&line);
                text_output.push('\n');
                let _ = app.emit(&format!("run-line:{}", run_id), &line);
                continue;
            }

            for chunk in &parsed.chunks {
                text_output.push_str(chunk);
                text_output.push('\n');
                let _ = app.emit(&format!("run-line:{}", run_id), chunk);
            }

            if let Some(result_text) = parsed.fallback_result {
                if text_output.trim().is_empty() {
                    text_output = result_text.clone();
                    let _ = app.emit(&format!("run-line:{}", run_id), &result_text);
                }
            }
        }

        // [P1 fix] Check exit code — non-zero means claude failed
        let status = child.wait().map_err(|e| e.to_string())?;
        runs.lock().unwrap().retain(|&p| p != pid);
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

        Ok::<RunResult, String>(RunResult { output: text_output, session_id: captured_sid, usage: captured_usage })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
async fn run_cli(
    app: tauri::AppHandle,
    command: String,
    args: Vec<String>,
    working_dir: Option<String>,
    run_id: String,
) -> Result<RunResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::BufRead;

        let program = resolve_cli_command(&command).ok_or_else(|| {
            format!(
                "CLI command '{}' not found. Add it to PATH or a known user CLI directory.",
                command
            )
        })?;
        tracing::info!(action = "run_cli", cli = %program.display(), arg_count = args.len());

        let mut cmd = prepare_cli_command(&program, &args);
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        if let Some(dir) = working_dir {
            if !dir.is_empty() {
                cmd.current_dir(&dir);
            }
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to start CLI at {}: {}", program.display(), e))?;

        let pid = child.id();
        let runs = app.state::<ActiveRuns>().inner().0.clone();
        runs.lock().unwrap().push(pid);

        let stdout = child.stdout.take().unwrap();
        let stderr_handle = child.stderr.take();
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
        for line in reader.lines().flatten() {
            text_output.push_str(&line);
            text_output.push('\n');
            let _ = app.emit(&format!("run-line:{}", run_id), &line);
        }

        let status = child.wait().map_err(|e| e.to_string())?;
        runs.lock().unwrap().retain(|&p| p != pid);
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
            return Err(format!("CLI '{}' exited with code {}: {}", command, code, detail));
        }

        if text_output.trim().is_empty() && !stderr_text.trim().is_empty() {
            text_output = stderr_text;
        }

        Ok::<RunResult, String>(RunResult {
            output: text_output,
            session_id: None,
            usage: None,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Domain tree commands (Phase 1.6.2) ─────────────────────────────────────
//
// These are thin wrappers around `ai_task_flow::tree::*`. The frontend keeps
// fast synchronous TS implementations for hot render paths; these IPC
// commands serve as the canonical implementation that:
//   1. Sibling tasks 06-04 (patch system) and 06-05 (db layer) call from Rust
//      directly via `tree::*` (no IPC hop).
//   2. The frontend can call from non-render paths where async is acceptable
//      (e.g. background validation) — see `src/js/data-rs.ts`.
//
// Keeping both implementations is a deliberate trade-off documented in the
// Phase 1.6.2 task notes: porting render-loop helpers to async would break
// 30+ DOM call sites and cause UI flicker.

/// Recursive count of every status across the tree.
///
/// Uses `u32` (not `usize`) because specta refuses to bridge `usize` to TS:
/// a 64-bit count would overflow `Number.MAX_SAFE_INTEGER`. `u32` is plenty
/// for any realistic task tree (4 billion tasks).
#[tauri::command]
#[specta::specta]
fn task_count_by_status(tasks: Vec<domain::Task>) -> HashMap<domain::TaskStatus, u32> {
    tree::count_by_status(&tasks)
        .into_iter()
        .map(|(k, v)| (k, v as u32))
        .collect()
}

/// Subtree completion percentage (0..=100) or `None` for a leaf with no
/// subtasks.
#[tauri::command]
#[specta::specta]
fn task_calc_progress(task: domain::Task) -> Option<u8> {
    tree::calc_progress(&task)
}

/// True when this task and every descendant is `Done`.
#[tauri::command]
#[specta::specta]
fn task_is_fully_done(task: domain::Task) -> bool {
    tree::is_fully_done(&task)
}

/// DFS path of ids to the first non-`Done` descendant, or `None` when nothing
/// is left to run.
#[tauri::command]
#[specta::specta]
fn task_find_next_runnable(task: domain::Task) -> Option<Vec<String>> {
    tree::find_next_runnable(&task)
}

// ── Agent commands (Phase 1.6.3) ───────────────────────────────────────────
//
// Thin wrappers around `ai_task_flow::agents::*`. The dashboard now treats
// Rust as the canonical source of agent state; the TS `registry.ts` has been
// reduced to a sync cache that calls these commands at startup and on every
// CRUD mutation.

/// Snapshot of the current registry. Returned as `Vec<Agent>` so the TS side
/// can drop it straight into its render cache.
#[tauri::command]
#[specta::specta]
fn agent_list() -> Vec<domain::Agent> {
    agents::agent_list()
}

/// Resolve which agent + model should run a given task. The frontend uses
/// this for both the play button (to pick the provider) and the activity
/// log (to record which agent ran).
#[tauri::command]
#[specta::specta]
fn agent_resolve(task: domain::Task) -> agents::ResolvedAgent {
    agents::resolved_for_task(&task)
}

/// Append a new agent to the registry. Returns an error string if the id
/// is already taken so the Agent Manager modal can surface a toast.
#[tauri::command]
#[specta::specta]
fn agent_add(agent: domain::Agent) -> Result<(), String> {
    agents::agent_add(agent)
}

/// Patch an existing agent in place. Missing fields are left untouched;
/// missing id is a no-op (matches the legacy TS semantics).
#[tauri::command]
#[specta::specta]
fn agent_update(id: String, patch: agents::AgentPatch) -> Result<(), String> {
    agents::agent_update(&id, patch).map(|_| ())
}

/// Remove an agent by id. Missing id is a no-op so the Agent Manager modal
/// can fire-and-forget without checking the result first.
#[tauri::command]
#[specta::specta]
fn agent_remove(id: String) -> Result<(), String> {
    agents::agent_remove(&id)
}

/// Replace the entire registry — used at startup when the dashboard loads
/// `Database.agents` from disk. Empty / null input falls back to defaults.
#[tauri::command]
#[specta::specta]
fn agent_replace_all(saved: Option<Vec<domain::Agent>>) {
    agents::replace_all(saved);
}

// ── Patch system commands (Phase 1.6.4) ────────────────────────────────────
//
// Pure mutation pipeline — see `ai_task_flow::patch` for the full semantics.
// The disk pipeline (read patches/ dir, deserialize files, persist db,
// delete consumed patch files) stays in TS for now because we don't yet have
// a Rust DB layer (Phase 1.6.5). Once 06-05 lands, the orchestrator
// `patches_apply_pending` should move here too.

/// Validate a patch's shape. Cheap: only checks the rules that survive
/// serde deserialization (version compat, etc.). Returns `Ok(())` for
/// well-formed patches, `Err(reason)` otherwise.
#[tauri::command]
#[specta::specta]
fn patch_validate(patch: domain::Patch) -> Result<(), String> {
    patch::validate(&patch)
}

/// Apply a single patch to the supplied `Database` and return the mutated
/// db. The TS caller passes the current in-memory db, receives the new one,
/// and writes it back to disk.
#[tauri::command]
#[specta::specta]
fn patch_apply_to_db(
    db: domain::Database,
    patch: domain::Patch,
) -> Result<domain::Database, String> {
    let mut db = db;
    patch::apply_to_db(&mut db, &patch)?;
    Ok(db)
}

/// Apply a batch of patches in timestamp order, deduplicating against
/// `db.appliedPatches` and the in-memory tracker. Returns the mutated db
/// plus a summary the dashboard can surface in a toast / activity log.
///
/// Tuple return is `(Database, ApplyResult)` so the TS side can destructure
/// directly without a wrapper struct.
#[tauri::command]
#[specta::specta]
fn patch_apply_batch(
    db: domain::Database,
    sources: Vec<patch::PatchSource>,
) -> (domain::Database, patch::ApplyResult) {
    let mut db = db;
    let result = patch::apply_batch(&mut db, sources);
    (db, result)
}

// ── DB layer commands (Phase 1.6.5) ────────────────────────────────────────
//
// These wrap `ai_task_flow::db::*` and own ALL persistence for tasks.json:
// load + atomic save + migration backup + the patches/ disk orchestrator.
// The frontend `fileops.ts` is now a thin wrapper layer that calls these.
//
// State sharing: every command takes `State<'_, DbState>` so the in-memory
// db sits behind a Mutex. No other layer is allowed to mutate it.

#[tauri::command]
#[specta::specta]
async fn db_load(base_dir: String, state: tauri::State<'_, DbState>) -> Result<domain::Database, String> {
    db::db_load_into(&base_dir, state.inner())
}

#[tauri::command]
#[specta::specta]
async fn db_save(state: tauri::State<'_, DbState>) -> Result<(), String> {
    db::db_save_current(state.inner())
}

#[tauri::command]
#[specta::specta]
async fn db_get(state: tauri::State<'_, DbState>) -> Result<domain::Database, String> {
    db::db_get_current(state.inner())
}

#[tauri::command]
#[specta::specta]
async fn db_replace(new_db: domain::Database, state: tauri::State<'_, DbState>) -> Result<(), String> {
    db::db_replace_current(new_db, state.inner())
}

#[tauri::command]
#[specta::specta]
async fn db_set_base(base_dir: String, state: tauri::State<'_, DbState>) -> Result<(), String> {
    db::db_set_base_dir(&base_dir, state.inner())
}

#[tauri::command]
#[specta::specta]
async fn db_write_migration_backup(
    from_version: String,
    raw_text: String,
    state: tauri::State<'_, DbState>,
) -> Result<String, String> {
    db::db_migration_backup(&from_version, &raw_text, state.inner())
}

#[tauri::command]
#[specta::specta]
async fn patches_apply_pending(state: tauri::State<'_, DbState>) -> Result<patch::ApplyResult, String> {
    db::patches_apply_pending_for(state.inner())
}

/// Build the tauri-specta Builder with all commands registered.
/// Extracted into a function so both `main()` and the `export_bindings` test
/// can reuse the same command list without duplication.
fn make_specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![
        get_config,
        set_config,
        read_text_file,
        write_text_file,
        write_text_file_atomic,
        read_dir,
        remove_file,
        create_dir,
        open_terminal,
        run_project_command,
        open_log_folder,
        write_log_entry,
        run_claude,
        run_cli,
        task_count_by_status,
        task_calc_progress,
        task_is_fully_done,
        task_find_next_runnable,
        agent_list,
        agent_resolve,
        agent_add,
        agent_update,
        agent_remove,
        agent_replace_all,
        patch_validate,
        patch_apply_to_db,
        patch_apply_batch,
        db_load,
        db_save,
        db_get,
        db_replace,
        db_set_base,
        db_write_migration_backup,
        patches_apply_pending,
    ])
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

    let builder = make_specta_builder();

    // In debug builds, export TypeScript bindings so `src/bindings.ts` stays
    // up-to-date with the Rust command surface automatically on every `tauri dev`.
    #[cfg(debug_assertions)]
    builder
        .export(specta_typescript::Typescript::default(), "../src/bindings.ts")
        .expect("Failed to export TypeScript bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(DbState::new())
        .manage(ActiveRuns::default())
        .manage(WorkspaceRoot::default())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);

            // Kill all tracked claude subprocesses when the main window closes,
            // so child.wait() unblocks and the process exits cleanly.
            let handle = app.handle().clone();
            if let Some(win) = app.get_webview_window("main") {
                if let Err(error) = win.minimize() {
                    tracing::warn!(%error, "failed to minimize main window on startup");
                }

                win.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Destroyed) {
                        let pids: Vec<u32> = handle
                            .state::<ActiveRuns>()
                            .inner()
                            .0
                            .lock()
                            .unwrap()
                            .clone();
                        for pid in pids {
                            kill_pid(pid);
                        }
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod specta_tests {
    use super::*;

    /// Generate `src/bindings.ts` from the Rust command surface.
    /// Run with: cargo test export_bindings --manifest-path src-tauri/Cargo.toml
    #[test]
    fn export_bindings() {
        let builder = make_specta_builder();
        builder
            .export(
                specta_typescript::Typescript::default(),
                "../src/bindings.ts",
            )
            .expect("Failed to export TypeScript bindings");

        // Verify the file was created and contains expected content
        let contents = std::fs::read_to_string("../src/bindings.ts")
            .expect("bindings.ts should exist after export");
        assert!(
            contents.contains("get_config") || contents.contains("getConfig"),
            "bindings.ts should contain get_config command"
        );
        assert!(
            contents.contains("run_claude") || contents.contains("runClaude"),
            "bindings.ts should contain run_claude command"
        );
    }
}

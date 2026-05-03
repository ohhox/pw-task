pub fn exe_dir() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

pub fn config_dir() -> std::path::PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let dir = std::path::PathBuf::from(appdata).join("ai-task-flow");
        if std::fs::create_dir_all(&dir).is_ok() {
            return dir;
        }
    }
    exe_dir()
}

/// Read tasksDir from a specific config.json path.
pub fn read_config(config_path: &std::path::Path) -> String {
    if let Ok(text) = std::fs::read_to_string(config_path) {
        if let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(dir) = cfg.get("tasksDir").and_then(|v| v.as_str()) {
                return dir.to_string();
            }
        }
    }
    String::new()
}

/// Write tasksDir to a specific config.json path.
pub fn write_config(config_path: &std::path::Path, tasks_dir: &str) -> Result<(), String> {
    let cfg = serde_json::json!({ "tasksDir": tasks_dir });
    std::fs::write(config_path, serde_json::to_string_pretty(&cfg).unwrap())
        .map_err(|e| e.to_string())
}

pub fn read_file(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

pub fn write_file(path: &str, contents: &str) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

/// List directory entries as JSON objects with "path" and "name" fields.
pub fn list_dir(path: &str) -> Result<Vec<serde_json::Value>, String> {
    let entries = std::fs::read_dir(path).map_err(|e| e.to_string())?;
    let result = entries
        .filter_map(|e| e.ok())
        .map(|entry| serde_json::json!({
            "path": entry.path().to_string_lossy().to_string(),
            "name": entry.file_name().to_string_lossy().to_string()
        }))
        .collect();
    Ok(result)
}

pub fn delete_file(path: &str) -> Result<(), String> {
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

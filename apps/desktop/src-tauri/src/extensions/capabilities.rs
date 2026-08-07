use super::manifest::ExtensionManifest;
use super::permissions::{resolve_workspace_path, PathResolution};
use crate::error::AppError;
use crate::semantic;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

pub fn dispatch(
    extension_id: &str,
    _manifest: &ExtensionManifest,
    workspace_root: &Path,
    capability: &str,
    method: &str,
    args: &[Value],
    app: &tauri::AppHandle,
) -> Result<Value, AppError> {
    match (capability, method) {
        ("fs", "readFile") => read_file(workspace_root, args),
        ("fs", "writeFile") => write_file(workspace_root, args),
        ("fs", "listFiles") => list_files(workspace_root, args),
        ("semantic", "search") => semantic_search(args, app),
        ("semantic", "indexNote") => semantic_index_note(workspace_root, args, app),
        ("semantic", "status") => {
            serde_json::to_value(semantic::semantic_index_status(app.clone())?)
                .map_err(|err| AppError::Io(err.to_string()))
        }
        ("ai", "chat") => Err(AppError::Unavailable("ai.chat not implemented".into())),
        ("storage", "get") => storage_get(app, extension_id, args, false),
        ("storage", "set") => storage_set(app, extension_id, args, false),
        ("storage", "getShared") => storage_get(app, extension_id, args, true),
        ("storage", "setShared") => storage_set(app, extension_id, args, true),
        _ => Err(AppError::Denied(format!(
            "unknown extension capability method {capability}.{method}"
        ))),
    }
}

fn read_file(workspace_root: &Path, args: &[Value]) -> Result<Value, AppError> {
    let path = string_arg(args, 0, "path")?;
    let resolved = resolve_workspace_path(workspace_root, path, PathResolution::MustExist)?;
    let content = fs::read_to_string(resolved.path)?;
    Ok(json!(content))
}

fn write_file(workspace_root: &Path, args: &[Value]) -> Result<Value, AppError> {
    let path = string_arg(args, 0, "path")?;
    let content = string_arg(args, 1, "content")?;
    let resolved = resolve_workspace_path(workspace_root, path, PathResolution::MayCreate)?;
    atomic_write(&resolved.path, content)?;
    Ok(Value::Null)
}

fn list_files(workspace_root: &Path, args: &[Value]) -> Result<Value, AppError> {
    let path = args.first().and_then(Value::as_str).unwrap_or(".");
    let resolved = resolve_workspace_path(workspace_root, path, PathResolution::MustExist)?;
    if !resolved.path.is_dir() {
        return Err(AppError::NotFound(path.to_string()));
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(resolved.path)? {
        let entry = entry?;
        let child = entry.path().to_string_lossy().to_string();
        let Ok(child) = resolve_workspace_path(workspace_root, &child, PathResolution::MustExist)
        else {
            continue;
        };
        let file_type = fs::symlink_metadata(&child.path)?.file_type();
        entries.push(json!({
            "path": child.relative_path,
            "isDir": file_type.is_dir(),
            "isFile": file_type.is_file(),
        }));
    }
    entries.sort_by(|a, b| {
        a.get("path")
            .and_then(Value::as_str)
            .cmp(&b.get("path").and_then(Value::as_str))
    });
    Ok(Value::Array(entries))
}

fn semantic_search(args: &[Value], app: &tauri::AppHandle) -> Result<Value, AppError> {
    let query = string_arg(args, 0, "query")?.to_string();
    let limit = args
        .get(1)
        .and_then(Value::as_u64)
        .map(|value| value as u32);
    serde_json::to_value(semantic::semantic_search(query, limit, app.clone())?)
        .map_err(|err| AppError::Io(err.to_string()))
}

fn semantic_index_note(
    workspace_root: &Path,
    args: &[Value],
    app: &tauri::AppHandle,
) -> Result<Value, AppError> {
    let path = string_arg(args, 0, "path")?;
    let resolved = resolve_workspace_path(workspace_root, path, PathResolution::MustExist)?;
    let indexed =
        semantic::semantic_index_note(resolved.path.to_string_lossy().to_string(), app.clone())?;
    Ok(json!(indexed))
}

fn storage_get(
    app: &tauri::AppHandle,
    extension_id: &str,
    args: &[Value],
    shared: bool,
) -> Result<Value, AppError> {
    let key = string_arg(args, 0, "key")?;
    let path = storage_path(app, extension_id, shared)?;
    let values = read_storage(&path)?;
    Ok(values.get(key).cloned().unwrap_or(Value::Null))
}

fn storage_set(
    app: &tauri::AppHandle,
    extension_id: &str,
    args: &[Value],
    shared: bool,
) -> Result<Value, AppError> {
    let key = string_arg(args, 0, "key")?;
    let value = args
        .get(1)
        .cloned()
        .ok_or_else(|| AppError::Denied("missing value argument".into()))?;
    let path = storage_path(app, extension_id, shared)?;
    let mut values = read_storage(&path)?;
    values.insert(key.to_string(), value);
    write_storage(&path, &values)?;
    Ok(Value::Null)
}

fn storage_path(
    app: &tauri::AppHandle,
    extension_id: &str,
    shared: bool,
) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| AppError::Io(err.to_string()))?
        .join("extension-storage");
    fs::create_dir_all(&dir)?;
    let file_name = if shared {
        "shared".to_string()
    } else {
        extension_id.to_string()
    };
    Ok(dir.join(format!("{file_name}.json")))
}

fn read_storage(path: &Path) -> Result<Map<String, Value>, AppError> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let content = fs::read_to_string(path)?;
    serde_json::from_str(&content).map_err(|err| AppError::Io(err.to_string()))
}

fn write_storage(path: &Path, values: &Map<String, Value>) -> Result<(), AppError> {
    let content =
        serde_json::to_string_pretty(values).map_err(|err| AppError::Io(err.to_string()))?;
    atomic_write(path, &content)
}

fn atomic_write(path: &Path, content: &str) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Io("No parent directory".into()))?;
    fs::create_dir_all(parent)?;
    let temp_path = parent.join(format!(".~{}", uuid::Uuid::new_v4()));
    fs::write(&temp_path, content)?;
    fs::rename(&temp_path, path)?;
    Ok(())
}

fn string_arg<'a>(args: &'a [Value], index: usize, label: &str) -> Result<&'a str, AppError> {
    args.get(index)
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Denied(format!("missing or invalid {label} argument")))
}

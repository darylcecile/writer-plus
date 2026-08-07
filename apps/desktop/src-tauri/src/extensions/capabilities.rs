use super::manifest::{CapabilityGrant, ExtensionManifest};
use super::permissions::{
    permission_pattern_matches, resolve_workspace_path, workspace_path_granted, PathResolution,
    ResolvedWorkspacePath,
};
use crate::error::AppError;
use crate::semantic;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;

#[allow(clippy::too_many_arguments)]
pub fn dispatch(
    extension_id: &str,
    manifest: &ExtensionManifest,
    workspace_root: Option<&Path>,
    capability: &str,
    method: &str,
    args: &[Value],
    webview: &tauri::Webview,
    app: &tauri::AppHandle,
) -> Result<Value, AppError> {
    match (capability, method) {
        ("workspace", "read") => workspace_read(required_root(workspace_root)?, args),
        ("workspace", "write") => workspace_write(required_root(workspace_root)?, args),
        ("workspace", "list") => workspace_list(manifest, required_root(workspace_root)?, args),
        ("workspace", "search") => workspace_search(manifest, required_root(workspace_root)?, args),
        ("workspace", "recent") => workspace_recent(manifest, required_root(workspace_root)?, args),
        ("workspace", "findByName") => {
            workspace_find_by_name(manifest, required_root(workspace_root)?, args)
        }
        ("workspace", "root") => Ok(workspace_root
            .map(|root| json!(root.to_string_lossy().to_string()))
            .unwrap_or(Value::Null)),
        ("embeddings", "query") => {
            embeddings_query(manifest, required_root(workspace_root)?, args, app)
        }
        ("embeddings", "status") => embeddings_status(manifest, workspace_root, app),
        ("embeddings", "reindex") => {
            embeddings_reindex(manifest, workspace_root, args, webview, app)
        }
        ("embeddings", "clear") => embeddings_clear(app),
        ("ai", "ask")
        | ("ai", "startStream")
        | ("ai", "pollStream")
        | ("ai", "cancel")
        | ("ai", "models") => Err(AppError::Unavailable(format!(
            "ai.{method} not implemented"
        ))),
        ("storage", "get") => storage_get(app, extension_id, args, storage_shared(manifest)),
        ("storage", "set") => storage_set(app, extension_id, args, storage_shared(manifest)),
        ("storage", "remove") => storage_remove(app, extension_id, args, storage_shared(manifest)),
        ("storage", "keys") => storage_keys(app, extension_id, storage_shared(manifest)),
        ("storage", "getShared") => storage_get(app, extension_id, args, true),
        ("storage", "setShared") => storage_set(app, extension_id, args, true),
        ("storage", "removeShared") => storage_remove(app, extension_id, args, true),
        ("storage", "keysShared") => storage_keys(app, extension_id, true),
        ("preferences", "all") => preferences_all(app, extension_id, manifest),
        ("preferences", "get") => preferences_get(app, extension_id, manifest, args),
        ("clipboard", "copy") => clipboard_copy(app, args),
        ("clipboard", "read") => clipboard_read(app),
        ("network", "fetch") => Err(AppError::Unavailable(
            "network.fetch not implemented".into(),
        )),
        _ => Err(AppError::Denied(format!(
            "unknown extension capability method {capability}.{method}"
        ))),
    }
}

fn required_root(root: Option<&Path>) -> Result<&Path, AppError> {
    root.ok_or(AppError::NoWorkspace)
}

fn workspace_read(workspace_root: &Path, args: &[Value]) -> Result<Value, AppError> {
    let path = string_arg(args, 0, "path")?;
    let resolved = resolve_workspace_path(workspace_root, path, PathResolution::MustExist)?;
    let content = fs::read_to_string(&resolved.path)?;
    Ok(json!({
        "path": resolved.relative_path,
        "title": title_for_path(&resolved.path, &resolved.relative_path),
        "modified": crate::commands::fs::modified_time(&resolved.path),
        "content": content,
    }))
}

fn workspace_write(workspace_root: &Path, args: &[Value]) -> Result<Value, AppError> {
    let path = string_arg(args, 0, "path")?;
    let content = string_arg(args, 1, "content")?;
    let resolved = resolve_workspace_path(workspace_root, path, PathResolution::MayCreate)?;
    atomic_write(&resolved.path, content)?;
    Ok(Value::Null)
}

fn workspace_list(
    manifest: &ExtensionManifest,
    workspace_root: &Path,
    args: &[Value],
) -> Result<Value, AppError> {
    let glob_pattern = args.first().and_then(Value::as_str);
    let mut refs: Vec<Value> = readable_markdown_files(manifest, workspace_root)
        .into_iter()
        .filter(|resolved| {
            glob_pattern
                .map(|pattern| permission_pattern_matches(pattern, &resolved.relative_path))
                .unwrap_or(true)
        })
        .map(|resolved| note_ref(&resolved))
        .collect();
    refs.sort_by(|a, b| json_path(a).cmp(json_path(b)));
    Ok(Value::Array(refs))
}

fn workspace_search(
    manifest: &ExtensionManifest,
    workspace_root: &Path,
    args: &[Value],
) -> Result<Value, AppError> {
    let query = string_arg(args, 0, "query")?.trim().to_string();
    if query.is_empty() {
        return Ok(Value::Array(Vec::new()));
    }
    let limit = limit_arg(args, 1, 30, 100);
    let needle = query.to_lowercase();
    let mut hits = Vec::new();

    for resolved in readable_markdown_files(manifest, workspace_root) {
        let Ok(content) = fs::read_to_string(&resolved.path) else {
            continue;
        };
        let lower = content.to_lowercase();
        let count = lower.matches(&needle).count();
        if count == 0 {
            continue;
        }
        let excerpt = excerpt_for_query(&content, &needle);
        let mut hit = Map::new();
        hit.insert("path".into(), Value::String(resolved.relative_path.clone()));
        hit.insert(
            "title".into(),
            Value::String(title_for_path(&resolved.path, &resolved.relative_path)),
        );
        hit.insert(
            "modified".into(),
            json!(crate::commands::fs::modified_time(&resolved.path)),
        );
        hit.insert("score".into(), json!(count as u64));
        if let Some(excerpt) = excerpt {
            hit.insert("excerpt".into(), Value::String(excerpt));
        }
        hits.push(Value::Object(hit));
    }

    hits.sort_by(|a, b| {
        json_u64(b, "score")
            .cmp(&json_u64(a, "score"))
            .then_with(|| json_path(a).cmp(json_path(b)))
    });
    hits.truncate(limit);
    Ok(Value::Array(hits))
}

fn workspace_recent(
    manifest: &ExtensionManifest,
    workspace_root: &Path,
    args: &[Value],
) -> Result<Value, AppError> {
    let limit = limit_arg(args, 0, 20, 100);
    let mut files = readable_markdown_files(manifest, workspace_root);
    files.sort_by(|a, b| {
        crate::commands::fs::modified_time(&b.path)
            .cmp(&crate::commands::fs::modified_time(&a.path))
            .then_with(|| a.relative_path.cmp(&b.relative_path))
    });
    Ok(Value::Array(
        files
            .into_iter()
            .take(limit)
            .map(|file| note_ref(&file))
            .collect(),
    ))
}

fn workspace_find_by_name(
    manifest: &ExtensionManifest,
    workspace_root: &Path,
    args: &[Value],
) -> Result<Value, AppError> {
    let name = string_arg(args, 0, "name")?.to_lowercase();
    let mut matches = Vec::new();
    for resolved in readable_markdown_files(manifest, workspace_root) {
        let file_name = resolved
            .path
            .file_name()
            .map(|part| part.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let stem = resolved
            .path
            .file_stem()
            .map(|part| part.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let title = title_for_path(&resolved.path, &resolved.relative_path).to_lowercase();
        if file_name == name || stem == name || title == name {
            matches.push(resolved);
        }
    }
    matches.sort_by(|a, b| {
        a.relative_path
            .split('/')
            .count()
            .cmp(&b.relative_path.split('/').count())
            .then_with(|| a.relative_path.cmp(&b.relative_path))
    });
    Ok(matches
        .into_iter()
        .next()
        .map(|resolved| Value::String(resolved.relative_path))
        .unwrap_or(Value::Null))
}

fn embeddings_query(
    manifest: &ExtensionManifest,
    workspace_root: &Path,
    args: &[Value],
    app: &tauri::AppHandle,
) -> Result<Value, AppError> {
    let text = string_arg(args, 0, "text")?.to_string();
    let limit = limit_arg(args, 1, 8, 100) as u32;
    let hits = semantic::semantic_search(text, Some(limit), app.clone())?;
    let mut out = Vec::new();

    for (fallback_index, hit) in hits.into_iter().enumerate() {
        let Ok(resolved) =
            resolve_workspace_path(workspace_root, &hit.note_path, PathResolution::MustExist)
        else {
            continue;
        };
        if !workspace_path_granted(manifest, false, &resolved.relative_path) {
            continue;
        }
        let chunk_index =
            chunk_index_for_hit(&resolved.path, &hit.chunk_text).unwrap_or(fallback_index);
        out.push(json!({
            "path": resolved.relative_path,
            "title": title_for_path(&resolved.path, &hit.note_path),
            "excerpt": hit.chunk_text,
            "distance": hit.distance,
            "chunkIndex": chunk_index,
        }));
    }

    Ok(Value::Array(out))
}

fn embeddings_status(
    manifest: &ExtensionManifest,
    workspace_root: Option<&Path>,
    app: &tauri::AppHandle,
) -> Result<Value, AppError> {
    let status = semantic::semantic_index_status(app.clone())?;
    let total = workspace_root
        .map(|root| readable_markdown_files(manifest, root).len())
        .unwrap_or(status.note_count);
    Ok(json!({
        "indexed": status.note_count,
        "total": total,
        "building": false,
        "model": format!("hash-{}", status.dimensions),
        "dimensions": status.dimensions,
        "lastBuilt": Value::Null,
    }))
}

fn embeddings_reindex(
    manifest: &ExtensionManifest,
    workspace_root: Option<&Path>,
    args: &[Value],
    webview: &tauri::Webview,
    app: &tauri::AppHandle,
) -> Result<Value, AppError> {
    let force = args
        .first()
        .and_then(Value::as_object)
        .and_then(|options| options.get("force"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if force {
        app.state::<semantic::SemanticState>().store.clear_all()?;
    }
    semantic::semantic_reindex_all(webview.clone(), app.clone())?;
    embeddings_status(manifest, workspace_root, app)
}

fn embeddings_clear(app: &tauri::AppHandle) -> Result<Value, AppError> {
    app.state::<semantic::SemanticState>().store.clear_all()?;
    Ok(Value::Null)
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

fn storage_remove(
    app: &tauri::AppHandle,
    extension_id: &str,
    args: &[Value],
    shared: bool,
) -> Result<Value, AppError> {
    let key = string_arg(args, 0, "key")?;
    let path = storage_path(app, extension_id, shared)?;
    let mut values = read_storage(&path)?;
    values.remove(key);
    write_storage(&path, &values)?;
    Ok(Value::Null)
}

fn storage_keys(
    app: &tauri::AppHandle,
    extension_id: &str,
    shared: bool,
) -> Result<Value, AppError> {
    let path = storage_path(app, extension_id, shared)?;
    let values = read_storage(&path)?;
    let mut keys: Vec<_> = values.keys().cloned().map(Value::String).collect();
    keys.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    Ok(Value::Array(keys))
}

fn preferences_all(
    app: &tauri::AppHandle,
    extension_id: &str,
    manifest: &ExtensionManifest,
) -> Result<Value, AppError> {
    Ok(Value::Object(preference_values(
        app,
        extension_id,
        manifest,
    )?))
}

fn preferences_get(
    app: &tauri::AppHandle,
    extension_id: &str,
    manifest: &ExtensionManifest,
    args: &[Value],
) -> Result<Value, AppError> {
    let name = string_arg(args, 0, "name")?;
    Ok(preference_values(app, extension_id, manifest)?
        .remove(name)
        .unwrap_or(Value::Null))
}

fn clipboard_copy(app: &tauri::AppHandle, args: &[Value]) -> Result<Value, AppError> {
    let text = string_arg(args, 0, "text")?;
    app.clipboard()
        .write_text(text)
        .map_err(|err| AppError::Unavailable(err.to_string()))?;
    Ok(Value::Null)
}

fn clipboard_read(app: &tauri::AppHandle) -> Result<Value, AppError> {
    let text = app
        .clipboard()
        .read_text()
        .map_err(|err| AppError::Unavailable(err.to_string()))?;
    Ok(Value::String(text))
}

fn readable_markdown_files(
    manifest: &ExtensionManifest,
    workspace_root: &Path,
) -> Vec<ResolvedWorkspacePath> {
    markdown_files(workspace_root)
        .into_iter()
        .filter(|resolved| workspace_path_granted(manifest, false, &resolved.relative_path))
        .collect()
}

fn markdown_files(workspace_root: &Path) -> Vec<ResolvedWorkspacePath> {
    let (files, _) = crate::commands::search::index_workspace_impl(
        workspace_root,
        Arc::new(AtomicBool::new(false)),
    );
    let mut resolved: Vec<_> = files
        .into_iter()
        .filter_map(|file| {
            resolve_workspace_path(
                workspace_root,
                &file.relative_path,
                PathResolution::MustExist,
            )
            .ok()
        })
        .filter(|file| {
            file.path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        })
        .collect();
    resolved.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    resolved
}

fn note_ref(resolved: &ResolvedWorkspacePath) -> Value {
    json!({
        "path": resolved.relative_path,
        "title": title_for_path(&resolved.path, &resolved.relative_path),
        "modified": crate::commands::fs::modified_time(&resolved.path),
    })
}

fn title_for_path(path: &Path, fallback: &str) -> String {
    crate::commands::fs::markdown_file_entry(path)
        .and_then(|entry| entry.title)
        .filter(|title| !title.trim().is_empty())
        .or_else(|| {
            path.file_stem()
                .map(|stem| stem.to_string_lossy().to_string())
                .filter(|stem| !stem.trim().is_empty())
        })
        .unwrap_or_else(|| fallback.to_string())
}

fn excerpt_for_query(content: &str, needle: &str) -> Option<String> {
    content
        .lines()
        .find(|line| line.to_lowercase().contains(needle))
        .map(|line| line.trim().chars().take(240).collect())
        .filter(|line: &String| !line.is_empty())
}

fn chunk_index_for_hit(path: &Path, chunk_text: &str) -> Option<usize> {
    let content = fs::read_to_string(path).ok()?;
    semantic::chunker::chunk_markdown(&content)
        .into_iter()
        .position(|chunk| chunk == chunk_text)
}

fn preference_values(
    app: &tauri::AppHandle,
    extension_id: &str,
    manifest: &ExtensionManifest,
) -> Result<Map<String, Value>, AppError> {
    let mut values = Map::new();
    for preference in &manifest.preferences {
        values.insert(preference.name.clone(), preference.default.clone());
    }

    let path = preferences_path(app, extension_id)?;
    for (key, value) in read_storage(&path)? {
        if manifest
            .preferences
            .iter()
            .any(|preference| preference.name == key)
        {
            values.insert(key, value);
        }
    }
    Ok(values)
}

fn storage_shared(manifest: &ExtensionManifest) -> bool {
    manifest
        .permissions
        .capabilities
        .iter()
        .find_map(|grant| match grant {
            CapabilityGrant::Storage { shared } => Some(*shared),
            _ => None,
        })
        .unwrap_or(false)
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

fn preferences_path(app: &tauri::AppHandle, extension_id: &str) -> Result<PathBuf, AppError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| AppError::Io(err.to_string()))?
        .join("extension-preferences")
        .join(format!("{extension_id}.json")))
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

fn limit_arg(args: &[Value], index: usize, default: usize, max: usize) -> usize {
    args.get(index)
        .and_then(Value::as_u64)
        .map(|value| value.clamp(1, max as u64) as usize)
        .unwrap_or(default)
}

fn json_path(value: &Value) -> &str {
    value.get("path").and_then(Value::as_str).unwrap_or("")
}

fn json_u64(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or_default()
}

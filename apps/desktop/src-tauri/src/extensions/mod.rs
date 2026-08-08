pub mod capabilities;
pub mod manifest;
pub mod permissions;
pub mod process;
pub mod registry;
pub mod which;

use crate::error::AppError;
use crate::state::AppState;
use manifest::ExtensionManifest;
use permissions::PermissionGate;
use registry::ExtensionRegistry;
use std::path::PathBuf;
use tauri::Manager;

#[tauri::command]
pub fn extension_capability(
    instance_id: String,
    extension_id: String,
    capability: String,
    method: String,
    args: Vec<serde_json::Value>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, AppError> {
    let _ = &instance_id;
    let registry = app.state::<ExtensionRegistry>();
    let installed = registry
        .get(&extension_id)
        .ok_or_else(|| AppError::Denied(format!("extension {extension_id:?} is not installed")))?;
    if !installed.enabled {
        return Err(AppError::Denied(format!(
            "extension {extension_id:?} is disabled"
        )));
    }

    let workspace_state = app.state::<AppState>().get_or_create(webview.label());
    let workspace_root = workspace_state.workspace_root.read().clone();

    let gate = PermissionGate;
    gate.check(
        &installed.manifest,
        workspace_root.as_deref(),
        &capability,
        &method,
        &args,
    )?;

    capabilities::dispatch(
        &extension_id,
        &installed.manifest,
        workspace_root.as_deref(),
        &capability,
        &method,
        &args,
        &webview,
        &app,
    )
}

#[tauri::command]
pub fn extension_list(registry: tauri::State<'_, ExtensionRegistry>) -> Vec<ExtensionManifest> {
    registry
        .list()
        .into_iter()
        .map(|installed| installed.manifest)
        .collect()
}

#[tauri::command]
pub fn extension_install_manifest(
    json: String,
    dir: String,
    registry: tauri::State<'_, ExtensionRegistry>,
) -> Result<(), AppError> {
    let manifest: ExtensionManifest =
        serde_json::from_str(&json).map_err(|err| AppError::Invalid(err.to_string()))?;
    manifest.validate()?;
    registry.register(manifest, PathBuf::from(dir))
}

pub fn init(app: &tauri::AppHandle) {
    app.manage(ExtensionRegistry::default());
    app.manage(process::ProcessTable::default());
}

/// Release any OS resources an extension instance still holds.
///
/// Called when a panel is disposed. This is host-enforced rather than left to
/// the guest because an extension that crashed, ran out of memory, or blew its
/// CPU budget never runs its own teardown - and an `unsafe`-tier extension may
/// be holding a live child process. Without this, closing a panel leaks a
/// process every time.
#[tauri::command]
pub fn extension_reap(extension_id: String, app: tauri::AppHandle) {
    use tauri::Manager as _;
    app.state::<process::ProcessTable>().reap(&extension_id);
}

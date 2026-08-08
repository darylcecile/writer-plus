pub mod capabilities;
pub mod credentials;
pub mod github;
pub mod installer;
pub mod manifest;
pub mod permissions;
pub mod process;
pub mod registry;
pub mod which;

use crate::error::AppError;
use crate::state::AppState;
use installer::{InstallCandidate, StagedInstall};
use manifest::ExtensionManifest;
use parking_lot::Mutex;
use permissions::PermissionGate;
use registry::ExtensionRegistry;
use std::collections::HashMap;
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
    let registry = ExtensionRegistry::default();

    // Load what is already on disk. Without this an install survives on disk
    // but not in the registry, so it disappears from the app on restart.
    match extensions_dir(app) {
        Ok(dir) => {
            for (path, err) in registry.load_from_disk(&dir) {
                // Skipping is deliberate (one broken extension must not hide the
                // rest) but it must not be silent, or a user sees an extension
                // missing with no way to find out why.
                eprintln!("[extensions] skipping {}: {err}", path.display());
            }
        }
        Err(e) => eprintln!("[extensions] could not open extensions directory: {e}"),
    }

    app.manage(registry);
    app.manage(process::ProcessTable::default());
    app.manage(StagingArea::default());
}

/// Downloads waiting on a consent decision.
///
/// Held in memory rather than on disk so that abandoning a consent dialog -
/// including by quitting - leaves nothing behind. An install that was never
/// approved should not be recoverable.
#[derive(Default)]
pub struct StagingArea(Mutex<HashMap<String, StagedInstall>>);

fn extensions_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Unavailable(format!("no app data directory: {e}")))?
        .join("extensions");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Fetch a release and report what the user is being asked to approve.
///
/// Writes nothing. The returned candidate carries the bundle hash, which
/// [`extension_install_commit`] requires back - so an install cannot happen
/// without a round trip through whatever asked the user.
#[tauri::command]
pub async fn extension_install_resolve(
    repo: String,
    app: tauri::AppHandle,
) -> Result<InstallCandidate, AppError> {
    // The token is read here rather than accepted as an argument so that a PAT
    // able to read private repositories never enters the WebView - the same
    // WebView that renders extension UI.
    let token = credentials::load()?;

    let installed_manifest = {
        let registry = app.state::<ExtensionRegistry>();
        let repo_ref = github::RepoRef::parse(&repo)?;
        // Match on the repo recorded at install time rather than on id, since
        // the id is only knowable after the manifest is fetched.
        installed_from_repo(&app, &repo_ref.slug()).and_then(|id| registry.get(&id))
    };

    let staged = installer::resolve(
        &repo,
        token,
        app.package_info().version.to_string().as_str(),
        installed_manifest.as_ref().map(|i| &i.manifest),
    )
    .await?;

    let candidate = staged.candidate.clone();
    app.state::<StagingArea>()
        .0
        .lock()
        .insert(candidate.bundle_sha256.clone(), staged);
    Ok(candidate)
}

/// Install a previously resolved candidate the user has approved.
#[tauri::command]
pub fn extension_install_commit(
    bundle_sha256: String,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let staged = app
        .state::<StagingArea>()
        .0
        .lock()
        .remove(&bundle_sha256)
        .ok_or_else(|| {
            AppError::NotFound(
                "that download is no longer staged; resolve the extension again".into(),
            )
        })?;

    let dir = extensions_dir(&app)?;
    let installed_dir = installer::commit(&staged, &bundle_sha256, &dir)?;
    app.state::<ExtensionRegistry>()
        .register(staged.candidate.manifest, installed_dir)
}

/// Save a GitHub token for private-repo installs.
///
/// There is deliberately no command to read it back. The frontend needs to know
/// only whether one exists, which is what [`extension_token_status`] reports.
#[tauri::command]
pub fn extension_token_save(token: String) -> Result<(), AppError> {
    credentials::store(&token)
}

/// Forget the stored GitHub token.
#[tauri::command]
pub fn extension_token_clear() -> Result<(), AppError> {
    credentials::clear()
}

/// Whether a GitHub token is stored. Never returns the token itself.
#[tauri::command]
pub fn extension_token_status() -> Result<bool, AppError> {
    Ok(credentials::load()?.is_some())
}

/// Discard a staged download without installing it.
#[tauri::command]
pub fn extension_install_cancel(bundle_sha256: String, app: tauri::AppHandle) {
    app.state::<StagingArea>().0.lock().remove(&bundle_sha256);
}

#[tauri::command]
pub fn extension_uninstall(extension_id: String, app: tauri::AppHandle) -> Result<(), AppError> {
    let dir = extensions_dir(&app)?;
    installer::uninstall(&extension_id, &dir)?;
    app.state::<ExtensionRegistry>().remove(&extension_id);
    app.state::<process::ProcessTable>().reap(&extension_id);
    Ok(())
}

/// The installed extension id that came from `repo`, if any.
fn installed_from_repo(app: &tauri::AppHandle, repo_slug: &str) -> Option<String> {
    let dir = extensions_dir(app).ok()?;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let record = entry.path().join("install.json");
        let Ok(bytes) = std::fs::read(&record) else {
            continue;
        };
        let Ok(record) = serde_json::from_slice::<installer::InstallRecord>(&bytes) else {
            continue;
        };
        if record.repo == repo_slug {
            return entry.file_name().to_str().map(str::to_string);
        }
    }
    None
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

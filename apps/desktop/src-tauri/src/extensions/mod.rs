pub mod capabilities;
pub mod credentials;
pub mod github;
pub mod grants;
pub mod installer;
pub mod manifest;
pub mod permissions;
pub mod process;
pub mod registry;
pub mod updates;
pub mod which;

use crate::error::AppError;
use crate::state::AppState;
use grants::GrantStore;
use installer::{InstallCandidate, StagedInstall};
use manifest::ExtensionManifest;
use parking_lot::Mutex;
use permissions::{PathResolution, PermissionGate};
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

    // Runtime tier, checked only after the manifest gate passed. Order is
    // deliberate: a capability the extension never declared must be refused
    // outright, never turned into a dialog, or any extension could raise an
    // alarming prompt for a permission it does not hold and harvest a click.
    grants::check(
        &app.state::<GrantStore>(),
        &installed.manifest,
        &extension_id,
        &capability,
        &method,
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

/// Resolves a path an extension named, for an action the *host* performs on the
/// user's behalf - opening a note in the editor, or previewing one in a panel.
///
/// These actions grant the extension nothing: it never receives the file's
/// contents, and it cannot observe whether this call succeeded. So they
/// deliberately require no capability. What they must not become is a way to
/// point the host at somewhere it should not look, which is why every such path
/// funnels through here and through the same containment check that guards
/// `workspace.read`. Without it an extension could render the user's private
/// keys into a panel next to a persuasive sentence, and the host would have
/// done it obligingly on the extension's say-so.
///
/// It is a separate command rather than a `PermissionGate` method precisely
/// because there is no permission involved; folding it into the gate would
/// imply a grant that is neither requested nor checked.
/// The containment half of [`extension_resolve_note`], split out so it can be
/// tested without a live webview. The command is untestable on its own (it
/// needs a real `Webview` and `AppHandle`), and untested containment is how a
/// traversal ships.
fn resolve_note_path(root: &std::path::Path, path: &str) -> Result<String, AppError> {
    let resolved = permissions::resolve_workspace_path(root, path, PathResolution::MustExist)?;
    Ok(resolved.path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn extension_resolve_note(
    extension_id: String,
    path: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<String, AppError> {
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
    let root = workspace_root.ok_or(AppError::NoWorkspace)?;

    resolve_note_path(&root, &path)
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

    // Runtime permission decisions. A missing or unreadable file means "no
    // decisions yet", so a wiped grants file re-prompts rather than silently
    // keeping permissions the user can no longer see.
    let grant_store = match extensions_dir(app) {
        Ok(dir) => GrantStore::load(&dir.join("grants.json")),
        Err(e) => {
            eprintln!("[extensions] permission decisions will not persist: {e}");
            GrantStore::default()
        }
    };
    app.manage(grant_store);
}

/// Everything the frontend runtime needs to start one installed extension.
///
/// Assembled in Rust so the capability namespaces the broker enforces are
/// derived from the same enum Rust gates on. Deriving them in TypeScript is
/// exactly how the consent dialog once ended up listing no permissions at all.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeExtension {
    pub id: String,
    pub name: String,
    pub code: String,
    pub commands: Vec<manifest::CommandDecl>,
    pub permissions: RuntimeGrants,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeGrants {
    pub capabilities: Vec<String>,
    pub uses_services: Vec<String>,
    pub provides_services: Vec<String>,
}

/// Namespaces every extension may call regardless of its manifest.
///
/// `preferences` only ever returns the extension's own declared preference
/// values, and `ui` never leaves the renderer, so neither is something to
/// consent to. They are listed here rather than special-cased in the broker so
/// the set is enumerable and reviewable in one place.
const IMPLICIT_CAPABILITIES: [&str; 2] = ["preferences", "ui"];

/// Installed extensions with their bundles, ready to run.
///
/// An extension whose bundle is missing or unreadable is skipped with a log
/// rather than failing the whole list: one broken install must not take every
/// other extension down with it.
#[tauri::command]
pub fn extension_runtime_list(app: tauri::AppHandle) -> Vec<RuntimeExtension> {
    let registry = app.state::<ExtensionRegistry>();
    let mut out = Vec::new();

    for installed in registry.list() {
        if !installed.enabled {
            continue;
        }

        let bundle = installed.install_dir.join("extension.js");
        let code = match std::fs::read_to_string(&bundle) {
            Ok(code) => code,
            Err(err) => {
                eprintln!(
                    "[extensions] {} has no runnable bundle at {}: {err}",
                    installed.manifest.id,
                    bundle.display()
                );
                continue;
            }
        };

        let mut capabilities: Vec<String> = installed
            .manifest
            .permissions
            .capabilities
            .iter()
            .map(|grant| grant.namespace().to_string())
            .collect();
        capabilities.extend(IMPLICIT_CAPABILITIES.iter().map(|s| s.to_string()));
        // `services` is routed peer to peer and checked against usesServices
        // rather than this list, but the broker's namespace check runs first.
        if !installed.manifest.permissions.uses_services.is_empty() {
            capabilities.push("services".into());
        }
        capabilities.sort();
        capabilities.dedup();

        out.push(RuntimeExtension {
            id: installed.manifest.id.clone(),
            name: installed.manifest.name.clone(),
            code,
            commands: installed.manifest.commands.clone(),
            permissions: RuntimeGrants {
                capabilities,
                uses_services: installed.manifest.permissions.uses_services.clone(),
                provides_services: installed.manifest.permissions.provides_services.clone(),
            },
        });
    }

    out
}

/// Writer's own wording for a permission an extension is asking to use.
///
/// The prompt must not invent its own description: the text a user reads when
/// deciding has to be the text produced by the module that grants the
/// permission, or the two can drift and the dialog stops describing what it
/// actually authorises.
#[tauri::command]
pub fn extension_permission_detail(
    extension_id: String,
    key: String,
    app: tauri::AppHandle,
) -> Result<manifest::PermissionDescription, AppError> {
    let registry = app.state::<ExtensionRegistry>();
    let installed = registry.get(&extension_id).ok_or_else(|| {
        AppError::NotFound(format!("extension {extension_id:?} is not installed"))
    })?;

    installed
        .manifest
        .describe_permissions()
        .into_iter()
        .find(|d| d.key == key)
        .ok_or_else(|| AppError::NotFound(format!("{extension_id:?} does not request {key:?}")))
}

/// Record what the user chose in a runtime permission prompt.
///
/// Rejects keys the extension never requested. Without that check a
/// compromised frontend could grant an extension a permission its manifest
/// never declared and the user never saw at install.
#[tauri::command]
pub fn extension_grant_set(
    extension_id: String,
    key: String,
    decision: grants::Decision,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    // Reuses the lookup above precisely so "is this a real permission for this
    // extension?" has one answer.
    extension_permission_detail(extension_id.clone(), key.clone(), app.clone())?;
    app.state::<GrantStore>()
        .record(&extension_id, &key, decision);
    Ok(())
}

/// Persisted runtime decisions for one extension, so they can be reviewed and
/// revoked. A permission granted once and never surfaced again is a permission
/// the user has effectively lost control of.
///
/// Each record carries Writer's own wording for the permission where the
/// manifest still describes it, so the review list reads the same as the dialog
/// the decision was made in. A key the manifest no longer mentions is still
/// listed, under its raw key: a decision that outlived the declaration is
/// exactly the one a user most needs to be able to see and take back.
#[tauri::command]
pub fn extension_grants(extension_id: String, app: tauri::AppHandle) -> Vec<GrantRecord> {
    let described = app
        .state::<ExtensionRegistry>()
        .get(&extension_id)
        .map(|installed| installed.manifest.describe_permissions());

    label_grants(
        app.state::<GrantStore>().list(&extension_id),
        described.as_deref(),
    )
}

/// Joins recorded decisions to the wording the user was shown.
///
/// Pulled out of the command so it can be tested without an `AppHandle`. The
/// fallback is the interesting half: a key the manifest no longer describes
/// still has to appear, because a decision that outlived its declaration is
/// precisely the one a user most needs to see and take back.
fn label_grants(
    recorded: Vec<(String, bool)>,
    described: Option<&[manifest::PermissionDescription]>,
) -> Vec<GrantRecord> {
    recorded
        .into_iter()
        .map(|(key, allowed)| {
            let label = described
                .and_then(|all| all.iter().find(|d| d.key == key))
                .map(|d| d.label.clone())
                .unwrap_or_else(|| key.clone());
            GrantRecord {
                key,
                label,
                allowed,
            }
        })
        .collect()
}

/// Reports the VM self test's result out of the WebView.
///
/// WebKit enforces CSP for WebAssembly, and the app serves its policy as an
/// HTTP header on `tauri://` - which no browser reproduces. So whether the
/// sandbox actually starts in the shipped app is not something a browser test
/// can answer, and the badge that answers it renders inside the very WebView
/// in question. This is the only way the answer reaches anywhere it can be
/// read: a terminal, or CI.
///
/// Failures are loud on purpose. A sandbox that silently does not start is the
/// worst outcome available, because every layer above it - the manifest, the
/// permission gate, the consent dialog - is built on the assumption that
/// extension code is contained.
#[tauri::command]
pub fn extension_vm_self_test_report(engine: String, ok: bool, detail: String) {
    if ok {
        eprintln!("[extensions] VM self test passed: engine={engine} ({detail})");
    } else {
        eprintln!("[extensions] VM SELF TEST FAILED: engine={engine} ({detail})");
    }
}

/// Take back one decision, returning the permission to "ask next time".
///
/// Deliberately does not validate the extension or the key the way
/// `extension_grant_set` does. Granting must be checked against the manifest;
/// revoking can only ever reduce access, so a stale key or an extension whose
/// manifest has since changed must not be a reason to refuse. A permission a
/// user cannot take back is not one they ever really granted.
#[tauri::command]
pub fn extension_grant_revoke(extension_id: String, key: String, app: tauri::AppHandle) {
    app.state::<GrantStore>().revoke(&extension_id, &key);
}

#[derive(serde::Serialize)]
pub struct GrantRecord {
    pub key: String,
    /// Writer's wording, falling back to the raw key if the manifest no longer
    /// describes it.
    pub label: String,
    pub allowed: bool,
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
    // Reinstalling the same id must not silently inherit consent the user gave
    // to different code.
    app.state::<GrantStore>().forget(&extension_id);
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

/// Check every GitHub-installed extension for a newer release.
///
/// Reports rather than installs: an update still goes through the normal
/// consent flow, so an extension cannot widen its permissions by publishing a
/// release.
///
/// Failures are per-extension. One unreachable repo (deleted, renamed, or a
/// revoked token) must not read as "nothing has updates", so its error is
/// returned alongside the successes instead of aborting the whole check.
#[tauri::command]
pub async fn extension_check_updates(
    app: tauri::AppHandle,
) -> Result<updates::UpdateReport, AppError> {
    let dir = extensions_dir(&app)?;
    run_update_check(&dir, credentials::load()?).await
}

/// Run a check only if the interval has elapsed, returning what is known
/// either way.
///
/// The caller decides *whether* checking on a schedule is wanted; this decides
/// whether it is time. Splitting it that way keeps the throttle out of a React
/// component, where a remount would reset it and turn "once a day" into "every
/// time Preferences is opened".
///
/// A failed scheduled check is recorded, not raised. It runs without the user
/// asking, so an error dialog on launch because the network is down would be
/// noise - but it is still written down, so Preferences can show that the last
/// attempt failed rather than implying everything is current.
#[tauri::command]
pub async fn extension_check_updates_if_due(
    app: tauri::AppHandle,
) -> Result<Option<updates::UpdateReport>, AppError> {
    let dir = extensions_dir(&app)?;
    let last = updates::last_check(&dir);
    if !updates::is_due(
        last.as_ref(),
        updates::now_secs(),
        updates::CHECK_INTERVAL_SECS,
    ) {
        return Ok(last);
    }

    match run_update_check(&dir, credentials::load()?).await {
        Ok(report) => Ok(Some(report)),
        Err(err) => {
            eprintln!("[extensions] scheduled update check failed: {err}");
            Ok(last)
        }
    }
}

/// What the last check found, without touching the network.
#[tauri::command]
pub fn extension_update_status(
    app: tauri::AppHandle,
) -> Result<Option<updates::UpdateReport>, AppError> {
    Ok(updates::last_check(&extensions_dir(&app)?))
}

/// The check itself, shared by the manual and scheduled entry points so they
/// cannot drift into reporting different things.
///
/// Takes the token rather than reading the Keychain, so a test can exercise a
/// real check without depending on - or writing to - whatever the developer
/// happens to have stored. A test that quietly reads real credentials passes
/// or fails for reasons that have nothing to do with the code.
async fn run_update_check(
    dir: &std::path::Path,
    token: Option<String>,
) -> Result<updates::UpdateReport, AppError> {
    let mut sources = Vec::new();
    for entry in std::fs::read_dir(dir)?.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        // Staging leftovers are not installed extensions.
        if name.starts_with('.') {
            continue;
        }
        if let Some(record) = updates::install_record(&entry.path()) {
            sources.push((name, record));
        }
    }

    let mut available = Vec::new();
    let mut errors = Vec::new();
    for (id, record) in sources {
        match updates::check_one(&record, &id, token.clone()).await {
            Ok(Some(update)) => available.push(update),
            Ok(None) => {}
            Err(err) => errors.push(updates::UpdateCheckError {
                id,
                message: err.to_string(),
            }),
        }
    }

    let report = updates::UpdateReport {
        checked_at: updates::now_secs(),
        available,
        errors,
    };
    updates::record_check(dir, &report);
    Ok(report)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn described(key: &str, label: &str) -> manifest::PermissionDescription {
        manifest::PermissionDescription {
            key: key.into(),
            label: label.into(),
            detail: String::new(),
            reason: None,
            tier: manifest::PermissionTier::Runtime,
        }
    }

    #[test]
    fn a_recorded_decision_is_shown_with_writers_own_wording() {
        let labelled = label_grants(
            vec![("workspace.write".into(), true)],
            Some(&[described("workspace.write", "Change your notes")]),
        );

        assert_eq!(labelled[0].label, "Change your notes");
        assert!(labelled[0].allowed);
    }

    /// The case that matters: an extension updated to drop a capability it once
    /// asked for leaves the old decision behind. Dropping it from the list
    /// would hide a grant the user could no longer revoke.
    #[test]
    fn a_decision_the_manifest_no_longer_describes_is_still_listed() {
        let labelled = label_grants(vec![("network".into(), true)], Some(&[]));

        assert_eq!(labelled.len(), 1);
        assert_eq!(labelled[0].key, "network");
        assert_eq!(labelled[0].label, "network");
    }

    /// An uninstalled extension has no manifest to read, and its decisions
    /// should already be gone - but if any survive, they must still be visible.
    #[test]
    fn decisions_survive_a_missing_manifest() {
        let labelled = label_grants(vec![("workspace.write".into(), false)], None);

        assert_eq!(labelled[0].label, "workspace.write");
        assert!(!labelled[0].allowed);
    }

    /// Scheduled checks must be opt-in.
    ///
    /// This app does not decide to use someone's network for them - the same
    /// reason the embedding model is downloaded on request. A default flipped
    /// to `true` in passing would start sending the user's GitHub token to
    /// github.com on every launch, and nothing in the UI would look different.
    #[test]
    fn scheduled_update_checks_are_off_unless_the_user_turns_them_on() {
        let schema = crate::config::settings_schema();
        let def = schema
            .iter()
            .find(|d| d.key == "extensions.auto-check-updates")
            .expect("the preference must exist in the schema Rust and the UI share");

        assert!(
            matches!(def.default, crate::config::ConfigValue::Bool(false)),
            "expected a boolean default of false, got {:?}",
            def.default
        );
        assert!(
            def.description.contains("token"),
            "the wording must say what the request carries, not just that it happens"
        );
    }
}

#[cfg(test)]
mod live_update_tests {
    //! The scheduled check against a real release. `#[ignore]`d because it
    //! needs network. Run with:
    //! `GITHUB_TOKEN=$(gh auth token) cargo test --lib live_update -- --ignored --nocapture`
    //!
    //! The unit tests pin `is_due` against synthetic timestamps, which proves
    //! the arithmetic but not that a check ever writes the timestamp it later
    //! reads. That seam is exactly where a throttle silently becomes a
    //! per-launch poller: every individual piece passes and the interval is
    //! never actually observed.

    use super::*;
    use crate::extensions::installer::InstallRecord;

    #[tokio::test]
    #[ignore = "network + private fixture"]
    async fn a_real_check_records_its_result_and_is_not_due_again() {
        assert!(
            std::env::var("GITHUB_TOKEN").is_ok(),
            "set GITHUB_TOKEN=$(gh auth token)"
        );

        let dir = tempfile::TempDir::new().unwrap();
        let ext = dir.path().join("live.test");
        std::fs::create_dir_all(&ext).unwrap();
        std::fs::write(
            ext.join("install.json"),
            serde_json::to_vec(&InstallRecord {
                repo: "darylcecile/writer-ext-live-test".into(),
                version: "0.0.1".into(),
                bundle_sha256: String::new(),
            })
            .unwrap(),
        )
        .unwrap();

        let report = run_update_check(dir.path(), std::env::var("GITHUB_TOKEN").ok())
            .await
            .expect("check failed");
        println!(
            "checked_at={} available={} errors={:?}",
            report.checked_at,
            report.available.len(),
            report.errors
        );
        assert!(
            report.errors.is_empty(),
            "the fixture repo must be reachable"
        );
        assert_eq!(
            report.available.len(),
            1,
            "0.0.1 is behind the real release"
        );

        let persisted = updates::last_check(dir.path()).expect("the check must be written down");
        assert_eq!(persisted.checked_at, report.checked_at);
        assert_eq!(persisted.available.len(), 1);

        assert!(
            !updates::is_due(
                Some(&persisted),
                updates::now_secs(),
                updates::CHECK_INTERVAL_SECS
            ),
            "a check that just ran must not be due again, or the schedule is a per-launch poller"
        );
    }
}

#[cfg(test)]
mod resolve_note_tests {
    use super::*;
    use std::fs;

    /// A note inside the workspace resolves, so the containment check is not
    /// simply refusing everything and passing by accident.
    #[test]
    fn a_note_inside_the_workspace_resolves() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        fs::write(root.join("note.md"), "hi").unwrap();

        let resolved = resolve_note_path(&root, "note.md").expect("a real note must resolve");
        assert!(resolved.ends_with("note.md"));
    }

    #[test]
    fn a_path_outside_the_workspace_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let outside = dir.path().parent().unwrap().join("outside.md");
        fs::write(&outside, "secret").unwrap();

        let err = resolve_note_path(&root, "../outside.md")
            .expect_err("traversal above the workspace must be refused");
        assert!(
            matches!(err, AppError::Denied(_)),
            "expected a denial, got {err:?}"
        );
    }

    /// The one that matters. A symlink is the interesting attack because the
    /// path *is* inside the workspace right up until the filesystem follows it.
    #[cfg(unix)]
    #[test]
    fn a_symlink_escaping_the_workspace_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();

        let secret = dir.path().join("id_rsa");
        fs::write(&secret, "PRIVATE KEY").unwrap();
        std::os::unix::fs::symlink(&secret, root.join("innocent.md")).unwrap();

        let err = resolve_note_path(&root, "innocent.md")
            .expect_err("a symlink pointing outside the workspace must be refused");
        assert!(
            matches!(err, AppError::Denied(_)),
            "expected a denial, got {err:?}"
        );
    }

    /// An absolute path is not a shortcut around the root.
    #[test]
    fn an_absolute_path_outside_the_workspace_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let outside = dir.path().parent().unwrap().join("elsewhere.md");
        fs::write(&outside, "secret").unwrap();

        let err = resolve_note_path(&root, outside.to_str().unwrap())
            .expect_err("an absolute path outside the workspace must be refused");
        assert!(
            matches!(err, AppError::Denied(_)),
            "expected a denial, got {err:?}"
        );
    }
}

//! Runtime permission grants.
//!
//! Install-time consent covers capabilities whose damage is bounded by their
//! own scope: a `workspace.read` grant physically cannot reach outside its
//! globs because Rust refuses. Runtime-tier capabilities are different -
//! modifying or deleting notes, or reaching an unrestricted network - and the
//! spec has always said these are prompted on first use rather than buried in
//! an install list next to "read your notes".
//!
//! **Rust decides, the UI only asks.** The gate lives here rather than in the
//! host JavaScript because the host renders extension UI in the same WebView
//! that runs extension code. A check on that side is a check an extension may
//! be able to reach. Rust refuses a runtime-tier call until a grant exists, so
//! the worst a compromised frontend can do is fail to show a prompt - it cannot
//! manufacture consent it never received.
//!
//! **"Allow once" is not persisted, and that is the point.** It lives in memory
//! for the life of the process, so it lapses on quit. Writing it to disk would
//! quietly turn it into "always".

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::manifest::{ExtensionManifest, PermissionDescription, PermissionTier};

/// What a user chose when asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Decision {
    /// This call only. Never written to disk.
    Once,
    /// Every call, until revoked.
    Always,
    /// Refuse, and keep refusing without asking again.
    Never,
}

/// The persisted half: only `Always` and `Never` survive a restart.
#[derive(Debug, Default, Serialize, Deserialize)]
struct StoredGrants {
    /// `extension id` → `permission key` → allowed.
    #[serde(default)]
    decisions: HashMap<String, HashMap<String, bool>>,
}

/// Runtime grants for the running process.
#[derive(Default)]
pub struct GrantStore {
    stored: Mutex<StoredGrants>,
    /// `(extension id, permission key)` pairs allowed once. Deliberately
    /// separate from `stored` so it cannot be persisted by accident.
    session: Mutex<HashSet<(String, String)>>,
    path: Mutex<Option<PathBuf>>,
}

/// Whether a runtime-tier call may proceed.
#[derive(Debug, PartialEq, Eq)]
pub enum GrantState {
    Allowed,
    Denied,
    /// No decision recorded. The caller must ask before proceeding.
    NeedsApproval,
}

impl GrantStore {
    /// Load persisted grants. A missing or unreadable file is treated as "no
    /// decisions yet", which fails *closed*: every runtime call will prompt.
    pub fn load(path: &Path) -> Self {
        let stored = std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<StoredGrants>(&bytes).ok())
            .unwrap_or_default();

        Self {
            stored: Mutex::new(stored),
            session: Mutex::new(HashSet::new()),
            path: Mutex::new(Some(path.to_path_buf())),
        }
    }

    pub fn state(&self, extension_id: &str, key: &str) -> GrantState {
        if let Some(allowed) = self
            .stored
            .lock()
            .expect("grants poisoned")
            .decisions
            .get(extension_id)
            .and_then(|keys| keys.get(key))
        {
            return if *allowed {
                GrantState::Allowed
            } else {
                GrantState::Denied
            };
        }

        if self
            .session
            .lock()
            .expect("session grants poisoned")
            .contains(&(extension_id.to_string(), key.to_string()))
        {
            return GrantState::Allowed;
        }

        GrantState::NeedsApproval
    }

    /// Record what the user chose.
    pub fn record(&self, extension_id: &str, key: &str, decision: Decision) {
        match decision {
            Decision::Once => {
                self.session
                    .lock()
                    .expect("session grants poisoned")
                    .insert((extension_id.to_string(), key.to_string()));
            }
            Decision::Always | Decision::Never => {
                self.stored
                    .lock()
                    .expect("grants poisoned")
                    .decisions
                    .entry(extension_id.to_string())
                    .or_default()
                    .insert(key.to_string(), decision == Decision::Always);
                self.persist();
            }
        }
    }

    /// Forget every decision for one extension.
    ///
    /// Called on uninstall so a reinstall does not silently inherit consent the
    /// user gave to different code.
    pub fn forget(&self, extension_id: &str) {
        self.stored
            .lock()
            .expect("grants poisoned")
            .decisions
            .remove(extension_id);
        self.session
            .lock()
            .expect("session grants poisoned")
            .retain(|(id, _)| id != extension_id);
        self.persist();
    }

    /// Every persisted decision for one extension, so the UI can show and
    /// revoke them.
    pub fn list(&self, extension_id: &str) -> Vec<(String, bool)> {
        self.stored
            .lock()
            .expect("grants poisoned")
            .decisions
            .get(extension_id)
            .map(|keys| keys.iter().map(|(k, v)| (k.clone(), *v)).collect())
            .unwrap_or_default()
    }

    /// Best-effort write.
    ///
    /// A failure here means a decision does not survive restart, so the user is
    /// asked again - annoying but safe. Refusing the call instead would make an
    /// unwritable disk look like a denied permission.
    fn persist(&self) {
        let Some(path) = self.path.lock().expect("path poisoned").clone() else {
            return;
        };
        let stored = self.stored.lock().expect("grants poisoned");
        if let Ok(bytes) = serde_json::to_vec_pretty(&*stored) {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Err(err) = std::fs::write(&path, bytes) {
                eprintln!("[grants] could not save permission decisions: {err}");
            }
        }
    }
}

/// Which permission key a capability call would consume, before knowing its
/// tier.
///
/// Deliberately *only* a call → key mapping. Whether that key is runtime-tier
/// is answered by the manifest, because the manifest is where every tier is
/// already decided and a second copy here would be free to disagree with the
/// wording the user was shown.
fn permission_key_for(capability: &str, method: &str) -> Option<&'static str> {
    match (capability, method) {
        ("workspace", "write") => Some("workspace.write"),
        ("network", _) => Some("network"),
        _ => None,
    }
}

/// The permission that must be approved before this call may run, or `None`
/// when install consent already covered it.
///
/// Returns the manifest's own description so the prompt uses the exact wording
/// the install dialog would have used.
///
/// Call this *after* the manifest permission gate has passed. A call the
/// extension was never granted must be refused outright, not turned into a
/// dialog - otherwise any extension could raise an alarming prompt for a
/// permission it does not hold.
pub fn required_approval(
    manifest: &ExtensionManifest,
    capability: &str,
    method: &str,
) -> Option<PermissionDescription> {
    let key = permission_key_for(capability, method)?;
    manifest
        .describe_permissions()
        .into_iter()
        .find(|description| description.key == key && description.tier == PermissionTier::Runtime)
}

/// Raised when a runtime-tier call has no decision yet.
///
/// Carries the permission key so the frontend knows what to ask about.
///
/// The whole gate, composed: what a call needs, what the user has said, and
/// what happens when they have not said anything. It lives here as a plain
/// function rather than inline in the Tauri command so the policy can be
/// exercised directly - the composition is the part that decides whether a
/// note gets modified, and a Tauri harness is a poor place to find that out.
///
/// Call *after* the manifest permission gate has passed.
pub fn check(
    store: &GrantStore,
    manifest: &ExtensionManifest,
    extension_id: &str,
    capability: &str,
    method: &str,
) -> Result<(), AppError> {
    let Some(required) = required_approval(manifest, capability, method) else {
        return Ok(());
    };

    match store.state(extension_id, &required.key) {
        GrantState::Allowed => Ok(()),
        GrantState::Denied => Err(AppError::Denied(format!(
            "{} was declined for {extension_id:?}",
            required.key
        ))),
        GrantState::NeedsApproval => Err(AppError::NeedsApproval(required.key)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn an_unknown_permission_needs_approval() {
        let store = GrantStore::default();
        assert_eq!(
            store.state("ext", "workspace.write"),
            GrantState::NeedsApproval
        );
    }

    #[test]
    fn always_is_remembered() {
        let store = GrantStore::default();
        store.record("ext", "workspace.write", Decision::Always);
        assert_eq!(store.state("ext", "workspace.write"), GrantState::Allowed);
    }

    /// A refusal must stick. Re-prompting after "never" trains a user to click
    /// through dialogs, which disarms every dialog after it.
    #[test]
    fn never_is_remembered_and_does_not_re_prompt() {
        let store = GrantStore::default();
        store.record("ext", "workspace.write", Decision::Never);
        assert_eq!(store.state("ext", "workspace.write"), GrantState::Denied);
    }

    #[test]
    fn a_decision_is_scoped_to_one_extension_and_one_permission() {
        let store = GrantStore::default();
        store.record("a", "workspace.write", Decision::Always);

        assert_eq!(
            store.state("b", "workspace.write"),
            GrantState::NeedsApproval
        );
        assert_eq!(store.state("a", "network"), GrantState::NeedsApproval);
    }

    /// The whole point of "once": it must not become "always" by being written
    /// to disk.
    #[test]
    fn allow_once_is_never_persisted() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("grants.json");

        let store = GrantStore::load(&path);
        store.record("ext", "workspace.write", Decision::Once);
        assert_eq!(store.state("ext", "workspace.write"), GrantState::Allowed);

        let reloaded = GrantStore::load(&path);
        assert_eq!(
            reloaded.state("ext", "workspace.write"),
            GrantState::NeedsApproval,
            "allow-once must lapse when the process ends"
        );
    }

    #[test]
    fn always_and_never_survive_a_restart() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("grants.json");

        let store = GrantStore::load(&path);
        store.record("yes", "workspace.write", Decision::Always);
        store.record("no", "workspace.write", Decision::Never);

        let reloaded = GrantStore::load(&path);
        assert_eq!(
            reloaded.state("yes", "workspace.write"),
            GrantState::Allowed
        );
        assert_eq!(reloaded.state("no", "workspace.write"), GrantState::Denied);
    }

    /// Reinstalling different code under the same id must not inherit consent.
    #[test]
    fn uninstalling_forgets_every_decision() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("grants.json");

        let store = GrantStore::load(&path);
        store.record("ext", "workspace.write", Decision::Always);
        store.record("ext", "network", Decision::Once);
        store.forget("ext");

        assert_eq!(
            store.state("ext", "workspace.write"),
            GrantState::NeedsApproval
        );
        assert_eq!(store.state("ext", "network"), GrantState::NeedsApproval);
        assert_eq!(
            GrantStore::load(&path).state("ext", "workspace.write"),
            GrantState::NeedsApproval,
            "the removal must reach disk"
        );
    }

    /// A corrupt file must fail closed - prompting - not open.
    #[test]
    fn a_corrupt_grant_file_prompts_rather_than_allowing() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("grants.json");
        std::fs::write(&path, b"{ not json").unwrap();

        let store = GrantStore::load(&path);
        assert_eq!(
            store.state("ext", "workspace.write"),
            GrantState::NeedsApproval
        );
    }

    #[test]
    fn listing_returns_persisted_decisions_only() {
        let store = GrantStore::default();
        store.record("ext", "workspace.write", Decision::Always);
        store.record("ext", "network", Decision::Once);

        let listed = store.list("ext");
        assert_eq!(listed.len(), 1, "allow-once is not a saved decision");
        assert_eq!(listed[0], ("workspace.write".to_string(), true));
    }

    // ── which calls need approval ─────────────────────────────────────────────

    fn manifest_with(capabilities: &str) -> ExtensionManifest {
        let json = format!(
            r#"{{
                "id": "test-ext",
                "name": "Test",
                "version": "1.0.0",
                "description": "Fixture",
                "author": "Writer",
                "commands": [{{ "name": "main", "title": "Main", "mode": "view" }}],
                "permissions": {{ "capabilities": {capabilities} }}
            }}"#
        );
        serde_json::from_str(&json).expect("fixture manifest should parse")
    }

    /// Parses *and* passes install validation.
    ///
    /// Serde will happily accept manifests the installer rejects, so a fixture
    /// that only parses can assert on a state no user can ever reach.
    fn installable(capabilities: &str) -> ExtensionManifest {
        let manifest = manifest_with(capabilities);
        manifest
            .validate()
            .expect("fixture must be a manifest that could really be installed");
        manifest
    }

    #[test]
    fn reads_do_not_need_approval() {
        let manifest = installable(r#"[{ "name": "workspace", "read": ["**/*.md"] }]"#);

        assert!(required_approval(&manifest, "workspace", "read").is_none());
        assert!(required_approval(&manifest, "workspace", "list").is_none());
        assert!(required_approval(&manifest, "workspace", "search").is_none());
    }

    #[test]
    fn writing_notes_needs_approval() {
        let manifest =
            installable(r#"[{ "name": "workspace", "read": ["**/*.md"], "write": ["**/*.md"] }]"#);

        let approval = required_approval(&manifest, "workspace", "write")
            .expect("modifying notes is runtime-tier");
        assert_eq!(approval.key, "workspace.write");
        assert_eq!(approval.tier, PermissionTier::Runtime);
        assert!(
            !approval.label.is_empty() && !approval.detail.is_empty(),
            "the prompt must have wording to show"
        );
    }

    /// A host allowlist was reviewable at install time; an empty one means
    /// "anywhere" and is the exfiltration path the runtime tier exists for.
    #[test]
    fn only_unrestricted_network_needs_approval() {
        let restricted = installable(r#"[{ "name": "network", "hosts": ["api.github.com"] }]"#);
        assert!(required_approval(&restricted, "network", "fetch").is_none());

        let unrestricted = installable(r#"[{ "name": "network", "hosts": [] }]"#);
        let approval = required_approval(&unrestricted, "network", "fetch")
            .expect("an unrestricted host list is runtime-tier");
        assert_eq!(approval.key, "network");
    }

    /// `*` is rejected outright at install, so an empty list is the only way to
    /// reach the unrestricted network tier. Pinned here because the test above
    /// would otherwise be free to assert on a manifest that can never exist -
    /// which is what it did before this was checked.
    #[test]
    fn a_wildcard_host_cannot_be_installed_at_all() {
        let wildcard = manifest_with(r#"[{ "name": "network", "hosts": ["*"] }]"#);
        assert!(wildcard.validate().is_err());
    }

    /// An extension must not be able to raise an alarming dialog about a
    /// permission it never asked for. Reaching this state means the manifest
    /// gate already refused, so there is nothing to approve.
    #[test]
    fn an_undeclared_capability_has_nothing_to_approve() {
        let manifest = installable(r#"[{ "name": "workspace", "read": ["**/*.md"] }]"#);

        assert!(
            required_approval(&manifest, "workspace", "write").is_none(),
            "a read-only manifest offers no write permission to prompt for"
        );
        assert!(required_approval(&manifest, "network", "fetch").is_none());
    }

    /// The wording shown in the prompt must be the wording the manifest
    /// produces, not a second copy that can drift.
    #[test]
    fn approval_wording_comes_from_the_manifest() {
        let manifest =
            installable(r#"[{ "name": "workspace", "read": ["**/*.md"], "write": ["notes/**"] }]"#);

        let approval = required_approval(&manifest, "workspace", "write").unwrap();
        let from_manifest = manifest
            .describe_permissions()
            .into_iter()
            .find(|d| d.key == "workspace.write")
            .unwrap();

        assert_eq!(approval.label, from_manifest.label);
        assert_eq!(approval.detail, from_manifest.detail);
    }

    // ── the composed gate ─────────────────────────────────────────────────────
    //
    // These are the tests that matter: the pieces above can each be right while
    // the composition still lets a write through.

    const WRITER: &str = r#"[{ "name": "workspace", "read": ["**/*.md"], "write": ["**/*.md"] }]"#;

    #[test]
    fn a_first_write_is_refused_until_the_user_is_asked() {
        let manifest = installable(WRITER);
        let store = GrantStore::default();

        let err = check(&store, &manifest, "ext", "workspace", "write")
            .expect_err("a write with no decision must not proceed");
        assert!(matches!(err, AppError::NeedsApproval(ref key) if key == "workspace.write"));
    }

    #[test]
    fn a_write_proceeds_once_allowed() {
        let manifest = installable(WRITER);
        let store = GrantStore::default();
        store.record("ext", "workspace.write", Decision::Always);

        assert!(check(&store, &manifest, "ext", "workspace", "write").is_ok());
    }

    /// A refusal must read as a refusal, not as an unanswered question - or the
    /// host would prompt again, and again, until the user gave in.
    #[test]
    fn a_declined_write_is_denied_rather_than_re_asked() {
        let manifest = installable(WRITER);
        let store = GrantStore::default();
        store.record("ext", "workspace.write", Decision::Never);

        let err = check(&store, &manifest, "ext", "workspace", "write").unwrap_err();
        assert!(matches!(err, AppError::Denied(_)), "got {err:?}");
    }

    /// Approving a write must not quietly approve everything else the manifest
    /// declared.
    #[test]
    fn approving_one_permission_does_not_approve_another() {
        let manifest = installable(
            r#"[{ "name": "workspace", "read": ["**/*.md"], "write": ["**/*.md"] },
                 { "name": "network", "hosts": [] }]"#,
        );
        let store = GrantStore::default();
        store.record("ext", "workspace.write", Decision::Always);

        assert!(check(&store, &manifest, "ext", "workspace", "write").is_ok());
        let err = check(&store, &manifest, "ext", "network", "fetch").unwrap_err();
        assert!(matches!(err, AppError::NeedsApproval(ref key) if key == "network"));
    }

    /// Install-tier calls must not be dragged into the prompt path. Asking
    /// about every read would bury the questions that matter.
    #[test]
    fn install_tier_calls_pass_straight_through() {
        let manifest = installable(WRITER);
        let store = GrantStore::default();

        for method in ["read", "list", "search", "recent", "findByName", "root"] {
            assert!(
                check(&store, &manifest, "ext", "workspace", method).is_ok(),
                "workspace.{method} should not prompt"
            );
        }
        assert!(check(&store, &manifest, "ext", "storage", "set").is_ok());
        assert!(check(&store, &manifest, "ext", "embeddings", "query").is_ok());
    }

    /// One extension's consent is not another's, even for the same permission.
    #[test]
    fn a_grant_does_not_leak_between_extensions() {
        let manifest = installable(WRITER);
        let store = GrantStore::default();
        store.record("trusted", "workspace.write", Decision::Always);

        assert!(check(&store, &manifest, "trusted", "workspace", "write").is_ok());
        assert!(matches!(
            check(&store, &manifest, "other", "workspace", "write"),
            Err(AppError::NeedsApproval(_))
        ));
    }

    /// Allow-once really is once per process, not once per call: a granted
    /// session decision keeps working until quit.
    #[test]
    fn allow_once_covers_later_calls_in_the_same_session() {
        let manifest = installable(WRITER);
        let store = GrantStore::default();
        store.record("ext", "workspace.write", Decision::Once);

        assert!(check(&store, &manifest, "ext", "workspace", "write").is_ok());
        assert!(check(&store, &manifest, "ext", "workspace", "write").is_ok());
    }
}

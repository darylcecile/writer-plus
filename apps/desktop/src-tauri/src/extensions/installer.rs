//! Install and update extensions from GitHub releases.
//!
//! # Why installation is two commands, not one
//!
//! Consent is not a dialog the installer pops; it is a precondition the
//! installer enforces. `resolve` fetches and inspects a release without
//! writing anything, and returns what the user must agree to. `commit` then
//! installs - but only if it is handed back the exact bundle hash `resolve`
//! reported.
//!
//! That hash echo is what makes the split worth having. If the frontend simply
//! called `install(repo)` after showing a dialog, Rust would have no way to
//! know a dialog ever appeared, and a second fetch could return a different
//! release than the one the user read the permissions of. Requiring the hash
//! closes both: the host installs the reviewed bytes or nothing.
//!
//! # Updates re-ask when, and only when, the ask changes
//!
//! A version bump that requests no new capability applies quietly. One that
//! does is not an update, it is a new consent decision, and it stops. This is
//! the single most valuable supply-chain control here: it turns "the extension
//! you trusted quietly gained the ability to spawn processes" into something
//! the user has to actively approve.

use super::github::{GitHubClient, RepoRef};
use super::manifest::{CapabilityGrant, ExtensionManifest, PermissionDescription};
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const MANIFEST_ASSET: &str = "manifest.json";
const BUNDLE_ASSET: &str = "extension.js";

/// A manifest is metadata; a megabyte of it is a bug or an attack.
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
/// Bundles include a React runtime, so the ceiling is generous, but bounded:
/// the VM has a memory budget and an oversized bundle would only fail later,
/// after the download cost had already been paid.
const MAX_BUNDLE_BYTES: u64 = 16 * 1024 * 1024;

/// What the user is being asked to approve, produced without touching disk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallCandidate {
    pub repo: String,
    pub manifest: ExtensionManifest,
    /// What the user is agreeing to, worded by the module that enforces it.
    pub permissions: Vec<PermissionDescription>,
    pub version: String,
    /// SHA-256 of the bundle. Echoed back to `commit` to pin the install to
    /// the bytes that were reviewed.
    pub bundle_sha256: String,
    /// `None` for a first install, otherwise the version being replaced.
    pub replaces_version: Option<String>,
    /// Capabilities this version requests that the installed one did not.
    /// Empty on a first install - everything is new, and the full list is
    /// already in `manifest`.
    pub added_capabilities: Vec<String>,
    /// Whether approving this leaves the sandbox. Surfaced separately so the
    /// consent UI cannot render it as one bullet among many.
    pub requires_unsafe: bool,
}

/// Bytes to write, held between `resolve` and `commit`.
pub struct StagedInstall {
    pub candidate: InstallCandidate,
    pub manifest_bytes: Vec<u8>,
    pub bundle_bytes: Vec<u8>,
}

pub async fn resolve(
    repo_input: &str,
    token: Option<String>,
    app_version: &str,
    installed: Option<&ExtensionManifest>,
) -> Result<StagedInstall, AppError> {
    let repo = RepoRef::parse(repo_input)?;
    let client = GitHubClient::new(token)?;
    let release = client.latest_release(&repo).await?;

    let manifest_asset = release.asset(MANIFEST_ASSET).ok_or_else(|| {
        AppError::Invalid(format!(
            "release {} has no {MANIFEST_ASSET} asset, so it is not a Writer extension",
            release.tag_name
        ))
    })?;
    let bundle_asset = release.asset(BUNDLE_ASSET).ok_or_else(|| {
        AppError::Invalid(format!(
            "release {} has no {BUNDLE_ASSET} asset, so it is not a Writer extension",
            release.tag_name
        ))
    })?;

    let manifest_bytes = client
        .download_asset(&repo, manifest_asset, MAX_MANIFEST_BYTES)
        .await?;
    let manifest: ExtensionManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| AppError::Invalid(format!("{MANIFEST_ASSET} is not valid: {e}")))?;
    manifest.validate()?;

    check_tag_matches_version(&release.tag_name, &manifest.version)?;
    check_writer_version(&manifest, app_version)?;

    if let Some(current) = installed {
        // Installing extension B over extension A would silently hand B every
        // grant A had, since grants are keyed by extension id.
        if current.id != manifest.id {
            return Err(AppError::Invalid(format!(
                "{} publishes extension {:?}, but {:?} is installed under that entry",
                repo.slug(),
                manifest.id,
                current.id
            )));
        }
    }

    let bundle_bytes = client
        .download_asset(&repo, bundle_asset, MAX_BUNDLE_BYTES)
        .await?;

    let added_capabilities = installed
        .map(|current| added_capabilities(current, &manifest))
        .unwrap_or_default();

    Ok(StagedInstall {
        candidate: InstallCandidate {
            repo: repo.slug(),
            version: manifest.version.clone(),
            bundle_sha256: sha256_hex(&bundle_bytes),
            replaces_version: installed.map(|m| m.version.clone()),
            requires_unsafe: manifest
                .permissions
                .capabilities
                .iter()
                .any(|c| c.is_unsafe()),
            added_capabilities,
            permissions: manifest.describe_permissions(),
            manifest,
        },
        manifest_bytes,
        bundle_bytes,
    })
}

/// Write a staged install to disk, but only if `approved_sha256` matches.
///
/// The write is atomic in the sense that matters: a fresh directory is fully
/// populated and only then swapped into place, so a crash mid-install cannot
/// leave a half-written extension that would load with a manifest and no code
/// (or worse, new code under an old manifest's permissions).
pub fn commit(
    staged: &StagedInstall,
    approved_sha256: &str,
    extensions_dir: &Path,
) -> Result<PathBuf, AppError> {
    if approved_sha256 != staged.candidate.bundle_sha256 {
        return Err(AppError::Denied(
            "the approved extension does not match the one downloaded; install cancelled".into(),
        ));
    }

    let id = &staged.candidate.manifest.id;
    if !is_safe_dir_name(id) {
        return Err(AppError::Invalid(format!(
            "extension id {id:?} cannot be used as a folder name"
        )));
    }

    let final_dir = extensions_dir.join(id);
    let staging_dir = extensions_dir.join(format!(".{id}.incoming"));

    if staging_dir.exists() {
        std::fs::remove_dir_all(&staging_dir)?;
    }
    std::fs::create_dir_all(&staging_dir)?;

    std::fs::write(staging_dir.join(MANIFEST_ASSET), &staged.manifest_bytes)?;
    std::fs::write(staging_dir.join(BUNDLE_ASSET), &staged.bundle_bytes)?;
    std::fs::write(
        staging_dir.join("install.json"),
        serde_json::to_vec_pretty(&InstallRecord {
            repo: staged.candidate.repo.clone(),
            version: staged.candidate.version.clone(),
            bundle_sha256: staged.candidate.bundle_sha256.clone(),
        })
        .map_err(|e| AppError::Invalid(e.to_string()))?,
    )?;

    // Retiring the old directory before the rename keeps the window in which
    // no extension exists as short as a rename, rather than as long as a
    // recursive delete.
    let retired_dir = extensions_dir.join(format!(".{id}.retired"));
    if retired_dir.exists() {
        std::fs::remove_dir_all(&retired_dir)?;
    }
    let had_previous = final_dir.exists();
    if had_previous {
        std::fs::rename(&final_dir, &retired_dir)?;
    }

    if let Err(err) = std::fs::rename(&staging_dir, &final_dir) {
        // Put the previous version back rather than leaving the user with
        // nothing because an upgrade failed.
        if had_previous {
            let _ = std::fs::rename(&retired_dir, &final_dir);
        }
        return Err(err.into());
    }

    let _ = std::fs::remove_dir_all(&retired_dir);
    Ok(final_dir)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRecord {
    pub repo: String,
    pub version: String,
    pub bundle_sha256: String,
}

pub fn uninstall(id: &str, extensions_dir: &Path) -> Result<(), AppError> {
    if !is_safe_dir_name(id) {
        return Err(AppError::Invalid(format!("invalid extension id {id:?}")));
    }
    let dir = extensions_dir.join(id);
    if !dir.exists() {
        return Err(AppError::NotFound(format!("{id} is not installed")));
    }
    std::fs::remove_dir_all(dir)?;
    Ok(())
}

/// Capabilities present in `next` that `current` did not have.
///
/// Compared by rendered grant rather than by variant, so widening an existing
/// grant counts as new: going from `workspace.read: ["notes/**"]` to
/// `["**"]` is a privilege increase and must re-prompt, even though the
/// capability name is unchanged.
fn added_capabilities(current: &ExtensionManifest, next: &ExtensionManifest) -> Vec<String> {
    let existing: Vec<String> = current
        .permissions
        .capabilities
        .iter()
        .map(describe_grant)
        .collect();

    let mut added: Vec<String> = next
        .permissions
        .capabilities
        .iter()
        .map(describe_grant)
        .filter(|d| !existing.contains(d))
        .collect();

    // A new inter-extension dependency is also an escalation: it lets this
    // extension reach data another one holds.
    for service in &next.permissions.uses_services {
        if !current.permissions.uses_services.contains(service) {
            added.push(format!("services.uses:{service}"));
        }
    }

    added.sort();
    added.dedup();
    added
}

fn describe_grant(grant: &CapabilityGrant) -> String {
    match grant {
        CapabilityGrant::Workspace { read, write } => {
            format!("workspace read={} write={}", join(read), join(write))
        }
        CapabilityGrant::Embeddings { query, write } => {
            format!("embeddings query={query} write={write}")
        }
        CapabilityGrant::Storage { shared } => format!("storage shared={shared}"),
        CapabilityGrant::Network { hosts } => format!("network hosts={}", join(hosts)),
        CapabilityGrant::Clipboard { read, write } => {
            format!("clipboard read={read} write={write}")
        }
        // Reason is excluded on purpose: rewording the justification must not
        // register as a new capability, and must not let a changed reason slip
        // by unreviewed either - `requires_unsafe` is surfaced every time.
        CapabilityGrant::Unsafe { .. } => "unsafe".to_string(),
    }
}

fn join(items: &[String]) -> String {
    if items.is_empty() {
        "-".to_string()
    } else {
        let mut sorted = items.to_vec();
        sorted.sort();
        sorted.join(",")
    }
}

/// The release tag must equal the manifest version.
///
/// Without this an author could tag `v2.0.0` while shipping a manifest that
/// still says `1.0.0`, and every version comparison downstream - update
/// checks, "what am I replacing" in the consent dialog - would be reasoning
/// about a number that does not describe the code.
fn check_tag_matches_version(tag: &str, version: &str) -> Result<(), AppError> {
    if tag.trim_start_matches('v') == version {
        return Ok(());
    }
    Err(AppError::Invalid(format!(
        "release tag {tag:?} does not match manifest version {version:?}"
    )))
}

fn check_writer_version(manifest: &ExtensionManifest, app_version: &str) -> Result<(), AppError> {
    let Some(required) = &manifest.min_writer_version else {
        return Ok(());
    };
    let required_v = semver::Version::parse(required).map_err(|e| {
        AppError::Invalid(format!("minWriterVersion {required:?} is not valid: {e}"))
    })?;
    let app_v = semver::Version::parse(app_version)
        .map_err(|e| AppError::Invalid(format!("app version {app_version:?} is not valid: {e}")))?;
    if app_v < required_v {
        return Err(AppError::Invalid(format!(
            "{} needs Writer {required} or newer; this is {app_version}",
            manifest.name
        )));
    }
    Ok(())
}

/// Extension ids become directory names, so they must not be able to escape
/// the extensions folder or collide with the `.`-prefixed staging directories.
fn is_safe_dir_name(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
        && !id.contains("..")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::manifest::{CommandDecl, CommandMode, Permissions};

    fn manifest(version: &str, capabilities: Vec<CapabilityGrant>) -> ExtensionManifest {
        ExtensionManifest {
            id: "test.ext".into(),
            name: "Test".into(),
            version: version.into(),
            description: "d".into(),
            author: "a".into(),
            min_writer_version: None,
            commands: vec![CommandDecl {
                name: "run".into(),
                title: "Run".into(),
                mode: CommandMode::View,
            }],
            permissions: Permissions {
                capabilities,
                uses_services: vec![],
                provides_services: vec![],
            },
            preferences: vec![],
        }
    }

    fn workspace(read: &[&str]) -> CapabilityGrant {
        CapabilityGrant::Workspace {
            read: read.iter().map(|s| s.to_string()).collect(),
            write: vec![],
        }
    }

    fn staged(sha: &str) -> StagedInstall {
        StagedInstall {
            candidate: InstallCandidate {
                repo: "o/r".into(),
                manifest: manifest("1.0.0", vec![]),
                permissions: vec![],
                version: "1.0.0".into(),
                bundle_sha256: sha.into(),
                replaces_version: None,
                added_capabilities: vec![],
                requires_unsafe: false,
            },
            manifest_bytes: b"{}".to_vec(),
            bundle_bytes: b"export default 1".to_vec(),
        }
    }

    #[test]
    fn an_unchanged_permission_set_adds_nothing() {
        let a = manifest("1.0.0", vec![workspace(&["notes/**"])]);
        let b = manifest("1.1.0", vec![workspace(&["notes/**"])]);
        assert!(added_capabilities(&a, &b).is_empty());
    }

    #[test]
    fn glob_order_is_not_treated_as_a_permission_change() {
        // Otherwise every reordering of a manifest would demand re-consent,
        // and users would learn to click through the dialog without reading.
        let a = manifest("1.0.0", vec![workspace(&["a/**", "b/**"])]);
        let b = manifest("1.1.0", vec![workspace(&["b/**", "a/**"])]);
        assert!(added_capabilities(&a, &b).is_empty());
    }

    #[test]
    fn widening_an_existing_grant_counts_as_new() {
        // The capability name is unchanged, so a variant-level comparison
        // would let this through. It is a straightforward privilege increase.
        let a = manifest("1.0.0", vec![workspace(&["notes/**"])]);
        let b = manifest("2.0.0", vec![workspace(&["**"])]);
        assert_eq!(added_capabilities(&a, &b).len(), 1);
    }

    #[test]
    fn quietly_gaining_unsafe_is_reported() {
        let a = manifest("1.0.0", vec![workspace(&["**"])]);
        let b = manifest(
            "2.0.0",
            vec![
                workspace(&["**"]),
                CapabilityGrant::Unsafe {
                    reason: "trust me".into(),
                },
            ],
        );
        assert_eq!(added_capabilities(&a, &b), vec!["unsafe".to_string()]);
    }

    #[test]
    fn rewording_an_unsafe_reason_is_not_a_new_capability() {
        let a = manifest(
            "1.0.0",
            vec![CapabilityGrant::Unsafe {
                reason: "runs an agent".into(),
            }],
        );
        let b = manifest(
            "1.1.0",
            vec![CapabilityGrant::Unsafe {
                reason: "runs the AI agent you picked".into(),
            }],
        );
        assert!(added_capabilities(&a, &b).is_empty());
    }

    #[test]
    fn a_new_service_dependency_counts_as_new() {
        let a = manifest("1.0.0", vec![]);
        let mut b = manifest("2.0.0", vec![]);
        b.permissions.uses_services = vec!["search".into()];
        assert_eq!(
            added_capabilities(&a, &b),
            vec!["services.uses:search".to_string()]
        );
    }

    #[test]
    fn dropping_a_capability_is_not_an_escalation() {
        let a = manifest(
            "1.0.0",
            vec![
                workspace(&["**"]),
                CapabilityGrant::Network { hosts: vec![] },
            ],
        );
        let b = manifest("2.0.0", vec![workspace(&["**"])]);
        assert!(added_capabilities(&a, &b).is_empty());
    }

    #[test]
    fn tag_must_match_manifest_version() {
        assert!(check_tag_matches_version("v1.2.3", "1.2.3").is_ok());
        assert!(check_tag_matches_version("1.2.3", "1.2.3").is_ok());
        assert!(check_tag_matches_version("v2.0.0", "1.2.3").is_err());
        assert!(check_tag_matches_version("latest", "1.2.3").is_err());
    }

    #[test]
    fn refuses_an_extension_that_needs_a_newer_writer() {
        let mut m = manifest("1.0.0", vec![]);
        m.min_writer_version = Some("9.0.0".into());
        assert!(check_writer_version(&m, "0.4.0").is_err());
        assert!(check_writer_version(&m, "9.0.0").is_ok());
        assert!(check_writer_version(&m, "9.1.0").is_ok());
    }

    #[test]
    fn rejects_ids_that_would_escape_the_extensions_folder() {
        for id in ["..", "../evil", "a/b", ".hidden", "", "a..b"] {
            assert!(!is_safe_dir_name(id), "should have rejected {id:?}");
        }
        for id in ["writer.ai-chat", "some_ext", "ext-1"] {
            assert!(is_safe_dir_name(id), "should have accepted {id:?}");
        }
    }

    #[test]
    fn commit_refuses_a_bundle_the_user_did_not_approve() {
        // The whole point of the two-phase flow. If the bytes changed between
        // the consent dialog and the install, the consent does not apply.
        let dir = tempdir();
        let s = staged("abc123");
        let err = commit(&s, "different-hash", &dir).unwrap_err();
        assert!(matches!(err, AppError::Denied(_)));
        assert!(!dir.join("test.ext").exists());
    }

    #[test]
    fn commit_writes_manifest_bundle_and_record() {
        let dir = tempdir();
        let s = staged("abc123");
        let installed = commit(&s, "abc123", &dir).unwrap();

        assert_eq!(
            std::fs::read(installed.join("extension.js")).unwrap(),
            s.bundle_bytes
        );
        let record: InstallRecord =
            serde_json::from_slice(&std::fs::read(installed.join("install.json")).unwrap())
                .unwrap();
        assert_eq!(record.bundle_sha256, "abc123");
        assert_eq!(record.repo, "o/r");
    }

    #[test]
    fn reinstalling_replaces_rather_than_merging() {
        // A stale file left behind by an old version could be loaded by the
        // new one, so the directory must be replaced wholesale.
        let dir = tempdir();
        let first = staged("hash-1");
        commit(&first, "hash-1", &dir).unwrap();
        std::fs::write(dir.join("test.ext").join("stale.js"), b"old").unwrap();

        let mut second = staged("hash-2");
        second.bundle_bytes = b"export default 2".to_vec();
        let installed = commit(&second, "hash-2", &dir).unwrap();

        assert!(!installed.join("stale.js").exists());
        assert_eq!(
            std::fs::read(installed.join("extension.js")).unwrap(),
            b"export default 2"
        );
    }

    #[test]
    fn uninstall_removes_the_directory_and_reports_a_missing_one() {
        let dir = tempdir();
        commit(&staged("h"), "h", &dir).unwrap();
        assert!(uninstall("test.ext", &dir).is_ok());
        assert!(!dir.join("test.ext").exists());
        assert!(matches!(
            uninstall("test.ext", &dir).unwrap_err(),
            AppError::NotFound(_)
        ));
    }

    #[test]
    fn uninstall_cannot_be_pointed_outside_the_extensions_folder() {
        let dir = tempdir();
        assert!(uninstall("../..", &dir).is_err());
        assert!(uninstall("a/b", &dir).is_err());
    }

    #[test]
    fn sha256_matches_a_known_vector() {
        // Empty-string SHA-256, so a broken digest cannot pass by comparing
        // two equally-wrong values.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    fn tempdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("writer-installer-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}

#[cfg(test)]
mod live_tests {
    //! End-to-end against a real GitHub release. `#[ignore]`d because it needs
    //! network. Run with:
    //! `cargo test --lib installer::live_ -- --ignored --nocapture`
    //!
    //! Every other test in this file constructs a `StagedInstall` by hand, which
    //! proves the install *logic* but not that it is connected to anything. This
    //! one starts from `owner/repo` and ends with an extension on disk, so the
    //! seams - release listing, asset lookup, authenticated download, manifest
    //! parse, tag/version agreement, atomic commit - are all exercised together.
    //!
    //! ## The fixture repository
    //!
    //! `darylcecile/writer-ext-live-test` is a **private** repo holding a single
    //! `v1.0.0` release with a `manifest.json` and an `extension.js`. It is
    //! private on purpose: that makes it serve as the private-repo fixture too,
    //! so both paths share one fixture and the private case cannot rot from
    //! disuse. Every test here therefore needs `GITHUB_TOKEN` set to a token
    //! that can read it:
    //!
    //! ```sh
    //! GITHUB_TOKEN=$(gh auth token) cargo test --lib installer::live_ -- --ignored
    //! ```
    //!
    //! To recreate it: publish a release tagged `v1.0.0` whose `manifest.json`
    //! declares id `writer.live-test`, version `1.0.0`, and a single `workspace`
    //! capability reading `notes/**`. The tag must equal the manifest version or
    //! `resolve` will reject it, which is itself the behaviour under test.

    use super::*;

    const TEST_REPO: &str = "darylcecile/writer-ext-live-test";

    fn token() -> String {
        std::env::var("GITHUB_TOKEN")
            .expect("set GITHUB_TOKEN; the fixture repo is private (see module docs)")
    }

    #[tokio::test]
    #[ignore = "requires network"]
    async fn live_installs_a_real_release_end_to_end() {
        let staged = resolve(TEST_REPO, Some(token()), "1.0.0", None)
            .await
            .expect("resolve should reach GitHub and parse the release");

        assert_eq!(staged.candidate.manifest.id, "writer.live-test");
        assert_eq!(staged.candidate.version, "1.0.0");
        assert_eq!(staged.candidate.replaces_version, None);
        assert!(!staged.candidate.requires_unsafe);

        // The consent wording must survive the round trip, since it is the whole
        // reason resolve is separate from commit.
        let described = staged.candidate.manifest.describe_permissions();
        assert!(
            described
                .iter()
                .any(|p| p.label.contains("notes/**") || p.detail.contains("notes/**")),
            "the workspace glob must reach the dialog: {described:?}"
        );

        let root = tempfile::tempdir().unwrap();
        let dir = commit(&staged, &staged.candidate.bundle_sha256, root.path())
            .expect("commit should install the resolved bytes");

        assert!(dir.join("manifest.json").is_file());
        assert!(dir.join("extension.js").is_file());
        assert!(
            dir.join("install.json").is_file(),
            "provenance must be recorded"
        );

        // And the registry must be able to pick it back up after a restart.
        let registry = crate::extensions::registry::ExtensionRegistry::default();
        assert!(registry.load_from_disk(root.path()).is_empty());
        assert_eq!(registry.list().len(), 1);
        assert_eq!(registry.list()[0].manifest.id, "writer.live-test");
    }

    /// The hash echo is the control that stops an install the user never saw.
    /// Proving it holds against real downloaded bytes, not a hand-made fixture.
    #[tokio::test]
    #[ignore = "requires network"]
    async fn live_commit_rejects_a_hash_the_user_never_approved() {
        let staged = resolve(TEST_REPO, Some(token()), "1.0.0", None)
            .await
            .unwrap();
        let root = tempfile::tempdir().unwrap();

        let err = commit(
            &staged,
            "0000000000000000000000000000000000000000000000000000000000000000",
            root.path(),
        )
        .expect_err("a mismatched hash must not install");
        assert!(
            format!("{err}").contains("approved") || format!("{err}").contains("hash"),
            "{err}"
        );
        assert!(
            std::fs::read_dir(root.path()).unwrap().next().is_none(),
            "a rejected commit must leave nothing on disk"
        );
    }
    /// Private repositories are the reason the asset API is used instead of
    /// `browser_download_url`. Both halves are asserted: without a token the
    /// repo must be invisible, and with one the same call must succeed - so a
    /// regression that made the token a no-op would be caught.
    #[tokio::test]
    #[ignore = "requires network and a token that can read the private test repo"]
    async fn live_private_repo_needs_a_token() {
        const PRIVATE_REPO: &str = "darylcecile/writer-ext-live-test";
        let token = token();

        let message = match resolve(PRIVATE_REPO, None, "1.0.0", None).await {
            Ok(_) => panic!("an anonymous caller must not see a private repo"),
            Err(err) => format!("{err}"),
        };
        // GitHub deliberately 404s rather than 403s so that a private repo's
        // existence is not confirmed; the message must not undo that.
        assert!(
            message.contains("not found") || message.contains("no access"),
            "unexpected message: {message}"
        );

        let staged = resolve(PRIVATE_REPO, Some(token), "1.0.0", None)
            .await
            .expect("the same repo must resolve once a token is supplied");
        assert_eq!(staged.candidate.manifest.id, "writer.live-test");
    }
}

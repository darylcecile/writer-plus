//! Update checks and the official extension registry.
//!
//! Two related jobs, kept in one module because both answer "is there a newer
//! version of this, and where does it come from".
//!
//! **The registry grants nothing.** `registry/extensions.json` in this repo is
//! a lookup table mapping a name to a GitHub repository. The manifest, the
//! version, and the bytes always come from that repository's own releases, so
//! being listed cannot change what an extension is allowed to do and cannot
//! shorten the consent flow. This deliberately keeps official and user-hosted
//! extensions on exactly one install path - a second, more trusted path is
//! where trust bugs live.
//!
//! **Checking is not installing.** A check reports that a newer version exists;
//! it never downloads a bundle or writes to disk. Installing still goes through
//! `installer::resolve` and `installer::commit`, so an update is consented to
//! with the same permission diff as any other install. An extension cannot
//! gain a capability by shipping a release.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::path::Path;

use super::github::{download_capped, http_client, GitHubClient, RepoRef};
use super::installer::InstallRecord;

/// Where the official registry is read from.
///
/// Served from `raw.githubusercontent.com` rather than the API so an anonymous
/// client is not spending the caller's unauthenticated API rate limit on a
/// file that is public by definition.
const REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/darylcecile/writer-plus/master/registry/extensions.json";

/// The registry is a small list of pointers; anything larger is wrong.
const MAX_REGISTRY_BYTES: u64 = 256 * 1024;

/// One entry in the official registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryEntry {
    pub id: String,
    pub name: String,
    pub author: String,
    pub description: String,
    /// `owner/repo`. Everything authoritative is fetched from here.
    pub repo: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RegistryFile {
    extensions: Vec<RegistryEntry>,
}

/// Fetch the official registry.
#[tauri::command]
pub async fn extension_registry_list() -> Result<Vec<RegistryEntry>, AppError> {
    fetch_registry(REGISTRY_URL).await
}

/// The fetch itself, taking the URL so it can be tested against a branch
/// before the file exists on `master`.
async fn fetch_registry(url: &str) -> Result<Vec<RegistryEntry>, AppError> {
    let client = http_client()?;
    let bytes = download_capped(&client, url, MAX_REGISTRY_BYTES).await?;
    let file: RegistryFile = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::Invalid(format!("the extension registry is not valid: {e}")))?;
    Ok(file.extensions)
}

/// An installed extension with a newer release available.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub id: String,
    pub repo: String,
    pub installed_version: String,
    pub latest_version: String,
}

/// Compare an installed version against the newest release of its repo.
///
/// Returns `None` when it is already current. Errors are the caller's to
/// report: a check that silently swallows a failure teaches a user that "no
/// updates" and "could not reach GitHub" look the same.
pub async fn check_one(
    record: &InstallRecord,
    id: &str,
    token: Option<String>,
) -> Result<Option<AvailableUpdate>, AppError> {
    let repo = RepoRef::parse(&record.repo)?;
    let client = GitHubClient::new(token)?;
    let release = client.latest_release(&repo).await?;

    let latest = release.tag_name.trim_start_matches('v').to_string();
    if is_newer(&latest, &record.version) {
        Ok(Some(AvailableUpdate {
            id: id.to_string(),
            repo: record.repo.clone(),
            installed_version: record.version.clone(),
            latest_version: latest,
        }))
    } else {
        Ok(None)
    }
}

/// Read the `install.json` written at install time.
///
/// Its absence is not an error: an extension can be present without ever
/// having been installed from GitHub (the bundled ones are), and those simply
/// have no update source.
pub fn install_record(extension_dir: &Path) -> Option<InstallRecord> {
    let bytes = std::fs::read(extension_dir.join("install.json")).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Whether `candidate` is a newer semantic version than `current`.
///
/// Compares numerically component by component rather than lexically, because
/// a string comparison makes 0.10.0 look older than 0.9.0 - which would leave
/// a user silently stuck on an old version forever. Non-numeric components
/// (prerelease tags) sort *before* the release they qualify, matching semver:
/// 1.0.0-beta is older than 1.0.0.
fn is_newer(candidate: &str, current: &str) -> bool {
    let key = |v: &str| -> (Vec<u64>, bool) {
        let core = v.split(['-', '+']).next().unwrap_or(v);
        let parts: Vec<u64> = core
            .split('.')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect();
        // A prerelease sorts before the same core version.
        (parts, !v.contains('-'))
    };

    let (a, a_release) = key(candidate);
    let (b, b_release) = key(current);

    let len = a.len().max(b.len());
    for i in 0..len {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    // Same core version: a release beats a prerelease.
    a_release && !b_release
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_higher_patch_is_newer() {
        assert!(is_newer("1.0.1", "1.0.0"));
        assert!(!is_newer("1.0.0", "1.0.1"));
    }

    /// The bug a lexical comparison would cause: 0.10.0 reads as *older* than
    /// 0.9.0, so a user sits on an old version forever and nothing says why.
    #[test]
    fn double_digit_components_compare_numerically_not_lexically() {
        assert!(is_newer("0.10.0", "0.9.0"));
        assert!(is_newer("1.0.0", "0.99.0"));
        assert!(!is_newer("0.9.0", "0.10.0"));
    }

    #[test]
    fn the_same_version_is_not_an_update() {
        assert!(!is_newer("1.2.3", "1.2.3"));
    }

    #[test]
    fn missing_components_are_treated_as_zero() {
        assert!(!is_newer("1.0", "1.0.0"));
        assert!(is_newer("1.1", "1.0.9"));
    }

    /// Offering a prerelease as an update would push users onto unfinished
    /// builds without asking.
    #[test]
    fn a_prerelease_is_older_than_the_release_it_qualifies() {
        assert!(!is_newer("1.0.0-beta", "1.0.0"));
        assert!(is_newer("1.0.0", "1.0.0-beta"));
    }

    #[test]
    fn a_missing_install_record_is_not_an_error() {
        let dir = tempfile::TempDir::new().unwrap();
        assert!(
            install_record(dir.path()).is_none(),
            "a bundled extension has no GitHub source and that is normal"
        );
    }

    #[test]
    fn a_corrupt_install_record_is_treated_as_absent() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("install.json"), b"{ not json").unwrap();
        assert!(install_record(dir.path()).is_none());
    }

    #[test]
    fn an_install_record_round_trips() {
        let dir = tempfile::TempDir::new().unwrap();
        let record = InstallRecord {
            repo: "owner/repo".into(),
            version: "1.2.3".into(),
            bundle_sha256: "abc".into(),
        };
        std::fs::write(
            dir.path().join("install.json"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();

        let read = install_record(dir.path()).expect("should read back");
        assert_eq!(read.repo, "owner/repo");
        assert_eq!(read.version, "1.2.3");
    }

    /// The registry file in this repo must parse into the struct the app reads
    /// it with.
    ///
    /// This runs offline and in CI on purpose. Two schemas for the same file
    /// drifting apart has already caused one security bug in this system (the
    /// consent dialog rendering an empty permission list), and the failure mode
    /// here is the same shape: the file looks fine, the code looks fine, and
    /// the registry silently reads as empty.
    #[test]
    fn the_checked_in_registry_matches_the_struct_that_reads_it() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../registry/extensions.json");
        let bytes =
            std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));

        let file: RegistryFile = serde_json::from_slice(&bytes)
            .unwrap_or_else(|e| panic!("the registry does not match RegistryFile: {e}"));

        assert!(!file.extensions.is_empty(), "the registry is empty");
        for entry in &file.extensions {
            assert!(
                RepoRef::parse(&entry.repo).is_ok(),
                "{} has an unusable repo {:?}",
                entry.id,
                entry.repo
            );
            assert!(!entry.name.is_empty(), "{} has no name", entry.id);
            assert!(
                !entry.description.is_empty(),
                "{} has no description, so the install list would show a blank row",
                entry.id
            );
        }
    }

    /// Checks a real repository with a real release, proving the tag is read
    /// and compared correctly against what is installed.
    ///
    /// `darylcecile/writer-ext-live-test` is a private fixture; see the
    /// `live_tests` module in `installer.rs`. Needs `GITHUB_TOKEN`.
    #[tokio::test]
    #[ignore = "network + private fixture"]
    async fn a_real_repo_reports_an_update_when_behind_and_none_when_current() {
        let token = std::env::var("GITHUB_TOKEN").ok();
        assert!(token.is_some(), "set GITHUB_TOKEN=$(gh auth token)");

        let behind = InstallRecord {
            repo: "darylcecile/writer-ext-live-test".into(),
            version: "0.0.1".into(),
            bundle_sha256: String::new(),
        };
        let update = check_one(&behind, "live.test", token.clone())
            .await
            .expect("check failed")
            .expect("an older install must report an update");
        println!("{} -> {}", update.installed_version, update.latest_version);
        assert_eq!(update.installed_version, "0.0.1");

        // The same repo, already at the published version, must report nothing.
        let current = InstallRecord {
            version: update.latest_version.clone(),
            ..behind
        };
        assert!(
            check_one(&current, "live.test", token)
                .await
                .expect("check failed")
                .is_none(),
            "an up-to-date install must not be offered an update"
        );
    }

    /// A repo that cannot be reached must error, not quietly report "no
    /// updates" - otherwise a revoked token looks identical to being current.
    #[tokio::test]
    #[ignore = "network"]
    async fn an_unreachable_repo_errors_rather_than_reporting_no_update() {
        let record = InstallRecord {
            repo: "darylcecile/this-repo-does-not-exist-xyz".into(),
            version: "1.0.0".into(),
            bundle_sha256: String::new(),
        };
        check_one(&record, "ghost", None)
            .await
            .expect_err("an unreachable repo must surface as an error");
    }

    /// Hits the real registry URL, so it proves the file is published at the
    /// path the app reads and parses into the shape the app expects.
    ///
    /// Only passes once this branch is merged, since it reads `master`.
    #[tokio::test]
    #[ignore = "network"]
    async fn the_published_registry_parses() {
        let url = std::env::var("WRITER_REGISTRY_URL").unwrap_or_else(|_| REGISTRY_URL.to_string());
        let entries = fetch_registry(&url).await.expect("registry fetch");
        assert!(!entries.is_empty(), "registry should not be empty");
        for entry in &entries {
            assert!(
                RepoRef::parse(&entry.repo).is_ok(),
                "{} has an unusable repo {:?}",
                entry.id,
                entry.repo
            );
        }
    }
}

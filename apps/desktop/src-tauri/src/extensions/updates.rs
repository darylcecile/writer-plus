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
//!
//! **Checking on a schedule is off by default.** A check is a network request
//! to GitHub carrying the user's token if one is stored, and this app does not
//! make network decisions on a user's behalf - the same reason the embedding
//! model is downloaded on request rather than at first launch. When it is
//! switched on, the interval is enforced *here* rather than by the caller, so
//! the throttle cannot be lost by a UI that re-mounts.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

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

/// How long a scheduled check waits before running again.
///
/// Daily rather than per-launch: an extension release is not urgent, and an
/// editor that is opened and closed twenty times a day should not produce
/// twenty authenticated requests to GitHub.
pub const CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;

/// Where the outcome of the last check is remembered.
const LAST_CHECK_FILE: &str = "update-check.json";

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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub id: String,
    pub repo: String,
    pub installed_version: String,
    pub latest_version: String,
}

/// The outcome of one update check, and when it happened.
///
/// Persisted verbatim so a scheduled check and a manual one produce the same
/// shape. Two shapes for the same answer is how a UI ends up rendering half of
/// it - the empty consent dialog in this same system started that way.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReport {
    /// Unix seconds. Shown to the user, because "no updates" is only
    /// meaningful alongside when that was last true.
    pub checked_at: u64,
    pub available: Vec<AvailableUpdate>,
    /// Extensions that could not be checked, so the UI can say so rather than
    /// implying they are up to date.
    pub errors: Vec<UpdateCheckError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckError {
    pub id: String,
    pub message: String,
}

/// Seconds since the Unix epoch, or 0 if the system clock predates it.
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Read the remembered outcome of the last check.
///
/// A missing or unreadable file simply means "never checked". Refusing to
/// start over because a cache is corrupt would strand the user with no way to
/// check again.
pub fn last_check(dir: &Path) -> Option<UpdateReport> {
    let bytes = std::fs::read(dir.join(LAST_CHECK_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Remember the outcome of a check.
///
/// A failure to write is deliberately not fatal: the check itself succeeded
/// and the caller has the answer. The cost is re-checking sooner than
/// necessary, which is strictly better than turning a working check into an
/// error the user cannot act on.
pub fn record_check(dir: &Path, report: &UpdateReport) {
    if let Ok(bytes) = serde_json::to_vec(report) {
        let _ = std::fs::write(dir.join(LAST_CHECK_FILE), bytes);
    }
}

/// Whether a scheduled check should run now.
///
/// A timestamp in the future means the clock moved backwards - a timezone fix,
/// a manual correction, or a dead RTC. Treating that as "not due yet" would
/// silently disable update checks until real time caught up, so it counts as
/// due instead. Being early once is recoverable; being stuck for months is not.
pub fn is_due(last: Option<&UpdateReport>, now: u64, interval: u64) -> bool {
    match last {
        None => true,
        Some(report) => {
            if report.checked_at > now {
                return true;
            }
            now - report.checked_at >= interval
        }
    }
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
pub(crate) fn is_newer(candidate: &str, current: &str) -> bool {
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

    fn report(checked_at: u64) -> UpdateReport {
        UpdateReport {
            checked_at,
            available: Vec::new(),
            errors: Vec::new(),
        }
    }

    #[test]
    fn a_first_run_is_always_due() {
        assert!(is_due(None, 1_000, CHECK_INTERVAL_SECS));
    }

    #[test]
    fn a_recent_check_is_not_due_again() {
        let last = report(1_000);
        assert!(!is_due(
            Some(&last),
            1_000 + CHECK_INTERVAL_SECS - 1,
            CHECK_INTERVAL_SECS
        ));
    }

    #[test]
    fn the_interval_boundary_counts_as_due() {
        let last = report(1_000);
        assert!(is_due(
            Some(&last),
            1_000 + CHECK_INTERVAL_SECS,
            CHECK_INTERVAL_SECS
        ));
    }

    /// A clock that moved backwards must not disable checking until real time
    /// catches up. A timestamp a year in the future would otherwise mean no
    /// update is ever offered again, with nothing on screen explaining why.
    #[test]
    fn a_timestamp_from_the_future_is_treated_as_due() {
        let last = report(9_000_000);
        assert!(
            is_due(Some(&last), 1_000, CHECK_INTERVAL_SECS),
            "a backwards clock must not strand the user on an old version"
        );
    }

    #[test]
    fn a_check_round_trips_through_disk() {
        let dir = tempfile::TempDir::new().unwrap();
        assert!(last_check(dir.path()).is_none(), "nothing checked yet");

        let written = UpdateReport {
            checked_at: 4_242,
            available: vec![AvailableUpdate {
                id: "a.b".into(),
                repo: "owner/repo".into(),
                installed_version: "1.0.0".into(),
                latest_version: "1.1.0".into(),
            }],
            errors: vec![UpdateCheckError {
                id: "c.d".into(),
                message: "unreachable".into(),
            }],
        };
        record_check(dir.path(), &written);

        let read = last_check(dir.path()).expect("should read back");
        assert_eq!(read.checked_at, 4_242);
        assert_eq!(read.available.len(), 1);
        assert_eq!(read.available[0].latest_version, "1.1.0");
        assert_eq!(
            read.errors.len(),
            1,
            "a failed check must survive a restart, or the next launch implies everything is current"
        );
    }

    /// A corrupt cache must not be a dead end. Refusing to read it is fine;
    /// refusing to check again because of it would leave no way to recover.
    #[test]
    fn a_corrupt_last_check_reads_as_never_checked_and_is_due() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join(LAST_CHECK_FILE), b"{ truncated").unwrap();

        let last = last_check(dir.path());
        assert!(last.is_none());
        assert!(is_due(last.as_ref(), now_secs(), CHECK_INTERVAL_SECS));
    }

    /// `now_secs` feeds the throttle, so a zero would make every check due
    /// forever.
    #[test]
    fn the_clock_returns_a_real_epoch_time() {
        // 2020-01-01, comfortably in the past but well clear of 0.
        assert!(now_secs() > 1_577_836_800);
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

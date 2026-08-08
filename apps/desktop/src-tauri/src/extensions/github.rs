//! GitHub as the extension distribution channel.
//!
//! There is no Writer-operated server and no CDN. An extension lives in its
//! author's own repository and ships as GitHub release assets, which means
//! user-hosted and official extensions travel exactly the same code path -
//! the official registry is only a lookup table of `owner/repo`, never a
//! source of truth for what gets installed.
//!
//! Two consequences worth being explicit about:
//!
//! **Private extensions need no feature of ours.** A private repo is readable
//! only by someone GitHub already authorises, so "who may install this" is a
//! question GitHub answers, not us. We pass the user's token through and let a
//! 404 mean what it means.
//!
//! **The token never reaches the webview.** Requests are made here, in the
//! host, so an extension - which is precisely the untrusted party - can never
//! read the credential that would let it enumerate the user's private repos.

use crate::error::AppError;
use serde::{Deserialize, Serialize};

const API_ROOT: &str = "https://api.github.com";

/// GitHub requires a User-Agent and will reject requests without one.
/// <https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api#user-agent>
const USER_AGENT: &str = concat!("Writer/", env!("CARGO_PKG_VERSION"));

/// Pinned so a future default change cannot silently alter response shapes.
/// <https://docs.github.com/en/rest/about-the-rest-api/api-versions>
const API_VERSION: &str = "2022-11-28";

/// A `owner/repo` pair, validated on construction.
///
/// Parsing is strict rather than forgiving because this value is interpolated
/// into a URL path. Accepting a slash-bearing "owner" would let
/// `a/b/../../other` address a different repository than the one displayed to
/// the user in the consent dialog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoRef {
    pub owner: String,
    pub name: String,
}

impl RepoRef {
    pub fn parse(input: &str) -> Result<Self, AppError> {
        let trimmed = input.trim().trim_end_matches(".git");
        // Accept a full URL for convenience, since that is what a user copying
        // from a browser will have on the clipboard.
        let path = trimmed
            .strip_prefix("https://github.com/")
            .or_else(|| trimmed.strip_prefix("http://github.com/"))
            .or_else(|| trimmed.strip_prefix("github.com/"))
            .unwrap_or(trimmed);

        let mut parts = path.split('/');
        let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
            return Err(AppError::Invalid(format!(
                "expected owner/repo, got {input:?}"
            )));
        };

        if !is_valid_segment(owner) || !is_valid_segment(name) {
            return Err(AppError::Invalid(format!(
                "invalid repository reference {input:?}"
            )));
        }

        Ok(Self {
            owner: owner.to_string(),
            name: name.to_string(),
        })
    }

    pub fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
}

/// GitHub's own rules for owner and repository names: alphanumerics plus
/// `-`, `_`, and `.`. Explicitly excluding `/`, `..`, and empty is the point -
/// see the note on [`RepoRef`].
fn is_valid_segment(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.len() <= 100
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReleaseAsset {
    pub id: u64,
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Release {
    pub tag_name: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub assets: Vec<ReleaseAsset>,
}

impl Release {
    pub fn asset(&self, name: &str) -> Option<&ReleaseAsset> {
        self.assets.iter().find(|a| a.name == name)
    }
}

/// Install the ring TLS provider, once per process.
///
/// reqwest is built with `rustls-no-provider` so that adding aws-lc-rs - a
/// second native crypto library - is not a side effect of wanting HTTPS. The
/// cost of that choice is that the provider must be installed explicitly, and
/// reqwest **panics** rather than returning an error if it is not. That makes
/// this a correctness requirement, not a nicety: without it the first install
/// attempt would crash the app.
fn install_crypto_provider() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // Errors only if something else already installed a provider, which is
        // a perfectly good outcome for us.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Thin GitHub REST client scoped to what installation needs.
pub struct GitHubClient {
    http: reqwest::Client,
    token: Option<String>,
}

impl GitHubClient {
    pub fn new(token: Option<String>) -> Result<Self, AppError> {
        install_crypto_provider();
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .build()
            .map_err(|e| AppError::Unavailable(format!("could not create HTTP client: {e}")))?;
        Ok(Self { http, token })
    }

    fn request(&self, method: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
        let mut req = self
            .http
            .request(method, url)
            .header("X-GitHub-Api-Version", API_VERSION);
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        req
    }

    /// The newest non-draft, non-prerelease release.
    ///
    /// Deliberately not `/releases/latest`: that endpoint's definition of
    /// "latest" is the most recently *created* release, which can be an older
    /// version republished. Listing and filtering keeps the rule ours and
    /// makes prerelease exclusion explicit rather than incidental.
    pub async fn latest_release(&self, repo: &RepoRef) -> Result<Release, AppError> {
        let url = format!(
            "{API_ROOT}/repos/{}/{}/releases?per_page=30",
            repo.owner, repo.name
        );
        let response = self
            .request(reqwest::Method::GET, &url)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| AppError::Unavailable(format!("could not reach GitHub: {e}")))?;

        let response = check_status(response, repo).await?;

        let releases: Vec<Release> = response
            .json()
            .await
            .map_err(|e| AppError::Invalid(format!("unreadable release list: {e}")))?;

        releases
            .into_iter()
            .find(|r| !r.draft && !r.prerelease)
            .ok_or_else(|| {
                AppError::NotFound(format!(
                    "{} has no published releases; extensions are distributed as GitHub releases",
                    repo.slug()
                ))
            })
    }

    /// Download a release asset by id.
    ///
    /// Uses the API asset endpoint rather than `browser_download_url` because
    /// the latter is unauthenticated and therefore fails for private repos.
    /// The API endpoint works for both, so there is one code path.
    /// <https://docs.github.com/en/rest/releases/assets#get-a-release-asset>
    ///
    /// `max_bytes` is enforced against the asset's declared size *and* against
    /// the bytes actually received, because the declared size is attacker-
    /// controlled metadata and streaming lets a mismatch exhaust memory before
    /// any post-hoc length check could run.
    pub async fn download_asset(
        &self,
        repo: &RepoRef,
        asset: &ReleaseAsset,
        max_bytes: u64,
    ) -> Result<Vec<u8>, AppError> {
        if asset.size > max_bytes {
            return Err(AppError::Invalid(format!(
                "{} is {} bytes, over the {max_bytes} byte limit",
                asset.name, asset.size
            )));
        }

        let url = format!(
            "{API_ROOT}/repos/{}/{}/releases/assets/{}",
            repo.owner, repo.name, asset.id
        );
        let response = self
            .request(reqwest::Method::GET, &url)
            .header("Accept", "application/octet-stream")
            .send()
            .await
            .map_err(|e| {
                AppError::Unavailable(format!("could not download {}: {e}", asset.name))
            })?;

        let response = check_status(response, repo).await?;
        read_capped(response, &asset.name, max_bytes).await
    }
}

/// Build a plain HTTP client with the same TLS setup as the GitHub client.
///
/// Exists so non-GitHub downloads (currently the embedding model) cannot skip
/// `install_crypto_provider`, whose absence makes reqwest *panic* rather than
/// return an error.
pub fn http_client() -> Result<reqwest::Client, AppError> {
    install_crypto_provider();
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| AppError::Unavailable(format!("could not create HTTP client: {e}")))
}

/// GET a URL, refusing to buffer more than `max_bytes`.
///
/// Shares the streaming cap with release-asset downloads rather than
/// reimplementing it, so there is one place where "how much will we hold in
/// memory for a remote file" is decided.
pub async fn download_capped(
    client: &reqwest::Client,
    url: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, AppError> {
    let label = url.rsplit('/').next().unwrap_or(url).to_string();
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::Unavailable(format!("could not download {label}: {e}")))?;

    if !response.status().is_success() {
        return Err(AppError::Unavailable(format!(
            "download of {label} failed: HTTP {}",
            response.status()
        )));
    }

    read_capped(response, &label, max_bytes).await
}

/// Stream a response body, refusing to grow past `max_bytes`.
///
/// The cap is applied per chunk rather than to a declared `Content-Length`,
/// because that header is supplied by the remote and a post-hoc check would
/// only run once the bytes were already resident.
async fn read_capped(
    mut response: reqwest::Response,
    label: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, AppError> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| AppError::Unavailable(format!("download of {label} failed: {e}")))?
    {
        if body.len() as u64 + chunk.len() as u64 > max_bytes {
            return Err(AppError::Invalid(format!(
                "{label} exceeded the {max_bytes} byte limit mid-download"
            )));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Turn an HTTP status into an error a user can act on.
///
/// 404 is treated as "not found *or* not visible to you", because GitHub
/// deliberately returns 404 rather than 403 for private resources the caller
/// cannot see - reporting "forbidden" would confirm the repo exists, which is
/// the disclosure GitHub is avoiding.
async fn check_status(
    response: reqwest::Response,
    repo: &RepoRef,
) -> Result<reqwest::Response, AppError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }

    // Rate limiting is common enough on unauthenticated requests to deserve
    // its own message; "not found" would send the user chasing a typo.
    let rate_limited = status.as_u16() == 403
        && response
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|v| v.to_str().ok())
            == Some("0");

    Err(match status.as_u16() {
        404 => AppError::NotFound(format!(
            "{} was not found, or you do not have access to it. Private extensions need a GitHub token with access to that repository.",
            repo.slug()
        )),
        401 => AppError::Denied(
            "GitHub rejected the token. It may have expired or lack repository access.".into(),
        ),
        _ if rate_limited => AppError::Unavailable(
            "GitHub's rate limit was reached. Adding a GitHub token raises it substantially."
                .into(),
        ),
        _ => AppError::Unavailable(format!("GitHub returned {status} for {}", repo.slug())),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_plain_owner_repo() {
        let r = RepoRef::parse("darylcecile/writer-plus").unwrap();
        assert_eq!(r.owner, "darylcecile");
        assert_eq!(r.name, "writer-plus");
    }

    #[test]
    fn accepts_the_url_a_user_would_paste_from_a_browser() {
        for input in [
            "https://github.com/darylcecile/writer-plus",
            "http://github.com/darylcecile/writer-plus",
            "github.com/darylcecile/writer-plus",
            "https://github.com/darylcecile/writer-plus.git",
            "  darylcecile/writer-plus  ",
        ] {
            assert_eq!(
                RepoRef::parse(input).unwrap().slug(),
                "darylcecile/writer-plus",
                "failed for {input:?}"
            );
        }
    }

    #[test]
    fn rejects_path_traversal_in_a_repo_reference() {
        // This is the reason parsing is strict. `owner` and `name` are
        // interpolated into an API URL path; a segment containing a slash or
        // `..` could address a repository other than the one the consent
        // dialog showed the user.
        for input in [
            "../../etc/passwd",
            "owner/../other",
            "owner/repo/extra",
            "../..",
            "owner/",
            "/repo",
            "owner",
            "",
        ] {
            assert!(
                RepoRef::parse(input).is_err(),
                "should have rejected {input:?}"
            );
        }
    }

    #[test]
    fn rejects_segments_with_url_metacharacters() {
        for input in [
            "own er/repo",
            "owner/re?po",
            "owner/re#po",
            "owner/re%2fpo",
            "owner/repo@main",
        ] {
            assert!(
                RepoRef::parse(input).is_err(),
                "should have rejected {input:?}"
            );
        }
    }

    #[test]
    fn finds_a_named_asset() {
        let release = Release {
            tag_name: "v1.0.0".into(),
            draft: false,
            prerelease: false,
            assets: vec![
                ReleaseAsset {
                    id: 1,
                    name: "manifest.json".into(),
                    size: 10,
                },
                ReleaseAsset {
                    id: 2,
                    name: "extension.js".into(),
                    size: 20,
                },
            ],
        };
        assert_eq!(release.asset("extension.js").unwrap().id, 2);
        assert!(release.asset("nope.js").is_none());
    }

    #[test]
    fn client_builds_with_the_configured_tls_provider() {
        // reqwest is built with `rustls-no-provider`, and it *panics* rather
        // than erroring when no provider is installed - so a missing
        // `install_crypto_provider` would crash the app at first install
        // rather than surface a message. This test caught exactly that.
        assert!(GitHubClient::new(None).is_ok());
    }

    #[test]
    fn installing_the_crypto_provider_twice_is_harmless() {
        // Two concurrent installs are entirely plausible - a scheduled update
        // check and a user-initiated install - and the second must not abort.
        install_crypto_provider();
        install_crypto_provider();
        assert!(GitHubClient::new(Some("t".into())).is_ok());
    }
}

#[cfg(test)]
mod live_tests {
    //! Real network calls, so `#[ignore]`d by default. Run with:
    //! `cargo test --lib live_ -- --ignored --nocapture`
    //!
    //! These exist because everything above is shape-checking. Whether TLS
    //! actually negotiates, whether GitHub accepts our headers, and whether the
    //! response deserializes into `Release` are facts only a live call settles.

    use super::*;

    #[tokio::test]
    #[ignore = "requires network"]
    async fn live_fetches_a_real_public_release() {
        let client = GitHubClient::new(std::env::var("GITHUB_TOKEN").ok()).unwrap();
        let repo = RepoRef::parse("BurntSushi/ripgrep").unwrap();
        let release = client.latest_release(&repo).await.unwrap();
        assert!(!release.tag_name.is_empty());
        assert!(!release.draft && !release.prerelease);
        assert!(!release.assets.is_empty());
        println!(
            "ripgrep latest: {} ({} assets)",
            release.tag_name,
            release.assets.len()
        );
    }

    #[tokio::test]
    #[ignore = "requires network"]
    async fn live_reports_a_missing_repo_as_not_found() {
        let client = GitHubClient::new(std::env::var("GITHUB_TOKEN").ok()).unwrap();
        let repo = RepoRef::parse("darylcecile/definitely-not-a-real-repo-xyzzy").unwrap();
        let err = client.latest_release(&repo).await.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
        println!("404 message: {err}");
    }

    #[tokio::test]
    #[ignore = "requires network"]
    async fn live_downloads_an_asset_and_enforces_the_size_cap() {
        let client = GitHubClient::new(std::env::var("GITHUB_TOKEN").ok()).unwrap();
        let repo = RepoRef::parse("BurntSushi/ripgrep").unwrap();
        let release = client.latest_release(&repo).await.unwrap();
        let asset = release.assets.iter().min_by_key(|a| a.size).unwrap();

        // The declared size is attacker-controlled, so the cap must be checked
        // before any bytes are pulled.
        let err = client.download_asset(&repo, asset, 1).await.unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)), "got {err:?}");

        let bytes = client
            .download_asset(&repo, asset, asset.size + 1)
            .await
            .unwrap();
        assert_eq!(bytes.len() as u64, asset.size);
        println!("downloaded {} ({} bytes)", asset.name, bytes.len());
    }
}

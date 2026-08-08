//! GitHub credential storage for private-repo installs.
//!
//! The token lives in the OS keychain rather than in settings JSON or in the
//! frontend. Two reasons, and the second is the one that matters:
//!
//! 1. Settings files are synced, backed up, and pasted into bug reports. A PAT
//!    that can read private repositories does not belong in one.
//! 2. If the frontend held the token and passed it on every install, the secret
//!    would sit in JS memory and cross the IPC boundary on every call - inside a
//!    WebView that also runs extension UI code. Keeping it in Rust means the
//!    only thing that ever holds the token is the process that talks to
//!    api.github.com.
//!
//! The frontend can therefore save and clear the token, and ask *whether* one is
//! stored, but can never read it back.

use crate::error::AppError;

const SERVICE: &str = "app.writer.extensions";
const ACCOUNT: &str = "github";

fn entry() -> Result<keyring::Entry, AppError> {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|e| AppError::Unavailable(format!("keychain unavailable: {e}")))
}

/// Store a GitHub token, replacing any existing one.
pub fn store(token: &str) -> Result<(), AppError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(AppError::Invalid("token is empty".into()));
    }
    entry()?
        .set_password(token)
        .map_err(|e| AppError::Unavailable(format!("could not save token: {e}")))
}

/// The stored token, if any.
///
/// A missing entry is `Ok(None)`, not an error: having no token is the normal
/// state for a user who only installs public extensions.
pub fn load() -> Result<Option<String>, AppError> {
    match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Unavailable(format!("could not read token: {e}"))),
    }
}

/// Forget the stored token. Deleting a token that isn't there succeeds, so that
/// "sign out" is idempotent and cannot fail in a way the user must act on.
pub fn clear() -> Result<(), AppError> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Unavailable(format!("could not clear token: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_token_is_rejected_before_it_reaches_the_keychain() {
        // Saving "" would otherwise look like success while leaving the user
        // unable to install anything private, with nothing to point at.
        assert!(store("   ").is_err());
        assert!(store("").is_err());
    }

    /// Exercises the real keychain. Ignored by default because on macOS it can
    /// raise a system authorisation prompt in an unconfigured environment, which
    /// would hang CI.
    #[test]
    #[ignore = "touches the real OS keychain"]
    fn round_trips_through_the_os_keychain() {
        clear().unwrap();
        assert_eq!(load().unwrap(), None, "must start clean");

        store("ghp_example_token").unwrap();
        assert_eq!(load().unwrap().as_deref(), Some("ghp_example_token"));

        // Storing again must replace rather than duplicate or fail.
        store("ghp_second").unwrap();
        assert_eq!(load().unwrap().as_deref(), Some("ghp_second"));

        clear().unwrap();
        assert_eq!(load().unwrap(), None);

        // Clearing twice must not error - "sign out" has to be idempotent.
        clear().unwrap();
    }
}

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("IO error: {0}")]
    Io(String),
    #[error("Invalid: {0}")]
    Invalid(String),
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Already exists: {0}")]
    AlreadyExists(String),
    #[error("No workspace is open")]
    NoWorkspace,
    #[error("Database error: {0}")]
    Database(String),
    #[error("denied: {0}")]
    Denied(String),
    /// A runtime-tier permission has no decision yet. The frontend must ask the
    /// user and retry.
    ///
    /// Deliberately distinct from [`AppError::Denied`]: "ask the user" and "the
    /// user said no" must never be confused, or a refusal would re-prompt
    /// forever and an unanswered prompt would look like a refusal.
    ///
    /// The payload is the permission key, which the frontend passes to
    /// `extension_permission_detail` to get Writer's own wording. Errors
    /// serialize as plain strings, so the prefix here is load-bearing and is
    /// asserted by a test.
    #[error("needs-approval: {0}")]
    NeedsApproval(String),
    #[error("unavailable: {0}")]
    Unavailable(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::Io(err.to_string())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        AppError::Database(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Errors cross into JavaScript as plain strings, so these prefixes are the
    /// only thing the host has to tell one failure from another. Changing one
    /// silently turns a permission prompt into a generic failure, which is why
    /// they are pinned here rather than left as incidental wording.
    #[test]
    fn the_prefixes_the_host_matches_on_are_stable() {
        let json = |err: AppError| serde_json::to_string(&err).unwrap();

        assert_eq!(
            json(AppError::NeedsApproval("workspace.write".into())),
            "\"needs-approval: workspace.write\""
        );
        assert_eq!(json(AppError::Denied("nope".into())), "\"denied: nope\"");
    }

    /// "Ask the user" and "the user said no" must not be confused: mistaking a
    /// refusal for an unanswered prompt re-asks forever, and mistaking an
    /// unanswered prompt for a refusal means the user is never asked at all.
    #[test]
    fn needing_approval_does_not_read_as_a_denial() {
        let needs = AppError::NeedsApproval("workspace.write".into()).to_string();
        assert!(!needs.starts_with("denied:"));
    }
}

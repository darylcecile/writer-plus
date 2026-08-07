use super::manifest::{CapabilityGrant, ExtensionManifest};
use crate::error::AppError;
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Copy)]
pub(crate) enum PathResolution {
    MustExist,
    MayCreate,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedWorkspacePath {
    pub path: PathBuf,
    pub relative_path: String,
}

#[derive(Default)]
pub struct PermissionGate;

impl PermissionGate {
    pub fn check(
        &self,
        manifest: &ExtensionManifest,
        workspace_root: &Path,
        capability: &str,
        method: &str,
        args: &[Value],
    ) -> Result<(), AppError> {
        match capability {
            "fs" => self.check_fs(manifest, workspace_root, method, args),
            "semantic" => self.check_semantic(manifest, workspace_root, method, args),
            "ai" => self.check_ai(manifest, method),
            "storage" => self.check_storage(manifest, method),
            "network" => self.check_network(manifest, method, args),
            _ => deny(format!("unknown capability {capability:?}")),
        }
    }

    fn check_fs(
        &self,
        manifest: &ExtensionManifest,
        workspace_root: &Path,
        method: &str,
        args: &[Value],
    ) -> Result<(), AppError> {
        let (write, resolution) = match method {
            "readFile" | "listFiles" => (false, PathResolution::MustExist),
            "writeFile" => (true, PathResolution::MayCreate),
            _ => return deny(format!("unknown fs method {method:?}")),
        };
        let path = string_arg(args, 0, "path")?;
        let resolved = resolve_workspace_path(workspace_root, path, resolution)?;
        if fs_prefix_granted(manifest, write, &resolved.relative_path) {
            Ok(())
        } else {
            deny(format!(
                "fs.{} is not granted for {}",
                method, resolved.relative_path
            ))
        }
    }

    fn check_semantic(
        &self,
        manifest: &ExtensionManifest,
        workspace_root: &Path,
        method: &str,
        args: &[Value],
    ) -> Result<(), AppError> {
        match method {
            "search" => {
                if semantic_granted(manifest, |search, _index| search) {
                    Ok(())
                } else {
                    deny("semantic.search was not granted")
                }
            }
            "indexNote" => {
                if !semantic_granted(manifest, |_search, index| index) {
                    return deny("semantic.indexNote was not granted");
                }
                let path = string_arg(args, 0, "path")?;
                resolve_workspace_path(workspace_root, path, PathResolution::MustExist)?;
                Ok(())
            }
            "status" => {
                if semantic_granted(manifest, |search, index| search || index) {
                    Ok(())
                } else {
                    deny("semantic.status was not granted")
                }
            }
            _ => deny(format!("unknown semantic method {method:?}")),
        }
    }

    fn check_ai(&self, manifest: &ExtensionManifest, method: &str) -> Result<(), AppError> {
        match method {
            "chat" => {
                if manifest
                    .permissions
                    .capabilities
                    .iter()
                    .any(|grant| matches!(grant, CapabilityGrant::Ai { chat: true }))
                {
                    Ok(())
                } else {
                    deny("ai.chat was not granted")
                }
            }
            _ => deny(format!("unknown ai method {method:?}")),
        }
    }

    fn check_storage(&self, manifest: &ExtensionManifest, method: &str) -> Result<(), AppError> {
        let storage = manifest
            .permissions
            .capabilities
            .iter()
            .find_map(|grant| match grant {
                CapabilityGrant::Storage { shared } => Some(*shared),
                _ => None,
            });

        match method {
            "get" | "set" => {
                if storage.is_some() {
                    Ok(())
                } else {
                    deny("storage was not granted")
                }
            }
            "getShared" | "setShared" => {
                if storage == Some(true) {
                    Ok(())
                } else {
                    deny("storage.shared was not granted")
                }
            }
            _ => deny(format!("unknown storage method {method:?}")),
        }
    }

    fn check_network(
        &self,
        manifest: &ExtensionManifest,
        method: &str,
        args: &[Value],
    ) -> Result<(), AppError> {
        if method != "fetch" {
            return deny(format!("unknown network method {method:?}"));
        }
        let url = string_arg(args, 0, "url")?;
        let host = parse_url_host(url)
            .ok_or_else(|| AppError::Denied("network.fetch URL has no host".into()))?;
        let granted = manifest
            .permissions
            .capabilities
            .iter()
            .any(|grant| match grant {
                CapabilityGrant::Network { hosts } => hosts
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(host)),
                _ => false,
            });
        if granted {
            Ok(())
        } else {
            deny(format!("network host {host:?} was not granted"))
        }
    }
}

pub(crate) fn resolve_workspace_path(
    workspace_root: &Path,
    requested_path: &str,
    resolution: PathResolution,
) -> Result<ResolvedWorkspacePath, AppError> {
    let root = workspace_root
        .canonicalize()
        .map_err(|err| AppError::Io(format!("workspace root is not accessible: {err}")))?;
    let resolved = resolve_against_root(&root, Path::new(requested_path), resolution)?;
    if !resolved.starts_with(&root) {
        return deny(format!("path {requested_path:?} is outside the workspace"));
    }
    let relative_path = resolved
        .strip_prefix(&root)
        .map_err(|_| AppError::Denied(format!("path {requested_path:?} is outside the workspace")))?
        .to_string_lossy()
        .replace('\\', "/");
    Ok(ResolvedWorkspacePath {
        path: resolved,
        relative_path,
    })
}

fn resolve_against_root(
    root: &Path,
    requested_path: &Path,
    resolution: PathResolution,
) -> Result<PathBuf, AppError> {
    let mut cursor = if requested_path.is_absolute() {
        PathBuf::new()
    } else {
        root.to_path_buf()
    };
    let mut missing = PathBuf::new();
    let mut has_missing = false;

    for component in requested_path.components() {
        match component {
            Component::Prefix(prefix) => {
                cursor = PathBuf::from(prefix.as_os_str());
                missing.clear();
                has_missing = false;
            }
            Component::RootDir => {
                cursor = PathBuf::from(component.as_os_str());
                missing.clear();
                has_missing = false;
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if has_missing && missing.pop() {
                    has_missing = missing.components().next().is_some();
                } else {
                    cursor.pop();
                    if !has_missing {
                        if let Ok(canonical) = cursor.canonicalize() {
                            cursor = canonical;
                        }
                    }
                }
            }
            Component::Normal(part) => {
                if has_missing {
                    missing.push(part);
                    continue;
                }

                let next = cursor.join(part);
                match next.canonicalize() {
                    Ok(canonical) => cursor = canonical,
                    Err(err) => match resolution {
                        PathResolution::MustExist => {
                            return Err(AppError::Denied(format!(
                                "path {} is not accessible: {err}",
                                requested_path.display()
                            )));
                        }
                        PathResolution::MayCreate => {
                            has_missing = true;
                            missing.push(part);
                        }
                    },
                }
            }
        }
    }

    if has_missing {
        Ok(cursor.join(missing))
    } else {
        Ok(cursor)
    }
}

fn string_arg<'a>(args: &'a [Value], index: usize, label: &str) -> Result<&'a str, AppError> {
    args.get(index)
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Denied(format!("missing or invalid {label} argument")))
}

fn fs_prefix_granted(manifest: &ExtensionManifest, write: bool, relative_path: &str) -> bool {
    manifest.permissions.capabilities.iter().any(|grant| {
        let CapabilityGrant::Fs {
            read,
            write: writes,
        } = grant
        else {
            return false;
        };
        let prefixes = if write { writes } else { read };
        prefixes
            .iter()
            .any(|prefix| permission_pattern_matches(prefix, relative_path))
    })
}

fn semantic_granted(manifest: &ExtensionManifest, predicate: impl Fn(bool, bool) -> bool) -> bool {
    manifest
        .permissions
        .capabilities
        .iter()
        .any(|grant| match grant {
            CapabilityGrant::Semantic { search, index } => predicate(*search, *index),
            _ => false,
        })
}

fn permission_pattern_matches(pattern: &str, relative_path: &str) -> bool {
    let pattern = normalize_pattern(pattern);
    if pattern == "**" || pattern == "**/*" {
        return true;
    }
    let relative_path = relative_path.trim_matches('/');
    if !pattern.contains('*') && !pattern.contains('?') {
        return relative_path == pattern
            || relative_path
                .strip_prefix(&pattern)
                .is_some_and(|rest| rest.starts_with('/'));
    }
    let pattern_segments: Vec<_> = pattern
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let path_segments: Vec<_> = relative_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    glob_segments_match(&pattern_segments, &path_segments)
}

fn normalize_pattern(pattern: &str) -> String {
    let mut pattern = pattern.trim().replace('\\', "/");
    while let Some(stripped) = pattern.strip_prefix("./") {
        pattern = stripped.to_string();
    }
    pattern.trim_matches('/').to_string()
}

fn glob_segments_match(pattern: &[&str], path: &[&str]) -> bool {
    if pattern.is_empty() {
        return path.is_empty();
    }
    if pattern[0] == "**" {
        return glob_segments_match(&pattern[1..], path)
            || (!path.is_empty() && glob_segments_match(pattern, &path[1..]));
    }
    !path.is_empty()
        && glob_segment_match(pattern[0], path[0])
        && glob_segments_match(&pattern[1..], &path[1..])
}

fn glob_segment_match(pattern: &str, text: &str) -> bool {
    fn inner(pattern: &[char], text: &[char]) -> bool {
        match pattern.split_first() {
            None => text.is_empty(),
            Some(('*', rest)) => {
                inner(rest, text) || (!text.is_empty() && inner(pattern, &text[1..]))
            }
            Some(('?', rest)) => !text.is_empty() && inner(rest, &text[1..]),
            Some((expected, rest)) => text.first() == Some(expected) && inner(rest, &text[1..]),
        }
    }
    inner(
        &pattern.chars().collect::<Vec<_>>(),
        &text.chars().collect::<Vec<_>>(),
    )
}

fn parse_url_host(url: &str) -> Option<&str> {
    let (_, after_scheme) = url.split_once("://")?;
    let end = after_scheme
        .find(['/', ':', '?', '#'])
        .unwrap_or(after_scheme.len());
    let host = &after_scheme[..end];
    (!host.is_empty()).then_some(host)
}

fn deny<T>(message: impl Into<String>) -> Result<T, AppError> {
    Err(AppError::Denied(message.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::manifest::{CommandDecl, CommandMode, Permissions};
    use serde_json::json;
    use std::fs;
    use tempfile::{Builder, TempDir};

    fn temp_dir() -> TempDir {
        let base = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("extensions-tests");
        fs::create_dir_all(&base).unwrap();
        Builder::new()
            .prefix("permissions-")
            .tempdir_in(base)
            .unwrap()
    }

    fn manifest(capabilities: Vec<CapabilityGrant>) -> ExtensionManifest {
        ExtensionManifest {
            id: "test-extension".to_string(),
            name: "Test".to_string(),
            version: "1.0.0".to_string(),
            description: "Test extension".to_string(),
            author: "Writer".to_string(),
            commands: vec![CommandDecl {
                name: "open".to_string(),
                title: "Open".to_string(),
                mode: CommandMode::View,
            }],
            permissions: Permissions {
                capabilities,
                uses_services: Vec::new(),
                provides_services: Vec::new(),
            },
        }
    }

    fn fs_manifest(read: Vec<&str>, write: Vec<&str>) -> ExtensionManifest {
        manifest(vec![CapabilityGrant::Fs {
            read: read.into_iter().map(str::to_string).collect(),
            write: write.into_iter().map(str::to_string).collect(),
        }])
    }

    #[test]
    fn denied_errors_start_with_required_prefix() {
        let dir = temp_dir();
        let gate = PermissionGate;
        let err = gate
            .check(&manifest(Vec::new()), dir.path(), "unknown", "method", &[])
            .unwrap_err();

        assert!(err.to_string().starts_with("denied: "));
    }

    #[test]
    fn unknown_capability_is_denied() {
        let dir = temp_dir();
        let gate = PermissionGate;
        let err = gate
            .check(
                &fs_manifest(vec!["**"], vec![]),
                dir.path(),
                "shell",
                "run",
                &[],
            )
            .unwrap_err();

        assert!(err.to_string().starts_with("denied: "));
    }

    #[test]
    fn unknown_method_is_denied() {
        let dir = temp_dir();
        let gate = PermissionGate;
        let err = gate
            .check(
                &fs_manifest(vec!["**"], vec![]),
                dir.path(),
                "fs",
                "deleteFile",
                &[json!("note.md")],
            )
            .unwrap_err();

        assert!(err.to_string().contains("unknown fs method"));
    }

    #[test]
    fn missing_grant_is_denied() {
        let dir = temp_dir();
        fs::write(dir.path().join("note.md"), "note").unwrap();
        let gate = PermissionGate;
        let err = gate
            .check(
                &manifest(Vec::new()),
                dir.path(),
                "fs",
                "readFile",
                &[json!("note.md")],
            )
            .unwrap_err();

        assert!(err.to_string().contains("not granted"));
    }

    #[test]
    fn allows_read_inside_workspace_matching_grant() {
        let dir = temp_dir();
        fs::create_dir(dir.path().join("notes")).unwrap();
        fs::write(dir.path().join("notes").join("note.md"), "note").unwrap();
        let gate = PermissionGate;

        gate.check(
            &fs_manifest(vec!["notes/**"], vec![]),
            dir.path(),
            "fs",
            "readFile",
            &[json!("notes/note.md")],
        )
        .unwrap();
    }

    #[test]
    fn denies_path_outside_grant_even_inside_workspace() {
        let dir = temp_dir();
        fs::create_dir(dir.path().join("private")).unwrap();
        fs::write(dir.path().join("private").join("secret.md"), "secret").unwrap();
        let gate = PermissionGate;
        let err = gate
            .check(
                &fs_manifest(vec!["notes/**"], vec![]),
                dir.path(),
                "fs",
                "readFile",
                &[json!("private/secret.md")],
            )
            .unwrap_err();

        assert!(err.to_string().contains("not granted"));
    }

    #[test]
    fn denies_parent_traversal_outside_workspace() {
        let base = temp_dir();
        let workspace = base.path().join("workspace");
        let outside = base.path().join("outside");
        fs::create_dir(&workspace).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.md"), "secret").unwrap();
        let gate = PermissionGate;
        let err = gate
            .check(
                &fs_manifest(vec!["**"], vec![]),
                &workspace,
                "fs",
                "readFile",
                &[json!("../outside/secret.md")],
            )
            .unwrap_err();

        assert!(err.to_string().contains("outside the workspace"));
    }

    #[test]
    fn denies_absolute_path_outside_workspace() {
        let base = temp_dir();
        let workspace = base.path().join("workspace");
        let outside = base.path().join("outside");
        fs::create_dir(&workspace).unwrap();
        fs::create_dir(&outside).unwrap();
        let secret = outside.join("secret.md");
        fs::write(&secret, "secret").unwrap();
        let gate = PermissionGate;
        let err = gate
            .check(
                &fs_manifest(vec!["**"], vec![]),
                &workspace,
                "fs",
                "readFile",
                &[json!(secret.to_string_lossy())],
            )
            .unwrap_err();

        assert!(err.to_string().contains("outside the workspace"));
    }

    #[cfg(unix)]
    #[test]
    fn denies_symlink_escape_outside_workspace() {
        use std::os::unix::fs::symlink;

        let base = temp_dir();
        let workspace = base.path().join("workspace");
        let outside = base.path().join("outside");
        fs::create_dir(&workspace).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.md"), "secret").unwrap();
        symlink(&outside, workspace.join("link")).unwrap();
        let gate = PermissionGate;
        let err = gate
            .check(
                &fs_manifest(vec!["**"], vec![]),
                &workspace,
                "fs",
                "readFile",
                &[json!("link/secret.md")],
            )
            .unwrap_err();

        assert!(err.to_string().contains("outside the workspace"));
    }

    #[test]
    fn denies_prefix_string_sibling_workspace_escape() {
        let base = temp_dir();
        let workspace = base.path().join("notes");
        let sibling = base.path().join("notes-secret");
        fs::create_dir(&workspace).unwrap();
        fs::create_dir(&sibling).unwrap();
        let secret = sibling.join("x.md");
        fs::write(&secret, "secret").unwrap();
        let gate = PermissionGate;
        let err = gate
            .check(
                &fs_manifest(vec!["**"], vec![]),
                &workspace,
                "fs",
                "readFile",
                &[json!(secret.to_string_lossy())],
            )
            .unwrap_err();

        assert!(err.to_string().contains("outside the workspace"));
    }

    #[test]
    fn allows_write_to_new_file_in_valid_directory() {
        let dir = temp_dir();
        fs::create_dir(dir.path().join("notes")).unwrap();
        let gate = PermissionGate;

        gate.check(
            &fs_manifest(vec![], vec!["notes/**"]),
            dir.path(),
            "fs",
            "writeFile",
            &[json!("notes/new.md"), json!("new note")],
        )
        .unwrap();
    }

    #[test]
    fn semantic_index_note_path_must_stay_inside_workspace() {
        let base = temp_dir();
        let workspace = base.path().join("workspace");
        let outside = base.path().join("outside");
        fs::create_dir(&workspace).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.md"), "secret").unwrap();
        let gate = PermissionGate;
        let err = gate
            .check(
                &manifest(vec![CapabilityGrant::Semantic {
                    search: false,
                    index: true,
                }]),
                &workspace,
                "semantic",
                "indexNote",
                &[json!("../outside/secret.md")],
            )
            .unwrap_err();

        assert!(err.to_string().contains("outside the workspace"));
    }
}

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Component, Path};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    #[serde(default)]
    pub commands: Vec<CommandDecl>,
    pub permissions: Permissions,
    #[serde(default)]
    pub preferences: Vec<PreferenceDecl>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandDecl {
    pub name: String,
    pub title: String,
    pub mode: CommandMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommandMode {
    View,
    NoView,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreferenceDecl {
    pub name: String,
    pub title: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Value,
    #[serde(default)]
    pub options: Vec<Value>,
    #[serde(default)]
    pub data: Vec<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Permissions {
    #[serde(default)]
    pub capabilities: Vec<CapabilityGrant>,
    #[serde(default, alias = "usesServices")]
    pub uses_services: Vec<String>,
    #[serde(default, alias = "providesServices")]
    pub provides_services: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "name", rename_all = "camelCase")]
pub enum CapabilityGrant {
    Workspace {
        #[serde(default)]
        read: Vec<String>,
        #[serde(default)]
        write: Vec<String>,
    },
    Embeddings {
        #[serde(default)]
        query: bool,
        #[serde(default)]
        write: bool,
    },
    Storage {
        #[serde(default)]
        shared: bool,
    },
    Network {
        #[serde(default)]
        hosts: Vec<String>,
    },
    Clipboard {
        #[serde(default)]
        read: bool,
        #[serde(default)]
        write: bool,
    },
    /// Escape hatch: run with the app's own privileges.
    ///
    /// This is the one grant that leaves the permission sandbox. It exists
    /// because some integrations genuinely cannot be expressed as a gated
    /// capability - driving an external agent process over stdio, for example -
    /// and the honest answer is to say so rather than to dress an unsandboxed
    /// feature up as a narrow permission.
    ///
    /// Everything a sandboxed extension does is mediated: paths are contained,
    /// hosts are allowlisted, capabilities are checked per call. An `unsafe`
    /// extension gets none of that. It can spawn processes and talk to anything
    /// on the machine, exactly like the app itself.
    ///
    /// `reason` is mandatory and is shown verbatim in the consent dialog, so an
    /// extension cannot request this silently or without explanation.
    Unsafe { reason: String },
}

impl CapabilityGrant {
    /// Whether this grant leaves the permission sandbox.
    pub fn is_unsafe(&self) -> bool {
        matches!(self, CapabilityGrant::Unsafe { .. })
    }
}

impl ExtensionManifest {
    pub fn validate(&self) -> Result<(), AppError> {
        if self.id.is_empty() {
            return Err(invalid("manifest id must not be empty"));
        }
        if !is_valid_id(&self.id) {
            return Err(invalid(format!(
                "manifest id {:?} must match ^[a-z0-9][a-z0-9._-]*$",
                self.id
            )));
        }

        for capability in &self.permissions.capabilities {
            match capability {
                CapabilityGrant::Workspace { read, write } => {
                    for prefix in read.iter().chain(write.iter()) {
                        validate_workspace_pattern(prefix)?;
                    }
                }
                CapabilityGrant::Network { hosts } => {
                    if hosts.iter().any(|host| host.trim() == "*") {
                        return Err(invalid("network host '*' is not allowed"));
                    }
                }
                CapabilityGrant::Unsafe { reason } => {
                    // The consent dialog shows this verbatim, so a blank or
                    // token reason would let an extension request the strongest
                    // grant in the system without telling the user anything.
                    if reason.trim().len() < 12 {
                        return Err(invalid(
                            "unsafe capability requires a reason explaining why the extension \
                             needs to run outside the sandbox",
                        ));
                    }
                }
                CapabilityGrant::Embeddings { .. }
                | CapabilityGrant::Storage { .. }
                | CapabilityGrant::Clipboard { .. } => {}
            }
        }

        Ok(())
    }
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Invalid(message.into())
}

fn is_valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-'))
}

fn validate_workspace_pattern(prefix: &str) -> Result<(), AppError> {
    let path = Path::new(prefix);
    if path.is_absolute() {
        return Err(invalid(format!(
            "workspace permission pattern {:?} must be workspace-relative",
            prefix
        )));
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(invalid(format!(
            "workspace permission pattern {:?} must not contain '..'",
            prefix
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn manifest_with_id(id: &str) -> ExtensionManifest {
        ExtensionManifest {
            id: id.to_string(),
            name: "Test".to_string(),
            version: "1.0.0".to_string(),
            description: "Test extension".to_string(),
            author: "Writer".to_string(),
            commands: vec![CommandDecl {
                name: "open".to_string(),
                title: "Open".to_string(),
                mode: CommandMode::View,
            }],
            permissions: Permissions::default(),
            preferences: Vec::new(),
        }
    }

    #[test]
    fn validate_rejects_empty_id() {
        let manifest = manifest_with_id("");
        assert!(manifest.validate().unwrap_err().to_string().contains("id"));
    }

    #[test]
    fn validate_rejects_id_that_does_not_match_pattern() {
        let manifest = manifest_with_id("Bad Id");
        assert!(manifest
            .validate()
            .unwrap_err()
            .to_string()
            .contains("must match"));
    }

    #[test]
    fn validate_rejects_absolute_fs_prefix() {
        let mut manifest = manifest_with_id("valid-id");
        manifest
            .permissions
            .capabilities
            .push(CapabilityGrant::Workspace {
                read: vec!["/Users/daryl/notes".to_string()],
                write: Vec::new(),
            });

        assert!(manifest
            .validate()
            .unwrap_err()
            .to_string()
            .contains("workspace-relative"));
    }

    #[test]
    fn validate_rejects_parent_segments_in_fs_prefix() {
        let mut manifest = manifest_with_id("valid-id");
        manifest
            .permissions
            .capabilities
            .push(CapabilityGrant::Workspace {
                read: vec!["../notes".to_string()],
                write: Vec::new(),
            });

        assert!(manifest
            .validate()
            .unwrap_err()
            .to_string()
            .contains("must not contain"));
    }

    #[test]
    fn validate_rejects_wildcard_network_host() {
        let mut manifest = manifest_with_id("valid-id");
        manifest
            .permissions
            .capabilities
            .push(CapabilityGrant::Network {
                hosts: vec!["*".to_string()],
            });

        assert!(manifest
            .validate()
            .unwrap_err()
            .to_string()
            .contains("network host '*'"));
    }

    #[test]
    fn real_core_extension_manifests_deserialize_and_validate() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        for relative in [
            "extensions/semantic-index/manifest.json",
            "extensions/ai-chat/manifest.json",
        ] {
            let path = root.join(relative);
            let content = fs::read_to_string(&path)
                .unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()));
            let manifest: ExtensionManifest = serde_json::from_str(&content)
                .unwrap_or_else(|err| panic!("failed to parse {}: {err}", path.display()));
            manifest
                .validate()
                .unwrap_or_else(|err| panic!("failed to validate {}: {err}", path.display()));
        }
    }
}

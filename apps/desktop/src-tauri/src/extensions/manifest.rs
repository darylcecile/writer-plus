use crate::error::AppError;
use serde::{Deserialize, Serialize};
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
    Fs {
        #[serde(default)]
        read: Vec<String>,
        #[serde(default)]
        write: Vec<String>,
    },
    Semantic {
        #[serde(default)]
        search: bool,
        #[serde(default)]
        index: bool,
    },
    Ai {
        #[serde(default)]
        chat: bool,
    },
    Storage {
        #[serde(default)]
        shared: bool,
    },
    Network {
        #[serde(default)]
        hosts: Vec<String>,
    },
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
                CapabilityGrant::Fs { read, write } => {
                    for prefix in read.iter().chain(write.iter()) {
                        validate_fs_prefix(prefix)?;
                    }
                }
                CapabilityGrant::Network { hosts } => {
                    if hosts.iter().any(|host| host.trim() == "*") {
                        return Err(invalid("network host '*' is not allowed"));
                    }
                }
                CapabilityGrant::Semantic { .. }
                | CapabilityGrant::Ai { .. }
                | CapabilityGrant::Storage { .. } => {}
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

fn validate_fs_prefix(prefix: &str) -> Result<(), AppError> {
    let path = Path::new(prefix);
    if path.is_absolute() {
        return Err(invalid(format!(
            "fs permission prefix {:?} must be workspace-relative",
            prefix
        )));
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(invalid(format!(
            "fs permission prefix {:?} must not contain '..'",
            prefix
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        manifest.permissions.capabilities.push(CapabilityGrant::Fs {
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
        manifest.permissions.capabilities.push(CapabilityGrant::Fs {
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
}

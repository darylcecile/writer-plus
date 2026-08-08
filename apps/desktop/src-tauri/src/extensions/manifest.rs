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
    /// Minimum Writer version this extension supports, checked at install.
    /// Optional because a local development extension has no reason to pin one.
    #[serde(default, alias = "minWriterVersion")]
    pub min_writer_version: Option<String>,
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

/// One capability, in the words shown to the user at install time.
///
/// Derived here rather than in the frontend on purpose. The consent dialog is
/// the only thing standing between a manifest and a grant, so the sentence a
/// user reads must come from the same module that enforces the grant - not
/// from a second, hand-maintained description that can drift out of step with
/// what Rust actually permits. It has drifted before.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDescription {
    /// Stable key, for React lists and for tests.
    pub key: String,
    /// Short phrase completing "This extension will be able to...".
    pub label: String,
    /// Writer's own explanation of what the capability means. Never supplied
    /// by the extension, so an extension cannot describe its own risk.
    pub detail: String,
    /// The extension's stated justification, verbatim. `None` when it gave one
    /// that was not required.
    pub reason: Option<String>,
    pub tier: PermissionTier,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionTier {
    /// Scope-checked at every call. Granted once, at install.
    Install,
    /// Scope-checked, but prompted on first use because the effect is
    /// destructive or irreversible.
    Runtime,
    /// Not scope-checked at all. See [`CapabilityGrant::Unsafe`].
    Unsafe,
}

impl CapabilityGrant {
    /// Whether this grant leaves the permission sandbox.
    pub fn is_unsafe(&self) -> bool {
        matches!(self, CapabilityGrant::Unsafe { .. })
    }

    pub fn describe(&self) -> PermissionDescription {
        match self {
            CapabilityGrant::Workspace { read, write } => {
                let scope = |globs: &[String]| {
                    if globs.iter().any(|g| g == "**" || g == "**/*") {
                        "every file in your workspace".to_string()
                    } else {
                        format!("files matching {}", globs.join(", "))
                    }
                };
                if write.is_empty() {
                    PermissionDescription {
                        key: "workspace.read".into(),
                        label: format!("Read {}", scope(read)),
                        detail: "Contents stay on your machine unless another permission sends them elsewhere.".into(),
                        reason: None,
                        tier: PermissionTier::Install,
                    }
                } else {
                    PermissionDescription {
                        key: "workspace.write".into(),
                        label: format!("Read and modify {}", scope(write)),
                        detail: "Changes are made directly to your notes and are not undoable from Writer's history.".into(),
                        reason: None,
                        tier: PermissionTier::Runtime,
                    }
                }
            }
            CapabilityGrant::Embeddings { query: _, write } => PermissionDescription {
                key: "embeddings".into(),
                label: if *write {
                    "Build and search the index of your notes".into()
                } else {
                    "Search the index of your notes".into()
                },
                detail: "The index is stored locally and holds text from your notes.".into(),
                reason: None,
                tier: PermissionTier::Install,
            },
            CapabilityGrant::Storage { shared } => PermissionDescription {
                key: "storage".into(),
                label: if *shared {
                    "Store data other extensions can read".into()
                } else {
                    "Store its own data".into()
                },
                detail: if *shared {
                    "Anything it puts in shared storage is visible to every extension that also uses shared storage.".into()
                } else {
                    "Private to this extension. No other extension can read it.".into()
                },
                reason: None,
                tier: PermissionTier::Install,
            },
            CapabilityGrant::Network { hosts } => {
                let unrestricted = hosts.is_empty() || hosts.iter().any(|h| h == "*");
                PermissionDescription {
                    key: "network".into(),
                    label: if unrestricted {
                        "Connect to any server on the internet".into()
                    } else {
                        format!("Connect to {}", hosts.join(", "))
                    },
                    detail: if unrestricted {
                        "Combined with reading your notes, this is enough to send them anywhere.".into()
                    } else {
                        "Connections to any other address are refused.".into()
                    },
                    reason: None,
                    // An unrestricted host list is the exfiltration path, so it
                    // is not something to grant silently at install.
                    tier: if unrestricted {
                        PermissionTier::Runtime
                    } else {
                        PermissionTier::Install
                    },
                }
            }
            CapabilityGrant::Clipboard { read, write } => PermissionDescription {
                key: "clipboard".into(),
                label: match (read, write) {
                    (true, true) => "Read and change your clipboard".into(),
                    (true, false) => "Read your clipboard".into(),
                    _ => "Change your clipboard".into(),
                },
                detail: if *read {
                    "Your clipboard may hold passwords or other text copied from any app.".into()
                } else {
                    "It can replace what you have copied.".into()
                },
                reason: None,
                tier: PermissionTier::Install,
            },
            CapabilityGrant::Unsafe { reason } => PermissionDescription {
                key: "unsafe".into(),
                label: "Run outside the sandbox".into(),
                detail: "This extension can start other programs on your computer. Those programs run with your full access, and Writer cannot restrict, inspect, or stop what they do.".into(),
                reason: Some(reason.clone()),
                tier: PermissionTier::Unsafe,
            },
        }
    }
}

impl ExtensionManifest {
    /// Every capability this manifest requests, in consent-dialog wording.
    pub fn describe_permissions(&self) -> Vec<PermissionDescription> {
        let mut described: Vec<PermissionDescription> = self
            .permissions
            .capabilities
            .iter()
            .map(CapabilityGrant::describe)
            .collect();

        for service in &self.permissions.uses_services {
            described.push(PermissionDescription {
                key: format!("services.uses.{service}"),
                label: format!("Use the {service} service from another extension"),
                detail:
                    "The other extension answers with its own permissions, never with this one's."
                        .into(),
                reason: None,
                tier: PermissionTier::Install,
            });
        }

        described
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
            min_writer_version: None,
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

#[cfg(test)]
mod description_tests {
    //! The consent surface is only as honest as these strings.
    //!
    //! A bug here does not throw; it quietly under-reports what an extension
    //! can do, which is the one failure the permission model cannot absorb -
    //! Rust will happily enforce a grant the user was never shown.

    use super::*;

    fn describe(grant: CapabilityGrant) -> PermissionDescription {
        grant.describe()
    }

    #[test]
    fn unsafe_sits_in_its_own_tier() {
        // Every other capability is scope-checked. Rendering `unsafe` at the
        // same tier would let a dialog present "runs arbitrary programs" with
        // the same visual weight as "read notes".
        let d = describe(CapabilityGrant::Unsafe {
            reason: "Starts the assistant you choose.".into(),
        });
        assert_eq!(d.tier, PermissionTier::Unsafe);

        let workspace = describe(CapabilityGrant::Workspace {
            read: vec!["**/*.md".into()],
            write: vec![],
        });
        assert_eq!(workspace.tier, PermissionTier::Install);
    }

    #[test]
    fn the_extensions_reason_is_passed_through_verbatim() {
        // The reason is the only thing distinguishing a legitimate request
        // from a pretextual one. Paraphrasing it would hide the tell.
        let reason = "Starts GitHub Copilot as a separate program on your computer.";
        let d = describe(CapabilityGrant::Unsafe {
            reason: reason.into(),
        });
        assert_eq!(d.reason.as_deref(), Some(reason));
    }

    #[test]
    fn the_risk_is_described_in_writers_words_not_the_extensions() {
        // An extension must not be able to author the explanation of its own
        // risk, or "unsafe" becomes whatever the author says it is.
        let d = describe(CapabilityGrant::Unsafe {
            reason: "Totally harmless, nothing to see here.".into(),
        });
        assert!(d.detail.contains("start other programs"), "{}", d.detail);
        assert!(d.detail.contains("Writer cannot restrict"), "{}", d.detail);
        assert!(!d.detail.contains("harmless"));
    }

    #[test]
    fn a_wildcard_read_is_not_described_as_a_glob() {
        // "files matching **" is technically accurate and completely useless
        // to someone deciding whether to trust an extension.
        let d = describe(CapabilityGrant::Workspace {
            read: vec!["**".into()],
            write: vec![],
        });
        assert!(d.label.contains("every file"), "{}", d.label);
    }

    #[test]
    fn unrestricted_network_is_a_runtime_prompt_not_a_silent_install_grant() {
        // Network plus read access is the exfiltration path; it should not be
        // obtainable by burying it in an install-time list.
        let open = describe(CapabilityGrant::Network { hosts: vec![] });
        assert_eq!(open.tier, PermissionTier::Runtime);
        assert!(
            open.detail.contains("send them anywhere"),
            "{}",
            open.detail
        );

        let scoped = describe(CapabilityGrant::Network {
            hosts: vec!["api.example.com".into()],
        });
        assert_eq!(scoped.tier, PermissionTier::Install);
        assert!(scoped.label.contains("api.example.com"));
    }

    #[test]
    fn write_access_is_described_and_tiered_separately_from_read() {
        let d = describe(CapabilityGrant::Workspace {
            read: vec!["**".into()],
            write: vec!["notes/**".into()],
        });
        assert_eq!(d.tier, PermissionTier::Runtime);
        assert!(d.label.contains("modify"), "{}", d.label);
    }

    #[test]
    fn shared_storage_says_who_else_can_read_it() {
        let shared = describe(CapabilityGrant::Storage { shared: true });
        assert!(
            shared.detail.contains("every extension"),
            "{}",
            shared.detail
        );
        let private = describe(CapabilityGrant::Storage { shared: false });
        assert!(
            private.detail.contains("No other extension"),
            "{}",
            private.detail
        );
    }

    #[test]
    fn a_service_dependency_is_shown_and_does_not_imply_borrowed_authority() {
        let mut m = manifest_with_id("test.ext");
        m.permissions.uses_services = vec!["search".into()];
        let described = m.describe_permissions();
        let service = described
            .iter()
            .find(|d| d.key == "services.uses.search")
            .expect("service dependency should be shown");
        assert!(
            service.detail.contains("its own permissions"),
            "{}",
            service.detail
        );
    }

    #[test]
    fn a_manifest_requesting_nothing_describes_nothing() {
        let m = manifest_with_id("test.ext");
        assert!(m.describe_permissions().is_empty());
    }

    #[test]
    fn the_shipped_ai_chat_manifest_describes_its_unsafe_grant() {
        // Guards the exact divergence that made this consolidation necessary:
        // a manifest that parses but whose permissions render as an empty list
        // would produce a consent dialog showing no permissions at all.
        let json = include_str!("../../../../../extensions/ai-chat/manifest.json");
        let m: ExtensionManifest = serde_json::from_str(json).expect("shipped manifest must parse");
        m.validate().expect("shipped manifest must validate");

        let described = m.describe_permissions();
        assert!(!described.is_empty(), "consent dialog would show nothing");
        assert!(
            described.iter().any(|d| d.tier == PermissionTier::Unsafe),
            "ai-chat must surface its unsafe grant"
        );
    }

    fn manifest_with_id(id: &str) -> ExtensionManifest {
        ExtensionManifest {
            id: id.into(),
            name: "Test".into(),
            version: "1.0.0".into(),
            description: "d".into(),
            author: "a".into(),
            min_writer_version: None,
            commands: vec![],
            permissions: Permissions::default(),
            preferences: vec![],
        }
    }
}

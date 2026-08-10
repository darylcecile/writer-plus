//! Install the first-party extensions shipped with the app.
//!
//! A core extension is bundled at build time (see
//! `apps/desktop/scripts/bundle-core-extensions.ts`) and shipped as a Tauri
//! resource. This module copies each shipped bundle into the user's extensions
//! directory on startup, so a fresh profile has the built-ins present on first
//! launch. Without it the registry is empty until the user installs something
//! by hand, and the two extensions the app "ships" are present only in the
//! source tree, never in a running build.
//!
//! Seeding is idempotent and version-aware. A shipped bundle is written only
//! when it is missing or strictly newer than what is installed, so an unchanged
//! launch writes nothing and an app upgrade that carries a newer core extension
//! replaces the old one in place. It runs once during init, before any
//! extension is spawned, so it never disturbs a panel the user has open.
//!
//! A user who uninstalls a core extension will see it return on the next
//! launch. That is deliberate for now: these are built-ins the rest of the app
//! depends on (the chat extension needs the index extension's search service),
//! and remembering per-extension uninstalls is a larger feature than this one.

use super::installer;
use super::manifest::ExtensionManifest;
use super::updates;
use crate::error::AppError;
use std::path::Path;

const BUNDLE_ASSET: &str = "extension.js";
const MANIFEST_ASSET: &str = "manifest.json";

/// Copy every shipped core extension under `resources_dir` that is missing or
/// out of date into `extensions_dir`.
///
/// Returns per-extension failures rather than aborting: one unreadable or
/// corrupt shipped bundle must not stop the others from seeding, the same way
/// one broken install does not stop the registry from loading the rest.
pub fn seed(resources_dir: &Path, extensions_dir: &Path) -> Vec<(String, AppError)> {
    let mut failures = Vec::new();

    let entries = match std::fs::read_dir(resources_dir) {
        Ok(entries) => entries,
        // No resources directory is the normal state for a dev build that has
        // not run the bundling step, and for tests. Nothing to seed - not an
        // error.
        Err(_) => return failures,
    };

    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        if let Err(err) = seed_one(&dir, extensions_dir) {
            let id = dir
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("<unknown>")
                .to_string();
            failures.push((id, err));
        }
    }

    failures
}

fn seed_one(shipped_dir: &Path, extensions_dir: &Path) -> Result<(), AppError> {
    let manifest_bytes = std::fs::read(shipped_dir.join(MANIFEST_ASSET))?;
    let shipped: ExtensionManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| AppError::Invalid(format!("shipped {MANIFEST_ASSET} is not valid: {e}")))?;

    if !should_seed(&shipped, extensions_dir) {
        return Ok(());
    }

    // Read the bundle only once we have decided to write it: the common case is
    // an unchanged launch, and a half-megabyte read per built-in on every start
    // is worth skipping.
    let bundle_bytes = std::fs::read(shipped_dir.join(BUNDLE_ASSET))?;
    installer::install_local(&manifest_bytes, &bundle_bytes, extensions_dir)?;
    eprintln!(
        "[extensions] seeded core extension {} v{}",
        shipped.id, shipped.version
    );
    Ok(())
}

/// Whether the shipped core extension should overwrite what is installed.
///
/// A missing install is seeded; an installed one is replaced only when the
/// shipped version is strictly newer. An installed version equal to or newer
/// than shipped is left alone, so a user is never downgraded and an unchanged
/// launch is a no-op. A corrupt installed manifest is replaced with the
/// known-good shipped one rather than left in place.
fn should_seed(shipped: &ExtensionManifest, extensions_dir: &Path) -> bool {
    // Installs are named by id on disk (see `installer::write_extension_atomically`).
    let installed_manifest = extensions_dir.join(&shipped.id).join(MANIFEST_ASSET);
    let Ok(bytes) = std::fs::read(&installed_manifest) else {
        return true;
    };
    match serde_json::from_slice::<ExtensionManifest>(&bytes) {
        Ok(installed) => updates::is_newer(&shipped.version, &installed.version),
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUNDLE: &[u8] = b"/* bundle */";

    fn manifest_json(id: &str, version: &str) -> String {
        format!(
            r#"{{
                "id": "{id}",
                "name": "Test",
                "version": "{version}",
                "description": "d",
                "author": "a",
                "commands": [],
                "permissions": {{ "capabilities": [], "usesServices": [], "providesServices": [] }}
            }}"#
        )
    }

    /// Writes a shipped resource directory `<root>/<id>/{manifest.json,extension.js}`.
    fn write_shipped(root: &Path, id: &str, version: &str) {
        let dir = root.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(MANIFEST_ASSET), manifest_json(id, version)).unwrap();
        std::fs::write(dir.join(BUNDLE_ASSET), BUNDLE).unwrap();
    }

    fn installed_version(extensions_dir: &Path, id: &str) -> Option<String> {
        let bytes = std::fs::read(extensions_dir.join(id).join(MANIFEST_ASSET)).ok()?;
        let m: ExtensionManifest = serde_json::from_slice(&bytes).ok()?;
        Some(m.version)
    }

    #[test]
    fn seeds_a_missing_core_extension() {
        let tmp = tempfile::tempdir().unwrap();
        let resources = tmp.path().join("resources");
        let installed = tmp.path().join("extensions");
        std::fs::create_dir_all(&installed).unwrap();
        write_shipped(&resources, "writer.test", "1.0.0");

        let failures = seed(&resources, &installed);

        assert!(failures.is_empty(), "unexpected failures: {failures:?}");
        assert_eq!(
            installed_version(&installed, "writer.test").as_deref(),
            Some("1.0.0")
        );
        // A core extension is seeded without an install.json - it updates with
        // the app, not from a GitHub release.
        assert!(!installed.join("writer.test").join("install.json").exists());
    }

    #[test]
    fn upgrades_when_shipped_is_newer_but_not_otherwise() {
        let tmp = tempfile::tempdir().unwrap();
        let resources = tmp.path().join("resources");
        let installed = tmp.path().join("extensions");
        std::fs::create_dir_all(&installed).unwrap();

        write_shipped(&resources, "writer.test", "1.0.0");
        seed(&resources, &installed);
        assert_eq!(
            installed_version(&installed, "writer.test").as_deref(),
            Some("1.0.0")
        );

        // A newer shipped version replaces the installed one.
        write_shipped(&resources, "writer.test", "1.2.0");
        seed(&resources, &installed);
        assert_eq!(
            installed_version(&installed, "writer.test").as_deref(),
            Some("1.2.0")
        );

        // An older shipped version does not downgrade what is installed.
        write_shipped(&resources, "writer.test", "1.1.0");
        seed(&resources, &installed);
        assert_eq!(
            installed_version(&installed, "writer.test").as_deref(),
            Some("1.2.0")
        );
    }

    #[test]
    fn a_missing_resources_directory_is_not_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let failures = seed(&tmp.path().join("does-not-exist"), tmp.path());
        assert!(failures.is_empty());
    }

    #[test]
    fn one_broken_shipped_extension_does_not_stop_the_others() {
        let tmp = tempfile::tempdir().unwrap();
        let resources = tmp.path().join("resources");
        let installed = tmp.path().join("extensions");
        std::fs::create_dir_all(&installed).unwrap();

        write_shipped(&resources, "writer.good", "1.0.0");
        // A manifest that is not valid JSON.
        let bad = resources.join("writer.bad");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(bad.join(MANIFEST_ASSET), b"{ not json").unwrap();
        std::fs::write(bad.join(BUNDLE_ASSET), BUNDLE).unwrap();

        let failures = seed(&resources, &installed);

        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].0, "writer.bad");
        assert_eq!(
            installed_version(&installed, "writer.good").as_deref(),
            Some("1.0.0")
        );
    }
}

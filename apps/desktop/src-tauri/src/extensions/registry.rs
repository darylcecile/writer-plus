use super::manifest::ExtensionManifest;
use crate::error::AppError;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct InstalledExtension {
    pub manifest: ExtensionManifest,
    pub install_dir: PathBuf,
    pub enabled: bool,
}

#[derive(Default)]
pub struct ExtensionRegistry {
    extensions: Mutex<HashMap<String, InstalledExtension>>,
}

impl ExtensionRegistry {
    pub fn register(
        &self,
        manifest: ExtensionManifest,
        install_dir: PathBuf,
    ) -> Result<(), AppError> {
        manifest.validate()?;
        let id = manifest.id.clone();
        self.extensions.lock().insert(
            id,
            InstalledExtension {
                manifest,
                install_dir,
                enabled: true,
            },
        );
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<InstalledExtension> {
        self.extensions.lock().get(id).cloned()
    }

    pub fn list(&self) -> Vec<InstalledExtension> {
        let mut installed: Vec<_> = self.extensions.lock().values().cloned().collect();
        installed.sort_by(|a, b| {
            a.manifest
                .id
                .cmp(&b.manifest.id)
                .then_with(|| a.install_dir.cmp(&b.install_dir))
        });
        installed
    }

    #[allow(dead_code)]
    pub fn remove(&self, id: &str) -> Option<InstalledExtension> {
        self.extensions.lock().remove(id)
    }

    /// Populate from an extensions directory on disk.
    ///
    /// The installer writes to disk; without this the registry is empty on
    /// every launch and an installed extension silently disappears when the
    /// app restarts.
    ///
    /// One bad directory does not abort the scan. A single unparseable
    /// manifest - a partially-restored backup, a hand-edited file - would
    /// otherwise take every other extension down with it, and the failure
    /// would look like "all my extensions vanished" rather than "one is
    /// broken". Skipped entries are returned so the caller can report them
    /// instead of losing them.
    pub fn load_from_disk(&self, dir: &std::path::Path) -> Vec<(PathBuf, AppError)> {
        let mut skipped = Vec::new();

        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            // No directory yet is the normal first-run state, not an error.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return skipped,
            Err(e) => {
                skipped.push((dir.to_path_buf(), AppError::from(e)));
                return skipped;
            }
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            // Staging leftovers (`.{id}.incoming`, `.{id}.retired`) are not
            // installs. Loading one would run code from an install that was
            // interrupted, under a manifest that may never have been consented to.
            if path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with('.'))
            {
                continue;
            }

            match Self::read_manifest(&path) {
                Ok(manifest) => {
                    if let Err(e) = self.register(manifest, path.clone()) {
                        skipped.push((path, e));
                    }
                }
                Err(e) => skipped.push((path, e)),
            }
        }

        skipped
    }

    fn read_manifest(dir: &std::path::Path) -> Result<ExtensionManifest, AppError> {
        let raw = std::fs::read_to_string(dir.join("manifest.json"))?;
        serde_json::from_str(&raw)
            .map_err(|e| AppError::Invalid(format!("invalid manifest.json: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_extension(root: &std::path::Path, dir_name: &str, id: &str) {
        let dir = root.join(dir_name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            format!(
                r#"{{
                    "id": "{id}",
                    "name": "Test",
                    "version": "1.0.0",
                    "description": "d",
                    "author": "a",
                    "commands": [{{ "name": "run", "title": "Run", "mode": "view" }}],
                    "permissions": {{ "capabilities": [] }}
                }}"#
            ),
        )
        .unwrap();
    }

    #[test]
    fn loads_installed_extensions_from_disk() {
        let root = tempfile::tempdir().unwrap();
        write_extension(root.path(), "a", "test.a");
        write_extension(root.path(), "b", "test.b");

        let registry = ExtensionRegistry::default();
        let skipped = registry.load_from_disk(root.path());

        assert!(skipped.is_empty(), "unexpected skips: {skipped:?}");
        let ids: Vec<_> = registry.list().into_iter().map(|e| e.manifest.id).collect();
        assert_eq!(ids, vec!["test.a", "test.b"]);
    }

    #[test]
    fn a_missing_directory_is_not_an_error() {
        let registry = ExtensionRegistry::default();
        let skipped = registry.load_from_disk(std::path::Path::new("/nonexistent/writer/exts"));
        assert!(skipped.is_empty());
        assert!(registry.list().is_empty());
    }

    /// The reason skipping is per-directory rather than aborting the scan: one
    /// corrupt manifest must not read to the user as "all my extensions are gone".
    #[test]
    fn one_broken_manifest_does_not_hide_the_others() {
        let root = tempfile::tempdir().unwrap();
        write_extension(root.path(), "good", "test.good");
        let bad = root.path().join("bad");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(bad.join("manifest.json"), "{ not json").unwrap();

        let registry = ExtensionRegistry::default();
        let skipped = registry.load_from_disk(root.path());

        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].0, bad);
        assert_eq!(
            registry.list().len(),
            1,
            "the good extension must still load"
        );
    }

    /// An interrupted install leaves `.{id}.incoming` / `.{id}.retired` behind.
    /// Loading one would run code from an install that was never completed -
    /// and possibly never consented to.
    #[test]
    fn staging_leftovers_are_never_loaded() {
        let root = tempfile::tempdir().unwrap();
        write_extension(root.path(), ".test.a.incoming", "test.a");
        write_extension(root.path(), ".test.b.retired", "test.b");

        let registry = ExtensionRegistry::default();
        let skipped = registry.load_from_disk(root.path());

        assert!(skipped.is_empty());
        assert!(
            registry.list().is_empty(),
            "staging dirs must not be installs"
        );
    }

    #[test]
    fn stray_files_are_ignored() {
        let root = tempfile::tempdir().unwrap();
        write_extension(root.path(), "a", "test.a");
        std::fs::write(root.path().join(".DS_Store"), "junk").unwrap();

        let registry = ExtensionRegistry::default();
        assert!(registry.load_from_disk(root.path()).is_empty());
        assert_eq!(registry.list().len(), 1);
    }
}

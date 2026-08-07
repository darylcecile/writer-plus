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
}

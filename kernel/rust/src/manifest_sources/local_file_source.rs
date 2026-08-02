//! Reads manifests from the local filesystem.
//! Mirrors `../../../nodejs/src/manifest-sources/local-file-source.ts`.
//!
//! Unlike the Node source it reports canonical filesystem paths rather than
//! `file://` URLs. Nothing in this kernel consumes a URL — a controller's
//! `local_path` and an import's relative `source` both resolve as paths — and a
//! path is one fewer conversion at every use.

use std::path::{Path, PathBuf};

use telo_analyzer::{LoadError, ManifestSource, ReadManifest, DEFAULT_MANIFEST_FILENAME};

pub struct LocalFileSource;

impl ManifestSource for LocalFileSource {
    fn supports(&self, path_or_url: &str) -> bool {
        !path_or_url.contains("://")
    }

    fn read(&self, path_or_url: &str) -> Result<ReadManifest, LoadError> {
        let path = absolute(Path::new(path_or_url));
        let file = if path.is_dir() {
            path.join(DEFAULT_MANIFEST_FILENAME)
        } else {
            path
        };
        let text = std::fs::read_to_string(&file).map_err(|err| LoadError::Io {
            path: file.display().to_string(),
            message: err.to_string(),
        })?;
        Ok(ReadManifest {
            text,
            source: file.display().to_string(),
        })
    }
}

fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    match std::env::current_dir() {
        Ok(cwd) => cwd.join(path),
        Err(_) => path.to_path_buf(),
    }
}

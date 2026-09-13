//! Reads manifests from the local filesystem.
//! Mirrors `../../../nodejs/src/manifest-sources/local-file-source.ts`.
//!
//! Unlike the Node source it reports canonical filesystem paths rather than
//! `file://` URLs. Nothing in this kernel consumes a URL — a controller's
//! `local_path` and an import's relative `source` both resolve as paths — and a
//! path is one fewer conversion at every use.

use std::path::Path;

use telo_analyzer::{LoadError, ManifestSource, ReadManifest, DEFAULT_MANIFEST_FILENAME};

use crate::lexical_path;

pub struct LocalFileSource;

impl ManifestSource for LocalFileSource {
    fn supports(&self, path_or_url: &str) -> bool {
        !path_or_url.contains("://")
    }

    fn read(&self, path_or_url: &str) -> Result<ReadManifest, LoadError> {
        let path = lexical_path::absolute(Path::new(path_or_url)).map_err(|err| LoadError::Io {
            path: path_or_url.to_string(),
            message: format!("the working directory cannot be read to resolve it: {err}"),
        })?;
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

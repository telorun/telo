//! Reads a manifest through the registered sources and parses it.
//! Mirrors `../../nodejs/src/manifest-loader.ts`.
//!
//! Import traversal is not here: the Node loader walks imports because static
//! analysis needs the whole graph up front, whereas the Rust kernel discovers
//! them through `Telo.Import`'s controller as it initialises. What this file
//! owns is "a source string becomes parsed documents", once.

use std::path::{Path, PathBuf};

use crate::loaded_types::LoadedFile;
use crate::parse_loaded_file::parse_loaded_file;
use crate::types::{LoadError, ManifestSource};

pub struct ManifestLoader {
    sources: Vec<Box<dyn ManifestSource>>,
}

impl ManifestLoader {
    pub fn new(sources: Vec<Box<dyn ManifestSource>>) -> Self {
        Self { sources }
    }

    pub fn load(&self, path_or_url: &str) -> Result<LoadedFile, LoadError> {
        let source = self
            .sources
            .iter()
            .find(|source| source.supports(path_or_url))
            .ok_or_else(|| LoadError::UnsupportedSource(path_or_url.to_string()))?;
        let read = source.read(path_or_url)?;
        let loaded = parse_loaded_file(&read.source, path_or_url, &read.text);
        if let Some(error) = loaded.parse_errors.first() {
            return Err(LoadError::Parse {
                path: read.source,
                message: format!("document {}: {}", error.document_index, error.message),
            });
        }
        Ok(loaded)
    }
}

/// Resolve an import's `source` against the manifest that declared it.
///
/// A relative spec is joined to the *importing file's* directory, never to the
/// process working directory — a library two imports deep would otherwise
/// resolve against wherever the CLI happened to be invoked.
pub fn resolve_source(base_source: &str, spec: &str) -> String {
    if !spec.starts_with('.') {
        return spec.to_string();
    }
    let base_dir = Path::new(base_source)
        .parent()
        .unwrap_or_else(|| Path::new("."));
    normalize(&base_dir.join(spec))
}

/// Collapse `.` and `..` lexically. Done without touching the filesystem so an
/// unreadable path still produces a message naming what was actually looked for.
fn normalize(path: &Path) -> String {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().into_owned()
}

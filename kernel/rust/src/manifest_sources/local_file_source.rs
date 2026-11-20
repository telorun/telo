//! Reads manifests from the local filesystem.
//! Mirrors `../../../nodejs/src/manifest-sources/local-file-source.ts`.
//!
//! Unlike the Node source it reports canonical filesystem paths rather than
//! `file://` URLs. Nothing in this kernel consumes a URL — a controller's
//! `local_path` and an import's relative `source` both resolve as paths — and a
//! path is one fewer conversion at every use. A failure still names its location
//! as the `file://` URL, as Telo's words do. The Node source's `readAll`,
//! `resolveOwnerOf`, `entryAt`, `readHead` and `listDirectory` serve the editor and
//! the module-file checks, which no Rust host has yet.

use std::path::{Path, PathBuf};

use telo_analyzer::sources::source_failure::{file_source_failure, file_url, ManifestSourceFailure, SourceFailureKind};
use telo_analyzer::{LoadError, ManifestSource, ReadManifest, DEFAULT_MANIFEST_FILENAME};
use telorun_glob::{is_pruned, select_by_patterns, SelectOptions};

use crate::lexical_path;

pub struct LocalFileSource;

impl LocalFileSource {
    fn absolute(path_or_url: &str) -> Result<PathBuf, LoadError> {
        let path = path_or_url.strip_prefix("file://").unwrap_or(path_or_url);
        lexical_path::absolute(Path::new(path)).map_err(|err| LoadError::Io {
            path: path_or_url.to_string(),
            message: format!("the working directory cannot be read to resolve it: {err}"),
        })
    }
}

impl ManifestSource for LocalFileSource {
    fn supports(&self, path_or_url: &str) -> bool {
        path_or_url.starts_with("file://")
            || path_or_url.starts_with('/')
            || path_or_url.starts_with("./")
            || path_or_url.starts_with("../")
            || (!path_or_url.contains("://") && !path_or_url.contains('@'))
    }

    /// A path that does not exist is `not-found`, a directory holding no `telo.yaml`
    /// `not-a-module`, anything else the OS refuses `unreadable`.
    fn read(&self, path_or_url: &str) -> Result<ReadManifest, LoadError> {
        let path = Self::absolute(path_or_url)?;
        let metadata =
            std::fs::metadata(&path).map_err(|err| LoadError::Source(file_source_failure(&err, file_url(&path))))?;
        let file = if metadata.is_dir() { path.join(DEFAULT_MANIFEST_FILENAME) } else { path.clone() };
        let text = std::fs::read_to_string(&file).map_err(|err| {
            let missing = matches!(err.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory);
            LoadError::Source(if metadata.is_dir() && missing {
                ManifestSourceFailure::new(SourceFailureKind::NotAModule, file_url(&path))
            } else {
                file_source_failure(&err, file_url(&file))
            })
        })?;
        Ok(ReadManifest { text, source: file.display().to_string() })
    }

    fn resolve_relative(&self, base: &str, relative: &str) -> Result<String, LoadError> {
        let base = Self::absolute(base)?;
        let directory = base.parent().unwrap_or(&base);
        Ok(lexical_path::normalize(&directory.join(relative)).display().to_string())
    }

    /// Every file beneath `base`'s directory the patterns select; `include:` may reach any
    /// co-located partial, so the soft default-ignore tier is off while the hard one
    /// (`node_modules`, `.git`, `.telo`) always holds.
    fn expand_glob(&self, base: &str, patterns: &[String]) -> Option<Result<Vec<String>, LoadError>> {
        let expanded = || -> Result<Vec<String>, LoadError> {
            let base = Self::absolute(base)?;
            let directory = base.parent().unwrap_or(&base).to_path_buf();
            let mut relative = Vec::new();
            collect_files(&directory, "", &mut relative)
                .map_err(|err| LoadError::Failed(format!("cannot list '{}': {err}", directory.display())))?;
            let options = SelectOptions { apply_default_ignore: Some(false), exclude: Vec::new() };
            Ok(select_by_patterns(&relative, patterns, &options)
                .into_iter()
                .map(|rel| lexical_path::normalize(&directory.join(rel)).display().to_string())
                .collect())
        };
        Some(expanded())
    }
}

/// Every regular file beneath `directory`, as `/`-separated paths relative to it.
fn collect_files(directory: &Path, prefix: &str, out: &mut Vec<String>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        let kind = entry.file_type()?;
        if kind.is_dir() {
            if !is_pruned(&name) {
                collect_files(&entry.path(), &relative, out)?;
            }
        } else if kind.is_file() {
            out.push(relative);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_a_missing_path_and_a_directory_holding_no_manifest() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonical");
        std::fs::create_dir(root.join("empty")).expect("mkdir");
        let read = |path: &Path| LocalFileSource.read(&path.display().to_string()).err().expect("refused").to_string();
        assert_eq!(read(&root.join("absent")), format!("nothing exists at {}.", file_url(&root.join("absent"))));
        assert_eq!(
            read(&root.join("empty")),
            format!("{} is not a module: it holds no telo.yaml.", file_url(&root.join("empty")))
        );
    }

    #[test]
    fn expands_a_glob_over_the_owner_s_directory_less_the_hard_ignore_tier() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonical");
        for file in ["telo.yaml", "parts/b.yaml", "parts/a.yaml", "parts/notes.txt", "node_modules/x/c.yaml"] {
            let path = root.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).expect("mkdir");
            std::fs::write(&path, "").expect("write");
        }
        let owner = root.join("telo.yaml").display().to_string();
        let found = LocalFileSource.expand_glob(&owner, &["**/*.yaml".to_string(), "!telo.yaml".to_string()]).expect("lists").expect("expands");
        assert_eq!(found, [root.join("parts/a.yaml"), root.join("parts/b.yaml")].map(|p| p.display().to_string()));
    }
}

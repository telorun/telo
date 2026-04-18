use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use tempfile::TempDir;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunBundlePayload {
    pub entry_relative_path: String,
    pub files: Vec<RunBundleFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunBundleFile {
    pub relative_path: String,
    pub contents: String,
}

/// Owns a scratch directory on disk populated with a `RunBundle`'s files.
/// The directory is deleted when the workdir is dropped (via `TempDir`).
pub struct BundleWorkdir {
    dir: TempDir,
}

impl BundleWorkdir {
    pub fn write(bundle: &RunBundlePayload) -> io::Result<Self> {
        let dir = tempfile::Builder::new().prefix("telo-run-").tempdir()?;
        for file in &bundle.files {
            let abs = safe_join(dir.path(), &file.relative_path)?;
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&abs, &file.contents)?;
        }
        Ok(Self { dir })
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }
}

/// Converts a POSIX-style relative path into a `PathBuf` rooted at `base`,
/// rejecting anything that would escape (`..`, absolute, drive letters).
fn safe_join(base: &Path, relative: &str) -> io::Result<PathBuf> {
    let normalized = relative.replace('\\', "/");
    if normalized.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty relative path"));
    }
    if normalized.starts_with('/') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("absolute path in bundle: {relative}"),
        ));
    }

    let mut out = base.to_path_buf();
    for segment in normalized.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("parent traversal in bundle path: {relative}"),
            ));
        }
        if segment.contains(':') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("drive letter in bundle path: {relative}"),
            ));
        }
        out.push(segment);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(files: Vec<(&str, &str)>) -> RunBundlePayload {
        RunBundlePayload {
            entry_relative_path: files.first().map(|f| f.0.to_string()).unwrap_or_default(),
            files: files
                .into_iter()
                .map(|(p, c)| RunBundleFile {
                    relative_path: p.to_string(),
                    contents: c.to_string(),
                })
                .collect(),
        }
    }

    #[test]
    fn writes_flat_and_nested_files() {
        let bundle = payload(vec![
            ("telo.yaml", "# main"),
            ("nested/sub.yaml", "# sub"),
        ]);
        let wd = BundleWorkdir::write(&bundle).expect("write");
        assert_eq!(
            std::fs::read_to_string(wd.path().join("telo.yaml")).unwrap(),
            "# main"
        );
        assert_eq!(
            std::fs::read_to_string(wd.path().join("nested").join("sub.yaml")).unwrap(),
            "# sub"
        );
    }

    #[test]
    fn rejects_parent_traversal() {
        let bundle = payload(vec![("../escape.yaml", "bad")]);
        assert!(BundleWorkdir::write(&bundle).is_err());
    }

    #[test]
    fn rejects_absolute_paths() {
        let bundle = payload(vec![("/etc/passwd", "bad")]);
        assert!(BundleWorkdir::write(&bundle).is_err());
    }

    #[test]
    fn normalizes_windows_separators() {
        let bundle = payload(vec![("nested\\sub.yaml", "# win")]);
        let wd = BundleWorkdir::write(&bundle).expect("write");
        assert_eq!(
            std::fs::read_to_string(wd.path().join("nested").join("sub.yaml")).unwrap(),
            "# win"
        );
    }
}

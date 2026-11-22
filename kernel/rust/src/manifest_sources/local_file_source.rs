//! Reads manifests from the local filesystem.
//! Mirrors `../../../nodejs/src/manifest-sources/local-file-source.ts`.
//!
//! Unlike the Node source it reports canonical filesystem paths rather than
//! `file://` URLs. Nothing in this kernel consumes a URL — a controller's
//! `local_path` and an import's relative `source` both resolve as paths — and a
//! path is one fewer conversion at every use. A failure still names its location
//! as the `file://` URL, as Telo's words do. The Node source's `readAll` and
//! `resolveOwnerOf` serve the editor, which no Rust host has. What the module-file
//! walk asks (`entry_at`, `read_head`, `locate`, `list_directory`) is answered from
//! the disk, a failure in the words the Node source lets through: the platform's,
//! as Node's `fs` writes them.

use std::io::Read;
use std::path::{Path, PathBuf};

use telo_analyzer::sources::source_failure::{file_source_failure, file_url, ManifestSourceFailure, SourceFailureKind};
use telo_analyzer::{HostEntryKind, LoadError, ManifestSource, ReadManifest, DEFAULT_MANIFEST_FILENAME};
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

    fn entry_at(&self, base: &str, relative: &str) -> Option<Result<Option<HostEntryKind>, LoadError>> {
        let answer = || -> Result<Option<HostEntryKind>, LoadError> {
            let path = self.located(base, relative)?;
            match std::fs::metadata(&path) {
                Ok(metadata) => Ok(Some(if metadata.is_dir() { HostEntryKind::Directory } else { HostEntryKind::File })),
                Err(err) if is_absent(&err) => Ok(None),
                Err(err) => Err(LoadError::Failed(fs_error_message(&err, "stat", Some(&path)))),
            }
        };
        Some(answer())
    }

    fn read_head(&self, base: &str, relative: &str, length: usize) -> Option<Result<Option<Vec<u8>>, LoadError>> {
        let answer = || -> Result<Option<Vec<u8>>, LoadError> {
            let path = self.located(base, relative)?;
            let file = match std::fs::File::open(&path) {
                Ok(file) => file,
                Err(err) if is_absent(&err) || err.kind() == std::io::ErrorKind::IsADirectory => return Ok(None),
                Err(err) => return Err(LoadError::Failed(fs_error_message(&err, "open", Some(&path)))),
            };
            let mut head = Vec::with_capacity(length);
            match file.take(length as u64).read_to_end(&mut head) {
                Ok(_) => Ok(Some(head)),
                Err(err) if err.kind() == std::io::ErrorKind::IsADirectory => Ok(None),
                Err(err) => Err(LoadError::Failed(fs_error_message(&err, "read", None))),
            }
        };
        Some(answer())
    }

    fn locate(&self, base: &str, relative: &str) -> Option<String> {
        self.located(base, relative).ok().map(|path| path.display().to_string())
    }

    /// The names in a directory, sorted as Node's `readdir` hands them over.
    fn list_directory(&self, base: &str, relative: &str) -> Option<Result<Option<Vec<String>>, LoadError>> {
        let answer = || -> Result<Option<Vec<String>>, LoadError> {
            let path = self.located(base, relative)?;
            let listed: std::io::Result<Vec<String>> = std::fs::read_dir(&path).and_then(|entries| {
                entries.map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned())).collect()
            });
            match listed {
                Ok(mut names) => {
                    names.sort();
                    Ok(Some(names))
                }
                Err(err) if is_absent(&err) => Ok(None),
                Err(err) => Err(LoadError::Failed(fs_error_message(&err, "scandir", Some(&path)))),
            }
        };
        Some(answer())
    }
}

impl LocalFileSource {
    /// `relative` beside the module file `base`: where every module-file question looks.
    fn located(&self, base: &str, relative: &str) -> Result<PathBuf, LoadError> {
        let base = Self::absolute(base)?;
        let directory = base.parent().unwrap_or(&base);
        Ok(lexical_path::normalize(&directory.join(relative)))
    }
}

/// Nothing at the path, or a path running through a file: what every question reads as absent.
fn is_absent(err: &std::io::Error) -> bool {
    matches!(err.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory)
}

/// `ELOOP`, whose kind std does not name yet.
const ELOOP: i32 = if cfg!(any(target_os = "macos", target_os = "ios", target_os = "freebsd")) { 62 } else { 40 };

/// A filesystem failure as Node's `fs` words it — `<CODE>: <description>, <syscall> '<path>'` —
/// for the failures a stat, an open, a read or a listing raises; any other in the platform's
/// own words.
fn fs_error_message(err: &std::io::Error, syscall: &str, path: Option<&Path>) -> String {
    use std::io::ErrorKind;
    let described = match (err.kind(), err.raw_os_error()) {
        (ErrorKind::PermissionDenied, Some(1)) => Some(("EPERM", "operation not permitted")),
        (ErrorKind::PermissionDenied, _) => Some(("EACCES", "permission denied")),
        (_, Some(code)) if cfg!(unix) && code == ELOOP => Some(("ELOOP", "too many symbolic links encountered")),
        (ErrorKind::InvalidFilename, _) => Some(("ENAMETOOLONG", "name too long")),
        (ErrorKind::IsADirectory, _) => Some(("EISDIR", "illegal operation on a directory")),
        (ErrorKind::NotADirectory, _) => Some(("ENOTDIR", "not a directory")),
        (ErrorKind::NotFound, _) => Some(("ENOENT", "no such file or directory")),
        (ErrorKind::OutOfMemory, _) => Some(("ENOMEM", "not enough memory")),
        (ErrorKind::ResourceBusy, _) => Some(("EBUSY", "resource busy or locked")),
        (ErrorKind::InvalidInput, _) => Some(("EINVAL", "invalid argument")),
        (_, Some(5)) if cfg!(unix) => Some(("EIO", "i/o error")),
        (_, Some(23)) if cfg!(unix) => Some(("ENFILE", "file table overflow")),
        (_, Some(24)) if cfg!(unix) => Some(("EMFILE", "too many open files")),
        _ => None,
    };
    let Some((code, description)) = described else { return err.to_string() };
    match path {
        Some(path) => format!("{code}: {description}, {syscall} '{}'", path.display()),
        None => format!("{code}: {description}, {syscall}"),
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

    #[test]
    fn answers_what_a_module_file_claim_names_beside_the_owner() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonical");
        std::fs::create_dir_all(root.join("public/css")).expect("mkdir");
        std::fs::write(root.join("public/index.html"), "<html>").expect("write");
        std::fs::write(root.join("public/about.html"), "").expect("write");
        let owner = root.join("telo.yaml").display().to_string();
        let entry = |relative: &str| LocalFileSource.entry_at(&owner, relative).expect("answers").expect("reads");
        assert_eq!(entry("public"), Some(HostEntryKind::Directory));
        assert_eq!(entry("public/index.html"), Some(HostEntryKind::File));
        assert_eq!(entry("missing.png"), None);
        assert_eq!(entry("public/index.html/x"), None);
        let head = |relative: &str| LocalFileSource.read_head(&owner, relative, 3).expect("answers").expect("reads");
        assert_eq!(head("public/index.html"), Some(b"<ht".to_vec()));
        assert_eq!(head("public/about.html"), Some(Vec::new()));
        assert_eq!(head("public"), None);
        assert_eq!(head("missing.png"), None);
        let list = |relative: &str| LocalFileSource.list_directory(&owner, relative).expect("answers").expect("reads");
        assert_eq!(list("public"), Some(vec!["about.html".to_string(), "css".to_string(), "index.html".to_string()]));
        assert_eq!(list("missing"), None);
        assert_eq!(LocalFileSource.locate(&owner, "./public/../icon.png"), Some(root.join("icon.png").display().to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn words_a_failed_question_as_node_s_fs_does() {
        let denied = std::io::Error::from_raw_os_error(13);
        assert_eq!(fs_error_message(&denied, "stat", Some(Path::new("/m/x"))), "EACCES: permission denied, stat '/m/x'");
        assert_eq!(fs_error_message(&std::io::Error::from_raw_os_error(1), "open", Some(Path::new("/m/x"))), "EPERM: operation not permitted, open '/m/x'");
        assert_eq!(fs_error_message(&std::io::Error::from_raw_os_error(5), "read", None), "EIO: i/o error, read");
        assert_eq!(
            fs_error_message(&std::io::Error::from_raw_os_error(ELOOP), "scandir", Some(Path::new("/m/loop"))),
            "ELOOP: too many symbolic links encountered, scandir '/m/loop'"
        );
    }
}

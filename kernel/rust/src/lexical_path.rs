//! Path arithmetic without the filesystem: `.` and `..` collapsed, and a relative
//! path made absolute against the working directory.
//!
//! No Node file of this name: the Node kernel calls `path.normalize` and
//! `path.resolve`, and the standard library here has no lexical equivalent of
//! either — so the one implementation lives here instead of beside each caller.

use std::path::{Component, Path, PathBuf};

/// `path.normalize`: `.` segments dropped and `..` segments collapsed, touching
/// nothing on disk. A `..` with nothing left to collapse is dropped.
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `path.resolve`: `path` against the working directory, normalized. Fails when
/// the working directory cannot be read — a deleted one, above all — rather than
/// answering with a relative path that would resolve differently for each caller.
pub fn absolute(path: &Path) -> std::io::Result<PathBuf> {
    if path.is_absolute() {
        return Ok(normalize(path));
    }
    Ok(normalize(&std::env::current_dir()?.join(path)))
}

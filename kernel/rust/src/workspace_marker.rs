//! Finding `telo-workspace.yaml` on disk. Mirrors
//! `kernel/nodejs/src/workspace-marker.ts`; the `.telo` cache root anchored on it
//! is `resolve_cache_root`, beside its Node twin in
//! `manifest_sources/local_manifest_cache_source.rs`.

use std::path::{Path, PathBuf};

pub use telo_analyzer::WORKSPACE_FILENAME;

/// Walk up from `from` looking for the marker. Returns the directory holding it,
/// or `None` — the file is optional, and its absence means "no parent lookup".
///
/// `from` is canonicalized first: a crate reached through a symlinked directory
/// would otherwise walk the LINK's parents, miss a marker sitting right there in
/// the real tree, and silently fall back to a narrower answer. A path that does
/// not exist is left as given — that is the caller's error to report, not this
/// function's to convert into a different one.
pub fn find_workspace_root(from: &Path) -> Option<PathBuf> {
    let start = from.canonicalize().unwrap_or_else(|_| from.to_path_buf());
    let mut dir = start.as_path();
    loop {
        if dir.join(WORKSPACE_FILENAME).is_file() {
            return Some(dir.to_path_buf());
        }
        dir = dir.parent()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A DIRECTORY named `telo-workspace.yaml` is not a marker — the Node half
    /// tests `isFile()` too, and a marker one kernel honours and the other ignores
    /// splits the cache in half.
    #[test]
    fn a_directory_named_like_the_marker_is_not_one() {
        let base = tempfile::tempdir().unwrap();
        let base = base.path().canonicalize().unwrap();
        fs::create_dir_all(base.join(WORKSPACE_FILENAME)).unwrap();
        assert_eq!(find_workspace_root(&base), None);
    }
}

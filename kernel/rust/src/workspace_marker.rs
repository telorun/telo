//! Finding `telo-workspace.yaml` on disk, and the `.telo` cache root anchored on
//! it.
//!
//! The finder mirrors `kernel/nodejs/src/workspace-marker.ts`. `resolve_cache_root`
//! does NOT have a same-named twin: on the Node side it lives in
//! `manifest-sources/local-manifest-cache-source.ts`, beside the manifest cache
//! that is its largest consumer. This kernel has no manifest cache — no OCI
//! transport, no registry source, so nothing to cache — and creating that file to
//! hold one unrelated function would mirror a name rather than a structure. The
//! two things it does own are the marker walk and the root derived from it, so
//! they live together here.

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

/// Absolutize a `TELO_CACHE_DIR` value against the process's working directory.
///
/// The Node half calls `path.resolve` here, and matching it is not cosmetic: this
/// value becomes `CARGO_TARGET_DIR` for a `cargo` invocation whose `current_dir`
/// is the CONTROLLER CRATE, not the cwd. A relative override would therefore
/// resolve against a different directory in each kernel — and, in the Rust one,
/// against a different directory per crate — silently scattering builds instead of
/// relocating them.
fn absolutize(dir: &str) -> PathBuf {
    let path = PathBuf::from(dir);
    if path.is_absolute() {
        return path;
    }
    match std::env::current_dir() {
        Ok(cwd) => cwd.join(path),
        Err(_) => path,
    }
}

/// The `.telo` cache root for work anchored at `from`.
///
/// Precedence: `TELO_CACHE_DIR` (the relocated root a prebuilt image bakes its
/// deps into) wins; then the directory holding `telo-workspace.yaml`, so every
/// crate in one repo shares a cache instead of each carrying its own copy of the
/// same dependency build; then `from` itself, which is what this did before the
/// anchor existed. So the marker enables the shared cache rather than gating one,
/// and deleting it cannot break a build.
pub fn resolve_cache_root(from: &Path) -> PathBuf {
    if let Ok(override_dir) = std::env::var("TELO_CACHE_DIR") {
        if !override_dir.trim().is_empty() {
            return absolutize(override_dir.trim());
        }
    }
    find_workspace_root(from)
        .unwrap_or_else(|| from.to_path_buf())
        .join(".telo")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Mirrors `kernel/nodejs/tests/cache-root.test.ts`. The two kernels share one
    /// marker and one precedence, so a divergence here is a workspace that exists
    /// for one runtime and not the other.
    ///
    /// `TELO_CACHE_DIR` is process-global, so these run in ONE test with the env
    /// restored around each case rather than as separate `#[test]` fns — cargo
    /// runs those on threads of one process, where a parallel case would observe
    /// another's override.
    #[test]
    fn cache_root_precedence() {
        let base = tempdir();
        fs::write(base.join(WORKSPACE_FILENAME), "modules: []\n").unwrap();
        let deep = base.join("examples").join("app").join("tests");
        fs::create_dir_all(&deep).unwrap();
        let loose = tempdir();

        with_cache_dir(None, || {
            // Anchors at the marker, however deep the crate sits.
            assert_eq!(resolve_cache_root(&deep), base.join(".telo"));
            assert_eq!(resolve_cache_root(&base), base.join(".telo"));
            // No marker above → what it did before the anchor existed.
            assert_eq!(resolve_cache_root(&loose), loose.join(".telo"));
        });

        let baked = base.join("baked");
        with_cache_dir(Some(baked.to_str().unwrap()), || {
            assert_eq!(resolve_cache_root(&deep), baked);
        });

        // A relative override is absolutized, as the Node half does: this value
        // becomes CARGO_TARGET_DIR for a build whose cwd is the crate, so leaving
        // it relative would scatter builds per crate instead of relocating them.
        with_cache_dir(Some("relative-cache"), || {
            let resolved = resolve_cache_root(&deep);
            assert!(resolved.is_absolute(), "{resolved:?} should be absolute");
            assert!(resolved.ends_with("relative-cache"));
        });
    }

    /// A DIRECTORY named `telo-workspace.yaml` is not a marker — the Node half
    /// tests `isFile()` too, and a marker one kernel honours and the other ignores
    /// splits the cache in half.
    #[test]
    fn a_directory_named_like_the_marker_is_not_one() {
        let base = tempdir();
        fs::create_dir_all(base.join(WORKSPACE_FILENAME)).unwrap();
        assert_eq!(find_workspace_root(&base), None);
    }

    fn with_cache_dir(value: Option<&str>, body: impl FnOnce()) {
        let saved = std::env::var("TELO_CACHE_DIR").ok();
        match value {
            Some(v) => std::env::set_var("TELO_CACHE_DIR", v),
            None => std::env::remove_var("TELO_CACHE_DIR"),
        }
        body();
        match saved {
            Some(v) => std::env::set_var("TELO_CACHE_DIR", v),
            None => std::env::remove_var("TELO_CACHE_DIR"),
        }
    }

    /// A unique directory under the system temp dir. Canonicalized, because
    /// `find_workspace_root` canonicalizes its input and `/tmp` is a symlink on
    /// macOS — an uncanonicalized expectation would fail there and nowhere else.
    fn tempdir() -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "telo-cacheroot-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }
}

//! Reads previously cached manifests from the workspace manifest cache.
//! Mirrors `../../../nodejs/src/manifest-sources/local-manifest-cache-source.ts`.
//!
//! Sits ahead of the OCI source, so a hit makes boot hermetic and a miss falls
//! through to the network. The cache is written by `telo install` and
//! `telo run` on the Node side; both kernels share it, which is why the path
//! grammar below must be byte-for-byte the Node one.
//!
//! The key renderer (`manifestCacheKey`) lives in the Node analyzer's
//! `sources/manifest-cache.ts`, beside the hub's browser read path. That file
//! has no Rust twin — the hub source is browser-only — so the one function this
//! reader needs is here, beside its only consumer. Only `oci://` refs have
//! coordinates: this kernel has no HTTP transport.

use std::path::{Path, PathBuf};

use telo_analyzer::sources::integrity::{split_integrity, verify_integrity};
use telo_analyzer::sources::oci_ref::parse_oci_ref;
use telo_analyzer::{LoadError, ManifestSource, ReadManifest, DEFAULT_MANIFEST_FILENAME};

use crate::lexical_path;
use crate::workspace_marker::find_workspace_root;

const CACHE_SUBDIR: &str = ".telo/manifests";

pub struct LocalManifestCacheSource {
    cache_root: PathBuf,
    legacy_root: Option<PathBuf>,
}

impl LocalManifestCacheSource {
    /// `manifests_dir` is the resolved `<cache-root>/manifests`; the
    /// pre-workspace-anchor `<entry-dir>/.telo/manifests` is consulted on a miss.
    pub fn new(entry_dir: &Path, manifests_dir: PathBuf) -> Self {
        let legacy_root = legacy_manifests_dir_fallback(entry_dir, &manifests_dir);
        Self {
            cache_root: manifests_dir,
            legacy_root,
        }
    }

    fn try_map(&self, url: &str) -> Option<PathBuf> {
        try_map_in(url, &self.cache_root)
            .or_else(|| self.legacy_root.as_deref().and_then(|root| try_map_in(url, root)))
    }
}

/// A regular file at the mapped path is a hit; a directory, a dangling link or a
/// stat failure is a miss, so the next source still gets the URL.
fn try_map_in(url: &str, root: &Path) -> Option<PathBuf> {
    let candidate = cache_path_for_canonical(url, root)?;
    std::fs::metadata(&candidate)
        .is_ok_and(|meta| meta.is_file())
        .then_some(candidate)
}

impl ManifestSource for LocalManifestCacheSource {
    fn supports(&self, path_or_url: &str) -> bool {
        self.try_map(path_or_url).is_some()
    }

    fn read(&self, path_or_url: &str) -> Result<ReadManifest, LoadError> {
        let mapped = self.try_map(path_or_url).ok_or_else(|| LoadError::Io {
            path: path_or_url.to_string(),
            message: "the manifest cache holds no file for it".to_string(),
        })?;
        let io = |message: String| LoadError::Io {
            path: mapped.display().to_string(),
            message,
        };
        let bytes = std::fs::read(&mapped).map_err(|err| io(err.to_string()))?;
        // A poisoned cache is terminal, never a self-healing miss.
        let split = split_integrity(path_or_url);
        if let Some(integrity) = split.integrity {
            verify_integrity(&bytes, integrity, split.base).map_err(|err| io(err.message))?;
        }
        let text = String::from_utf8(bytes)
            .map_err(|err| io(format!("the cached manifest is not UTF-8: {err}")))?;
        Ok(ReadManifest {
            text,
            source: mapped.display().to_string(),
        })
    }
}

/// The pre-workspace-anchor manifest cache for an entry: always
/// `<entry-dir>/.telo/manifests`.
pub fn legacy_manifests_dir(entry_dir: &Path) -> PathBuf {
    entry_dir.join(CACHE_SUBDIR)
}

/// [`legacy_manifests_dir`], or `None` when it coincides with `current` — so the
/// fallback is never a second lookup at the same place.
pub fn legacy_manifests_dir_fallback(entry_dir: &Path, current: &Path) -> Option<PathBuf> {
    let legacy = legacy_manifests_dir(entry_dir);
    (lexical_path::normalize(&legacy) != lexical_path::normalize(current)).then_some(legacy)
}

/// The `.telo` cache root for work anchored at `from`.
///
/// Precedence: `TELO_CACHE_DIR` (the relocated root a prebuilt image bakes its
/// deps into) wins; then the directory holding `telo-workspace.yaml`, so every
/// crate in one repo shares a cache instead of each carrying its own copy of the
/// same dependency build; then `from` itself, which is what this did before the
/// anchor existed. So the marker enables the shared cache rather than gating one,
/// and deleting it cannot break a build.
///
/// A relative `TELO_CACHE_DIR` is made absolute against the working directory,
/// as the Node half's `path.resolve` does. That is not cosmetic: the value becomes
/// `CARGO_TARGET_DIR` for a `cargo` invocation whose `current_dir` is the
/// CONTROLLER CRATE, so a relative override would resolve against a different
/// directory per crate, scattering builds instead of relocating them.
pub fn resolve_cache_root(from: &Path) -> std::io::Result<PathBuf> {
    if let Ok(override_dir) = std::env::var("TELO_CACHE_DIR") {
        if !override_dir.trim().is_empty() {
            return lexical_path::absolute(Path::new(override_dir.trim()));
        }
    }
    Ok(find_workspace_root(from)
        .unwrap_or_else(|| from.to_path_buf())
        .join(".telo"))
}

/// URL → cache path, the single mapping reader and writer share: `null` for a
/// ref no transport gives coordinates, or one whose key would escape `root`.
pub fn cache_path_for_canonical(canonical: &str, root: &Path) -> Option<PathBuf> {
    let key = oci_cache_key(canonical)?;
    join_under(root, key.split('/'))
}

/// `oci/<host>/<repo…>/<reference>/telo.yaml` — the OCI transport's coordinates
/// rendered by the Node analyzer's `manifestCacheKey`.
fn oci_cache_key(reference: &str) -> Option<String> {
    let parsed = parse_oci_ref(reference).ok()?;
    let mut segments = vec!["oci", parsed.host.as_str()];
    segments.extend(parsed.repo.split('/'));
    segments.push(parsed.reference.as_str());
    segments.push(DEFAULT_MANIFEST_FILENAME);
    let invalid = segments
        .iter()
        .any(|s| s.is_empty() || *s == "." || *s == ".." || s.contains('\\'))
        || parsed.host.contains('/')
        || parsed.reference.contains('/');
    (!invalid).then(|| segments.join("/"))
}

/// `root` joined with `segments`, or `None` when the result escapes `root`.
fn join_under<'a>(root: &Path, segments: impl Iterator<Item = &'a str>) -> Option<PathBuf> {
    let mut candidate = root.to_path_buf();
    for segment in segments {
        if segment.is_empty() {
            return None;
        }
        candidate.push(segment);
    }
    // Compared lexically: the candidate is the root joined with segments, so a
    // relative root and its candidate collapse identically.
    let resolved = lexical_path::normalize(&candidate);
    let resolved_root = lexical_path::normalize(root);
    (resolved != resolved_root && resolved.starts_with(&resolved_root)).then_some(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_marker::WORKSPACE_FILENAME;
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
            assert_eq!(resolve_cache_root(&deep).unwrap(), base.join(".telo"));
            assert_eq!(resolve_cache_root(&base).unwrap(), base.join(".telo"));
            // No marker above → what it did before the anchor existed.
            assert_eq!(resolve_cache_root(&loose).unwrap(), loose.join(".telo"));
        });

        let baked = base.join("baked");
        with_cache_dir(Some(baked.to_str().unwrap()), || {
            assert_eq!(resolve_cache_root(&deep).unwrap(), baked);
        });

        with_cache_dir(Some("relative-cache"), || {
            let resolved = resolve_cache_root(&deep).unwrap();
            assert!(resolved.is_absolute(), "{resolved:?} should be absolute");
            assert!(resolved.ends_with("relative-cache"));
        });
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

    /// Mirrors `kernel/nodejs/tests/local-manifest-cache-source.test.ts` §
    /// cachePathForCanonical and the traversal guard: both kernels must land one
    /// ref on one file.
    #[test]
    fn maps_an_oci_ref_into_the_shared_layout() {
        let root = Path::new("/cache/manifests");
        assert_eq!(
            cache_path_for_canonical("oci://ghcr.io/telorun/console@0.9.0#sha256-abc", root),
            Some(root.join("oci/ghcr.io/telorun/console/0.9.0/telo.yaml"))
        );
        assert_eq!(cache_path_for_canonical("oci://ghcr.io/a/../../x@1", root), None);
        assert_eq!(cache_path_for_canonical("./local/telo.yaml", root), None);
    }
}

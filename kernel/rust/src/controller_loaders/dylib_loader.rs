//! `pkg:telo/local/dylib` controllers: a prebuilt cdylib shipped in its module's
//! artifact, opened over `telorun-abi`.
//!
//! No Node file of this name. Its Node counterpart is `bundle-loader.ts`, which
//! hosts the `js` and `napi` formats of the same `pkg:telo/local/<format>`
//! delivery; this loader applies that loader's `napi` path to a cdylib — parse,
//! platform gate, materialize the layer carrying the candidate's selector, or on a
//! source checkout stage a file its `sources:` block stages and verify it against
//! its pin, then resolve `path=`. Building from `local_path` source, realm symlinks and sibling-library
//! shims are JavaScript-bundle concerns with no cdylib equivalent.
//!
//! The platform gate — `abi` included — runs BEFORE materialization, so a
//! candidate built for another host or another controller ABI is never fetched.
//! `LoadedController::open`'s ABI version check stays the second line.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;

use telo_analyzer::artifact_selector::{
    describe_selector, selector_from_qualifiers, selector_matches, ArtifactSelectorError,
    PlatformAxis,
};
use telo_analyzer::native_entries::{normalize_native_path, PathVerdict};
use telo_analyzer::source_entries::ModuleSources;

use crate::bundle::module_artifact::{host_platform_target, ModuleFiles};
use crate::bundle::source_staging::{ensure_staged_entry, EnsuredEntryState, StagingError};
use crate::controller_loaders::cargo_loader::{manifest_dir, EnvMissing, ResolveError};
use crate::controller_loaders::native_abi::LoadedController;
use crate::controller_loaders::purl::Purl;
use crate::error::KernelError;
use crate::lexical_path;

/// The one `pkg:telo/local/<format>` this loader hosts.
const DYLIB_FORMAT: &str = "dylib";

fn env_missing(reason: String) -> ResolveError {
    ResolveError::EnvMissing(EnvMissing { reason })
}

thread_local! {
    /// Keyed on the resolved library path plus entry, for the reason
    /// `cargo_loader`'s cache is: two kinds of one module share one `dlopen`
    /// and one `register`. Per thread, because the entries are `Rc`.
    static LOADED: RefCell<HashMap<String, Rc<LoadedController>>> = RefCell::new(HashMap::new());
    /// Staged libraries already verified against their pins, so every kind a
    /// module selects out of one library hashes it once.
    static VERIFIED: RefCell<HashSet<PathBuf>> = RefCell::new(HashSet::new());
}

pub struct DylibControllerLoader;

impl DylibControllerLoader {
    /// Resolve and open one candidate. `files` is where the declaring module's
    /// files are, and `sources` its `sources:` block as read at load.
    pub fn resolve(
        &self,
        purl: &str,
        base_uri: &str,
        files: &ModuleFiles,
        sources: Option<&ModuleSources>,
    ) -> Result<Rc<LoadedController>, ResolveError> {
        let parsed = Purl::parse(purl)
            .filter(|parsed| parsed.purl_type == "telo")
            .ok_or_else(|| env_missing(format!("Unparseable pkg:telo PURL \"{purl}\"")))?;
        if parsed.namespace.as_deref() != Some("local") {
            return Err(env_missing(format!(
                "pkg:telo controller \"{purl}\" must use the \"local\" namespace (pkg:telo/local/<format>); got \"{}\"",
                parsed.namespace.as_deref().unwrap_or("(none)")
            )));
        }
        let format = parsed.name.as_str();
        if format != DYLIB_FORMAT {
            return Err(env_missing(format!(
                "pkg:telo controller \"{purl}\": format \"{format}\" is not hostable by the Rust kernel (it loads \"{DYLIB_FORMAT}\")"
            )));
        }
        let Some(relative) = parsed.qualifiers.get("path") else {
            return Err(env_missing(format!(
                "pkg:telo controller \"{purl}\" is missing a \"path\" qualifier"
            )));
        };

        // An invalid selector is the author's manifest, not this host's
        // environment, so it fails rather than falling through.
        let selector = selector_from_qualifiers(format, &parsed.qualifiers, &format!("controller \"{purl}\""))
            .map_err(|err: ArtifactSelectorError| {
                ResolveError::Fatal(KernelError::new(ArtifactSelectorError::CODE, err.detail))
            })?;
        let host = host_platform_target();
        if !selector_matches(&selector, host) {
            let axes: Vec<String> = PlatformAxis::ALL
                .into_iter()
                .map(|axis| {
                    host.axes
                        .get(axis)
                        .map_or_else(|| format!("unknown {}", axis.name()), str::to_string)
                })
                .collect();
            return Err(env_missing(format!(
                "pkg:telo controller \"{purl}\" targets {}, which does not match this host ({})",
                describe_selector(&selector),
                axes.join("/")
            )));
        }

        let dir: PathBuf = match files {
            ModuleFiles::Artifact(artifact) => match artifact.materialize_controller(&selector)? {
                Some(layer) => layer.dir,
                None => {
                    return Err(env_missing(format!(
                        "pkg:telo controller \"{purl}\": the module artifact ships no layer for {} (has: {})",
                        describe_selector(&selector),
                        artifact.describe_layers()
                    )))
                }
            },
            ModuleFiles::Unlocatable => {
                return Err(env_missing(format!(
                    "pkg:telo controller \"{purl}\" cannot be located: the declaring module resolved from \
                     \"{base_uri}\", fetched from a registry with no layer index. A bundled controller ships \
                     in its module's artifact — republish the module, or import it from a local path during \
                     development."
                )))
            }
            // A module already on disk: its files sit next to the manifest, and a
            // staged one is staged on first use and read only once it matches its
            // pin. A stale one may still be on disk, and it is never the one opened.
            ModuleFiles::OnDisk => {
                let dir = manifest_dir(base_uri);
                if let Some(reason) = assert_staged_library(purl, &dir, relative, sources)? {
                    return Err(env_missing(format!(
                        "pkg:telo controller \"{purl}\": the library '{relative}' is not available — {reason}"
                    )));
                }
                dir
            }
        };

        let library = lexical_path::normalize(&dir.join(relative));
        if !library.is_file() {
            return Err(env_missing(format!(
                "pkg:telo controller library not found at \"{}\" (from \"{purl}\")",
                library.display()
            )));
        }
        let entry = parsed
            .subpath
            .unwrap_or_else(|| telorun_abi::DEFAULT_ENTRY.to_string());
        let cache_key = format!("{}\0{entry}", library.display());
        if let Some(cached) = LOADED.with(|cache| cache.borrow().get(&cache_key).cloned()) {
            return Ok(cached);
        }
        let loaded = unsafe { LoadedController::open(&library, &entry, purl) }?;
        LOADED.with(|cache| cache.borrow_mut().insert(cache_key, Rc::clone(&loaded)));
        Ok(loaded)
    }
}

fn staged_invalid(message: String) -> ResolveError {
    ResolveError::Fatal(KernelError::new("ERR_STAGED_FILE_INVALID", message))
}

/// Stage a library its `sources:` block stages, and refuse one that is unpinned or
/// does not match its pin, or whose staging cannot be known because the block does
/// not read — the rule the Node kernel applies to a staged `napi` addon. Returns
/// why the library could not be fetched, which the caller reports as env-missing
/// so the next candidate still gets its turn. Any other staging failure (a lock, a
/// write) is `ERR_STAGING_FAILED`.
fn assert_staged_library(
    purl: &str,
    module_dir: &Path,
    relative: &str,
    sources: Option<&ModuleSources>,
) -> Result<Option<String>, ResolveError> {
    let (PathVerdict::Path(path), Some(sources)) = (normalize_native_path(relative.trim()), sources) else {
        return Ok(None);
    };
    let key = module_dir.join(&path);
    if VERIFIED.with(|verified| verified.borrow().contains(&key)) {
        return Ok(None);
    }
    for source in &sources.sources {
        let Some(entry) = source.entries.iter().find(|candidate| candidate.path() == path) else {
            continue;
        };
        let by = format!(
            "pkg:telo controller \"{purl}\": the library '{path}' is staged by source '{}'",
            source.name
        );
        let state = match ensure_staged_entry(module_dir, source, entry) {
            Ok(state) => state,
            Err(StagingError::Fetch(detail)) => {
                return Ok(Some(format!("it is staged by source '{}': {detail}", source.name)))
            }
            Err(err @ StagingError::Content(_)) => {
                return Err(staged_invalid(format!("{by}, {}", err.describe())))
            }
            Err(err @ StagingError::Failed(_)) => {
                return Err(ResolveError::Fatal(KernelError::new(
                    "ERR_STAGING_FAILED",
                    format!("{by}, {}", err.describe()),
                )))
            }
        };
        return match state {
            EnsuredEntryState::Match => {
                VERIFIED.with(|verified| verified.borrow_mut().insert(key));
                Ok(None)
            }
            EnsuredEntryState::Unpinned => Err(staged_invalid(format!(
                "{by}, which carries no pin to verify it against — run `telo release stage --pin`."
            ))),
        };
    }
    if !sources.problems.is_empty() {
        let problems: Vec<String> = sources.problems.iter().map(|p| format!("  {}", p.message)).collect();
        return Err(staged_invalid(format!(
            "pkg:telo controller \"{purl}\": the module's sources: block cannot be read, so whether the \
             library '{path}' is staged — and what it must hash to — is unknown:\n{}\nRun `telo check` \
             on the module.",
            problems.join("\n")
        )));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use telo_analyzer::source_entries::read_module_sources;

    fn sources(url: &str, sha256: &str) -> ModuleSources {
        read_module_sources(&json!({ "sources": { "console": {
            "version": "1", "url": url, "archive": "tar.gz", "notices": ["LICENSE"],
            "entries": { "rust/libconsole.so": { "upstream": "x", "member": "m", "sha256": sha256, "executable": false } },
        } } }))
    }

    #[test]
    fn stages_a_library_before_it_is_opened_and_never_opens_a_stale_one() {
        use sha2::{Digest, Sha256};
        let bar: String = Sha256::digest(b"bar").iter().map(|b| format!("{b:02x}")).collect();
        let dir = tempfile::tempdir().unwrap();
        let purl = "pkg:telo/local/dylib?path=./rust/libconsole.so";
        // Loopback with nothing listening on port 1, so a fetch fails at once.
        let pinned = sources("https://127.0.0.1:1/x.tgz", &bar);

        let missing = assert_staged_library(purl, dir.path(), "./rust/libconsole.so", Some(&pinned));
        let reason = missing.ok().flatten().expect("an unfetchable library is reported, not opened");
        assert!(reason.contains("staged by source 'console'"), "{reason}");

        std::fs::create_dir_all(dir.path().join("rust")).unwrap();
        std::fs::write(dir.path().join("rust/libconsole.so"), "tampered").unwrap();
        assert!(
            matches!(
                assert_staged_library(purl, dir.path(), "./rust/libconsole.so", Some(&pinned)),
                Ok(Some(_))
            ),
            "a stale library that cannot be restaged is reported, not opened"
        );

        std::fs::write(dir.path().join("rust/libconsole.so"), "bar").unwrap();
        assert!(matches!(
            assert_staged_library(purl, dir.path(), "./rust/libconsole.so", Some(&pinned)),
            Ok(None)
        ));

        let unreadable = sources("http://e.test/x.tgz", &bar);
        let other = tempfile::tempdir().unwrap();
        match assert_staged_library(purl, other.path(), "./rust/libconsole.so", Some(&unreadable)) {
            Err(ResolveError::Fatal(err)) => assert!(err.message.contains("cannot be read"), "{err}"),
            _ => panic!("an unreadable sources: block must refuse the read"),
        }
    }
}

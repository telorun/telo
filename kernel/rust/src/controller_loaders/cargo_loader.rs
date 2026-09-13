//! `pkg:cargo` controller loader.
//! Mirrors `../../../nodejs/src/controller-loaders/napi-loader.ts` — same PURL,
//! same dev-mode build-on-load, same recoverable/fatal split; the difference is
//! what it produces, a `cdylib` opened through the C ABI rather than a `.node`.
//!
//! The recoverable/fatal boundary is the load-bearing decision: a missing
//! `rustc` or a missing `local_path` is a property of the host, so the
//! dispatcher may try the next candidate; a `cargo build` that ran and failed is
//! the author's broken code, and falling through to another controller would
//! mask it.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;

use serde_json::Value;
use telo_analyzer::DEFAULT_MANIFEST_FILENAME;

use crate::bundle::module_artifact::ModuleFiles;
use crate::controller_loaders::native_abi::LoadedController;
use crate::controller_loaders::purl::Purl;
use crate::error::KernelError;
use crate::lexical_path;
use crate::manifest_sources::local_manifest_cache_source::resolve_cache_root;

/// The SDK crate whose backend feature selects the FFI bridge.
const SDK_CRATE_NAME: &str = "telorun-sdk";

/// The SDK feature this kernel's controllers are built with. A crate built on
/// `telorun-sdk` carries no `[features]` block of its own, so the backend can
/// only be selected as a dependency feature from the outside —
/// `--no-default-features` here would apply to the controller crate, not to the
/// SDK.
///
/// Passed only when the crate actually depends on the SDK: `pkg:cargo` names a
/// Rust controller, not an SDK user, and a crate exporting the ABI symbols by
/// hand is legitimate. Naming a feature of a dependency it does not have is a
/// hard cargo error, so guessing costs the build.
const SDK_BACKEND_FEATURE: &str = "telorun-sdk/native";

/// Resolution outcome that is *not* a failure of the author's code, so the
/// dispatcher may advance to the next candidate.
pub struct EnvMissing {
    pub reason: String,
}

pub enum ResolveError {
    EnvMissing(EnvMissing),
    Fatal(KernelError),
}

impl From<KernelError> for ResolveError {
    fn from(err: KernelError) -> Self {
        ResolveError::Fatal(err)
    }
}

fn env_missing(reason: impl Into<String>) -> ResolveError {
    ResolveError::EnvMissing(EnvMissing {
        reason: reason.into(),
    })
}

thread_local! {
    /// Cache keyed on the canonical crate path plus entry: two imports reaching
    /// the same crate share one build and one `dlopen`, rather than getting two
    /// vtables and two copies of whatever `register` set up.
    ///
    /// **Per thread, not per process**, because the entries are `Rc` — the whole
    /// kernel is single-threaded by construction. One kernel run is therefore
    /// one thread and the guarantee holds for it; a host that ran two kernels on
    /// two threads would build and `register` once each. Making it process-wide
    /// means making `LoadedController` `Send + Sync`, which is a threading model
    /// this kernel does not have yet.
    static LOADED: RefCell<HashMap<String, Rc<LoadedController>>> = RefCell::new(HashMap::new());
}

pub struct CargoControllerLoader;

impl CargoControllerLoader {
    /// `files` is where the declaring module's files are: a crate is built only
    /// from a source checkout. A published module's directory holds whatever its
    /// layers shipped, which is never the crate its binaries were built from, so
    /// building there would compile a copy nobody pinned — the candidate falls
    /// through to one the artifact ships instead.
    pub fn resolve(
        &self,
        purl: &str,
        base_uri: &str,
        files: &ModuleFiles,
    ) -> Result<Rc<LoadedController>, ResolveError> {
        let parsed = Purl::parse(purl)
            .filter(|parsed| parsed.purl_type == "cargo")
            .ok_or_else(|| env_missing(format!("unparseable pkg:cargo PURL: {purl}")))?;
        match files {
            ModuleFiles::OnDisk => {}
            ModuleFiles::Artifact(_) => {
                return Err(env_missing(
                    "pkg:cargo builds a crate from a source checkout, and the declaring module was loaded \
                     from a published artifact, which ships no crate to build",
                ))
            }
            ModuleFiles::Unlocatable => {
                return Err(env_missing(
                    "pkg:cargo builds a crate from a source checkout, and the declaring module was fetched \
                     from a registry",
                ))
            }
        }
        let Some(local_path) = parsed.qualifiers.get("local_path") else {
            return Err(env_missing(
                "pkg:cargo distribution-mode resolution is not implemented; supply ?local_path=...",
            ));
        };

        let manifest_dir = manifest_dir(base_uri);
        let crate_path = lexical_path::normalize(&manifest_dir.join(local_path));
        if !crate_path.join("Cargo.toml").is_file() {
            return Err(env_missing(format!(
                "pkg:cargo local_path has no Cargo.toml: {}",
                crate_path.display()
            )));
        }

        let entry = parsed
            .subpath
            .clone()
            .unwrap_or_else(|| telorun_abi::DEFAULT_ENTRY.to_string());
        let cache_key = format!("{}\0{entry}", crate_path.display());
        if let Some(cached) = LOADED.with(|cache| cache.borrow().get(&cache_key).cloned()) {
            return Ok(cached);
        }

        probe_rustc()?;
        let dylib = build_cdylib(&crate_path, &parsed.name)?;
        let loaded = unsafe { LoadedController::open(&dylib, &entry, purl) }?;
        LOADED.with(|cache| {
            cache
                .borrow_mut()
                .insert(cache_key, Rc::clone(&loaded))
        });
        Ok(loaded)
    }
}

/// A missing toolchain is the host's business, not the author's — probed before
/// `cargo build` so the two outcomes stay distinguishable.
fn probe_rustc() -> Result<(), ResolveError> {
    match Command::new("rustc").arg("--version").output() {
        Ok(output) if output.status.success() => Ok(()),
        _ => Err(env_missing("rustc not found on PATH")),
    }
}

fn build_cdylib(crate_path: &Path, crate_name: &str) -> Result<PathBuf, ResolveError> {
    // A dedicated target directory keeps this build off the workspace lock the
    // caller may already hold — `telo-rs` itself is often run through cargo. It
    // is anchored at the workspace marker rather than inside the crate, so every
    // controller crate in one repo shares a dependency build instead of each
    // carrying its own copy; cargo already handles many packages in one target
    // directory, and this is still not the workspace target, so the anti-lock
    // property is unchanged.
    //
    // KEYED BY SDK BACKEND, and that is not cosmetic: the Node kernel builds
    // these same crates with `telorun-sdk/napi` while this one uses `native`, and
    // the two are kept apart today only by the accident that Node's loader takes
    // cargo's default target directory. Give both one directory and every
    // alternation between kernels rebuilds the whole dependency tree.
    let target_dir = resolve_cache_root(crate_path)
        .map_err(|err| {
            ResolveError::Fatal(KernelError::controller_build_failed(format!(
                "cannot resolve the build cache for {}: the working directory cannot be read: {err}",
                crate_path.display()
            )))
        })?
        .join("cargo")
        .join(SDK_BACKEND_FEATURE.rsplit('/').next().unwrap_or(SDK_BACKEND_FEATURE))
        .join("target");
    let mut args = vec!["build", "--release"];
    if depends_on_sdk(crate_path, crate_name)? {
        args.extend(["--features", SDK_BACKEND_FEATURE]);
    }
    args.extend(["--message-format", "json-render-diagnostics"]);
    let output = Command::new("cargo")
        .current_dir(crate_path)
        .env("CARGO_TARGET_DIR", &target_dir)
        .args(&args)
        .output()
        .map_err(|err| {
            ResolveError::EnvMissing(EnvMissing {
                reason: format!("cargo not found on PATH: {err}"),
            })
        })?;

    if !output.status.success() {
        return Err(ResolveError::Fatal(KernelError::controller_build_failed(
            format!(
                "cargo build failed for {}:\n{}",
                crate_path.display(),
                String::from_utf8_lossy(&output.stderr)
            ),
        )));
    }

    find_cdylib(&output.stdout, crate_name).ok_or_else(|| {
        ResolveError::Fatal(KernelError::controller_build_failed(format!(
            "cargo build succeeded but produced no cdylib for `{crate_name}` in {}. Does its Cargo.toml declare `crate-type = [\"cdylib\", \"rlib\"]`?",
            crate_path.display()
        )))
    })
}

/// Whether the crate lists `telorun-sdk` among its dependencies, which decides
/// whether the backend feature is passed.
///
/// Read with `cargo metadata --no-deps`, so it reflects the resolved manifest
/// rather than a hand-parse of `Cargo.toml`. A crate whose metadata cannot be
/// read is treated as SDK-free: the build that follows produces the real error,
/// and inventing one here would report it against the wrong operation.
fn depends_on_sdk(crate_path: &Path, crate_name: &str) -> Result<bool, ResolveError> {
    let output = Command::new("cargo")
        .current_dir(crate_path)
        .args(["metadata", "--format-version", "1", "--no-deps"])
        .output()
        .map_err(|err| {
            ResolveError::EnvMissing(EnvMissing {
                reason: format!("cargo not found on PATH: {err}"),
            })
        })?;
    if !output.status.success() {
        return Ok(false);
    }
    let Ok(metadata) = serde_json::from_slice::<Value>(&output.stdout) else {
        return Ok(false);
    };
    let Some(packages) = metadata.get("packages").and_then(Value::as_array) else {
        return Ok(false);
    };
    // Matched by package name — the same key `find_cdylib` uses to pick the
    // artifact — because `--no-deps` inside a workspace still lists every
    // member, and comparing manifest paths would turn a symlinked checkout into
    // a silent miss.
    Ok(packages
        .iter()
        .filter(|package| package.get("name").and_then(Value::as_str) == Some(crate_name))
        .filter_map(|package| package.get("dependencies").and_then(Value::as_array))
        .flatten()
        .any(|dependency| {
            dependency.get("name").and_then(Value::as_str) == Some(SDK_CRATE_NAME)
        }))
}

/// Read the built artifact straight out of cargo's JSON message stream. Asking
/// cargo what it produced beats reconstructing a path from the target directory
/// and platform naming rules.
fn find_cdylib(stdout: &[u8], crate_name: &str) -> Option<PathBuf> {
    let normalized_name = crate_name.replace('-', "_");
    for line in String::from_utf8_lossy(stdout).lines() {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if message.get("reason").and_then(Value::as_str) != Some("compiler-artifact") {
            continue;
        }
        let target = message.get("target")?;
        let is_cdylib = target
            .get("kind")
            .and_then(Value::as_array)
            .is_some_and(|kinds| kinds.iter().any(|kind| kind.as_str() == Some("cdylib")));
        if !is_cdylib {
            continue;
        }
        let name_matches = target
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| name.replace('-', "_") == normalized_name);
        if !name_matches {
            continue;
        }
        let filenames = message.get("filenames")?.as_array()?;
        for filename in filenames {
            let path = PathBuf::from(filename.as_str()?);
            if matches!(
                path.extension().and_then(|ext| ext.to_str()),
                Some("so" | "dylib" | "dll")
            ) {
                return Some(path);
            }
        }
    }
    None
}

/// The directory of the manifest a definition was declared in.
pub(crate) fn manifest_dir(base_uri: &str) -> PathBuf {
    let path = Path::new(base_uri);
    if path.file_name().map(|name| name == DEFAULT_MANIFEST_FILENAME) == Some(true) || path.is_file()
    {
        return path.parent().unwrap_or(Path::new(".")).to_path_buf();
    }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::files_integrity::PayloadFile;
    use crate::bundle::module_artifact::{LayerFetcher, ModuleArtifact};

    struct NoLayers;

    impl LayerFetcher for NoLayers {
        fn fetch_layer(&self, _pinned_ref: &str, blob: &str) -> Result<Vec<PayloadFile>, KernelError> {
            Err(KernelError::new("ERR_TEST", format!("fetched {blob}")))
        }
    }

    /// A crate source beside a published module's manifest is not built: the
    /// candidate falls through before anything is read or compiled.
    #[test]
    fn falls_through_for_a_published_or_unlocatable_module() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("rust")).unwrap();
        std::fs::write(dir.path().join("rust/Cargo.toml"), "[package]\nname = \"x\"\n").unwrap();
        let base = dir.path().join("telo.yaml").display().to_string();
        let artifact = ModuleArtifact::new("oci://r.test/x@1".into(), Vec::new(), dir.path().into(), Rc::new(NoLayers)).unwrap();
        for files in [ModuleFiles::Artifact(Rc::new(artifact)), ModuleFiles::Unlocatable] {
            match CargoControllerLoader.resolve("pkg:cargo/x?local_path=./rust", &base, &files) {
                Err(ResolveError::EnvMissing(missing)) => assert!(missing.reason.contains("source checkout"), "{}", missing.reason),
                Err(ResolveError::Fatal(err)) => panic!("expected a fall-through, got {err}"),
                Ok(_) => panic!("expected a fall-through, got a controller"),
            }
        }
    }
}


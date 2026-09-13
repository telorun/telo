//! A loaded module's artifact: materializing its layers by selector, and the
//! host target they are matched against. Mirrors
//! `../../../nodejs/src/bundle/module-artifact.ts`.
//!
//! Built at module load, where the **pinned** import ref and the verified
//! manifest are both in hand: a controller loader sees only the canonical base
//! URI, which carries no `#sha256-`, so a loader that fetched for itself would
//! trust whatever is on disk instead of the importer's pin.
//!
//! What the Node file has and this one lacks, each for want of a consumer:
//! `materializeLibrary` (a dependent's JS bundle resolving a sibling's
//! specifier), `materializeNative` (`ctx.resolveNativeFile`) and `materializeAll`
//! / `warmPlan` (`telo install`'s warm). Node's in-flight promise map and
//! `transferred` progress flag become a completed-layer memo: this kernel is
//! synchronous and reports no download progress.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::OnceLock;

use telo_analyzer::artifact_layer_index::{code_layer_for, singleton_layer, ArtifactLayer};
use telo_analyzer::artifact_selector::{
    describe_selector, ArtifactSelector, LayerRole, PlatformAxis, PlatformTarget,
};
use telo_analyzer::source_entries::ModuleSources;
use telo_analyzer::sources::integrity::split_integrity;

use crate::bundle::files_integrity::{compute_files_integrity, PayloadFile};
use crate::bundle::layer_entry_rules::{describe_layer_violations, find_layer_violations};
use crate::directory_lock::with_directory_lock;
use crate::error::KernelError;
use crate::lexical_path;
use crate::manifest_sources::local_manifest_cache_source::cache_path_for_canonical;

/// Where a layer's files come from — the OCI source in production. The fetcher
/// verifies the transfer against `blob`; the artifact verifies the contents.
pub trait LayerFetcher {
    fn fetch_layer(&self, pinned_ref: &str, blob: &str) -> Result<Vec<PayloadFile>, KernelError>;
}

/// The module directory a materialization extracted into, and the
/// module-relative paths of the code layers it wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializedLayer {
    pub dir: PathBuf,
    pub files: Vec<String>,
}

/// `std::env::consts::OS` in the OCI/GOOS vocabulary a selector is published in.
fn host_os() -> Option<String> {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        os @ ("linux" | "windows" | "freebsd" | "openbsd" | "netbsd" | "dragonfly" | "illumos"
        | "solaris" | "android" | "ios" | "aix") => os,
        _ => return None,
    };
    Some(os.to_string())
}

/// `std::env::consts::ARCH` in the OCI/GOARCH vocabulary.
fn host_arch() -> Option<String> {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "x86" => "386",
        "aarch64" => "arm64",
        "arm" => "arm",
        "powerpc64" if cfg!(target_endian = "little") => "ppc64le",
        "powerpc64" => "ppc64",
        "s390x" => "s390x",
        "riscv64" => "riscv64",
        "loongarch64" => "loong64",
        _ => return None,
    };
    Some(arch.to_string())
}

/// The libc this binary is linked against. Decided at compile time — a Rust
/// binary links exactly one — and undetermined off Linux or for a C library the
/// vocabulary does not name, which is never guessed.
fn host_libc() -> Option<String> {
    if std::env::consts::OS != "linux" {
        return None;
    }
    if cfg!(target_env = "gnu") {
        Some("gnu".to_string())
    } else if cfg!(target_env = "musl") {
        Some("musl".to_string())
    } else {
        None
    }
}

/// The platform this kernel runs on, in the published vocabulary. `abi` is the
/// controller ABI this kernel loads, `telo-<TELO_ABI_VERSION>`.
pub fn host_platform_target() -> &'static PlatformTarget {
    static HOST: OnceLock<PlatformTarget> = OnceLock::new();
    HOST.get_or_init(|| {
        let mut target = PlatformTarget::default();
        for axis in PlatformAxis::ALL {
            // Exhaustive, so an axis added to the vocabulary fails to compile
            // here until this host can answer it.
            let value = match axis {
                PlatformAxis::Os => host_os(),
                PlatformAxis::Arch => host_arch(),
                PlatformAxis::Libc => host_libc(),
                PlatformAxis::Abi => Some(format!("telo-{}", telorun_abi::TELO_ABI_VERSION)),
            };
            target.axes.set(axis, value);
        }
        target
    })
}

/// Where a loaded module's own files are.
#[derive(Clone)]
pub enum ModuleFiles {
    /// Beside its manifest: a module read from a local path.
    OnDisk,
    /// In the layers of its published artifact, materialized on demand.
    Artifact(Rc<ModuleArtifact>),
    /// Nowhere this kernel can reach: a module fetched from a registry whose
    /// manifest carries no layer index — one published before layers.
    Unlocatable,
}

/// What one kernel run learned, at load, about each module's files: its artifact
/// (or why it has none) and its `sources:` block. Keyed by the canonical `source`
/// a definition's controller resolves against.
#[derive(Default)]
pub struct ModuleArtifacts {
    by_source: RefCell<HashMap<String, Rc<ModuleArtifact>>>,
    unlocatable: RefCell<HashSet<String>>,
    sources: RefCell<HashMap<String, Rc<ModuleSources>>>,
}

impl ModuleArtifacts {
    pub fn register(&self, source: &str, artifact: Rc<ModuleArtifact>) {
        self.by_source.borrow_mut().insert(source.to_string(), artifact);
    }

    /// Record that the module at `source` came from a registry with no layer
    /// index, so its files cannot be located.
    pub fn register_unlocatable(&self, source: &str) {
        self.unlocatable.borrow_mut().insert(source.to_string());
    }

    pub fn register_sources(&self, source: &str, sources: ModuleSources) {
        self.sources.borrow_mut().insert(source.to_string(), Rc::new(sources));
    }

    /// The artifact of the module whose manifest resolved from `source`, or
    /// `None` for a module with no payload layers.
    pub fn get(&self, source: &str) -> Option<Rc<ModuleArtifact>> {
        self.by_source.borrow().get(source).cloned()
    }

    pub fn files(&self, source: &str) -> ModuleFiles {
        if let Some(artifact) = self.get(source) {
            return ModuleFiles::Artifact(artifact);
        }
        if self.unlocatable.borrow().contains(source) {
            return ModuleFiles::Unlocatable;
        }
        ModuleFiles::OnDisk
    }

    /// The `sources:` block of the module at `source`, as read at load.
    pub fn sources(&self, source: &str) -> Option<Rc<ModuleSources>> {
        self.sources.borrow().get(source).cloned()
    }
}

pub struct ModuleArtifact {
    /// The importer's pinned ref, as written — what keeps verification anchored.
    pinned_ref: String,
    layers: Vec<ArtifactLayer>,
    dir: PathBuf,
    fetcher: Rc<dyn LayerFetcher>,
    /// Materialized layers by blob digest, with the paths each wrote.
    materialized: RefCell<HashMap<String, Vec<String>>>,
}

impl ModuleArtifact {
    pub fn new(
        pinned_ref: String,
        layers: Vec<ArtifactLayer>,
        dir: PathBuf,
        fetcher: Rc<dyn LayerFetcher>,
    ) -> Result<Self, KernelError> {
        let dir = lexical_path::absolute(&dir).map_err(|err| {
            KernelError::new(
                "ERR_MODULE_LAYER_EXTRACT_FAILED",
                format!(
                    "Cannot place the layers of {pinned_ref}: '{}' is relative and the working directory cannot be read: {err}",
                    dir.display()
                ),
            )
        })?;
        Ok(Self {
            pinned_ref,
            layers,
            dir,
            fetcher,
            materialized: RefCell::new(HashMap::new()),
        })
    }

    /// Where every layer of the module extracts.
    pub fn directory(&self) -> &Path {
        &self.dir
    }

    /// Materialize the code layers carrying exactly `selector` — `controller`
    /// and `library` both, since a file named by both lands in `library` — plus
    /// the `common` sink. `None` when the artifact ships no code layer for the
    /// selector, which is how a loader learns to fall through.
    ///
    /// By exact key, never by re-matching the host: the candidate already IS
    /// one selector, and re-matching would take the first host-compatible layer
    /// whichever candidate asked.
    pub fn materialize_controller(
        &self,
        selector: &ArtifactSelector,
    ) -> Result<Option<MaterializedLayer>, KernelError> {
        let wanted: Vec<&ArtifactLayer> = [LayerRole::Controller, LayerRole::Library]
            .into_iter()
            .filter_map(|role| code_layer_for(&self.layers, role, selector))
            .collect();
        if wanted.is_empty() {
            return Ok(None);
        }
        if let Some(common) = singleton_layer(&self.layers, LayerRole::Common) {
            self.materialize(common)?;
        }
        let mut files = Vec::new();
        for layer in wanted {
            files.extend(self.materialize(layer)?);
        }
        files.sort();
        Ok(Some(MaterializedLayer {
            dir: self.dir.clone(),
            files,
        }))
    }

    /// Materialize everything a module-relative file read could need: the
    /// `assets` layer and the `common` layer, where the sink rule puts a file no
    /// declaration claimed.
    pub fn materialize_module_files(&self) -> Result<(), KernelError> {
        for role in [LayerRole::Assets, LayerRole::Common] {
            if let Some(layer) = singleton_layer(&self.layers, role) {
                self.materialize(layer)?;
            }
        }
        Ok(())
    }

    /// What this artifact ships, for a diagnostic explaining why nothing matched.
    pub fn describe_layers(&self) -> String {
        if self.layers.is_empty() {
            return "(no payload layers)".to_string();
        }
        self.layers
            .iter()
            .map(|layer| match &layer.selector {
                Some(selector) => format!("{} {}", layer.role.name(), describe_selector(selector)),
                None => layer.role.name().to_string(),
            })
            .collect::<Vec<_>>()
            .join(", ")
    }

    fn materialize(&self, layer: &ArtifactLayer) -> Result<Vec<String>, KernelError> {
        if let Some(files) = self.materialized.borrow().get(&layer.blob) {
            return Ok(files.clone());
        }
        let marker = self.marker_path(layer);
        let files = if marker.exists() {
            self.read_marker(&marker, layer)?
        } else {
            with_directory_lock(&self.dir, "module layer", || {
                // A peer may have extracted this layer while we waited.
                if marker.exists() {
                    return self.read_marker(&marker, layer);
                }
                let files = self.fetcher.fetch_layer(&self.pinned_ref, &layer.blob)?;
                let actual = compute_files_integrity(&files);
                if actual != layer.integrity {
                    return Err(KernelError::new(
                        "ERR_MODULE_LAYER_INTEGRITY",
                        format!(
                            "Integrity check failed for the {} layer of {}: expected {}, got {actual}. \
                             The layer's contents do not match the digest recorded in the module's pinned \
                             telo.yaml — it may have been tampered with or republished.",
                            layer.role.name(),
                            self.pinned_ref,
                            layer.integrity
                        ),
                    ));
                }
                self.assert_extractable(&files, layer)?;
                let written = self.extract(&files, layer)?;
                // Last, so an interrupted extraction leaves no marker and re-runs.
                let mut body = written.join("\n");
                body.push('\n');
                fs::write(&marker, body).map_err(|err| {
                    self.extract_failed(layer, &marker.display().to_string(), err)
                })?;
                Ok(written)
            })?
        };
        self.materialized
            .borrow_mut()
            .insert(layer.blob.clone(), files.clone());
        Ok(files)
    }

    /// Keyed by the blob digest, so a republish to different bytes re-extracts
    /// instead of reading as already present. The role is for a human reader.
    fn marker_path(&self, layer: &ArtifactLayer) -> PathBuf {
        let hex = layer.blob.strip_prefix("sha256:").unwrap_or(&layer.blob);
        let short = &hex[..hex.len().min(16)];
        self.dir
            .join(format!(".telo-layer-{}-{short}", layer.role.name()))
    }

    fn read_marker(&self, marker: &Path, layer: &ArtifactLayer) -> Result<Vec<String>, KernelError> {
        let text = fs::read_to_string(marker)
            .map_err(|err| self.extract_failed(layer, &marker.display().to_string(), err))?;
        Ok(text.lines().filter(|line| !line.is_empty()).map(str::to_string).collect())
    }

    /// Every entry is checked before anything is written, so a refused layer
    /// leaves the module directory untouched.
    fn assert_extractable(&self, files: &[PayloadFile], layer: &ArtifactLayer) -> Result<(), KernelError> {
        if let Some(escaping) = files.iter().find(|entry| {
            let dest = lexical_path::normalize(&self.dir.join(entry.name()));
            dest == self.dir || !dest.starts_with(&self.dir)
        }) {
            return Err(KernelError::new(
                "ERR_MODULE_LAYER_INVALID",
                format!(
                    "The {} layer of {} contains entry '{}', which resolves outside the module's cache directory.",
                    layer.role.name(),
                    self.pinned_ref,
                    escaping.name()
                ),
            ));
        }
        let violations = find_layer_violations(files);
        if !violations.is_empty() {
            return Err(KernelError::new(
                "ERR_MODULE_LAYER_INVALID",
                format!(
                    "The {} layer of {} has entries that cannot be extracted within the module directory:\n{}\n\
                     Entry paths must be unique and none may run through another entry; a link must resolve, \
                     within the module directory, to a file shipped in the same layer. The module has to be \
                     republished with a layer that satisfies both.",
                    layer.role.name(),
                    self.pinned_ref,
                    describe_layer_violations(&violations)
                ),
            ));
        }
        Ok(())
    }

    fn extract(&self, files: &[PayloadFile], layer: &ArtifactLayer) -> Result<Vec<String>, KernelError> {
        let dir_text = self.dir.display().to_string();
        fs::create_dir_all(&self.dir).map_err(|err| self.extract_failed(layer, &dir_text, err))?;
        let real_root =
            fs::canonicalize(&self.dir).map_err(|err| self.extract_failed(layer, &dir_text, err))?;
        let mut confined: HashSet<PathBuf> = HashSet::new();
        let mut written = Vec::with_capacity(files.len());
        for entry in files {
            let dest = lexical_path::normalize(&self.dir.join(entry.name()));
            self.confine_parent(&real_root, &dest, entry.name(), layer, &mut confined)?;
            let failed = |err| self.extract_failed(layer, entry.name(), err);
            // Replaced rather than written over: writing through a link left by
            // an earlier extraction would change its target, and an existing
            // file keeps its mode.
            match fs::symlink_metadata(&dest) {
                Ok(_) => fs::remove_file(&dest).map_err(failed)?,
                Err(err) if err.kind() == ErrorKind::NotFound => {}
                Err(err) => return Err(failed(err)),
            }
            match entry {
                PayloadFile::Link { link, .. } => symlink(link, &dest).map_err(failed)?,
                PayloadFile::Regular {
                    content,
                    executable,
                    ..
                } => {
                    fs::write(&dest, content).map_err(failed)?;
                    if *executable {
                        make_executable(&dest).map_err(failed)?;
                    }
                }
            }
            written.push(entry.name().to_string());
        }
        written.sort();
        Ok(written)
    }

    /// Create `dest`'s parent directories one at a time and require each to be
    /// a real directory under the real module directory, so a symbolic link
    /// already on disk cannot redirect a write or a removal out of it.
    fn confine_parent(
        &self,
        real_root: &Path,
        dest: &Path,
        name: &str,
        layer: &ArtifactLayer,
        confined: &mut HashSet<PathBuf>,
    ) -> Result<(), KernelError> {
        let parent = dest.parent().unwrap_or(&self.dir).to_path_buf();
        if confined.contains(&parent) {
            return Ok(());
        }
        let relative = parent.strip_prefix(&self.dir).unwrap_or(Path::new(""));
        let mut current = self.dir.clone();
        for segment in relative.components() {
            current.push(segment);
            match fs::symlink_metadata(&current) {
                Err(err) if err.kind() == ErrorKind::NotFound => fs::create_dir(&current)
                    .map_err(|err| self.extract_failed(layer, name, err))?,
                Err(err) => return Err(self.extract_failed(layer, name, err)),
                Ok(meta) if !meta.is_dir() => return Err(self.unconfined(name, layer, &current)),
                Ok(_) => {}
            }
        }
        let real_parent =
            fs::canonicalize(&parent).map_err(|err| self.extract_failed(layer, name, err))?;
        if !real_parent.starts_with(real_root) {
            return Err(self.unconfined(name, layer, &parent));
        }
        confined.insert(parent);
        Ok(())
    }

    fn unconfined(&self, name: &str, layer: &ArtifactLayer, blocker: &Path) -> KernelError {
        KernelError::new(
            "ERR_MODULE_LAYER_INVALID",
            format!(
                "Cannot extract entry '{name}' of the {} layer of {}: '{}' is not a directory inside the \
                 module's cache directory ({}). Something other than this layer changed that directory — \
                 remove it and run again to re-materialize the module.",
                layer.role.name(),
                self.pinned_ref,
                blocker.display(),
                self.dir.display()
            ),
        )
    }

    fn extract_failed(&self, layer: &ArtifactLayer, what: &str, err: std::io::Error) -> KernelError {
        KernelError::new(
            "ERR_MODULE_LAYER_EXTRACT_FAILED",
            format!(
                "Cannot materialize the {} layer of {} into {}: '{what}': {err}",
                layer.role.name(),
                self.pinned_ref,
                self.dir.display()
            ),
        )
    }
}

#[cfg(unix)]
fn symlink(target: &str, dest: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, dest)
}

#[cfg(windows)]
fn symlink(target: &str, dest: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, dest)
}

#[cfg(unix)]
fn make_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}

/// Windows carries no execute bit; a file is runnable by its extension.
#[cfg(windows)]
fn make_executable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// The directory a module's layers live in.
///
/// Derived from the **pinned** requested ref, not the canonical `source`: a
/// cache hit is served from `.telo/manifests/`, and the pinned ref places the
/// module identically cold and warm. Layers extract beside the cached manifest,
/// so the pre-workspace-anchor root is chosen when it — and not the current
/// root — holds the manifest. A module read straight off disk resolves to its
/// own directory.
pub fn module_directory_for(
    requested_url: &str,
    source: &str,
    manifests_dir: &Path,
    legacy_dir: Option<&Path>,
) -> Option<PathBuf> {
    let pinned = split_integrity(requested_url).base;
    if let Some(cache_file) = cache_path_for_canonical(pinned, manifests_dir) {
        if let Some(legacy_dir) = legacy_dir {
            if !cache_file.exists() {
                if let Some(legacy_file) = cache_path_for_canonical(pinned, legacy_dir) {
                    if legacy_file.exists() {
                        return legacy_file.parent().map(Path::to_path_buf);
                    }
                }
            }
        }
        return cache_file.parent().map(Path::to_path_buf);
    }
    let source = Path::new(source);
    if source.is_absolute() {
        return source.parent().map(Path::to_path_buf);
    }
    None
}

/// The artifact handle for a loaded module, or `None` when it has no payload
/// layers to materialize or no directory to put them in.
pub fn module_artifact_for(
    pinned_ref: &str,
    layers: Option<Vec<ArtifactLayer>>,
    module_dir: Option<PathBuf>,
    fetcher: Rc<dyn LayerFetcher>,
) -> Result<Option<ModuleArtifact>, KernelError> {
    let (Some(layers), Some(dir)) = (layers.filter(|layers| !layers.is_empty()), module_dir) else {
        return Ok(None);
    };
    ModuleArtifact::new(pinned_ref.to_string(), layers, dir, fetcher).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap as Map;

    const REF: &str = "oci://reg.test/acme/demo@1.0.0#sha256-abc";

    /// Serves canned layers by blob digest and records every fetch, so a test
    /// can prove what was — and was not — transferred.
    #[derive(Default)]
    struct FakeFetcher {
        by_blob: Map<String, Vec<PayloadFile>>,
        fetched: RefCell<Vec<String>>,
    }

    impl LayerFetcher for FakeFetcher {
        fn fetch_layer(&self, _pinned_ref: &str, blob: &str) -> Result<Vec<PayloadFile>, KernelError> {
            self.fetched.borrow_mut().push(blob.to_string());
            self.by_blob
                .get(blob)
                .cloned()
                .ok_or_else(|| KernelError::new("ERR_TEST", format!("no such blob {blob}")))
        }
    }

    fn file(name: &str, content: &str) -> PayloadFile {
        PayloadFile::Regular {
            name: name.into(),
            content: content.as_bytes().to_vec(),
            executable: false,
        }
    }

    fn link(name: &str, target: &str) -> PayloadFile {
        PayloadFile::Link {
            name: name.into(),
            link: target.into(),
        }
    }

    fn selector(format: &str, axes: &[(PlatformAxis, &str)]) -> ArtifactSelector {
        let mut selector = ArtifactSelector {
            format: format.into(),
            axes: Default::default(),
        };
        for (axis, value) in axes {
            selector.axes.set(*axis, Some((*value).to_string()));
        }
        selector
    }

    fn layer(role: LayerRole, blob_char: char, files: &[PayloadFile], selector: Option<ArtifactSelector>) -> ArtifactLayer {
        ArtifactLayer {
            role,
            selector,
            blob: format!("sha256:{}", blob_char.to_string().repeat(64)),
            integrity: compute_files_integrity(files),
        }
    }

    /// An artifact over `layers`, each served with the files it was built from.
    fn artifact(dir: &Path, layers: Vec<(ArtifactLayer, Vec<PayloadFile>)>) -> (ModuleArtifact, Rc<FakeFetcher>) {
        let mut fetcher = FakeFetcher::default();
        for (layer, files) in &layers {
            fetcher.by_blob.insert(layer.blob.clone(), files.clone());
        }
        let fetcher = Rc::new(fetcher);
        let index = layers.into_iter().map(|(layer, _)| layer).collect();
        let artifact = ModuleArtifact::new(REF.into(), index, dir.to_path_buf(), fetcher.clone()).unwrap();
        (artifact, fetcher)
    }

    fn fetched(fetcher: &FakeFetcher) -> Vec<String> {
        let mut blobs = fetcher.fetched.borrow().clone();
        blobs.sort();
        blobs
    }

    fn linux() -> ArtifactSelector {
        selector("dylib", &[(PlatformAxis::Os, "linux"), (PlatformAxis::Arch, "amd64")])
    }

    /// By exact selector, both code roles plus `common`, and nothing else — not
    /// the platform-neutral layer declared first, not `assets`.
    #[test]
    fn materializes_the_code_layers_of_exactly_the_selector_with_common() {
        let dir = tempfile::tempdir().unwrap();
        let neutral_files = vec![file("rust/any.so", "neutral")];
        let controller_files = vec![file("rust/linux/controller.so", "controller")];
        let library_files = vec![file("rust/linux/library.so", "library")];
        let common_files = vec![file("NOTICE", "notice")];
        let assets_files = vec![file("public/index.html", "hi")];
        let neutral = layer(LayerRole::Controller, '1', &neutral_files, Some(selector("dylib", &[])));
        let controller = layer(LayerRole::Controller, '2', &controller_files, Some(linux()));
        let library = layer(LayerRole::Library, '3', &library_files, Some(linux()));
        let common = layer(LayerRole::Common, '4', &common_files, None);
        let assets = layer(LayerRole::Assets, '5', &assets_files, None);
        let expected = vec![controller.blob.clone(), library.blob.clone(), common.blob.clone()];
        let (artifact, fetcher) = artifact(
            dir.path(),
            vec![
                (neutral, neutral_files),
                (controller, controller_files),
                (library, library_files),
                (common, common_files),
                (assets, assets_files),
            ],
        );

        let materialized = artifact.materialize_controller(&linux()).unwrap().unwrap();

        assert_eq!(materialized.files, ["rust/linux/controller.so", "rust/linux/library.so"]);
        assert_eq!(fetched(&fetcher), expected);
        assert_eq!(fs::read_to_string(dir.path().join("rust/linux/controller.so")).unwrap(), "controller");
        assert_eq!(fs::read_to_string(dir.path().join("NOTICE")).unwrap(), "notice");
        assert!(!dir.path().join("public").exists());
        let darwin = selector("dylib", &[(PlatformAxis::Os, "darwin")]);
        assert_eq!(artifact.materialize_controller(&darwin).unwrap(), None);
    }

    #[test]
    fn refuses_contents_that_do_not_match_the_pinned_integrity_before_extracting() {
        let dir = tempfile::tempdir().unwrap();
        let mut controller = layer(LayerRole::Controller, '1', &[file("rust/x.so", "built")], Some(linux()));
        controller.integrity = compute_files_integrity(&[file("rust/x.so", "other")]);
        let (artifact, _) = artifact(dir.path(), vec![(controller, vec![file("rust/x.so", "built")])]);

        let err = artifact.materialize_controller(&linux()).unwrap_err();

        assert_eq!(err.code, "ERR_MODULE_LAYER_INTEGRITY", "{err}");
        assert!(err.message.contains(REF), "{err}");
        assert!(!dir.path().join("rust").exists());
    }

    #[cfg(unix)]
    #[test]
    fn restores_execute_bits_and_links() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let files = vec![
            PayloadFile::Regular {
                name: "native/tool".into(),
                content: b"#!/bin/sh\n".to_vec(),
                executable: true,
            },
            file("native/libx.so.1.2", "elf"),
            link("native/libx.so.1", "libx.so.1.2"),
            link("native/libx.so", "./libx.so.1"),
        ];
        let common = layer(LayerRole::Common, '1', &files, None);
        let code_files = vec![file("rust/x.so", "x")];
        let code = layer(LayerRole::Controller, '2', &code_files, Some(linux()));
        let (artifact, _) = artifact(dir.path(), vec![(common, files), (code, code_files)]);

        artifact.materialize_controller(&linux()).unwrap();

        let mode = |name: &str| fs::metadata(dir.path().join(name)).unwrap().permissions().mode();
        assert_ne!(mode("native/tool") & 0o111, 0);
        assert_eq!(mode("native/libx.so.1.2") & 0o111, 0);
        assert_eq!(fs::read_link(dir.path().join("native/libx.so.1")).unwrap(), Path::new("libx.so.1.2"));
        assert_eq!(fs::read_to_string(dir.path().join("native/libx.so")).unwrap(), "elf");
    }

    /// Mirrors the Node case: every broken link is named with why, and the
    /// layer is refused before anything reaches the disk.
    #[test]
    fn refuses_links_breaking_the_link_rule_before_writing() {
        let dir = tempfile::tempdir().unwrap();
        let files = vec![
            file("lib/real.so", "elf"),
            link("lib/escape.so", "../../outside.so"),
            link("lib/absolute.so", "/usr/lib/libc.so"),
            link("lib/elsewhere.so", "../public/index.html"),
            link("lib/loop.so", "loop2.so"),
            link("lib/loop2.so", "loop.so"),
        ];
        let bad = layer(LayerRole::Controller, '1', &files, Some(linux()));
        let (artifact, _) = artifact(dir.path(), vec![(bad, files)]);

        let err = artifact.materialize_controller(&linux()).unwrap_err();

        assert_eq!(err.code, "ERR_MODULE_LAYER_INVALID", "{err}");
        for expected in [
            "'lib/escape.so' → '../../outside.so': escapes the module directory",
            "'lib/absolute.so' → '/usr/lib/libc.so': is absolute",
            "'lib/elsewhere.so' → '../public/index.html': names 'public/index.html', which no file of the layer has",
            "'lib/loop.so' → 'loop2.so': forms a cycle through 'lib/loop2.so'",
        ] {
            assert!(err.message.contains(expected), "missing {expected:?} in {err}");
        }
        assert!(!err.message.contains("lib/real.so"), "{err}");
        assert!(!dir.path().join("lib").exists());
    }

    /// A link standing where a later entry needs a directory would redirect that
    /// entry's write; the entry-path rule refuses the layer before any write.
    #[test]
    fn refuses_entries_running_through_another_entry_before_writing() {
        let root = tempfile::tempdir().unwrap();
        let module_dir = root.path().join("a/b/module");
        fs::create_dir_all(&module_dir).unwrap();
        let files = vec![
            file("b/x", "x"),
            link("p/q/c", "../../b"),
            link("p/q/c/e", "../../../victim"),
            file("p/q/c/e/pwned", "pwned"),
            file("b", "b"),
            file("victim", "v"),
        ];
        let crafted = layer(LayerRole::Controller, '1', &files, Some(linux()));
        let (artifact, _) = artifact(&module_dir, vec![(crafted, files)]);

        let err = artifact.materialize_controller(&linux()).unwrap_err();

        assert_eq!(err.code, "ERR_MODULE_LAYER_INVALID", "{err}");
        assert!(err.message.contains("'b/x': runs through 'b', another entry of the layer, as a directory"), "{err}");
        assert!(err.message.contains("'p/q/c/e': runs through 'p/q/c', another entry of the layer, as a directory"), "{err}");
        assert_eq!(fs::read_dir(&module_dir).unwrap().count(), 0);
        assert!(!root.path().join("a/victim").exists());
    }

    /// A link already on disk — not part of the layer, so no entry rule sees it —
    /// cannot redirect a write out of the real module directory.
    #[cfg(unix)]
    #[test]
    fn confines_writes_to_the_real_module_directory() {
        let root = tempfile::tempdir().unwrap();
        let module_dir = root.path().join("module");
        let outside = root.path().join("outside");
        fs::create_dir_all(&module_dir).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, module_dir.join("rust")).unwrap();
        let files = vec![file("rust/x.so", "x")];
        let code = layer(LayerRole::Controller, '1', &files, Some(linux()));
        let (artifact, _) = artifact(&module_dir, vec![(code, files)]);

        let err = artifact.materialize_controller(&linux()).unwrap_err();

        assert_eq!(err.code, "ERR_MODULE_LAYER_INVALID", "{err}");
        assert!(err.message.contains("is not a directory inside the module's cache directory"), "{err}");
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    }

    /// The marker is keyed by blob: a later kernel over the same directory reads
    /// the layer off disk, while a republish of the same selector to other bytes
    /// re-extracts rather than passing for already present.
    #[test]
    fn records_completion_keyed_by_the_blob_digest() {
        let dir = tempfile::tempdir().unwrap();
        let files = vec![file("rust/x.so", "v1")];
        let v1 = layer(LayerRole::Controller, '1', &files, Some(linux()));
        let (first, _) = artifact(dir.path(), vec![(v1.clone(), files.clone())]);
        first.materialize_controller(&linux()).unwrap();
        assert!(dir.path().join(format!(".telo-layer-controller-{}", "1".repeat(16))).is_file());

        let (warm, warm_fetcher) = artifact(dir.path(), vec![(v1, files)]);
        warm.materialize_controller(&linux()).unwrap();
        assert!(fetched(&warm_fetcher).is_empty());

        let republished_files = vec![file("rust/x.so", "v2")];
        let v2 = layer(LayerRole::Controller, '2', &republished_files, Some(linux()));
        let (republished, republished_fetcher) = artifact(dir.path(), vec![(v2.clone(), republished_files)]);
        republished.materialize_controller(&linux()).unwrap();
        assert_eq!(fetched(&republished_fetcher), [v2.blob]);
        assert_eq!(fs::read_to_string(dir.path().join("rust/x.so")).unwrap(), "v2");
    }

    /// An extraction that fails part-way leaves no marker, so the next run
    /// extracts again instead of trusting a half-written layer.
    #[test]
    fn writes_the_marker_only_after_every_entry() {
        let dir = tempfile::tempdir().unwrap();
        // A directory where the layer's second entry is a file makes that write fail.
        fs::create_dir_all(dir.path().join("rust/blocker")).unwrap();
        let files = vec![file("rust/a.so", "a"), file("rust/blocker", "b")];
        let code = layer(LayerRole::Controller, '1', &files, Some(linux()));
        let (artifact, _) = artifact(dir.path(), vec![(code, files)]);

        let err = artifact.materialize_controller(&linux()).unwrap_err();

        assert_eq!(err.code, "ERR_MODULE_LAYER_EXTRACT_FAILED", "{err}");
        assert!(dir.path().join("rust/a.so").is_file());
        assert!(!dir.path().join(format!(".telo-layer-controller-{}", "1".repeat(16))).exists());
    }

    /// Warming a foreign tuple's layer into the same module directory does not
    /// change what the host's selector resolves to.
    #[test]
    fn a_warmed_foreign_layer_does_not_shadow_the_hosts() {
        let dir = tempfile::tempdir().unwrap();
        let arm = selector("dylib", &[(PlatformAxis::Os, "linux"), (PlatformAxis::Arch, "arm64")]);
        let host_files = vec![file("rust/linux-amd64/libconsole.so", "amd64")];
        let foreign_files = vec![file("rust/linux-arm64/libconsole.so", "arm64")];
        let host_layer = layer(LayerRole::Controller, '1', &host_files, Some(linux()));
        let foreign_layer = layer(LayerRole::Controller, '2', &foreign_files, Some(arm.clone()));
        let layers = vec![(host_layer, host_files), (foreign_layer, foreign_files)];

        let (run, _) = artifact(dir.path(), layers.clone());
        let before = run.materialize_controller(&linux()).unwrap().unwrap();
        let (warm, _) = artifact(dir.path(), layers.clone());
        warm.materialize_controller(&arm).unwrap().unwrap();
        let (rerun, rerun_fetcher) = artifact(dir.path(), layers);
        let after = rerun.materialize_controller(&linux()).unwrap().unwrap();

        assert_eq!(after, before);
        assert!(fetched(&rerun_fetcher).is_empty());
        assert_eq!(fs::read_to_string(dir.path().join(&after.files[0])).unwrap(), "amd64");
    }

    #[test]
    fn the_host_reports_the_controller_abi_it_loads() {
        assert_eq!(
            host_platform_target().axes.get(PlatformAxis::Abi),
            Some(format!("telo-{}", telorun_abi::TELO_ABI_VERSION).as_str())
        );
    }
}

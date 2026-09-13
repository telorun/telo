//! Boot sequence: load the entry manifest, stand its module scope up, run its
//! `targets`. Mirrors `../../nodejs/src/kernel.ts`.
//!
//! There is no multi-pass init loop here. The Node kernel needs one because CEL
//! lets a resource depend on a value another resource publishes, so an init can
//! defer and be retried. Nothing in this kernel's vocabulary can defer — imports
//! resolve before the resources that reference them, and a `!ref` is resolved
//! before any resource is created — so a single pass in document order is the
//! whole loop. The multi-pass structure belongs here the moment CEL lands.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use serde_json::{json, Value};
use telo_analyzer::{as_resolved_ref, LoadedFile, ManifestLoader, DEFAULT_MANIFEST_FILENAME};

use crate::bundle::module_artifact::{
    module_artifact_for, module_directory_for, LayerFetcher, ModuleArtifacts, ModuleFiles,
};
use crate::bundle::module_manifest::read_owner_manifest;
use crate::controller_loader::ControllerLoader;
use crate::controller_registry::ControllerRegistry;
use crate::controllers::module::module_controller::{load_module, LoadedModule, ModuleRole};
use crate::error::KernelError;
use crate::evaluation_context::ResourceInstance;
use crate::invoke_dispatch;
use crate::lexical_path;
use crate::manifest_sources::local_file_source::LocalFileSource;
use crate::manifest_sources::local_manifest_cache_source::{
    legacy_manifests_dir_fallback, resolve_cache_root, LocalManifestCacheSource,
};
use crate::manifest_sources::oci_source::OciSource;
use crate::module_context::ModuleContext;
use crate::runtime_registry::ControllerPolicy;

/// The analyzer's manifest loader plus what the Node kernel's
/// `buildModuleArtifacts` does after a load: a module whose manifest carries a
/// `layers:` index gets its artifact registered under its canonical source, one
/// fetched from a registry without one is recorded as unlocatable, and every
/// module's `sources:` block is kept for the staged-file check.
///
/// At READ time rather than after the whole graph, because this kernel creates a
/// module's resources inside that module's load — its own kinds' controllers
/// resolve before the load returns, so the artifact must already be known.
pub struct ArtifactManifestLoader {
    manifests: ManifestLoader,
    layer_fetcher: Rc<dyn LayerFetcher>,
    artifacts: Rc<ModuleArtifacts>,
    manifests_dir: PathBuf,
    legacy_manifests_dir: Option<PathBuf>,
}

impl ArtifactManifestLoader {
    pub fn load(&self, path_or_url: &str) -> Result<LoadedFile, KernelError> {
        let loaded = self.manifests.load(path_or_url)?;
        let owner = read_owner_manifest(loaded.documents())
            .map_err(|err| KernelError::new(err.code(), format!("'{}': {err}", loaded.source)))?;
        let module_dir = module_directory_for(
            &loaded.requested_url,
            &loaded.source,
            &self.manifests_dir,
            self.legacy_manifests_dir.as_deref(),
        );
        match module_artifact_for(
            &loaded.requested_url,
            owner.layers,
            module_dir,
            Rc::clone(&self.layer_fetcher),
        )? {
            Some(artifact) => self.artifacts.register(&loaded.source, Rc::new(artifact)),
            None if loaded.requested_url.contains("://") => {
                self.artifacts.register_unlocatable(&loaded.source)
            }
            None => {}
        }
        self.artifacts.register_sources(&loaded.source, owner.sources);
        Ok(loaded)
    }

    /// Where the files of the module whose manifest resolved from `source` are.
    pub fn module_files(&self, source: &str) -> ModuleFiles {
        self.artifacts.files(source)
    }
}

/// Everything a module load needs, shared by every module in one run.
pub struct LoadEnv {
    pub loader: ArtifactManifestLoader,
    pub registry: ControllerRegistry,
    pub controllers: ControllerLoader,
    /// Loaded modules by (canonical manifest path, policy). A library imported
    /// twice under the same policy must be one module: two copies would give
    /// each import its own instance of an exported singleton.
    ///
    /// The key is *canonical* because two spellings of one path — `../console`
    /// and `../console/telo.yaml` — are the same module, and treating them as
    /// two would duplicate every singleton silently. It includes the policy
    /// because two imports may legitimately select different controllers for the
    /// same kinds, which is exactly what the Node registry's policy fingerprint
    /// exists for.
    modules: RefCell<HashMap<String, Rc<ModuleContext>>>,
}

impl LoadEnv {
    pub fn load_import(
        &self,
        source: &str,
        policy: ControllerPolicy,
    ) -> Result<Rc<ModuleContext>, KernelError> {
        let cache_key = format!(
            "{}\0{}",
            canonical_module_key(source),
            policy.load.join(",")
        );
        if let Some(cached) = self.modules.borrow().get(&cache_key) {
            return Ok(Rc::clone(cached));
        }
        let loaded = load_module(self, source, policy, ModuleRole::Import)?;
        self.modules
            .borrow_mut()
            .insert(cache_key, Rc::clone(&loaded.context));
        Ok(loaded.context)
    }
}

/// The environment for one run from `entry`: the `.telo` cache root anchored on
/// it, and the source chain local file → manifest cache → OCI registry, so a
/// cached manifest never reaches the network.
fn load_env(entry: &str) -> Result<LoadEnv, KernelError> {
    let entry_dir = entry_dir(entry)?;
    let manifests_dir = resolve_cache_root(&entry_dir)
        .map_err(|err| cwd_unreadable("the TELO_CACHE_DIR cache root", err))?
        .join("manifests");
    let oci = OciSource::default();
    let artifacts = Rc::new(ModuleArtifacts::default());
    Ok(LoadEnv {
        loader: ArtifactManifestLoader {
            manifests: ManifestLoader::new(vec![
                Box::new(LocalFileSource),
                Box::new(LocalManifestCacheSource::new(&entry_dir, manifests_dir.clone())),
                Box::new(oci.clone()),
            ]),
            layer_fetcher: Rc::new(oci),
            artifacts: Rc::clone(&artifacts),
            legacy_manifests_dir: legacy_manifests_dir_fallback(&entry_dir, &manifests_dir),
            manifests_dir,
        },
        registry: ControllerRegistry::default(),
        controllers: ControllerLoader::new(artifacts),
        modules: RefCell::new(HashMap::new()),
    })
}

fn cwd_unreadable(what: &str, err: std::io::Error) -> KernelError {
    KernelError::new(
        "ERR_MANIFEST_LOAD_FAILED",
        format!("Cannot resolve {what}: the working directory cannot be read: {err}"),
    )
}

/// The directory an entry manifest anchors its cache on: the directory itself,
/// or the one holding the file, absolute either way.
fn entry_dir(entry: &str) -> Result<PathBuf, KernelError> {
    let absolute = lexical_path::absolute(Path::new(entry))
        .map_err(|err| cwd_unreadable(&format!("the entry manifest '{entry}'"), err))?;
    if absolute.is_dir() {
        return Ok(absolute);
    }
    Ok(absolute.parent().map(Path::to_path_buf).unwrap_or(absolute))
}

/// Reduce a module source to one identity per module.
///
/// Falls back to the raw string when the path cannot be canonicalised — the load
/// that follows will produce the real "no such file" error, and inventing one
/// here would report it against the wrong operation.
fn canonical_module_key(source: &str) -> String {
    let path = Path::new(source);
    let manifest = if path.is_dir() {
        path.join(DEFAULT_MANIFEST_FILENAME)
    } else {
        path.to_path_buf()
    };
    std::fs::canonicalize(&manifest)
        .map(|resolved| resolved.display().to_string())
        .unwrap_or_else(|_| source.to_string())
}

pub struct Kernel {
    /// Built by `load`, because the `.telo` cache the sources read is anchored
    /// on the entry manifest.
    env: Option<LoadEnv>,
    root: Option<LoadedModule>,
}

impl Default for Kernel {
    fn default() -> Self {
        Self::new()
    }
}

impl Kernel {
    pub fn new() -> Self {
        Self {
            env: None,
            root: None,
        }
    }

    /// Load the entry manifest and initialise every resource it declares.
    pub fn load(&mut self, path: &str) -> Result<(), KernelError> {
        let env = self.env.insert(load_env(path)?);
        let root = load_module(env, path, ControllerPolicy::default(), ModuleRole::Root)?;
        self.root = Some(root);
        Ok(())
    }

    /// Run the application's `targets`, returning each step's result in order.
    pub fn run_targets(&self) -> Result<Vec<Value>, KernelError> {
        let root = self.root.as_ref().ok_or_else(|| {
            KernelError::new("ERR_KERNEL_NOT_LOADED", "run_targets called before load")
        })?;
        let application = &root.documents[0];
        let Some(targets) = application.get("targets").and_then(Value::as_array) else {
            return Ok(Vec::new());
        };

        let mut results = Vec::with_capacity(targets.len());
        for (index, target) in targets.iter().enumerate() {
            results.push(self.run_target(root, target, index)?);
        }
        Ok(results)
    }

    fn run_target(
        &self,
        root: &LoadedModule,
        target: &Value,
        index: usize,
    ) -> Result<Value, KernelError> {
        if target.get("when").is_some() {
            return Err(KernelError::new(
                "ERR_UNSUPPORTED_MANIFEST_FEATURE",
                format!("targets[{index}] declares `when:`, which needs an expression engine this kernel does not have yet"),
            ));
        }

        let Some(invoke) = target.get("invoke") else {
            return Err(KernelError::new(
                "ERR_UNSUPPORTED_MANIFEST_FEATURE",
                format!(
                    "targets[{index}] is not an inline invoke step. This kernel runs Telo.Invocable targets only — a bare reference names a Telo.Runnable or Telo.Service, neither of which it hosts yet."
                ),
            ));
        };

        let instance = self.resolve_target_ref(root, invoke, index)?;
        let inputs = target.get("inputs").cloned().unwrap_or_else(|| json!({}));
        invoke_dispatch::invoke(&instance, &inputs)
    }

    /// Resolve a step's `invoke:` to a live instance — local by name, or through
    /// the import alias a cross-module reference carries.
    fn resolve_target_ref(
        &self,
        root: &LoadedModule,
        invoke: &Value,
        index: usize,
    ) -> Result<Rc<ResourceInstance>, KernelError> {
        let Some(reference) = as_resolved_ref(invoke) else {
            return Err(KernelError::resource_not_found(format!(
                "targets[{index}] `invoke:` did not resolve to a declared resource. Check the name in the `!ref`."
            )));
        };
        match reference.alias {
            Some(alias) => {
                let import = root.context.imports.get(alias).ok_or_else(|| {
                    KernelError::resource_not_found(format!(
                        "targets[{index}] references import alias '{alias}', which is not declared"
                    ))
                })?;
                import.exported_resource(reference.name)
            }
            None => root.context.resources.require_resource(reference.name),
        }
    }
}

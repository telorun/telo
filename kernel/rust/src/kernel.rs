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
use telo_analyzer::sources::oci_ref::is_oci_ref;
use telo_analyzer::{
    analysis, as_resolved_ref, load_graph, load_refusal, Analysis, ImportTargetPort, LoadError,
    LoadRefusalHost, LoadedFile, LoadedGraph, LoadedModule as TargetModule, ManifestLoader, ManifestSource,
};

use crate::bundle::module_artifact::{
    module_artifact_for, module_directory_for, LayerFetcher, ModuleArtifacts, ModuleFiles,
};
use crate::bundle::module_manifest::read_owner_manifest;
use crate::controller_loader::ControllerLoader;
use crate::controller_registry::ControllerRegistry;
use crate::controllers::module::import_controller::refuse_unreadable_import;
use crate::controllers::module::module_controller::{load_module, LoadedModule, ModuleRole};
use crate::error::KernelError;
use crate::evaluation_context::ResourceInstance;
use crate::sentinel_pass::{compile_sentinels_at, Owner};
use crate::invoke_dispatch;
use telorun_sdk_core::FailureFrame;
use crate::lexical_path;
use crate::manifest_sources::local_file_source::LocalFileSource;
use crate::manifest_sources::local_manifest_cache_source::{
    legacy_manifests_dir_fallback, resolve_cache_root, LocalManifestCacheSource,
};
use crate::manifest_sources::oci_source::OciSource;
use crate::module_context::ModuleContext;
use crate::runtime_registry::ControllerPolicy;

/// The analyzer's manifest loader, the port the load's graph walk reads and
/// resolves through, plus what the Node kernel's `buildModuleArtifacts` does
/// after a load: a module whose manifest carries a `layers:` index gets its
/// artifact registered under its canonical source, one fetched from a registry
/// without one is recorded as unlocatable, and every module's `sources:` block
/// is kept for the staged-file check.
pub struct ArtifactManifestLoader {
    manifests: SourcesImportPort,
    layer_fetcher: Rc<dyn LayerFetcher>,
    artifacts: Rc<ModuleArtifacts>,
    manifests_dir: PathBuf,
    legacy_manifests_dir: Option<PathBuf>,
}

/// The import-target port over a list of manifest sources: an import this kernel cannot read
/// (`refuse_unreadable_import`: a transport or a nested library) is a host refusal, any other
/// is resolved and read through the loader's sources, each module with its partials. The
/// load walks it, and a host that reads a graph without creating anything — `telo check` —
/// walks the same one.
pub struct SourcesImportPort {
    manifests: ManifestLoader,
}

impl SourcesImportPort {
    pub fn new(sources: Vec<Box<dyn ManifestSource>>) -> Self {
        Self { manifests: ManifestLoader::new(sources) }
    }
}

impl ImportTargetPort for SourcesImportPort {
    fn resolve(&self, from: &LoadedFile, alias: &str, source: &str) -> Result<String, LoadError> {
        let from_artifact = is_oci_ref(&from.requested_url) || is_oci_ref(&from.source);
        refuse_unreadable_import(alias, source, from_artifact).map_err(|refusal| LoadError::Unsupported(refusal.message))?;
        self.manifests.resolve_import_url(&from.source, source)
    }

    fn load(&self, url: &str) -> Result<TargetModule, LoadError> {
        self.manifests.load_module(url)
    }

    fn source_for(&self, url: &str) -> Option<&dyn ManifestSource> {
        self.manifests.source_for(url)
    }
}

impl ImportTargetPort for ArtifactManifestLoader {
    fn resolve(&self, from: &LoadedFile, alias: &str, source: &str) -> Result<String, LoadError> {
        self.manifests.resolve(from, alias, source)
    }

    fn load(&self, url: &str) -> Result<TargetModule, LoadError> {
        self.manifests.load(url)
    }

    fn source_for(&self, url: &str) -> Option<&dyn ManifestSource> {
        self.manifests.source_for(url)
    }
}

impl ArtifactManifestLoader {
    /// Register every module of `graph`'s artifact and `sources:` block — between the
    /// load refusal rule's parse group and its version conflicts, as the Node kernel
    /// builds them, so a manifest that does not parse is refused before its owner
    /// fields are read.
    fn build_module_artifacts(&self, graph: &LoadedGraph) -> Result<(), KernelError> {
        for module in graph.modules.values() {
            let loaded = &module.owner;
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
        }
        Ok(())
    }

    /// Where the files of the module whose manifest resolved from `source` are.
    pub fn module_files(&self, source: &str) -> ModuleFiles {
        self.artifacts.files(source)
    }
}

/// Everything a module load needs, shared by every module in one run.
pub struct LoadEnv {
    pub loader: ArtifactManifestLoader,
    /// The entry and every library its imports reach, read once, before anything
    /// is created: every module the load creates is read from here.
    pub graph: LoadedGraph,
    pub registry: ControllerRegistry,
    pub controllers: ControllerLoader,
    /// Loaded modules by (the graph's canonical source, policy). A library imported
    /// twice under the same policy must be one module: two copies would give
    /// each import its own instance of an exported singleton. The key includes the
    /// policy because two imports may legitimately select different controllers for
    /// the same kinds, which is exactly what the Node registry's policy fingerprint
    /// exists for.
    modules: RefCell<HashMap<String, Rc<ModuleContext>>>,
}

impl LoadEnv {
    /// The module the graph's import edge reached at `target_source`, created once per policy.
    pub fn load_import(
        &self,
        target_source: &str,
        policy: ControllerPolicy,
    ) -> Result<Rc<ModuleContext>, KernelError> {
        let cache_key = format!("{target_source}\0{}", policy.load.join(","));
        if let Some(cached) = self.modules.borrow().get(&cache_key) {
            return Ok(Rc::clone(cached));
        }
        let loaded = load_module(self, target_source, policy, ModuleRole::Import)?;
        self.modules
            .borrow_mut()
            .insert(cache_key, Rc::clone(&loaded.context));
        Ok(loaded.context)
    }

    /// The module the load's graph read for `path_or_url`: its owner file and its partials.
    pub fn module(&self, path_or_url: &str) -> Result<&TargetModule, KernelError> {
        self.graph.module(path_or_url).ok_or_else(|| {
            KernelError::runtime_invalid(format!(
                "'{path_or_url}' is loaded by a module, but the load's import graph never reached it"
            ))
        })
    }
}

/// What a load does once its entry's graph is read and nothing refused it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LoadOptions {
    /// Stop after the static pre-flight — the graph, the load refusal rule, the module
    /// artifacts — before any module is created. The twin of the Node kernel's `analyzeOnly`.
    pub analyze_only: bool,
}

/// The environment for one run from `entry`: the `.telo` cache root anchored on
/// it, and the source chain local file → manifest cache → OCI registry, so a
/// cached manifest never reaches the network. The entry's whole import graph is
/// read and refused by the load refusal rule before anything else.
fn load_env(entry: &str) -> Result<LoadEnv, KernelError> {
    let entry_dir = entry_dir(entry)?;
    let manifests_dir = resolve_cache_root(&entry_dir)
        .map_err(|err| cwd_unreadable("the TELO_CACHE_DIR cache root", err))?
        .join("manifests");
    let oci = OciSource::default();
    let artifacts = Rc::new(ModuleArtifacts::default());
    let loader = ArtifactManifestLoader {
        manifests: SourcesImportPort::new(vec![
            Box::new(LocalFileSource),
            Box::new(LocalManifestCacheSource::new(&entry_dir, manifests_dir.clone())),
            Box::new(oci.clone()),
        ]),
        layer_fetcher: Rc::new(oci),
        artifacts: Rc::clone(&artifacts),
        legacy_manifests_dir: legacy_manifests_dir_fallback(&entry_dir, &manifests_dir),
        manifests_dir,
    };
    let graph = load_graph(&loader, entry)?;
    let refusal = load_refusal(&graph, entry, &mut StaticPreflight { loader: &loader, graph: &graph })?;
    if let Some(refusal) = refusal {
        return Err(KernelError::new(refusal.code, refusal.message).with_diagnostics(refusal.diagnostics));
    }
    Ok(LoadEnv {
        loader,
        graph,
        registry: ControllerRegistry::default(),
        controllers: ControllerLoader::new(artifacts),
        modules: RefCell::new(HashMap::new()),
    })
}

/// What the load refusal rule asks of this kernel between its groups.
struct StaticPreflight<'a> {
    loader: &'a ArtifactManifestLoader,
    graph: &'a LoadedGraph,
}

impl LoadRefusalHost for StaticPreflight<'_> {
    type Error = KernelError;

    fn build_module_artifacts(&mut self) -> Result<(), KernelError> {
        self.loader.build_module_artifacts(self.graph)
    }

    fn analyze(&mut self) -> Analysis {
        analysis(self.graph)
    }
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
        crate::host_paths::verify_host_entry_queries();
        Self {
            env: None,
            root: None,
        }
    }

    /// Load the entry manifest and initialise every resource it declares.
    pub fn load(&mut self, path: &str) -> Result<(), KernelError> {
        self.load_with(path, LoadOptions::default())
    }

    /// Load the entry manifest as `options` say: with `analyze_only`, refuse what the
    /// static pre-flight refuses and create nothing.
    pub fn load_with(&mut self, path: &str, options: LoadOptions) -> Result<(), KernelError> {
        let env = self.env.insert(load_env(path)?);
        if options.analyze_only {
            return Ok(());
        }
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
        // The entry is consumed now, so it takes the pass a resource takes at creation. Its
        // embeds are not resolved: the analysis refuses a file embed on the Application.
        let label = format!("Telo.Application/{}", root.context.name);
        let mut target = target.clone();
        compile_sentinels_at(
            Owner { label: &label, source: &root.context.source },
            &mut target,
            &format!("targets[{index}]"),
        )?;
        let target = &target;
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
        let application = FailureFrame::new(
            "Telo.Application",
            root.context.name.clone(),
            Some(root.context.source.clone()),
        );
        invoke_dispatch::invoke(&instance, &inputs, Some(&application))
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

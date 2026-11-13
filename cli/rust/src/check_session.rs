//! How a static-analysis command loads a manifest graph: one loader per invocation, the
//! manifest cache ahead of the OCI source, and every mutable `oci://` tag revalidated before
//! a verdict is computed from it. Mirrors `../../nodejs/src/check-session.ts`, without the
//! sealed session (this build reads no packaged executable) and without a loader memo (this
//! loader keeps none, so a dropped cache entry is simply read again).

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use telo_analyzer::{load_graph, ImportTargetPort, LoadedFile, LoadedGraph};
use telo_kernel::error::KernelError;
use telo_kernel::kernel::SourcesImportPort;
use telo_kernel::manifest_sources::local_file_source::LocalFileSource;
use telo_kernel::manifest_sources::local_manifest_cache_source::{resolve_entry_dir, LocalManifestCacheSource};
use telo_kernel::manifest_sources::oci_source::OciSource;
use telo_kernel::manifest_sources::origin_digests::read_origin_digests;

use crate::logger::Logger;
use crate::manifest_freshness::{revalidate_mutable_oci_refs, RecordingCacheSource, ServedFiles};
use crate::manifest_input::ManifestInput;

/// Where one input path's manifest cache lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheTarget {
    pub entry_dir: PathBuf,
    pub manifests_dir: PathBuf,
}

/// `None` for an entry with no local anchor to hang a `.telo` directory off.
pub fn cache_target_for(input: &ManifestInput) -> std::io::Result<Option<CacheTarget>> {
    let entry_dir = resolve_entry_dir(&input.entry_path)?;
    Ok(match (&input.cache_root, entry_dir) {
        (Some(root), Some(entry_dir)) => Some(CacheTarget { entry_dir, manifests_dir: root.join("manifests") }),
        _ => None,
    })
}

pub struct CheckSession {
    port: CheckPort,
    /// One recorder per distinct cache root, so the freshness pass can tell which manifests
    /// were served from disk and from which file.
    recorders: Vec<ServedFiles>,
    /// The `manifests` dir of every registered root, in the same order — the freshness pass
    /// judges a cached file against the record of the root it came from.
    manifests_dirs: Vec<PathBuf>,
    oci: OciSource,
    /// Mutable tags already probed in this invocation, so a module imported by twenty
    /// manifests is asked once.
    verified: RefCell<HashMap<String, String>>,
}

/// A cache source for every input path's cache root, ahead of the OCI source: the entries
/// are content-addressed, so a hit under any root is as good as a hit under the one this
/// path would write to, and a miss falls through unchanged.
pub fn open_session(targets: &[CacheTarget]) -> CheckSession {
    let oci = OciSource::default();
    let mut sources: Vec<Box<dyn telo_analyzer::ManifestSource>> = vec![Box::new(LocalFileSource)];
    let mut recorders = Vec::new();
    for target in targets {
        let (recorder, served) = RecordingCacheSource::new(LocalManifestCacheSource::new(
            &target.entry_dir,
            target.manifests_dir.clone(),
        ));
        sources.push(Box::new(recorder));
        recorders.push(served);
    }
    sources.push(Box::new(oci.clone()));
    CheckSession {
        port: CheckPort::new(SourcesImportPort::new(sources)),
        recorders,
        manifests_dirs: targets.iter().map(|t| t.manifests_dir.clone()).collect(),
        oci,
        verified: RefCell::new(HashMap::new()),
    }
}

/// Why a graph did not load.
#[derive(Debug)]
pub enum GraphFailure {
    /// The entry itself could not be read: the load failure Node reports for the path.
    Entry(String),
    /// A module the entry's imports reach could not be resolved or read. Node reports it as
    /// a diagnostic this analyzer has no producer for, so it is a host refusal here.
    Refused { file: Option<String>, error: KernelError },
    /// The freshness pass could not ask the registry.
    Freshness(String),
}

/// The port the walk goes through, noting where it failed: an entry that does not read is a
/// load failure and every other refusal belongs to an import. No Node twin — Node's loader
/// throws errors that carry this themselves.
struct CheckPort {
    inner: SourcesImportPort,
    entry: RefCell<Option<String>>,
    entry_error: RefCell<Option<KernelError>>,
    import_failure_in: RefCell<Option<String>>,
}

impl CheckPort {
    fn new(inner: SourcesImportPort) -> Self {
        Self {
            inner,
            entry: RefCell::new(None),
            entry_error: RefCell::new(None),
            import_failure_in: RefCell::new(None),
        }
    }
}

impl ImportTargetPort for CheckPort {
    type Error = KernelError;

    fn resolve(&self, from: &LoadedFile, alias: &str, source: &str) -> Result<String, KernelError> {
        self.inner.resolve(from, alias, source).inspect_err(|_| {
            *self.import_failure_in.borrow_mut() = Some(from.source.clone());
        })
    }

    fn load(&self, url: &str) -> Result<LoadedFile, KernelError> {
        let is_entry = self.entry.borrow().as_deref() == Some(url);
        self.inner.load(url).map_err(|err| {
            if is_entry {
                *self.entry_error.borrow_mut() = Some(KernelError::new(&err.code, err.message.clone()));
            }
            err
        })
    }
}

/// Drop a stale cache entry: the file, and the record that it was ever served. The next
/// load re-resolves that one manifest through the OCI source. A removal failure is warned,
/// not thrown: this is cache maintenance, and a read-only `.telo` must not change the exit
/// code of a static check.
fn drop_stale_entry(file: &str, session: &CheckSession, log: &Logger) -> std::io::Result<()> {
    if let Err(err) = std::fs::remove_file(file) {
        if err.kind() != std::io::ErrorKind::NotFound {
            log.out.err_line(&format!(
                "{}\n",
                log.err().warn(&format!("[manifest-cache] could not remove stale entry {file}: {err}"))
            ))?;
        }
    }
    for served in &session.recorders {
        served.borrow_mut().retain(|_, served_file| served_file != file);
    }
    Ok(())
}

/// The graph of `entry_path`, loaded through `session` and never from a moved tag. Returns
/// the digests observed, which a cache write records against what the origin serves now.
pub fn load_fresh_graph(
    entry_path: &str,
    session: &CheckSession,
    log: &Logger,
) -> Result<(LoadedGraph, BTreeMap<String, String>), GraphFailure> {
    let load = || -> Result<LoadedGraph, GraphFailure> {
        *session.port.entry.borrow_mut() = Some(entry_path.to_string());
        *session.port.entry_error.borrow_mut() = None;
        *session.port.import_failure_in.borrow_mut() = None;
        load_graph(&session.port, entry_path).map_err(|error| match session.port.entry_error.borrow_mut().take() {
            Some(entry_error) => GraphFailure::Entry(node_io_message(&entry_error)),
            None => GraphFailure::Refused { file: session.port.import_failure_in.borrow_mut().take(), error },
        })
    };
    let graph = load()?;
    if session.recorders.is_empty() {
        return Ok((graph, BTreeMap::new()));
    }
    let mut served: HashMap<String, String> = HashMap::new();
    for recorder in &session.recorders {
        served.extend(recorder.borrow().iter().map(|(url, file)| (url.clone(), file.clone())));
    }
    let origins_by_root: HashMap<String, BTreeMap<String, String>> = session
        .manifests_dirs
        .iter()
        .map(|dir| (dir.to_string_lossy().into_owned(), read_origin_digests(dir)))
        .collect();
    let mut digest_of = |reference: &str| session.oci.manifest_digest(reference);
    let freshness = revalidate_mutable_oci_refs(
        &graph,
        &served,
        &origins_by_root,
        &mut session.verified.borrow_mut(),
        &mut digest_of,
    )
    .map_err(GraphFailure::Freshness)?;
    if freshness.stale_files.is_empty() {
        return Ok((graph, freshness.digests));
    }
    for file in &freshness.stale_files {
        drop_stale_entry(file, session, log).map_err(|err| GraphFailure::Freshness(err.to_string()))?;
    }
    Ok((load()?, freshness.digests))
}

/// The text Node reports for a path that does not read: the runtime's own errno wording.
/// Only the two a person meets are spelled so; any other keeps the kernel's sentence.
fn node_io_message(error: &KernelError) -> String {
    let Some(rest) = error.message.strip_prefix("failed to read `") else { return error.message.clone() };
    let Some((path, reason)) = rest.split_once("`: ") else { return error.message.clone() };
    match reason {
        "No such file or directory (os error 2)" => format!("ENOENT: no such file or directory, open '{path}'"),
        "Permission denied (os error 13)" => format!("EACCES: permission denied, open '{path}'"),
        _ => error.message.clone(),
    }
}

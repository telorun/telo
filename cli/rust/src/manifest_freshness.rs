//! The mutable-tag freshness pass of `telo check`. Mirrors
//! `../../nodejs/src/manifest-freshness.ts`.
//!
//! A cached manifest of a tag the publisher can repoint may be stale, and `check` must not
//! report a clean verdict against one that moved. Every mutable, unpinned `oci://` tag the
//! graph resolved costs one digest request; a pinned ref is verified against its inline
//! hash and costs none, and a tag fetched during this load is fresh by construction.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;

use telo_analyzer::sources::oci_ref::{is_oci_ref, parse_oci_ref};
use telo_analyzer::{LoadError, LoadedGraph, ManifestSource, ReadManifest};
use telo_kernel::manifest_sources::local_manifest_cache_source::LocalManifestCacheSource;
use telo_kernel::manifest_sources::origin_digests::origin_key;

/// True when `reference` names an OCI artifact by a **tag** rather than by content — the
/// only case a cached manifest can silently go stale. A `sha256:` reference is immutable.
pub fn is_oci_tag_ref(reference: &str) -> bool {
    is_oci_ref(reference) && parse_oci_ref(reference).is_ok_and(|parsed| !parsed.reference.contains(':'))
}

/// True when `reference` carries Telo's inline `#sha256-…` pin, which the cache source and
/// the OCI source verify the manifest bytes against on every read. Asked of the ref as
/// authored: the canonical source of a module loses the fragment.
pub fn is_pinned_oci_ref(reference: &str) -> bool {
    is_oci_ref(reference) && parse_oci_ref(reference).is_ok_and(|parsed| parsed.integrity.is_some())
}

/// Request URL → absolute path of the cache file that answered it.
pub type ServedFiles = Rc<RefCell<HashMap<String, String>>>;

/// Wraps the cache source and records which request URLs it served, and from which file:
/// once the cache serves a manifest the graph's canonical source is the file, so the
/// `oci://` ref that asked for it is gone — and for a relative import the only place its
/// absolute ref survives is here.
pub struct RecordingCacheSource {
    inner: LocalManifestCacheSource,
    served: ServedFiles,
}

impl RecordingCacheSource {
    pub fn new(inner: LocalManifestCacheSource) -> (Self, ServedFiles) {
        let served: ServedFiles = Rc::default();
        (Self { inner, served: Rc::clone(&served) }, served)
    }
}

impl ManifestSource for RecordingCacheSource {
    fn supports(&self, path_or_url: &str) -> bool {
        self.inner.supports(path_or_url)
    }

    fn read(&self, path_or_url: &str) -> Result<ReadManifest, LoadError> {
        let read = self.inner.read(path_or_url)?;
        self.served.borrow_mut().insert(path_or_url.to_string(), read.source.clone());
        Ok(read)
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct FreshnessResult {
    /// Cache files whose tag has moved (or was never verified) since they were written.
    pub stale_files: Vec<String>,
    /// Current digest per origin key, to record once the load is trusted.
    pub digests: BTreeMap<String, String>,
}

struct Target {
    reference: String,
    cache_file: Option<String>,
}

/// Revalidate every mutable OCI ref this graph resolved, with one digest request per
/// repository reference. `origins_by_root` is the recorded digests per cache root (keyed by
/// its `manifests` dir): a cached manifest is judged against the record of the root it was
/// served from, which need not be the root this entry writes to. `verified` holds digests
/// already probed in this invocation and is mutated in place. `digest_of` asks the
/// registry; its failure is the pass's.
pub fn revalidate_mutable_oci_refs(
    graph: &LoadedGraph,
    served: &HashMap<String, String>,
    origins_by_root: &HashMap<String, BTreeMap<String, String>>,
    verified: &mut HashMap<String, String>,
    digest_of: &mut dyn FnMut(&str) -> Result<Option<String>, String>,
) -> Result<FreshnessResult, String> {
    let empty = BTreeMap::new();
    let record_for = |cache_file: &str| -> &BTreeMap<String, String> {
        origins_by_root
            .iter()
            .filter(|(root, _)| cache_file.starts_with(&format!("{root}{}", std::path::MAIN_SEPARATOR)))
            .max_by_key(|(root, _)| root.len())
            .map_or(&empty, |(_, record)| record)
    };

    // A module's canonical source loses the pin, so pinning is read off the refs as
    // authored: one pinned edge is enough, edges sharing a canonical source resolved the
    // same tag and its bytes were verified against that pin.
    let pinned_sources: Vec<&str> = graph
        .import_edges
        .values()
        .flat_map(|edges| edges.values())
        .filter(|edge| is_pinned_oci_ref(&edge.target_ref))
        .map(|edge| edge.target_source.as_str())
        .collect();

    let cache_file_to_request: HashMap<&str, &str> =
        served.iter().map(|(url, file)| (file.as_str(), url.as_str())).collect();

    // Restricted to modules this graph actually reached, in the order it reached them.
    let mut targets: Vec<(String, Target)> = Vec::new();
    for source in graph.modules.keys() {
        let request = cache_file_to_request.get(source.as_str()).copied();
        let reference = request.unwrap_or(source);
        if !is_oci_tag_ref(reference) || is_pinned_oci_ref(reference) || pinned_sources.contains(&source.as_str()) {
            continue;
        }
        let key = origin_key(reference).map_err(|err| err.message)?;
        // The same tag reached twice can differ only in whether a copy sat on disk; the
        // cache-served one is what a staleness verdict has to act on.
        if targets.iter().any(|(k, t)| *k == key && t.cache_file.is_some()) {
            continue;
        }
        let target = Target { reference: reference.to_string(), cache_file: request.map(|_| source.clone()) };
        match targets.iter_mut().find(|(k, _)| *k == key) {
            Some((_, existing)) => *existing = target,
            None => targets.push((key, target)),
        }
    }
    if targets.is_empty() {
        return Ok(FreshnessResult::default());
    }

    let mut result = FreshnessResult::default();
    for (key, target) in &targets {
        let digest = match verified.get(key) {
            Some(already) => Some(already.clone()),
            None => {
                let digest = digest_of(&target.reference)?;
                if let Some(digest) = &digest {
                    verified.insert(key.clone(), digest.clone());
                }
                digest
            }
        };
        if let Some(digest) = &digest {
            result.digests.insert(key.clone(), digest.clone());
        }
        let Some(cache_file) = &target.cache_file else { continue };
        // A tag that no longer resolves is stale too: dropping the cached copy lets the
        // reload surface the real resolution failure.
        if digest.is_some_and(|digest| record_for(cache_file).get(key) == Some(&digest)) {
            continue;
        }
        result.stale_files.push(cache_file.clone());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;
    use telo_analyzer::{LoadedFile, LoadedModule};

    fn file(source: &str) -> LoadedFile {
        let mut loaded = telo_analyzer::parse_loaded_file(source, source, "kind: Telo.Library\nmetadata: { name: A }\n");
        loaded.requested_url = source.to_string();
        loaded
    }

    fn graph_of(sources: &[&str]) -> LoadedGraph {
        let mut modules = IndexMap::new();
        for source in sources {
            modules.insert(source.to_string(), LoadedModule { owner: file(source) });
        }
        LoadedGraph {
            root_source: sources[0].to_string(),
            modules,
            requested: HashMap::new(),
            import_edges: HashMap::new(),
            parse_diagnostics: Vec::new(),
            migration_diagnostics: Vec::new(),
            errors: Vec::new(),
        }
    }

    #[test]
    fn a_cached_tag_is_stale_unless_its_recorded_digest_is_what_the_registry_serves() {
        let cache_file = "/cache/manifests/oci/ghcr.io/x/lib/1.0.0/telo.yaml";
        let graph = graph_of(&["/app/telo.yaml", cache_file]);
        let served = HashMap::from([("oci://ghcr.io/x/lib@1.0.0".to_string(), cache_file.to_string())]);
        let key = "ghcr.io/x/lib@1.0.0";
        let origins = |digest: &str| {
            HashMap::from([(
                "/cache/manifests".to_string(),
                BTreeMap::from([(key.to_string(), digest.to_string())]),
            )])
        };
        let asked = RefCell::new(Vec::new());
        let mut ask = |reference: &str| {
            asked.borrow_mut().push(reference.to_string());
            Ok(Some("sha256:new".to_string()))
        };
        let fresh = revalidate_mutable_oci_refs(&graph, &served, &origins("sha256:new"), &mut HashMap::new(), &mut ask).unwrap();
        assert!(fresh.stale_files.is_empty());
        assert_eq!(fresh.digests, BTreeMap::from([(key.to_string(), "sha256:new".to_string())]));
        let stale = revalidate_mutable_oci_refs(&graph, &served, &origins("sha256:old"), &mut HashMap::new(), &mut ask).unwrap();
        assert_eq!(stale.stale_files, vec![cache_file.to_string()]);
        assert_eq!(*asked.borrow(), vec!["oci://ghcr.io/x/lib@1.0.0"; 2]);
        // A digest verified earlier in the invocation is not asked again.
        let mut verified = HashMap::from([(key.to_string(), "sha256:new".to_string())]);
        revalidate_mutable_oci_refs(&graph, &served, &origins("sha256:new"), &mut verified, &mut ask).unwrap();
        assert_eq!(asked.borrow().len(), 2);
    }

    #[test]
    fn a_pinned_ref_and_a_digest_ref_cost_no_request() {
        let pinned = "/cache/manifests/oci/ghcr.io/x/lib/1.0.0/telo.yaml";
        let graph = graph_of(&["/app/telo.yaml", pinned]);
        let served = HashMap::from([("oci://ghcr.io/x/lib@1.0.0#sha256-abc".to_string(), pinned.to_string())]);
        let mut ask = |_: &str| -> Result<Option<String>, String> { panic!("no request expected") };
        let result =
            revalidate_mutable_oci_refs(&graph, &served, &HashMap::new(), &mut HashMap::new(), &mut ask).unwrap();
        assert_eq!(result, FreshnessResult::default());
        assert!(is_oci_tag_ref("oci://ghcr.io/x/lib@1.0.0"));
        assert!(!is_oci_tag_ref(&format!("oci://ghcr.io/x/lib@sha256:{}", "a".repeat(64))));
    }
}

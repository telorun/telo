//! `oci://host/repo@reference` modules read from an OCI distribution registry.
//!
//! No Node file of this name: in Node this is the read half of
//! `transports/oci/oci-transport.ts`, an `OciTransport` that also publishes,
//! lists versions and rewrites refs. This kernel does none of those, and its
//! manifest loader takes plain `ManifestSource`s rather than transports, so the
//! read half lives among the other sources.
//!
//! Two operations, both verified: reading a manifest pulls only the manifest
//! layer and checks it against the import pin; fetching a payload layer pulls a
//! blob by the digest the pinned index names and checks the bytes against it.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use telo_analyzer::sources::integrity::verify_integrity;
use telo_analyzer::sources::oci_ref::{is_oci_ref, parse_oci_ref, OCI_SCHEME};
use telo_analyzer::{LoadError, ManifestSource, ReadManifest, DEFAULT_MANIFEST_FILENAME};

use crate::bundle::files_integrity::PayloadFile;
use crate::bundle::module_artifact::LayerFetcher;
use crate::bundle::tar::read_tar_gz;
use crate::error::KernelError;
use crate::transports::oci::oci_client::{
    blob_digest, OciClient, TELO_LEGACY_LAYER_MEDIA_TYPE, TELO_MANIFEST_LAYER_MEDIA_TYPE,
};

/// Cheap to clone: the loader holds one handle and every module artifact
/// another, sharing one client (and one token cache) per repository.
#[derive(Clone, Default)]
pub struct OciSource {
    clients: Rc<RefCell<HashMap<String, Rc<OciClient>>>>,
}

impl OciSource {
    fn client(&self, host: &str, repo: &str) -> Rc<OciClient> {
        let key = format!("{host}/{repo}");
        Rc::clone(
            self.clients
                .borrow_mut()
                .entry(key)
                .or_insert_with(|| Rc::new(OciClient::new(host, repo))),
        )
    }

    /// Pull only the manifest layer and return its verified `telo.yaml`.
    ///
    /// The OCI manifest is fetched by a usually-mutable reference and never
    /// hashed, so it only locates the blob; the pin then verifies that blob's
    /// `telo.yaml`, which is what makes addressing the rest from its index safe.
    /// A pre-layers single-blob artifact contains `telo.yaml` too and is read
    /// the same way.
    fn pull_manifest_layer(&self, reference: &str) -> Result<ReadManifest, String> {
        let parsed = parse_oci_ref(reference).map_err(|err| err.message)?;
        let client = self.client(&parsed.host, &parsed.repo);
        let manifest = client.pull_manifest(&parsed.reference).map_err(|err| err.message)?;
        let layer = manifest
            .layers
            .iter()
            .find(|l| l.media_type == TELO_MANIFEST_LAYER_MEDIA_TYPE)
            .or_else(|| manifest.layers.iter().find(|l| l.media_type == TELO_LEGACY_LAYER_MEDIA_TYPE))
            .or_else(|| manifest.layers.first())
            .ok_or_else(|| format!("OCI artifact {reference} has no layers"))?;
        let blob = client.pull_blob(&layer.digest).map_err(|err| err.message)?;
        let entries = read_tar_gz(&blob).map_err(|err| {
            format!("OCI artifact {reference} manifest layer is not a readable tar.gz: {err}")
        })?;
        let content = match entries.into_iter().find(|e| e.name() == DEFAULT_MANIFEST_FILENAME) {
            None => {
                return Err(format!(
                    "OCI artifact {reference} manifest layer does not contain {DEFAULT_MANIFEST_FILENAME}"
                ))
            }
            Some(PayloadFile::Link { .. }) => {
                return Err(format!(
                    "OCI artifact {reference} manifest layer carries {DEFAULT_MANIFEST_FILENAME} as a symbolic link; it must be a regular file."
                ))
            }
            Some(PayloadFile::Regular { content, .. }) => content,
        };
        // Telo's inline hash is authoritative; the OCI digest only corroborates.
        if let Some(integrity) = &parsed.integrity {
            verify_integrity(&content, integrity, reference).map_err(|err| err.message)?;
        }
        let text = String::from_utf8(content).map_err(|err| {
            format!("OCI artifact {reference} carries a {DEFAULT_MANIFEST_FILENAME} that is not UTF-8: {err}")
        })?;
        Ok(ReadManifest {
            text,
            source: format!(
                "{OCI_SCHEME}{}/{}@{}",
                parsed.host, parsed.repo, parsed.reference
            ),
        })
    }
}

impl ManifestSource for OciSource {
    fn supports(&self, path_or_url: &str) -> bool {
        is_oci_ref(path_or_url)
    }

    fn read(&self, path_or_url: &str) -> Result<ReadManifest, LoadError> {
        self.pull_manifest_layer(path_or_url)
            .map_err(|message| LoadError::Io {
                path: path_or_url.to_string(),
                message,
            })
    }
}

impl LayerFetcher for OciSource {
    /// Pull one payload layer by the `blob` digest the pinned index supplies —
    /// never through the OCI layer list — and verify the transfer against it.
    /// Content verification is the artifact's, which holds the `integrity`.
    fn fetch_layer(&self, pinned_ref: &str, digest: &str) -> Result<Vec<PayloadFile>, KernelError> {
        let failed = |message: String| KernelError::new("ERR_MODULE_LAYER_FETCH_FAILED", message);
        let parsed = parse_oci_ref(pinned_ref).map_err(|err| failed(err.message))?;
        let tar = self
            .client(&parsed.host, &parsed.repo)
            .pull_blob(digest)
            .map_err(|err| failed(err.message))?;
        let actual = blob_digest(&tar);
        if actual != digest {
            return Err(KernelError::new(
                "ERR_MODULE_LAYER_INTEGRITY",
                format!(
                    "Blob digest mismatch fetching a layer of {pinned_ref}: requested {digest}, received {actual}. \
                     The registry returned different bytes than were addressed."
                ),
            ));
        }
        read_tar_gz(&tar).map_err(|err| {
            failed(format!("the layer {digest} of {pinned_ref} is not a readable tar.gz: {err}"))
        })
    }
}

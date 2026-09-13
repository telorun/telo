//! The owner document of a manifest and the fields the artifact path reads off
//! it. Mirrors `../../../nodejs/src/bundle/module-manifest.ts`.
//!
//! Reads the documents the analyzer's loader already parsed rather than
//! re-parsing text, since every caller holds a `LoadedFile`. Of the Node
//! `OwnerManifest` the layer index and the `sources:` block have consumers here:
//! asset patterns, `files:`, provenance, library candidates and `native:` serve
//! publishing, sibling-library resolution and native-file lookup, none of which
//! this kernel implements.

use serde_json::Value;
use telo_analyzer::artifact_layer_index::{parse_layer_index, ArtifactLayer, LayerIndexError};
use telo_analyzer::kind_of;
use telo_analyzer::source_entries::{read_module_sources, ModuleSources};
use telo_analyzer::system_kinds::is_module_document;

/// The owner-doc fields the kernel reads.
pub struct OwnerManifest {
    /// The published layer index, absent on an unpublished manifest. A malformed
    /// index is a hard error, never a silently ignored field.
    pub layers: Option<Vec<ArtifactLayer>>,
    /// Where each staged file of a source checkout comes from, and its pin.
    pub sources: ModuleSources,
}

/// The single `Telo.Application` / `Telo.Library` document carrying the
/// module's identity and its published `layers:` index.
fn find_owner_doc<'a>(documents: impl IntoIterator<Item = &'a Value>) -> Option<&'a Value> {
    documents
        .into_iter()
        .find(|document| kind_of(document).is_some_and(is_module_document))
}

pub fn read_owner_manifest<'a>(
    documents: impl IntoIterator<Item = &'a Value>,
) -> Result<OwnerManifest, LayerIndexError> {
    let owner = find_owner_doc(documents);
    let layers = owner
        .and_then(|owner| owner.get("layers"))
        .map(|layers| parse_layer_index(layers, "layers"))
        .transpose()?;
    let sources = owner.map(read_module_sources).unwrap_or_default();
    Ok(OwnerManifest { layers, sources })
}

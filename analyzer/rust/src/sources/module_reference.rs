//! Whether an import source is a module reference, read by its scheme's own grammar
//! before anything is fetched. Mirrors `../../../nodejs/src/sources/module-reference.ts`:
//! the `url` crate is the WHATWG URL parser Node's `URL.canParse` is.

use crate::manifest_loader::is_local_path_source;
use crate::sources::integrity::split_integrity;
use crate::sources::oci_ref::{parse_oci_ref, OCI_SCHEME};

#[derive(PartialEq, Eq)]
enum SchemedReading {
    WellFormed,
    Malformed,
    Unclaimed,
}

/// How the scheme `source` names reads it: an `oci://` ref by the OCI ref grammar, an
/// http(s) URL by the WHATWG URL parser.
fn schemed_reading(source: &str) -> SchemedReading {
    let base = split_integrity(source).base;
    let reads = if base.starts_with(OCI_SCHEME) {
        parse_oci_ref(source).is_ok()
    } else if base.starts_with("http://") || base.starts_with("https://") {
        url::Url::parse(base).is_ok()
    } else {
        return SchemedReading::Unclaimed;
    };
    if reads {
        SchemedReading::WellFormed
    } else {
        SchemedReading::Malformed
    }
}

/// True when `source` is a module reference: a path, or an `oci://` / http(s) reference
/// its scheme's own grammar reads.
pub fn is_module_reference(source: &str) -> bool {
    is_local_path_source(source) || schemed_reading(source) == SchemedReading::WellFormed
}

/// True when `source` names the `oci://` or an http(s) scheme and that scheme's grammar
/// refuses it: refused as no module reference before any source is asked.
pub fn is_malformed_schemed_reference(source: &str) -> bool {
    schemed_reading(source) == SchemedReading::Malformed
}


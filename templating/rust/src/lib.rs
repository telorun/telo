//! Telo templating for the Rust kernel.
//!
//! Mirrors the half of `templating/nodejs` the kernel depends on to read a
//! manifest: the tagged-sentinel shape and the YAML tag configuration. The CEL
//! engine the Node package's tag engines run on is `telorun-cel` (`cel/rust`); this
//! crate depends on it for the hole grammar (`cel/interpolation_holes.rs`, which asks the
//! engine where a quoted literal ends), and the tag engines will run on it. The kernel's
//! tag reader (`yaml_tags.rs`) still refuses `!cel`, `!interpolate` and `!sql`.

pub mod cel;
pub mod engines;
pub mod expansion_tags;
pub mod sentinel;
pub mod yaml_tags;

pub use cel::interpolation_holes::{
    interpolation_shape, literal_fragments, read_interpolation_holes, HoleReading, InterpolationHole,
    InterpolationShape,
};
pub use engines::include::{
    is_include_engine, normalize_include_path, normalize_module_path, IncludePathError,
    INCLUDE_BYTES_ENGINE, INCLUDE_TEXT_ENGINE,
};
pub use engines::module_path::MODULE_PATH_ENGINE;
pub use engines::r#ref::{parse_ref_source, ParsedRef, RefIndex, RefVerdict, REF_MEMBER_INVALID};
pub use expansion_tags::{
    expansion_shape_code, expansion_tag_of, is_expansion_tag, EXPANSION_MARKER, EXPANSION_TAGS,
    SPLICE_KEY,
};
pub use sentinel::{
    is_tagged_sentinel, make_tagged_sentinel, ref_sentinel_source, ref_sentinel_verdict,
    tagged_sentinel_parts, REF_ENGINE,
};
pub use yaml_tags::{yaml_to_json, TagError};

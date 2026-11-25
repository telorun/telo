//! The `path-template` Telo format: the path-template reader's own verdict, its reason
//! and the offset it is about. Mirrors `../../nodejs/src/path-template-format.ts` and runs
//! the same conformance set, `sdk/formats/path-template.json`.

use crate::path_template_reading::{read_path_template, PathTemplateReading};
use crate::telo_format::{fail, FormatFailure};

pub fn check(value: &str) -> Option<FormatFailure> {
    match read_path_template(value) {
        PathTemplateReading::Variables(_) => None,
        PathTemplateReading::Invalid { reason, offset } => fail(reason, offset),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn holds_the_entry_s_conformance_set() {
        crate::telo_format::assert_conformance("path-template", include_str!("../../../sdk/formats/path-template.json"));
    }
}

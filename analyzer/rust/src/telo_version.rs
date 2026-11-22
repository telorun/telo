//! The manifest surface generation this build implements, mirroring `../../nodejs/src/telo-version.ts`.
//!
//! Node's module is written by `scripts/generate-telo-version.mjs` from the telo line's recorded
//! version; Cargo runs no Node, so here both values are read once from the embedded built-in
//! vocabulary archive's version, which the same generator's `teloGeneration` writes into the
//! archive beside Node's module: `V+unreleased` in every build but one rendered `--published`,
//! which carries exactly `V`. Nothing here computes a version — a build reports what its archive
//! says.

use std::sync::LazyLock;

use crate::builtin_vocabulary::{builtin_vocabulary_version, BUILTIN_VOCABULARY_ARCHIVE};

/// The release the embedded archive is the vocabulary of, `V` or `V+unreleased`.
static IDENTITY: LazyLock<String> = LazyLock::new(|| {
    builtin_vocabulary_version(BUILTIN_VOCABULARY_ARCHIVE).unwrap_or_else(|reason| {
        panic!(
            "the built-in vocabulary this build embeds is malformed: {reason} Render it again from the \
             repository root with `node scripts/generate-telo-version.mjs && node scripts/render-builtin-vocabulary.mjs`."
        )
    })
});

/// The surface generation this analyzer implements: the triple of the archive's version.
pub static TELO_SURFACE_VERSION: LazyLock<String> =
    LazyLock::new(|| IDENTITY.split(['-', '+']).next().unwrap_or_default().to_string());

/// The surface generation as a `requires:` gate compares it: marked `+unreleased` in every build
/// but the published one, which is what satisfies `>=unreleased`.
pub static TELO_RUNNING_SURFACE: LazyLock<String> = LazyLock::new(|| {
    if IDENTITY.contains("+unreleased") {
        format!("{}+unreleased", *TELO_SURFACE_VERSION)
    } else {
        TELO_SURFACE_VERSION.clone()
    }
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_surface_of_the_telo_line_this_crate_carries() {
        // The analyzer crate carries the telo line's version, as `telo release apply` writes it.
        assert_eq!(*TELO_SURFACE_VERSION, env!("CARGO_PKG_VERSION"));
        assert!(TELO_RUNNING_SURFACE.starts_with(env!("CARGO_PKG_VERSION")));
        assert_eq!(TELO_RUNNING_SURFACE.contains("+unreleased"), IDENTITY.contains("+unreleased"));
    }
}

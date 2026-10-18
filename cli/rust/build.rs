//! Refuses to build the CLI without the built-in vocabulary archive it embeds.
//!
//! The one Rust file with no Node twin here, because it is Cargo's: the Node CLI
//! imports the same bytes from `@telorun/analyzer`, which renders them in its
//! `prepare`. The archive is generated and never tracked, so a fresh checkout
//! has none until the renderer runs — and `include_str!` would then fail naming
//! a missing path but not the remedy. This only checks; it never runs node and
//! writes nothing, so a Rust build cannot become a second renderer.

use std::path::PathBuf;

fn main() {
    let archive = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../analyzer/nodejs/src/builtin-vocabulary/builtins.yaml");
    println!("cargo:rerun-if-changed={}", archive.display());
    if !archive.is_file() {
        panic!(
            "\n{} does not exist.\n\
             The `telo` binary embeds the built-in vocabulary archive, which is rendered from \
             sdk/builtins and never committed. Render it from the repository root with \
             `pnpm install`, or with no install at all:\n\n    \
             node scripts/generate-telo-version.mjs && node scripts/render-builtin-vocabulary.mjs\n",
            archive.display()
        );
    }
}

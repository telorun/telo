//! Emits the migration entry list from the directory listing of `analyzer/migrations/` and
//! the shared schema fragment list from `sdk/builtins/fragments/`, and refuses to build
//! without the built-in vocabulary archive the crate embeds.
//!
//! The one Rust file with no Node twin here, because it is Cargo's: the Node half emits
//! its barrel from the same listing in `scripts/copy-migration-entries.mjs`. Nothing lists
//! the entries by hand, so a file that exists always runs and a deleted one never does —
//! a hand-maintained list is the one place the mechanism could fail silently.
//!
//! The archive is rendered from `sdk/builtins` by the Node half's `prepare` and never tracked,
//! so a fresh checkout has none until the renderer runs — and `include_str!` would then fail
//! naming a missing path but not the remedy. Its presence is only checked: this never runs node
//! and writes nothing, so a Rust build cannot become a second renderer.

use std::fmt::Write as _;
use std::path::PathBuf;

fn main() {
    require_builtin_vocabulary_archive();
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations");
    println!("cargo:rerun-if-changed={}", directory.display());
    let listing = std::fs::read_dir(&directory).unwrap_or_else(|err| {
        panic!(
            "\n{} cannot be read ({err}). Migration entries are data that ships beside the language halves — if this is a container or package build, its file allowlist has to include 'analyzer/migrations'.\n",
            directory.display()
        )
    });
    let mut names: Vec<String> = listing
        .map(|entry| entry.expect("a migration directory entry").file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".json"))
        .collect();
    // Lexical order is the set's order, never the order the filesystem returns.
    names.sort();
    let mut out = String::from("/// Every entry file, lexically ordered, with its text.\npub(crate) const MIGRATION_ENTRY_FILES: &[(&str, &str)] = &[\n");
    for name in &names {
        let path = directory.join(name).canonicalize().expect("a listed migration entry");
        println!("cargo:rerun-if-changed={}", path.display());
        writeln!(out, "    ({name:?}, include_str!({:?})),", path.display().to_string()).expect("write to a string");
    }
    out.push_str("];\n");
    let target = PathBuf::from(std::env::var("OUT_DIR").expect("Cargo sets OUT_DIR")).join("migration_entries.rs");
    std::fs::write(target, out).expect("write the migration entry list");
    emit_manifest_fragments();
}

/// The shared schema fragments of `sdk/builtins/fragments/`, lexically by name — the
/// manifest root a validator registers under `telo://manifest`, as the Node half's
/// `BUILTIN_FRAGMENT_FILES` lists them.
fn emit_manifest_fragments() {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../sdk/builtins/fragments");
    println!("cargo:rerun-if-changed={}", directory.display());
    let listing = std::fs::read_dir(&directory).unwrap_or_else(|err| {
        panic!("\n{} cannot be read ({err}). The shared schema fragments are data the analyzer embeds.\n", directory.display())
    });
    let mut names: Vec<String> = listing
        .map(|entry| entry.expect("a fragment directory entry").file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".json"))
        .collect();
    names.sort();
    let mut out = String::from("/// Every shared schema fragment, lexically by name, with its text.\npub(crate) const MANIFEST_FRAGMENT_FILES: &[(&str, &str)] = &[\n");
    for name in &names {
        let path = directory.join(name).canonicalize().expect("a listed fragment");
        println!("cargo:rerun-if-changed={}", path.display());
        writeln!(out, "    ({:?}, include_str!({:?})),", name.trim_end_matches(".json"), path.display().to_string()).expect("write to a string");
    }
    out.push_str("];\n");
    let target = PathBuf::from(std::env::var("OUT_DIR").expect("Cargo sets OUT_DIR")).join("manifest_fragments.rs");
    std::fs::write(target, out).expect("write the manifest fragment list");
}

fn require_builtin_vocabulary_archive() {
    let archive = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../nodejs/src/builtin-vocabulary/builtins.yaml");
    println!("cargo:rerun-if-changed={}", archive.display());
    if !archive.is_file() {
        panic!(
            "\n{} does not exist.\n\
             The analyzer embeds the built-in vocabulary archive, which is rendered from \
             sdk/builtins and never committed. Render it from the repository root with \
             `pnpm install`, or, once the workspace is installed (the version generator reads \
             analyzer/nodejs/package.json):\n\n    \
             node scripts/generate-telo-version.mjs && node scripts/render-builtin-vocabulary.mjs\n",
            archive.display()
        );
    }
}

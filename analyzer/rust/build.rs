//! Emits the migration entry list from the directory listing of `analyzer/migrations/`.
//!
//! The one Rust file with no Node twin here, because it is Cargo's: the Node half emits
//! its barrel from the same listing in `scripts/copy-migration-entries.mjs`. Nothing lists
//! the entries by hand, so a file that exists always runs and a deleted one never does —
//! a hand-maintained list is the one place the mechanism could fail silently.

use std::fmt::Write as _;
use std::path::PathBuf;

fn main() {
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
}

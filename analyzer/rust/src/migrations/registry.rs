//! The core migration set — entries that ship with the analyzer and may match any node.
//! Mirrors `../../../nodejs/src/migrations/registry.ts`.
//!
//! The set is data: one JSON file per entry under `analyzer/migrations/`, read as one
//! lexically ordered list and embedded with `include_str!` by the list `build.rs` emits from
//! the directory listing, so the identical files the Node half reads are the ones this half
//! applies. Entries carry no version stamp; retiring one is deleting its file.

use std::sync::OnceLock;

use serde_json::Value;

use super::entry_data::parse_migration_entry;
use super::r#match::MigrationSurface;
use super::types::MigrationEntry;

include!(concat!(env!("OUT_DIR"), "/migration_entries.rs"));

/// Every core entry, read once. An entry file the reader refuses is a defect of this build,
/// refused as Node's module refuses it when it loads: with the reader's whole sentence.
pub fn core_migrations() -> &'static [MigrationEntry] {
    static CORE: OnceLock<Vec<MigrationEntry>> = OnceLock::new();
    CORE.get_or_init(|| {
        MIGRATION_ENTRY_FILES
            .iter()
            .map(|(file, text)| {
                let data: Value = serde_json::from_str(text)
                    .unwrap_or_else(|err| panic!("migration entry '{file}' is not JSON: {err}"));
                parse_migration_entry(file, &data, MigrationSurface::Core).unwrap_or_else(|err| panic!("{err}"))
            })
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_entry_file_of_the_directory_in_lexical_order() {
        let directory = concat!(env!("CARGO_MANIFEST_DIR"), "/../migrations");
        let mut files: Vec<String> = std::fs::read_dir(directory)
            .expect("the migration directory")
            .map(|entry| entry.expect("an entry").file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".json"))
            .collect();
        files.sort();
        let embedded: Vec<&str> = MIGRATION_ENTRY_FILES.iter().map(|(file, _)| *file).collect();
        assert_eq!(embedded, files);
        assert_eq!(core_migrations().len(), files.len());
        for entry in core_migrations() {
            assert!(!entry.id.is_empty() && !entry.code.is_empty() && !entry.reason.is_empty() && !entry.rules.is_empty());
        }
    }
}

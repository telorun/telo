//! A loader stamp an author writes in a document's `metadata` is refused at load
//! (`ERR_METADATA_RESERVED_FIELD`), root and import alike; a library's in the words the
//! Node kernel uses, at the root's import reaching it.

use std::path::PathBuf;

use telo_kernel::Kernel;

const STAMP: &str = "Telo.Definition/Greeter: 'metadata.module' is written by the loader — the module the document belongs to — and cannot be written in a manifest. Remove it.";

fn fixture(name: &str) -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
        .join("telo.yaml")
        .display()
        .to_string()
}

fn refusal(name: &str) -> telo_kernel::KernelError {
    Kernel::new().load(&fixture(name)).expect_err("load must fail")
}

/// The refusal reaching a library through `alias` of `fixture`: its whole message, and the
/// one stamp it carries, located at the import.
fn assert_refused_at_import(name: &str, alias: &str) {
    let err = refusal(name);
    let importer = fixture(name);
    // `metadataStampWrittenAtImport`'s `runFails` in `tests/check-run-agreement.yaml`.
    let stamp = format!("Imported library 'MetadataStampLib', reached through import '{alias}': {STAMP}");
    assert_eq!(err.code, "ERR_METADATA_RESERVED_FIELD", "{err}");
    assert_eq!(err.message, format!("{importer}: {stamp}"), "{err}");
    assert_eq!(err.diagnostics.len(), 1, "{err}");
    let carried = &err.diagnostics[0];
    let data = carried.data.as_ref().expect("carried diagnostic data");
    assert_eq!(carried.code.as_deref(), Some("ERR_METADATA_RESERVED_FIELD"));
    assert_eq!(carried.message, stamp);
    assert_eq!(data.file_path.as_deref(), Some(importer.as_str()));
    assert_eq!(data.path.as_deref(), Some(format!("imports.{alias}").as_str()));
}

#[test]
fn refuses_a_stamp_written_in_the_root() {
    let err = refusal("metadata-stamp");
    assert_eq!(err.code, "ERR_METADATA_RESERVED_FIELD", "{err}");
    assert_eq!(err.message, format!("{}: {STAMP}", fixture("metadata-stamp")), "{err}");
}

#[test]
fn refuses_a_stamp_written_in_an_imported_library_at_the_import() {
    assert_refused_at_import("metadata-stamp-import", "Lib");
}

#[test]
fn refuses_a_stamp_two_imports_down_at_the_root_import() {
    assert_refused_at_import("metadata-stamp-transitive", "Mid");
}

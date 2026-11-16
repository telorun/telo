//! `analyzer/library-migration-conformance/`: the matcher answers every `matcher.json`
//! vector as Node's does, and no consumer row Node migrates — a node rewritten, a migration
//! reported or `MIGRATION_FAILED` — is accepted by this build, which applies no library
//! migration and refuses the import reaching the library instead.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::Value;
use telo_analyzer::library_migrations::declaration::read_migration_match;
use telo_analyzer::library_migrations::migration_match_holds;
use telo_analyzer::{
    load_graph, parse_loaded_file, unapplied_library_migrations, LoadError, ManifestLoader, ManifestSource,
    ReadManifest, DEFAULT_MANIFEST_FILENAME,
};

fn conformance() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../library-migration-conformance")
        .canonicalize()
        .expect("conformance directory")
}

struct FileSource;

impl ManifestSource for FileSource {
    fn supports(&self, path: &str) -> bool {
        !path.contains("://")
    }

    fn read(&self, path: &str) -> Result<ReadManifest, LoadError> {
        let path = Path::new(path);
        let file = if path.is_dir() { path.join(DEFAULT_MANIFEST_FILENAME) } else { path.to_path_buf() };
        let text = std::fs::read_to_string(&file)
            .map_err(|err| LoadError::Io { path: file.display().to_string(), message: err.to_string() })?;
        Ok(ReadManifest { text, source: file.display().to_string() })
    }
}

#[test]
fn the_matcher_answers_every_vector() {
    let text = std::fs::read_to_string(conformance().join("matcher.json")).expect("matcher.json");
    let vectors: Value = serde_json::from_str(&text).expect("matcher.json parses");
    let vectors = vectors["vectors"].as_array().expect("vectors");
    assert!(!vectors.is_empty());
    for vector in vectors {
        let id = vector["id"].as_str().expect("id");
        let file = parse_loaded_file("value.yaml", "value.yaml", vector["value"].as_str().expect("value"));
        assert!(file.parse_errors.is_empty(), "{id}: the value does not read");
        let value = file.manifests.first().cloned().flatten().unwrap_or(Value::Null);
        let r#match = read_migration_match(&vector["match"]).unwrap_or_else(|| panic!("{id}: the match does not read"));
        assert_eq!(migration_match_holds(&r#match, &value), vector["holds"].as_bool().expect("holds"), "{id}");
    }
}

#[test]
fn no_consumer_row_node_migrates_is_accepted() {
    let consumers = conformance().join("consumers");
    let mut rows = 0;
    for entry in std::fs::read_dir(&consumers).expect("consumers") {
        let dir = entry.expect("entry").path();
        let id = dir.file_name().and_then(|name| name.to_str()).expect("row name").to_string();
        if id.starts_with("__") || !dir.is_dir() {
            continue;
        }
        let expected: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("expected.json")).expect("expected.json"))
            .expect("expected.json parses");
        let migrates = expected["migrated"].as_object().is_some_and(|migrated| !migrated.is_empty())
            || expected["diagnostics"].as_array().into_iter().flatten().any(|d| d["code"] == "MIGRATION_FAILED");
        assert!(migrates, "{id}: a row Node neither migrates nor fails is not expected here");
        let loader = ManifestLoader::new(vec![Box::new(FileSource)]);
        let graph = load_graph(&loader, &dir.join(DEFAULT_MANIFEST_FILENAME).display().to_string()).expect("graph loads");
        let refusals = unapplied_library_migrations(&graph);
        assert!(!refusals.is_empty(), "{id}: accepted, where Node migrates");
        rows += 1;
    }
    assert!(rows > 0);
}

/// The refusals of a consumer written beside the fixture libraries, each import's `{lib}`
/// replaced by that library's absolute path.
fn refusals_of(consumer: &str) -> Vec<telo_analyzer::UnappliedLibraryMigration> {
    let fixtures = conformance().join("consumers/__fixtures__");
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "telo-library-migrations-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).expect("scratch dir");
    let text = ["ui", "views", "sqlite"].iter().fold(consumer.to_string(), |text, lib| {
        text.replace(&format!("{{{lib}}}"), &fixtures.join(lib).display().to_string())
    });
    let entry = dir.join(DEFAULT_MANIFEST_FILENAME);
    std::fs::write(&entry, text).expect("consumer written");
    let loader = ManifestLoader::new(vec![Box::new(FileSource)]);
    let graph = load_graph(&loader, &entry.display().to_string()).expect("graph loads");
    let refusals = unapplied_library_migrations(&graph);
    std::fs::remove_dir_all(&dir).expect("scratch dir removed");
    refusals
}

#[test]
fn the_refusal_names_the_import_the_migration_and_the_node() {
    let dir = conformance().join("consumers/rewrite-under-alias");
    let loader = ManifestLoader::new(vec![Box::new(FileSource)]);
    let graph = load_graph(&loader, &dir.join(DEFAULT_MANIFEST_FILENAME).display().to_string()).expect("graph loads");
    let refusals = unapplied_library_migrations(&graph);
    assert_eq!(refusals.len(), 1);
    let base = format!("{}/", dir.display());
    let message = refusals[0].message(|path| path.replace(&base, ""));
    assert!(message.starts_with("'telo.yaml', imports.U: Ui ("), "{message}");
    assert!(
        message.ends_with(
            ") declares the manifest migration UI_LINK_HREF_MOVED, which may apply at telo.yaml:11:5, and this build does not apply library migrations"
        ),
        "{message}"
    );
}

#[test]
fn a_consumer_in_current_spelling_is_accepted() {
    let refusals = refusals_of(
        "kind: Telo.Application
metadata: { name: Current }
imports: { U: {ui}, V: {views}, Db: {sqlite} }
targets: []
---
kind: U.Page
metadata: { name: home }
path: /
children:
  - { type: link, text: Home, to: { kind: U.Navigate, address: { path: / } } }
  - { type: text, text: Hello }
panel: { kind: U.Panel, title: Welcome }
---
kind: V.Page
metadata: { name: account }
path: /account
children:
  - { type: composite, ref: !ref me }
  - { type: query, query: !ref read, children: [{ type: text, text: Me }] }
---
kind: V.View
metadata: { name: me }
content: { type: query, query: { kind: V.Query, url: { path: /me } } }
---
kind: V.Query
metadata: { name: read }
url: { path: /read }
",
    );
    assert_eq!(refusals, Vec::new());
}

#[test]
fn a_rule_reading_a_type_before_its_rewrite_counts_only_where_that_type_is_named() {
    let composite = "kind: Telo.Application
metadata: { name: Composite }
imports: { V: {views} }
targets: []
---
kind: V.Page
metadata: { name: account }
path: /account
children: [{ type: composite, ref: !ref me }]
";
    assert_eq!(refusals_of(composite), Vec::new());
    let with_data = format!("{composite}---\nkind: V.Data\nmetadata: {{ name: me }}\nurl: {{ path: /me }}\n");
    let refusals = refusals_of(&with_data);
    assert_eq!(refusals.len(), 1);
    assert_eq!(refusals[0].migration, "VIEWS_DATA_REPLACED");
    assert_eq!(refusals[0].import_path, "imports.V");
}

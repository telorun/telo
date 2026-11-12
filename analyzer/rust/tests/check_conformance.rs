//! `analyzer/check-conformance/`: each row is a manifest tree and what `telo check` reports
//! for it, every diagnostic whole and at the range it is shown at. This runner holds the
//! analysis, assembled as every host assembles it, to each row's `diagnostics`.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use telo_analyzer::{
    analyze, assemble_graph_diagnostics, load_graph, locate_diagnostic, AnalysisOptions, LoadError, ManifestLoader,
    ManifestSource, ReadManifest, DEFAULT_MANIFEST_FILENAME,
};

fn vectors() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../check-conformance/vectors")
        .canonicalize()
        .expect("vectors directory")
}

/// A path with `/` separators on every platform, so a source reads as the recorded rows do.
fn slashed(path: &str) -> String {
    path.replace(std::path::MAIN_SEPARATOR, "/")
}

/// The filesystem, a directory read as its `telo.yaml`.
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
        Ok(ReadManifest { text, source: slashed(&file.display().to_string()) })
    }
}

/// Every string with the row directory's prefix removed, so a file reads relative to it.
fn relativize(value: &mut Value, prefix: &str) {
    match value {
        Value::String(text) => *text = text.replace(prefix, ""),
        Value::Object(map) => map.values_mut().for_each(|item| relativize(item, prefix)),
        Value::Array(items) => items.iter_mut().for_each(|item| relativize(item, prefix)),
        _ => {}
    }
}

/// Keys sorted at every depth.
fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            Value::Object(keys.into_iter().map(|key| (key.clone(), canonical(&map[key]))).collect::<Map<_, _>>())
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

/// The canonical sort: by each diagnostic's JSON text with keys sorted at every depth,
/// compared by code point.
fn sorted(diagnostics: &[Value]) -> Vec<Value> {
    let mut keyed: Vec<(String, Value)> =
        diagnostics.iter().map(|d| (canonical(d).to_string(), canonical(d))).collect();
    keyed.sort_by(|a, b| a.0.cmp(&b.0));
    keyed.into_iter().map(|(_, d)| d).collect()
}

fn diagnostics_of(dir: &Path) -> Vec<Value> {
    let loader = ManifestLoader::new(vec![Box::new(FileSource)]);
    let entry = dir.join(DEFAULT_MANIFEST_FILENAME).display().to_string();
    let graph = load_graph(&loader, &entry).expect("graph loads");
    let analysis = analyze(&graph, &AnalysisOptions { accepts_value: &|_, _, _| false });
    let prefix = format!("{}/", slashed(&dir.display().to_string()));
    assemble_graph_diagnostics(&graph, analysis)
        .diagnostics
        .iter()
        .map(|d| {
            let mut shown = serde_json::to_value(d).expect("diagnostic serializes");
            let object = shown.as_object_mut().expect("diagnostic is an object");
            object.remove("range");
            if let Some(located) = locate_diagnostic(&graph, d) {
                object.insert("range".to_string(), serde_json::to_value(located.range).expect("range serializes"));
            }
            relativize(&mut shown, &prefix);
            shown
        })
        .collect()
}

#[test]
fn answers_every_check_conformance_row() {
    let mut ids: Vec<PathBuf> =
        std::fs::read_dir(vectors()).expect("read vectors").map(|entry| entry.expect("entry").path()).collect();
    ids.sort();
    assert!(!ids.is_empty(), "no rows");
    let mut failures = Vec::new();
    for dir in ids {
        let id = dir.file_name().unwrap().to_string_lossy().into_owned();
        let expected: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("expected.json")).expect("expected.json"),
        )
        .expect("expected.json parses");
        let mut keys: Vec<&String> = expected.as_object().expect("an object").keys().collect();
        keys.sort();
        assert_eq!(keys, ["diagnostics", "runFails"], "{id}");
        let want = sorted(expected["diagnostics"].as_array().expect("diagnostics"));
        let got = sorted(&diagnostics_of(&dir));
        if got != want {
            failures.push(format!(
                "{id}:\n  expected {}\n  got      {}",
                Value::Array(want),
                Value::Array(got)
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

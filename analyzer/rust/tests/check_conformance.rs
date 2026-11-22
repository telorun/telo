//! `analyzer/check-conformance/`: each row is a manifest tree and what `telo check` reports
//! for it, every diagnostic whole and at the range it is shown at. This runner holds what
//! `telo check` reports — the entry's assembly plus every imported library's verdict — to each
//! row's `diagnostics`.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use telo_analyzer::sources::source_failure::{file_source_failure, file_url, ManifestSourceFailure, SourceFailureKind};
use telo_analyzer::{
    analyze_loaded_graph, join_relative, load_graph, locate_diagnostic, AnalysisOptions, DependencyAnalysisOptions,
    LoadError, ManifestLoader, ManifestSource, ReadManifest, DEFAULT_MANIFEST_FILENAME, TELO_RUNNING_SURFACE,
};
use telorun_glob::{select_by_patterns, SelectOptions};

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

/// The filesystem as the kernel's local file source reads it: a directory read as its
/// `telo.yaml`, a failure in Telo's words, an `include:` glob expanded over the owner's directory.
struct FileSource;

impl ManifestSource for FileSource {
    fn supports(&self, path: &str) -> bool {
        path.starts_with('/') || path.starts_with("./") || path.starts_with("../") || (!path.contains("://") && !path.contains('@'))
    }

    fn read(&self, path: &str) -> Result<ReadManifest, LoadError> {
        let path = Path::new(path);
        let metadata = std::fs::metadata(path).map_err(|err| LoadError::Source(file_source_failure(&err, file_url(path))))?;
        let file = if metadata.is_dir() { path.join(DEFAULT_MANIFEST_FILENAME) } else { path.to_path_buf() };
        let text = std::fs::read_to_string(&file).map_err(|err| {
            LoadError::Source(if metadata.is_dir() && err.kind() == std::io::ErrorKind::NotFound {
                ManifestSourceFailure::new(SourceFailureKind::NotAModule, file_url(path))
            } else {
                file_source_failure(&err, file_url(&file))
            })
        })?;
        Ok(ReadManifest { text, source: slashed(&file.display().to_string()) })
    }

    fn expand_glob(&self, base: &str, patterns: &[String]) -> Option<Result<Vec<String>, LoadError>> {
        let directory = Path::new(base).parent().expect("an owner's directory").to_path_buf();
        let mut relative = Vec::new();
        collect_files(&directory, "", &mut relative);
        let options = SelectOptions { apply_default_ignore: Some(false), exclude: Vec::new() };
        Some(Ok(select_by_patterns(&relative, patterns, &options)
            .into_iter()
            .map(|rel| join_relative(base, &rel))
            .collect()))
    }
}

/// Every regular file beneath `directory`, `/`-separated relative to it.
fn collect_files(directory: &Path, prefix: &str, out: &mut Vec<String>) {
    for entry in std::fs::read_dir(directory).expect("a listable row directory") {
        let entry = entry.expect("a directory entry");
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        let kind = entry.file_type().expect("a file type");
        if kind.is_dir() {
            collect_files(&entry.path(), &relative, out);
        } else if kind.is_file() {
            out.push(relative);
        }
    }
}

/// Every string with the row directory's prefixes — its `file://` URL, then its path —
/// removed, so a file reads relative to it, then this build's running surface written as
/// `<running-surface>`.
fn relativize(value: &mut Value, prefixes: &[String]) {
    match value {
        Value::String(text) => {
            let relative = prefixes.iter().fold(text.clone(), |text, prefix| text.replace(prefix.as_str(), ""));
            *text = relative.replace(TELO_RUNNING_SURFACE.as_str(), "<running-surface>");
        }
        Value::Object(map) => map.values_mut().for_each(|item| relativize(item, prefixes)),
        Value::Array(items) => items.iter_mut().for_each(|item| relativize(item, prefixes)),
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
    let options = DependencyAnalysisOptions {
        analysis: &AnalysisOptions { accepts_value: &|_, _, _| false },
        store: None,
        memo: None,
    };
    let prefixes = [format!("{}/", file_url(dir)), format!("{}/", slashed(&dir.display().to_string()))];
    analyze_loaded_graph(&graph, &options)
        .diagnostics
        .iter()
        .map(|d| {
            let mut shown = serde_json::to_value(d).expect("diagnostic serializes");
            let object = shown.as_object_mut().expect("diagnostic is an object");
            object.remove("range");
            if let Some(located) = locate_diagnostic(&graph, d) {
                object.insert("range".to_string(), serde_json::to_value(located.range).expect("range serializes"));
            }
            relativize(&mut shown, &prefixes);
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

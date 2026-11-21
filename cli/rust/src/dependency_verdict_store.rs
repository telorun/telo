//! Library verdicts kept as JSON files under `<cache root>/dependency-verdicts/`, one per
//! verdict key. Mirrors `../../nodejs/src/dependency-verdict-store.ts`. Like the manifest cache
//! this is an optimization: an unreadable entry is recomputed and a failed write warns once,
//! never fails the check.

use std::cell::{Cell, RefCell};
use std::path::PathBuf;

use serde_json::Value;
use telo_analyzer::builtin_vocabulary::builtin_vocabulary_version;
use telo_analyzer::{AnalysisDiagnostic, DependencyVerdict, DependencyVerdictStore, VERDICT_FORMAT};

use crate::commands::builtins::BUILTIN_VOCABULARY_ARCHIVE;
use crate::logger::Logger;
use crate::manifest_input::ManifestInput;

/// Verdicts live beside the manifest cache, under the cache root.
pub const DEPENDENCY_VERDICTS_DIR: &str = "dependency-verdicts";

/// The verdicts under one cache root.
pub struct FileDependencyVerdictStore<'a> {
    dir: PathBuf,
    /// Whether a verdict may be written; reads are always served.
    write: bool,
    log: &'a Logger<'a>,
    warned: Cell<bool>,
    /// A warning that could not be written, surfaced by [`FileDependencyVerdictStore::finish`].
    unwritten: RefCell<Option<std::io::Error>>,
}

impl FileDependencyVerdictStore<'_> {
    fn warn(&self, message: &str) {
        if self.warned.replace(true) {
            return;
        }
        let line = format!("{}\n", self.log.err().warn(&format!("[dependency-verdicts] {message}")));
        if let Err(err) = self.log.out.err_line(&line) {
            self.unwritten.borrow_mut().get_or_insert(err);
        }
    }

    /// Ends the store's use: the error of a warning stderr refused, if one was.
    pub fn finish(self) -> std::io::Result<()> {
        self.unwritten.into_inner().map_or(Ok(()), Err)
    }

    fn write_entry(&self, key: &str, verdict: &DependencyVerdict) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let file = self.dir.join(format!("{key}.json"));
        let tmp = self.dir.join(format!("{key}.json.{}.tmp", std::process::id()));
        let text = serde_json::to_string(verdict).map_err(std::io::Error::other)?;
        let written = std::fs::write(&tmp, text).and_then(|()| std::fs::rename(&tmp, &file));
        if written.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        written
    }
}

impl DependencyVerdictStore for FileDependencyVerdictStore<'_> {
    fn get(&self, key: &str) -> Option<DependencyVerdict> {
        let text = match std::fs::read_to_string(self.dir.join(format!("{key}.json"))) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return None,
            Err(err) => {
                self.warn(&format!("read failed: {err}"));
                return None;
            }
        };
        match kept_verdict(&text) {
            Some(verdict) => Some(verdict),
            None => {
                // A damaged entry is recomputed and rewritten.
                self.warn(&format!("ignored a damaged entry {key}.json"));
                None
            }
        }
    }

    fn set(&self, key: &str, verdict: &DependencyVerdict) {
        if !self.write {
            return;
        }
        if let Err(err) = self.write_entry(key, verdict) {
            self.warn(&format!("write failed: {err}"));
        }
    }
}

/// A kept verdict's text read back: damaged unless it names its module and holds a list of
/// diagnostics. One of another format is handed back for its format alone, which the stage
/// judges again whatever it holds.
fn kept_verdict(text: &str) -> Option<DependencyVerdict> {
    let value: Value = serde_json::from_str(text).ok()?;
    let module = value.get("module")?.as_str()?.to_string();
    let diagnostics = value.get("diagnostics")?.as_array()?;
    let format = value.get("format").and_then(Value::as_u64).and_then(|format| u32::try_from(format).ok());
    if format != Some(VERDICT_FORMAT) {
        return Some(DependencyVerdict { format: format.unwrap_or(0), module, diagnostics: Vec::new() });
    }
    let diagnostics: Vec<AnalysisDiagnostic> = serde_json::from_value(Value::Array(diagnostics.clone())).ok()?;
    Some(DependencyVerdict { format: VERDICT_FORMAT, module, diagnostics })
}

/// The store for `input`'s cache root; none for an input with no root. A sealed root is read,
/// never written. A `+unreleased` build is a dev build whose code a version does not identify,
/// so it keeps no verdicts.
pub fn verdict_store_for<'a>(
    input: &ManifestInput,
    cache_write: bool,
    log: &'a Logger<'a>,
    running_surface: &str,
) -> Option<FileDependencyVerdictStore<'a>> {
    let root = input.cache_root.as_ref()?;
    if running_surface.contains("+unreleased") {
        return None;
    }
    Some(FileDependencyVerdictStore {
        dir: root.join(DEPENDENCY_VERDICTS_DIR),
        write: cache_write && !input.cache_sealed,
        log,
        warned: Cell::new(false),
        unwritten: RefCell::new(None),
    })
}

/// The surface this build implements as a `requires:` gate compares it, Node's
/// `TELO_RUNNING_SURFACE`: the release triple of the embedded vocabulary's release, marked
/// `+unreleased` when that release is.
pub fn running_surface() -> Result<String, String> {
    let identity = builtin_vocabulary_version(BUILTIN_VOCABULARY_ARCHIVE)?;
    let triple = identity.split(['-', '+']).next().unwrap_or_default();
    Ok(if identity.contains("+unreleased") { format!("{triple}+unreleased") } else { triple.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::{Output, OutputFormat};

    fn quiet() -> Output {
        let env = std::collections::HashMap::new();
        Output::new(OutputFormat::Text, &env, false, false, Box::new(std::io::sink()), Box::new(std::io::sink()))
    }

    fn input(root: &std::path::Path) -> ManifestInput {
        ManifestInput { entry_path: "telo.yaml".into(), cache_root: Some(root.to_path_buf()), cache_sealed: false }
    }

    fn verdict() -> DependencyVerdict {
        DependencyVerdict { format: VERDICT_FORMAT, module: "Lib".into(), diagnostics: Vec::new() }
    }

    #[test]
    fn keeps_a_verdict_under_its_key_and_reads_it_back() {
        let root = tempfile::tempdir().unwrap();
        let out = quiet();
        let log = Logger::new(&out, root.path().to_path_buf());
        let store = verdict_store_for(&input(root.path()), true, &log, "1.2.3").expect("a store");
        assert_eq!(store.get("k"), None);
        store.set("k", &verdict());
        assert!(root.path().join(DEPENDENCY_VERDICTS_DIR).join("k.json").is_file());
        assert_eq!(store.get("k"), Some(verdict()));
    }

    #[test]
    fn writes_nothing_without_cache_writes_and_keeps_nothing_for_an_unreleased_build() {
        let root = tempfile::tempdir().unwrap();
        let out = quiet();
        let log = Logger::new(&out, root.path().to_path_buf());
        verdict_store_for(&input(root.path()), false, &log, "1.2.3").expect("a store").set("k", &verdict());
        assert!(!root.path().join(DEPENDENCY_VERDICTS_DIR).exists());
        assert!(verdict_store_for(&input(root.path()), true, &log, "1.2.3+unreleased").is_none());
    }

    #[test]
    fn reads_a_damaged_entry_as_none_and_one_of_another_format_for_its_format() {
        assert_eq!(kept_verdict("{"), None);
        assert_eq!(kept_verdict("{\"module\":\"Lib\"}"), None);
        assert_eq!(kept_verdict("{\"module\":\"Lib\",\"diagnostics\":[]}").map(|v| v.format), Some(0));
    }
}

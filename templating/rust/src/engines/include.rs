//! The `!include-text` / `!include-bytes` file-embedding tags, mirroring
//! `../../../nodejs/src/engines/include.ts`.
//!
//! The path grammar — the half that must give the same answer on both kernels, because it
//! decides what a manifest MEANS — and the two engines over it: `compile` leaves the marker
//! for whoever reads it, `analyze` reports why a path is unusable, `file_claims` hands the
//! path to publish. Reading the file is the kernel's, and the two kernels differ there: see
//! `kernel/rust/src/resolve_include_sentinels.rs`.

use serde_json::{json, Value};
use telorun_cel_value::es_trim;

use crate::cel::verdict_codes::TemplatingError;
use crate::engine::{AnalyzeEnv, AnalyzeResult, CompileEnv, CompileOutcome, EngineDiagnostic, EngineFileClaim, TemplatingEngine};

/// Engine name for the text-embedding tag, `!include-text`.
pub const INCLUDE_TEXT_ENGINE: &str = "include-text";
/// Engine name for the byte-embedding tag, `!include-bytes`.
pub const INCLUDE_BYTES_ENGINE: &str = "include-bytes";

/// True when `engine` names one of the two file-embedding tags.
pub fn is_include_engine(engine: &str) -> bool {
    engine == INCLUDE_TEXT_ENGINE || engine == INCLUDE_BYTES_ENGINE
}

/// Why a written path is not a usable module-relative reference: the diagnostic code that
/// reports it and the sentence saying what is wrong.
#[derive(Debug, PartialEq, Eq)]
pub struct IncludePathError {
    pub code: &'static str,
    pub message: String,
}

/// What differs between the tags that name a module-root-relative location: their codes and
/// how a message names what the path must be.
struct RootRelativeGrammar {
    invalid: &'static str,
    escapes: &'static str,
    /// "An include path" / "A module path".
    noun: &'static str,
    /// What one such path names, for the refusal of a pattern.
    names: &'static str,
    /// Where a location outside the module is written instead.
    elsewhere: &'static str,
}

const INCLUDE_PATH_GRAMMAR: RootRelativeGrammar = RootRelativeGrammar {
    invalid: "INCLUDE_PATH_INVALID",
    escapes: "INCLUDE_PATH_ESCAPES_MODULE",
    noun: "An include path",
    names: "exactly one file",
    elsewhere: "To read a file at runtime from somewhere else, use Fs.File.",
};

const MODULE_PATH_GRAMMAR: RootRelativeGrammar = RootRelativeGrammar {
    invalid: "MODULE_PATH_INVALID",
    escapes: "MODULE_PATH_ESCAPES_MODULE",
    noun: "A module path",
    names: "one file or directory",
    elsewhere: "A location on the host is a Telo.HostPath value, read from a variable.",
};

/// Normalize an `!include-*` source to a module-root-relative path, or explain
/// why it is not one.
///
/// Pure string work, exactly as in the Node half: the path is root-relative by
/// definition, so `..` below depth zero is an escape regardless of where the
/// module sits on disk, and confinement never needs a filesystem to decide.
pub fn normalize_include_path(source: &str) -> Result<String, IncludePathError> {
    normalize_root_relative(source, &INCLUDE_PATH_GRAMMAR)
}

/// Normalize a `!module-path` source — a file or a directory that ships inside
/// the module — by the same pure-string rules as an include path.
pub fn normalize_module_path(source: &str) -> Result<String, IncludePathError> {
    normalize_root_relative(source, &MODULE_PATH_GRAMMAR)
}

fn normalize_root_relative(source: &str, grammar: &RootRelativeGrammar) -> Result<String, IncludePathError> {
    let RootRelativeGrammar { noun, names, elsewhere, .. } = grammar;
    let invalid = |message: String| IncludePathError { code: grammar.invalid, message };
    let escapes = |message: String| IncludePathError { code: grammar.escapes, message };
    let raw = es_trim(source);
    if raw.is_empty() {
        return Err(invalid("the path is empty \u{2014} name a location relative to the module root.".into()));
    }
    if has_uri_scheme(raw) {
        return Err(invalid(format!(
            "'{raw}' names a location outside the module. {noun} names what ships \
             inside the module artifact, written relative to the module root. {elsewhere}"
        )));
    }
    if raw.contains(['*', '?', '[', ']', '{', '}']) {
        return Err(invalid(format!(
            "'{raw}' looks like a pattern. {noun} names {names}, because \
             publish places each claimed file into a layer by name."
        )));
    }
    if raw.starts_with('/') || raw.starts_with('\\') {
        return Err(escapes(format!(
            "'{raw}' is an absolute path. {noun} is written relative to the module \
             root, so the same manifest resolves identically from a checkout and from a \
             published artifact."
        )));
    }

    let mut out: Vec<&str> = Vec::new();
    for segment in raw.split(['/', '\\']) {
        match segment {
            "" | "." => continue,
            ".." => {
                // Depth zero is the module root; popping past it names a file the
                // artifact could never carry.
                if out.pop().is_none() {
                    return Err(escapes(format!(
                        "'{raw}' points above the module root. {noun} may only name what is \
                         inside the module, since that is the only thing its artifact can carry."
                    )));
                }
            }
            other => out.push(other),
        }
    }
    if out.is_empty() {
        return Err(invalid(format!(
            "'{raw}' resolves to the module root itself, which is not {names} of it \u{2014} \
             name what inside it you mean."
        )));
    }
    Ok(out.join("/"))
}

/// `scheme:` prefix — a URL, or a Windows drive letter.
fn has_uri_scheme(raw: &str) -> bool {
    let mut chars = raw.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-') {
            return false;
        }
    }
    false
}

/// The `!include-text` / `!include-bytes` engines. `compile` returns the marker unchanged
/// rather than a value, so the read is deferred to resource creation and the analyzer can
/// type the slot without opening the file.
pub struct IncludeEngine {
    name: &'static str,
    bytes: bool,
}

/// Embeds a file's contents as a UTF-8 string.
pub static INCLUDE_TEXT: IncludeEngine = IncludeEngine { name: INCLUDE_TEXT_ENGINE, bytes: false };
/// Embeds a file's contents as raw bytes — the shape every `Telo.Bytes` slot accepts.
pub static INCLUDE_BYTES: IncludeEngine = IncludeEngine { name: INCLUDE_BYTES_ENGINE, bytes: true };

impl TemplatingEngine for IncludeEngine {
    fn name(&self) -> &'static str {
        self.name
    }

    #[allow(unused_variables)]
    fn compile(&self, source: &str, env: &CompileEnv<'_>) -> Result<CompileOutcome, TemplatingError> {
        Ok(CompileOutcome::Unchanged)
    }

    fn produced_type(&self) -> Option<Value> {
        Some(if self.bytes { json!({ "x-telo-type": "Telo.Bytes" }) } else { json!({ "type": "string" }) })
    }

    #[allow(unused_variables)]
    fn analyze(&self, source: &str, env: &AnalyzeEnv<'_>) -> AnalyzeResult {
        path_analysis(normalize_include_path(source))
    }

    fn file_claims(&self, source: &str) -> Vec<EngineFileClaim> {
        // A malformed path claims nothing: `analyze` is what says why.
        match normalize_include_path(source) {
            Ok(path) => vec![EngineFileClaim { path, directory: false, not_found_code: "INCLUDE_FILE_NOT_FOUND" }],
            Err(_) => Vec::new(),
        }
    }
}

/// The diagnostics a path's normalization reports, as an `analyze` answer.
pub(crate) fn path_analysis(path: Result<String, IncludePathError>) -> AnalyzeResult {
    AnalyzeResult {
        diagnostics: path
            .err()
            .map(|error| EngineDiagnostic { message: error.message, code: Some(error.code.into()), fix: None })
            .into_iter()
            .collect(),
        ..AnalyzeResult::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_dot_segments_to_a_root_relative_path() {
        assert_eq!(normalize_include_path("./assets/logo.svg").unwrap(), "assets/logo.svg");
        assert_eq!(normalize_include_path("assets/./logo.svg").unwrap(), "assets/logo.svg");
    }

    #[test]
    fn resolves_an_interior_parent_segment() {
        assert_eq!(
            normalize_include_path("assets/fonts/../logo.svg").unwrap(),
            "assets/logo.svg"
        );
    }

    #[test]
    fn normalizes_backslash_separators() {
        assert_eq!(normalize_include_path("assets\\logo.svg").unwrap(), "assets/logo.svg");
    }

    #[test]
    fn rejects_paths_above_the_module_root() {
        assert!(normalize_include_path("../outside.txt").is_err());
        assert!(normalize_include_path("assets/../../outside.txt").is_err());
    }

    #[test]
    fn rejects_absolute_paths_urls_and_globs() {
        assert!(normalize_include_path("/etc/passwd").is_err());
        assert!(normalize_include_path("https://example.com/a.png").is_err());
        assert!(normalize_include_path("assets/*.svg").is_err());
    }

    #[test]
    fn rejects_an_empty_path_and_one_that_is_the_root() {
        assert!(normalize_include_path("").is_err());
        assert!(normalize_include_path("./").is_err());
    }

    #[test]
    fn a_dotted_filename_is_not_a_uri_scheme() {
        assert_eq!(normalize_include_path("assets/a.b.c.svg").unwrap(), "assets/a.b.c.svg");
    }
}

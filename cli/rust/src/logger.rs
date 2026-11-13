//! How a diagnostic is shown: its location resolved to `file:line:col`, the text line, and
//! the `-o json` entry. Mirrors the parts of `../../nodejs/src/logger.ts` that `telo check`
//! reads: `createLogger`, `resolveLocation`, `formatAnalysisDiagnostics`, and the
//! single-diagnostic case of `formatDiagnostics` a path that did not load is shown with.
//! The runtime-diagnostic renderer (collapsed blocked groups) has no reader here.

use std::path::{Path, PathBuf};

use serde::Serialize;
use telo_analyzer::{locate_diagnostic, AnalysisDiagnostic, DiagnosticFix, DiagnosticSeverity, LoadedGraph};
use telo_kernel::lexical_path;

use crate::output::{Output, Palette};

/// The colouring of the CLI's own text. Its methods paint text destined for STDOUT;
/// [`Logger::err`] is the same palette bound to stderr.
pub struct Logger<'a> {
    pub out: &'a Output,
    /// The working directory every shown path is relative to.
    pub cwd: PathBuf,
}

impl<'a> Logger<'a> {
    pub fn new(out: &'a Output, cwd: PathBuf) -> Self {
        Self { out, cwd }
    }

    pub fn ok(&self, text: &str) -> String {
        self.out.stdout.ok(text)
    }

    pub fn warn(&self, text: &str) -> String {
        self.out.stdout.warn(text)
    }

    pub fn error(&self, text: &str) -> String {
        self.out.stdout.error(text)
    }

    pub fn dim(&self, text: &str) -> String {
        self.out.stdout.dim(text)
    }

    /// Palette for text written to stderr.
    pub fn err(&self) -> &Palette {
        &self.out.stderr
    }
}

/// `path.relative(from, to)`, both made absolute first, joined with the host separator.
pub fn relative_path(from: &Path, to: &Path) -> String {
    let from = lexical_path::normalize(from);
    let to = lexical_path::normalize(to);
    let from_parts: Vec<_> = from.components().collect();
    let to_parts: Vec<_> = to.components().collect();
    let common = from_parts.iter().zip(&to_parts).take_while(|(a, b)| a == b).count();
    // Another root (a Windows drive) has no relative spelling.
    if common == 0 && from_parts.first().is_some_and(|c| matches!(c, std::path::Component::Prefix(_))) {
        return to.to_string_lossy().into_owned();
    }
    let mut parts: Vec<String> = vec!["..".to_string(); from_parts.len() - common];
    parts.extend(to_parts[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    parts.join(std::path::MAIN_SEPARATOR_STR)
}

/// A manifest source for display: a path becomes cwd-relative, a real remote URL is kept
/// absolute, and a `file://` URL reads as its path.
pub fn display_source_path(raw: &str, cwd: &Path) -> String {
    if let Some(path) = raw.strip_prefix("file://") {
        return relative_path(cwd, &absolute_in(cwd, path));
    }
    if raw.contains("://") {
        return raw.to_string();
    }
    relative_path(cwd, &absolute_in(cwd, raw))
}

fn absolute_in(cwd: &Path, path: &str) -> PathBuf {
    let path = Path::new(path);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    }
}

/// Where a diagnostic is shown, 1-based.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocationParts {
    pub file: String,
    pub line: usize,
    pub column: usize,
}

/// `file:line:col` of `d`, through the analyzer's `locate_diagnostic` — the rule every host
/// shares. `None` when nothing located it.
fn resolve_location_parts(
    graph: &LoadedGraph,
    d: &AnalysisDiagnostic,
    fallback_source: &str,
    cwd: &Path,
) -> Option<LocationParts> {
    let located = locate_diagnostic(graph, d)?;
    let source = located.file.as_deref().unwrap_or(fallback_source);
    Some(LocationParts {
        file: display_source_path(source, cwd),
        line: located.range.start.line + 1,
        column: located.range.start.character + 1,
    })
}

/// One diagnostic as `-o json` reports it: the machine contract that replaces parsing the
/// prose form, its location pre-resolved.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct JsonDiagnostic {
    pub file: String,
    pub line: usize,
    pub column: usize,
    pub severity: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub message: String,
    /// `<kind>/<name>` of the resource the diagnostic is pinned to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    /// Dotted path of the offending value within that resource.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<DiagnosticFix>,
}

pub struct Counts {
    pub error_count: usize,
    pub warn_count: usize,
    pub diagnostics: Vec<JsonDiagnostic>,
}

/// Print each diagnostic with its location resolved against `graph` and collect it for the
/// payload. `entry_path` leads an unlocatable one: `check` has no resource-named form to
/// fall back to.
pub fn format_analysis_diagnostics(
    diagnostics: &[AnalysisDiagnostic],
    graph: &LoadedGraph,
    log: &Logger,
    entry_path: &str,
) -> std::io::Result<Counts> {
    let mut error_count = 0;
    let mut warn_count = 0;
    let mut collected = Vec::new();
    for d in diagnostics {
        let parts = resolve_location_parts(graph, d, entry_path, &log.cwd).unwrap_or_else(|| LocationParts {
            file: display_source_path(entry_path, &log.cwd),
            line: 1,
            column: 1,
        });
        let is_error = d.severity.unwrap_or(DiagnosticSeverity::Warning) as u8 <= DiagnosticSeverity::Error as u8;
        let severity_label = if is_error { log.error("error") } else { log.warn("warning") };
        let code = d.code.as_ref().map(|code| format!("  {}", log.dim(code))).unwrap_or_default();
        log.out.line(&format!(
            "{}:{}:{}  {severity_label}  {}{code}",
            parts.file, parts.line, parts.column, d.message
        ))?;
        let stamp = d.data.as_ref();
        collected.push(JsonDiagnostic {
            file: parts.file,
            line: parts.line,
            column: parts.column,
            severity: if is_error { "error" } else { "warning" },
            code: d.code.clone(),
            message: d.message.clone(),
            resource: stamp.and_then(|data| data.resource.as_ref()).map(|r| format!("{}/{}", r.kind, r.name)),
            path: stamp.and_then(|data| data.path.clone()).filter(|path| !path.is_empty()),
            fix: stamp.and_then(|data| data.fix.clone()),
        });
        if is_error {
            error_count += 1;
        } else {
            warn_count += 1;
        }
    }
    Ok(Counts { error_count, warn_count, diagnostics: collected })
}

/// A path that did not load, as one diagnostic: printed on stderr, and — since a load
/// failure is a diagnostic like any other to a `-o json` consumer — carried in the payload.
pub fn load_failure(
    display_path: &str,
    message: &str,
    source_line: Option<usize>,
    log: &Logger,
) -> std::io::Result<Counts> {
    let location = source_line.map(|line| format!(":{}", line + 1)).unwrap_or_default();
    log.out.err_line(&format!("{display_path}{location}  {}  {message}", log.err().error("error")))?;
    Ok(Counts {
        error_count: 1,
        warn_count: 0,
        diagnostics: vec![JsonDiagnostic {
            file: display_path.to_string(),
            line: source_line.map_or(1, |line| line + 1),
            column: 1,
            severity: "error",
            code: None,
            message: message.to_string(),
            resource: None,
            path: None,
            fix: None,
        }],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_climb_and_descend_as_node_does() {
        let cwd = Path::new("/a/b/c");
        assert_eq!(display_source_path("/a/b/c/x/telo.yaml", cwd), "x/telo.yaml");
        assert_eq!(display_source_path("/a/b/d/telo.yaml", cwd), "../d/telo.yaml");
        assert_eq!(display_source_path("/a/b/c", cwd), "");
        assert_eq!(display_source_path("oci://ghcr.io/x/y@1", cwd), "oci://ghcr.io/x/y@1");
        assert_eq!(display_source_path("rel/telo.yaml", cwd), "rel/telo.yaml");
    }
}

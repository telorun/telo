//! Shared manifest types, mirroring `../../nodejs/src/types.ts`.
//!
//! A manifest is a plain [`serde_json::Value`]; the accessors below name the
//! handful of well-known fields rather than introducing a struct, because a
//! resource's shape is defined by its kind's schema and not by the kernel.
//!
//! In Node these types come from `@telorun/sdk`. They live here instead because
//! the Rust kernel must not depend on `telorun-sdk`: that crate selects a
//! controller backend by feature, and Cargo would unify the napi backend into
//! the kernel binary.

use indexmap::IndexMap;
use serde::{Serialize, Serializer};
use serde_json::Value;

use crate::quoted_place::QuotedPlace;

pub const DEFAULT_MANIFEST_FILENAME: &str = "telo.yaml";

/// A place in a file: 0-based line, and 0-based character in UTF-16 code units.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Position {
    pub line: usize,
    pub character: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

/// Maps a dotted field path (`kind`, `config.routes[0].path`) to its source range; a
/// map key's own range is filed under `@key:<path>`. Built from the YAML nodes before the
/// conversion to plain JSON, so positions never enter the manifest tree.
pub type PositionIndex = IndexMap<String, Range>;

/// LSP's `DiagnosticSeverity`, serialized as its number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosticSeverity {
    Error = 1,
    Warning = 2,
    Information = 3,
    Hint = 4,
}

impl Serialize for DiagnosticSeverity {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(*self as u8)
    }
}

/// LSP's `DiagnosticTag`, serialized as its number — declared whole, as the Node twin is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosticTag {
    Unnecessary = 1,
    Deprecated = 2,
}

impl Serialize for DiagnosticTag {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(*self as u8)
    }
}

/// The YAML tag a repair writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiagnosticFixTag {
    Ref,
    Cel,
    ModulePath,
}

/// A mechanically applicable repair: the whole value at the diagnostic's `path`,
/// corrected, optionally written behind a tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiagnosticFix {
    pub replacement: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<DiagnosticFixTag>,
}

/// The declaration a diagnostic is about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiagnosticResource {
    pub kind: String,
    pub name: String,
}

/// The `data` stamp a diagnostic carries — the fields Node's `DiagnosticData`
/// declares, and the further ones its producers stamp, under their Node names.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct DiagnosticData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<DiagnosticResource>,
    #[serde(rename = "filePath", skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    /// Dotted path of the offending value within its resource.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<DiagnosticFix>,
    /// The line of the declaration a file-level diagnostic belongs to (an import's).
    #[serde(rename = "sourceLine", skip_serializing_if = "Option::is_none")]
    pub source_line: Option<usize>,
    /// The kind of source failure that left an import's target unobtained.
    #[serde(rename = "sourceFailure", skip_serializing_if = "Option::is_none")]
    pub source_failure: Option<String>,
    /// The places the message quotes, in order.
    #[serde(rename = "quotedPlace", skip_serializing_if = "Option::is_none")]
    pub quoted_place: Option<Vec<QuotedPlace>>,
    /// The code a kernel raises the refusal under, where it is not `ERR_<code>`.
    #[serde(rename = "runtimeCode", skip_serializing_if = "Option::is_none")]
    pub runtime_code: Option<String>,
    /// The rewrite a migration's deprecation reports.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub migration: Option<DiagnosticMigration>,
    /// Where the defect an import-anchored finding re-reports is written: the place the
    /// declaring module's own check reports it at.
    #[serde(rename = "writtenAt", skip_serializing_if = "Option::is_none")]
    pub written_at: Option<WrittenAt>,
}

/// Where a defect is written, Node's `WrittenAt`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct WrittenAt {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<DiagnosticResource>,
    #[serde(rename = "filePath", skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl WrittenAt {
    /// The place `data` reports its own diagnostic at.
    pub fn of(data: &DiagnosticData) -> Self {
        WrittenAt { resource: data.resource.clone(), file_path: data.file_path.clone(), path: data.path.clone() }
    }
}

/// The rewrite a migration's deprecation reports: the entry, and the path before and after.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiagnosticMigration {
    pub id: String,
    #[serde(rename = "legacyPath")]
    pub legacy_path: String,
    #[serde(rename = "migratedPath")]
    pub migrated_path: String,
}

/// An LSP-compatible diagnostic, Node's `AnalysisDiagnostic`. `range` is absent when only
/// the diagnostic's `data` locates it (`diagnostic_location::locate_diagnostic`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AnalysisDiagnostic {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<Range>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<DiagnosticSeverity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<DiagnosticTag>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<DiagnosticData>,
}

/// The source every analyzer diagnostic names.
pub const ANALYZER_SOURCE: &str = "telo-analyzer";

impl AnalysisDiagnostic {
    /// An error of the analyzer.
    pub fn error(code: &str, message: impl Into<String>, data: DiagnosticData) -> Self {
        Self {
            range: None,
            severity: Some(DiagnosticSeverity::Error),
            code: Some(code.to_string()),
            source: Some(ANALYZER_SOURCE.to_string()),
            message: message.into(),
            tags: None,
            data: Some(data),
        }
    }
}

/// A single YAML document from a manifest file.
pub type ResourceManifest = Value;

/// What a [`ManifestSource`] hands back: the text and the canonical location it
/// was read from, which later relative sources resolve against.
pub struct ReadManifest {
    pub text: String,
    pub source: String,
}

/// A transport a manifest can be read through, mirroring Node's `ManifestSource`. The Rust kernel registers the local-file source, the workspace manifest cache and the OCI registry source; an HTTP(S) import has no Rust source, so the kernel refuses it as a construct this build cannot read.
pub trait ManifestSource {
    fn supports(&self, path_or_url: &str) -> bool;
    fn read(&self, path_or_url: &str) -> Result<ReadManifest, LoadError>;

    /// `relative` resolved against `base`, a location this source reads (Node's
    /// `resolveRelative`): by default the path joined to `base`'s directory.
    fn resolve_relative(&self, base: &str, relative: &str) -> Result<String, LoadError> {
        Ok(join_relative(base, relative))
    }

    /// The files `patterns` select beside `base`, `.gitignore`-style (Node's `expandGlob`);
    /// `None` for a source that cannot list files.
    fn expand_glob(&self, base: &str, patterns: &[String]) -> Option<Result<Vec<String>, LoadError>> {
        let _ = (base, patterns);
        None
    }
}

/// `relative` joined to the directory of `base`, `.` and `..` collapsed lexically, so an
/// unreadable path still names what was looked for. An absolute `relative` is itself.
pub fn join_relative(base: &str, relative: &str) -> String {
    let base_dir = std::path::Path::new(base).parent().unwrap_or_else(|| std::path::Path::new("."));
    let mut out = std::path::PathBuf::new();
    for component in base_dir.join(relative).components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().into_owned()
}

#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    /// No registered source reads the location: Node's loader's own words.
    #[error("No source found for: {0}")]
    UnsupportedSource(String),
    /// The source could not hand the manifest over, worded by Telo.
    #[error("{0}")]
    Source(crate::sources::source_failure::ManifestSourceFailure),
    /// A read that failed for a reason outside the source-failure set (an integrity
    /// mismatch, a malformed artifact), in the source's own words.
    #[error("{0}")]
    Failed(String),
    /// A construct this build cannot read — a transport or a nested artifact the Rust
    /// sources do not implement: never a diagnostic, a refusal of the Rust hosts.
    #[error("{0}")]
    Unsupported(String),
    #[error("failed to read `{path}`: {message}")]
    Io { path: String, message: String },
}

/// `kind` of a resource document.
pub fn kind_of(manifest: &ResourceManifest) -> Option<&str> {
    manifest.get("kind").and_then(Value::as_str)
}

/// `metadata.name` of a resource document.
pub fn name_of(manifest: &ResourceManifest) -> Option<&str> {
    manifest
        .get("metadata")
        .and_then(|metadata| metadata.get("name"))
        .and_then(Value::as_str)
}

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
    /// The places the message quotes, in order.
    #[serde(rename = "quotedPlace", skip_serializing_if = "Option::is_none")]
    pub quoted_place: Option<Vec<QuotedPlace>>,
    /// The code a kernel raises the refusal under, where it is not `ERR_<code>`.
    #[serde(rename = "runtimeCode", skip_serializing_if = "Option::is_none")]
    pub runtime_code: Option<String>,
    /// The rewrite a migration's deprecation reports.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub migration: Option<DiagnosticMigration>,
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

/// A transport a manifest can be read through. The Rust kernel registers the local-file source, the workspace manifest cache and the OCI registry source; an HTTP(S) import has no Rust source, so it fails at resolution with a precise message rather than being silently skipped.
pub trait ManifestSource {
    fn supports(&self, path_or_url: &str) -> bool;
    fn read(&self, path_or_url: &str) -> Result<ReadManifest, LoadError>;
}

#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    #[error("no manifest source supports `{0}`. This kernel reads local paths and oci:// refs only")]
    UnsupportedSource(String),
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

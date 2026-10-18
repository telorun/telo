//! Checking an expression against the Node build's answer.
//!
//! A row is a source, the type name Node answers for it and every diagnostic Node
//! reports, in order. A schema is written as JSON text and read with `read_json_text`, so
//! every object is its own node, as `JSON.parse` makes it.

#![allow(dead_code)]

use std::sync::Arc;

use telorun_cel::{
    read_json_text, CelCheckCode, CelCheckDiagnostic, CelDiagnosticFix, CelEnvironment, CelEnvironmentOptions,
    CheckResult, JsonSchemaDocument, JsonValue, SourceRange, TypeDeclaration,
};

pub fn range(start: u32, end: u32) -> SourceRange {
    SourceRange { start, end }
}

pub fn found(code: CelCheckCode, message: &str, start: u32, end: u32) -> CelCheckDiagnostic {
    CelCheckDiagnostic { code, message: message.into(), range: range(start, end), fix: None }
}

pub fn fixed(code: CelCheckCode, message: &str, start: u32, end: u32, replacement: &str) -> CelCheckDiagnostic {
    CelCheckDiagnostic {
        code,
        message: message.into(),
        range: range(start, end),
        fix: Some(CelDiagnosticFix { replacement: replacement.into() }),
    }
}

pub fn json(text: &str) -> Arc<JsonValue> {
    read_json_text(text).expect("the row is JSON")
}

/// A schema standing as its own document.
pub fn schema(text: &str) -> TypeDeclaration {
    TypeDeclaration::Schema(JsonSchemaDocument { node: json(text), root: None })
}

pub fn environment(options: CelEnvironmentOptions) -> CelEnvironment {
    CelEnvironment::new(options)
}

pub fn optional_types() -> CelEnvironmentOptions {
    CelEnvironmentOptions { enable_optional_types: true, ..Default::default() }
}

pub fn unlisted_dyn() -> CelEnvironmentOptions {
    CelEnvironmentOptions { unlisted_variables_are_dyn: true, ..Default::default() }
}

pub fn codes(result: &CheckResult) -> Vec<CelCheckCode> {
    result.diagnostics.iter().map(|diagnostic| diagnostic.code).collect()
}

pub fn first_code(result: &CheckResult) -> Option<CelCheckCode> {
    result.diagnostics.first().map(|diagnostic| diagnostic.code)
}

pub type Row = (&'static str, &'static str, Vec<CelCheckDiagnostic>);

/// Each row's type name and diagnostics, as Node answers them.
pub fn assert_rows(environment: &CelEnvironment, rows: Vec<Row>) {
    for (source, type_name, diagnostics) in rows {
        let result = environment.check(source);
        assert_eq!((result.type_name.as_str(), &result.diagnostics), (type_name, &diagnostics), "{source}");
        assert_eq!(result.valid, diagnostics.is_empty(), "{source}");
    }
}

/// The type name a source checks to, with no diagnostic.
pub fn type_of(environment: &CelEnvironment, source: &str) -> String {
    let result = environment.check(source);
    assert_eq!(result.diagnostics, [], "{source}");
    result.type_name
}

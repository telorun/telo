//! An error as the vectors record one: `{ code, celCode, message, range? }`, read from the
//! error that left the seam, never from its cause — the twin of
//! `cel/nodejs/conformance/conformance-error.ts`.
//!
//! `code` is the Telo error code the error carries (`ERR_…`), `celCode` the engine's own
//! code — an evaluation code, or an engine error's — and at most one is non-null. An error
//! carrying no code records both as null. An error the format cannot record makes the row
//! that raised it malformed, and its runner fails.
//!
//! Node's classifier reads a thrown JavaScript value; here the engine's errors are a closed
//! enum, so each variant is classified where Node tests a class: an evaluation error and an
//! engine error give `celCode`, a compile error (Node's `CelCompileError`, which carries no
//! code) gives both null, and a host's own failure — reached only through a namespaced
//! call, which no engine replay makes — is not one the format can record. No engine error
//! carries an `ERR_*` code, so Node's branch for one has no twin.

#![allow(dead_code)]

use serde_json::{Map, Value};
use telorun_cel::{
    CelCheckCode, CelCheckDiagnostic, CelEngineErrorCode, CelEvaluateError, SourceRange, CEL_CHECK_CODES,
    CEL_EVALUATION_CODES,
};

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RecordedError {
    pub code: Option<String>,
    pub cel_code: Option<String>,
    pub message: String,
    pub range: Option<SourceRange>,
}

impl RecordedError {
    /// The error as a row writes it.
    pub fn to_json(&self) -> Value {
        let text = |held: &Option<String>| held.clone().map(Value::String).unwrap_or(Value::Null);
        let mut out = Map::new();
        out.insert("code".into(), text(&self.code));
        out.insert("celCode".into(), text(&self.cel_code));
        out.insert("message".into(), Value::String(self.message.clone()));
        if let Some(range) = self.range {
            out.insert("range".into(), recorded_range(range));
        }
        Value::Object(out)
    }
}

/// An error whose code the format has no place for.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct UnrecordableError(pub String);

/// Every engine-error code, held complete by an exhaustive match.
pub const ENGINE_ERROR_CODES: [CelEngineErrorCode; 4] = [
    CelEngineErrorCode::NamespacesMismatch,
    CelEngineErrorCode::UnreadableExpression,
    CelEngineErrorCode::EmittedModuleRejected,
    CelEngineErrorCode::SignatureTooWide,
];

/// The position of a code in [`ENGINE_ERROR_CODES`]: a code added to the enum fails to
/// compile here until it is given its place in the list.
fn engine_error_code_position(code: CelEngineErrorCode) -> usize {
    match code {
        CelEngineErrorCode::NamespacesMismatch => 0,
        CelEngineErrorCode::UnreadableExpression => 1,
        CelEngineErrorCode::EmittedModuleRejected => 2,
        CelEngineErrorCode::SignatureTooWide => 3,
    }
}

/// The check codes a language row's error may carry: the `CEL_*` verdicts.
pub fn cel_check_error_codes() -> Vec<&'static str> {
    CEL_CHECK_CODES.iter().map(|code: &CelCheckCode| code.as_str()).filter(|code| code.starts_with("CEL_")).collect()
}

/// Every `celCode` a language row may record.
pub fn language_cel_codes() -> Vec<&'static str> {
    for (at, code) in ENGINE_ERROR_CODES.iter().enumerate() {
        assert_eq!(engine_error_code_position(*code), at, "{} is listed out of its place", code.as_str());
    }
    let mut codes: Vec<&'static str> = CEL_EVALUATION_CODES.iter().map(|code| code.as_str()).collect();
    codes.extend(ENGINE_ERROR_CODES.iter().map(|code| code.as_str()));
    codes.extend(cel_check_error_codes());
    codes
}

pub fn recorded_range(range: SourceRange) -> Value {
    let mut out = Map::new();
    out.insert("start".into(), Value::from(range.start));
    out.insert("end".into(), Value::from(range.end));
    Value::Object(out)
}

/// The refusal a check made, as the error the evaluation half records for it.
pub fn check_refusal(diagnostic: &CelCheckDiagnostic) -> RecordedError {
    RecordedError {
        code: None,
        cel_code: Some(diagnostic.code.as_str().to_string()),
        message: diagnostic.message.clone(),
        range: Some(diagnostic.range),
    }
}

/// What a failed compile or evaluation records.
pub fn recorded_error(cause: &CelEvaluateError) -> Result<RecordedError, UnrecordableError> {
    match cause {
        CelEvaluateError::Evaluation(error) => Ok(RecordedError {
            code: None,
            cel_code: Some(error.code.as_str().to_string()),
            message: error.message.clone(),
            range: error.range,
        }),
        CelEvaluateError::Engine(error) => Ok(RecordedError {
            code: None,
            cel_code: Some(error.code.as_str().to_string()),
            message: error.message.clone(),
            range: None,
        }),
        CelEvaluateError::Compile(error) => {
            Ok(RecordedError { code: None, cel_code: None, message: error.message.clone(), range: None })
        }
        CelEvaluateError::Host(failure) => {
            Err(UnrecordableError(format!("a host's own failure left the evaluation, which carries no code the format can record: {failure:?}")))
        }
    }
}

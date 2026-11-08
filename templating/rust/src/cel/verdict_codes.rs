//! Every code the `!cel`, `!interpolate` and `!sql` engines emit — `verdict-codes.ts`.
//!
//! The diagnostic codes `analyze` reports and the error codes compiling or evaluating
//! fails with are stated once, as two enums. A diagnostic those engines build is a
//! [`CelDiagnostic`], whose code is a [`CelDiagnosticCode`], so the crate's own build
//! refuses a code the list does not hold — the checker's codes are forwarded through an
//! exhaustive conversion. A coded failure is built by [`cel_verdict_error`] alone.
//!
//! Four codes the engine decides are in the list and no row can pin, because these engines
//! cannot reach them: `FUNCTION_UNRESOLVED`, `FUNCTION_ARITY_MISMATCH` and
//! `FUNCTION_ARGUMENT_MISMATCH` need a namespace declared closed with a parameter list, and
//! a module's names are registered open with their parameters withheld;
//! `CEL_TYPE_ARGUMENT_MISMATCH` needs a parameterized value type on both sides, and the
//! brands registered here are nominal. The conformance runner exempts them.
//!
//! Declared here and not in the Node file: [`TemplatingError`] — Node throws a
//! `RuntimeError` or the engine's own error; a Rust engine answers this.

use std::fmt;

use telorun_cel::CelCheckCode;

use crate::engine::{AnalyzeResult, DiagnosticFix, EngineDiagnostic};

/// A diagnostic code the three engines report.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum CelDiagnosticCode {
    BindingNameReserved,
    CelInvalidArgument,
    CelNullableAccess,
    CelSyntaxError,
    CelTypeArgumentMismatch,
    CelTypeError,
    CelUnknownField,
    CelUnknownFunction,
    CelUnknownIdentifier,
    CelWrongCallForm,
    FunctionArgumentMismatch,
    FunctionArityMismatch,
    FunctionUnresolved,
    InterpolationHoleNotConvertible,
}

impl CelDiagnosticCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BindingNameReserved => "BINDING_NAME_RESERVED",
            Self::CelInvalidArgument => "CEL_INVALID_ARGUMENT",
            Self::CelNullableAccess => "CEL_NULLABLE_ACCESS",
            Self::CelSyntaxError => "CEL_SYNTAX_ERROR",
            Self::CelTypeArgumentMismatch => "CEL_TYPE_ARGUMENT_MISMATCH",
            Self::CelTypeError => "CEL_TYPE_ERROR",
            Self::CelUnknownField => "CEL_UNKNOWN_FIELD",
            Self::CelUnknownFunction => "CEL_UNKNOWN_FUNCTION",
            Self::CelUnknownIdentifier => "CEL_UNKNOWN_IDENTIFIER",
            Self::CelWrongCallForm => "CEL_WRONG_CALL_FORM",
            Self::FunctionArgumentMismatch => "FUNCTION_ARGUMENT_MISMATCH",
            Self::FunctionArityMismatch => "FUNCTION_ARITY_MISMATCH",
            Self::FunctionUnresolved => "FUNCTION_UNRESOLVED",
            Self::InterpolationHoleNotConvertible => "INTERPOLATION_HOLE_NOT_CONVERTIBLE",
        }
    }
}

/// The checker decides these and the engines forward them; the conversion is exhaustive,
/// so a code the checker gains is a build failure here until the list holds it.
impl From<CelCheckCode> for CelDiagnosticCode {
    fn from(code: CelCheckCode) -> Self {
        match code {
            CelCheckCode::SyntaxError => Self::CelSyntaxError,
            CelCheckCode::TypeError => Self::CelTypeError,
            CelCheckCode::UnknownIdentifier => Self::CelUnknownIdentifier,
            CelCheckCode::UnknownField => Self::CelUnknownField,
            CelCheckCode::UnknownFunction => Self::CelUnknownFunction,
            CelCheckCode::WrongCallForm => Self::CelWrongCallForm,
            CelCheckCode::TypeArgumentMismatch => Self::CelTypeArgumentMismatch,
            CelCheckCode::NullableAccess => Self::CelNullableAccess,
            CelCheckCode::InvalidArgument => Self::CelInvalidArgument,
            CelCheckCode::FunctionUnresolved => Self::FunctionUnresolved,
            CelCheckCode::FunctionArityMismatch => Self::FunctionArityMismatch,
            CelCheckCode::FunctionArgumentMismatch => Self::FunctionArgumentMismatch,
        }
    }
}

/// An error code compiling or evaluating fails with.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum CelErrorCode {
    ErrInterpolationHoleNotConvertible,
}

impl CelErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ErrInterpolationHoleNotConvertible => "ERR_INTERPOLATION_HOLE_NOT_CONVERTIBLE",
        }
    }
}

/// The two lists.
pub struct CelVerdictCodes {
    pub diagnostics: &'static [CelDiagnosticCode],
    pub errors: &'static [CelErrorCode],
}

pub const CEL_VERDICT_CODES: CelVerdictCodes = CelVerdictCodes {
    diagnostics: &[
        CelDiagnosticCode::BindingNameReserved,
        CelDiagnosticCode::CelInvalidArgument,
        CelDiagnosticCode::CelNullableAccess,
        CelDiagnosticCode::CelSyntaxError,
        CelDiagnosticCode::CelTypeArgumentMismatch,
        CelDiagnosticCode::CelTypeError,
        CelDiagnosticCode::CelUnknownField,
        CelDiagnosticCode::CelUnknownFunction,
        CelDiagnosticCode::CelUnknownIdentifier,
        CelDiagnosticCode::CelWrongCallForm,
        CelDiagnosticCode::FunctionArgumentMismatch,
        CelDiagnosticCode::FunctionArityMismatch,
        CelDiagnosticCode::FunctionUnresolved,
        CelDiagnosticCode::InterpolationHoleNotConvertible,
    ],
    errors: &[CelErrorCode::ErrInterpolationHoleNotConvertible],
};

/// A diagnostic one of the three engines builds.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CelDiagnostic {
    pub code: CelDiagnosticCode,
    pub message: String,
    pub fix: Option<DiagnosticFix>,
}

impl From<CelDiagnostic> for EngineDiagnostic {
    fn from(diagnostic: CelDiagnostic) -> Self {
        EngineDiagnostic {
            message: diagnostic.message,
            code: Some(diagnostic.code.as_str().into()),
            fix: diagnostic.fix,
        }
    }
}

/// What those engines' `analyze` answers: an [`AnalyzeResult`] whose diagnostics are
/// coded from the list.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct CelAnalyzeResult {
    pub diagnostics: Vec<CelDiagnostic>,
    pub type_name: Option<String>,
    pub calls: Vec<crate::engine::CallSite>,
    pub string_literal: Option<String>,
    pub read_types: Option<Vec<String>>,
}

impl From<CelAnalyzeResult> for AnalyzeResult {
    fn from(result: CelAnalyzeResult) -> Self {
        AnalyzeResult {
            diagnostics: result.diagnostics.into_iter().map(Into::into).collect(),
            type_name: result.type_name,
            calls: result.calls,
            string_literal: result.string_literal,
            read_types: result.read_types,
        }
    }
}

/// Why compiling or evaluating a tagged value answered no value. `code` is a Telo error
/// code where one names the failure — set only by [`cel_verdict_error`] — and absent for
/// the engine's own refusals (an expression that does not read, an evaluation error).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TemplatingError {
    pub code: Option<String>,
    pub message: String,
}

impl TemplatingError {
    /// A failure no Telo code names.
    pub fn uncoded(message: impl Into<String>) -> Self {
        Self { code: None, message: message.into() }
    }
}

impl fmt::Display for TemplatingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.code {
            Some(code) => write!(f, "[{code}] {}", self.message),
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for TemplatingError {}

/// The one constructor of a coded failure those engines answer.
pub fn cel_verdict_error(code: CelErrorCode, message: impl Into<String>) -> TemplatingError {
    TemplatingError { code: Some(code.as_str().into()), message: message.into() }
}

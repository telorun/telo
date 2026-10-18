//! A function's declared shape: `size(string): int`, `string.startsWith(string): bool` —
//! `signature.ts`.
//!
//! One spelling serves registration, the signature data and the definition listing.
//! The dispatch key excludes the return type, so registering a signature that answers
//! the same call replaces the one that was there.
//!
//! The text is read as Node's pattern reads it,
//! `^(?:(.+)\.)?([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)\s*:\s*(.+)$` over the trimmed text,
//! by a matcher written out here: ECMAScript's whitespace for `\s` and the trim, a `.`
//! that never matches a line terminator, and the receiver taken at the last dot that
//! leaves the rest readable, as the greedy group backtracks.
//!
//! Node items with no twin in this file:
//! - `CelSignature.form` as a field — it is [`CelSignature::form`], derived from the
//!   receiver, so a form contradicting the receiver has no spelling.
//! - `FunctionMetadata.implementation` — implementations arrive with evaluation.
//!
//! Declared here and not in the Node file:
//! - `CallForm::as_str` — Node holds the form as the string itself.

use std::fmt;
use std::sync::Arc;

use telorun_cel_value::{es_trim, is_es_whitespace, json_quote, CelValue};

use crate::cel_type::{format_type, CelType};
use crate::type_expression::{parse_type_expression, CelTypeExpressionError, CelTypeTextError, NominalResolver};

/// How a call is written: `f(x)`, or on a value, `x.f()`.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum CallForm {
    Global,
    Receiver,
}

impl CallForm {
    pub fn as_str(self) -> &'static str {
        match self {
            CallForm::Global => "global",
            CallForm::Receiver => "receiver",
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CelSignature {
    pub name: String,
    /// The type the call is written on, for a receiver call.
    pub receiver: Option<CelType>,
    pub parameters: Vec<CelType>,
    pub returns: CelType,
}

impl CelSignature {
    pub fn form(&self) -> CallForm {
        if self.receiver.is_some() {
            CallForm::Receiver
        } else {
            CallForm::Global
        }
    }
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// The name, the parameter text and the return text of a signature whose name starts at
/// `from`, when the rest of the pattern matches there.
fn match_from(text: &str, from: usize) -> Option<(&str, &str, &str)> {
    let rest = &text[from..];
    let first = rest.bytes().next()?;
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return None;
    }
    let name_end = rest.bytes().position(|byte| !(byte.is_ascii_alphanumeric() || byte == b'_')).unwrap_or(rest.len());
    let after_name = &rest[name_end..];
    let parameters_and_more = after_name.strip_prefix('(')?;
    let close = parameters_and_more.find(')')?;
    let parameters = &parameters_and_more[..close];
    let after_close = parameters_and_more[close + 1..].trim_start_matches(is_es_whitespace);
    let returns = after_close.strip_prefix(':')?.trim_start_matches(is_es_whitespace);
    if returns.is_empty() || returns.contains(is_line_terminator) {
        return None;
    }
    Some((&rest[..name_end], parameters, returns))
}

/// The pattern's captures over `text`: the receiver, the name, the parameters and the
/// return type.
fn match_signature(text: &str) -> Option<(Option<&str>, &str, &str, &str)> {
    // `(.+)` runs to the first line terminator; backtracking tries each dot inside that
    // run, rightmost first, and the optional group is tried before it is skipped.
    let run = text.find(is_line_terminator).unwrap_or(text.len());
    for (dot, _) in text[..run].match_indices('.').collect::<Vec<_>>().into_iter().rev() {
        if dot == 0 {
            continue;
        }
        if let Some((name, parameters, returns)) = match_from(text, dot + 1) {
            return Some((Some(&text[..dot]), name, parameters, returns));
        }
    }
    match_from(text, 0).map(|(name, parameters, returns)| (None, name, parameters, returns))
}

/// The parameter list, split at its own commas — `map<K, V>` holds one of its own.
fn split_parameters(text: &str) -> Vec<&str> {
    if es_trim(text).is_empty() {
        return Vec::new();
    }
    let mut parts = Vec::new();
    let mut depth: i64 = 0;
    let mut from = 0;
    for (at, byte) in text.bytes().enumerate() {
        match byte {
            b'<' => depth += 1,
            b'>' => depth -= 1,
            b',' if depth == 0 => {
                parts.push(&text[from..at]);
                from = at + 1;
            }
            _ => {}
        }
    }
    parts.push(&text[from..]);
    parts
}

pub fn parse_signature(text: &str, resolver: Option<&NominalResolver<'_>>) -> Result<CelSignature, CelTypeTextError> {
    let Some((receiver, name, parameters, returns)) = match_signature(es_trim(text)) else {
        return Err(CelTypeExpressionError {
            message: format!(
                "{} is not a signature — write 'name(a, b): r' or 'Receiver.name(a): r'",
                json_quote(text)
            ),
        }
        .into());
    };
    let parameters = split_parameters(parameters)
        .into_iter()
        .map(|part| parse_type_expression(part, resolver))
        .collect::<Result<Vec<_>, _>>()?;
    let receiver = receiver.map(|receiver| parse_type_expression(receiver, resolver)).transpose()?;
    Ok(CelSignature { name: name.into(), receiver, parameters, returns: parse_type_expression(returns, resolver)? })
}

pub fn format_signature(signature: &CelSignature) -> String {
    format!("{}: {}", signature_key(signature), format_type(&signature.returns, false))
}

/// What two registrations of the same call share: the name, the form and the parameters.
pub fn signature_key(signature: &CelSignature) -> String {
    let on = signature.receiver.as_ref().map(|receiver| format!("{}.", format_type(receiver, false))).unwrap_or_default();
    let parameters: Vec<String> = signature.parameters.iter().map(|ty| format_type(ty, false)).collect();
    format!("{on}{}({})", signature.name, parameters.join(", "))
}

/// A guard over the arguments a call wrote as literals: each argument's value where it
/// was written as a literal — the receiver first, for a call written on a value — and
/// nothing where it was not, which a guard skips. It answers the refusal, or nothing.
pub type LiteralArgumentCheck = Arc<dyn Fn(&[Option<CelValue>]) -> Option<String> + Send + Sync>;

/// What a host declares about a function beyond its types. Written with
/// `..FunctionMetadata::default()`.
#[derive(Clone)]
pub struct FunctionMetadata {
    /// A guard over the arguments written as literals, asked where a call resolves.
    pub check_arguments: Option<LiteralArgumentCheck>,
    /// Whether two calls with the same arguments answer the same thing.
    pub deterministic: bool,
    /// Whether the implementation is supplied by the host rather than the engine.
    pub host_backed: bool,
    /// The error codes a call may fail with; an empty list is not an absent one.
    pub throws: Option<Vec<String>>,
    pub description: Option<String>,
    /// Where the registration came from, for a listing a human reads.
    pub origin: Option<String>,
}

impl Default for FunctionMetadata {
    fn default() -> Self {
        Self {
            check_arguments: None,
            deterministic: true,
            host_backed: false,
            throws: None,
            description: None,
            origin: None,
        }
    }
}

impl fmt::Debug for FunctionMetadata {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FunctionMetadata")
            .field("check_arguments", &self.check_arguments.as_ref().map(|_| "guard"))
            .field("deterministic", &self.deterministic)
            .field("host_backed", &self.host_backed)
            .field("throws", &self.throws)
            .field("description", &self.description)
            .field("origin", &self.origin)
            .finish()
    }
}

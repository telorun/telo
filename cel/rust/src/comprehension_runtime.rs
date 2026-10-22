//! What a comprehension macro **does**, as a function of its range and its body —
//! `comprehension-runtime.ts`.
//!
//! There is no comprehension node in the tree: the evaluator lowers a macro to a loop,
//! and what each element contributes is decided here, once, as a fold the loop drives
//! one answer at a time ([`ComprehensionFold`]). The public functions taking a closure as
//! the body — [`cel_all`] … [`cel_map_comprehension`] — are built on the same fold, so
//! the two cannot answer differently.
//!
//! **An error does not win over a decided answer**: `all` is `false` as soon as one
//! element is false even if another errors, and `exists` is `true` as soon as one is
//! true — the rule `&&` and `||` follow. `exists_one`, `filter` and `map` answer the first
//! error, since no count or collection can be trusted past one.
//!
//! A test that answers no bool is `no_matching_overload`, `a comprehension's test must
//! answer a bool, and it answered <the value in CEL's terms>` — an interim wording, where
//! Node names JavaScript's `typeof` of the value.
//!
//! Node items with no twin in this file: the thenable refusal at each element — no Rust
//! value can be awaited.

use telorun_cel_value::{cel_error, CelError, CelEvaluationCode, CelValue, SourceRange};

use crate::member_read::cel_terms;

/// The body of a comprehension: the value its expression answers for one element.
pub type ComprehensionBody<'a> = dyn FnMut(&CelValue) -> CelValue + 'a;

/// Which macro a comprehension is.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ComprehensionMacro {
    All,
    Exists,
    ExistsOne,
    Filter,
    /// `map`, with or without its filter.
    Map,
}

fn not_bool(value: &CelValue, range: Option<SourceRange>) -> CelValue {
    cel_error(
        CelEvaluationCode::NoMatchingOverload,
        format!("a comprehension's test must answer a bool, and it answered {}", cel_terms(value)),
        range,
    )
    .into()
}

/// A predicate's answer for one element: the bool, or the error it is.
fn tested(answered: CelValue, range: Option<SourceRange>) -> Result<bool, CelValue> {
    match answered {
        CelValue::Bool(held) => Ok(held),
        CelValue::Error(_) => Err(answered),
        other => Err(not_bool(&other, range)),
    }
}

/// What a filter decides for one element of a `map` written with one: keep it, skip it,
/// or the error that ends the comprehension.
pub(crate) fn filter_verdict(answered: CelValue, range: Option<SourceRange>) -> Result<bool, CelValue> {
    tested(answered, range)
}

/// One comprehension's state between elements.
pub(crate) enum ComprehensionFold {
    All { failure: Option<CelError> },
    Exists { failure: Option<CelError> },
    ExistsOne { found: usize },
    Filter { kept: Vec<CelValue> },
    Map { out: Vec<CelValue> },
}

impl ComprehensionFold {
    pub(crate) fn new(comprehension: ComprehensionMacro) -> Self {
        match comprehension {
            ComprehensionMacro::All => Self::All { failure: None },
            ComprehensionMacro::Exists => Self::Exists { failure: None },
            ComprehensionMacro::ExistsOne => Self::ExistsOne { found: 0 },
            ComprehensionMacro::Filter => Self::Filter { kept: Vec::new() },
            ComprehensionMacro::Map => Self::Map { out: Vec::new() },
        }
    }

    /// A predicate's answer for `element`: the comprehension's answer where this element
    /// decides it, or nothing to go on to the next.
    pub(crate) fn test(&mut self, answered: CelValue, element: &CelValue, range: Option<SourceRange>) -> Option<CelValue> {
        let answered = tested(answered, range);
        match self {
            Self::All { failure } => match answered {
                Ok(false) => Some(CelValue::Bool(false)),
                Ok(true) => None,
                Err(error) => {
                    remember(failure, error);
                    None
                }
            },
            Self::Exists { failure } => match answered {
                Ok(true) => Some(CelValue::Bool(true)),
                Ok(false) => None,
                Err(error) => {
                    remember(failure, error);
                    None
                }
            },
            Self::ExistsOne { found } => match answered {
                Ok(held) => {
                    *found += usize::from(held);
                    None
                }
                Err(error) => Some(error),
            },
            Self::Filter { kept } => match answered {
                Ok(held) => {
                    if held {
                        kept.push(element.clone());
                    }
                    None
                }
                Err(error) => Some(error),
            },
            Self::Map { .. } => unreachable!("a map's elements are transformed, not tested"),
        }
    }

    /// A `map`'s transform of one element: the error that ends it, or nothing.
    pub(crate) fn transform(&mut self, value: CelValue) -> Option<CelValue> {
        let Self::Map { out } = self else { unreachable!("only a map transforms its elements") };
        if let CelValue::Error(_) = value {
            return Some(value);
        }
        out.push(value);
        None
    }

    /// The answer once every element has been read and none decided it.
    pub(crate) fn finish(self) -> CelValue {
        match self {
            Self::All { failure } => failure.map_or(CelValue::Bool(true), CelValue::Error),
            Self::Exists { failure } => failure.map_or(CelValue::Bool(false), CelValue::Error),
            Self::ExistsOne { found } => CelValue::Bool(found == 1),
            Self::Filter { kept } => CelValue::List(kept.into()),
            Self::Map { out } => CelValue::List(out.into()),
        }
    }
}

/// The first error is the one remembered.
fn remember(failure: &mut Option<CelError>, error: CelValue) {
    if failure.is_none() {
        let CelValue::Error(error) = error else { unreachable!("a failed test is an error value") };
        *failure = Some(error);
    }
}

fn predicate(
    comprehension: ComprehensionMacro,
    elements: &[CelValue],
    body: &mut ComprehensionBody<'_>,
    range: Option<SourceRange>,
) -> CelValue {
    let mut fold = ComprehensionFold::new(comprehension);
    for element in elements {
        if let Some(decided) = fold.test(body(element), element, range) {
            return decided;
        }
    }
    fold.finish()
}

/// `all`: `false` at the first element that is, else the first error, else `true`.
pub fn cel_all(elements: &[CelValue], body: &mut ComprehensionBody<'_>, range: Option<SourceRange>) -> CelValue {
    predicate(ComprehensionMacro::All, elements, body, range)
}

/// `exists`: `true` at the first element that is, else the first error, else `false`.
pub fn cel_exists(elements: &[CelValue], body: &mut ComprehensionBody<'_>, range: Option<SourceRange>) -> CelValue {
    predicate(ComprehensionMacro::Exists, elements, body, range)
}

/// `exists_one`: exactly one element satisfies the test. An error anywhere leaves no
/// count to trust, so the first one is the answer.
pub fn cel_exists_one(elements: &[CelValue], body: &mut ComprehensionBody<'_>, range: Option<SourceRange>) -> CelValue {
    predicate(ComprehensionMacro::ExistsOne, elements, body, range)
}

/// `filter`: the elements the test keeps, or the first error.
pub fn cel_filter(elements: &[CelValue], body: &mut ComprehensionBody<'_>, range: Option<SourceRange>) -> CelValue {
    predicate(ComprehensionMacro::Filter, elements, body, range)
}

/// `map` in both arities: with a filter, an element the filter drops is not transformed.
pub fn cel_map_comprehension(
    elements: &[CelValue],
    transform: &mut ComprehensionBody<'_>,
    mut filter: Option<&mut ComprehensionBody<'_>>,
    range: Option<SourceRange>,
) -> CelValue {
    let mut fold = ComprehensionFold::new(ComprehensionMacro::Map);
    for element in elements {
        if let Some(filter) = filter.as_mut() {
            match filter_verdict(filter(element), range) {
                Ok(true) => {}
                Ok(false) => continue,
                Err(error) => return error,
            }
        }
        if let Some(error) = fold.transform(transform(element)) {
            return error;
        }
    }
    fold.finish()
}

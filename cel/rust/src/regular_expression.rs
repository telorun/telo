//! `matches` — and it is RE2, not the host's regular expressions — `regular-expression.ts`.
//!
//! CEL's pattern language is RE2: linear-time matching with no backreferences and no
//! lookaround. A pattern RE2 cannot parse is `invalid_regular_expression`, never a silent
//! `false`. Node compiles with re2js 2.8.3; here the language, its program and its machine
//! are the engine's own twins of re2js's (`re2_syntax.rs`, `re2_program.rs`,
//! `re2_machine.rs`), so a pattern is accepted, refused and matched as Node does it.
//!
//! Compilation is memoized, bounded, process-wide: one compile and one cache serve every
//! caller, refusals included, and the cache's lock is never held while a pattern compiles
//! or a text is searched.
//!
//! Node items with no twin: `RE2Compiled` — the answer is a `Result`. Node's refusal
//! without a kind — re2js throwing anything but its syntax exception, which Node folds into
//! a refusal — has no counterpart: every refusal here has a kind, and a parser invariant
//! that fails is an engine defect and panics.

use std::fmt;
use std::num::NonZeroUsize;
use std::borrow::Borrow;
use std::hash::{Hash, Hasher};
use std::ops::BitOr;
use std::sync::{Arc, Mutex, OnceLock};

use telorun_cel_value::json_quote;

use crate::bounded_cache::BoundedCache;
use crate::cel_value::{cel_error, CelEvaluationCode, CelValue};
use crate::re2_program::{compile_pattern, Re2Program};
use crate::syntax_tree::SourceRange;

/// How many compiled patterns one process keeps.
pub const PATTERN_CACHE_CAPACITY: usize = 128;

/// re2js's public compile flags, which a caller maps flag letters onto.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Default)]
pub struct Re2Flags(u32);

impl Re2Flags {
    pub const NONE: Re2Flags = Re2Flags(0);
    pub const CASE_INSENSITIVE: Re2Flags = Re2Flags(1);
    pub const DOTALL: Re2Flags = Re2Flags(2);
    pub const MULTILINE: Re2Flags = Re2Flags(4);

    /// The flags as re2js numbers them.
    pub fn bits(self) -> u32 {
        self.0
    }

    pub fn contains(self, other: Re2Flags) -> bool {
        self.0 & other.0 == other.0
    }
}

impl BitOr for Re2Flags {
    type Output = Re2Flags;

    fn bitor(self, other: Re2Flags) -> Re2Flags {
        Re2Flags(self.0 | other.0)
    }
}

/// The flag letters a caller may map onto RE2's own flags.
pub const RE2_FLAG_LETTERS: [(char, Re2Flags); 3] =
    [('i', Re2Flags::CASE_INSENSITIVE), ('m', Re2Flags::MULTILINE), ('s', Re2Flags::DOTALL)];

/// RE2's parse-error kinds, in RE2's own words and Node's order — the closed vocabulary an
/// invalid-pattern refusal ends with. The last two are RE2's parser limits: a nesting
/// height above 1000, and a parsed size above 3,355,443 or more than 33,554,432 class
/// bounds.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Re2PatternErrorKind {
    MissingClosingParen,
    MissingClosingBracket,
    UnexpectedParen,
    TrailingBackslash,
    InvalidEscapeSequence,
    InvalidCharacterClassRange,
    InvalidNamedCapture,
    DuplicateCaptureGroupName,
    InvalidOrUnsupportedPerlSyntax,
    MissingArgumentToRepetitionOperator,
    InvalidNestedRepetitionOperator,
    InvalidRepeatCount,
    ExpressionNestsTooDeeply,
    ExpressionTooLarge,
}

/// Every kind, in Node's order.
pub const RE2_PATTERN_ERROR_KINDS: [Re2PatternErrorKind; 14] = [
    Re2PatternErrorKind::MissingClosingParen,
    Re2PatternErrorKind::MissingClosingBracket,
    Re2PatternErrorKind::UnexpectedParen,
    Re2PatternErrorKind::TrailingBackslash,
    Re2PatternErrorKind::InvalidEscapeSequence,
    Re2PatternErrorKind::InvalidCharacterClassRange,
    Re2PatternErrorKind::InvalidNamedCapture,
    Re2PatternErrorKind::DuplicateCaptureGroupName,
    Re2PatternErrorKind::InvalidOrUnsupportedPerlSyntax,
    Re2PatternErrorKind::MissingArgumentToRepetitionOperator,
    Re2PatternErrorKind::InvalidNestedRepetitionOperator,
    Re2PatternErrorKind::InvalidRepeatCount,
    Re2PatternErrorKind::ExpressionNestsTooDeeply,
    Re2PatternErrorKind::ExpressionTooLarge,
];

impl Re2PatternErrorKind {
    /// The kind as RE2 words it.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::MissingClosingParen => "missing closing )",
            Self::MissingClosingBracket => "missing closing ]",
            Self::UnexpectedParen => "unexpected )",
            Self::TrailingBackslash => "trailing backslash at end of expression",
            Self::InvalidEscapeSequence => "invalid escape sequence",
            Self::InvalidCharacterClassRange => "invalid character class range",
            Self::InvalidNamedCapture => "invalid named capture",
            Self::DuplicateCaptureGroupName => "duplicate capture group name",
            Self::InvalidOrUnsupportedPerlSyntax => "invalid or unsupported Perl syntax",
            Self::MissingArgumentToRepetitionOperator => "missing argument to repetition operator",
            Self::InvalidNestedRepetitionOperator => "invalid nested repetition operator",
            Self::InvalidRepeatCount => "invalid repeat count",
            Self::ExpressionNestsTooDeeply => "expression nests too deeply",
            Self::ExpressionTooLarge => "expression too large",
        }
    }
}

impl fmt::Display for Re2PatternErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Why RE2 refused a pattern: its parse-error kind, and its whole message —
/// `error parsing regexp: <kind>`, then `: `<the text it quotes>`` where it quotes one.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Re2PatternRefusal {
    pub kind: Re2PatternErrorKind,
    pub message: String,
}

impl fmt::Display for Re2PatternRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Re2PatternRefusal {}

type Compiled = Result<Arc<Re2Program>, Re2PatternRefusal>;

/// A cache key readable without being built: a lookup borrows the pattern as a view, so a
/// hit allocates nothing, and the pattern text is held once.
#[derive(Clone)]
struct PatternKey {
    flags: u32,
    pattern: Arc<str>,
}

trait PatternKeyView {
    fn flags(&self) -> u32;
    fn pattern(&self) -> &str;
}

impl PatternKeyView for PatternKey {
    fn flags(&self) -> u32 {
        self.flags
    }
    fn pattern(&self) -> &str {
        &self.pattern
    }
}

struct PatternKeyRef<'a> {
    flags: u32,
    pattern: &'a str,
}

impl PatternKeyView for PatternKeyRef<'_> {
    fn flags(&self) -> u32 {
        self.flags
    }
    fn pattern(&self) -> &str {
        self.pattern
    }
}

impl<'a> Borrow<dyn PatternKeyView + 'a> for PatternKey {
    fn borrow(&self) -> &(dyn PatternKeyView + 'a) {
        self
    }
}

impl PartialEq for dyn PatternKeyView + '_ {
    fn eq(&self, other: &Self) -> bool {
        self.flags() == other.flags() && self.pattern() == other.pattern()
    }
}

impl Eq for dyn PatternKeyView + '_ {}

impl Hash for dyn PatternKeyView + '_ {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.flags().hash(state);
        self.pattern().hash(state);
    }
}

impl PartialEq for PatternKey {
    fn eq(&self, other: &Self) -> bool {
        <dyn PatternKeyView as PartialEq>::eq(self, other)
    }
}

impl Eq for PatternKey {}

impl Hash for PatternKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        <dyn PatternKeyView as Hash>::hash(self, state)
    }
}

fn pattern_cache() -> &'static Mutex<BoundedCache<PatternKey, Compiled>> {
    static CACHE: OnceLock<Mutex<BoundedCache<PatternKey, Compiled>>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let capacity = NonZeroUsize::new(PATTERN_CACHE_CAPACITY).expect("the pattern cache holds at least one entry");
        Mutex::new(BoundedCache::new(capacity))
    })
}

const CACHE_LOCK: &str = "the pattern cache's lock is held only to read or write an entry";

/// A compiled pattern, or why RE2 refused it. One compile and one cache for every caller.
///
/// The flags are applied as re2js applies them, as inline flags written before the
/// pattern — `(?m)(?s)(?i)` — so a refusal quoting the whole pattern quotes them too.
pub fn re2_pattern(pattern: &str, flags: Re2Flags) -> Result<Arc<Re2Program>, Re2PatternRefusal> {
    let lookup = PatternKeyRef { flags: flags.bits(), pattern };
    if let Some(held) = pattern_cache().lock().expect(CACHE_LOCK).get(&lookup as &dyn PatternKeyView) {
        return held.clone();
    }
    let key = PatternKey { flags: flags.bits(), pattern: Arc::from(pattern) };
    let mut written = pattern.to_owned();
    if flags.contains(Re2Flags::CASE_INSENSITIVE) {
        written = format!("(?i){written}");
    }
    if flags.contains(Re2Flags::DOTALL) {
        written = format!("(?s){written}");
    }
    if flags.contains(Re2Flags::MULTILINE) {
        written = format!("(?m){written}");
    }
    let compiled: Compiled = compile_pattern(&written).map(Arc::new).map_err(|refused| {
        let mut message = format!("error parsing regexp: {}", refused.kind);
        if let Some(input) = refused.input {
            message.push_str(&format!(": `{input}`"));
        }
        Re2PatternRefusal { kind: refused.kind, message }
    });
    pattern_cache().lock().expect(CACHE_LOCK).set(key, compiled.clone());
    compiled
}

/// Whether the pattern matches anywhere in the text, or why the pattern is not one:
/// `invalid_regular_expression`, `<the pattern, JSON-quoted> is not an RE2 pattern:
/// <RE2's message>`, about `range`.
pub fn cel_matches(text: &str, pattern: &str, range: Option<SourceRange>) -> CelValue {
    match re2_pattern(pattern, Re2Flags::NONE) {
        Ok(program) => CelValue::Bool(program.is_match(text)),
        Err(refused) => CelValue::Error(cel_error(
            CelEvaluationCode::InvalidRegularExpression,
            format!("{} is not an RE2 pattern: {}", json_quote(pattern), refused.message),
            range,
        )),
    }
}

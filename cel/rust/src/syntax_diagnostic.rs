//! What the front end says when it cannot read the source — `syntax-diagnostic.ts`.
//!
//! A syntax diagnostic is data, never a panic and never a sentence a consumer
//! re-derives: a code from the closed set below, the range of the offending text and a
//! message for a reader. Reading reports at most one — the first thing it could not
//! read, in source order. Every range lies within the source and splits no character.
//!
//! Private, as on Node's entry: the first-diagnostic holder and the rule that decides
//! between the lexer's and the parser's.

use std::fmt;

use telorun_cel_value::SourceRange;

/// Every syntax refusal the front end names. A code is never derived from a message.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum CelSyntaxCode {
    /// A character that begins no CEL token.
    UnexpectedCharacter,
    /// A token that cannot stand where it does.
    UnexpectedToken,
    /// The source ended with an expression unfinished.
    UnexpectedEnd,
    /// A string or bytes literal that no quote closes.
    UnterminatedString,
    /// A reserved word written where an identifier must be.
    ReservedIdentifier,
    /// A number literal that is not spelled as one.
    InvalidNumber,
    /// An integer literal outside the int64 range.
    InvalidInteger,
    /// An unsigned integer literal outside the uint64 range.
    InvalidUnsignedInteger,
    /// An escape sequence no string or bytes literal admits.
    InvalidEscapeSequence,
    /// A `\u`/`\U` escape naming no Unicode code point.
    InvalidUnicodeEscape,
    /// A `\u` escape naming a surrogate not paired with its partner.
    InvalidUnicodeSurrogate,
    /// A `\x`/`\X` escape with fewer than two hexadecimal digits.
    InvalidHexEscape,
    /// A `\nnn` escape with fewer than three octal digits.
    InvalidOctalEscape,
    /// A `\nnn` escape naming a value above 255.
    OctalEscapeOutOfRange,
    /// A `\u`/`\U` escape inside a bytes literal, which holds bytes and not text.
    BytesUnicodeEscape,
    /// An input limit was reached.
    LimitExceeded,
}

impl CelSyntaxCode {
    /// The code as every engine writes it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnexpectedCharacter => "unexpected_character",
            Self::UnexpectedToken => "unexpected_token",
            Self::UnexpectedEnd => "unexpected_end",
            Self::UnterminatedString => "unterminated_string",
            Self::ReservedIdentifier => "reserved_identifier",
            Self::InvalidNumber => "invalid_number",
            Self::InvalidInteger => "invalid_integer",
            Self::InvalidUnsignedInteger => "invalid_unsigned_integer",
            Self::InvalidEscapeSequence => "invalid_escape_sequence",
            Self::InvalidUnicodeEscape => "invalid_unicode_escape",
            Self::InvalidUnicodeSurrogate => "invalid_unicode_surrogate",
            Self::InvalidHexEscape => "invalid_hex_escape",
            Self::InvalidOctalEscape => "invalid_octal_escape",
            Self::OctalEscapeOutOfRange => "octal_escape_out_of_range",
            Self::BytesUnicodeEscape => "bytes_unicode_escape",
            Self::LimitExceeded => "limit_exceeded",
        }
    }
}

impl fmt::Display for CelSyntaxCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CelSyntaxDiagnostic {
    pub code: CelSyntaxCode,
    pub message: String,
    pub range: SourceRange,
}

/// Holds the first diagnostic reported to it and ignores every later one. The lexer and
/// the parser each hold one, and `first_in_source_order` decides between the two.
#[derive(Default)]
pub(crate) struct FirstSyntaxDiagnostic {
    held: Option<CelSyntaxDiagnostic>,
}

impl FirstSyntaxDiagnostic {
    pub(crate) fn report(&mut self, code: CelSyntaxCode, message: impl Into<String>, start: u32, end: u32) {
        if self.held.is_none() {
            self.held = Some(CelSyntaxDiagnostic { code, message: message.into(), range: SourceRange { start, end } });
        }
    }

    /// The diagnostic held, where Node answers a list of at most one.
    pub(crate) fn first(self) -> Option<CelSyntaxDiagnostic> {
        self.held
    }
}

/// The one diagnostic of a read whose lexer stopped at `cut`, the offset where the text
/// it could not read begins. The parser read the source cut there, so what it reports
/// before the cut came first; from the cut on, the unreadable text is the cause.
pub(crate) fn first_in_source_order(
    lexed: Option<CelSyntaxDiagnostic>,
    parsed: Option<CelSyntaxDiagnostic>,
    cut: u32,
) -> Option<CelSyntaxDiagnostic> {
    match (lexed, parsed) {
        (Some(lexed), Some(parsed)) => Some(if parsed.range.start < cut { parsed } else { lexed }),
        (lexed, parsed) => lexed.or(parsed),
    }
}

//! What the core refuses, and how it says so — worded as the Node core words it.
//! Reading and checking answer problems at a path, with a UTF-16 range inside a
//! pattern's text; formatting answers one `MessageFormatError`.

use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MessageCode {
    SyntaxInvalid,
    PluralCategoryInvalid,
    PlaceholderUnknown,
    PlaceholderUnbound,
    PlaceholderValueUnsupported,
}

impl MessageCode {
    pub fn as_str(self) -> &'static str {
        match self {
            MessageCode::SyntaxInvalid => "MESSAGE_SYNTAX_INVALID",
            MessageCode::PluralCategoryInvalid => "MESSAGE_PLURAL_CATEGORY_INVALID",
            MessageCode::PlaceholderUnknown => "MESSAGE_PLACEHOLDER_UNKNOWN",
            MessageCode::PlaceholderUnbound => "MESSAGE_PLACEHOLDER_UNBOUND",
            MessageCode::PlaceholderValueUnsupported => "MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED",
        }
    }
}

/// A half-open `[start, end)` span of UTF-16 code units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageProblem {
    pub code: MessageCode,
    pub message: String,
    /// Keys from the value that was read down to the node at fault.
    pub path: Vec<String>,
    /// Where inside a pattern's text; `None` when the node as a whole is at fault.
    pub range: Option<SourceRange>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageFormatError {
    pub code: MessageCode,
    pub message: String,
}

impl fmt::Display for MessageFormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for MessageFormatError {}

pub(crate) fn syntax_problem(message: String, path: Vec<String>, range: Option<SourceRange>) -> MessageProblem {
    MessageProblem { code: MessageCode::SyntaxInvalid, message, path, range }
}

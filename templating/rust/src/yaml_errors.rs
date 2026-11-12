//! The YAML errors the parser and composer raise — a twin of `yaml@2.8.3`'s `dist/errors.js`
//! (the error shape, and `prettifyError`'s `linePos`), of `LineCounter.linePos`
//! (`dist/parse/line-counter.js`) and of the composer's `getErrorPos`.
//!
//! No Telo twin (see `yaml_cst.rs`). An error is `yaml`'s own: its code, its message as
//! `yaml` words it before `prettifyError` appends the position, and its position. Telo's
//! loaders word it in their own sentences from the code and the message.

/// Where an error is, as `getErrorPos` reads what `onError` is handed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorAt {
    /// An offset: `[n, n + 1]`.
    Offset(usize),
    /// A range.
    Range(usize, usize),
    /// A token: from its offset, as long as its source (one unit when it has none).
    Token { offset: usize, len: Option<usize> },
}

impl ErrorAt {
    pub fn pos(self) -> [usize; 2] {
        match self {
            ErrorAt::Offset(n) => [n, n + 1],
            ErrorAt::Range(a, b) => [a, b],
            ErrorAt::Token { offset, len } => [offset, offset + len.unwrap_or(1)],
        }
    }
}

/// A 1-based line and column, as `LineCounter.linePos` gives it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinePos {
    pub line: usize,
    pub col: usize,
}

/// One of `yaml`'s errors (`YAMLParseError`).
#[derive(Debug, Clone, PartialEq)]
pub struct YamlError {
    /// The document it belongs to, in the stream `yaml` reads (every document it yields).
    pub document_index: usize,
    /// `yaml`'s code (`MISSING_CHAR`, `BAD_INDENT`, …).
    pub code: &'static str,
    /// `yaml`'s message, without the position `prettifyError` appends.
    pub message: String,
    /// `[start, end]` in UTF-16 code units.
    pub pos: [usize; 2],
    /// `pos` as lines and columns, read off the parser's line starts.
    pub line_pos: [LinePos; 2],
}

/// `LineCounter.linePos` over the line starts the parser recorded.
pub fn line_pos(line_starts: &[usize], offset: usize) -> LinePos {
    let low = line_starts.partition_point(|start| *start < offset);
    if line_starts.get(low) == Some(&offset) {
        return LinePos { line: low + 1, col: 1 };
    }
    if low == 0 {
        return LinePos { line: 0, col: offset };
    }
    LinePos { line: low, col: offset - line_starts[low - 1] + 1 }
}

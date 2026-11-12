//! The concrete syntax tree the YAML parser builds — a twin of `yaml@2.8.3`'s
//! `dist/parse/cst.js` and of the token shapes its `cst.d.ts` declares.
//!
//! No Telo twin: the Node loaders read YAML through the `yaml` package, and this family
//! (`yaml_cst.rs`, `yaml_lexer.rs`, `yaml_cst_parser.rs`, `yaml_errors.rs`,
//! `yaml_resolve.rs`, `yaml_composer.rs`) is its Rust twin, pinned to the exact version the
//! Node packages depend on.
//!
//! Text is held as UTF-16 code units, the unit `yaml` counts every offset in, so an offset
//! here is one the Node loader reports. A composite token lives in an arena and names its
//! children by index, so nothing building or dropping a tree recurses on its depth.

/// One unit of `\x02`: a document starts with the next token.
pub const DOCUMENT: u16 = 0x02;
/// One unit of `\x18`: an unexpected end of flow mode.
pub const FLOW_END: u16 = 0x18;
/// One unit of `\x1f`: the next token is a scalar value.
pub const SCALAR: u16 = 0x1f;
/// The byte order mark.
pub const BOM: u16 = 0xfeff;

/// `cst.tokenType`'s answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenType {
    ByteOrderMark,
    DocMode,
    FlowErrorEnd,
    Scalar,
    DocStart,
    DocEnd,
    Newline,
    SeqItemInd,
    ExplicitKeyInd,
    MapValueInd,
    FlowMapStart,
    FlowMapEnd,
    FlowSeqStart,
    FlowSeqEnd,
    Comma,
    Space,
    Comment,
    DirectiveLine,
    Alias,
    Anchor,
    Tag,
    SingleQuotedScalar,
    DoubleQuotedScalar,
    BlockScalarHeader,
}

impl TokenType {
    /// The name `yaml` gives the type, as its messages print it.
    pub fn name(self) -> &'static str {
        match self {
            TokenType::ByteOrderMark => "byte-order-mark",
            TokenType::DocMode => "doc-mode",
            TokenType::FlowErrorEnd => "flow-error-end",
            TokenType::Scalar => "scalar",
            TokenType::DocStart => "doc-start",
            TokenType::DocEnd => "doc-end",
            TokenType::Newline => "newline",
            TokenType::SeqItemInd => "seq-item-ind",
            TokenType::ExplicitKeyInd => "explicit-key-ind",
            TokenType::MapValueInd => "map-value-ind",
            TokenType::FlowMapStart => "flow-map-start",
            TokenType::FlowMapEnd => "flow-map-end",
            TokenType::FlowSeqStart => "flow-seq-start",
            TokenType::FlowSeqEnd => "flow-seq-end",
            TokenType::Comma => "comma",
            TokenType::Space => "space",
            TokenType::Comment => "comment",
            TokenType::DirectiveLine => "directive-line",
            TokenType::Alias => "alias",
            TokenType::Anchor => "anchor",
            TokenType::Tag => "tag",
            TokenType::SingleQuotedScalar => "single-quoted-scalar",
            TokenType::DoubleQuotedScalar => "double-quoted-scalar",
            TokenType::BlockScalarHeader => "block-scalar-header",
        }
    }
}

/// `cst.tokenType`: the type of a lexer token, or `None` for one that is no YAML token.
pub fn token_type(source: &[u16]) -> Option<TokenType> {
    const fn c(ch: char) -> u16 {
        ch as u16
    }
    match source {
        [BOM] => return Some(TokenType::ByteOrderMark),
        [DOCUMENT] => return Some(TokenType::DocMode),
        [FLOW_END] => return Some(TokenType::FlowErrorEnd),
        [SCALAR] => return Some(TokenType::Scalar),
        [a, b, d] if *a == c('-') && *b == c('-') && *d == c('-') => return Some(TokenType::DocStart),
        [a, b, d] if *a == c('.') && *b == c('.') && *d == c('.') => return Some(TokenType::DocEnd),
        [] => return Some(TokenType::Newline),
        [a] if *a == c('\n') => return Some(TokenType::Newline),
        [a, b] if *a == c('\r') && *b == c('\n') => return Some(TokenType::Newline),
        [a] if *a == c('-') => return Some(TokenType::SeqItemInd),
        [a] if *a == c('?') => return Some(TokenType::ExplicitKeyInd),
        [a] if *a == c(':') => return Some(TokenType::MapValueInd),
        [a] if *a == c('{') => return Some(TokenType::FlowMapStart),
        [a] if *a == c('}') => return Some(TokenType::FlowMapEnd),
        [a] if *a == c('[') => return Some(TokenType::FlowSeqStart),
        [a] if *a == c(']') => return Some(TokenType::FlowSeqEnd),
        [a] if *a == c(',') => return Some(TokenType::Comma),
        _ => {}
    }
    match char::from_u32(u32::from(source[0])) {
        Some(' ' | '\t') => Some(TokenType::Space),
        Some('#') => Some(TokenType::Comment),
        Some('%') => Some(TokenType::DirectiveLine),
        Some('*') => Some(TokenType::Alias),
        Some('&') => Some(TokenType::Anchor),
        Some('!') => Some(TokenType::Tag),
        Some('\'') => Some(TokenType::SingleQuotedScalar),
        Some('"') => Some(TokenType::DoubleQuotedScalar),
        Some('|' | '>') => Some(TokenType::BlockScalarHeader),
        _ => None,
    }
}

/// A token's source: a slice of the text, or one of the lexer's control units.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Src {
    Text { start: usize, end: usize },
    Control(u16),
}

impl Src {
    pub const EMPTY: Src = Src::Text { start: 0, end: 0 };

    /// `source.length`.
    pub fn len(self) -> usize {
        match self {
            Src::Text { start, end } => end - start,
            Src::Control(_) => 1,
        }
    }

    pub fn is_empty(self) -> bool {
        self.len() == 0
    }
}

/// Reads a [`Src`] against the text it was cut from.
#[derive(Clone, Copy)]
pub struct Units<'s> {
    pub text: &'s [u16],
}

impl<'s> Units<'s> {
    pub fn of(&self, src: Src) -> &'s [u16] {
        match src {
            Src::Text { start, end } => &self.text[start.min(self.text.len())..end.min(self.text.len())],
            Src::Control(unit) => match unit {
                DOCUMENT => &[DOCUMENT],
                FLOW_END => &[FLOW_END],
                SCALAR => &[SCALAR],
                _ => &[BOM],
            },
        }
    }

    pub fn string(&self, src: Src) -> String {
        String::from_utf16_lossy(self.of(src))
    }
}

/// A lexical token that the parser keeps as it was: `{ type, offset, indent, source }`.
#[derive(Debug, Clone, Copy)]
pub struct SourceToken {
    pub ty: TokenType,
    pub offset: usize,
    pub indent: usize,
    pub source: Src,
}

/// Index of a composite token in the parser's arena.
pub type TokenId = usize;

/// The four flow scalar token types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowScalarType {
    Alias,
    Scalar,
    SingleQuoted,
    DoubleQuoted,
}

impl FlowScalarType {
    pub fn from_type(ty: TokenType) -> Option<Self> {
        match ty {
            TokenType::Alias => Some(FlowScalarType::Alias),
            TokenType::Scalar => Some(FlowScalarType::Scalar),
            TokenType::SingleQuotedScalar => Some(FlowScalarType::SingleQuoted),
            TokenType::DoubleQuotedScalar => Some(FlowScalarType::DoubleQuoted),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            FlowScalarType::Alias => "alias",
            FlowScalarType::Scalar => "scalar",
            FlowScalarType::SingleQuoted => "single-quoted-scalar",
            FlowScalarType::DoubleQuoted => "double-quoted-scalar",
        }
    }
}

/// One entry of a collection token: `{ start, explicitKey?, key?, sep?, value? }`.
#[derive(Debug, Clone, Default)]
pub struct CollectionItem {
    pub start: Vec<SourceToken>,
    pub explicit_key: bool,
    /// `undefined` and `null` both read as no key wherever `yaml` reads one.
    pub key: Option<TokenId>,
    pub sep: Option<Vec<SourceToken>>,
    pub value: Option<TokenId>,
}

/// A block scalar's props: source tokens, or (in error) a whole token the parser popped
/// into it.
#[derive(Debug, Clone)]
pub enum BlockScalarProp {
    Source(SourceToken),
    Token(TokenId),
}

/// A composite token.
#[derive(Debug, Clone)]
pub enum Token {
    /// A token yielded as it was at the stream level.
    Source(SourceToken),
    Directive { offset: usize, source: Src },
    Error { offset: usize, message: String, source: Src },
    Document { offset: usize, start: Vec<SourceToken>, value: Option<TokenId>, end: Option<Vec<SourceToken>> },
    DocEnd { offset: usize, source: Src, end: Option<Vec<SourceToken>> },
    FlowScalar { ty: FlowScalarType, offset: usize, indent: usize, source: Src, end: Option<Vec<SourceToken>> },
    BlockScalar { offset: usize, indent: usize, props: Vec<BlockScalarProp>, source: Src },
    BlockMap { offset: usize, indent: usize, items: Vec<CollectionItem> },
    BlockSeq { offset: usize, indent: usize, items: Vec<CollectionItem> },
    FlowCollection { offset: usize, indent: usize, start: SourceToken, items: Vec<CollectionItem>, end: Vec<SourceToken> },
}

/// The type name of a composite token, as `yaml`'s `token.type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Source(TokenType),
    Directive,
    Error,
    Document,
    DocEnd,
    FlowScalar(FlowScalarType),
    BlockScalar,
    BlockMap,
    BlockSeq,
    FlowCollection,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Source(ty) => ty.name(),
            Kind::Directive => "directive",
            Kind::Error => "error",
            Kind::Document => "document",
            Kind::DocEnd => "doc-end",
            Kind::FlowScalar(ty) => ty.name(),
            Kind::BlockScalar => "block-scalar",
            Kind::BlockMap => "block-map",
            Kind::BlockSeq => "block-seq",
            Kind::FlowCollection => "flow-collection",
        }
    }
}

impl Token {
    pub fn kind(&self) -> Kind {
        match self {
            Token::Source(token) => Kind::Source(token.ty),
            Token::Directive { .. } => Kind::Directive,
            Token::Error { .. } => Kind::Error,
            Token::Document { .. } => Kind::Document,
            Token::DocEnd { .. } => Kind::DocEnd,
            Token::FlowScalar { ty, .. } => Kind::FlowScalar(*ty),
            Token::BlockScalar { .. } => Kind::BlockScalar,
            Token::BlockMap { .. } => Kind::BlockMap,
            Token::BlockSeq { .. } => Kind::BlockSeq,
            Token::FlowCollection { .. } => Kind::FlowCollection,
        }
    }

    pub fn offset(&self) -> usize {
        match self {
            Token::Source(token) => token.offset,
            Token::Directive { offset, .. }
            | Token::Error { offset, .. }
            | Token::Document { offset, .. }
            | Token::DocEnd { offset, .. }
            | Token::FlowScalar { offset, .. }
            | Token::BlockScalar { offset, .. }
            | Token::BlockMap { offset, .. }
            | Token::BlockSeq { offset, .. }
            | Token::FlowCollection { offset, .. } => *offset,
        }
    }

    /// `token.indent`, for the tokens that carry one (`'indent' in token`).
    pub fn indent(&self) -> Option<usize> {
        match self {
            Token::Source(token) => Some(token.indent),
            Token::FlowScalar { indent, .. }
            | Token::BlockScalar { indent, .. }
            | Token::BlockMap { indent, .. }
            | Token::BlockSeq { indent, .. }
            | Token::FlowCollection { indent, .. } => Some(*indent),
            _ => None,
        }
    }

    /// `token.source`, for the tokens that carry one as a string.
    pub fn source(&self) -> Option<Src> {
        match self {
            Token::Source(token) => Some(token.source),
            Token::Directive { source, .. }
            | Token::Error { source, .. }
            | Token::DocEnd { source, .. }
            | Token::FlowScalar { source, .. }
            | Token::BlockScalar { source, .. } => Some(*source),
            _ => None,
        }
    }

    pub fn items(&self) -> Option<&Vec<CollectionItem>> {
        match self {
            Token::BlockMap { items, .. } | Token::BlockSeq { items, .. } | Token::FlowCollection { items, .. } => {
                Some(items)
            }
            _ => None,
        }
    }

    pub fn items_mut(&mut self) -> Option<&mut Vec<CollectionItem>> {
        match self {
            Token::BlockMap { items, .. } | Token::BlockSeq { items, .. } | Token::FlowCollection { items, .. } => {
                Some(items)
            }
            _ => None,
        }
    }
}

/// `isFlowToken`.
pub fn is_flow_kind(kind: Option<Kind>) -> bool {
    matches!(kind, Some(Kind::FlowScalar(_) | Kind::FlowCollection))
}

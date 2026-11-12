//! Pure: text in, structured load result out. No I/O, no caches.
//! Mirrors `../../nodejs/src/parse-loaded-file.ts`.
//!
//! Node items with no twin: `ParseOptions` (migration, fragment expansion and precompile run
//! in the Node loader only) and the parse cache's restored parse.

use telo_templating::{document_to_json, expansion_tag_misuse, JsonRefusal, LinePos, TagRefusal, YamlError};

use crate::loaded_types::{LoadedFile, ParseError, ParseErrorOrigin};
use crate::loader_expansion_refusals::loader_expansion_refusals;
use crate::position_metadata::{build_document_positions, build_line_offsets, offset_to_position};
use crate::types::{Position, Range, ResourceManifest};
use crate::yaml_ast::{document_to_ast, manifest_documents, AstDocument};

/// The closed set of YAML errors both loaders name, one sentence each (`ParseErrorKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum YamlErrorKind {
    DuplicateKey,
    UnresolvedAlias,
    AliasLimit,
    UnclosedQuote,
    UnclosedFlowCollection,
    TabIndentation,
    PlainValueColon,
    BadIndentation,
    InvalidEscape,
    ReservedCharacter,
    Unreadable,
}

/// What each YAML error says — one sentence per kind, the same words in both loaders
/// (`PARSE_ERROR_MESSAGES` in the Node twin).
pub fn parse_error_message(kind: YamlErrorKind) -> &'static str {
    match kind {
        YamlErrorKind::DuplicateKey => "This key is already written earlier in the same mapping; a mapping holds each key once, so remove or rename one of the two.",
        YamlErrorKind::UnresolvedAlias => "This alias names no anchor written before it in the document; write the anchor (`&name`) on an earlier value, or write the value out in place of the alias.",
        YamlErrorKind::AliasLimit => "The aliases in this document expand into more copies of their values than a manifest may hold; write the repeated values out, or alias them fewer times.",
        YamlErrorKind::UnclosedQuote => "A quoted value is never closed; end it with the quote character it opens with.",
        YamlErrorKind::UnclosedFlowCollection => "A bracketed list or map ('[…]' or '{…}') is not closed, or a line inside it is not indented past the key holding it; close it with the matching ']' or '}', and indent its continuation lines.",
        YamlErrorKind::TabIndentation => "A tab indents this line; YAML indents with spaces only.",
        YamlErrorKind::PlainValueColon => "A plain (unquoted) value cannot contain ': ' (a colon followed by a space), which the parser reads as a nested mapping; wrap the value in quotes, e.g. `description: \"… encoding: base64 …\"`.",
        YamlErrorKind::BadIndentation => "This line is not indented to match the entries beside it; align it with its siblings, or indent it under the key it belongs to.",
        YamlErrorKind::InvalidEscape => "A double-quoted value holds an escape sequence YAML does not define; write the backslash itself as `\\\\`, or use single quotes, inside which a backslash is literal.",
        YamlErrorKind::ReservedCharacter => "A plain value cannot start with '@' or '`', which YAML reserves; wrap the value in quotes.",
        YamlErrorKind::Unreadable => "This is not valid YAML; check the indentation, quoting and brackets at this position.",
    }
}

/// The kind of one of the `yaml` package's errors, read from its code and, where one code
/// covers several causes, its message (`parseErrorKind`).
pub fn parse_error_kind(code: &str, message: &str) -> YamlErrorKind {
    let flow_prefix = |rest: &str| ["Flow sequence", "Flow map"].iter().any(|name| message.strip_prefix(name).is_some_and(|tail| tail.starts_with(rest)));
    let items_prefix = |rest: &str| ["All mapping", "All sequence"].iter().any(|name| message.strip_prefix(name).is_some_and(|tail| tail.starts_with(rest)));
    match code {
        "DUPLICATE_KEY" => YamlErrorKind::DuplicateKey,
        "TAB_AS_INDENT" => YamlErrorKind::TabIndentation,
        "BAD_DQ_ESCAPE" => YamlErrorKind::InvalidEscape,
        "BLOCK_AS_IMPLICIT_KEY" if message.starts_with("Nested mappings are not allowed in compact mappings") => {
            YamlErrorKind::PlainValueColon
        }
        "MISSING_CHAR" if message.starts_with("Missing closing") => YamlErrorKind::UnclosedQuote,
        "MISSING_CHAR" if flow_prefix(" must end with") => YamlErrorKind::UnclosedFlowCollection,
        "BAD_INDENT" if flow_prefix(" in block collection must be sufficiently indented") => {
            YamlErrorKind::UnclosedFlowCollection
        }
        "BAD_INDENT" if items_prefix(" items must start at the same column") => YamlErrorKind::BadIndentation,
        "BAD_SCALAR_START" if message.contains("reserved character") => YamlErrorKind::ReservedCharacter,
        _ => YamlErrorKind::Unreadable,
    }
}

/// `yaml`'s 1-based `{ line, col }` pair as a 0-based `Range` (`rangeFromLinePos`).
fn range_from_line_pos(line_pos: [LinePos; 2]) -> Range {
    let at = |pos: LinePos| Position { line: pos.line.saturating_sub(1), character: pos.col.saturating_sub(1) };
    Range { start: at(line_pos[0]), end: at(line_pos[1]) }
}

/// One of `yaml`'s errors as a parse error of the loader.
pub fn yaml_parse_error(error: &YamlError) -> ParseError {
    ParseError {
        document_index: error.document_index,
        origin: ParseErrorOrigin::Yaml(parse_error_kind(error.code, &error.message)),
        range: Some(range_from_line_pos(error.line_pos)),
    }
}

pub fn parse_loaded_file(source: &str, requested_url: &str, text: &str) -> LoadedFile {
    let stream = manifest_documents(text);
    let ast_documents: Vec<AstDocument> = stream.documents.iter().map(document_to_ast).collect();
    let positions = build_document_positions(text, &ast_documents);
    let line_offsets = build_line_offsets(text);
    let range_of = |offsets: [usize; 2]| Range {
        start: offset_to_position(offsets[0], &line_offsets),
        end: offset_to_position(offsets[1], &line_offsets),
    };

    // In the Node loader's order: the parser's errors, then the documents an alias makes
    // unreadable, then every expansion tag misused, then the loader's own refusals; the
    // constructs this reader cannot hold, which are no diagnostic, last.
    let mut parse_errors: Vec<ParseError> = stream.errors.iter().map(yaml_parse_error).collect();
    let mut unsupported: Vec<ParseError> = Vec::new();
    let mut manifests: Vec<Option<ResourceManifest>> = Vec::with_capacity(stream.documents.len());
    for (document_index, document) in stream.documents.iter().enumerate() {
        match document_to_json(document) {
            Ok(manifest) => manifests.push(manifest),
            Err(JsonRefusal::AliasLimit) => {
                manifests.push(None);
                parse_errors.push(ParseError {
                    document_index,
                    origin: ParseErrorOrigin::Yaml(YamlErrorKind::AliasLimit),
                    range: None,
                });
            }
            Err(JsonRefusal::UnresolvedAlias { range }) => {
                manifests.push(None);
                parse_errors.push(ParseError {
                    document_index,
                    origin: ParseErrorOrigin::Yaml(YamlErrorKind::UnresolvedAlias),
                    range: Some(range_of(range)),
                });
            }
            Err(JsonRefusal::Tag(error)) => {
                manifests.push(None);
                let TagRefusal::Unsupported(construct) = error.refusal;
                unsupported.push(ParseError {
                    document_index,
                    origin: ParseErrorOrigin::Unsupported(construct),
                    range: error.range.map(range_of),
                });
            }
        }
    }
    for (document_index, document) in stream.documents.iter().enumerate() {
        for misuse in expansion_tag_misuse(document) {
            parse_errors.push(ParseError {
                document_index,
                origin: ParseErrorOrigin::Loader { code: misuse.code, message: misuse.message },
                range: Some(range_of(misuse.range)),
            });
        }
    }

    for (document_index, manifest) in manifests.iter().enumerate() {
        let Some(manifest) = manifest else { continue };
        for refusal in loader_expansion_refusals(manifest) {
            let range = positions
                .get(document_index)
                .and_then(|position| position.position_index.get(&refusal.path))
                .copied();
            parse_errors.push(ParseError {
                document_index,
                origin: ParseErrorOrigin::Loader { code: refusal.code, message: refusal.message },
                range,
            });
        }
    }

    parse_errors.append(&mut unsupported);

    LoadedFile {
        source: source.to_string(),
        requested_url: requested_url.to_string(),
        text: text.to_string(),
        manifests,
        ast_documents,
        positions,
        parse_errors,
    }
}

//! Pure: text in, structured load result out. No I/O, no caches.
//! Mirrors `../../nodejs/src/parse-loaded-file.ts`.
//!
//! Node items with no twin: `ParseOptions` (migration, fragment expansion and precompile run
//! in the Node loader only) and the parse cache's restored parse.

use telo_templating::{compose_yaml, document_to_json, JsonRefusal, ReadFailure, TagRefusal, YamlErrorKind};

use crate::loaded_types::{LoadedFile, ParseError, ParseErrorOrigin};
use crate::loader_expansion_refusals::loader_expansion_refusals;
use crate::position_metadata::{build_document_positions, build_line_offsets, offset_to_position};
use crate::types::{Range, ResourceManifest};
use crate::yaml_ast::{document_to_ast, AstDocument};

/// What each YAML error says — one sentence per kind, the same words in both loaders
/// (`PARSE_ERROR_MESSAGES` in the Node twin), whichever parser found it.
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

pub fn parse_loaded_file(source: &str, requested_url: &str, text: &str) -> LoadedFile {
    let stream = compose_yaml(text);
    let ast_documents: Vec<AstDocument> = stream.documents.iter().map(document_to_ast).collect();
    let positions = build_document_positions(text, &ast_documents);
    let line_offsets = build_line_offsets(text);
    let range_of = |offsets: [usize; 2]| Range {
        start: offset_to_position(offsets[0], &line_offsets),
        end: offset_to_position(offsets[1], &line_offsets),
    };

    // In the Node loader's order: the parser's errors, then the documents an alias makes
    // unreadable, then the tag layer's refusals, then the loader's own.
    let mut parse_errors: Vec<ParseError> = stream
        .errors
        .iter()
        .map(|error| ParseError {
            document_index: error.document_index,
            origin: match &error.failure {
                ReadFailure::Yaml(kind) => ParseErrorOrigin::Yaml(*kind),
                ReadFailure::Unsupported(construct) => ParseErrorOrigin::Unsupported(construct.clone()),
            },
            range: error.range.map(range_of),
        })
        .collect();
    let mut tag_errors: Vec<ParseError> = Vec::new();
    let mut manifests: Vec<Option<ResourceManifest>> = Vec::with_capacity(stream.documents.len());
    for (document_index, document) in stream.documents.iter().enumerate() {
        if !document.complete {
            manifests.push(None);
            continue;
        }
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
            Err(JsonRefusal::Tag(error)) => {
                manifests.push(None);
                tag_errors.push(ParseError {
                    document_index,
                    origin: match error.refusal {
                        TagRefusal::Loader { code, message } => ParseErrorOrigin::Loader { code, message },
                        TagRefusal::Unsupported(construct) => ParseErrorOrigin::Unsupported(construct),
                    },
                    range: error.range.map(range_of),
                });
            }
        }
    }
    parse_errors.append(&mut tag_errors);

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

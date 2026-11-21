//! What the loader refuses about a file itself, as a coded parse error on the file that
//! writes it, held back as a parse failure is. Mirrors
//! `../../nodejs/src/module-declaration-refusals.ts`: the module-declaration rule over a
//! module's main `telo.yaml` and the three `PARTIAL_*` refusals of `include:`.

use crate::builtin_vocabulary::BUILTIN_VOCABULARY_KIND;
use crate::loaded_types::{LoadedFile, ParseError, ParseErrorOrigin};
use crate::sources::source_failure::{ManifestSourceFailure, SourceFailureKind};
use crate::system_kinds::{is_module_document, APPLICATION, DEFINITION, LIBRARY};
use crate::types::{kind_of, Position, Range};

/// The document kinds only a module's own `telo.yaml` declares.
const OWNER_ONLY_KINDS: [&str; 4] = [APPLICATION, LIBRARY, "Telo.Import", DEFINITION];

const FILE_START: Range = Range { start: Position { line: 0, character: 0 }, end: Position { line: 0, character: 0 } };

pub const MODULE_DECLARATION_MISSING_MESSAGE: &str = "This file declares no module: a module's telo.yaml declares exactly one Telo.Application or Telo.Library, and a partial is checked and run through the module that includes it.";

fn module_declaration_duplicate_message(kinds: &[&str]) -> String {
    format!(
        "This file declares {} module documents ({}): a module's telo.yaml declares exactly one Telo.Application or Telo.Library; keep one and move each other module to a telo.yaml in a directory of its own.",
        kinds.len(),
        kinds.join(", ")
    )
}

/// What an import of a library holding several module documents is refused with.
pub fn duplicate_module_target_message(kinds: &[&str]) -> String {
    format!(
        "it declares {} module documents ({}); a library's telo.yaml declares exactly one Telo.Library.",
        kinds.len(),
        kinds.join(", ")
    )
}

/// The kinds of every module document of `file`, in file order.
pub fn module_document_kinds(file: &LoadedFile) -> Vec<&str> {
    file.manifests.iter().flatten().filter_map(kind_of).filter(|kind| is_module_document(kind)).collect()
}

fn kind_range(file: &LoadedFile, index: usize) -> Option<Range> {
    let positions = &file.positions.get(index)?.position_index;
    positions.get("kind").or_else(|| positions.get("")).copied()
}

fn loader_error(document_index: usize, code: &'static str, message: String, range: Option<Range>) -> ParseError {
    ParseError { document_index, origin: ParseErrorOrigin::Loader { code, message }, range }
}

/// Exactly one `Telo.Application` or `Telo.Library`: none is `MODULE_DECLARATION_MISSING`
/// (at the first document's `kind:`, the file's start for an empty file), more than one
/// `MODULE_DECLARATION_DUPLICATE` at the second module document's `kind:`. The built-in
/// vocabulary archive is refused on its own terms, and a file that did not parse is judged
/// by nothing more. A construct only this build cannot read is no parse failure of Node's,
/// so it does not stop the rule.
pub fn module_declaration_errors(file: &LoadedFile) -> Vec<ParseError> {
    let builtins = file.manifests.first().and_then(Option::as_ref).and_then(kind_of) == Some(BUILTIN_VOCABULARY_KIND);
    if builtins || file.parse_errors.iter().any(|error| !error.is_host_refusal()) {
        return Vec::new();
    }
    let module_indexes: Vec<usize> = file
        .manifests
        .iter()
        .enumerate()
        .filter(|(_, m)| m.as_ref().and_then(kind_of).is_some_and(is_module_document))
        .map(|(index, _)| index)
        .collect();
    match module_indexes.len() {
        1 => Vec::new(),
        0 => {
            let first = file.manifests.iter().position(Option::is_some);
            let range = first.and_then(|index| kind_range(file, index)).unwrap_or(FILE_START);
            vec![loader_error(
                first.unwrap_or(0),
                "MODULE_DECLARATION_MISSING",
                MODULE_DECLARATION_MISSING_MESSAGE.to_string(),
                Some(range),
            )]
        }
        _ => {
            let second = module_indexes[1];
            vec![loader_error(
                second,
                "MODULE_DECLARATION_DUPLICATE",
                module_declaration_duplicate_message(&module_document_kinds(file)),
                kind_range(file, second),
            )]
        }
    }
}

/// `PARTIAL_KIND_FORBIDDEN` for each document of a partial whose kind only the including
/// module's `telo.yaml` may declare, at its `kind:`.
pub fn partial_kind_errors(file: &LoadedFile) -> Vec<ParseError> {
    let mut errors = Vec::new();
    for (index, manifest) in file.manifests.iter().enumerate() {
        let Some(kind) = manifest.as_ref().and_then(kind_of).filter(|kind| OWNER_ONLY_KINDS.contains(kind)) else {
            continue;
        };
        errors.push(loader_error(
            index,
            "PARTIAL_KIND_FORBIDDEN",
            format!(
                "A partial may not declare a '{kind}' document: Telo.Application, Telo.Library, Telo.Import and Telo.Definition documents are declared only in the telo.yaml that includes it."
            ),
            kind_range(file, index),
        ));
    }
    errors
}

/// `PARTIAL_GLOB_UNSUPPORTED` for an `include:` glob the module's source cannot expand.
pub fn partial_glob_unsupported_error(pattern: &str, document_index: usize, range: Option<Range>) -> ParseError {
    loader_error(
        document_index,
        "PARTIAL_GLOB_UNSUPPORTED",
        format!(
            "'{pattern}' is a glob, and the source this module is read from cannot list files to expand it; name each partial by its path instead."
        ),
        range,
    )
}

/// Why a partial could not be read: the source failure's sentence, except for `NotAModule`,
/// whose sentence speaks of modules and no partial is one.
pub fn partial_failure_reason(failure: &ManifestSourceFailure) -> String {
    match failure.kind {
        SourceFailureKind::NotAModule => format!(
            "{} is not a file: an include: entry names one YAML file, or a glob over several.",
            failure.location
        ),
        _ => failure.sentence(),
    }
}

/// `PARTIAL_NOT_FOUND` for an `include:` entry naming a partial its source could not hand over.
pub fn partial_not_found_error(pattern: &str, reason: &str, document_index: usize, range: Option<Range>) -> ParseError {
    loader_error(document_index, "PARTIAL_NOT_FOUND", format!("The partial '{pattern}' cannot be read: {reason}"), range)
}

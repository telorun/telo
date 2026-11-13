//! Reading and writing a version where it lives, touching nothing else.
//!
//! Each write finds the one scalar and splices over its span, so a bump is a
//! one-line diff. A location names a file and, for JSON, YAML or TOML, an RFC
//! 6901 pointer into it; with no pointer the file is read by the handler
//! registered for its name, or — for any other file — as a plain version file.

use crate::adapter::{AdapterRegistry, VersionLocationSpec};
use crate::yaml::{json_string, parse_document, scalar_at, Scalar, ScalarStyle};
use crate::ReleaseError;

fn err(message: String) -> ReleaseError {
    ReleaseError::new(message)
}

/// Replace `[start, end)` of `text`.
pub fn splice_text(text: &str, start: usize, end: usize, replacement: &str) -> String {
    format!("{}{replacement}{}", &text[..start], &text[end..])
}

/// The pointer's reference tokens, unescaped.
pub fn pointer_tokens(pointer: &str, at: &str) -> Result<Vec<String>, ReleaseError> {
    let Some(rest) = pointer.strip_prefix('/') else {
        return Err(err(format!("{at}: '{pointer}' is not a JSON pointer; it must start with '/'.")));
    };
    Ok(rest.split('/').map(|token| token.replace("~1", "/").replace("~0", "~")).collect())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Format {
    Json,
    Yaml,
    Toml,
}

fn format_of(file: &str) -> Option<Format> {
    let lower = file.to_lowercase();
    if lower.ends_with(".json") {
        Some(Format::Json)
    } else if lower.ends_with(".yaml") || lower.ends_with(".yml") {
        Some(Format::Yaml)
    } else if lower.ends_with(".toml") {
        Some(Format::Toml)
    } else {
        None
    }
}

fn base_name(file: &str) -> &str {
    file.rsplit('/').next().unwrap_or(file)
}

/// The version a location holds, or `None` when it holds none.
pub fn read_version_at(location: &VersionLocationSpec, text: &str, at: &str, adapters: &AdapterRegistry) -> Result<Option<String>, ReleaseError> {
    if let Some(pointer) = &location.pointer {
        return read_pointer(text, &location.file, pointer, at);
    }
    if let Some(handler) = adapters.handler_for(base_name(&location.file)) {
        return handler.read(text, at);
    }
    refuse_structured(location, at)?;
    let version = text.trim();
    Ok(if version.is_empty() || version.contains('\n') { None } else { Some(version.to_string()) })
}

/// `text` rewritten so the location holds `version`.
pub fn write_version_at(
    location: &VersionLocationSpec,
    text: &str,
    version: &str,
    at: &str,
    adapters: &AdapterRegistry,
) -> Result<String, ReleaseError> {
    if let Some(pointer) = &location.pointer {
        return write_pointer(text, &location.file, pointer, version, at);
    }
    if let Some(handler) = adapters.handler_for(base_name(&location.file)) {
        return handler.write(text, version, at)?.ok_or_else(|| err(format!("{at} carries no version to write.")));
    }
    refuse_structured(location, at)?;
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.contains('\n') {
        return Err(err(format!("{at} is read as a plain version file, but it does not hold a single version line.")));
    }
    let start = text.find(trimmed).unwrap_or(0);
    Ok(splice_text(text, start, start + trimmed.len(), version))
}

fn refuse_structured(location: &VersionLocationSpec, at: &str) -> Result<(), ReleaseError> {
    let name = match format_of(&location.file) {
        Some(Format::Json) => "JSON",
        Some(Format::Yaml) => "YAML",
        Some(Format::Toml) => "TOML",
        None => return Ok(()),
    };
    Err(err(format!(
        "{at} is {name}, and no handler here reads a version from a file of that name. Name the version with {{ file, pointer }}."
    )))
}

fn unpointable(at: &str) -> ReleaseError {
    err(format!("{at}: a pointer reads only a JSON, YAML or TOML file."))
}

fn read_pointer(text: &str, file: &str, pointer: &str, at: &str) -> Result<Option<String>, ReleaseError> {
    let tokens = pointer_tokens(pointer, at)?;
    match format_of(file) {
        Some(Format::Toml) => Ok(toml_string(text, &tokens, at)?.map(|found| found.value)),
        None => Err(unpointable(at)),
        Some(_) => Ok(document_scalar(text, &tokens, at)?.and_then(|node| node.string_value().map(str::to_string))),
    }
}

fn write_pointer(text: &str, file: &str, pointer: &str, version: &str, at: &str) -> Result<String, ReleaseError> {
    let tokens = pointer_tokens(pointer, at)?;
    match format_of(file) {
        Some(Format::Toml) => {
            let found = toml_string(text, &tokens, at)?.ok_or_else(|| err(format!("{at} holds no string at {pointer}.")))?;
            Ok(splice_text(text, found.start, found.end, &format!("{}{version}{}", found.quote, found.quote)))
        }
        None => Err(unpointable(at)),
        Some(_) => {
            let node = document_scalar(text, &tokens, at)?
                .filter(|node| node.string_value().is_some())
                .ok_or_else(|| err(format!("{at} holds no string at {pointer}.")))?;
            splice_scalar(text, &node, version, at)
        }
    }
}

/// The scalar node at `tokens` of a JSON or YAML document.
pub fn document_scalar(text: &str, tokens: &[String], at: &str) -> Result<Option<Scalar>, ReleaseError> {
    let root = parse_document(text).map_err(|e| err(format!("{at} cannot be parsed: {}", e.message)))?;
    Ok(root.as_ref().and_then(|root| scalar_at(root, tokens)).cloned())
}

fn is_plain_version(version: &str) -> bool {
    let mut chars = version.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
}

/// Splice `version` over a scalar node, re-quoted in the author's own style.
pub fn splice_scalar(text: &str, node: &Scalar, version: &str, at: &str) -> Result<String, ReleaseError> {
    let (start, end) = node.range;
    let source = &text[start..end];
    let quoted = if node.style == ScalarStyle::DoubleQuoted || source.starts_with('"') {
        Some(json_string(version))
    } else if source.starts_with('\'') {
        Some(format!("'{}'", version.replace('\'', "''")))
    } else if is_plain_version(version) && !source.contains('\n') && node.style == ScalarStyle::Plain {
        Some(version.to_string())
    } else {
        None
    };
    let Some(quoted) = quoted else {
        return Err(err(format!(
            "{at}: the version is written as '{source}', which cannot be rewritten in place. Write it as a plain or quoted scalar on one line."
        )));
    };
    Ok(splice_text(text, start, end, &quoted))
}

#[derive(Debug, Clone)]
pub struct TomlString {
    pub value: String,
    pub start: usize,
    pub end: usize,
    pub quote: char,
}

/// Lines of `text` as `(start, content)`, split on `\n`; `content` stops at a
/// line terminator JavaScript's `$` stops at.
pub(crate) fn lines(text: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let mut start = 0;
    for line in text.split('\n') {
        let content = match line.find(['\r', '\u{2028}', '\u{2029}']) {
            Some(cut) => &line[..cut],
            None => line,
        };
        out.push((start, content));
        start += line.len() + 1;
    }
    out
}

/// `[ \t]*(?:#.*)?` filling the rest of a line.
pub(crate) fn rest_is_blank_or_comment(rest: &str) -> bool {
    let trimmed = rest.trim_start_matches([' ', '\t']);
    trimmed.is_empty() || trimmed.starts_with('#')
}

/// A header line `[table]` / `[[table]]`: whether it is an array table, and
/// the text between the brackets.
fn table_header(line: &str) -> Option<(bool, &str)> {
    let body = line.trim_start_matches([' ', '\t']);
    let rest = body.strip_prefix('[')?;
    let (array, rest) = match rest.strip_prefix('[') {
        Some(after) => (true, after),
        None => (false, rest),
    };
    let close = rest.find(']')?;
    let name = &rest[..close];
    let after = &rest[close + 1..];
    let after = after.strip_prefix(']').unwrap_or(after);
    rest_is_blank_or_comment(after).then_some((array, name))
}

/// A quoted string at `tokens` of a TOML document — the last token a key, the
/// rest the table header holding it. Scanned rather than parsed, for the
/// shape version files are written in.
pub fn toml_string(text: &str, tokens: &[String], at: &str) -> Result<Option<TomlString>, ReleaseError> {
    let Some((key, table)) = tokens.split_last() else {
        return Err(err(format!("{at}: the pointer names no key.")));
    };
    let all = lines(text);
    let mut body_start: Option<usize> = if table.is_empty() { Some(0) } else { None };
    let mut body_end = text.len();
    for (start, line) in &all {
        let Some((array, name)) = table_header(line) else { continue };
        if body_start.is_some() {
            body_end = *start;
            break;
        }
        if !array && same_table_path(name, table) {
            body_start = Some(start + line.len());
        }
    }
    let Some(body_start) = body_start else {
        return Ok(None);
    };
    let body = &text[body_start..body_end];
    for (start, line) in lines(body) {
        if let Some(found) = key_value(line, key, body_start + start) {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

/// `^([ \t]*(?:KEY|"KEY")[ \t]*=[ \t]*)("[^"\n]*"|'[^'\n]*')[ \t]*(?:#.*)?$`
fn key_value(line: &str, key: &str, offset: usize) -> Option<TomlString> {
    let indent = line.len() - line.trim_start_matches([' ', '\t']).len();
    let rest = &line[indent..];
    let quoted_key = format!("\"{key}\"");
    let rest = rest.strip_prefix(quoted_key.as_str()).or_else(|| rest.strip_prefix(key))?;
    let after_key = rest.trim_start_matches([' ', '\t']);
    let after_eq = after_key.strip_prefix('=')?;
    let value = after_eq.trim_start_matches([' ', '\t']);
    let quote = value.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let close = value[1..].find(quote)? + 1;
    if !rest_is_blank_or_comment(&value[close + 1..]) {
        return None;
    }
    let start = offset + (line.len() - value.len());
    Some(TomlString { value: value[1..close].to_string(), start, end: start + close + 1, quote })
}

fn same_table_path(header: &str, table: &[String]) -> bool {
    let parts: Vec<String> = header
        .split('.')
        .map(|part| {
            let trimmed = part.trim();
            match trimmed.strip_prefix('"').and_then(|p| p.strip_suffix('"')) {
                Some(inner) if trimmed.len() >= 2 => inner.to_string(),
                _ => trimmed.to_string(),
            }
        })
        .collect();
    parts.len() == table.len() && parts.iter().zip(table).all(|(a, b)| a == b)
}

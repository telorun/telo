//! What a path template reads: its `{name}` variables, or why it is no template. Mirrors
//! `../../nodejs/src/path-template-reading.ts`, the one reader of the grammar, reason for
//! reason and offset for offset — an offset counts UTF-16 code units, as JavaScript does.
//!
//! A template is an app-relative path or an `http://`, `https://` or `mailto:` address
//! whose variables are whole path segments `{<name>}`, `<name>` matching
//! `/^[A-Za-z_][A-Za-z0-9_]*$/`, each named once; an absolute URL's authority, its query
//! and its fragment hold none.

/// What a template reads: its variables in order, or why it is no template and the
/// zero-based offset (in UTF-16 code units) the reason is about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PathTemplateReading {
    Variables(Vec<String>),
    Invalid { reason: String, offset: usize },
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

fn is_variable_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn brace_at(text: &str) -> Option<usize> {
    text.find(['{', '}']).map(|at| units(&text[..at]))
}

/// `^(https?)://([^/?#]*)((?:[/?#].*)?)$`, case-insensitive: the scheme, the authority and
/// the rest. `.` stops at a line terminator, so a rest holding one reads as no URL.
fn absolute_url(template: &str) -> Option<(&str, &str, &str)> {
    let lower = template.get(..8).map(str::to_ascii_lowercase).unwrap_or_default();
    let scheme_length = if lower.starts_with("https://") {
        5
    } else if lower.starts_with("http://") {
        4
    } else {
        return None;
    };
    let after = &template[scheme_length + 3..];
    let authority_end = after.find(['/', '?', '#']).unwrap_or(after.len());
    let rest = &after[authority_end..];
    if rest.chars().skip(1).any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')) {
        return None;
    }
    Some((&template[..scheme_length], &after[..authority_end], rest))
}

/// A path template's variables, or the reason it is not one.
pub fn read_path_template(template: &str) -> PathTemplateReading {
    let invalid = |reason: String, offset: usize| PathTemplateReading::Invalid { reason, offset };
    let mut rest = template;
    let mut rest_at = 0;
    if let Some((scheme, authority, tail)) = absolute_url(template) {
        let authority_at = units(scheme) + 3;
        if let Some(brace) = brace_at(authority) {
            return invalid(
                format!("its authority '{authority}' holds a variable — only the path segments after the authority are variables"),
                authority_at + brace,
            );
        }
        rest = tail;
        rest_at = authority_at + units(authority);
    } else if template.get(..7).is_some_and(|head| head.eq_ignore_ascii_case("mailto:"))
        && !template[7..].chars().any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
    {
        rest = &template[7..];
        rest_at = units(template) - units(rest);
    }
    let tail_at = rest.find(['?', '#']);
    let (path, tail) = match tail_at {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, ""),
    };
    if let Some(brace) = brace_at(tail) {
        return invalid(
            format!("its query or fragment '{tail}' holds '{{' or '}}' — a variable is a whole path segment"),
            rest_at + units(path) + brace,
        );
    }
    let mut variables: Vec<String> = Vec::new();
    let mut segment_at = rest_at;
    for segment in path.split('/') {
        let at = segment_at;
        segment_at += units(segment) + 1;
        if !segment.contains(['{', '}']) {
            continue;
        }
        let whole = segment
            .strip_prefix('{')
            .and_then(|inner| inner.strip_suffix('}'))
            .filter(|inner| !inner.contains(['{', '}']));
        let Some(name) = whole else {
            return invalid(
                format!("segment '{segment}' holds a variable beside other text — a variable is a whole segment, '/{{<name>}}/'"),
                at,
            );
        };
        if !is_variable_name(name) {
            return invalid(format!("'{{{name}}}' names no variable — a name matches /^[A-Za-z_][A-Za-z0-9_]*$/"), at);
        }
        if variables.iter().any(|held| held == name) {
            return invalid(format!("'{{{name}}}' appears twice — each variable names one segment"), at);
        }
        variables.push(name.to_string());
    }
    PathTemplateReading::Variables(variables)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_variables_and_refusals_as_the_node_reader_does() {
        assert_eq!(read_path_template("/x/{id}/y/{rev}"), PathTemplateReading::Variables(vec!["id".into(), "rev".into()]));
        assert_eq!(
            read_path_template("/x/{id}/{id}"),
            PathTemplateReading::Invalid { reason: "'{id}' appears twice — each variable names one segment".into(), offset: 8 }
        );
        assert_eq!(
            read_path_template("https://{host}/x"),
            PathTemplateReading::Invalid {
                reason: "its authority '{host}' holds a variable — only the path segments after the authority are variables".into(),
                offset: 8
            }
        );
        assert_eq!(
            read_path_template("/x?{q}"),
            PathTemplateReading::Invalid { reason: "its query or fragment '?{q}' holds '{' or '}' — a variable is a whole path segment".into(), offset: 3 }
        );
    }
}

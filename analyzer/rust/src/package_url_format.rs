//! The `package-url` Telo format: a versionless package URL, `pkg:<type>/<name>`
//! (the purl specification). Mirrors `../../nodejs/src/package-url-format.ts` and
//! runs the same conformance set, `sdk/formats/package-url.json`.

use crate::telo_format::{fail, text, FormatFailure};

fn is_type(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '+' | '-'))
}

fn is_qualifier_key(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

fn component_failure(text: &[char], base: usize) -> Option<FormatFailure> {
    for (i, ch) in text.iter().enumerate() {
        if *ch == '%' {
            let hex = text.get(i + 1..i + 3).is_some_and(|h| h.iter().all(char::is_ascii_hexdigit));
            if !hex {
                return fail("a '%' must be followed by two hexadecimal digits", base + i);
            }
        } else if ch.is_whitespace() || ch.is_control() {
            return fail("whitespace and control characters must be percent-encoded", base + i);
        }
    }
    None
}

/// The qualifier a bill of materials writes from a declared `vcs:`, never written by hand.
const VCS_QUALIFIER: &str = "vcs_url";

fn find(chars: &[char], needle: char, from: usize) -> Option<usize> {
    chars.get(from..)?.iter().position(|c| *c == needle).map(|p| p + from)
}

pub(crate) fn check(value: &str) -> Option<FormatFailure> {
    let chars: Vec<char> = value.chars().collect();
    if !value.starts_with("pkg:") {
        return fail("a package URL starts with the scheme pkg:, as in pkg:npm/left-pad", 0);
    }
    let hash = find(&chars, '#', 0);
    let before_hash = hash.unwrap_or(chars.len());
    let query = find(&chars[..before_hash], '?', 0);
    let path_end = query.unwrap_or(before_hash);
    let path = &chars[4..path_end];

    let Some(slash) = path.iter().position(|c| *c == '/') else {
        return fail("it has no name: write pkg:<type>/<name>", chars.len());
    };
    let kind = text(&path[..slash]);
    if !is_type(&kind) {
        return fail(
            format!("the type '{kind}' must be lower-case letters, digits, '.', '+' or '-', and not start with a digit"),
            4,
        );
    }

    if let Some(at) = find(path, '@', slash) {
        let after = &path[at + 1..];
        if after.contains(&'/') {
            return fail(
                "an '@' inside a namespace or name is written %40, as in pkg:npm/%40napi-rs/canvas",
                4 + at,
            );
        }
        return fail(
            format!(
                "it names a version (@{}). A source's version is its `version:`; write {}",
                text(after),
                text(&chars[..4 + at])
            ),
            4 + at,
        );
    }

    let mut offset = 4 + slash + 1;
    let segments: Vec<&[char]> = path[slash + 1..].split(|c| *c == '/').collect();
    for segment in &segments {
        if segment.is_empty() {
            let reason = if segments.len() == 1 {
                "it has no name: write pkg:<type>/<name>"
            } else {
                "a namespace or name segment is empty"
            };
            return fail(reason, offset);
        }
        if let Some(bad) = component_failure(segment, offset) {
            return Some(bad);
        }
        offset += segment.len() + 1;
    }

    if let Some(query) = query {
        let body = &chars[query + 1..before_hash];
        if body.is_empty() {
            return fail("the qualifiers after '?' are empty", query);
        }
        let mut seen: Vec<String> = Vec::new();
        let pairs: Vec<&[char]> = body.split(|c| *c == '&').collect();
        let mut at = query + 1;
        for pair in &pairs {
            let eq = pair.iter().position(|c| *c == '=');
            let key = text(&pair[..eq.unwrap_or(pair.len())]);
            let Some(eq) = eq.filter(|_| is_qualifier_key(&key)) else {
                return fail(
                    format!("the qualifier '{}' must be key=value with a lower-case key of letters, digits, '.', '-' or '_'", text(pair)),
                    at,
                );
            };
            if key == VCS_QUALIFIER {
                let rest: Vec<String> = pairs
                    .iter()
                    .filter(|other| text(&other[..other.iter().position(|c| *c == '=').unwrap_or(other.len())]) != VCS_QUALIFIER)
                    .map(|other| text(other))
                    .collect();
                let query_text = if rest.is_empty() { String::new() } else { format!("?{}", rest.join("&")) };
                return fail(
                    format!(
                        "it carries a vcs_url qualifier. The repository and commit are declared beside the package URL as `vcs: {{ url, revision }}`; write {}{}{}",
                        text(&chars[..query]),
                        query_text,
                        text(&chars[before_hash..])
                    ),
                    at,
                );
            }
            if eq == pair.len() - 1 {
                return fail(format!("the qualifier '{key}' has no value"), at);
            }
            if seen.contains(&key) {
                return fail(format!("the qualifier '{key}' is given twice"), at);
            }
            seen.push(key);
            if let Some(bad) = component_failure(&pair[eq + 1..], at + eq + 1) {
                return Some(bad);
            }
            at += pair.len() + 1;
        }
    }

    if let Some(hash) = hash {
        let body = &chars[hash + 1..];
        if body.is_empty() {
            return fail("the subpath after '#' is empty", hash);
        }
        let mut at = hash + 1;
        for segment in body.split(|c| *c == '/') {
            let name = text(segment);
            if name.is_empty() || name == "." || name == ".." {
                return fail("a subpath segment must be a name, not empty, '.' or '..'", at);
            }
            if let Some(bad) = component_failure(segment, at) {
                return Some(bad);
            }
            at += segment.len() + 1;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telo_format::{assert_conformance, format_failure};

    #[test]
    fn agrees_with_the_shared_conformance_set() {
        assert_conformance("package-url", include_str!("../../../sdk/formats/package-url.json"));
    }

    #[test]
    fn words_a_version_written_into_the_purl() {
        let failure = check("pkg:npm/better-sqlite3@12.8.0").unwrap();
        assert!(failure.reason.contains("it names a version (@12.8.0)"));
        assert!(failure.reason.contains("write pkg:npm/better-sqlite3"));
        assert_eq!(format_failure("package-url", "pkg:npm/better-sqlite3@12.8.0"), Some(failure));
    }

    #[test]
    fn refuses_a_vcs_url_qualifier_naming_the_purl_without_it() {
        let value = "pkg:generic/engine?arch=x86&vcs_url=git%2Bhttps%3A%2F%2Fgit.example.test%2Facme%2Fengine%40a5333afb9ad1aa473f8963b92caeaa955f47dc74";
        let failure = check(value).unwrap();
        assert_eq!(
            failure.reason,
            "it carries a vcs_url qualifier. The repository and commit are declared beside the package URL as `vcs: { url, revision }`; write pkg:generic/engine?arch=x86"
        );
        assert_eq!(failure.offset, "pkg:generic/engine?arch=x86&".len());
        assert_eq!(check("pkg:generic/engine?vcs_url=x").unwrap().reason.rsplit("write ").next(), Some("pkg:generic/engine"));
    }
}

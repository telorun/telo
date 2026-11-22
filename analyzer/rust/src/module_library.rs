//! A module's **exported code** — the `exports.code:` block on a `Telo.Library` doc, which
//! names the entry point a sibling module's controller bundle resolves this module's bare
//! specifier to. Mirrors `../../nodejs/src/module-library.ts`: the reader returns every
//! malformed entry as a problem rather than skipping it silently, and an entry with a problem
//! is not a candidate. Whether the named file exists is a separate question.

use serde_json::{Map, Value};

use crate::artifact_selector::{selector_from_record, ArtifactSelector, PlatformAxis};
use crate::module_relative_path::normalize_relative;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LibraryCandidate {
    /// The bare specifier a sibling's controller bundle imports this library by.
    pub specifier: String,
    /// Module-root-relative path of the built entry point.
    pub path: String,
    /// Module-root-relative source it is built from (`source:`), when the entry names one.
    pub local_path: Option<String>,
    pub selector: ArtifactSelector,
    /// Where the entry was written, for diagnostics.
    pub origin: String,
}

/// Why an `exports.code` entry could not be read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LibraryCandidateProblem {
    pub origin: String,
    pub detail: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LibraryCandidates {
    pub candidates: Vec<LibraryCandidate>,
    pub problems: Vec<LibraryCandidateProblem>,
}

/// Every key an entry may carry: the two locators, plus the selector axes.
fn known_keys() -> Vec<&'static str> {
    let mut keys = vec!["specifier", "path", "source", "format"];
    keys.extend(PlatformAxis::ALL.map(PlatformAxis::name));
    keys
}

fn required_string(entry: &Map<String, Value>, key: &str) -> Result<String, String> {
    match entry.get(key) {
        Some(Value::String(raw)) if !raw.trim().is_empty() => Ok(raw.trim().to_string()),
        _ => Err(format!("'{key}' is required and must be a non-empty string.")),
    }
}

/// Read the `exports.code:` block off an owner document's JSON projection.
pub fn read_library_candidates(owner: &Value) -> LibraryCandidates {
    let mut out = LibraryCandidates::default();
    let Some(declared) = owner.get("exports").and_then(|exports| exports.get("code")) else {
        return out;
    };
    let Some(declared) = declared.as_array() else {
        out.problems.push(LibraryCandidateProblem {
            origin: "exports.code".into(),
            detail: "expected a list of entries.".into(),
        });
        return out;
    };
    let known = known_keys();
    for (index, raw) in declared.iter().enumerate() {
        let origin = format!("exports.code[{index}]");
        let Some(entry) = raw.as_object() else {
            out.problems.push(LibraryCandidateProblem { origin, detail: "expected an object.".into() });
            continue;
        };
        let unknown: Vec<String> =
            entry.keys().filter(|key| !known.contains(&key.as_str())).map(|key| format!("'{key}'")).collect();
        if !unknown.is_empty() {
            out.problems.push(LibraryCandidateProblem {
                origin,
                detail: format!(
                    "unknown {} {}. Known: {}.",
                    if unknown.len() == 1 { "key" } else { "keys" },
                    unknown.join(", "),
                    known.join(", ")
                ),
            });
            continue;
        }

        let specifier = match required_string(entry, "specifier") {
            Ok(specifier) => specifier,
            Err(detail) => {
                out.problems.push(LibraryCandidateProblem { origin, detail });
                continue;
            }
        };
        let named = format!("{origin} ('{specifier}')");
        let file = match required_string(entry, "path") {
            Ok(file) => file,
            Err(detail) => {
                out.problems.push(LibraryCandidateProblem { origin: named, detail });
                continue;
            }
        };
        let format = match required_string(entry, "format") {
            Ok(format) => format,
            Err(detail) => {
                out.problems.push(LibraryCandidateProblem { origin: named, detail });
                continue;
            }
        };
        let selector = match selector_from_record(Some(&Value::String(format)), entry, &named) {
            Ok(selector) => selector,
            Err(error) => {
                out.problems.push(LibraryCandidateProblem { origin: named, detail: error.detail });
                continue;
            }
        };
        let source = match entry.get("source") {
            None => None,
            Some(Value::String(source)) if !source.trim().is_empty() => Some(source.trim().to_string()),
            Some(_) => {
                out.problems.push(LibraryCandidateProblem {
                    origin: named,
                    detail: "'source' must be a non-empty string when present.".into(),
                });
                continue;
            }
        };
        out.candidates.push(LibraryCandidate {
            specifier,
            path: normalize_relative(&file),
            local_path: source.map(|source| normalize_relative(&source)),
            selector,
            origin: named,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn read(code: Value) -> LibraryCandidates {
        read_library_candidates(&json!({ "exports": { "code": code } }))
    }

    #[test]
    fn reads_an_entry_into_a_candidate() {
        let read = read(json!([{ "specifier": "@acme/x", "format": "js", "path": "./nodejs/x.mjs", "source": "./nodejs/src/index.ts" }]));
        assert_eq!(read.problems, []);
        let candidate = &read.candidates[0];
        assert_eq!(
            (candidate.path.as_str(), candidate.local_path.as_deref(), candidate.origin.as_str()),
            ("nodejs/x.mjs", Some("nodejs/src/index.ts"), "exports.code[0] ('@acme/x')")
        );
    }

    #[test]
    fn reports_each_malformed_entry_and_drops_it() {
        let read = read(json!([
            "text",
            { "specifier": "a", "format": "js", "path": "p", "extra": 1 },
            { "format": "js" },
            { "specifier": "b", "format": "js" },
            { "specifier": "c", "format": "Bad Format", "path": "p" },
            { "specifier": "d", "format": "js", "path": "p", "source": " " },
        ]));
        assert!(read.candidates.is_empty());
        let reported: Vec<_> = read.problems.iter().map(|p| (p.origin.as_str(), p.detail.as_str())).collect();
        assert_eq!(reported[0], ("exports.code[0]", "expected an object."));
        assert_eq!(
            reported[1],
            ("exports.code[1]", "unknown key 'extra'. Known: specifier, path, source, format, os, arch, libc, abi.")
        );
        assert_eq!(reported[2], ("exports.code[2]", "'specifier' is required and must be a non-empty string."));
        assert_eq!(reported[3], ("exports.code[3] ('b')", "'path' is required and must be a non-empty string."));
        assert!(reported[4].1.starts_with("exports.code[4] ('c'): format value 'Bad Format'"));
        assert_eq!(reported[5], ("exports.code[5] ('d')", "'source' must be a non-empty string when present."));
    }
}

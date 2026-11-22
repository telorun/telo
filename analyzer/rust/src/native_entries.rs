//! A module's **native files** — the `native:` block on a `Telo.Library` or
//! `Telo.Application` doc, naming each platform-specific file the runtime does not import as
//! a controller. Mirrors `../../nodejs/src/native-entries.ts`: the path normalizer, the
//! entry grammar and the reader, whose problems `validate_native_entries` reports.

use serde_json::{Map, Value};

use crate::artifact_selector::{selector_from_record, ArtifactSelector, PlatformAxis};

/// Every key an entry may carry, in Node's order: `name`, `format`, `path`, then the axes.
fn known_keys() -> Vec<&'static str> {
    let mut keys = vec!["name", "format", "path"];
    keys.extend(PlatformAxis::ALL.map(PlatformAxis::name));
    keys
}

/// Axes an entry must state: a native file is built for one platform.
const REQUIRED_AXES: [&str; 2] = ["os", "arch"];

/// A normalized module-root-relative POSIX path, or why the written path names
/// no single file inside the module.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PathVerdict {
    Path(String),
    Invalid(String),
    Escape(String),
}

fn has_uri_scheme(raw: &str) -> bool {
    let Some(colon) = raw.find(':') else {
        return false;
    };
    let scheme = &raw[..colon];
    scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

/// Normalize a module-relative path, deciding confinement from the written path
/// alone: the module root is the one directory every path is measured from, so
/// `..` below depth zero is an escape wherever the module sits.
pub fn normalize_native_path(raw: &str) -> PathVerdict {
    if has_uri_scheme(raw) || raw.starts_with('/') || raw.starts_with('\\') {
        return PathVerdict::Escape(format!(
            "path '{raw}' is not relative to the module root. A native file ships inside the module artifact, so name it relative to the directory holding telo.yaml."
        ));
    }
    if raw.contains(['*', '?', '[', ']', '{', '}']) {
        return PathVerdict::Invalid(format!(
            "path '{raw}' looks like a pattern. A native entry names exactly one file."
        ));
    }
    let mut out: Vec<&str> = Vec::new();
    for segment in raw.split(['/', '\\']) {
        match segment {
            "" | "." => {}
            ".." => {
                if out.pop().is_none() {
                    return PathVerdict::Escape(format!(
                        "path '{raw}' points above the module root. A native file must ship inside the module directory."
                    ));
                }
            }
            other => out.push(other),
        }
    }
    if out.is_empty() {
        return PathVerdict::Invalid(format!(
            "path '{raw}' resolves to the module root, not to a file."
        ));
    }
    PathVerdict::Path(out.join("/"))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeEntry {
    /// The logical name controller code asks for.
    pub name: String,
    pub selector: ArtifactSelector,
    /// Module-root-relative POSIX path, normalized.
    pub path: String,
    /// Position in the `native:` list.
    pub index: usize,
    /// Human-facing label for diagnostics: `native[0] ('better-sqlite3')`.
    pub origin: String,
}

/// Why an entry could not be read: `Shape` is a missing, non-string or unknown key (the owner
/// doc's JSON Schema reports it), `Invalid` a value the schema accepts and the grammar
/// rejects, `Escape` a `path` pointing outside the module directory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeProblemKind {
    Shape,
    Invalid,
    Escape,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeEntryProblem {
    pub kind: NativeProblemKind,
    pub index: Option<usize>,
    pub origin: String,
    /// Dotted/bracketed path from the module doc root, for `data.path`.
    pub path: String,
    /// What is wrong, prefixed with `origin`.
    pub message: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NativeEntries {
    pub entries: Vec<NativeEntry>,
    pub problems: Vec<NativeEntryProblem>,
}

/// `^[a-z0-9][a-z0-9_.-]*$`
fn is_name_token(name: &str) -> bool {
    name.bytes().next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'.' | b'-'))
}

fn quoted_list(keys: &[&str]) -> String {
    keys.iter().map(|k| format!("'{k}'")).collect::<Vec<_>>().join(", ")
}

/// Read the `native:` block off an owner document's JSON projection. An entry with any
/// problem is left out of `entries`, never read partially: a half-read entry would name a
/// layer the author did not declare.
pub fn read_native_entries(owner: &Value) -> NativeEntries {
    let mut out = NativeEntries::default();
    let Some(declared) = owner.get("native") else {
        return out;
    };
    let Some(declared) = declared.as_array() else {
        out.problems.push(NativeEntryProblem {
            kind: NativeProblemKind::Shape,
            index: None,
            origin: "native".into(),
            path: "native".into(),
            message: "native: expected a list of entries.".into(),
        });
        return out;
    };
    let known = known_keys();
    for (index, raw) in declared.iter().enumerate() {
        let at = format!("native[{index}]");
        let shape = |problems: &mut Vec<NativeEntryProblem>, detail: String| {
            problems.push(NativeEntryProblem {
                kind: NativeProblemKind::Shape,
                index: Some(index),
                origin: at.clone(),
                path: at.clone(),
                message: format!("{at}: {detail}"),
            })
        };
        let Some(entry) = raw.as_object() else {
            shape(&mut out.problems, "expected an object.".into());
            continue;
        };
        let unknown: Vec<&str> = entry.keys().map(String::as_str).filter(|key| !known.contains(key)).collect();
        if !unknown.is_empty() {
            shape(
                &mut out.problems,
                format!(
                    "unknown {} {}. Known: {}.",
                    if unknown.len() == 1 { "key" } else { "keys" },
                    quoted_list(&unknown),
                    known.join(", ")
                ),
            );
            continue;
        }
        let mut required_keys = vec!["name", "format"];
        required_keys.extend(REQUIRED_AXES);
        required_keys.push("path");
        let missing: Vec<&str> =
            required_keys.iter().copied().filter(|key| !entry.get(*key).is_some_and(Value::is_string)).collect();
        if !missing.is_empty() {
            shape(&mut out.problems, format!("{} must be strings.", quoted_list(&missing)));
            continue;
        }
        let text = |entry: &Map<String, Value>, key: &str| entry[key].as_str().unwrap_or_default().to_string();
        let blank: Vec<&str> = required_keys.iter().copied().filter(|key| text(entry, key).trim().is_empty()).collect();
        if !blank.is_empty() {
            for key in blank {
                out.problems.push(NativeEntryProblem {
                    kind: NativeProblemKind::Invalid,
                    index: Some(index),
                    origin: at.clone(),
                    path: format!("{at}.{key}"),
                    message: format!("{at}: '{key}' must not be empty."),
                });
            }
            continue;
        }

        let name = text(entry, "name");
        let origin = format!("{at} ('{name}')");
        if !is_name_token(&name) {
            out.problems.push(NativeEntryProblem {
                kind: NativeProblemKind::Invalid,
                index: Some(index),
                origin: origin.clone(),
                path: format!("{at}.name"),
                message: format!(
                    "{origin}: name '{name}' is not a canonical token. Use lowercase letters, digits, '.', '-' or '_', starting with a letter or digit."
                ),
            });
            continue;
        }

        let selector = match selector_from_record(entry.get("format"), entry, &origin) {
            Ok(selector) => selector,
            Err(error) => {
                out.problems.push(NativeEntryProblem {
                    kind: NativeProblemKind::Invalid,
                    index: Some(index),
                    origin,
                    path: at.clone(),
                    message: error.detail,
                });
                continue;
            }
        };

        let (kind, detail) = match normalize_native_path(text(entry, "path").trim()) {
            PathVerdict::Path(path) => {
                out.entries.push(NativeEntry { name, selector, path, index, origin });
                continue;
            }
            PathVerdict::Invalid(detail) => (NativeProblemKind::Invalid, detail),
            PathVerdict::Escape(detail) => (NativeProblemKind::Escape, detail),
        };
        out.problems.push(NativeEntryProblem {
            kind,
            index: Some(index),
            origin: origin.clone(),
            path: format!("{at}.path"),
            message: format!("{origin}: {detail}"),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(native: serde_json::Value) -> NativeEntries {
        read_native_entries(&serde_json::json!({ "native": native }))
    }

    #[test]
    fn reads_an_entry_and_leaves_out_one_with_a_problem() {
        let good = serde_json::json!({ "name": "addon", "format": "napi", "os": "linux", "arch": "amd64", "path": "./native/a.node" });
        let read = read(serde_json::json!([good, { "name": "Bad!", "format": "napi", "os": "linux", "arch": "amd64", "path": "x" }]));
        assert_eq!(read.entries.len(), 1);
        assert_eq!((read.entries[0].path.as_str(), read.entries[0].origin.as_str()), ("native/a.node", "native[0] ('addon')"));
        assert_eq!(read.problems.len(), 1);
        assert_eq!(read.problems[0].kind, NativeProblemKind::Invalid);
        assert_eq!(read.problems[0].path, "native[1].name");
    }

    #[test]
    fn classifies_what_it_cannot_read() {
        let entry = |extra: serde_json::Value| {
            let mut entry = serde_json::json!({ "name": "a", "format": "napi", "os": "linux", "arch": "amd64", "path": "p" });
            entry.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            entry
        };
        let kinds = |value: serde_json::Value| read(value).problems.iter().map(|p| (p.kind, p.message.clone())).collect::<Vec<_>>();
        assert_eq!(kinds(serde_json::json!("x")), [(NativeProblemKind::Shape, "native: expected a list of entries.".to_string())]);
        assert_eq!(
            kinds(serde_json::json!([entry(serde_json::json!({ "bogus": 1 }))])),
            [(NativeProblemKind::Shape, "native[0]: unknown key 'bogus'. Known: name, format, path, os, arch, libc, abi.".to_string())]
        );
        assert_eq!(
            kinds(serde_json::json!([entry(serde_json::json!({ "arch": 1 }))])),
            [(NativeProblemKind::Shape, "native[0]: 'arch' must be strings.".to_string())]
        );
        assert_eq!(
            kinds(serde_json::json!([entry(serde_json::json!({ "path": "../x" }))])),
            [(NativeProblemKind::Escape, "native[0] ('a'): path '../x' points above the module root. A native file must ship inside the module directory.".to_string())]
        );
        assert_eq!(kinds(serde_json::json!([entry(serde_json::json!({ "os": " " }))]))[0].0, NativeProblemKind::Invalid);
    }

    #[test]
    fn normalizes_as_the_node_reader_does() {
        assert_eq!(normalize_native_path("./native/../native//x.node"), PathVerdict::Path("native/x.node".into()));
        assert!(matches!(normalize_native_path("../x"), PathVerdict::Escape(_)));
        assert!(matches!(normalize_native_path("file:x"), PathVerdict::Escape(_)));
        assert!(matches!(normalize_native_path("native/*.node"), PathVerdict::Invalid(_)));
        assert!(matches!(normalize_native_path("./"), PathVerdict::Invalid(_)));
    }
}

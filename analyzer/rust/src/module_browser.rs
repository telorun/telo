//! A module's **browser entries** — the `exports.browser:` block on a `Telo.Library` doc,
//! which names the ES modules the module ships for a browser to import. Mirrors
//! `../../nodejs/src/module-browser.ts`: everything malformed is a problem rather than a
//! silent skip, and an entry with a problem is not an entry.

use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::artifact_selector::{normalize_axis_value, ArtifactSelector, AxisValues, PlatformAxis};
use crate::module_relative_path::normalize_relative;

/// The format every browser entry has. Implied, so it is never written.
pub const BROWSER_FORMAT: &str = "esm";

const KNOWN_KEYS: [&str; 6] = ["specifier", "path", "source", "abi", "external", "exports"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowserEntry {
    /// The import-map key, and the name resources refer to the entry by.
    pub specifier: String,
    /// Module-root-relative path of the built file.
    pub path: String,
    /// Module-root-relative source it is built from, when the entry names one.
    pub local_path: Option<String>,
    pub abi: Option<String>,
    /// Bare specifiers the host supplies, sorted.
    pub external: Vec<String>,
    /// Export names a resource may name.
    pub exports: Vec<String>,
    /// `format: esm` plus the entry's `abi` — the layer it ships in.
    pub selector: ArtifactSelector,
    /// Where the entry was written, for diagnostics.
    pub origin: String,
    /// Its position in the `exports.browser:` list.
    pub index: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowserEntryProblem {
    pub origin: String,
    pub detail: String,
    /// The entry's position in the list, when the problem is one entry's.
    pub index: Option<usize>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BrowserEntries {
    pub entries: Vec<BrowserEntry>,
    pub problems: Vec<BrowserEntryProblem>,
}

fn has_uri_scheme(raw: &str) -> bool {
    let Some(colon) = raw.find(':') else { return false };
    let scheme = &raw[..colon];
    scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

/// Why a written `path` / `source` is not a file inside the module, decided from the text
/// alone: the module root is the directory every path is measured from.
fn outside_module(key: &str, raw: &str) -> Option<String> {
    if has_uri_scheme(raw) || raw.starts_with('/') || raw.starts_with('\\') {
        return Some(format!(
            "'{key}' is '{raw}', which is not relative to the module root. A browser entry ships inside the module, so name the file relative to the directory holding telo.yaml."
        ));
    }
    let mut depth: i64 = 0;
    for segment in raw.split(['/', '\\']) {
        if segment.is_empty() || segment == "." {
            continue;
        }
        depth += if segment == ".." { -1 } else { 1 };
        if depth < 0 {
            return Some(format!(
                "'{key}' is '{raw}', which points above the module root. A browser entry ships inside the module, so the file must be inside the directory holding telo.yaml."
            ));
        }
    }
    None
}

fn string_list(entry: &Map<String, Value>, key: &str) -> Result<Vec<String>, String> {
    let Some(raw) = entry.get(key) else { return Ok(Vec::new()) };
    let items = raw.as_array().and_then(|items| {
        items
            .iter()
            .map(|item| item.as_str().filter(|text| !text.trim().is_empty()).map(|text| text.trim().to_string()))
            .collect::<Option<Vec<_>>>()
    });
    items.ok_or_else(|| format!("'{key}' must be a list of non-empty strings."))
}

fn non_blank(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|text| !text.trim().is_empty())
}

fn quoted(keys: &[&str]) -> String {
    keys.iter().map(|key| format!("'{key}'")).collect::<Vec<_>>().join(", ")
}

/// Read the `exports.browser:` block off an owner document's JSON projection.
pub fn read_browser_entries(owner: &Value) -> BrowserEntries {
    let mut out = BrowserEntries::default();
    let Some(declared) = owner.get("exports").and_then(|exports| exports.get("browser")) else {
        return out;
    };
    let Some(declared) = declared.as_array() else {
        out.problems.push(BrowserEntryProblem {
            origin: "exports.browser".into(),
            detail: "expected a list of entries.".into(),
            index: None,
        });
        return out;
    };
    let mut seen: HashSet<String> = HashSet::new();
    for (index, raw) in declared.iter().enumerate() {
        let at = format!("exports.browser[{index}]");
        let Some(entry) = raw.as_object() else {
            out.problems.push(BrowserEntryProblem { origin: at, detail: "expected an object.".into(), index: Some(index) });
            continue;
        };
        let named = non_blank(entry.get("specifier"));
        let origin = match named {
            Some(specifier) => format!("{at} ('{}')", specifier.trim()),
            None => at.clone(),
        };
        let mut refuse = |detail: String| {
            out.problems.push(BrowserEntryProblem { origin: origin.clone(), detail, index: Some(index) })
        };

        let platform: Vec<&str> = entry
            .keys()
            .map(String::as_str)
            .filter(|key| *key == "format" || (PlatformAxis::from_name(key).is_some() && *key != "abi"))
            .collect();
        if !platform.is_empty() {
            refuse(format!(
                "{} cannot be stated. A browser entry is an ES module served to a page: its format is always '{BROWSER_FORMAT}' and it is the same file on every platform. The only axis it states is 'abi'.",
                quoted(&platform)
            ));
            continue;
        }
        let unknown: Vec<&str> = entry.keys().map(String::as_str).filter(|key| !KNOWN_KEYS.contains(key)).collect();
        if !unknown.is_empty() {
            refuse(format!(
                "unknown {} {}. Known: {}.",
                if unknown.len() == 1 { "key" } else { "keys" },
                quoted(&unknown),
                KNOWN_KEYS.join(", ")
            ));
            continue;
        }
        let Some(specifier) = named.map(str::trim) else {
            refuse("'specifier' is required and must be a non-empty string.".into());
            continue;
        };
        let Some(path) = non_blank(entry.get("path")).map(str::trim) else {
            refuse("'path' is required and must be a non-empty string.".into());
            continue;
        };
        if entry.get("source").is_some() && non_blank(entry.get("source")).is_none() {
            refuse("'source' must be a non-empty string when present.".into());
            continue;
        }
        let source = non_blank(entry.get("source")).map(str::trim);
        let outside = outside_module("path", path).or_else(|| source.and_then(|source| outside_module("source", source)));
        if let Some(outside) = outside {
            refuse(outside);
            continue;
        }
        let abi = match entry.get("abi") {
            None => None,
            Some(raw) => match normalize_axis_value("abi", Some(raw), &origin) {
                Ok(abi) => Some(abi),
                Err(error) => {
                    // The reader words it without the origin the message is prefixed with.
                    refuse(error.detail[origin.len() + 2..].to_string());
                    continue;
                }
            },
        };
        let external = match string_list(entry, "external") {
            Ok(list) => list,
            Err(detail) => {
                refuse(detail);
                continue;
            }
        };
        let names = match string_list(entry, "exports") {
            Ok(list) => list,
            Err(detail) => {
                refuse(detail);
                continue;
            }
        };
        if seen.contains(specifier) {
            refuse(format!(
                "a second entry declares the specifier '{specifier}'. A specifier is one import-map key, so it names one entry."
            ));
            continue;
        }
        seen.insert(specifier.to_string());

        let mut external: Vec<String> = external.into_iter().collect::<std::collections::BTreeSet<_>>().into_iter().collect();
        external.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let mut exports: Vec<String> = Vec::new();
        for name in names {
            if !exports.contains(&name) {
                exports.push(name);
            }
        }
        let mut axes = AxisValues::default();
        axes.set(PlatformAxis::Abi, abi.clone());
        out.entries.push(BrowserEntry {
            specifier: specifier.to_string(),
            path: normalize_relative(path),
            local_path: source.map(normalize_relative),
            abi,
            external,
            exports,
            selector: ArtifactSelector { format: BROWSER_FORMAT.into(), axes },
            origin,
            index,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn read(entries: Value) -> BrowserEntries {
        read_browser_entries(&json!({ "exports": { "browser": entries } }))
    }

    #[test]
    fn reads_an_entry_with_its_abi_externals_and_exports() {
        let read = read(json!([{
            "specifier": "@acme/badges", "path": "./browser/b.js", "source": "./browser/src/b.tsx",
            "abi": "ui-1", "external": ["react", "react", "a"], "exports": ["Pill", "Pill"],
        }]));
        assert_eq!(read.problems, []);
        let entry = &read.entries[0];
        assert_eq!(entry.external, ["a", "react"]);
        assert_eq!(entry.exports, ["Pill"]);
        assert_eq!((entry.path.as_str(), entry.local_path.as_deref()), ("browser/b.js", Some("browser/src/b.tsx")));
        assert_eq!(entry.selector.axes.get(PlatformAxis::Abi), Some("ui-1"));
    }

    #[test]
    fn refuses_what_node_refuses() {
        let read = read(json!([
            { "specifier": "a", "path": "p", "os": "linux" },
            { "specifier": "b", "path": "../p" },
            { "specifier": "c", "path": "p", "abi": "1" },
            { "specifier": "d", "path": "p" },
            { "specifier": "d", "path": "q" },
            { "path": "p" },
        ]));
        let details: Vec<_> = read.problems.iter().map(|p| (p.origin.as_str(), p.detail.as_str())).collect();
        assert!(details[0].1.starts_with("'os' cannot be stated."));
        assert!(details[1].1.starts_with("'path' is '../p', which points above the module root."));
        assert_eq!(details[2].1, "abi value '1' must have the form <family>-<version>, e.g. 'node-137' or 'telo-3'.");
        assert_eq!(details[3].0, "exports.browser[4] ('d')");
        assert!(details[3].1.starts_with("a second entry declares the specifier 'd'."));
        assert_eq!(details[4], ("exports.browser[5]", "'specifier' is required and must be a non-empty string."));
        assert_eq!(read.entries.len(), 1);
    }
}

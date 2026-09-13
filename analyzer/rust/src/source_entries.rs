//! A module's **sources** — the `sources:` block on a `Telo.Library` or
//! `Telo.Application` doc, saying where every staged file comes from. Mirrors
//! `../../nodejs/src/source-entries.ts`, and is kept rule for rule with it: a
//! kernel refuses to read a staged file whenever the block has a problem, so a
//! rule one reader applies and the other does not is a file one kernel reads and
//! the other refuses.
//!
//! Two parts of the Node reader have no counterpart: `ignorePins` serves the one
//! writer of pins, `telo release stage --pin`, and `resolveSourceUrl` serves
//! fetching — this kernel does neither.

use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::native_entries::{normalize_native_path, PathVerdict};

const SOURCE_KEYS: [&str; 6] = ["version", "url", "archive", "notices", "entries", "build"];
const BUILD_KEYS: [&str; 2] = ["cargo", "inputs"];
const URL_PLACEHOLDERS: [&str; 2] = ["version", "upstream"];
const FILE_KEYS: [&str; 4] = ["upstream", "member", "sha256", "executable"];

/// The archive formats an upstream may be.
pub const SOURCE_ARCHIVE_FORMATS: [&str; 1] = ["tar.gz"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourcePin {
    /// Lowercase hex digest of the file's bytes.
    pub sha256: String,
    pub executable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SourceEntry {
    File {
        /// The key as written, for diagnostic paths.
        key: String,
        /// Module-root-relative POSIX path, normalized.
        path: String,
        upstream: String,
        /// Path of the file inside the archive.
        member: String,
        /// Absent until `telo release stage --pin` writes it.
        pin: Option<SourcePin>,
    },
    Link {
        key: String,
        path: String,
        /// The link target, exactly as the link stores it.
        target: String,
        /// The module-relative path the target resolves to.
        resolved: String,
    },
}

impl SourceEntry {
    pub fn key(&self) -> &str {
        match self {
            SourceEntry::File { key, .. } | SourceEntry::Link { key, .. } => key,
        }
    }

    pub fn path(&self) -> &str {
        match self {
            SourceEntry::File { path, .. } | SourceEntry::Link { path, .. } => path,
        }
    }
}

/// How a source's files are built in this repository, keyed by build system.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceBuild {
    /// Module-root-relative directory of the Cargo crate, normalized.
    pub cargo: String,
    pub inputs: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModuleSource {
    pub name: String,
    pub version: String,
    pub url: String,
    pub archive: String,
    pub notices: Vec<String>,
    pub entries: Vec<SourceEntry>,
    pub build: Option<SourceBuild>,
}

/// Why part of the block could not be read. `code` is the Node reader's:
/// `SHAPE`, or the diagnostic `telo check` reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceProblem {
    pub code: &'static str,
    pub path: String,
    pub message: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ModuleSources {
    pub sources: Vec<ModuleSource>,
    pub problems: Vec<SourceProblem>,
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_inputs_digest(value: &str) -> bool {
    value.strip_prefix("sha256-").is_some_and(|rest| {
        rest.len() == 43 && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

fn is_source_name(name: &str) -> bool {
    name.bytes().next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'.' | b'-'))
}

fn is_loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") || host == "[::1]" {
        return true;
    }
    let octets: Vec<&str> = host.split('.').collect();
    octets.len() == 4
        && octets[0] == "127"
        && octets
            .iter()
            .all(|o| !o.is_empty() && o.len() <= 3 && o.bytes().all(|b| b.is_ascii_digit()))
}

/// Why a url may not be fetched from, or `None` when it may: https, or plain
/// http to a loopback host.
pub fn source_url_problem(url: &str) -> Option<(&'static str, String)> {
    let Some((scheme, rest)) = url.split_once("://") else {
        return Some((
            "SOURCE_INVALID",
            format!("url '{url}' is not an absolute URL. Write an https:// URL template."),
        ));
    };
    let valid_scheme = scheme.bytes().next().is_some_and(|b| b.is_ascii_alphabetic())
        && scheme
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-'));
    if !valid_scheme {
        return Some((
            "SOURCE_INVALID",
            format!("url '{url}' is not an absolute URL. Write an https:// URL template."),
        ));
    }
    let scheme = scheme.to_ascii_lowercase();
    if scheme == "https" {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    let host = if host_port.starts_with('[') {
        host_port.find(']').map_or(host_port, |end| &host_port[..=end])
    } else {
        host_port.split(':').next().unwrap_or("")
    };
    if scheme == "http" && is_loopback_host(host) {
        return None;
    }
    Some((
        "SOURCE_URL_INSECURE",
        format!(
            "url '{url}' is fetched over {scheme}, where the archive could be altered on the way. \
             Use https; plain http is accepted only for a loopback host (localhost, 127.0.0.0/8, [::1])."
        ),
    ))
}

fn normalized(raw: &str) -> Option<String> {
    match normalize_native_path(raw) {
        PathVerdict::Path(path) => Some(path),
        _ => None,
    }
}

/// Resolve a link target against the link's own directory, confined to the module.
fn resolve_link_target(link_path: &str, target: &str) -> Option<String> {
    if target.starts_with('/') || target.starts_with('\\') {
        return None;
    }
    let dir = link_path.rfind('/').map_or("", |slash| &link_path[..slash]);
    if dir.is_empty() {
        normalized(target)
    } else {
        normalized(&format!("{dir}/{target}"))
    }
}

fn runs_through(path: &str, parent: &str) -> bool {
    path.len() > parent.len() && path.starts_with(parent) && path.as_bytes()[parent.len()] == b'/'
}

fn shape_ok(raw: &Map<String, Value>) -> bool {
    let build_ok = match raw.get("build") {
        None => true,
        Some(Value::Object(build)) => {
            build.get("cargo").is_some_and(Value::is_string)
                && build.get("inputs").map_or(true, Value::is_string)
                && build.keys().all(|key| BUILD_KEYS.contains(&key.as_str()))
        }
        Some(_) => false,
    };
    raw.get("version").is_some_and(Value::is_string)
        && raw.get("url").is_some_and(Value::is_string)
        && raw
            .get("archive")
            .and_then(Value::as_str)
            .is_some_and(|archive| SOURCE_ARCHIVE_FORMATS.contains(&archive))
        && raw
            .get("notices")
            .and_then(Value::as_array)
            .is_some_and(|notices| !notices.is_empty() && notices.iter().all(Value::is_string))
        && raw.get("entries").is_some_and(Value::is_object)
        && build_ok
        && raw.keys().all(|key| SOURCE_KEYS.contains(&key.as_str()))
}

/// Read the `sources:` block off an owner document. A source or entry with any
/// problem is left out, never read partially.
pub fn read_module_sources(owner: &Value) -> ModuleSources {
    let mut out = ModuleSources::default();
    let Some(declared) = owner.get("sources") else {
        return out;
    };
    let mut problem = |code: &'static str, path: String, message: String| {
        out.problems.push(SourceProblem { code, path, message })
    };
    let Some(declared) = declared.as_object() else {
        problem("SHAPE", "sources".into(), "sources: expected a map of source name to source.".into());
        return out;
    };

    let mut sources = Vec::new();
    let mut producers: Vec<(String, String, String)> = Vec::new();
    for (name, raw) in declared {
        let at = format!("sources.{name}");
        let label = format!("source '{name}'");
        let Some(raw) = raw.as_object() else {
            problem("SHAPE", at, format!("{label}: expected an object."));
            continue;
        };
        if !shape_ok(raw) {
            problem(
                "SHAPE",
                at,
                format!(
                    "{label}: a source is {{ version, url, archive ({}), notices (non-empty list), entries, build? {{ cargo, inputs? }} }} and nothing else.",
                    SOURCE_ARCHIVE_FORMATS.join(" | ")
                ),
            );
            continue;
        }

        let mut valid = true;
        if !is_source_name(name) {
            problem(
                "SOURCE_INVALID",
                at.clone(),
                format!(
                    "{label}: the name is not a canonical token. Use lowercase letters, digits, '.', '-' or '_', starting with a letter or digit."
                ),
            );
            valid = false;
        }
        let version = raw["version"].as_str().unwrap_or_default();
        let url = raw["url"].as_str().unwrap_or_default();
        for (key, value) in [("version", version), ("url", url)] {
            if value.trim().is_empty() {
                problem("SOURCE_INVALID", format!("{at}.{key}"), format!("{label}: '{key}' must not be empty."));
                valid = false;
            }
        }
        let mut rest = url;
        while let Some(open) = rest.find('{') {
            let after = &rest[open + 1..];
            let Some(close) = after.find('}') else { break };
            let placeholder = &after[..close];
            if placeholder.contains('{') {
                rest = &after[placeholder.rfind('{').unwrap_or(0)..];
                continue;
            }
            if !URL_PLACEHOLDERS.contains(&placeholder) {
                problem(
                    "SOURCE_URL_PLACEHOLDER_UNKNOWN",
                    format!("{at}.url"),
                    format!(
                        "{label}: the url placeholder '{{{placeholder}}}' is not recognized. A url template may use only {{version}} (the source's version) and {{upstream}} (each entry's upstream)."
                    ),
                );
                valid = false;
            }
            rest = &after[close + 1..];
        }
        if !url.trim().is_empty() {
            if let Some((code, detail)) = source_url_problem(url) {
                problem(code, format!("{at}.url"), format!("{label}: {detail}"));
                valid = false;
            }
        }
        let mut notices = Vec::new();
        for (index, notice) in raw["notices"].as_array().into_iter().flatten().enumerate() {
            match normalize_native_path(notice.as_str().unwrap_or_default().trim()) {
                PathVerdict::Path(path) => notices.push(path),
                PathVerdict::Invalid(detail) | PathVerdict::Escape(detail) => {
                    problem("SOURCE_INVALID", format!("{at}.notices[{index}]"), format!("{label}: notice {detail}"));
                    valid = false;
                }
            }
        }

        let mut build = None;
        if let Some(Value::Object(raw_build)) = raw.get("build") {
            let written = raw_build["cargo"].as_str().unwrap_or_default().trim();
            let inputs = raw_build.get("inputs").and_then(Value::as_str);
            let verdict = if matches!(written, "" | "." | "./" | "/") {
                PathVerdict::Path(String::new())
            } else {
                normalize_native_path(written)
            };
            match verdict {
                PathVerdict::Path(cargo) => {
                    if inputs.is_some_and(|inputs| !is_inputs_digest(inputs)) {
                        problem(
                            "SOURCE_INVALID",
                            format!("{at}.build.inputs"),
                            format!(
                                "{label}: build.inputs must be a digest of the form sha256-<43 base64url characters> — run `telo release stage --pin` to write it."
                            ),
                        );
                        valid = false;
                    } else {
                        build = Some(SourceBuild { cargo, inputs: inputs.map(str::to_string) });
                    }
                }
                PathVerdict::Escape(_) => {
                    problem(
                        "SOURCE_INVALID",
                        format!("{at}.build.cargo"),
                        format!(
                            "{label}: build.cargo '{written}' is not a directory inside the module. Name the crate relative to the directory holding telo.yaml; code outside the module reaches its digest as a path dependency of that crate."
                        ),
                    );
                    valid = false;
                }
                PathVerdict::Invalid(_) => {
                    problem(
                        "SOURCE_INVALID",
                        format!("{at}.build.cargo"),
                        format!("{label}: build.cargo '{written}' does not name one module-relative directory."),
                    );
                    valid = false;
                }
            }
        }

        let raw_entries = raw["entries"].as_object().cloned().unwrap_or_default();
        let mut entry_paths: HashMap<String, String> = HashMap::new();
        let mut path_of_key: HashMap<String, String> = HashMap::new();
        for key in raw_entries.keys() {
            let entry_at = format!("{at}.entries.{key}");
            match normalize_native_path(key.trim()) {
                PathVerdict::Path(path) => {
                    if let Some(other) = entry_paths.get(&path) {
                        problem(
                            "SOURCE_ENTRY_DUPLICATE",
                            entry_at,
                            format!("{label} entry '{key}': path '{path}' is also produced by entry '{other}'."),
                        );
                        valid = false;
                        continue;
                    }
                    entry_paths.insert(path.clone(), key.clone());
                    path_of_key.insert(key.clone(), path);
                }
                PathVerdict::Invalid(detail) | PathVerdict::Escape(detail) => {
                    problem("SOURCE_ENTRY_INVALID", entry_at, format!("{label} entry '{key}': {detail}"));
                    valid = false;
                }
            }
        }

        let mut entries = Vec::new();
        let mut links: Vec<(String, String, String)> = Vec::new();
        for (key, value) in &raw_entries {
            let Some(path) = path_of_key.get(key).cloned() else { continue };
            let entry_at = format!("{at}.entries.{key}");
            let entry_label = format!("{label} entry '{key}'");
            let Some(value) = value.as_object() else {
                problem("SHAPE", entry_at, format!("{entry_label}: expected an object."));
                valid = false;
                continue;
            };
            let file_keys: Vec<&str> = FILE_KEYS.iter().copied().filter(|k| value.contains_key(*k)).collect();
            let is_link = value.contains_key("target");
            if is_link && !file_keys.is_empty() {
                let listed: Vec<String> = file_keys.iter().map(|k| format!("'{k}'")).collect();
                problem(
                    "SOURCE_ENTRY_INVALID",
                    entry_at,
                    format!(
                        "{entry_label}: an entry is either a link (target) or a file (upstream, member, sha256, executable) — remove {} or 'target'.",
                        listed.join(", ")
                    ),
                );
                valid = false;
                continue;
            }
            let strings: &[&str] = if is_link { &["target"] } else { &["upstream", "member"] };
            if strings.iter().any(|k| !value.get(*k).is_some_and(Value::is_string))
                || value.get("sha256").is_some_and(|v| !v.is_string())
                || value.get("executable").is_some_and(|v| !v.is_boolean())
            {
                problem("SHAPE", entry_at, format!("{entry_label}: expected a file or a link entry."));
                valid = false;
                continue;
            }
            let blank: Vec<&str> = strings
                .iter()
                .copied()
                .filter(|k| value[*k].as_str().unwrap_or_default().trim().is_empty())
                .collect();
            if !blank.is_empty() {
                for k in blank {
                    problem("SOURCE_ENTRY_INVALID", format!("{entry_at}.{k}"), format!("{entry_label}: '{k}' must not be empty."));
                }
                valid = false;
                continue;
            }
            if is_link {
                links.push((key.clone(), path, value["target"].as_str().unwrap_or_default().to_string()));
                continue;
            }
            let sha256 = value.get("sha256").and_then(Value::as_str);
            let executable = value.get("executable").and_then(Value::as_bool);
            if sha256.is_some_and(|sha| !is_sha256_hex(sha)) {
                problem(
                    "SOURCE_ENTRY_INVALID",
                    format!("{entry_at}.sha256"),
                    format!("{entry_label}: sha256 must be 64 lowercase hex characters — run `telo release stage --pin` to write it."),
                );
                valid = false;
                continue;
            }
            if sha256.is_some() != executable.is_some() {
                problem(
                    "SOURCE_ENTRY_INVALID",
                    entry_at,
                    format!("{entry_label}: a pin is sha256 and executable together — run `telo release stage --pin` to write both."),
                );
                valid = false;
                continue;
            }
            entries.push(SourceEntry::File {
                key: key.clone(),
                path,
                upstream: value["upstream"].as_str().unwrap_or_default().to_string(),
                member: value["member"].as_str().unwrap_or_default().to_string(),
                pin: sha256.zip(executable).map(|(sha256, executable)| SourcePin {
                    sha256: sha256.to_string(),
                    executable,
                }),
            });
        }

        let mut link_targets: HashMap<String, String> = HashMap::new();
        for (key, path, target) in &links {
            let target_at = format!("{at}.entries.{key}.target");
            let resolved = resolve_link_target(path, target);
            if resolved.as_deref() == Some(path.as_str()) {
                problem(
                    "SOURCE_LINK_CYCLE",
                    target_at,
                    format!("{label} entry '{key}': link target '{target}' resolves to the link itself."),
                );
                valid = false;
                continue;
            }
            let Some(resolved) = resolved.filter(|resolved| entry_paths.contains_key(resolved)) else {
                let described = resolve_link_target(path, target)
                    .map_or("a path outside the module".to_string(), |r| format!("'{r}'"));
                problem(
                    "SOURCE_LINK_TARGET_UNRESOLVED",
                    target_at,
                    format!(
                        "{label} entry '{key}': link target '{target}' resolves, relative to the link's directory, to {described}, which is not another entry of this source."
                    ),
                );
                valid = false;
                continue;
            };
            link_targets.insert(path.clone(), resolved.clone());
            entries.push(SourceEntry::Link {
                key: key.clone(),
                path: path.clone(),
                target: target.clone(),
                resolved,
            });
        }
        for (key, path, _) in &links {
            let Some(first) = link_targets.get(path) else { continue };
            let mut chain = vec![path.clone()];
            let mut next = Some(first.clone());
            while let Some(current) = next {
                if chain.contains(&current) {
                    let rendered: Vec<String> = chain.iter().map(|p| format!("'{p}'")).collect();
                    problem(
                        "SOURCE_LINK_CYCLE",
                        format!("{at}.entries.{key}.target"),
                        format!(
                            "{label} entry '{key}': the link never reaches a file — it cycles through {} → '{current}'. A link chain must end at a file entry.",
                            rendered.join(" → ")
                        ),
                    );
                    valid = false;
                    break;
                }
                next = link_targets.get(&current).cloned();
                chain.push(current);
            }
        }

        for entry in &entries {
            let entry_at = format!("{at}.entries.{}", entry.key());
            if let Some((_, other_source, _)) = producers.iter().find(|(path, _, _)| path == entry.path()) {
                problem(
                    "SOURCE_ENTRY_DUPLICATE",
                    entry_at,
                    format!(
                        "{label} entry '{}': path '{}' is also produced by source '{other_source}'. Each staged file has exactly one source.",
                        entry.key(),
                        entry.path()
                    ),
                );
                valid = false;
                continue;
            }
            let nested = producers.iter().find_map(|(path, source, key)| {
                if runs_through(entry.path(), path) {
                    Some((format!("runs through '{path}' as a directory"), path, source, key))
                } else if runs_through(path, entry.path()) {
                    Some((format!("is a directory that '{path}' runs through"), path, source, key))
                } else {
                    None
                }
            });
            if let Some((relation, path, source, key)) = nested {
                problem(
                    "SOURCE_ENTRY_NESTED",
                    entry_at,
                    format!(
                        "{label} entry '{}': path '{}' {relation}, and source '{source}' entry '{key}' produces '{path}'. A staged path cannot be both a file and a directory — give each entry its own path.",
                        entry.key(),
                        entry.path()
                    ),
                );
                valid = false;
                continue;
            }
            producers.push((entry.path().to_string(), name.clone(), entry.key().to_string()));
        }

        if !valid {
            continue;
        }
        sources.push(ModuleSource {
            name: name.clone(),
            version: version.to_string(),
            url: url.to_string(),
            archive: raw["archive"].as_str().unwrap_or_default().to_string(),
            notices,
            entries,
            build,
        });
    }
    drop(problem);
    out.sources = sources;
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn owner(url: &str, entries: Value) -> Value {
        json!({ "sources": { "addon": {
            "version": "1.0.0", "url": url, "archive": "tar.gz", "notices": ["./LICENSE"], "entries": entries,
        } } })
    }

    fn codes(owner: &Value) -> Vec<&'static str> {
        read_module_sources(owner).problems.iter().map(|p| p.code).collect()
    }

    #[test]
    fn reads_a_valid_block() {
        let read = read_module_sources(&owner(
            "https://example.test/{version}/{upstream}.tar.gz",
            json!({
                "./native/libx.so.1": { "upstream": "x", "member": "libx.so.1", "sha256": SHA, "executable": false },
                "./native/libx.so": { "target": "libx.so.1" },
            }),
        ));
        assert_eq!(read.problems, []);
        let entries = &read.sources[0].entries;
        assert!(entries.iter().any(|e| matches!(e, SourceEntry::Link { resolved, .. } if resolved == "native/libx.so.1")));
    }

    #[test]
    fn reports_what_the_node_reader_reports() {
        let file = json!({ "upstream": "x", "member": "m", "sha256": SHA, "executable": false });
        assert_eq!(codes(&owner("http://example.test/x.tgz", json!({ "a": file }))), ["SOURCE_URL_INSECURE"]);
        assert_eq!(codes(&owner("http://127.0.0.1:8080/x.tgz", json!({ "a": file }))), Vec::<&str>::new());
        assert_eq!(codes(&owner("https://e.test/{os}.tgz", json!({ "a": file }))), ["SOURCE_URL_PLACEHOLDER_UNKNOWN"]);
        assert_eq!(
            codes(&owner("https://e.test/x.tgz", json!({ "a": { "target": "b" }, "b": { "target": "a" } }))),
            ["SOURCE_LINK_CYCLE", "SOURCE_LINK_CYCLE"]
        );
        assert_eq!(codes(&owner("https://e.test/x.tgz", json!({ "a": file, "a/b": file }))), ["SOURCE_ENTRY_NESTED"]);
        assert_eq!(
            codes(&owner("https://e.test/x.tgz", json!({ "a": { "upstream": "x", "member": "m", "sha256": "ABC", "executable": false } }))),
            ["SOURCE_ENTRY_INVALID"]
        );
        assert_eq!(codes(&json!({ "sources": { "addon": { "version": "1", "url": "https://e.test", "notices": ["L"], "entries": {} } } })), ["SHAPE"]);
    }
}

//! The entry rules extraction relies on to keep a layer inside the module
//! directory. Mirrors `../../../nodejs/src/bundle/layer-entry-rules.ts`.
//!
//! The Node rule also takes the module's paths in OTHER layers, to tell a target
//! shipped elsewhere from one that names nothing; that knowledge is a
//! publisher's, and extraction never has it.

use std::collections::{HashMap, HashSet};

use crate::bundle::files_integrity::PayloadFile;

/// An entry of one layer breaking the layer's entry rules, and why. `target` is
/// set when the entry is a link and the violation is about where it points.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LayerViolation {
    pub path: String,
    pub target: Option<String>,
    pub reason: String,
}

/// Every entry of one layer breaking the rules extraction relies on to stay
/// inside the module directory (spec §5): unique paths inside the module
/// directory, no entry running through another as a directory, and the link
/// rule — a link names, within the module directory, another entry of the same
/// layer, a chain of links ending at a file.
pub fn find_layer_violations(files: &[PayloadFile]) -> Vec<LayerViolation> {
    let mut violations = Vec::new();
    let mut order: Vec<(String, &PayloadFile)> = Vec::new();
    let mut by_path: HashMap<String, &PayloadFile> = HashMap::new();
    for file in files {
        match entry_path(file.name()) {
            None => violations.push(violation(file.name(), None, "escapes the module directory")),
            Some(key) => match by_path.get(&key) {
                Some(existing) => violations.push(violation(
                    file.name(),
                    None,
                    &format!("is the same path as '{}'", existing.name()),
                )),
                None => {
                    by_path.insert(key.clone(), file);
                    order.push((key, file));
                }
            },
        }
    }
    for (key, file) in &order {
        let segments: Vec<&str> = key.split('/').collect();
        for depth in 1..segments.len() {
            if let Some(parent) = by_path.get(&segments[..depth].join("/")) {
                violations.push(violation(
                    file.name(),
                    None,
                    &format!(
                        "runs through '{}', another entry of the layer, as a directory",
                        parent.name()
                    ),
                ));
                break;
            }
        }
    }
    for (_, file) in &order {
        if let PayloadFile::Link { name, link } = file {
            if let Some(reason) = link_problem(name, link, &by_path) {
                violations.push(violation(name, Some(link), &reason));
            }
        }
    }
    violations
}

fn violation(path: &str, target: Option<&str>, reason: &str) -> LayerViolation {
    LayerViolation {
        path: path.to_string(),
        target: target.map(str::to_string),
        reason: reason.to_string(),
    }
}

/// One line per violation, for a refusal message.
pub fn describe_layer_violations(violations: &[LayerViolation]) -> String {
    violations
        .iter()
        .map(|v| match &v.target {
            None => format!("  '{}': {}", v.path, v.reason),
            Some(target) => format!("  '{}' → '{target}': {}", v.path, v.reason),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// An entry's normalized module-relative path, or `None` when it is absolute or
/// climbs out of the module directory.
fn entry_path(name: &str) -> Option<String> {
    if name.starts_with('/') {
        return None;
    }
    let normalized = posix_normalize(name);
    let normalized = normalized.trim_end_matches('/');
    if normalized == "." || normalized == ".." || normalized.starts_with("../") {
        return None;
    }
    Some(normalized.to_string())
}

fn link_problem(start: &str, link: &str, by_path: &HashMap<String, &PayloadFile>) -> Option<String> {
    let mut visited: HashSet<&str> = HashSet::from([start]);
    let (mut name, mut target) = (start, link);
    loop {
        let via = if name == start {
            String::new()
        } else {
            format!("through '{name}', ")
        };
        if target.is_empty() {
            return Some(format!("{via}has no target"));
        }
        if target.starts_with('/') {
            return Some(format!("{via}is absolute, so it escapes the module directory"));
        }
        let Some(resolved) = resolve_link_target(name, target) else {
            return Some(format!("{via}escapes the module directory"));
        };
        let Some(entry) = by_path.get(&resolved) else {
            return Some(format!(
                "{via}names '{resolved}', which no file of the layer has (the link dangles)"
            ));
        };
        let PayloadFile::Link {
            name: next_name,
            link: next_link,
        } = entry
        else {
            return None;
        };
        if !visited.insert(next_name) {
            return Some(format!("forms a cycle through '{name}'"));
        }
        (name, target) = (next_name, next_link);
    }
}

/// The module-relative path a relative link names, or `None` when it climbs out
/// of the module directory.
fn resolve_link_target(name: &str, link: &str) -> Option<String> {
    let trimmed = name.trim_end_matches('/');
    let name = if trimmed.is_empty() { name } else { trimmed };
    let dir = match name.rfind('/') {
        Some(0) => "/",
        Some(slash) => &name[..slash],
        None => ".",
    };
    let resolved = posix_normalize(&format!("{dir}/{link}"));
    if resolved == ".." || resolved.starts_with("../") {
        return None;
    }
    Some(resolved)
}

/// Node's `path.posix.normalize`: collapse separators, `.` and `..` segments,
/// keeping a trailing separator and a leading `..` of a relative path.
fn posix_normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let absolute = path.starts_with('/');
    let mut segments: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => match segments.last() {
                Some(&last) if last != ".." => {
                    segments.pop();
                }
                _ if absolute => {}
                _ => segments.push(".."),
            },
            other => segments.push(other),
        }
    }
    let mut out = segments.join("/");
    if absolute {
        out.insert(0, '/');
    }
    if out.is_empty() {
        out.push('.');
    }
    if path.ends_with('/') && !out.ends_with('/') {
        out.push('/');
    }
    out
}

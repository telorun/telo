//! The external packages a crate links into the artifact it builds, as the
//! text its layer holds at `Cargo.lock`: one `name version source` line per
//! package outside the workspace (a package with no source, two fields),
//! sorted, each ending in a newline. Only a crate with a linked-artifact target
//! (`bin`, `cdylib`, `staticlib`, `dylib`) has one, so a lockfile-only bump of
//! a dependency releases the binaries that link it and never a library.
//!
//! The closure follows normal and build edges, transitively, never dev ones;
//! it walks through workspace members, which are units of their own and are
//! never lines. It is read either from the tree (`cargo metadata` over every
//! feature and platform) or from a published `.crate` (its `Cargo.lock`, the
//! root's own edges taken from its packaged `Cargo.toml`); both give the same
//! text.

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

use indexmap::IndexMap;
use serde_json::Value;

use super::cargo::{dotted_key, quoted_value};
use crate::ReleaseError;

/// Target kinds whose artifact links its dependencies in.
pub const LINKED_ARTIFACT_KINDS: [&str; 4] = ["bin", "cdylib", "staticlib", "dylib"];

/// Whether a crate's `cargo metadata` targets (each `{ kind: [..] }`) include a
/// linked artifact.
pub fn links_artifact(targets: &Value) -> bool {
    targets.as_array().into_iter().flatten().any(|target| {
        target
            .get("kind")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .any(|kind| LINKED_ARTIFACT_KINDS.contains(&kind))
    })
}

fn canonical(lines: impl IntoIterator<Item = String>) -> String {
    lines.into_iter().collect::<BTreeSet<_>>().into_iter().map(|line| format!("{line}\n")).collect()
}

fn line(name: &str, version: &str, source: Option<&str>) -> String {
    match source {
        Some(source) if !source.is_empty() => format!("{name} {version} {source}"),
        _ => format!("{name} {version}"),
    }
}

/// The closure of the package `root_id` in a `cargo metadata` answer read with
/// its resolve (no `--no-deps`).
pub fn closure_from_metadata(metadata: &Value, root_id: &str) -> Result<String, ReleaseError> {
    let Some(nodes) = metadata.get("resolve").and_then(|resolve| resolve.get("nodes")).and_then(Value::as_array) else {
        return Err(ReleaseError::new(format!("cargo metadata carries no resolve, so the closure of '{root_id}' cannot be read.")));
    };
    let id_of = |value: &Value| value.get("id").and_then(Value::as_str).map(str::to_string);
    let packages: HashMap<String, &Value> =
        metadata.get("packages").and_then(Value::as_array).into_iter().flatten().filter_map(|pkg| Some((id_of(pkg)?, pkg))).collect();
    let nodes: HashMap<String, &Value> = nodes.iter().filter_map(|node| Some((id_of(node)?, node))).collect();
    let members: HashSet<&str> =
        metadata.get("workspace_members").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    if !nodes.contains_key(root_id) {
        return Err(ReleaseError::new(format!("cargo metadata resolves no package '{root_id}'.")));
    }

    let mut seen: HashSet<String> = HashSet::from([root_id.to_string()]);
    let mut queue: VecDeque<String> = VecDeque::from([root_id.to_string()]);
    let mut lines = Vec::new();
    while let Some(id) = queue.pop_front() {
        if !members.contains(id.as_str()) {
            let Some(pkg) = packages.get(&id) else {
                return Err(ReleaseError::new(format!("cargo metadata resolves '{id}' but lists no such package.")));
            };
            let field = |key: &str| pkg.get(key).and_then(Value::as_str).unwrap_or("");
            lines.push(line(field("name"), field("version"), pkg.get("source").and_then(Value::as_str)));
        }
        let Some(node) = nodes.get(&id) else {
            return Err(ReleaseError::new(format!("cargo metadata lists '{id}' with no resolve node.")));
        };
        for dep in node.get("deps").and_then(Value::as_array).into_iter().flatten() {
            let linked = dep
                .get("dep_kinds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .any(|kind| matches!(kind.get("kind"), Some(Value::Null)) || kind.get("kind").and_then(Value::as_str) == Some("build"));
            let Some(target) = dep.get("pkg").and_then(Value::as_str) else { continue };
            if !linked || seen.contains(target) {
                continue;
            }
            seen.insert(target.to_string());
            queue.push_back(target.to_string());
        }
    }
    Ok(canonical(lines))
}

struct LockPackage {
    name: String,
    version: String,
    source: Option<String>,
    dependencies: Vec<String>,
}

/// Every `"…"` in `text`, in order.
fn quoted_strings(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find('"') {
        let after = &rest[open + 1..];
        let Some(close) = after.find('"') else { break };
        out.push(after[..close].to_string());
        rest = &after[close + 1..];
    }
    out
}

/// `^([A-Za-z0-9_-]+)[ \t]*=[ \t]*(.*)$`: a bare key and its value.
fn bare_entry(text: &str) -> Option<(&str, &str)> {
    let end = text.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-')).unwrap_or(text.len());
    if end == 0 {
        return None;
    }
    let value = text[end..].trim_start_matches([' ', '\t']).strip_prefix('=')?;
    Some((&text[..end], value.trim_start_matches([' ', '\t'])))
}

/// The basic string a TOML value starts with.
fn leading_string(value: &str) -> Option<String> {
    let body = value.trim_start_matches([' ', '\t']).strip_prefix('"')?;
    body.find('"').map(|close| body[..close].to_string())
}

/// The `[[package]]` entries of a `Cargo.lock` in the layout cargo writes.
fn lock_packages(text: &str, at: &str) -> Result<Vec<LockPackage>, ReleaseError> {
    #[derive(Default)]
    struct Open {
        name: Option<String>,
        version: Option<String>,
        source: Option<String>,
        dependencies: Vec<String>,
    }
    let mut out = Vec::new();
    let mut current: Option<Open> = None;
    let mut in_dependencies = false;
    let close = |current: &mut Option<Open>, out: &mut Vec<LockPackage>| -> Result<(), ReleaseError> {
        let Some(open) = current.take() else { return Ok(()) };
        let (Some(name), Some(version)) = (open.name, open.version) else {
            return Err(ReleaseError::new(format!("{at}: a [[package]] entry records no name or version.")));
        };
        out.push(LockPackage { name, version, source: open.source, dependencies: open.dependencies });
        Ok(())
    };
    for raw in text.split('\n') {
        let text = raw.strip_suffix('\r').unwrap_or(raw).trim();
        if in_dependencies {
            if let Some(open) = current.as_mut() {
                open.dependencies.extend(quoted_strings(text));
            }
            if text.contains(']') {
                in_dependencies = false;
            }
            continue;
        }
        if text.starts_with('[') {
            close(&mut current, &mut out)?;
            if text == "[[package]]" {
                current = Some(Open::default());
            }
            continue;
        }
        let Some(open) = current.as_mut() else { continue };
        let Some((key, value)) = bare_entry(text) else { continue };
        if key == "dependencies" {
            let body = value.strip_prefix('[').unwrap_or(value);
            open.dependencies.extend(quoted_strings(body));
            in_dependencies = !body.contains(']');
            continue;
        }
        let Some(quoted) = value.strip_prefix('"').and_then(|body| body.find('"').map(|close| body[..close].to_string())) else { continue };
        match key {
            "name" => open.name = Some(quoted),
            "version" => open.version = Some(quoted),
            "source" => open.source = Some(quoted),
            _ => {}
        }
    }
    close(&mut current, &mut out)?;
    Ok(out)
}

/// `^(\S+)(?: (\S+))?(?: \((.*)\))?$`: a lock dependency's name, version and
/// source.
fn parse_reference(reference: &str) -> Option<(&str, Option<&str>, Option<&str>)> {
    let reference = reference.trim();
    let name_end = reference.find(char::is_whitespace).unwrap_or(reference.len());
    let name = &reference[..name_end];
    if name.is_empty() {
        return None;
    }
    let after_name = &reference[name_end..];
    if after_name.is_empty() {
        return Some((name, None, None));
    }
    let rest = after_name.strip_prefix(' ')?;
    let token_end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let (token, after) = rest.split_at(token_end);
    if !token.is_empty() {
        if after.is_empty() {
            return Some((name, Some(token), None));
        }
        if let Some(source) = after.strip_prefix(" (").and_then(|s| s.strip_suffix(')')) {
            return Some((name, Some(token), Some(source)));
        }
    }
    rest.strip_prefix('(').and_then(|s| s.strip_suffix(')')).map(|source| (name, None, Some(source)))
}

/// The package a lock dependency names: `name`, `name version` or
/// `name version (source)`.
fn lock_target(packages: &[LockPackage], reference: &str, at: &str) -> Result<usize, ReleaseError> {
    let Some((name, version, source)) = parse_reference(reference) else {
        return Err(ReleaseError::new(format!("{at}: '{reference}' names no package.")));
    };
    let found: Vec<usize> = packages
        .iter()
        .enumerate()
        .filter(|(_, pkg)| {
            pkg.name == name && version.is_none_or(|v| pkg.version == v) && source.is_none_or(|s| pkg.source.as_deref() == Some(s))
        })
        .map(|(index, _)| index)
        .collect();
    if found.len() != 1 {
        let count = if found.is_empty() { "no package".to_string() } else { format!("{} packages", found.len()) };
        return Err(ReleaseError::new(format!("{at}: '{reference}' names {count} in the lockfile.")));
    }
    Ok(found[0])
}

const LINKED_DEPENDENCY_TABLES: [&str; 2] = ["dependencies", "build-dependencies"];

/// `^[ \t]*(\[\[?)([^[\]]+)\]\]?[ \t]*(#.*)?$`: whether the header is an array
/// of tables, and its key.
fn table_header(line: &str) -> Option<(bool, &str)> {
    let text = line.trim_start_matches([' ', '\t']);
    let (double, body) = match text.strip_prefix("[[") {
        Some(body) => (true, body),
        None => (false, text.strip_prefix('[')?),
    };
    let close = body.find(']')?;
    let key = &body[..close];
    if key.is_empty() || key.contains('[') {
        return None;
    }
    let after = &body[close + 1..];
    let after = after.strip_prefix(']').unwrap_or(after).trim_start_matches([' ', '\t']);
    (after.is_empty() || after.starts_with('#')).then_some((double, key))
}

/// One part of a dotted key — `"…"`, `'…'` or a bare run — and its length.
fn key_part(text: &str) -> Option<usize> {
    for quote in ['"', '\''] {
        if let Some(body) = text.strip_prefix(quote) {
            return body.find(quote).map(|close| close + 2);
        }
    }
    let end = text.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-')).unwrap_or(text.len());
    (end > 0).then_some(end)
}

/// A `key = value` line, the key possibly dotted: the key's text and the value.
fn key_entry(line: &str) -> Option<(&str, &str)> {
    let text = line.trim_start_matches([' ', '\t']);
    let mut end = key_part(text)?;
    loop {
        let rest = text[end..].trim_start_matches([' ', '\t']);
        let Some(next) = rest.strip_prefix('.') else { break };
        let next = next.trim_start_matches([' ', '\t']);
        let part = key_part(next)?;
        end = text.len() - next.len() + part;
    }
    let value = text[end..].trim_start_matches([' ', '\t']).strip_prefix('=')?;
    Some((&text[..end], value))
}

/// The package names a `Cargo.toml` depends on for normal and build use,
/// target-specific tables included, a renamed dependency by its `package`.
fn linked_dependency_names(text: &str) -> HashSet<String> {
    struct Table {
        scope: String,
        key: String,
        package: Option<String>,
    }
    let mut packages: IndexMap<String, String> = IndexMap::new();
    let mut inline: Option<String> = None;
    let mut table: Option<Table> = None;
    let close_table = |table: &mut Option<Table>, packages: &mut IndexMap<String, String>| {
        if let Some(open) = table.take() {
            let package = open.package.unwrap_or_else(|| open.key.clone());
            packages.insert(format!("{}\0{}", open.scope, open.key), package);
        }
    };
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some((double, header)) = table_header(line) {
            close_table(&mut table, &mut packages);
            inline = None;
            if double {
                continue;
            }
            let segments = dotted_key(header);
            let at = if segments.first().map(String::as_str) == Some("target") { 2 } else { 0 };
            let linked = segments.get(at).is_some_and(|segment| LINKED_DEPENDENCY_TABLES.contains(&segment.as_str()));
            let scope = segments.iter().take(at + 1).cloned().collect::<Vec<_>>().join("\0");
            if linked && segments.len() == at + 1 {
                inline = Some(scope);
            } else if linked && segments.len() == at + 2 {
                table = Some(Table { scope, key: segments[at + 1].clone(), package: None });
            }
            continue;
        }
        let Some((key, value)) = key_entry(line) else { continue };
        let key = dotted_key(key);
        if let Some(open) = table.as_mut() {
            if key.len() == 1 && key[0] == "package" {
                open.package = leading_string(value);
            }
            continue;
        }
        let Some(scope) = inline.as_ref() else { continue };
        let renamed = match key.len() {
            1 => quoted_value(value, "package").map(|(found, _, _)| found),
            2 if key[1] == "package" => leading_string(value),
            _ => None,
        };
        let id = format!("{scope}\0{}", key[0]);
        let package = renamed.or_else(|| packages.get(&id).cloned()).unwrap_or_else(|| key[0].clone());
        packages.insert(id, package);
    }
    close_table(&mut table, &mut packages);
    packages.into_values().collect()
}

/// The closure of the crate `root` (`name`, `version`) read from a published
/// `.crate`: its `Cargo.lock`, and its packaged `Cargo.toml` for the root's own
/// non-dev edges, which the lockfile does not tell from dev ones. `members`
/// are the workspace's member names, never lines.
pub fn closure_from_lock(
    lock_text: &str,
    manifest_text: &str,
    root: (&str, &str),
    members: &[String],
    at: &str,
) -> Result<String, ReleaseError> {
    let packages = lock_packages(lock_text, at)?;
    let roots: Vec<usize> = packages
        .iter()
        .enumerate()
        .filter(|(_, pkg)| pkg.name == root.0 && pkg.version == root.1 && pkg.source.is_none())
        .map(|(index, _)| index)
        .collect();
    if roots.len() != 1 {
        return Err(ReleaseError::new(format!("{at}: the lockfile records no single '{} {}' path package.", root.0, root.1)));
    }
    let linked = linked_dependency_names(manifest_text);
    let excluded: HashSet<&str> = members.iter().map(String::as_str).collect();
    let mut seen: HashSet<usize> = HashSet::from([roots[0]]);
    let mut queue: VecDeque<usize> = VecDeque::new();
    for reference in &packages[roots[0]].dependencies {
        let target = lock_target(&packages, reference, at)?;
        if linked.contains(&packages[target].name) {
            queue.push_back(target);
        }
    }
    seen.extend(queue.iter().copied());
    let mut lines = Vec::new();
    while let Some(index) = queue.pop_front() {
        let pkg = &packages[index];
        if !excluded.contains(pkg.name.as_str()) {
            lines.push(line(&pkg.name, &pkg.version, pkg.source.as_deref()));
        }
        for reference in &pkg.dependencies {
            let target = lock_target(&packages, reference, at)?;
            if seen.insert(target) {
                queue.push_back(target);
            }
        }
    }
    Ok(canonical(lines))
}

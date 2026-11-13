//! The `cargo` ecosystem's pure half: an anchor holding a `Cargo.toml` with a
//! `[package]` table is one crate — never the crates beneath it. Its version is
//! `[package].version`, and the `Cargo.lock` recording the crate moves with it.

use std::sync::{Arc, LazyLock};

use crate::adapter::{AnchorProbe, Companion, EcosystemAdapter, RecognizedPackage, VersionFileHandler, VersionLocationSpec};
use crate::version_files::{lines, splice_text, toml_string};
use crate::ReleaseError;

pub const CARGO_TOML: &str = "Cargo.toml";
pub const CARGO_LOCK: &str = "Cargo.lock";

/// `[package].name` of a `Cargo.toml`, or `None` when it declares no package.
pub fn read_crate_name(text: &str) -> Option<String> {
    toml_string(text, &["package".into(), "name".into()], CARGO_TOML).ok().flatten().map(|found| found.value)
}

fn leading_ws(line: &str) -> &str {
    line.trim_start_matches([' ', '\t'])
}

/// `^[ \t]*<key>[ \t]*=` at a line: the rest after `=`.
fn assignment<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let rest = leading_ws(line).strip_prefix(key)?;
    leading_ws(rest).strip_prefix('=')
}

/// `^([ \t]*<key>[ \t]*=[ \t]*)("…"|'…')[ \t]*$` with a lazy body: the
/// quoted value and its byte span within the line.
fn quoted_assignment(line: &str, key: &str, single_too: bool) -> Option<(usize, usize, String)> {
    let after_eq = assignment(line, key)?;
    let value = leading_ws(after_eq);
    let quote = value.chars().next().filter(|c| *c == '"' || (single_too && *c == '\''))?;
    let trimmed = value.trim_end_matches([' ', '\t']);
    if trimmed.len() < 2 || !trimmed.ends_with(quote) {
        return None;
    }
    let start = line.len() - value.len();
    Some((start, start + trimmed.len(), trimmed[1..trimmed.len() - 1].to_string()))
}

/// The body of the table whose header line `is_header` accepts: from the end
/// of that header line to the next line starting `[`.
fn table_bodies(text: &str, is_header: impl Fn(&str) -> bool) -> Vec<(usize, usize)> {
    let all = lines(text);
    let mut bodies = Vec::new();
    for (i, (start, line)) in all.iter().enumerate() {
        if !is_header(line) {
            continue;
        }
        let body_start = start + line.len();
        let body_end = all[i + 1..]
            .iter()
            .find(|(_, next)| leading_ws(next).starts_with('['))
            .map(|(next_start, _)| *next_start)
            .unwrap_or(text.len());
        bodies.push((body_start, body_end.max(body_start)));
    }
    bodies
}

fn body_lines(text: &str, (start, end): (usize, usize)) -> Vec<(usize, &str)> {
    lines(&text[start..end]).into_iter().map(|(at, line)| (start + at, line)).collect()
}

/// `version` in a `Cargo.toml`'s `[package]` table, rewritten in place.
pub fn stamp_crate_version(text: &str, version: &str, at: &str) -> Result<Option<String>, ReleaseError> {
    let is_package = |line: &str| leading_ws(line).strip_prefix("[package]").is_some_and(|rest| leading_ws(rest).is_empty());
    let Some(body) = table_bodies(text, is_package).into_iter().next() else { return Ok(None) };
    let lines = body_lines(text, body);
    for (offset, line) in &lines {
        if let Some((start, end, _)) = quoted_assignment(line, "version", true) {
            let quote = &line[start..start + 1];
            return Ok(Some(splice_text(text, offset + start, offset + end, &format!("{quote}{version}{quote}"))));
        }
    }
    let workspace = lines.iter().any(|(_, line)| {
        leading_ws(line).strip_prefix("version").is_some_and(|rest| {
            leading_ws(rest).strip_prefix('.').is_some_and(|rest| leading_ws(rest).strip_prefix("workspace").is_some_and(|r| leading_ws(r).starts_with('=')))
        })
    });
    if workspace {
        return Ok(None);
    }
    if lines.iter().any(|(_, line)| assignment(line, "version").is_some()) {
        return Err(ReleaseError::new(format!(
            "{at}: [package].version is not a quoted scalar on one line, so it cannot be rewritten in place."
        )));
    }
    Ok(None)
}

/// A workspace member's `version` in the `Cargo.lock` that governs it.
pub fn stamp_locked_crate_version(text: &str, krate: &str, version: &str, at: &str) -> Result<Option<String>, ReleaseError> {
    let is_package = |line: &str| line.strip_prefix("[[package]]").is_some_and(|rest| rest.trim_start_matches([' ', '\t']).is_empty());
    let mut edits = Vec::new();
    for body in table_bodies(text, is_package) {
        let lines = body_lines(text, body);
        let name = lines.iter().find_map(|(_, line)| quoted_assignment(line, "name", false)).map(|(_, _, name)| name);
        if name.as_deref() != Some(krate) {
            continue;
        }
        if lines.iter().any(|(_, line)| assignment(line, "source").is_some()) {
            continue;
        }
        let entry = lines.iter().find_map(|(offset, line)| quoted_assignment(line, "version", false).map(|(s, e, _)| (offset + s, offset + e)));
        let Some(edit) = entry else {
            return Err(ReleaseError::new(format!(
                "{at}: the '{krate}' package records no version that can be rewritten in place, so the lockfile would keep naming a version of it that no longer exists."
            )));
        };
        edits.push(edit);
    }
    match edits.len() {
        0 => Ok(None),
        1 => Ok(Some(splice_text(text, edits[0].0, edits[0].1, &format!("\"{version}\"")))),
        n => Err(ReleaseError::new(format!(
            "{at}: '{krate}' is recorded {n} times as a path package, so which entry is the workspace member cannot be decided."
        ))),
    }
}

/// The `Cargo.lock` governing a crate: its own, else the nearest above it.
pub fn governing_lockfile(crate_dir: &str, read: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    let segments: Vec<&str> = if crate_dir.is_empty() { Vec::new() } else { crate_dir.split('/').collect() };
    for depth in (0..=segments.len()).rev() {
        let dir = segments[..depth].join("/");
        let file = if dir.is_empty() { CARGO_LOCK.to_string() } else { format!("{dir}/{CARGO_LOCK}") };
        if read(&file).is_some() {
            return Some(file);
        }
    }
    None
}

struct CargoTomlHandler;

impl VersionFileHandler for CargoTomlHandler {
    fn file_name(&self) -> &'static str {
        CARGO_TOML
    }

    fn read(&self, text: &str, at: &str) -> Result<Option<String>, ReleaseError> {
        Ok(toml_string(text, &["package".into(), "version".into()], at)?.map(|found| found.value))
    }

    fn write(&self, text: &str, version: &str, at: &str) -> Result<Option<String>, ReleaseError> {
        stamp_crate_version(text, version, at)
    }

    fn companions(&self, file: &str, version: &str, read: &dyn Fn(&str) -> Option<String>) -> Result<Vec<Companion>, ReleaseError> {
        let text = read(file);
        let name = text.as_deref().and_then(read_crate_name);
        if let Some(text) = &text {
            if toml_string(text, &["package".into(), "version".into()], file)?.is_none() {
                return Ok(Vec::new());
            }
        }
        let Some(name) = name else {
            return Err(ReleaseError::new(format!(
                "{file}: [package].name is missing, so the crate's entry in Cargo.lock cannot be addressed and the lockfile would keep naming a version that no longer exists."
            )));
        };
        let dir = file.rfind('/').map_or("", |at| &file[..at]);
        let Some(lockfile) = governing_lockfile(dir, read) else { return Ok(Vec::new()) };
        let before = read(&lockfile).unwrap_or_default();
        match stamp_locked_crate_version(&before, &name, version, &lockfile)? {
            Some(after) if after != before => Ok(vec![Companion { file: lockfile, text: after }]),
            _ => Ok(Vec::new()),
        }
    }
}

pub struct CargoAdapter {
    handlers: Vec<Arc<dyn VersionFileHandler>>,
}

impl EcosystemAdapter for CargoAdapter {
    fn ecosystem(&self) -> &'static str {
        "cargo"
    }

    fn anchor_description(&self) -> &'static str {
        "a directory holding a Cargo.toml with a [package] table"
    }

    fn version_file(&self) -> Option<VersionLocationSpec> {
        Some(VersionLocationSpec { file: CARGO_TOML.into(), pointer: None })
    }

    fn recognize(&self, probe: &AnchorProbe<'_>) -> Option<RecognizedPackage> {
        let name = read_crate_name(&probe.read_file(CARGO_TOML)?)?;
        Some(RecognizedPackage { name: Some(name), contributes_layer: true, version_files: Vec::new() })
    }

    fn version_file_handlers(&self) -> Vec<Arc<dyn VersionFileHandler>> {
        self.handlers.clone()
    }
}

pub static CARGO_ADAPTER: LazyLock<Arc<CargoAdapter>> =
    LazyLock::new(|| Arc::new(CargoAdapter { handlers: vec![Arc::new(CargoTomlHandler)] }));

const DEPENDENCY_TABLES: [&str; 3] = ["dependencies", "dev-dependencies", "build-dependencies"];

/// A dotted TOML key split into its segments, quotes removed.
pub(crate) fn dotted_key(key: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for c in key.trim().chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => current.push(c),
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == '.' => {
                segments.push(current.trim().to_string());
                current.clear();
            }
            None => current.push(c),
        }
    }
    segments.push(current.trim().to_string());
    segments
}

/// `path/..` segments resolved, `/`-separated and relative to the workspace.
fn normalized_path(dir: &str, relative: &str) -> String {
    let mut out: Vec<&str> = if dir.is_empty() { Vec::new() } else { dir.split('/').collect() };
    for segment in relative.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out.join("/")
}

/// The first `key = "…"` in `text` preceded by its start, `{`, `,` or
/// whitespace: the value and the span of its quoted form.
pub(crate) fn quoted_value(text: &str, key: &str) -> Option<(String, usize, usize)> {
    let bytes = text.as_bytes();
    let mut from = 0;
    while let Some(found) = text[from..].find(key) {
        let at = from + found;
        from = at + 1;
        if at > 0 && !matches!(bytes[at - 1], b'{' | b',' | b' ' | b'\t' | b'\n' | b'\r') {
            continue;
        }
        let rest = &text[at + key.len()..];
        let Some(after_eq) = rest.trim_start_matches([' ', '\t']).strip_prefix('=') else { continue };
        let value = after_eq.trim_start_matches([' ', '\t']);
        let Some(body) = value.strip_prefix('"') else { continue };
        let Some(close) = body.find('"') else { continue };
        let start = text.len() - value.len();
        return Some((body[..close].to_string(), start, start + close + 2));
    }
    None
}

/// `^(\^|~|>=|=)?(\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?)$`: the operator of a plain
/// requirement, `None` for any other.
fn plain_requirement(value: &str) -> Option<&str> {
    let operator = ["^", "~", ">=", "="].into_iter().find(|op| value.starts_with(op)).unwrap_or("");
    let rest = &value[operator.len()..];
    let (core, pre) = match rest.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (rest, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    let numeric = (1..=3).contains(&parts.len()) && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    let pre_ok = pre.is_none_or(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-'));
    (numeric && pre_ok).then_some(operator)
}

/// A `Cargo.toml` with the version requirement of every dependency on the
/// crate at `target_dir` rewritten to `version`, keeping its operator — the
/// cargo twin of a dependent's plain npm range. Both directories are
/// workspace-relative. A dependency is matched by its `path`, in a
/// `[*dependencies]` table's inline entry or in a `[*dependencies.<name>]`
/// table; one with no `version` key, or a requirement that is not one plain
/// version (`>=1, <2`), is left as written.
pub fn stamp_path_dependency_requirements(text: &str, manifest_dir: &str, target_dir: &str, version: &str) -> String {
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    let targets = |path: &str| normalized_path(manifest_dir, path) == target_dir;
    let mut rewrite = |found: Option<(String, usize, usize)>, at: usize, edits: &mut Vec<(usize, usize, String)>| {
        let Some((value, start, end)) = found else { return };
        let Some(operator) = plain_requirement(&value) else { return };
        let replacement = format!("\"{operator}{version}\"");
        if replacement != text[at + start..at + end] {
            edits.push((at + start, at + end, replacement));
        }
    };

    let mut section: Vec<String> = Vec::new();
    // `[*dependencies.<name>]` being read: its `path` and its `version` with the line's offset.
    let mut table: Option<(Option<String>, Option<(String, usize, usize, usize)>)> = None;
    let close = |table: &mut Option<(Option<String>, Option<(String, usize, usize, usize)>)>,
                 edits: &mut Vec<(usize, usize, String)>,
                 rewrite: &mut dyn FnMut(Option<(String, usize, usize)>, usize, &mut Vec<(usize, usize, String)>)| {
        if let Some((Some(path), Some((value, start, end, at)))) = table.take() {
            if targets(&path) {
                rewrite(Some((value, start, end)), at, edits);
            }
        }
    };
    let mut offset = 0;
    for raw in text.split('\n') {
        let at = offset;
        offset += raw.len() + 1;
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let trimmed = leading_ws(line);
        if let Some(inner) = trimmed.strip_prefix('[').and_then(|rest| {
            let close_at = rest.find(']')?;
            let (inner, after) = (&rest[..close_at], &rest[close_at + 1..]);
            let after = leading_ws(after);
            (!inner.is_empty() && !inner.contains('[') && (after.is_empty() || after.starts_with('#'))).then_some(inner)
        }) {
            close(&mut table, &mut edits, &mut rewrite);
            section = dotted_key(inner);
            if section.len() >= 2 && DEPENDENCY_TABLES.contains(&section[section.len() - 2].as_str()) {
                table = Some((None, None));
            }
            continue;
        }
        if let Some((path, requirement)) = table.as_mut() {
            if assignment(line, "path").is_some() {
                if let Some((value, _, _)) = quoted_value(line, "path") {
                    *path = Some(value);
                }
            }
            if assignment(line, "version").is_some() {
                if let Some((value, start, end)) = quoted_value(line, "version") {
                    *requirement = Some((value, start, end, at));
                }
            }
            continue;
        }
        if !section.last().is_some_and(|last| DEPENDENCY_TABLES.contains(&last.as_str())) {
            continue;
        }
        let Some(eq) = line.find('=') else { continue };
        if line[..eq].contains('#') || leading_ws(&line[..eq]).is_empty() {
            continue;
        }
        let after_eq = leading_ws(&line[eq + 1..]);
        if !after_eq.starts_with('{') {
            continue;
        }
        let (Some(open), Some(close_brace)) = (line.find('{'), line.rfind('}')) else { continue };
        if close_brace <= open {
            continue;
        }
        let body = &line[open + 1..close_brace];
        let Some((path, _, _)) = quoted_value(body, "path") else { continue };
        if !targets(&path) {
            continue;
        }
        rewrite(quoted_value(body, "version"), at + open + 1, &mut edits);
    }
    close(&mut table, &mut edits, &mut rewrite);
    edits.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out = text.to_string();
    for (start, end, replacement) in edits {
        out = splice_text(&out, start, end, &replacement);
    }
    out
}

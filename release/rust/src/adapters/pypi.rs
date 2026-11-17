//! The `pypi` ecosystem's pure half: an anchor holding a `pyproject.toml` with
//! a `[project]` table carrying `name` is one Python distribution. Its version
//! is `project.version`; one listed in `project.dynamic` is no static version,
//! and a `pyproject.toml` with no `[build-system]` builds nothing, so
//! contributes no layer. Edges are runtime requirements whose source is a
//! sibling's directory, named through `[tool.uv.sources]`,
//! `[tool.poetry.dependencies]` or a `file:` reference rooted at the project
//! (PDM, Hatch). This file also holds what apply rewrites — a linked
//! requirement's specifier, a lockfile's entry and content hash — and how a
//! published sdist is found in a simple index, all over text.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use indexmap::{IndexMap, IndexSet};
use serde_json::Value;

use crate::adapter::{AnchorProbe, EcosystemAdapter, RecognizedPackage, VersionFileHandler, VersionLocationSpec};
use crate::bump_level::is_unit_version;
use crate::fragment::UnitKey;
use crate::marker_schema::{KeySchemas, KeyType, WorkspaceKeySchema};
use crate::version_files::{splice_text, toml_string, PYPROJECT_TOML_HANDLER};
use crate::ReleaseError;

use super::toml_document::{read_toml_document, respell_toml_string, toml_at, TomlString, TomlTable, TomlValue};

pub const PYPROJECT_TOML: &str = "pyproject.toml";
/// The lockfiles that record a path project's version.
pub const PYPI_LOCKFILES: [&str; 3] = ["uv.lock", "poetry.lock", "pdm.lock"];

fn err(message: String) -> ReleaseError {
    ReleaseError::new(message)
}

/// JavaScript's `\s`.
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// JavaScript's `String.prototype.trim`.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// JavaScript's default sort order: UTF-16 code units.
fn utf16_order(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

// ---------------------------------------------------------------------------
// Names and versions
// ---------------------------------------------------------------------------

/// A distribution name as PEP 503 compares it.
pub fn normalize_pypi_name(name: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in name.chars() {
        if matches!(c, '-' | '_' | '.') {
            if !in_run {
                out.push('-');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out.to_lowercase()
}

type Span = (usize, usize);

/// The groups PEP 440's pattern captures, as spans of the trimmed version.
#[derive(Default, Clone, Copy)]
struct Pep440Groups {
    epoch: Option<Span>,
    release: Span,
    pre: Option<(Span, Option<Span>)>,
    /// `-N` (implicit) or a label and its number.
    post: Option<(Option<Span>, Option<Span>)>,
    dev: Option<Option<Span>>,
    local: Option<Span>,
}

const PRE_LABELS: [&str; 8] = ["alpha", "a", "beta", "b", "preview", "pre", "c", "rc"];
const POST_LABELS: [&str; 3] = ["post", "rev", "r"];

fn digits_end(b: &[u8], at: usize) -> usize {
    let mut i = at;
    while b.get(i).is_some_and(u8::is_ascii_digit) {
        i += 1;
    }
    i
}

/// `[-_.]?`, greedy first.
fn separator_ends(b: &[u8], at: usize) -> Vec<usize> {
    if matches!(b.get(at), Some(b'-' | b'_' | b'.')) {
        vec![at + 1, at]
    } else {
        vec![at]
    }
}

/// Each label of the alternation matching at `at`, ASCII-case-insensitively, in its order.
fn label_ends(b: &[u8], at: usize, labels: &[&str]) -> Vec<(usize, Span)> {
    labels
        .iter()
        .filter(|label| b.get(at..at + label.len()).is_some_and(|run| run.eq_ignore_ascii_case(label.as_bytes())))
        .map(|label| (at + label.len(), (at, at + label.len())))
        .collect()
}

/// `(\d+)?`: the whole run, then none. No group after one starts with a
/// digit, so a shorter run never matches.
fn optional_number(b: &[u8], at: usize) -> Vec<(usize, Option<Span>)> {
    let end = digits_end(b, at);
    if end > at {
        vec![(end, Some((at, end))), (at, None)]
    } else {
        vec![(at, None)]
    }
}

/// `[-_.]?(label)[-_.]?(\d+)?` from `at`, every way it matches, in the pattern's order.
fn labelled(b: &[u8], at: usize, labels: &[&str]) -> Vec<(usize, Span, Option<Span>)> {
    let mut out = Vec::new();
    for s1 in separator_ends(b, at) {
        for (l_end, label) in label_ends(b, s1, labels) {
            for s2 in separator_ends(b, l_end) {
                for (n_end, number) in optional_number(b, s2) {
                    out.push((n_end, label, number));
                }
            }
        }
    }
    out
}

/// `^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(alpha|a|beta|b|preview|pre|c|rc)[-_.]?(\d+)?)?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d+)?)?(?:[-_.]?(dev)[-_.]?(\d+)?)?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$`
/// with the `i` flag, matched with the pattern's own backtracking order.
fn match_pep440(b: &[u8]) -> Option<Pep440Groups> {
    let starts = if matches!(b.first(), Some(b'v' | b'V')) { vec![1, 0] } else { vec![0] };
    for i0 in starts {
        let mut epochs: Vec<(usize, Option<Span>)> = Vec::new();
        let e = digits_end(b, i0);
        if e > i0 && b.get(e) == Some(&b'!') {
            epochs.push((e + 1, Some((i0, e))));
        }
        epochs.push((i0, None));
        for (i1, epoch) in epochs {
            let mut i2 = digits_end(b, i1);
            if i2 == i1 {
                continue;
            }
            while b.get(i2) == Some(&b'.') && digits_end(b, i2 + 1) > i2 + 1 {
                i2 = digits_end(b, i2 + 1);
            }
            let release = (i1, i2);
            let mut pres: Vec<(usize, Option<(Span, Option<Span>)>)> =
                labelled(b, i2, &PRE_LABELS).into_iter().map(|(end, label, number)| (end, Some((label, number)))).collect();
            pres.push((i2, None));
            for (i3, pre) in pres {
                let mut posts: Vec<(usize, Option<(Option<Span>, Option<Span>)>)> = Vec::new();
                let implicit = digits_end(b, i3 + 1);
                if b.get(i3) == Some(&b'-') && implicit > i3 + 1 {
                    posts.push((implicit, Some((None, Some((i3 + 1, implicit))))));
                }
                posts.extend(labelled(b, i3, &POST_LABELS).into_iter().map(|(end, label, number)| (end, Some((Some(label), number)))));
                posts.push((i3, None));
                for (i4, post) in posts {
                    let mut devs: Vec<(usize, Option<Option<Span>>)> =
                        labelled(b, i4, &["dev"]).into_iter().map(|(end, _, number)| (end, Some(number))).collect();
                    devs.push((i4, None));
                    for (i5, dev) in devs {
                        let local = if i5 == b.len() {
                            Some(None)
                        } else if b[i5] == b'+' && is_local(&b[i5 + 1..]) {
                            Some(Some((i5 + 1, b.len())))
                        } else {
                            None
                        };
                        if let Some(local) = local {
                            return Some(Pep440Groups { epoch, release, pre, post, dev, local });
                        }
                    }
                }
            }
        }
    }
    None
}

/// `[a-z0-9]+(?:[-_.][a-z0-9]+)*`, case-insensitively, the whole of `b`.
fn is_local(b: &[u8]) -> bool {
    !b.is_empty() && b.split(|c| matches!(c, b'-' | b'_' | b'.')).all(|part| !part.is_empty() && part.iter().all(u8::is_ascii_alphanumeric))
}

/// `String(BigInt(text))` of a digit run.
fn int_text(text: Option<&str>) -> String {
    let trimmed = text.unwrap_or("0").trim_start_matches('0');
    if trimmed.is_empty() { "0".to_string() } else { trimmed.to_string() }
}

struct Pep440 {
    epoch: String,
    release: Vec<String>,
    rest: String,
}

fn parse_pep440(version: &str) -> Option<Pep440> {
    let text = js_trim(version);
    let m = match_pep440(text.as_bytes())?;
    let at = |span: Span| &text[span.0..span.1];
    let pre = m.pre.map_or_else(String::new, |(label, number)| {
        let label = match at(label).to_ascii_lowercase().as_str() {
            "alpha" | "a" => "a",
            "beta" | "b" => "b",
            _ => "rc",
        };
        format!("{label}{}", int_text(number.map(at)))
    });
    let post = m.post.map_or_else(String::new, |(_, number)| format!(".post{}", int_text(number.map(at))));
    let dev = m.dev.map_or_else(String::new, |number| format!(".dev{}", int_text(number.map(at))));
    let local = m.local.map_or_else(String::new, |span| {
        let parts: Vec<String> = at(span)
            .to_ascii_lowercase()
            .split(['-', '_', '.'])
            .map(|part| if part.bytes().all(|c| c.is_ascii_digit()) { int_text(Some(part)) } else { part.to_string() })
            .collect();
        format!("+{}", parts.join("."))
    });
    let epoch = match m.epoch.map(at) {
        Some(epoch) if int_text(Some(epoch)) != "0" => format!("{}!", int_text(Some(epoch))),
        _ => String::new(),
    };
    Some(Pep440 { epoch, release: at(m.release).split('.').map(|part| int_text(Some(part))).collect(), rest: format!("{pre}{post}{dev}{local}") })
}

/// A version in PEP 440 normalized form (`1.0.0-rc.1` → `1.0.0rc1`), or `None`
/// when PEP 440 cannot spell it.
pub fn normalize_pypi_version(version: &str) -> Option<String> {
    parse_pep440(version).map(|parsed| format!("{}{}{}", parsed.epoch, parsed.release.join("."), parsed.rest))
}

/// Two versions PEP 440 holds equal compare equal here (`1.0` and `1.0.0`).
fn version_key(version: &str) -> Option<String> {
    let parsed = parse_pep440(version)?;
    let mut release = parsed.release;
    while release.len() > 1 && release.last().is_some_and(|last| last == "0") {
        release.pop();
    }
    Some(format!("{}{}{}", parsed.epoch, release.join("."), parsed.rest))
}

/// Why `version` cannot be planned or published, or `None` when it can.
pub fn pypi_version_problem(version: &str) -> Option<String> {
    if !is_unit_version(version) {
        return Some(format!(
            "'{version}' is not a version a release can be planned from: write it as major.minor.patch (1.2.3), or a candidate of one (1.2.3-rc.1)"
        ));
    }
    if normalize_pypi_version(version).is_none() {
        return Some(format!(
            "'{version}' is not a version PEP 440 can spell: a candidate's identifier must be one of a, alpha, b, beta, c, rc, pre, preview, dev or post"
        ));
    }
    None
}

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

fn read_document(text: &str, at: &str) -> Option<TomlTable> {
    read_toml_document(text, at).ok()
}

fn string_at(from: &TomlTable, path: &[&str]) -> Option<String> {
    match toml_at(from, path)? {
        TomlValue::String(found) => Some(found.value.clone()),
        _ => None,
    }
}

fn strings(value: Option<&TomlValue>) -> Vec<String> {
    match value {
        Some(TomlValue::Array { items, .. }) => {
            items.iter().filter_map(|item| if let TomlValue::String(s) = item { Some(s.value.clone()) } else { None }).collect()
        }
        _ => Vec::new(),
    }
}

fn scanned_string(text: &str, path: &[&str], at: &str) -> Option<crate::version_files::TomlString> {
    let tokens: Vec<String> = path.iter().map(|part| part.to_string()).collect();
    toml_string(text, &tokens, at).ok().flatten()
}

/// The tool that derives a dynamic version from git, when one does.
fn vcs_version_tool(doc: &TomlTable) -> Option<&'static str> {
    let requires: Vec<String> =
        strings(toml_at(doc, &["build-system", "requires"])).iter().map(|r| normalize_pypi_name(requirement_name(r).unwrap_or(""))).collect();
    if toml_at(doc, &["tool", "setuptools_scm"]).is_some() {
        return Some("setuptools-scm");
    }
    if requires.iter().any(|r| r == "setuptools-scm") && toml_at(doc, &["tool", "setuptools", "dynamic", "version"]).is_none() {
        return Some("setuptools-scm");
    }
    if string_at(doc, &["tool", "hatch", "version", "source"]).as_deref() == Some("vcs") {
        return Some("hatch-vcs");
    }
    if string_at(doc, &["tool", "pdm", "version", "source"]).as_deref() == Some("scm") {
        return Some("pdm-backend's scm source");
    }
    if toml_at(doc, &["tool", "poetry-dynamic-versioning", "enable"]) == Some(&TomlValue::Boolean(true)) {
        return Some("poetry-dynamic-versioning");
    }
    None
}

pub struct PypiAdapter;

impl EcosystemAdapter for PypiAdapter {
    fn ecosystem(&self) -> &'static str {
        "pypi"
    }

    fn anchor_description(&self) -> &'static str {
        "a directory holding a pyproject.toml with a [project] table carrying name"
    }

    fn keys(&self) -> KeySchemas {
        vec![(
            "registry",
            WorkspaceKeySchema {
                ty: KeyType::String,
                description: "Simple-API index base URL the distribution is published to and read back from, as `<registry>/<normalized name>`. Omitted: no read-back, and no destination.",
                examples: &["https://pypi.org/simple"],
                entry: None,
            },
        )]
    }

    fn version_file(&self) -> Option<VersionLocationSpec> {
        Some(VersionLocationSpec { file: PYPROJECT_TOML.into(), pointer: None })
    }

    fn recognize(&self, probe: &AnchorProbe<'_>) -> Option<RecognizedPackage> {
        let text = probe.read_file(PYPROJECT_TOML)?;
        let at = format!("{}/{PYPROJECT_TOML}", if probe.dir.is_empty() { "." } else { probe.dir });
        // A file that does not parse is still the anchor its scanned name says;
        // the evidence half refuses it with the parse error.
        let Some(doc) = read_document(&text, &at) else {
            let name = scanned_string(&text, &["project", "name"], &at)?.value;
            return Some(RecognizedPackage { name: Some(name), contributes_layer: true, ..RecognizedPackage::default() });
        };
        let name = string_at(&doc, &["project", "name"])?;
        let anchor = format!("pypi at `{}`", probe.anchor);
        let builds = toml_at(&doc, &["build-system"]).is_some();
        let no_static_version = if strings(toml_at(&doc, &["project", "dynamic"])).iter().any(|d| d == "version") {
            Some(match vcs_version_tool(&doc) {
                Some(tool) => format!(
                    "{anchor} lists `version` in `project.dynamic` and derives it from git through {tool}, which no release can plan; make its build backend read the version from a file instead"
                ),
                None => format!("{anchor} lists `version` in `project.dynamic`"),
            })
        } else if toml_at(&doc, &["project", "version"]).is_none() {
            Some(format!("{anchor} sets no `project.version`"))
        } else if scanned_string(&text, &["project", "version"], &at).is_none() {
            Some(format!(
                "{anchor} writes `project.version` in a form that cannot be rewritten in place; write it as version = \"<version>\" in the [project] table"
            ))
        } else {
            None
        };
        Some(RecognizedPackage {
            name: Some(name),
            contributes_layer: builds,
            no_layer_reason: (!builds).then(|| format!("{anchor} declares no `[build-system]`")),
            no_static_version,
            version_files: Vec::new(),
        })
    }

    fn version_file_handlers(&self) -> Vec<Arc<dyn VersionFileHandler>> {
        vec![PYPROJECT_TOML_HANDLER.clone()]
    }
}

pub static PYPI_ADAPTER: LazyLock<Arc<PypiAdapter>> = LazyLock::new(|| Arc::new(PypiAdapter));

// ---------------------------------------------------------------------------
// The build system
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PypiBuildSystem {
    pub requires: Vec<String>,
    pub backend: String,
    pub backend_path: Vec<String>,
}

/// PEP 517's fallback when `[build-system]` names no backend.
const LEGACY_BACKEND: &str = "setuptools.build_meta:__legacy__";

/// `[build-system]` as a frontend reads it, or `None` when there is none.
pub fn pypi_build_system(text: &str, at: &str) -> Result<Option<PypiBuildSystem>, ReleaseError> {
    let doc = read_toml_document(text, at)?;
    let Some(system) = toml_at(&doc, &["build-system"]) else { return Ok(None) };
    let TomlValue::Table(system) = system else {
        return Err(err(format!("{at}: [build-system] is not a table.")));
    };
    let list = |key: &str, required: bool| -> Result<Vec<String>, ReleaseError> {
        let value = system.entries.get(key);
        if value.is_none() && !required {
            return Ok(Vec::new());
        }
        match value {
            Some(TomlValue::Array { items, .. }) if items.iter().all(|item| matches!(item, TomlValue::String(_))) => Ok(strings(value)),
            _ => Err(err(format!("{at}: [build-system].{key} must be a list of strings."))),
        }
    };
    let requires = list("requires", true)?;
    let backend = match system.entries.get("build-backend") {
        None => LEGACY_BACKEND.to_string(),
        Some(TomlValue::String(backend)) => backend.value.clone(),
        Some(_) => return Err(err(format!("{at}: [build-system].build-backend must be a string."))),
    };
    Ok(Some(PypiBuildSystem { requires, backend, backend_path: list("backend-path", false)? }))
}

/// Whether an sdist member holds core metadata its backend derives from the
/// project (`PKG-INFO`, an `*.egg-info` directory) rather than a file of it.
pub fn is_generated_sdist_member(path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').collect();
    path == "PKG-INFO" || segments[..segments.len() - 1].iter().any(|segment| segment.ends_with(".egg-info"))
}

// ---------------------------------------------------------------------------
// Requirements and edges
// ---------------------------------------------------------------------------

struct Requirement {
    name: String,
    url: Option<String>,
    /// The specifier's span in the requirement text, parentheses excluded.
    specifier: Option<Span>,
}

fn skip_js_spaces(text: &str, at: usize) -> usize {
    at + text[at..].len() - text[at..].trim_start_matches(is_js_space).len()
}

/// `^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)`: the name's span.
fn requirement_name_span(text: &str) -> Option<Span> {
    let start = skip_js_spaces(text, 0);
    let b = text.as_bytes();
    if !b.get(start).is_some_and(u8::is_ascii_alphanumeric) {
        return None;
    }
    let mut run = start;
    while b.get(run).is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-')) {
        run += 1;
    }
    let mut end = run;
    while !b[end - 1].is_ascii_alphanumeric() {
        end -= 1;
    }
    Some((start, end))
}

fn requirement_name(text: &str) -> Option<&str> {
    requirement_name_span(text).map(|(start, end)| &text[start..end])
}

/// A PEP 508 requirement's name, and its URL or specifier.
fn parse_requirement(text: &str) -> Option<Requirement> {
    let (start, end) = requirement_name_span(text)?;
    let name = text[start..end].to_string();
    let mut pos = skip_js_spaces(text, end);
    if text[pos..].starts_with('[') {
        if let Some(close) = text[pos + 1..].find(']') {
            pos = skip_js_spaces(text, pos + 1 + close + 1);
        }
    }
    if text[pos..].starts_with('@') {
        let from = skip_js_spaces(text, pos + 1);
        let run = text[from..].find(is_js_space).map_or(text.len(), |i| from + i);
        return (run > from).then(|| Requirement { name, url: Some(text[from..run].to_string()), specifier: None });
    }
    let mut start = pos;
    let mut end = text[pos..].find(';').map_or(text.len(), |i| pos + i);
    end = start + text[start..end].trim_end_matches(is_js_space).len();
    if end > start && text.as_bytes()[start] == b'(' && text.as_bytes()[end - 1] == b')' {
        start += 1;
        end -= 1;
        if end > start {
            start = skip_js_spaces(&text[..end], start);
            end = start + text[start..end].trim_end_matches(is_js_space).len();
        }
    }
    Some(Requirement { name, url: None, specifier: (end > start).then_some((start, end)) })
}

/// One pypi anchor of the workspace, as the edge reader sees it.
#[derive(Debug, Clone)]
pub struct PypiProjectFile {
    pub unit: UnitKey,
    /// Workspace-relative directory (`""` the root).
    pub dir: String,
    pub text: String,
}

/// The workspace's pypi anchors by directory and by normalized name.
#[derive(Debug, Clone, Default)]
pub struct PypiProjectIndex {
    pub units: HashMap<String, UnitKey>,
    pub dirs_by_name: HashMap<String, Vec<String>>,
}

pub fn pypi_project_index(projects: &[PypiProjectFile]) -> PypiProjectIndex {
    let mut index = PypiProjectIndex::default();
    for project in projects {
        index.units.insert(project.dir.clone(), project.unit.clone());
        let at = project_file(&project.dir);
        let name = match read_document(&project.text, &at) {
            Some(doc) => string_at(&doc, &["project", "name"]),
            None => scanned_string(&project.text, &["project", "name"], &at).map(|found| found.value),
        };
        let Some(name) = name else { continue };
        let dirs = index.dirs_by_name.entry(normalize_pypi_name(&name)).or_default();
        dirs.push(project.dir.clone());
        dirs.sort_by(|a, b| utf16_order(a, b));
    }
    index
}

/// A runtime requirement of one project that names a sibling anchor's directory.
#[derive(Debug, Clone)]
pub struct PypiLink {
    /// The requirement as written.
    pub requirement: String,
    /// Where it is listed (`project.dependencies`, `project.optional-dependencies.<extra>`).
    pub at: String,
    /// The sibling anchor's workspace-relative directory.
    pub target: String,
    pub literal: TomlString,
}

/// One project as planning reads it.
#[derive(Debug, Clone, Default)]
pub struct PypiProjectRead {
    pub links: Vec<PypiLink>,
    pub problems: Vec<String>,
}

const SOURCE_FORMS: &str = "A sibling is read from [tool.uv.sources] (path = \"<dir>\" or workspace = true), [tool.poetry.dependencies] (path = \"<dir>\"), or a file: reference rooted at ${PROJECT_ROOT} (PDM) or {root:uri} (Hatch).";

fn project_file(dir: &str) -> String {
    if dir.is_empty() { PYPROJECT_TOML.to_string() } else { format!("{dir}/{PYPROJECT_TOML}") }
}

/// `relative` resolved against the workspace-relative `dir`; `None` when it climbs above the workspace.
fn resolve_within(dir: &str, relative: &str) -> Option<String> {
    let mut out: Vec<String> = if dir.is_empty() { Vec::new() } else { dir.split('/').map(str::to_string).collect() };
    for segment in relative.replace('\\', "/").split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            other => out.push(other.to_string()),
        }
    }
    Some(out.join("/"))
}

/// JavaScript's `decodeURIComponent`.
fn decode_uri_component(text: &str) -> Result<String, ReleaseError> {
    let malformed = || err("URI malformed".into());
    let b = text.as_bytes();
    let byte_at = |i: usize| -> Option<u8> {
        if b.get(i) != Some(&b'%') {
            return None;
        }
        let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
        u8::from_str_radix(hex, 16).ok().filter(|_| hex.bytes().all(|h| h.is_ascii_hexdigit()))
    };
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'%' {
            let c = text[i..].chars().next().ok_or_else(malformed)?;
            out.push(c);
            i += c.len_utf8();
            continue;
        }
        let lead = byte_at(i).ok_or_else(malformed)?;
        let count = match lead {
            0x00..=0x7f => 1,
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => return Err(malformed()),
        };
        let mut bytes = vec![lead];
        for k in 1..count {
            let next = byte_at(i + 3 * k).filter(|n| n & 0xc0 == 0x80).ok_or_else(malformed)?;
            bytes.push(next);
        }
        out.push_str(std::str::from_utf8(&bytes).map_err(|_| malformed())?);
        i += 3 * count;
    }
    Ok(out)
}

/// The path after a project-root placeholder, relative to the project.
fn rooted(rest: &str) -> Result<String, ReleaseError> {
    Ok(decode_uri_component(rest)?.trim_start_matches('/').to_string())
}

fn is_absolute_path(path: &str) -> bool {
    let b = path.as_bytes();
    path.starts_with('/') || path.starts_with('\\') || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/'))
}

/// Each runtime requirement, with where it is listed.
fn runtime_requirements<'d>(doc: &'d TomlTable, at: &str, problems: &mut Vec<String>) -> Vec<(String, &'d TomlString)> {
    let mut found = Vec::new();
    let mut list = |value: Option<&'d TomlValue>, listed: String, problems: &mut Vec<String>| {
        let Some(value) = value else { return };
        let TomlValue::Array { items, .. } = value else {
            problems.push(format!("{at}: {listed} is not a list of strings."));
            return;
        };
        let literals: Vec<&TomlString> = items.iter().filter_map(|item| if let TomlValue::String(s) = item { Some(s) } else { None }).collect();
        if literals.len() != items.len() {
            problems.push(format!("{at}: {listed} is not a list of strings."));
            return;
        }
        for literal in literals {
            found.push((listed.clone(), literal));
        }
    };
    list(toml_at(doc, &["project", "dependencies"]), "project.dependencies".into(), problems);
    match toml_at(doc, &["project", "optional-dependencies"]) {
        Some(TomlValue::Table(optional)) => {
            for (extra, value) in &optional.entries {
                list(Some(value), format!("project.optional-dependencies.{extra}"), problems);
            }
        }
        Some(_) => problems.push(format!("{at}: project.optional-dependencies is not a table.")),
        None => {}
    }
    found
}

/// The source entries a tool table gives a requirement name, each a table.
fn sources_for<'d>(table: Option<&'d TomlValue>, name: &str) -> Vec<&'d TomlTable> {
    let Some(TomlValue::Table(table)) = table else { return Vec::new() };
    let mut found = Vec::new();
    for (key, value) in &table.entries {
        if normalize_pypi_name(key) != name {
            continue;
        }
        let items: Vec<&TomlValue> = match value {
            TomlValue::Array { items, .. } => items.iter().collect(),
            other => vec![other],
        };
        found.extend(items.into_iter().filter_map(|item| if let TomlValue::Table(t) = item { Some(t) } else { None }));
    }
    found
}

/// `^file:\/\/\/?\$\{PROJECT_ROOT\}(?=\/|$)`: the match's length.
fn pdm_root(url: &str) -> Option<usize> {
    let rest = url.strip_prefix("file://")?;
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    let after = rest.strip_prefix("${PROJECT_ROOT}")?;
    (after.is_empty() || after.starts_with('/')).then_some(url.len() - after.len())
}

/// `^\{root((?::parent)*):uri\}(?=\/|$)`: the match's length and its parents.
fn hatch_root(url: &str) -> Option<(usize, usize)> {
    let mut rest = url.strip_prefix("{root")?;
    let mut parents = 0;
    while let Some(after) = rest.strip_prefix(":parent") {
        rest = after;
        parents += 1;
    }
    let after = rest.strip_prefix(":uri}")?;
    (after.is_empty() || after.starts_with('/')).then_some((url.len() - after.len(), parents))
}

/// One project as planning reads it: its links, and every reason it cannot be
/// planned — a static `project.version` no release can plan, a requirement
/// that cannot be read. Index, git and URL requirements are pins, and
/// dependency groups and dev tables are never read; a path naming no anchor is
/// no link.
pub fn read_pypi_project(dir: &str, text: &str, index: &PypiProjectIndex) -> Result<PypiProjectRead, ReleaseError> {
    let at = project_file(dir);
    let mut read = PypiProjectRead::default();
    let doc = match read_toml_document(text, &at) {
        Ok(doc) => doc,
        Err(error) => {
            read.problems.push(error.message);
            return Ok(read);
        }
    };
    if !strings(toml_at(&doc, &["project", "dynamic"])).iter().any(|d| d == "version") {
        if let Some(problem) = scanned_string(text, &["project", "version"], &at).and_then(|version| pypi_version_problem(&version.value)) {
            read.problems.push(format!("{at}: project.version {problem}."));
        }
    }
    let own = normalize_pypi_name(&string_at(&doc, &["project", "name"]).unwrap_or_default());
    let uv_sources = toml_at(&doc, &["tool", "uv", "sources"]);
    let poetry_dependencies = toml_at(&doc, &["tool", "poetry", "dependencies"]);

    for (listed, literal) in runtime_requirements(&doc, &at, &mut read.problems) {
        let requirement = &literal.value;
        let Some(parsed) = parse_requirement(requirement) else {
            read.problems.push(format!("{at}: '{requirement}' in {listed} cannot be read as a PEP 508 requirement."));
            continue;
        };
        let name = normalize_pypi_name(&parsed.name);
        if name == own {
            continue;
        }
        let mut named: Vec<(String, &str, &str)> = Vec::new();
        if let Some(url) = &parsed.url {
            if let Some(length) = pdm_root(url) {
                named.push((rooted(&url[length..])?, "a file: reference rooted at ${PROJECT_ROOT}", dir));
            } else if let Some((length, parents)) = hatch_root(url) {
                named.push((format!("{}{}", "../".repeat(parents), rooted(&url[length..])?), "a file: reference rooted at {root:uri}", dir));
            } else if url.get(..5).is_some_and(|scheme| scheme.eq_ignore_ascii_case("file:")) {
                read.problems.push(format!(
                    "{at}: '{requirement}' in {listed} is a file: reference not rooted at the project, so which sibling it names cannot be read. {SOURCE_FORMS}"
                ));
                continue;
            }
        } else {
            for source in sources_for(uv_sources, &name) {
                match (source.entries.get("path"), source.entries.get("workspace")) {
                    (Some(TomlValue::String(path)), _) => named.push((path.value.clone(), "[tool.uv.sources]", dir)),
                    (_, Some(TomlValue::Boolean(true))) => {
                        let dirs = index.dirs_by_name.get(&name).cloned().unwrap_or_default();
                        if dirs.len() > 1 {
                            let shown: Vec<String> = dirs.iter().map(|d| format!("'{}'", if d.is_empty() { "." } else { d })).collect();
                            read.problems.push(format!(
                                "{at}: '{requirement}' in {listed} names a workspace member through [tool.uv.sources], and {} are each called '{name}'.",
                                shown.join(" and ")
                            ));
                        } else if let Some(only) = dirs.first() {
                            named.push((only.clone(), "[tool.uv.sources]", ""));
                        }
                    }
                    _ => {}
                }
            }
            for source in sources_for(poetry_dependencies, &name) {
                if let Some(TomlValue::String(path)) = source.entries.get("path") {
                    named.push((path.value.clone(), "[tool.poetry.dependencies]", dir));
                }
            }
        }
        for (path, form, base) in named {
            if is_absolute_path(&path) {
                read.problems.push(format!(
                    "{at}: '{requirement}' in {listed} names the absolute path '{path}' through {form}; only a path relative to the project is read."
                ));
                continue;
            }
            let Some(target) = resolve_within(base, &path) else {
                read.problems.push(format!(
                    "{at}: '{requirement}' in {listed} names '{path}' through {form}, which leaves the workspace; a release plans only along paths inside it."
                ));
                continue;
            };
            let known = read.links.iter().any(|l| l.literal.start == literal.start && l.target == target);
            if target != dir && index.units.contains_key(&target) && !known {
                read.links.push(PypiLink { requirement: requirement.clone(), at: listed.clone(), target, literal: literal.clone() });
            }
        }
    }
    Ok(read)
}

// ---------------------------------------------------------------------------
// What apply rewrites
// ---------------------------------------------------------------------------

/// `^(==|>=|~=)\s*(\S+)$`: the version's offset in the clause.
fn movable(clause: &str) -> Option<usize> {
    let rest = clause.strip_prefix("==").or_else(|| clause.strip_prefix(">=")).or_else(|| clause.strip_prefix("~="))?;
    let version = rest.trim_start_matches(is_js_space);
    (!version.is_empty() && !version.contains(is_js_space)).then_some(clause.len() - version.len())
}

/// A dependent's `pyproject.toml` with every requirement linked to
/// `target_dir` that holds one `==`, `>=` or `~=` clause moved to `version`,
/// keeping the operator; any other shape is left as written.
pub fn stamp_linked_requirements(
    text: &str,
    dir: &str,
    index: &PypiProjectIndex,
    target_dir: &str,
    version: &str,
) -> Result<String, ReleaseError> {
    let read = read_pypi_project(dir, text, index)?;
    if !read.problems.is_empty() {
        return Err(err(read.problems.join("\n")));
    }
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for link in &read.links {
        if link.target != target_dir || edits.iter().any(|edit| edit.0 == link.literal.start) {
            continue;
        }
        let Some((start, end)) = parse_requirement(&link.requirement).and_then(|parsed| parsed.specifier) else { continue };
        let clause = &link.requirement[start..end];
        let Some(offset) = movable(clause) else { continue };
        let written = &clause[offset..];
        if normalize_pypi_version(written).is_none() || written.contains('*') {
            continue;
        }
        let moved = format!("{}{version}{}", &link.requirement[..start + offset], &link.requirement[end..]);
        if moved == link.requirement {
            continue;
        }
        edits.push((link.literal.start, link.literal.end, respell_toml_string(text, &link.literal, &moved)));
    }
    edits.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out = text.to_string();
    for (start, end, replacement) in edits {
        out = splice_text(&out, start, end, &replacement);
    }
    Ok(out)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LockKind {
    Uv,
    Poetry,
    Pdm,
}

fn lock_kind(file: &str) -> Result<LockKind, ReleaseError> {
    match file.rsplit('/').next().unwrap_or(file) {
        "uv.lock" => Ok(LockKind::Uv),
        "poetry.lock" => Ok(LockKind::Poetry),
        "pdm.lock" => Ok(LockKind::Pdm),
        _ => Err(err(format!("{file} is not a lockfile the pypi ecosystem reads."))),
    }
}

fn directory_of(file: &str) -> &str {
    file.rsplit_once('/').map_or("", |(dir, _)| dir)
}

/// The directory a lockfile's package entry was locked from, as it records it.
fn locked_path(kind: LockKind, entry: &TomlTable) -> Option<String> {
    match kind {
        LockKind::Uv => {
            let Some(TomlValue::Table(source)) = entry.entries.get("source") else { return None };
            ["editable", "directory", "virtual"].iter().find_map(|key| match source.entries.get(*key) {
                Some(TomlValue::String(value)) => Some(value.value.clone()),
                _ => None,
            })
        }
        LockKind::Poetry => {
            let Some(TomlValue::Table(source)) = entry.entries.get("source") else { return None };
            if string_at(source, &["type"]).as_deref() != Some("directory") {
                return None;
            }
            string_at(source, &["url"])
        }
        LockKind::Pdm => string_at(entry, &["path"]),
    }
}

/// A lockfile (`uv.lock`, `poetry.lock`, `pdm.lock`, workspace-relative
/// `file`) with the `version` of every package locked from `target_dir` moved
/// to `version` — PEP 440 normalized as uv and PDM record it, as written for
/// Poetry. `None` when it records none. A package locked from a registry is a
/// pin and is left alone.
pub fn stamp_pypi_lockfile(text: &str, file: &str, target_name: &str, target_dir: &str, version: &str) -> Result<Option<String>, ReleaseError> {
    let kind = lock_kind(file)?;
    let spelled = if kind == LockKind::Poetry { Some(version.to_string()) } else { normalize_pypi_version(version) };
    let Some(spelled) = spelled else {
        return Err(err(format!("{file}: '{version}' is not a version PEP 440 can spell.")));
    };
    let doc = read_toml_document(text, file)?;
    let Some(TomlValue::Array { items: packages, .. }) = doc.entries.get("package") else { return Ok(None) };
    let mut edits: Vec<&TomlString> = Vec::new();
    for entry in packages {
        let TomlValue::Table(entry) = entry else { continue };
        if normalize_pypi_name(&string_at(entry, &["name"]).unwrap_or_default()) != normalize_pypi_name(target_name) {
            continue;
        }
        let Some(path) = locked_path(kind, entry) else { continue };
        if is_absolute_path(&path) || resolve_within(directory_of(file), &path).as_deref() != Some(target_dir) {
            continue;
        }
        match entry.entries.get("version") {
            None => continue,
            Some(TomlValue::String(recorded)) => edits.push(recorded),
            Some(_) => return Err(err(format!("{file}: the '{target_name}' package records a version that is not a string."))),
        }
    }
    edits.sort_by(|a, b| b.start.cmp(&a.start));
    let mut out = text.to_string();
    for edit in edits {
        let replacement = respell_toml_string(&out, edit, &spelled);
        out = splice_text(&out, edit.start, edit.end, &replacement);
    }
    Ok((out != text).then_some(out))
}

/// A Python value, as `json.dumps` writes it.
#[derive(Debug, Clone, PartialEq)]
enum PyValue {
    Null,
    Bool(bool),
    Int(String),
    Str(String),
    List(Vec<PyValue>),
    Map(IndexMap<String, PyValue>),
}

fn to_py(value: &TomlValue, at: &str) -> Result<PyValue, ReleaseError> {
    Ok(match value {
        TomlValue::String(s) => PyValue::Str(s.value.clone()),
        TomlValue::Boolean(b) => PyValue::Bool(*b),
        TomlValue::Integer(i) => PyValue::Int(i.clone()),
        TomlValue::Array { items, .. } => PyValue::List(items.iter().map(|item| to_py(item, at)).collect::<Result<_, _>>()?),
        TomlValue::Table(table) => {
            PyValue::Map(table.entries.iter().map(|(key, item)| Ok((key.clone(), to_py(item, at)?))).collect::<Result<_, ReleaseError>>()?)
        }
        other => {
            return Err(err(format!(
                "{at} holds a {} where a content hash is computed, which cannot be written as Python's json.dumps writes it.",
                other.kind()
            )));
        }
    })
}

fn py_string(value: &str) -> String {
    let mut out = String::from("\"");
    for unit in value.encode_utf16() {
        match unit {
            0x22 => out.push_str("\\\""),
            0x5c => out.push_str("\\\\"),
            0x0a => out.push_str("\\n"),
            0x0d => out.push_str("\\r"),
            0x09 => out.push_str("\\t"),
            0x08 => out.push_str("\\b"),
            0x0c => out.push_str("\\f"),
            unit if !(0x20..=0x7e).contains(&unit) => out.push_str(&format!("\\u{unit:04x}")),
            unit => out.push(unit as u8 as char),
        }
    }
    out.push('"');
    out
}

/// `json.dumps(value, sort_keys=True)`, byte for byte.
fn python_json(value: &PyValue) -> String {
    match value {
        PyValue::Null => "null".into(),
        PyValue::Bool(b) => if *b { "true" } else { "false" }.into(),
        PyValue::Int(i) => i.clone(),
        PyValue::Str(s) => py_string(s),
        PyValue::List(items) => format!("[{}]", items.iter().map(python_json).collect::<Vec<_>>().join(", ")),
        PyValue::Map(map) => {
            // Rust orders strings by UTF-8 bytes, which is code-point order.
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            format!("{{{}}}", keys.iter().map(|key| format!("{}: {}", py_string(key), python_json(&map[*key]))).collect::<Vec<_>>().join(", "))
        }
    }
}

fn py_at(doc: &TomlTable, path: &[&str], at: &str) -> Result<Option<PyValue>, ReleaseError> {
    toml_at(doc, path).map(|value| to_py(value, at)).transpose()
}

/// What Poetry hashes into `content-hash` (its `Locker._get_content_hash`).
fn poetry_hash_input(text: &str, at: &str) -> Result<String, ReleaseError> {
    let doc = read_toml_document(text, at)?;
    let mut project = IndexMap::new();
    for key in ["requires-python", "dependencies", "optional-dependencies"] {
        if let Some(value) = py_at(&doc, &["project", key], at)? {
            project.insert(key.to_string(), value);
        }
    }
    let legacy = ["dependencies", "source", "extras", "dev-dependencies"];
    let mut poetry = IndexMap::new();
    for key in legacy.iter().chain(&["group"]) {
        let value = py_at(&doc, &["tool", "poetry", *key], at)?;
        if value.is_none() && (!legacy.contains(key) || !project.is_empty()) {
            continue;
        }
        poetry.insert(key.to_string(), value.unwrap_or(PyValue::Null));
    }
    let relevant = if project.is_empty() {
        PyValue::Map(poetry)
    } else {
        let tool = IndexMap::from([("poetry".to_string(), PyValue::Map(poetry))]);
        PyValue::Map(IndexMap::from([("project".to_string(), PyValue::Map(project)), ("tool".to_string(), PyValue::Map(tool))]))
    };
    Ok(python_json(&relevant))
}

/// `name.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()`.
fn pdm_group_name(name: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            in_run = false;
        } else {
            if !in_run {
                out.push('-');
            }
            in_run = true;
        }
    }
    out.to_lowercase()
}

/// What PDM hashes into `content_hash` (its `PyProject.content_hash`).
fn pdm_hash_input(text: &str, at: &str) -> Result<String, ReleaseError> {
    let doc = read_toml_document(text, at)?;
    let mut groups: IndexMap<String, PyValue> = IndexMap::new();
    if let Some(PyValue::Map(declared)) = py_at(&doc, &["dependency-groups"], at)? {
        for (name, deps) in declared {
            let key = pdm_group_name(&name);
            if groups.contains_key(&key) {
                return Err(err(format!("{at}: the dependency group '{key}' is declared twice.")));
            }
            groups.insert(key, deps);
        }
    }
    if let Some(PyValue::Map(dev)) = py_at(&doc, &["tool", "pdm", "dev-dependencies"], at)? {
        for (name, deps) in dev {
            let key = pdm_group_name(&name);
            let mut merged = match groups.get(&key) {
                Some(PyValue::List(existing)) => existing.clone(),
                _ => Vec::new(),
            };
            if let PyValue::List(deps) = deps {
                merged.extend(deps);
            }
            groups.insert(key, PyValue::List(merged));
        }
    }
    let or = |value: Option<PyValue>, default: PyValue| value.unwrap_or(default);
    Ok(python_json(&PyValue::Map(IndexMap::from([
        ("sources".to_string(), or(py_at(&doc, &["tool", "pdm", "source"], at)?, PyValue::List(Vec::new()))),
        ("dependencies".to_string(), or(py_at(&doc, &["project", "dependencies"], at)?, PyValue::List(Vec::new()))),
        ("dev-dependencies".to_string(), PyValue::Map(groups)),
        ("optional-dependencies".to_string(), or(py_at(&doc, &["project", "optional-dependencies"], at)?, PyValue::Map(IndexMap::new()))),
        ("requires-python".to_string(), or(py_at(&doc, &["project", "requires-python"], at)?, PyValue::Str(String::new()))),
        ("resolution".to_string(), or(py_at(&doc, &["tool", "pdm", "resolution"], at)?, PyValue::Map(IndexMap::new()))),
    ]))))
}

/// A `poetry.lock` or `pdm.lock` whose content hash follows its project's
/// `pyproject.toml` from `before` to `after`, `sha256` giving a text's hex
/// digest. The recorded hash must be the one the tool computes from `before`:
/// otherwise the lockfile is already stale, or its tool hashes another way,
/// and a moved hash would claim a freshness nobody checked. `None` when the
/// lockfile records no content hash (`uv.lock`).
pub fn move_pypi_lock_content_hash(
    text: &str,
    file: &str,
    before: &str,
    after: &str,
    pyproject: &str,
    sha256: &dyn Fn(&str) -> String,
) -> Result<Option<String>, ReleaseError> {
    let kind = lock_kind(file)?;
    if kind == LockKind::Uv {
        return Ok(None);
    }
    let doc = read_toml_document(text, file)?;
    let recorded = match toml_at(&doc, &["metadata", if kind == LockKind::Poetry { "content-hash" } else { "content_hash" }]) {
        None => return Ok(None),
        Some(TomlValue::String(recorded)) => recorded,
        Some(_) => return Err(err(format!("{file}: its content hash is not a string."))),
    };
    let prefix = if kind == LockKind::Pdm { "sha256:" } else { "" };
    if !recorded.value.starts_with(prefix) {
        return Err(err(format!(
            "{file}: its content hash '{}' is not a sha256 one, so it cannot be moved with {pyproject}.",
            recorded.value
        )));
    }
    let input: fn(&str, &str) -> Result<String, ReleaseError> = if kind == LockKind::Poetry { poetry_hash_input } else { pdm_hash_input };
    let tool = if kind == LockKind::Poetry { "poetry lock" } else { "pdm lock" };
    if format!("{prefix}{}", sha256(&input(before, pyproject)?)) != recorded.value {
        return Err(err(format!(
            "{file}: its content hash is not the one {pyproject} as it stands gives, so it cannot be moved with the requirement a release rewrites there. Run `{tool}` so the lockfile matches {pyproject}, then apply again."
        )));
    }
    let moved = format!("{prefix}{}", sha256(&input(after, pyproject)?));
    Ok((moved != recorded.value).then(|| splice_text(text, recorded.start, recorded.end, &respell_toml_string(text, recorded, &moved))))
}

// ---------------------------------------------------------------------------
// The simple index
// ---------------------------------------------------------------------------

/// A file a project page lists; `href` as written, less its fragment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexFile {
    pub filename: String,
    pub href: String,
    pub sha256: Option<String>,
}

fn decode_entities(text: &str) -> String {
    const ENTITIES: [(&str, &str); 6] = [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&#x27;", "'")];
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        match ENTITIES.iter().find(|(entity, _)| rest.starts_with(entity)) {
            Some((entity, decoded)) => {
                out.push_str(decoded);
                rest = &rest[entity.len()..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// `(?:^|&)sha256=([0-9a-fA-F]{64})(?:&|$)` over a fragment.
fn fragment_sha256(fragment: &str) -> Option<String> {
    let starts = std::iter::once(0).chain(fragment.match_indices('&').map(|(i, _)| i + 1));
    for start in starts {
        let Some(rest) = fragment[start..].strip_prefix("sha256=") else { continue };
        let Some(hex) = rest.get(..64) else { continue };
        let after = &rest[64..];
        if hex.bytes().all(|c| c.is_ascii_hexdigit()) && (after.is_empty() || after.starts_with('&')) {
            return Some(hex.to_lowercase());
        }
    }
    None
}

fn without_fragment(href: &str) -> (String, Option<String>) {
    match href.split_once('#') {
        None => (href.to_string(), None),
        Some((base, fragment)) => (base.to_string(), fragment_sha256(fragment)),
    }
}

fn starts_with_ignore_case(text: &str, at: usize, token: &str) -> bool {
    text.as_bytes().get(at..at + token.len()).is_some_and(|run| run.eq_ignore_ascii_case(token.as_bytes()))
}

/// Where `</a\s*>` first ends at or after `from`, and where it starts.
fn closing_anchor(body: &str, from: usize) -> Option<(usize, usize)> {
    let mut at = from;
    while let Some(i) = body[at..].find('<') {
        let q = at + i;
        if starts_with_ignore_case(body, q, "</a") {
            let after = skip_js_spaces(body, q + 3);
            if body[after..].starts_with('>') {
                return Some((q, after + 1));
            }
        }
        at = q + 1;
    }
    None
}

/// One match of `<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>`
/// (case-insensitive) starting at `i`: its end, the href and the content.
fn anchor_at(body: &str, i: usize) -> Option<(usize, String, String)> {
    if !starts_with_ignore_case(body, i, "<a") {
        return None;
    }
    let space = body[i + 2..].chars().next().filter(|c| is_js_space(*c))?;
    let mut p = i + 2 + space.len_utf8();
    loop {
        if starts_with_ignore_case(body, p, "href") {
            let mut k = skip_js_spaces(body, p + 4);
            if body[k..].starts_with('=') {
                k = skip_js_spaces(body, k + 1);
                let mut values: Vec<(String, usize)> = Vec::new();
                for quote in ['"', '\''] {
                    if body[k..].starts_with(quote) {
                        if let Some(close) = body[k + 1..].find(quote) {
                            values.push((body[k + 1..k + 1 + close].to_string(), k + 1 + close + 1));
                        }
                    }
                }
                let bare = body[k..].find(|c: char| is_js_space(c) || c == '>').map_or(body.len(), |e| k + e);
                if bare > k {
                    values.push((body[k..bare].to_string(), bare));
                }
                for (href, after) in values {
                    let Some(gt) = body[after..].find('>') else { continue };
                    let content_start = after + gt + 1;
                    if let Some((close, end)) = closing_anchor(body, content_start) {
                        return Some((end, href, body[content_start..close].to_string()));
                    }
                }
            }
        }
        match body[p..].chars().next() {
            None | Some('>') => return None,
            Some(c) => p += c.len_utf8(),
        }
    }
}

/// `text.replace(/<[^>]*>/g, "")`.
fn strip_tags(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        match rest[i..].find('>') {
            Some(close) => rest = &rest[i + close + 1..],
            None => {
                rest = &rest[i..];
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The files a PEP 503 (HTML) or PEP 691 (JSON, when `json`) project page lists.
pub fn simple_index_files(body: &str, json: bool, at: &str) -> Result<Vec<IndexFile>, ReleaseError> {
    if json {
        let page: Value = serde_json::from_str(body).map_err(|_| err(format!("{at} is not a JSON project page.")))?;
        if page.is_null() {
            return Err(err("Cannot read properties of null (reading 'files')".into()));
        }
        let Some(files) = page.get("files").and_then(Value::as_array) else {
            return Err(err(format!("{at} lists no 'files'.")));
        };
        let mut found = Vec::new();
        for file in files {
            if file.is_null() {
                return Err(err("Cannot read properties of null (reading 'filename')".into()));
            }
            let (Some(filename), Some(url)) = (file.get("filename").and_then(Value::as_str), file.get("url").and_then(Value::as_str)) else {
                continue;
            };
            let (href, from_fragment) = without_fragment(url);
            let listed = file.get("hashes").and_then(|h| h.get("sha256")).and_then(Value::as_str).map(str::to_lowercase);
            found.push(IndexFile { filename: filename.to_string(), href, sha256: listed.or(from_fragment) });
        }
        return Ok(found);
    }
    let mut found = Vec::new();
    let mut i = 0;
    while i < body.len() {
        if let Some((end, href, content)) = anchor_at(body, i) {
            let (href, sha256) = without_fragment(&decode_entities(&href));
            found.push(IndexFile { filename: decode_entities(js_trim(&strip_tags(&content))), href, sha256 });
            i = end;
        } else {
            i += body[i..].chars().next().map_or(1, char::len_utf8);
        }
    }
    Ok(found)
}

/// `name-version` of a distribution file, as its filename spells them.
fn distribution_of(filename: &str) -> Option<(&str, &str)> {
    if let Some(base) = filename.strip_suffix(".tar.gz") {
        let dash = base.rfind('-').filter(|dash| *dash > 0)?;
        return Some((&base[..dash], &base[dash + 1..]));
    }
    if filename.ends_with(".whl") {
        let mut parts = filename.split('-');
        let name = parts.next().filter(|n| !n.is_empty())?;
        let version = parts.next().filter(|v| !v.is_empty())?;
        return Some((name, version));
    }
    None
}

/// The sdist of `name` at `version` a project page lists, `None` when it lists none.
pub fn sdist_in_index(files: &[IndexFile], name: &str, version: &str, at: &str) -> Result<Option<IndexFile>, ReleaseError> {
    let wanted = version_key(version);
    let matches: Vec<&IndexFile> = files
        .iter()
        .filter(|file| {
            file.filename.ends_with(".tar.gz")
                && distribution_of(&file.filename)
                    .is_some_and(|(dist, v)| normalize_pypi_name(dist) == normalize_pypi_name(name) && version_key(v) == wanted)
        })
        .collect();
    let hrefs: IndexSet<&str> = matches.iter().map(|file| file.href.as_str()).collect();
    if hrefs.len() > 1 {
        return Err(err(format!(
            "{at} lists {} sdists of {name} {version} ({}), so which one is published cannot be decided.",
            hrefs.len(),
            hrefs.iter().copied().collect::<Vec<_>>().join(", ")
        )));
    }
    Ok(matches.first().map(|file| (*file).clone()))
}

/// Every version a project page lists a distribution of, PEP 440 normalized.
pub fn versions_in_index(files: &[IndexFile], name: &str) -> Vec<String> {
    let mut versions = IndexSet::new();
    for file in files {
        let Some((dist, version)) = distribution_of(&file.filename) else { continue };
        if normalize_pypi_name(dist) != normalize_pypi_name(name) {
            continue;
        }
        if let Some(normalized) = normalize_pypi_version(version) {
            versions.insert(normalized);
        }
    }
    versions.into_iter().collect()
}

/// Where a distribution publishes: `<registry>/<normalized name>`.
pub fn pypi_destination(registry: &str, name: &str) -> String {
    format!("{}/{}", registry.trim_end_matches('/'), normalize_pypi_name(name))
}

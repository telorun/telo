//! `adopt changesets` — the one-time import of a changesets setup.
//!
//! Every workspace package becomes a `release.units` entry with
//! `ecosystem: npm`; `fixed` groups become `release.groups`; `ignore` becomes
//! `!` entries; each pending change file becomes one fragment of the same id
//! naming the same units with the same body (`major` / `minor` / `patch` →
//! `Changed` / `Added` / `Fixed`). The npm layers are then seeded from the
//! registry as `verify --write` records them, and `.changeset/` is deleted.
//! `linked` groups are refused. CI steps and `@changesets/*` dependencies are
//! listed, never rewritten.

use std::fs;
use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use serde_json::Value;

use crate::bump_level::FragmentKind;
use crate::fragment::{serialize_fragment, UnitKey};
use telorun_glob::{is_pruned, last_match_index, select_by_patterns, SelectOptions};
use crate::ledger::LEDGER_PATH;
use crate::marker_reader::{Severity, WORKSPACE_FILENAME};
use crate::yaml::{json_string, parse_json};
use crate::ReleaseError;

use super::evidence::Argv;
use super::host::ReleaseHost;
use super::ledger_store::{write_ledger, PENDING_DIR};
use super::operations::{load_workspace_for, verify_ledger};
use super::workspace::{absolute, directories_under};

pub struct AdoptResult {
    pub root: PathBuf,
    pub written: Vec<String>,
    pub deleted: Vec<String>,
    /// What the import did not rewrite: CI steps, dependencies, private packages.
    pub left_behind: Vec<String>,
}

#[derive(Clone)]
struct WorkspacePackage {
    name: String,
    dir: String,
    private: bool,
}

fn err(message: String) -> ReleaseError {
    ReleaseError::new(message)
}

fn read_json(file: &Path) -> Result<Value, ReleaseError> {
    let text = fs::read_to_string(file).map_err(|e| err(format!("{}: {e}", file.display())))?;
    serde_json::from_str(&text).map_err(|e| err(format!("{}: {e}", file.display())))
}

fn bump_kind(bump: &str) -> Option<FragmentKind> {
    match bump {
        "major" => Some(FragmentKind::Changed),
        "minor" => Some(FragmentKind::Added),
        "patch" => Some(FragmentKind::Fixed),
        _ => None,
    }
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        _ => Vec::new(),
    }
}

fn io(path: &Path, e: std::io::Error) -> ReleaseError {
    err(format!("{}: {e}", path.display()))
}

fn sorted_names(dir: &Path) -> Result<Vec<String>, ReleaseError> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map_err(|e| io(dir, e))?
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    Ok(names)
}

pub fn adopt_changesets(host: &ReleaseHost, from: &Path, argv: &Argv) -> Result<AdoptResult, ReleaseError> {
    let root = changesets_root(from)?;
    let config = read_json(&root.join(".changeset").join("config.json"))?;
    let linked: Vec<&Value> = match config.get("linked") {
        Some(Value::Array(groups)) => groups.iter().filter(|g| matches!(g, Value::Array(list) if !list.is_empty())).collect(),
        _ => Vec::new(),
    };
    if !linked.is_empty() {
        return Err(err(format!(
            ".changeset/config.json declares {} 'linked' group(s), which have no counterpart: a unit's version is its own, or shared whole by a group. Turn each into a 'fixed' group or remove it, then adopt.",
            linked.len()
        )));
    }
    let marker_file = root.join(WORKSPACE_FILENAME);
    let existing_marker = if marker_file.exists() { Some(fs::read_to_string(&marker_file).map_err(|e| io(&marker_file, e))?) } else { None };
    if let Some(existing) = &existing_marker {
        if let Ok(Value::Object(map)) = parse_json(existing) {
            if map.contains_key("release") {
                return Err(err(format!("{WORKSPACE_FILENAME} already declares 'release:', so there is nothing to adopt into.")));
            }
        }
    }

    let packages = workspace_packages(&root)?;
    let by_name: IndexMap<String, WorkspacePackage> = packages.iter().map(|p| (p.name.clone(), p.clone())).collect();
    let select = |patterns: Option<&Value>, at: &str| -> Result<Vec<WorkspacePackage>, ReleaseError> {
        let list = string_list(patterns);
        for pattern in &list {
            if !pattern.contains(['*', '?']) && !by_name.contains_key(pattern) {
                return Err(err(format!(".changeset/config.json {at} names '{pattern}', which is not a package of this workspace.")));
            }
        }
        Ok(packages
            .iter()
            .filter(|pkg| list.iter().any(|pattern| *pattern == pkg.name || last_match_index(&pkg.name, &[pattern]).is_some()))
            .cloned()
            .collect())
    };
    let ignored: Vec<String> = select(config.get("ignore"), "ignore")?.into_iter().map(|p| p.dir).collect();
    let mut left_behind = Vec::new();
    let mut units = Vec::new();
    let mut excluded: Vec<String> = Vec::new();
    for pkg in &packages {
        units.push(pkg.dir.clone());
        if ignored.contains(&pkg.dir) {
            excluded.push(pkg.dir.clone());
        } else if pkg.private {
            excluded.push(pkg.dir.clone());
            left_behind.push(format!(
                "{}: private package {} publishes nothing, so it is excluded ('!{}'). Declare its 'payload:' to version it.",
                pkg.dir, pkg.name, pkg.dir
            ));
        }
    }
    let fixed: Vec<Value> = match config.get("fixed") {
        Some(Value::Array(groups)) => groups.clone(),
        _ => Vec::new(),
    };
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for (index, group) in fixed.iter().enumerate() {
        let members: Vec<String> =
            select(Some(group), &format!("fixed[{index}]"))?.into_iter().map(|p| p.dir).filter(|dir| !excluded.contains(dir)).collect();
        if !members.is_empty() {
            groups.push((format!("fixed-{}", index + 1), members));
        }
    }

    let mut written = Vec::new();
    let mut marker: Vec<String> = Vec::new();
    if let Some(existing) = &existing_marker {
        marker.push(existing.trim_end().to_string());
        marker.push(String::new());
    }
    marker.push("release:".into());
    marker.push("  units:".into());
    for dir in &units {
        marker.push(format!("    - {{ path: {}, ecosystem: npm }}", yaml_scalar(dir)));
    }
    for dir in &excluded {
        marker.push(format!("    - {}", yaml_scalar(&format!("!{dir}"))));
    }
    if !groups.is_empty() {
        marker.push("  groups:".into());
        for (name, members) in &groups {
            marker.push(format!("    {name}: [{}]", members.iter().map(|m| yaml_scalar(m)).collect::<Vec<_>>().join(", ")));
        }
    }
    marker.push(String::new());
    fs::write(&marker_file, marker.join("\n")).map_err(|e| io(&marker_file, e))?;
    written.push(WORKSPACE_FILENAME.to_string());

    let changeset_dir = root.join(".changeset");
    let pending = root.join(PENDING_DIR);
    fs::create_dir_all(&pending).map_err(|e| io(&pending, e))?;
    for name in sorted_names(&changeset_dir)?.into_iter().filter(|n| n.ends_with(".md") && n != "README.md") {
        let file = changeset_dir.join(&name);
        let text = fs::read_to_string(&file).map_err(|e| io(&file, e))?;
        let (named, body) = read_changeset(&text, &format!(".changeset/{name}"), &by_name)?;
        let fragment = format!("{PENDING_DIR}/{}.yaml", &name[..name.len() - 3]);
        let kept: IndexMap<UnitKey, FragmentKind> = named.into_iter().filter(|(dir, _)| !excluded.contains(dir)).collect();
        if kept.is_empty() {
            left_behind.push(format!(".changeset/{name}: names only excluded packages, so no fragment was written."));
            continue;
        }
        let target = root.join(&fragment);
        fs::write(&target, serialize_fragment(&kept, &body)).map_err(|e| io(&target, e))?;
        written.push(fragment);
    }

    let workspace = load_workspace_for(host, &root)?;
    let verified = verify_ledger(host, &workspace, argv, &|_| {})?;
    if let Some(error) = verified.diagnostics.iter().find(|d| d.severity == Severity::Error) {
        return Err(err(format!("{}: {}", error.code, error.message)));
    }
    write_ledger(&root, &verified.ledger)?;
    written.push(LEDGER_PATH.to_string());

    let deleted: Vec<String> = sorted_names(&changeset_dir)?.into_iter().map(|name| format!(".changeset/{name}")).collect();
    fs::remove_dir_all(&changeset_dir).map_err(|e| io(&changeset_dir, e))?;

    left_behind.extend(changesets_mentions(&root, &packages)?);
    Ok(AdoptResult { root, written, deleted, left_behind })
}

fn changesets_root(from: &Path) -> Result<PathBuf, ReleaseError> {
    let start = absolute(from);
    let mut dir = start.clone();
    loop {
        if dir.join(".changeset").join("config.json").exists() {
            return Ok(dir);
        }
        if !dir.pop() {
            return Err(err(format!(
                "No .changeset/config.json in '{}' or any parent directory: nothing to adopt.",
                start.display()
            )));
        }
    }
}

fn yaml_scalar(value: &str) -> String {
    let plain = !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-'));
    if plain && !value.starts_with('!') {
        value.to_string()
    } else {
        json_string(value)
    }
}

/// The workspace packages, from `pnpm-workspace.yaml` or `package.json`'s
/// `workspaces`; with neither, the root package alone.
fn workspace_packages(root: &Path) -> Result<Vec<WorkspacePackage>, ReleaseError> {
    let mut patterns: Option<Vec<String>> = None;
    let pnpm = root.join("pnpm-workspace.yaml");
    if pnpm.exists() {
        let text = fs::read_to_string(&pnpm).map_err(|e| io(&pnpm, e))?;
        if let Ok(value) = parse_json(&text) {
            if let Some(Value::Array(_)) = value.get("packages") {
                patterns = Some(string_list(value.get("packages")));
            }
        }
    }
    let root_manifest = read_json(&root.join("package.json"))?;
    if patterns.is_none() {
        patterns = match root_manifest.get("workspaces") {
            Some(list @ Value::Array(_)) => Some(string_list(Some(list))),
            Some(Value::Object(map)) if matches!(map.get("packages"), Some(Value::Array(_))) => Some(string_list(map.get("packages"))),
            _ => None,
        };
    }
    let mut dirs = match patterns {
        Some(patterns) => {
            let trimmed: Vec<String> = patterns.iter().map(|p| p.trim_end_matches('/').to_string()).collect();
            select_by_patterns(&directories_under(root), &trimmed, &SelectOptions { apply_default_ignore: Some(false), exclude: Vec::new() })
        }
        None => vec![String::new()],
    };
    dirs.sort();
    let mut packages = Vec::new();
    for dir in dirs {
        if dir.split('/').any(is_pruned) {
            continue;
        }
        let file = root.join(&dir).join("package.json");
        if !file.exists() {
            continue;
        }
        let pkg = read_json(&file)?;
        let (Some(name), Some(_)) = (pkg.get("name").and_then(Value::as_str), pkg.get("version").and_then(Value::as_str)) else { continue };
        packages.push(WorkspacePackage {
            name: name.to_string(),
            dir: if dir.is_empty() { ".".into() } else { dir.clone() },
            private: pkg.get("private") == Some(&Value::Bool(true)),
        });
    }
    Ok(packages)
}

/// `/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/`: front matter and body.
fn split_front_matter(text: &str) -> Option<(&str, &str)> {
    let rest = text.strip_prefix("---\r\n").or_else(|| text.strip_prefix("---\n"))?;
    let offset = text.len() - rest.len();
    for (k, _) in rest.char_indices() {
        let tail = &rest[k..];
        let after = tail.strip_prefix("\r\n---").or_else(|| tail.strip_prefix("\n---"));
        if let Some(after) = after {
            let after = after.strip_prefix('\r').unwrap_or(after);
            let after = after.strip_prefix('\n').unwrap_or(after);
            return Some((&text[offset..offset + k], after));
        }
    }
    None
}

fn read_changeset(
    text: &str,
    at: &str,
    by_name: &IndexMap<String, WorkspacePackage>,
) -> Result<(IndexMap<UnitKey, FragmentKind>, String), ReleaseError> {
    let Some((front, body)) = split_front_matter(text) else {
        return Err(err(format!("{at} has no '---' front matter naming its packages.")));
    };
    let front = match parse_json(front) {
        Ok(Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    let mut units = IndexMap::new();
    for (name, bump) in &front {
        let Some(pkg) = by_name.get(name) else {
            return Err(err(format!("{at} names '{name}', which is not a package of this workspace.")));
        };
        let Some(kind) = bump.as_str().and_then(bump_kind) else {
            let shown = match bump {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            return Err(err(format!("{at} gives '{name}' the bump '{shown}'; expected major, minor or patch.")));
        };
        units.insert(pkg.dir.clone(), kind);
    }
    Ok((units, body.trim().to_string()))
}

/// `/\bchangeset\b/`
fn names_changeset_word(text: &str) -> bool {
    let word = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
    text.match_indices("changeset").any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + "changeset".len()..].chars().next();
        !word(before) && !word(after)
    })
}

/// CI lines and dependencies that still name changesets.
fn changesets_mentions(root: &Path, packages: &[WorkspacePackage]) -> Result<Vec<String>, ReleaseError> {
    let mut found = Vec::new();
    let workflows = root.join(".github").join("workflows");
    if workflows.exists() {
        for name in sorted_names(&workflows)?.into_iter().filter(|n| n.ends_with(".yml") || n.ends_with(".yaml")) {
            let file = workflows.join(&name);
            let text = fs::read_to_string(&file).map_err(|e| io(&file, e))?;
            for (index, line) in text.split('\n').enumerate() {
                if line.to_lowercase().contains("changeset") {
                    found.push(format!(".github/workflows/{name}:{}: {}", index + 1, line.trim()));
                }
            }
        }
    }
    let mut manifests: Vec<String> = vec![".".into()];
    for pkg in packages {
        if !manifests.contains(&pkg.dir) {
            manifests.push(pkg.dir.clone());
        }
    }
    for dir in manifests {
        let file = root.join(&dir).join("package.json");
        if !file.exists() {
            continue;
        }
        let pkg = read_json(&file)?;
        let prefix = if dir == "." { String::new() } else { format!("{dir}/") };
        for section in ["dependencies", "devDependencies"] {
            if let Some(Value::Object(deps)) = pkg.get(section) {
                for name in deps.keys().filter(|n| n.starts_with("@changesets/")) {
                    found.push(format!("{prefix}package.json: {section}.{name}"));
                }
            }
        }
        if let Some(Value::Object(scripts)) = pkg.get("scripts") {
            for (script, command) in scripts {
                if let Some(command) = command.as_str().filter(|c| names_changeset_word(c)) {
                    found.push(format!("{prefix}package.json: scripts.{script}: {command}"));
                }
            }
        }
    }
    Ok(found)
}

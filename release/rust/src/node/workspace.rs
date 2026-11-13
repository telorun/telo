//! The workspace on disk: the marker found by walking up, its `release:` block
//! read against the host's adapters, and its units resolved against the tree.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::adapter::{AdapterRegistry, EcosystemAdapter};
use telorun_glob::is_pruned;
use crate::marker_reader::{WorkspaceDiagnostic, WORKSPACE_FILENAME};
use crate::release_plan::ReleaseDiagnostic;
use crate::release_settings::{read_release_marker, require_release_settings, ReadReleaseOptions, ReleaseMarkerRead, ReleaseSettings};
use crate::units::{resolve_units, ResolvedUnit, WorkspaceTree};
use crate::ReleaseError;

use super::files_digest::relative_posix;

/// What a host's marker reader answers: the release block, and every
/// diagnostic it reports about the file.
pub struct MarkerRead {
    pub release: Option<ReleaseSettings>,
    pub diagnostics: Vec<WorkspaceDiagnostic>,
    pub extra: Vec<ReleaseDiagnostic>,
}

/// How a host reads its marker.
pub type MarkerReader = dyn Fn(&str, &Path, &[String]) -> Result<MarkerRead, ReleaseError>;

pub struct ReleaseWorkspace {
    /// The directory holding the marker.
    pub root: PathBuf,
    pub release: ReleaseSettings,
    pub units: Vec<ResolvedUnit>,
    pub diagnostics: Vec<ReleaseDiagnostic>,
    pub tree: DiskTree,
    pub adapters: AdapterRegistry,
}

/// The nearest directory at or above `from` holding the marker.
pub fn find_workspace_root(from: &Path) -> Option<PathBuf> {
    let mut dir = absolute(from);
    loop {
        if dir.join(WORKSPACE_FILENAME).exists() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

pub(crate) fn absolute(path: &Path) -> PathBuf {
    let joined = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(path) };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub struct LoadOptions<'a> {
    pub adapters: &'a [Arc<dyn EcosystemAdapter>],
    pub ecosystem_hosts: &'a ReadReleaseOptions,
    pub read_marker: Option<&'a MarkerReader>,
    /// The command a refusal tells the reader to run.
    pub command: &'a str,
}

pub fn load_release_workspace(from: &Path, options: &LoadOptions<'_>) -> Result<ReleaseWorkspace, ReleaseError> {
    let Some(root) = find_workspace_root(from) else {
        return Err(ReleaseError::new(format!(
            "No {WORKSPACE_FILENAME} found in '{}' or any parent directory. `{}` works over a declared workspace — create one at the repo root listing its units:\n\n  release:\n    units:\n      - {{ path: packages/*, ecosystem: npm }}\n",
            absolute(from).display(),
            options.command
        )));
    };
    let marker = root.join(WORKSPACE_FILENAME);
    let text = fs::read_to_string(&marker).map_err(|err| ReleaseError::new(format!("{}: {err}", marker.display())))?;
    let directories = directories_under(&root);
    let read = match options.read_marker {
        Some(reader) => reader(&text, &root, &directories)?,
        None => {
            let read = read_release_marker(&text, WORKSPACE_FILENAME, options.adapters, options.ecosystem_hosts)?;
            MarkerRead { release: read.release, diagnostics: read.diagnostics, extra: Vec::new() }
        }
    };
    let release = require_release_settings(
        &ReleaseMarkerRead { release: read.release, diagnostics: read.diagnostics },
        WORKSPACE_FILENAME,
    )?;
    let adapters = AdapterRegistry::new(options.adapters)?;
    let tree = DiskTree { root: root.clone(), directories };
    let resolution = resolve_units(&release, &tree, &adapters);
    let mut diagnostics = read.extra;
    diagnostics.extend(resolution.diagnostics.into_iter().map(|d| ReleaseDiagnostic {
        severity: d.severity,
        code: d.code.to_string(),
        message: format!("{WORKSPACE_FILENAME}: {}", d.message),
    }));
    Ok(ReleaseWorkspace { root, release, units: resolution.units, diagnostics, tree, adapters })
}

fn sorted_entries(dir: &Path) -> Vec<fs::DirEntry> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut entries: Vec<fs::DirEntry> = entries.filter_map(Result::ok).collect();
    entries.sort_by_key(|entry| entry.file_name());
    entries
}

/// Workspace-relative directories, pruned as discovery prunes.
pub fn directories_under(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    fn walk(root: &Path, dir: &Path, found: &mut Vec<String>) {
        for entry in sorted_entries(dir) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) || is_pruned(&name) {
                continue;
            }
            let child = entry.path();
            found.push(relative_posix(root, &child));
            walk(root, &child, found);
        }
    }
    walk(root, root, &mut found);
    found
}

/// The tree as the disk holds it.
pub struct DiskTree {
    root: PathBuf,
    directories: Vec<String>,
}

impl WorkspaceTree for DiskTree {
    fn directories(&self) -> &[String] {
        &self.directories
    }

    fn files_under(&self, dir: &str) -> Vec<String> {
        let base = self.root.join(dir);
        let mut found = Vec::new();
        fn walk(base: &Path, current: &Path, found: &mut Vec<String>) {
            for entry in sorted_entries(current) {
                let name = entry.file_name().to_string_lossy().into_owned();
                if is_pruned(&name) {
                    continue;
                }
                let child = entry.path();
                match entry.file_type() {
                    Ok(kind) if kind.is_dir() => walk(base, &child, found),
                    Ok(kind) if kind.is_file() => found.push(relative_posix(base, &child)),
                    _ => {}
                }
            }
        }
        walk(&base, &base, &mut found);
        found
    }

    fn read_file(&self, relative: &str) -> Option<String> {
        read_text(&self.root, relative)
    }
}

/// A workspace-relative file's text, `None` when absent.
pub fn read_text(root: &Path, relative: &str) -> Option<String> {
    let file = root.join(relative);
    if !file.is_file() {
        return None;
    }
    fs::read(&file).ok().map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// Read a workspace-relative file, `None` when absent.
pub fn read_workspace_file(workspace: &ReleaseWorkspace, relative: &str) -> Option<String> {
    read_text(&workspace.root, relative)
}

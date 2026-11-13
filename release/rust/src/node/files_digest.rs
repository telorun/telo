//! The one digest every layer is taken with: a file set, never archive bytes.
//!
//! SHA-256 over the sorted lines of every file — `<path>\0<sha256(content)>`,
//! an executable file `…\0x`, a symbolic link `<path>\0l\0<target>` — returned
//! as `sha256-<base64url>`, so a file set packed locally and one unpacked from
//! a registry give one number.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};

use crate::ledger::LEDGER_PATH;
use crate::ReleaseError;

/// The planner's own bookkeeping, workspace-relative: the ledger and the
/// pending fragments. No layer holds it — `apply` rewrites it after the layers
/// are read, so a layer reaching it (a build context at the root, a `**`
/// payload) would move with every release it records.
pub fn bookkeeping_dir() -> &'static str {
    LEDGER_PATH.rsplit_once('/').map_or(".", |(dir, _)| dir)
}

/// Whether a workspace-relative path lies in [`bookkeeping_dir`].
pub fn is_bookkeeping(workspace_relative: &str) -> bool {
    let dir = bookkeeping_dir();
    workspace_relative == dir || workspace_relative.strip_prefix(dir).is_some_and(|rest| rest.starts_with('/'))
}

/// The entries of a file set named relative to the workspace directory `dir`,
/// less the bookkeeping.
pub fn without_bookkeeping(entries: Vec<FileSetEntry>, dir: &str) -> Vec<FileSetEntry> {
    entries
        .into_iter()
        .filter(|entry| !is_bookkeeping(&if dir.is_empty() { entry.path().to_string() } else { format!("{dir}/{}", entry.path()) }))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileSetEntry {
    File { path: String, content: Vec<u8>, executable: bool },
    Link { path: String, link: String },
}

impl FileSetEntry {
    pub fn path(&self) -> &str {
        match self {
            FileSetEntry::File { path, .. } | FileSetEntry::Link { path, .. } => path,
        }
    }

    pub fn renamed(self, to: String) -> FileSetEntry {
        match self {
            FileSetEntry::File { content, executable, .. } => FileSetEntry::File { path: to, content, executable },
            FileSetEntry::Link { link, .. } => FileSetEntry::Link { path: to, link },
        }
    }
}

fn sha256(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

pub fn digest_file_set(entries: &[FileSetEntry]) -> Result<String, ReleaseError> {
    let mut lines: Vec<Vec<u16>> = Vec::new();
    let mut seen = HashSet::new();
    for entry in entries {
        if !seen.insert(entry.path().to_string()) {
            return Err(ReleaseError::new(format!("'{}' is listed twice in one file set.", entry.path())));
        }
        let line = match entry {
            FileSetEntry::Link { path, link } => format!("{path}\0l\0{link}"),
            FileSetEntry::File { path, content, executable } => {
                let digest = URL_SAFE_NO_PAD.encode(sha256(content));
                if *executable { format!("{path}\0{digest}\0x") } else { format!("{path}\0{digest}") }
            }
        };
        lines.push(line.encode_utf16().collect());
    }
    // JavaScript sorts strings by UTF-16 code unit.
    lines.sort();
    let joined: Vec<String> = lines.iter().map(|units| String::from_utf16_lossy(units)).collect();
    Ok(format!("sha256-{}", URL_SAFE_NO_PAD.encode(sha256(joined.join("\n").as_bytes()))))
}

/// One file of a directory as the kind it is — a link never followed, a file
/// with any execute bit executable — named `as_name`.
pub fn read_file_set_entry(dir: &Path, relative: &str, as_name: &str) -> Result<FileSetEntry, ReleaseError> {
    let abs = dir.join(relative);
    let io = |err: std::io::Error| ReleaseError::new(format!("{}: {err}", abs.display()));
    let stat = fs::symlink_metadata(&abs).map_err(io)?;
    if stat.file_type().is_symlink() {
        let link = fs::read_link(&abs).map_err(io)?;
        return Ok(FileSetEntry::Link { path: as_name.to_string(), link: link.to_string_lossy().replace('\\', "/") });
    }
    if !stat.is_file() {
        return Err(ReleaseError::new(format!("'{relative}' is neither a regular file nor a symbolic link.")));
    }
    let content = fs::read(&abs).map_err(io)?;
    Ok(FileSetEntry::File { path: as_name.to_string(), content, executable: executable(&stat) })
}

#[cfg(unix)]
fn executable(stat: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    stat.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn executable(_stat: &fs::Metadata) -> bool {
    false
}

/// Every file beneath `dir`, `/`-separated and relative to it, skipping the
/// directories `prune` names.
pub fn list_files(dir: &Path, prune: &dyn Fn(&str) -> bool) -> Result<Vec<String>, ReleaseError> {
    let mut found = Vec::new();
    walk(dir, dir, prune, &mut found)?;
    found.sort();
    Ok(found)
}

fn walk(root: &Path, current: &Path, prune: &dyn Fn(&str) -> bool, found: &mut Vec<String>) -> Result<(), ReleaseError> {
    let entries = fs::read_dir(current).map_err(|err| ReleaseError::new(format!("{}: {err}", current.display())))?;
    let mut entries: Vec<fs::DirEntry> = entries.filter_map(Result::ok).collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if prune(&name) {
            continue;
        }
        let full = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            walk(root, &full, prune, found)?;
        } else if kind.is_file() || kind.is_symlink() {
            found.push(relative_posix(root, &full));
        }
    }
    Ok(())
}

/// `path.relative(root, full)` with `/` separators.
pub fn relative_posix(root: &Path, full: &Path) -> String {
    let relative = full.strip_prefix(root).unwrap_or(full);
    relative.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/")
}

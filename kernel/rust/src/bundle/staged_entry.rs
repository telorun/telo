//! A staged file measured against the `sources:` entry that stages it. Mirrors
//! `../../../nodejs/src/bundle/staged-entry.ts` — the one rule `telo release
//! stage`, publish and both kernels apply to a source checkout, so a file one of
//! them accepts none of the others refuses.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use sha2::{Digest, Sha256};
use telo_analyzer::source_entries::{ModuleSource, SourceEntry};

/// What is on disk at a staged path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StagedEntryState {
    Match,
    Unpinned,
    Missing(String),
    Mismatch(String),
}

/// Check a staged entry against its declaration: a file's bytes and execute bit
/// against its pin, a link's stored target against `target`. A link is followed
/// through the entries of its own source, so it matches only when the file at the
/// end of the chain does.
pub fn check_staged_entry(
    dir: &Path,
    source: &ModuleSource,
    entry: &SourceEntry,
) -> std::io::Result<StagedEntryState> {
    let mut visited: Vec<&str> = Vec::new();
    let mut current = entry;
    loop {
        let via = if std::ptr::eq(current, entry) {
            String::new()
        } else {
            format!("through the link to '{}', ", current.path())
        };
        visited.push(current.path());
        let abs = dir.join(current.path());
        let metadata = match fs::symlink_metadata(&abs) {
            Ok(metadata) => Some(metadata),
            Err(err) if matches!(err.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => None,
            Err(err) => return Err(err),
        };
        match current {
            SourceEntry::Link { path, target, resolved, .. } => {
                let Some(metadata) = metadata else {
                    return Ok(StagedEntryState::Missing(format!("{via}'{path}' is not on disk")));
                };
                let stored = if metadata.file_type().is_symlink() {
                    Some(fs::read_link(&abs)?.to_string_lossy().replace('\\', "/"))
                } else {
                    None
                };
                if stored.as_deref() != Some(target.as_str()) {
                    return Ok(StagedEntryState::Mismatch(format!(
                        "{via}'{path}' is not a symbolic link to '{target}'"
                    )));
                }
                match source.entries.iter().find(|candidate| candidate.path() == resolved) {
                    Some(next) if !visited.contains(&next.path()) => current = next,
                    _ => {
                        return Ok(StagedEntryState::Mismatch(format!(
                            "{via}the link '{path}' does not lead to a file entry of source '{}'",
                            source.name
                        )))
                    }
                }
            }
            SourceEntry::File { path, pin, .. } => {
                let Some(pin) = pin else {
                    return Ok(StagedEntryState::Unpinned);
                };
                let Some(metadata) = metadata else {
                    return Ok(StagedEntryState::Missing(format!("{via}'{path}' is not on disk")));
                };
                if !metadata.is_file() {
                    return Ok(StagedEntryState::Mismatch(format!("{via}'{path}' is not a regular file")));
                }
                let executable = is_executable(&metadata);
                // Windows has no execute bit, so every file reads as not
                // executable there; the bytes are what can be verified.
                if cfg!(unix) && executable != pin.executable {
                    return Ok(StagedEntryState::Mismatch(format!(
                        "{via}'{path}' is {}executable, but the pin says executable: {}",
                        if executable { "" } else { "not " },
                        pin.executable
                    )));
                }
                let digest: String = Sha256::digest(fs::read(&abs)?)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect();
                if digest != pin.sha256 {
                    return Ok(StagedEntryState::Mismatch(format!(
                        "{via}'{path}' hashes to sha256 {digest}, but the pin is {}",
                        pin.sha256
                    )));
                }
                return Ok(StagedEntryState::Match);
            }
        }
    }
}

#[cfg(unix)]
fn is_executable(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

/// Windows carries no execute bit; the caller does not compare it there.
#[cfg(windows)]
fn is_executable(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use telo_analyzer::source_entries::read_module_sources;

    #[cfg(unix)]
    #[test]
    fn matches_mismatches_and_misses_as_the_node_rule_does() {
        let dir = tempfile::tempdir().unwrap();
        let sha: String = Sha256::digest(b"bar").iter().map(|b| format!("{b:02x}")).collect();
        let owner = json!({ "sources": { "lib": {
            "version": "1", "url": "https://e.test/x.tgz", "archive": "tar.gz", "notices": ["L"],
            "entries": {
                "native/libx.so.1": { "upstream": "x", "member": "m", "sha256": sha, "executable": false },
                "native/libx.so": { "target": "libx.so.1" },
                "native/unpinned.so": { "upstream": "x", "member": "m" },
            },
        } } });
        let read = read_module_sources(&owner);
        assert_eq!(read.problems, []);
        let source = &read.sources[0];
        let entry = |path: &str| source.entries.iter().find(|e| e.path() == path).unwrap();
        let check = |path: &str| check_staged_entry(dir.path(), source, entry(path)).unwrap();

        assert!(matches!(check("native/libx.so"), StagedEntryState::Missing(_)));
        assert_eq!(check("native/unpinned.so"), StagedEntryState::Unpinned);
        fs::create_dir_all(dir.path().join("native")).unwrap();
        fs::write(dir.path().join("native/libx.so.1"), "bar").unwrap();
        std::os::unix::fs::symlink("libx.so.1", dir.path().join("native/libx.so")).unwrap();
        assert_eq!(check("native/libx.so"), StagedEntryState::Match);
        fs::write(dir.path().join("native/libx.so.1"), "tampered").unwrap();
        assert!(matches!(check("native/libx.so"), StagedEntryState::Mismatch(detail) if detail.contains("through the link")));
    }
}

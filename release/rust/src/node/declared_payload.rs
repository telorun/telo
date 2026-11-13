//! A unit's declared `payload:` — patterns, or a command printing the paths —
//! as one more layer, digested under unit-relative names. The planner's own
//! bookkeeping (`.changes/`) is never part of it, whichever form selects it.
//!
//! A command runs in the unit's directory and prints one unit-relative path per
//! line. A non-zero exit, a path naming no file, a path printed twice, or one
//! leaving the workspace fails the plan.

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

use telorun_glob::{is_pruned, select_by_patterns, SelectOptions};
use crate::release_settings::PayloadSpec;
use crate::units::ResolvedUnit;
use crate::ReleaseError;

use super::files_digest::{digest_file_set, is_bookkeeping, list_files, read_file_set_entry, relative_posix};
use super::workspace::absolute;

pub struct DeclaredPayload {
    pub digest: String,
    /// Workspace-relative.
    pub files: Vec<String>,
}

pub fn declared_payload(root: &Path, unit: &ResolvedUnit) -> Result<DeclaredPayload, ReleaseError> {
    let unit_dir = root.join(&unit.dir);
    let selected = match unit.payload.as_ref().expect("a declared payload") {
        PayloadSpec::Patterns(patterns) => select_by_patterns(
            &list_files(&unit_dir, &is_pruned)?,
            patterns,
            &SelectOptions { apply_default_ignore: Some(false), exclude: Vec::new() },
        ),
        PayloadSpec::Command(command) => command_paths(root, unit, command)?,
    };
    let from_root = |file: &str| relative_posix(&absolute(root), &absolute(&unit_dir.join(file)));
    let relative: Vec<String> = selected.into_iter().filter(|file| !is_bookkeeping(&from_root(file))).collect();
    let entries = relative.iter().map(|file| read_file_set_entry(&unit_dir, file, file)).collect::<Result<Vec<_>, _>>()?;
    let mut files: Vec<String> = relative.iter().map(|file| from_root(file)).collect();
    files.sort();
    Ok(DeclaredPayload { digest: digest_file_set(&entries)?, files })
}

/// The command a shell runs, the way Node's `shell: true` spawns it.
pub(crate) fn shell(command: &str) -> Command {
    if cfg!(windows) {
        let mut run = Command::new("cmd.exe");
        run.args(["/d", "/s", "/c", command]);
        run
    } else {
        let mut run = Command::new("/bin/sh");
        run.args(["-c", command]);
        run
    }
}

fn exit_text(status: std::process::ExitStatus) -> String {
    if let Some(code) = status.code() {
        return code.to_string();
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return format!("on signal {signal}");
        }
    }
    "on a signal".into()
}

fn command_paths(root: &Path, unit: &ResolvedUnit, command: &str) -> Result<Vec<String>, ReleaseError> {
    let unit_dir = root.join(&unit.dir);
    let at = format!("unit '{}' payload command `{command}`", unit.key);
    let run = shell(command)
        .current_dir(&unit_dir)
        .stdin(Stdio::null())
        .output()
        .map_err(|err| ReleaseError::new(format!("{at} could not start: {err}")))?;
    if !run.status.success() {
        let stderr = String::from_utf8_lossy(&run.stderr).trim().to_string();
        return Err(ReleaseError::new(format!(
            "{at} exited {}{}",
            exit_text(run.status),
            if stderr.is_empty() { String::new() } else { format!(": {stderr}") }
        )));
    }
    let stdout = String::from_utf8_lossy(&run.stdout).into_owned();
    let root_abs = absolute(root);
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    for raw in stdout.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw).trim();
        if line.is_empty() {
            continue;
        }
        let posix = line.replace('\\', "/");
        let posix = posix.strip_prefix("./").map(str::to_string).unwrap_or(posix);
        let abs = absolute(&unit_dir.join(&posix));
        let from_root = relative_text(&root_abs, &abs);
        if Path::new(&posix).is_absolute() || from_root.starts_with("..") {
            return Err(ReleaseError::new(format!("{at} printed '{line}', which is outside the workspace.")));
        }
        if !seen.insert(posix.clone()) {
            return Err(ReleaseError::new(format!("{at} printed '{line}' twice.")));
        }
        let Ok(stat) = fs::symlink_metadata(&abs) else {
            return Err(ReleaseError::new(format!("{at} printed '{line}', which names no file.")));
        };
        if !stat.is_file() && !stat.file_type().is_symlink() {
            return Err(ReleaseError::new(format!("{at} printed '{line}', which is not a file.")));
        }
        paths.push(posix);
    }
    paths.sort();
    Ok(paths)
}

/// `path.relative(from, to)` for two normalized absolute paths.
pub(crate) fn relative_text(from: &Path, to: &Path) -> String {
    let a: Vec<_> = from.components().collect();
    let b: Vec<_> = to.components().collect();
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let mut parts: Vec<String> = std::iter::repeat_n("..".to_string(), a.len() - common).collect();
    parts.extend(b[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    parts.join("/")
}

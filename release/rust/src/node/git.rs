//! The git reads a release takes: the files changed since a base, a file as a
//! commit holds it, and the release tags.

use std::path::Path;
use std::process::{Command, Stdio};

use crate::ReleaseError;

/// `git <args>` in `cwd`: its stdout, or a refusal carrying its stderr.
pub(crate) fn git(cwd: &Path, args: &[&str]) -> Result<String, ReleaseError> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .map_err(|err| ReleaseError::new(format!("git could not start: {err}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ReleaseError::new(format!(
            "Command failed: git {}\n{}",
            args.join(" "),
            stderr.trim_end()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The files changed since a base ref: the plain `base...HEAD` name list.
/// Refuses when git cannot answer (no merge base, a shallow clone).
pub fn changed_files_since_base(cwd: &Path, base_ref: &str) -> Result<Vec<String>, ReleaseError> {
    let output = git(cwd, &["diff", "--name-only", &format!("{base_ref}...HEAD")])?;
    Ok(output.split('\n').map(str::trim).filter(|line| !line.is_empty()).map(str::to_string).collect())
}

/// `path` (relative to `cwd`) as `rev` holds it, or `None` when it holds none.
pub fn file_at(cwd: &Path, rev: &str, path: &str) -> Result<Option<String>, ReleaseError> {
    if git(cwd, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")]).is_err() {
        return Ok(None);
    }
    let prefix = git(cwd, &["rev-parse", "--show-prefix"])?.trim().to_string();
    let full = format!("{prefix}{path}");
    let listed = git(cwd, &["ls-tree", "--name-only", "--full-tree", rev, "--", &full])?;
    if listed.trim().is_empty() {
        return Ok(None);
    }
    git(cwd, &["show", &format!("{rev}:{full}")]).map(Some)
}

/// The commit a tag points at, or `None` when the tag does not exist.
pub fn tag_commit(cwd: &Path, tag: &str) -> Option<String> {
    let found = git(cwd, &["rev-parse", "--verify", "--quiet", &format!("refs/tags/{tag}^{{commit}}")]).ok()?;
    let found = found.trim();
    (!found.is_empty()).then(|| found.to_string())
}

pub fn head_commit(cwd: &Path) -> Result<String, ReleaseError> {
    Ok(git(cwd, &["rev-parse", "HEAD"])?.trim().to_string())
}

pub fn create_tag(cwd: &Path, tag: &str) -> Result<(), ReleaseError> {
    git(cwd, &["tag", tag, "HEAD"]).map(|_| ())
}

//! Which change files (changesets, release fragments) in a tree another ref
//! already carries — read from git history alone.
//!
//! A file of `at`'s tree is CARRIED by `ref` when a file of the same path and
//! the same blob is present at their merge base, or was written on a commit
//! between the merge base and `ref`. It is RELEASED by `ref` when it is carried
//! and `ref`'s own tree no longer holds it. It knows no branch or tag names.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;

use super::git::git as plain_git;
use crate::ReleaseError;

pub struct CarriedQuery<'a> {
    /// Any directory inside the repository; `files` are relative to it.
    pub cwd: &'a Path,
    pub files: &'a [String],
    pub reference: &'a str,
    /// The tree the files are read from. Default `HEAD`.
    pub at: Option<&'a str>,
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, ReleaseError> {
    let mut all = vec!["--literal-pathspecs"];
    all.extend_from_slice(args);
    plain_git(cwd, &all)
}

fn with_paths<'a>(head: &[&'a str], paths: &'a [String]) -> Vec<&'a str> {
    let mut args = head.to_vec();
    args.push("--");
    args.extend(paths.iter().map(String::as_str));
    args
}

/// `path -> blob` of `paths` in `rev`'s tree, paths from the repository root.
fn tree_blobs(top: &Path, rev: &str, paths: &[String]) -> Result<HashMap<String, String>, ReleaseError> {
    let mut blobs = HashMap::new();
    for entry in git(top, &with_paths(&["ls-tree", "-z", "--full-tree", rev], paths))?.split('\0') {
        let Some(tab) = entry.find('\t') else { continue };
        let meta: Vec<&str> = entry[..tab].split(' ').collect();
        if meta.get(1) == Some(&"blob") {
            if let Some(blob) = meta.get(2) {
                blobs.insert(entry[tab + 1..].to_string(), blob.to_string());
            }
        }
    }
    Ok(blobs)
}

/// `path -> blobs` written to `paths` on the commits of `range`.
fn written_blobs(top: &Path, range: &str, paths: &[String]) -> Result<HashMap<String, HashSet<String>>, ReleaseError> {
    let mut written: HashMap<String, HashSet<String>> = HashMap::new();
    let output = git(top, &with_paths(&["log", "--raw", "-z", "--no-renames", "--no-abbrev", "--format=", range], paths))?;
    let tokens: Vec<&str> = output.split('\0').filter(|t| !t.is_empty()).collect();
    let mut i = 0;
    while i + 1 < tokens.len() {
        if !tokens[i].starts_with(':') {
            i += 1;
            continue;
        }
        let meta: Vec<&str> = tokens[i].split(' ').collect();
        let blob = meta.get(3).copied().unwrap_or("");
        let status = meta.get(4).copied().unwrap_or("");
        i += 1;
        let path = tokens[i];
        if status == "A" || status == "M" {
            written.entry(path.to_string()).or_default().insert(blob.to_string());
        }
        i += 1;
    }
    Ok(written)
}

struct Walk {
    carried: BTreeSet<String>,
    released: BTreeSet<String>,
}

fn walk(query: &CarriedQuery<'_>) -> Result<Walk, ReleaseError> {
    let mut carried = BTreeSet::new();
    let mut released = BTreeSet::new();
    if query.files.is_empty() {
        return Ok(Walk { carried, released });
    }
    let top = git(query.cwd, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    let top = Path::new(&top);
    let prefix = git(query.cwd, &["rev-parse", "--show-prefix"])?.trim().to_string();
    let by_full: HashMap<String, &String> = query.files.iter().map(|file| (format!("{prefix}{}", file.replace('\\', "/")), file)).collect();
    let paths: Vec<String> = query.files.iter().map(|file| format!("{prefix}{}", file.replace('\\', "/"))).collect();
    let at = query.at.unwrap_or("HEAD");

    let base = match git(top, &["merge-base", at, query.reference]) {
        Ok(base) => base.trim().to_string(),
        Err(err) => {
            let detail = err.message.split_once('\n').map(|(_, rest)| rest.trim().to_string()).unwrap_or_default();
            return Err(ReleaseError::new(format!(
                "{at} and {} share no history{}, so which change files {} carries cannot be decided. Fetch the full history of both.",
                query.reference,
                if detail.is_empty() { String::new() } else { format!(" ({detail})") },
                query.reference
            )));
        }
    };

    let current = tree_blobs(top, at, &paths)?;
    let at_base = tree_blobs(top, &base, &paths)?;
    let written = written_blobs(top, &format!("{base}..{}", query.reference), &paths)?;
    let at_ref = tree_blobs(top, query.reference, &paths)?;
    for (path, blob) in &current {
        if at_base.get(path) != Some(blob) && !written.get(path).is_some_and(|set| set.contains(blob)) {
            continue;
        }
        let Some(file) = by_full.get(path) else { continue };
        carried.insert((*file).clone());
        if !at_ref.contains_key(path) {
            released.insert((*file).clone());
        }
    }
    Ok(Walk { carried, released })
}

/// The files of `at`'s tree that `ref` carries.
pub fn carried_by(query: &CarriedQuery<'_>) -> Result<BTreeSet<String>, ReleaseError> {
    Ok(walk(query)?.carried)
}

/// The files of `at`'s tree that `ref` carries and no longer holds.
pub fn released_by(query: &CarriedQuery<'_>) -> Result<BTreeSet<String>, ReleaseError> {
    Ok(walk(query)?.released)
}

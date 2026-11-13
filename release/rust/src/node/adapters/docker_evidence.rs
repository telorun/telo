//! The `docker` ecosystem's evidence half — the only reader of a build context.
//!
//! Its layer is the context the image is built from (`context`, the anchor
//! directory by default) less what the ignore file excludes —
//! `<Dockerfile>.dockerignore` beside the Dockerfile, else the context's
//! `.dockerignore` — named relative to the context. The Dockerfile and its
//! ignore file are always in it; the planner's own bookkeeping (`.changes/`)
//! never is. An image keeps no version and has no read-back; it publishes to
//! `<registry>/<name>`.

use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::adapters::docker::DOCKERFILE;
use crate::fragment::UnitKey;
use telorun_glob::{is_pruned, select_by_patterns, SelectOptions};
use crate::ledger::AnchorDigest;
use crate::ReleaseError;

use super::super::evidence::{AnchorEvidence, AnchorRef, EvidenceAdapter, EvidenceSession, SessionOptions};
use super::super::files_digest::{digest_file_set, is_bookkeeping, list_files, read_file_set_entry, FileSetEntry};
use super::super::workspace::ReleaseWorkspace;
use super::dockerignore_patterns::dockerignore_patterns;

fn joined(dir: &str, relative: &str) -> String {
    if dir.is_empty() {
        relative.to_string()
    } else {
        format!("{dir}/{relative}")
    }
}

/// The workspace-relative context directory of a docker anchor.
pub fn docker_context(reference: AnchorRef<'_>) -> String {
    match reference.anchor.settings.get("context") {
        Some(Value::String(context)) => if context == "." { String::new() } else { context.clone() },
        _ => reference.anchor.dir.clone(),
    }
}

fn posix_basename(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

pub fn docker_destination(reference: AnchorRef<'_>) -> Option<String> {
    let Some(Value::String(registry)) = reference.anchor.settings.get("registry") else { return None };
    let name = match reference.anchor.settings.get("name") {
        Some(Value::String(name)) => name.clone(),
        _ => {
            let dir = if reference.anchor.dir.is_empty() { "." } else { reference.anchor.dir.as_str() };
            let base = posix_basename(dir);
            if base == "." || base.is_empty() {
                return None;
            }
            base.to_string()
        }
    };
    Some(format!("{}/{name}", registry.trim_end_matches('/')))
}

/// `path.posix.relative(from, to)` for two workspace-relative paths.
fn posix_relative(from: &str, to: &str) -> String {
    let parts = |p: &str| p.split('/').filter(|s| !s.is_empty() && *s != ".").map(str::to_string).collect::<Vec<_>>();
    let (a, b) = (parts(from), parts(to));
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let mut out: Vec<String> = std::iter::repeat_n("..".to_string(), a.len() - common).collect();
    out.extend(b[common..].iter().cloned());
    out.join("/")
}

/// The image's file set: context-relative names, workspace-relative sources.
pub fn docker_file_set(root: &Path, reference: AnchorRef<'_>) -> Result<(Vec<FileSetEntry>, Vec<String>), ReleaseError> {
    let context = docker_context(reference);
    let context_dir = root.join(&context);
    let dockerfile = joined(&reference.anchor.dir, DOCKERFILE);
    let candidates = [format!("{dockerfile}.dockerignore"), joined(&context, ".dockerignore")];
    let ignore_file = candidates.into_iter().find(|file| root.join(file).exists());
    let ignored = match &ignore_file {
        Some(file) => {
            let text = fs::read_to_string(root.join(file)).map_err(|err| ReleaseError::new(format!("{file}: {err}")))?;
            dockerignore_patterns(&text, file)?
        }
        None => Vec::new(),
    };
    let selected = select_by_patterns(
        &list_files(&context_dir, &is_pruned)?,
        &["**"],
        &SelectOptions { apply_default_ignore: Some(false), exclude: ignored },
    );
    let mut sources: std::collections::BTreeMap<Vec<u16>, (String, String)> = std::collections::BTreeMap::new();
    for file in selected {
        let source = joined(&context, &file);
        if !is_bookkeeping(&source) {
            sources.insert(file.encode_utf16().collect(), (file.clone(), source));
        }
    }
    for always in [Some(dockerfile), ignore_file].into_iter().flatten() {
        let name = posix_relative(if context.is_empty() { "." } else { &context }, &always);
        sources.insert(name.encode_utf16().collect(), (name, always));
    }
    let mut entries = Vec::new();
    let mut files = Vec::new();
    for (name, source) in sources.into_values() {
        entries.push(read_file_set_entry(root, &source, &name)?);
        files.push(source);
    }
    Ok((entries, files))
}

pub struct DockerEvidence;

struct DockerSession<'a> {
    workspace: &'a ReleaseWorkspace,
}

impl EvidenceAdapter for DockerEvidence {
    fn ecosystem(&self) -> &'static str {
        "docker"
    }

    fn needs_destination(&self) -> bool {
        true
    }

    fn open<'a>(&self, workspace: &'a ReleaseWorkspace, _options: &SessionOptions<'_>) -> Result<Box<dyn EvidenceSession + 'a>, ReleaseError> {
        Ok(Box::new(DockerSession { workspace }))
    }
}

impl EvidenceSession for DockerSession<'_> {
    fn collect(&self, reference: AnchorRef<'_>) -> Result<AnchorEvidence, ReleaseError> {
        let (entries, files) = docker_file_set(&self.workspace.root, reference)?;
        Ok(AnchorEvidence { layer: Some(AnchorDigest::One(digest_file_set(&entries)?)), files, ..AnchorEvidence::default() })
    }

    fn imports(&self, _reference: AnchorRef<'_>) -> Result<Vec<UnitKey>, ReleaseError> {
        Ok(Vec::new())
    }

    fn destination(&self, reference: AnchorRef<'_>) -> Option<String> {
        docker_destination(reference)
    }
}

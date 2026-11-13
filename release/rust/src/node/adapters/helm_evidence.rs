//! The `helm` ecosystem's evidence half.
//!
//! Its layer is the chart `helm package` builds — the file set the chart's
//! `.helmignore` admits, with the `Chart.yaml` helm writes — unpacked and
//! digested, so the number is the one a chart pulled back from its OCI
//! registry gives, the planner's own bookkeeping (`.changes/`) left out of
//! both. It publishes to `<registry>/<Chart.yaml name>`.

use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::Value;

use crate::fragment::UnitKey;
use crate::ledger::AnchorDigest;
use crate::ReleaseError;

use super::super::evidence::{AnchorEvidence, AnchorRef, EvidenceAdapter, EvidenceSession, ReadBack, SessionOptions};
use super::super::files_digest::{digest_file_set, without_bookkeeping, FileSetEntry};
use super::super::tar::{read_tar_gz, scratch_dir, strip_prefix};
use super::super::workspace::ReleaseWorkspace;

fn helm(args: &[String], what: &str) -> Result<(bool, String), ReleaseError> {
    let run = Command::new("helm")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|err| ReleaseError::new(format!("{what}: helm could not start ({err}). Install Helm 3.8 or later.")))?;
    let stderr = String::from_utf8_lossy(&run.stderr).into_owned();
    let detail = if stderr.is_empty() { String::from_utf8_lossy(&run.stdout).into_owned() } else { stderr };
    Ok((run.status.success(), detail.trim().to_string()))
}

/// A scratch directory for one helm command, removed after `body`.
fn with_scratch<T>(body: impl FnOnce(&Path) -> Result<T, ReleaseError>) -> Result<T, ReleaseError> {
    let dir = scratch_dir("telorun-release-helm-")?;
    let result = body(&dir);
    let _ = fs::remove_dir_all(&dir);
    result
}

fn chart_files(dir: &Path, chart: &str, at: &str) -> Result<Vec<FileSetEntry>, ReleaseError> {
    let mut tarballs: Vec<String> = fs::read_dir(dir)
        .map_err(|err| ReleaseError::new(format!("{}: {err}", dir.display())))?
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tgz"))
        .collect();
    tarballs.sort();
    if tarballs.len() != 1 {
        return Err(ReleaseError::new(format!("{at}: helm wrote {} charts, expected one.", tarballs.len())));
    }
    let bytes = fs::read(dir.join(&tarballs[0])).map_err(|err| ReleaseError::new(format!("{at}: {err}")))?;
    strip_prefix(read_tar_gz(&bytes, at)?, chart, at)
}

pub struct HelmEvidence;

struct HelmSession<'a> {
    workspace: &'a ReleaseWorkspace,
}

impl EvidenceAdapter for HelmEvidence {
    fn ecosystem(&self) -> &'static str {
        "helm"
    }

    fn needs_destination(&self) -> bool {
        true
    }

    fn open<'a>(&self, workspace: &'a ReleaseWorkspace, _options: &SessionOptions<'_>) -> Result<Box<dyn EvidenceSession + 'a>, ReleaseError> {
        Ok(Box::new(HelmSession { workspace }))
    }
}

fn not_found(detail: &str) -> bool {
    let lower = detail.to_lowercase();
    lower.contains("not found") || lower.contains("404") || lower.contains("manifest unknown")
}

impl EvidenceSession for HelmSession<'_> {
    fn collect(&self, reference: AnchorRef<'_>) -> Result<AnchorEvidence, ReleaseError> {
        let chart = reference.anchor.package.name.clone().unwrap_or_default();
        let entries = with_scratch(|dir| {
            let args = vec![
                "package".to_string(),
                self.workspace.root.join(&reference.anchor.dir).display().to_string(),
                "--destination".to_string(),
                dir.display().to_string(),
            ];
            let (ok, detail) = helm(&args, &reference.unit.key)?;
            if !ok {
                return Err(ReleaseError::new(format!("{}: `helm package` failed: {detail}", reference.unit.key)));
            }
            chart_files(dir, &chart, &format!("{}'s packaged chart", reference.unit.key))
        })?;
        let entries = without_bookkeeping(entries, &reference.anchor.dir);
        let files = entries
            .iter()
            .map(|entry| if reference.anchor.dir.is_empty() { entry.path().to_string() } else { format!("{}/{}", reference.anchor.dir, entry.path()) })
            .collect();
        Ok(AnchorEvidence { layer: Some(AnchorDigest::One(digest_file_set(&entries)?)), files, ..AnchorEvidence::default() })
    }

    fn imports(&self, _reference: AnchorRef<'_>) -> Result<Vec<UnitKey>, ReleaseError> {
        Ok(Vec::new())
    }

    fn destination(&self, reference: AnchorRef<'_>) -> Option<String> {
        let Some(Value::String(registry)) = reference.anchor.settings.get("registry") else { return None };
        let name = reference.anchor.package.name.as_ref().filter(|n| !n.is_empty())?;
        Some(format!("{}/{name}", registry.trim_end_matches('/')))
    }

    fn read_back(&self, reference: AnchorRef<'_>, version: &str, recorded: Option<&AnchorDigest>) -> Option<Result<ReadBack, ReleaseError>> {
        let Some(chart_ref) = self.destination(reference) else {
            return Some(Ok(ReadBack::Unverifiable { reason: "no registry names where the chart is published".into() }));
        };
        Some(with_scratch(|dir| {
            let args = vec![
                "pull".to_string(),
                chart_ref.clone(),
                "--version".to_string(),
                version.to_string(),
                "--destination".to_string(),
                dir.display().to_string(),
            ];
            let (ok, detail) = helm(&args, &reference.unit.key)?;
            if !ok {
                if not_found(&detail) {
                    return Ok(ReadBack::Absent);
                }
                return Err(ReleaseError::new(format!(
                    "{}: `helm pull {chart_ref} --version {version}` failed: {detail}",
                    reference.unit.key
                )));
            }
            let chart = reference.anchor.package.name.clone().unwrap_or_default();
            let layer = digest_file_set(&without_bookkeeping(chart_files(dir, &chart, &format!("{chart_ref}:{version}"))?, &reference.anchor.dir))?;
            let drift = match recorded {
                Some(AnchorDigest::One(was)) if *was == layer => Vec::new(),
                Some(_) => vec![format!("helm/{}", reference.anchor.anchor)],
                None => Vec::new(),
            };
            Ok(ReadBack::Published { layer: AnchorDigest::One(layer), drift })
        }))
    }
}

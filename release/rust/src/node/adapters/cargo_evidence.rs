//! The `cargo` ecosystem's evidence half.
//!
//! Its layer is the file set `cargo package --list` names, read from disk;
//! what cargo generates — `.cargo_vcs_info.json`, the authored manifest's copy
//! and a `Cargo.lock` pruned to the crate — is left out. A crate with a
//! linked-artifact target has `Cargo.lock` in its layer instead as its
//! external closure (`adapters/cargo_closure.rs`), read from `cargo metadata`
//! and never from disk, so a lockfile-only bump releases the binaries that
//! link it. Read-back unpacks the `.crate` crates.io serves under the same
//! rule, reading its `Cargo.toml.orig` as `Cargo.toml` and recomputing the
//! closure from its own `Cargo.lock`. Import edges are path dependencies —
//! normal, build and target-specific, never dev — read from `cargo metadata`.
//! A crate with `publish = false` has a layer and no read-back. When a crate
//! moves, every cargo anchor naming it by path with a version requirement has
//! that requirement moved with it, or the dependent would no longer resolve.

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::rc::Rc;

use serde_json::Value;

use crate::adapters::cargo::{stamp_path_dependency_requirements, CARGO_LOCK, CARGO_TOML};
use crate::adapters::cargo_closure::{closure_from_lock, closure_from_metadata, links_artifact};
use crate::release_plan::ReleasePlan;
use crate::fragment::UnitKey;
use crate::ledger::AnchorDigest;
use crate::ReleaseError;

use super::super::evidence::{AnchorEvidence, AnchorRef, EvidenceAdapter, EvidenceSession, ReadBack, SessionOptions};
use super::super::files_digest::{digest_file_set, is_bookkeeping, read_file_set_entry, without_bookkeeping, FileSetEntry};
use super::super::registry_fetch::{fetch_bytes, fetch_json, fetch_or_absent};
use super::super::tar::{read_tar_gz, strip_prefix};
use super::super::workspace::{absolute, ReleaseWorkspace};

const GENERATED: [&str; 3] = [".cargo_vcs_info.json", "Cargo.toml.orig", "Cargo.lock"];
const CRATES_IO: &str = "https://crates.io/api/v1/crates";

#[derive(Clone)]
struct CargoPackage {
    id: String,
    name: String,
    /// `license-file` and `readme` as the manifest writes them, relative to it.
    outside: Vec<String>,
    publish: Option<Vec<String>>,
    /// `(path, kind)` of every dependency.
    dependencies: Vec<(Option<String>, Option<String>)>,
    /// Whether a target links an artifact.
    links: bool,
    /// The names of its workspace's members.
    members: Vec<String>,
}

/// The resolve is read offline across every platform, so each platform's crates must be on disk.
const CLOSURE_REMEDY: &str = " Fetch every platform's crates first with `cargo fetch --locked`.";

fn cargo(args: &[String], cwd: &Path, what: &str) -> Result<String, ReleaseError> {
    cargo_or(args, cwd, what, "")
}

fn cargo_or(args: &[String], cwd: &Path, what: &str, remedy: &str) -> Result<String, ReleaseError> {
    let run = Command::new("cargo")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .map_err(|err| ReleaseError::new(format!("{what}: cargo could not start ({err}). Install the Rust toolchain.")))?;
    if !run.status.success() {
        return Err(ReleaseError::new(format!(
            "{what}: `cargo {}` exited {}: {}{remedy}",
            args.join(" "),
            run.status.code().map_or("null".to_string(), |code| code.to_string()),
            String::from_utf8_lossy(&run.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&run.stdout).into_owned())
}

/// `path` relative to `root`, `/`-separated.
fn relative_to(root: &Path, path: &Path) -> String {
    let root = absolute(root);
    path.strip_prefix(&root)
        .map(|rest| rest.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"))
        .unwrap_or_else(|_| path.display().to_string())
}

fn joined(dir: &str, relative: &str) -> String {
    if dir.is_empty() {
        relative.to_string()
    } else {
        format!("{dir}/{relative}")
    }
}

pub struct CargoEvidence;

struct CargoSession<'a> {
    workspace: &'a ReleaseWorkspace,
    owners: HashMap<PathBuf, UnitKey>,
    metadata: RefCell<HashMap<PathBuf, CargoPackage>>,
    /// `cargo metadata` with its resolve, by each member's manifest.
    resolved: RefCell<HashMap<PathBuf, Rc<Value>>>,
}

impl EvidenceAdapter for CargoEvidence {
    fn ecosystem(&self) -> &'static str {
        "cargo"
    }

    fn open<'a>(&self, workspace: &'a ReleaseWorkspace, _options: &SessionOptions<'_>) -> Result<Box<dyn EvidenceSession + 'a>, ReleaseError> {
        let mut owners = HashMap::new();
        for unit in &workspace.units {
            for anchor in &unit.anchors {
                if anchor.ecosystem == "cargo" {
                    owners.insert(absolute(&workspace.root.join(&anchor.dir)), unit.key.clone());
                }
            }
        }
        Ok(Box::new(CargoSession { workspace, owners, metadata: RefCell::new(HashMap::new()), resolved: RefCell::new(HashMap::new()) }))
    }
}

impl CargoSession<'_> {
    fn package_of(&self, reference: AnchorRef<'_>) -> Result<CargoPackage, ReleaseError> {
        let manifest = absolute(&self.workspace.root.join(&reference.anchor.dir).join(CARGO_TOML));
        if let Some(known) = self.metadata.borrow().get(&manifest) {
            return Ok(known.clone());
        }
        let args: Vec<String> = ["metadata", "--no-deps", "--format-version", "1", "--manifest-path"]
            .iter()
            .map(|s| s.to_string())
            .chain([manifest.display().to_string()])
            .collect();
        let output = cargo(&args, &self.workspace.root, &reference.unit.key)?;
        let read: Value = serde_json::from_str(&output)
            .map_err(|err| ReleaseError::new(format!("{}: cargo metadata answered no JSON: {err}", reference.unit.key)))?;
        let member_ids: Vec<&str> = read.get("workspace_members").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
        let packages: Vec<&Value> = read.get("packages").and_then(Value::as_array).into_iter().flatten().collect();
        let members: Vec<String> = packages
            .iter()
            .filter(|pkg| pkg.get("id").and_then(Value::as_str).is_some_and(|id| member_ids.contains(&id)))
            .map(|pkg| pkg.get("name").and_then(Value::as_str).unwrap_or("").to_string())
            .collect();
        for pkg in packages {
            let Some(path) = pkg.get("manifest_path").and_then(Value::as_str) else { continue };
            let package = CargoPackage {
                id: pkg.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                name: pkg.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                outside: ["license_file", "readme"].iter().filter_map(|key| pkg.get(*key).and_then(Value::as_str)).map(str::to_string).collect(),
                publish: pkg.get("publish").and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect()),
                dependencies: pkg
                    .get("dependencies")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|dep| {
                        (dep.get("path").and_then(Value::as_str).map(str::to_string), dep.get("kind").and_then(Value::as_str).map(str::to_string))
                    })
                    .collect(),
                links: pkg.get("targets").is_some_and(links_artifact),
                members: members.clone(),
            };
            self.metadata.borrow_mut().insert(absolute(Path::new(path)), package);
        }
        self.metadata.borrow().get(&manifest).cloned().ok_or_else(|| {
            ReleaseError::new(format!("{}: cargo metadata does not list the crate at {}.", reference.unit.key, manifest.display()))
        })
    }

    fn closure_of(&self, reference: AnchorRef<'_>, package: &CargoPackage) -> Result<String, ReleaseError> {
        let manifest = absolute(&self.workspace.root.join(&reference.anchor.dir).join(CARGO_TOML));
        let known = self.resolved.borrow().get(&manifest).cloned();
        let answer = match known {
            Some(answer) => answer,
            None => {
                let args: Vec<String> = ["metadata", "--locked", "--offline", "--all-features", "--format-version", "1", "--manifest-path"]
                    .iter()
                    .map(|s| s.to_string())
                    .chain([manifest.display().to_string()])
                    .collect();
                let output = cargo_or(&args, &self.workspace.root, &reference.unit.key, CLOSURE_REMEDY)?;
                let answer: Rc<Value> = Rc::new(
                    serde_json::from_str(&output)
                        .map_err(|err| ReleaseError::new(format!("{}: cargo metadata answered no JSON: {err}", reference.unit.key)))?,
                );
                let members: Vec<&str> =
                    answer.get("workspace_members").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
                for pkg in answer.get("packages").and_then(Value::as_array).into_iter().flatten() {
                    let member = pkg.get("id").and_then(Value::as_str).is_some_and(|id| members.contains(&id));
                    if let (true, Some(path)) = (member, pkg.get("manifest_path").and_then(Value::as_str)) {
                        self.resolved.borrow_mut().insert(absolute(Path::new(path)), answer.clone());
                    }
                }
                answer
            }
        };
        closure_from_metadata(&answer, &package.id)
    }

    fn imports_of(&self, reference: AnchorRef<'_>) -> Result<Vec<UnitKey>, ReleaseError> {
        let mut found = BTreeSet::new();
        for (path, kind) in self.package_of(reference)?.dependencies {
            let Some(path) = path.filter(|p| !p.is_empty()) else { continue };
            if kind.as_deref() == Some("dev") {
                continue;
            }
            if let Some(owner) = self.owners.get(&absolute(Path::new(&path))) {
                if *owner != reference.unit.key {
                    found.insert(owner.clone());
                }
            }
        }
        Ok(found.into_iter().collect())
    }

    fn read_back_inner(&self, reference: AnchorRef<'_>, version: &str, recorded: Option<&AnchorDigest>) -> Result<ReadBack, ReleaseError> {
        let package = self.package_of(reference)?;
        if package.publish.as_ref().is_some_and(|list| list.is_empty()) {
            return Ok(ReadBack::Unverifiable { reason: "publish = false, so nothing is published to read back".into() });
        }
        let name = &package.name;
        if fetch_or_absent(&format!("{CRATES_IO}/{name}/{version}"))?.is_none() {
            return Ok(ReadBack::Absent);
        }
        let bytes = fetch_bytes(&format!("{CRATES_IO}/{name}/{version}/download"))?;
        let closure = package.links.then_some((name.as_str(), version, package.members.as_slice()));
        let layer = digest_file_set(&without_bookkeeping(published_files(&bytes, &format!("{name}-{version}"), closure)?, &reference.anchor.dir))?;
        let drift = match recorded {
            Some(AnchorDigest::One(was)) if *was == layer => Vec::new(),
            Some(_) => vec![format!("cargo/{}", reference.anchor.anchor)],
            None => Vec::new(),
        };
        Ok(ReadBack::Published { layer: AnchorDigest::One(layer), drift })
    }
}

impl EvidenceSession for CargoSession<'_> {
    fn collect(&self, reference: AnchorRef<'_>) -> Result<AnchorEvidence, ReleaseError> {
        let package = self.package_of(reference)?;
        let entries = packaged_files(self.workspace, reference, &package)?;
        let mut files: Vec<FileSetEntry> = entries.iter().map(|(entry, _)| entry.clone()).collect();
        if package.links {
            files.push(FileSetEntry::File { path: CARGO_LOCK.into(), content: self.closure_of(reference, &package)?.into_bytes(), executable: false });
        }
        Ok(AnchorEvidence {
            layer: Some(AnchorDigest::One(digest_file_set(&files)?)),
            files: entries.into_iter().map(|(_, source)| source).collect(),
            imports: self.imports_of(reference)?,
            ..AnchorEvidence::default()
        })
    }

    fn imports(&self, reference: AnchorRef<'_>) -> Result<Vec<UnitKey>, ReleaseError> {
        self.imports_of(reference)
    }

    fn read_back(&self, reference: AnchorRef<'_>, version: &str, recorded: Option<&AnchorDigest>) -> Option<Result<ReadBack, ReleaseError>> {
        Some(self.read_back_inner(reference, version, recorded))
    }

    fn after_stamp(&self, reference: AnchorRef<'_>, version: &str, _plan: &ReleasePlan) -> Result<Vec<String>, ReleaseError> {
        let mut written = Vec::new();
        for unit in &self.workspace.units {
            for anchor in &unit.anchors {
                if anchor.ecosystem != "cargo" || anchor.dir == reference.anchor.dir {
                    continue;
                }
                let relative = joined(&anchor.dir, CARGO_TOML);
                let file = self.workspace.root.join(&relative);
                let before = std::fs::read_to_string(&file).map_err(|err| ReleaseError::new(format!("{}: {err}", file.display())))?;
                let after = stamp_path_dependency_requirements(&before, &anchor.dir, &reference.anchor.dir, version);
                if after == before {
                    continue;
                }
                std::fs::write(&file, &after).map_err(|err| ReleaseError::new(format!("{}: {err}", file.display())))?;
                written.push(relative);
            }
        }
        Ok(written)
    }

    fn published_versions(&self, reference: AnchorRef<'_>) -> Option<Result<Vec<String>, ReleaseError>> {
        Some((|| {
            let name = self.package_of(reference)?.name;
            let Some(doc) = fetch_json(&format!("{CRATES_IO}/{name}/versions"))? else { return Ok(Vec::new()) };
            Ok(doc
                .get("versions")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(|v| v.get("num").and_then(Value::as_str)).map(str::to_string).collect())
                .unwrap_or_default())
        })())
    }
}

/// The files `cargo package --list` names, read where they are: a `license-file`
/// or `readme` outside the crate is packaged at the crate's root under its own
/// name, so a listed name absent from the crate is read from the path the
/// manifest gives.
fn packaged_files(workspace: &ReleaseWorkspace, reference: AnchorRef<'_>, package: &CargoPackage) -> Result<Vec<(FileSetEntry, String)>, ReleaseError> {
    let dir = workspace.root.join(&reference.anchor.dir);
    let args: Vec<String> = vec![
        "package".into(),
        "--list".into(),
        "--allow-dirty".into(),
        "--manifest-path".into(),
        dir.join(CARGO_TOML).display().to_string(),
    ];
    let listed = cargo(&args, &dir, &reference.unit.key)?;
    let mut out = Vec::new();
    for line in listed.split('\n') {
        let file = line.strip_suffix('\r').unwrap_or(line).trim();
        if file.is_empty() || GENERATED.contains(&file) || is_bookkeeping(&joined(&reference.anchor.dir, file)) {
            continue;
        }
        if !dir.join(file).exists() {
            let outside = package.outside.iter().find(|written| written.replace('\\', "/").rsplit('/').next() == Some(file));
            if let Some(written) = outside.filter(|written| dir.join(written).exists()) {
                let source = relative_to(&workspace.root, &absolute(&dir.join(written)));
                out.push((read_file_set_entry(&workspace.root, &source, file)?, source));
                continue;
            }
            return Err(ReleaseError::new(format!(
                "{}: `cargo package --list` names '{file}', which is not on disk.",
                reference.unit.key
            )));
        }
        out.push((read_file_set_entry(&dir, file, file)?, joined(&reference.anchor.dir, file)));
    }
    Ok(out)
}

/// A `.crate`'s files under the tree's rule: the authored manifest as
/// `Cargo.toml`, nothing cargo generated, and — for a crate linking an
/// artifact, given its name, version and workspace members — the closure its
/// own `Cargo.lock` and packaged manifest give.
fn published_files(bytes: &[u8], prefix: &str, closure: Option<(&str, &str, &[String])>) -> Result<Vec<FileSetEntry>, ReleaseError> {
    let at = format!("{prefix}.crate");
    let entries = strip_prefix(read_tar_gz(bytes, &at)?, prefix, &at)?;
    let orig = entries.iter().find(|entry| entry.path() == "Cargo.toml.orig").cloned();
    let mut kept: Vec<FileSetEntry> = entries
        .iter()
        .filter(|entry| !GENERATED.contains(&entry.path()) && (orig.is_none() || entry.path() != CARGO_TOML))
        .cloned()
        .collect();
    if let Some(orig) = orig {
        kept.push(orig.renamed(CARGO_TOML.into()));
    }
    let Some((name, version, members)) = closure else { return Ok(kept) };
    let text = |file: &str| -> Result<String, ReleaseError> {
        match entries.iter().find(|entry| entry.path() == file) {
            Some(FileSetEntry::File { content, .. }) => Ok(String::from_utf8_lossy(content).into_owned()),
            _ => Err(ReleaseError::new(format!("{at}: holds no {file}, so the closure the crate links cannot be read."))),
        }
    };
    let lock = closure_from_lock(&text(CARGO_LOCK)?, &text(CARGO_TOML)?, (name, version), members, &format!("{at}/{CARGO_LOCK}"))?;
    kept.push(FileSetEntry::File { path: CARGO_LOCK.into(), content: lock.into_bytes(), executable: false });
    Ok(kept)
}

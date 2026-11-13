//! The `npm` ecosystem's evidence half.
//!
//! Its layer is the file set the package manager's own `pack` produces — npm,
//! pnpm, yarn (classic and berry) or bun — so it holds the `package.json` as
//! published; one still holding `workspace:` or `catalog:` is refused. Import
//! edges are the siblings named in `dependencies`, `peerDependencies` and
//! `optionalDependencies` (never `devDependencies`): by a `workspace:` range,
//! and — for a manager with no workspace protocol — by a plain range, which
//! `apply` rewrites when it moves the sibling. Read-back downloads the
//! published tarball, checks `dist.integrity` for transport only, and digests
//! the unpacked set. Both readings leave out the planner's own bookkeeping
//! (`.changes/`), which a package at the workspace root would otherwise pack.

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{Map, Value};
use sha2::Digest;

use crate::adapters::npm::PACKAGE_JSON;
use crate::fragment::UnitKey;
use crate::ledger::AnchorDigest;
use crate::release_plan::ReleasePlan;
use crate::version_files::{document_scalar, splice_scalar};
use crate::ReleaseError;

use super::super::evidence::{AnchorEvidence, AnchorRef, EvidenceAdapter, EvidenceSession, ReadBack, SessionOptions};
use super::super::files_digest::{digest_file_set, without_bookkeeping, FileSetEntry};
use super::super::registry_fetch::{fetch_bytes, fetch_json};
use super::super::tar::{read_tar_gz, scratch_dir};
use super::super::workspace::ReleaseWorkspace;
use super::package_manager::{detect_package_manager, pack_command, uses_plain_ranges, PackageManager};

const EDGE_SECTIONS: [&str; 3] = ["dependencies", "peerDependencies", "optionalDependencies"];
const DEFAULT_REGISTRY: &str = "https://registry.npmjs.org";

fn read_json(file: &Path) -> Result<Map<String, Value>, ReleaseError> {
    let text = fs::read_to_string(file).map_err(|err| ReleaseError::new(format!("{}: {err}", file.display())))?;
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Ok(Map::new()),
        Err(err) => Err(ReleaseError::new(format!("{}: {err}", file.display()))),
    }
}

/// `[name, range, section]` of every string range in the edge sections.
fn dependencies(pkg: &Map<String, Value>) -> Vec<(String, String, &'static str)> {
    let mut out = Vec::new();
    for section in EDGE_SECTIONS {
        let Some(Value::Object(entries)) = pkg.get(section) else { continue };
        for (name, range) in entries {
            if let Some(range) = range.as_str() {
                out.push((name.clone(), range.to_string(), section));
            }
        }
    }
    out
}

/// `/^(\^|~|>=|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/`: the operator.
fn plain_range(range: &str) -> Option<&str> {
    let (operator, version) = ["^", "~", ">=", "="]
        .iter()
        .find_map(|op| range.strip_prefix(op).map(|rest| (*op, rest)))
        .unwrap_or(("", range));
    let (core, pre) = match version.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (version, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if parts.len() != 3 || !parts.iter().all(|p| digits(p)) {
        return None;
    }
    if let Some(pre) = pre {
        if pre.is_empty() || !pre.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
            return None;
        }
    }
    Some(operator)
}

fn is_plain_range(range: &str) -> bool {
    let first = range.chars().next();
    first.is_some_and(|c| "^~>=<*xX .|-".contains(c) || c.is_ascii_digit()) && !range.contains([':', '/'])
}

fn unpublishable(range: &str) -> bool {
    range.starts_with("workspace:") || range.starts_with("catalog:")
}

fn joined(dir: &str, relative: &str) -> String {
    if dir.is_empty() {
        relative.to_string()
    } else {
        format!("{dir}/{relative}")
    }
}

/// `encodeURIComponent`.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub struct NpmEvidence;

struct NpmSession<'a> {
    workspace: &'a ReleaseWorkspace,
    owners: HashMap<String, UnitKey>,
    managers: RefCell<HashMap<String, PackageManager>>,
}

impl EvidenceAdapter for NpmEvidence {
    fn ecosystem(&self) -> &'static str {
        "npm"
    }

    fn open<'a>(&self, workspace: &'a ReleaseWorkspace, _options: &SessionOptions<'_>) -> Result<Box<dyn EvidenceSession + 'a>, ReleaseError> {
        let mut owners = HashMap::new();
        for unit in &workspace.units {
            for anchor in &unit.anchors {
                if anchor.ecosystem == "npm" {
                    if let Some(name) = anchor.package.name.as_ref().filter(|n| !n.is_empty()) {
                        owners.insert(name.clone(), unit.key.clone());
                    }
                }
            }
        }
        Ok(Box::new(NpmSession { workspace, owners, managers: RefCell::new(HashMap::new()) }))
    }
}

impl NpmSession<'_> {
    fn manager_of(&self, dir: &str) -> Result<PackageManager, ReleaseError> {
        if let Some(known) = self.managers.borrow().get(dir) {
            return Ok(*known);
        }
        let found = detect_package_manager(&self.workspace.root.join(dir), &self.workspace.root)?;
        self.managers.borrow_mut().insert(dir.to_string(), found);
        Ok(found)
    }

    fn manifest_of(&self, reference: AnchorRef<'_>) -> Result<Map<String, Value>, ReleaseError> {
        read_json(&self.workspace.root.join(&reference.anchor.dir).join(PACKAGE_JSON))
    }

    fn imports_of(&self, reference: AnchorRef<'_>) -> Result<Vec<UnitKey>, ReleaseError> {
        let plain = uses_plain_ranges(self.manager_of(&reference.anchor.dir)?);
        let mut found = BTreeSet::new();
        for (name, range, _) in dependencies(&self.manifest_of(reference)?) {
            let Some(owner) = self.owners.get(&name) else { continue };
            if *owner == reference.unit.key {
                continue;
            }
            if range.starts_with("workspace:") || (plain && is_plain_range(&range)) {
                found.insert(owner.clone());
            }
        }
        Ok(found.into_iter().collect())
    }

    fn registry_of(&self, reference: AnchorRef<'_>) -> Result<String, ReleaseError> {
        let manifest = self.manifest_of(reference)?;
        let configured = manifest.get("publishConfig").and_then(|c| c.get("registry")).and_then(Value::as_str).map(str::to_string);
        let registry = configured
            .or_else(|| std::env::var("npm_config_registry").ok())
            .or_else(|| std::env::var("NPM_CONFIG_REGISTRY").ok())
            .unwrap_or_else(|| DEFAULT_REGISTRY.to_string());
        Ok(registry.trim_end_matches('/').to_string())
    }

    fn document_url(&self, reference: AnchorRef<'_>) -> Result<String, ReleaseError> {
        let manifest = self.manifest_of(reference)?;
        let name = manifest.get("name").and_then(Value::as_str).unwrap_or("undefined");
        Ok(format!("{}/{}", self.registry_of(reference)?, name.replacen('/', "%2f", 1)))
    }

    fn read_back_inner(&self, reference: AnchorRef<'_>, version: &str, recorded: Option<&AnchorDigest>) -> Result<ReadBack, ReleaseError> {
        let document = self.document_url(reference)?;
        let Some(doc) = fetch_json(&format!("{document}/{}", encode_uri_component(version)))? else {
            return Ok(ReadBack::Absent);
        };
        let dist = doc.get("dist");
        let Some(tarball) = dist.and_then(|d| d.get("tarball")).and_then(Value::as_str).filter(|t| !t.is_empty()) else {
            return Err(ReleaseError::new(format!("{document}/{version} names no dist.tarball.")));
        };
        let bytes = fetch_bytes(tarball)?;
        check_transport(
            &bytes,
            dist.and_then(|d| d.get("integrity")).and_then(Value::as_str),
            dist.and_then(|d| d.get("shasum")).and_then(Value::as_str),
            tarball,
        )?;
        let layer = digest_file_set(&canonical_manifest(without_bookkeeping(unpack_tarball(&bytes, tarball)?, &reference.anchor.dir))?)?;
        let drift = match recorded {
            Some(AnchorDigest::One(was)) if *was == layer => Vec::new(),
            Some(_) => vec![format!("npm/{}", reference.anchor.anchor)],
            None => Vec::new(),
        };
        Ok(ReadBack::Published { layer: AnchorDigest::One(layer), drift })
    }
}

impl EvidenceSession for NpmSession<'_> {
    fn collect(&self, reference: AnchorRef<'_>) -> Result<AnchorEvidence, ReleaseError> {
        let imports = self.imports_of(reference)?;
        if !reference.anchor.package.contributes_layer {
            return Ok(AnchorEvidence { imports, ..AnchorEvidence::default() });
        }
        let entries = without_bookkeeping(pack(&self.workspace.root, reference, self.manager_of(&reference.anchor.dir)?)?, &reference.anchor.dir);
        Ok(AnchorEvidence {
            layer: Some(AnchorDigest::One(digest_file_set(&canonical_manifest(entries.clone())?)?)),
            files: entries.iter().map(|entry| joined(&reference.anchor.dir, entry.path())).collect(),
            imports,
            ..AnchorEvidence::default()
        })
    }

    fn imports(&self, reference: AnchorRef<'_>) -> Result<Vec<UnitKey>, ReleaseError> {
        self.imports_of(reference)
    }

    fn read_back(&self, reference: AnchorRef<'_>, version: &str, recorded: Option<&AnchorDigest>) -> Option<Result<ReadBack, ReleaseError>> {
        Some(self.read_back_inner(reference, version, recorded))
    }

    fn published_versions(&self, reference: AnchorRef<'_>) -> Option<Result<Vec<String>, ReleaseError>> {
        Some((|| {
            let Some(doc) = fetch_json(&self.document_url(reference)?)? else { return Ok(Vec::new()) };
            Ok(doc.get("versions").and_then(Value::as_object).map(|v| v.keys().cloned().collect()).unwrap_or_default())
        })())
    }

    fn after_stamp(&self, reference: AnchorRef<'_>, version: &str, _plan: &ReleasePlan) -> Result<Vec<String>, ReleaseError> {
        let Some(name) = reference.anchor.package.name.as_ref().filter(|n| !n.is_empty()) else { return Ok(Vec::new()) };
        let mut written = Vec::new();
        for unit in &self.workspace.units {
            for anchor in &unit.anchors {
                if anchor.ecosystem != "npm" || unit.key == reference.unit.key {
                    continue;
                }
                if !uses_plain_ranges(self.manager_of(&anchor.dir)?) {
                    continue;
                }
                let relative = joined(&anchor.dir, PACKAGE_JSON);
                let file = self.workspace.root.join(&relative);
                let before = fs::read_to_string(&file).map_err(|err| ReleaseError::new(format!("{}: {err}", file.display())))?;
                let parsed = match serde_json::from_str::<Value>(&before) {
                    Ok(Value::Object(map)) => map,
                    Ok(_) => Map::new(),
                    Err(err) => return Err(ReleaseError::new(format!("{}: {err}", file.display()))),
                };
                let mut after = before.clone();
                for (dep, range, section) in dependencies(&parsed) {
                    if dep != *name {
                        continue;
                    }
                    let Some(operator) = plain_range(&range) else { continue };
                    if let Some(node) = document_scalar(&after, &[section.to_string(), dep.clone()], &relative)? {
                        after = splice_scalar(&after, &node, &format!("{operator}{version}"), &relative)?;
                    }
                }
                if after != before {
                    fs::write(&file, &after).map_err(|err| ReleaseError::new(format!("{}: {err}", file.display())))?;
                    written.push(relative);
                }
            }
        }
        Ok(written)
    }
}

const DEPENDENCY_MAPS: [&str; 4] = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/// The file set with `package.json` as its layer digests it: compact JSON, each
/// dependency map's entries in name order, every other key where it stands — a
/// package manager writes the workspace ranges it resolves in the order its
/// resolution finished, so the same package packs its maps in varying orders.
pub fn canonical_manifest(entries: Vec<FileSetEntry>) -> Result<Vec<FileSetEntry>, ReleaseError> {
    entries
        .into_iter()
        .map(|entry| match entry {
            FileSetEntry::File { path, content, executable } if path == PACKAGE_JSON => {
                let mut manifest: Map<String, Value> =
                    serde_json::from_slice(&content).map_err(|err| ReleaseError::new(format!("{PACKAGE_JSON}: {err}")))?;
                for key in DEPENDENCY_MAPS {
                    if let Some(Value::Object(map)) = manifest.get(key) {
                        let mut names: Vec<&String> = map.keys().collect();
                        names.sort();
                        let sorted: Map<String, Value> = names.into_iter().map(|name| (name.clone(), map[name].clone())).collect();
                        manifest.insert(key.to_string(), Value::Object(sorted));
                    }
                }
                let text = serde_json::to_string(&manifest).map_err(|err| ReleaseError::new(format!("{PACKAGE_JSON}: {err}")))?;
                Ok(FileSetEntry::File { path, content: text.into_bytes(), executable })
            }
            other => Ok(other),
        })
        .collect()
}

/// Pack the anchor with its own manager into a scratch directory and read the
/// file set back, refusing a manifest that would not install.
fn pack(root: &Path, reference: AnchorRef<'_>, manager: PackageManager) -> Result<Vec<FileSetEntry>, ReleaseError> {
    let dir = root.join(&reference.anchor.dir);
    let destination = scratch_dir("telorun-release-pack-")?;
    let result = (|| {
        let (command, args) = pack_command(manager, &destination);
        let run = Command::new(command).args(&args).current_dir(&dir).stdin(Stdio::null()).output().map_err(|err| {
            ReleaseError::new(format!(
                "{}: `{command} {}` could not start ({err}). {command} packs this package; install it, or name another manager in 'packageManager'.",
                reference.unit.key,
                args.join(" ")
            ))
        })?;
        if !run.status.success() {
            let stderr = String::from_utf8_lossy(&run.stderr).into_owned();
            let stdout = String::from_utf8_lossy(&run.stdout).into_owned();
            let detail = if stderr.is_empty() { stdout } else { stderr };
            return Err(ReleaseError::new(format!(
                "{}: `{command} pack` exited {}: {}",
                reference.unit.key,
                run.status.code().map_or("null".to_string(), |code| code.to_string()),
                detail.trim()
            )));
        }
        let mut tarballs: Vec<String> = fs::read_dir(&destination)
            .map_err(|err| ReleaseError::new(format!("{}: {err}", destination.display())))?
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tgz"))
            .collect();
        tarballs.sort();
        if tarballs.len() != 1 {
            return Err(ReleaseError::new(format!(
                "{}: `{command} pack` wrote {} tarballs, expected one.",
                reference.unit.key,
                tarballs.len()
            )));
        }
        let at = format!("{}'s packed {}", reference.unit.key, tarballs[0]);
        let bytes = fs::read(destination.join(&tarballs[0])).map_err(|err| ReleaseError::new(format!("{at}: {err}")))?;
        let entries = unpack_tarball(&bytes, &at)?;
        let manifest = entries.iter().find(|entry| entry.path() == PACKAGE_JSON);
        let Some(FileSetEntry::File { content, .. }) = manifest else {
            return Err(ReleaseError::new(format!("{at} holds no package.json.")));
        };
        let packed = match serde_json::from_slice::<Value>(content) {
            Ok(Value::Object(map)) => map,
            Ok(_) => Map::new(),
            Err(err) => return Err(ReleaseError::new(format!("{at}: package.json: {err}"))),
        };
        for (name, range, section) in dependencies(&packed) {
            if unpublishable(&range) {
                return Err(ReleaseError::new(format!(
                    "{at}: package.json {section}.{name} is still '{range}', which no registry install can resolve. {} did not rewrite it; pack with a manager that does, or write a range.",
                    manager.as_str()
                )));
            }
        }
        Ok(entries)
    })();
    let _ = fs::remove_dir_all(&destination);
    result
}

/// A tarball's file set, beneath its one top-level directory (`package/`).
fn unpack_tarball(bytes: &[u8], at: &str) -> Result<Vec<FileSetEntry>, ReleaseError> {
    let entries = read_tar_gz(bytes, at)?;
    let tops: BTreeSet<String> = entries.iter().map(|entry| entry.path().split('/').next().unwrap_or("").to_string()).collect();
    if tops.len() != 1 {
        return Err(ReleaseError::new(format!("{at} holds {} top-level directories, expected one.", tops.len())));
    }
    let top_len = tops.iter().next().map_or(0, String::len);
    Ok(entries
        .into_iter()
        .map(|entry| {
            let rest = entry.path().get(top_len + 1..).unwrap_or("").to_string();
            entry.renamed(rest)
        })
        .collect())
}

fn check_transport(bytes: &[u8], integrity: Option<&str>, shasum: Option<&str>, url: &str) -> Result<(), ReleaseError> {
    if let Some(integrity) = integrity.filter(|i| !i.is_empty()) {
        let (algorithm, expected) = integrity.split_once('-').unwrap_or((integrity, ""));
        let actual = match algorithm {
            "sha512" => STANDARD.encode(sha2::Sha512::digest(bytes)),
            "sha384" => STANDARD.encode(sha2::Sha384::digest(bytes)),
            "sha256" => STANDARD.encode(sha2::Sha256::digest(bytes)),
            "sha1" => STANDARD.encode(<sha1::Sha1 as sha1::Digest>::digest(bytes)),
            other => return Err(ReleaseError::new(format!("Digest method not supported: {other}"))),
        };
        if actual != expected {
            return Err(ReleaseError::new(format!("{url} does not match its dist.integrity; the download is corrupt.")));
        }
        return Ok(());
    }
    if let Some(shasum) = shasum.filter(|s| !s.is_empty()) {
        let actual: String = <sha1::Sha1 as sha1::Digest>::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
        if actual != shasum {
            return Err(ReleaseError::new(format!("{url} does not match its dist.shasum; the download is corrupt.")));
        }
    }
    Ok(())
}

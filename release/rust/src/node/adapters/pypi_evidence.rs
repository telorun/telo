//! The `pypi` ecosystem's evidence half.
//!
//! Its layer is the member set of the sdist the declared `[build-system]`
//! backend builds through PEP 517 `build_sdist`, in a fresh virtual
//! environment holding only `[build-system].requires` (and what the backend
//! asks for), so the backend's own include and exclude rules decide
//! membership. The core metadata a backend derives from the project —
//! `PKG-INFO` and any `*.egg-info` directory — is left out, so a backend
//! release that rewrites it moves no digest; whatever the build leaves in the
//! project is removed. Installing the requirements reads the package index pip
//! is configured with (or pip's cache). Read-back finds the sdist at the PEP
//! 440 normalized version in the simple index `registry` names and digests it
//! by the same rule; with no `registry` the layer is unverifiable and there is
//! no destination. Import edges are the links `adapters/pypi.rs` reads;
//! `apply` moves a dependent's linked requirement and every lockfile entry
//! recording a moved version.

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;

use sha2::{Digest, Sha256};

use crate::adapters::pypi::{
    is_generated_sdist_member, js_trim, move_pypi_lock_content_hash, normalize_pypi_name, normalize_pypi_version, pypi_build_system,
    pypi_destination, pypi_project_index, pypi_version_problem, read_pypi_project, sdist_in_index, simple_index_files, stamp_linked_requirements, stamp_pypi_lockfile,
    versions_in_index, IndexFile, PypiBuildSystem, PypiLink, PypiProjectFile, PYPI_LOCKFILES, PYPROJECT_TOML,
};
use crate::fragment::UnitKey;
use crate::ledger::AnchorDigest;
use crate::release_plan::ReleasePlan;
use crate::units::{ResolvedAnchor, ResolvedUnit, WorkspaceTree};
use crate::ReleaseError;

use super::super::evidence::{AnchorEvidence, AnchorRef, EvidenceAdapter, EvidenceSession, ReadBack, SessionOptions};
use super::super::files_digest::{digest_file_set, without_bookkeeping, FileSetEntry};
use super::super::registry_fetch::{fetch_bytes, fetch_response_or_absent};
use super::super::tar::{read_tar_gz, scratch_dir};
use super::super::workspace::ReleaseWorkspace;
use super::pypi_build_sdist::PYPI_BUILD_SDIST_SCRIPT;

/// Builds the sdist of the project in a directory and returns its members,
/// named relative to the sdist's top directory.
pub type SdistBuilder = dyn Fn(&Path, &PypiBuildSystem, &str) -> Result<Vec<FileSetEntry>, ReleaseError> + Send + Sync;

const SIMPLE_JSON: &str = "application/vnd.pypi.simple.v1+json";

fn err(message: String) -> ReleaseError {
    ReleaseError::new(message)
}

fn joined(dir: &str, relative: &str) -> String {
    if dir.is_empty() {
        relative.to_string()
    } else {
        format!("{dir}/{relative}")
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// An sdist's members beneath its one top directory.
pub fn sdist_members(bytes: &[u8], at: &str) -> Result<Vec<FileSetEntry>, ReleaseError> {
    let entries = read_tar_gz(bytes, at)?;
    let tops: BTreeSet<&str> = entries.iter().map(|entry| entry.path().split('/').next().unwrap_or("")).collect();
    if tops.len() != 1 {
        return Err(err(format!("{at} holds {} top-level directories, expected one.", tops.len())));
    }
    let top = tops.iter().next().map(|top| top.to_string()).unwrap_or_default();
    let lead = format!("{top}/");
    entries
        .into_iter()
        .map(|entry| match entry.path().strip_prefix(&lead) {
            Some(rest) => {
                let rest = rest.to_string();
                Ok(entry.renamed(rest))
            }
            None => Err(err(format!("{at} holds '{}' outside its '{top}/' directory.", entry.path()))),
        })
        .collect()
}

/// The members a pypi layer digests: the sdist less derived metadata and the planner's bookkeeping.
fn layer_members(members: Vec<FileSetEntry>, anchor_dir: &str) -> Vec<FileSetEntry> {
    without_bookkeeping(members.into_iter().filter(|member| !is_generated_sdist_member(member.path())).collect(), anchor_dir)
}

#[cfg(unix)]
fn signal_of(status: &std::process::ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt;
    let names = [(1, "SIGHUP"), (2, "SIGINT"), (3, "SIGQUIT"), (6, "SIGABRT"), (9, "SIGKILL"), (11, "SIGSEGV"), (13, "SIGPIPE"), (15, "SIGTERM")];
    match status.signal() {
        Some(signal) => names.iter().find(|(n, _)| *n == signal).map_or_else(|| format!("signal {signal}"), |(_, name)| name.to_string()),
        None => "null".into(),
    }
}

#[cfg(not(unix))]
fn signal_of(_status: &std::process::ExitStatus) -> String {
    "null".into()
}

fn run(command: &Path, args: &[OsString], cwd: &Path, at: &str, remedy: &str) -> Result<String, ReleaseError> {
    let shown = format!(
        "`{}`",
        std::iter::once(command.to_string_lossy().into_owned()).chain(args.iter().map(|a| a.to_string_lossy().into_owned())).collect::<Vec<_>>().join(" ")
    );
    let output = Command::new(command)
        .args(args)
        .current_dir(cwd)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| err(format!("{at}: {shown} could not start ({error}).{remedy}")))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        let code = output.status.code().map_or_else(|| signal_of(&output.status), |code| code.to_string());
        let detail = if stderr.is_empty() { &stdout } else { &stderr };
        return Err(err(format!("{at}: {shown} exited {code}: {}{remedy}", js_trim(detail))));
    }
    Ok(stdout)
}

/// What a build backend leaves behind.
fn is_build_leftover(name: &str) -> bool {
    name.ends_with(".egg-info") || matches!(name, "build" | ".pdm-build" | "dist")
}

/// Where a backend leaves them: the project's top directory, and `src` for a src layout.
const LEFTOVER_DIRS: [&str; 2] = ["", "src"];

fn names_in(dir: &Path) -> Result<HashSet<String>, ReleaseError> {
    let mut found = HashSet::new();
    if !dir.exists() {
        return Ok(found);
    }
    for entry in fs::read_dir(dir).map_err(|e| err(format!("{}: {e}", dir.display())))? {
        let entry = entry.map_err(|e| err(format!("{}: {e}", dir.display())))?;
        found.insert(entry.file_name().to_string_lossy().into_owned());
    }
    Ok(found)
}

/// The names directly in each of [`LEFTOVER_DIRS`], as the build found them.
fn top_level_names(dir: &Path) -> Result<Vec<HashSet<String>>, ReleaseError> {
    LEFTOVER_DIRS.iter().map(|sub| names_in(&dir.join(sub))).collect()
}

/// Remove the build leftovers that appeared directly in those directories since
/// `before`; returns what could not be removed, with why.
fn remove_created(dir: &Path, before: &[HashSet<String>]) -> Result<Vec<String>, ReleaseError> {
    let mut left = Vec::new();
    for (sub, known) in LEFTOVER_DIRS.iter().zip(before) {
        let at = dir.join(sub);
        for name in names_in(&at)? {
            if known.contains(&name) || !is_build_leftover(&name) {
                continue;
            }
            let full = at.join(&name);
            let is_dir = full.is_dir();
            let removed = if is_dir { fs::remove_dir_all(&full) } else { fs::remove_file(&full) };
            if let Err(error) = removed {
                left.push(format!("{} ({error})", full.display()));
            }
        }
    }
    Ok(left)
}

const PIP_REMEDY: &str = " Installing the build requirements reads the package index pip is configured with, or pip's cache.";

fn os(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

/// The sdist `build_sdist` produces in an isolated environment: a fresh venv,
/// `[build-system].requires` and the backend's own sdist requirements
/// installed into it, then the frontend run in the project directory.
pub fn isolated_sdist_builder(project_dir: &Path, system: &PypiBuildSystem, at: &str) -> Result<Vec<FileSetEntry>, ReleaseError> {
    let scratch = scratch_dir("telorun-release-pypi-")?;
    let built = build_in(&scratch, project_dir, system, at);
    match fs::remove_dir_all(&scratch) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(err(format!("{}: {error}", scratch.display()))),
        _ => built,
    }
}

fn build_in(scratch: &Path, project_dir: &Path, system: &PypiBuildSystem, at: &str) -> Result<Vec<FileSetEntry>, ReleaseError> {
    let python = Path::new(if cfg!(windows) { "python" } else { "python3" });
    let env = scratch.join("env");
    let mut venv = os(&["-I", "-m", "venv"]);
    venv.push(env.clone().into_os_string());
    run(python, &venv, scratch, at, " Install Python 3 with its venv module; the sdist is built in a fresh one.")?;
    let env_python = if cfg!(windows) { env.join("Scripts").join("python.exe") } else { env.join("bin").join("python") };
    let install = |requirements: &[String]| -> Result<String, ReleaseError> {
        let mut args = os(&["-I", "-m", "pip", "install", "--no-input", "--quiet"]);
        args.extend(requirements.iter().map(OsString::from));
        run(&env_python, &args, scratch, at, PIP_REMEDY)
    };
    if !system.requires.is_empty() {
        install(&system.requires)?;
    }
    let frontend = scratch.join("pypi-build-sdist.py");
    fs::write(&frontend, PYPI_BUILD_SDIST_SCRIPT).map_err(|e| err(format!("{}: {e}", frontend.display())))?;
    let out = scratch.join("out");
    fs::create_dir(&out).map_err(|e| err(format!("{}: {e}", out.display())))?;

    let before = top_level_names(project_dir)?;
    let attempt = (|| {
        let backend: Vec<OsString> = std::iter::once(&system.backend).chain(&system.backend_path).map(OsString::from).collect();
        let mut requires = vec![OsString::from("-I"), frontend.clone().into_os_string(), OsString::from("requires")];
        requires.extend(backend.iter().cloned());
        let extra: Vec<String> = run(&env_python, &requires, project_dir, at, "")?.lines().filter(|line| !line.is_empty()).map(str::to_string).collect();
        if !extra.is_empty() {
            install(&extra)?;
        }
        let mut build = vec![OsString::from("-I"), frontend.clone().into_os_string(), OsString::from("build"), out.clone().into_os_string()];
        build.extend(backend.iter().cloned());
        let answer = run(&env_python, &build, project_dir, at, "")?;
        let name = js_trim(&answer).lines().last().unwrap_or("").to_string();
        let file = out.join(&name);
        if name.is_empty() || !file.exists() {
            return Err(err(format!("{at}: the build backend reported the sdist '{name}', which it did not write.")));
        }
        let bytes = fs::read(&file).map_err(|e| err(format!("{}: {e}", file.display())))?;
        sdist_members(&bytes, &format!("{at}'s sdist {name}"))
    })();
    let left = remove_created(project_dir, &before)?;
    let members = attempt?;
    if !left.is_empty() {
        return Err(err(format!("{at}: building the sdist left {} in the project, which could not be removed.", left.join(", "))));
    }
    Ok(members)
}

#[derive(Default)]
pub struct PypiEvidenceOptions {
    /// How an sdist is built; [`isolated_sdist_builder`] unless given.
    pub build_sdist: Option<Arc<SdistBuilder>>,
}

pub struct PypiEvidence {
    build_sdist: Arc<SdistBuilder>,
}

pub fn pypi_evidence_with(options: PypiEvidenceOptions) -> PypiEvidence {
    PypiEvidence { build_sdist: options.build_sdist.unwrap_or_else(|| Arc::new(isolated_sdist_builder)) }
}

pub fn pypi_evidence() -> PypiEvidence {
    pypi_evidence_with(PypiEvidenceOptions::default())
}

struct PypiSession<'a> {
    workspace: &'a ReleaseWorkspace,
    build_sdist: Arc<SdistBuilder>,
    anchors: Vec<(&'a ResolvedUnit, &'a ResolvedAnchor)>,
    table: RefCell<Option<HashMap<String, Vec<PypiLink>>>>,
    lockfiles: RefCell<Option<Vec<String>>>,
}

impl EvidenceAdapter for PypiEvidence {
    fn ecosystem(&self) -> &'static str {
        "pypi"
    }

    fn open<'a>(&self, workspace: &'a ReleaseWorkspace, _options: &SessionOptions<'_>) -> Result<Box<dyn EvidenceSession + 'a>, ReleaseError> {
        let anchors = workspace.units.iter().flat_map(|unit| unit.anchors.iter().filter(|a| a.ecosystem == "pypi").map(move |a| (unit, a))).collect();
        Ok(Box::new(PypiSession { workspace, build_sdist: self.build_sdist.clone(), anchors, table: RefCell::new(None), lockfiles: RefCell::new(None) }))
    }
}

fn file_of(dir: &str) -> String {
    joined(dir, PYPROJECT_TOML)
}

fn name_of(reference: AnchorRef<'_>) -> &str {
    reference.anchor.package.name.as_deref().unwrap_or("")
}

impl PypiSession<'_> {
    /// The lockfiles of the workspace, listed once per session.
    fn lockfile_paths(&self) -> Vec<String> {
        self.lockfiles
            .borrow_mut()
            .get_or_insert_with(|| {
                let directories = std::iter::once(String::new()).chain(self.workspace.tree.directories().iter().cloned());
                directories
                    .flat_map(|dir| PYPI_LOCKFILES.iter().map(move |lockfile| joined(&dir, lockfile)))
                    .filter(|lock| self.workspace.tree_read(lock).is_some())
                    .collect()
            })
            .clone()
    }

    fn read_projects(&self) -> Result<Vec<PypiProjectFile>, ReleaseError> {
        self.anchors
            .iter()
            .map(|(unit, anchor)| {
                let file = file_of(&anchor.dir);
                let text = self.workspace.tree_read(&file).ok_or_else(|| err(format!("{}: {file} does not exist.", unit.key)))?;
                Ok(PypiProjectFile { unit: unit.key.clone(), dir: anchor.dir.clone(), text })
            })
            .collect()
    }

    fn links_of(&self, dir: &str) -> Result<Vec<PypiLink>, ReleaseError> {
        if self.table.borrow().is_none() {
            let projects = self.read_projects()?;
            let index = pypi_project_index(&projects);
            let mut problems = Vec::new();
            let mut read = HashMap::new();
            for project in &projects {
                let found = read_pypi_project(&project.dir, &project.text, &index)?;
                read.insert(project.dir.clone(), found.links);
                problems.extend(found.problems);
            }
            if !problems.is_empty() {
                return Err(err(problems.join("\n")));
            }
            *self.table.borrow_mut() = Some(read);
        }
        Ok(self.table.borrow().as_ref().and_then(|table| table.get(dir).cloned()).unwrap_or_default())
    }

    fn imports_of(&self, reference: AnchorRef<'_>) -> Result<Vec<UnitKey>, ReleaseError> {
        let owners: HashMap<&str, &str> = self.anchors.iter().map(|(unit, anchor)| (anchor.dir.as_str(), unit.key.as_str())).collect();
        let mut found = BTreeSet::new();
        for link in self.links_of(&reference.anchor.dir)? {
            if let Some(owner) = owners.get(link.target.as_str()).filter(|owner| **owner != reference.unit.key) {
                found.insert(owner.to_string());
            }
        }
        Ok(found.into_iter().collect())
    }

    fn registry_of(&self, reference: AnchorRef<'_>) -> Option<String> {
        reference.anchor.settings.get("registry").and_then(|r| r.as_str()).map(|r| r.trim_end_matches('/').to_string())
    }

    /// The project page and what it lists; `None` with no registry.
    fn index_page(&self, reference: AnchorRef<'_>) -> Result<Option<(String, Vec<IndexFile>)>, ReleaseError> {
        let Some(registry) = self.registry_of(reference) else { return Ok(None) };
        let page = format!("{registry}/{}/", normalize_pypi_name(name_of(reference)));
        let accept = format!("{SIMPLE_JSON}, text/html;q=0.1");
        let Some(response) = fetch_response_or_absent(&page, &[("accept", &accept)])? else {
            return Ok(Some((page, Vec::new())));
        };
        let json = response.content_type.as_deref().unwrap_or("").contains(SIMPLE_JSON);
        let files = simple_index_files(&String::from_utf8_lossy(&response.bytes), json, &page)?;
        Ok(Some((page, files)))
    }

    fn read_back_inner(&self, reference: AnchorRef<'_>, version: &str, recorded: Option<&AnchorDigest>) -> Result<ReadBack, ReleaseError> {
        if self.registry_of(reference).is_none() {
            return Ok(ReadBack::Unverifiable { reason: "no registry names the index it is published to".into() });
        }
        if normalize_pypi_version(version).is_none() {
            return Err(err(format!(
                "{}: '{version}' is not a version PEP 440 can spell, so it cannot be looked up in an index.",
                reference.unit.key
            )));
        }
        let Some((page, files)) = self.index_page(reference)? else { return Ok(ReadBack::Absent) };
        let Some(sdist) = sdist_in_index(&files, name_of(reference), version, &page)? else { return Ok(ReadBack::Absent) };
        let url = resolve_url(&page, &sdist.href);
        let bytes = fetch_bytes(&url)?;
        if sdist.sha256.as_ref().is_some_and(|expected| sha256_hex(&bytes) != *expected) {
            return Err(err(format!("{url} does not match the sha256 its index lists; the download is corrupt.")));
        }
        let layer = digest_file_set(&layer_members(sdist_members(&bytes, &url)?, &reference.anchor.dir))?;
        let drift = match recorded {
            Some(AnchorDigest::One(was)) if *was == layer => Vec::new(),
            Some(_) => vec![format!("pypi/{}", reference.anchor.anchor)],
            None => Vec::new(),
        };
        Ok(ReadBack::Published { layer: AnchorDigest::One(layer), drift })
    }
}

impl EvidenceSession for PypiSession<'_> {
    fn collect(&self, reference: AnchorRef<'_>) -> Result<AnchorEvidence, ReleaseError> {
        let imports = self.imports_of(reference)?;
        if !reference.anchor.package.contributes_layer {
            return Ok(AnchorEvidence { imports, ..AnchorEvidence::default() });
        }
        let file = file_of(&reference.anchor.dir);
        let path = self.workspace.root.join(&file);
        let text = fs::read_to_string(&path).map_err(|e| err(format!("{}: {e}", path.display())))?;
        let Some(system) = pypi_build_system(&text, &file)? else {
            return Err(err(format!("{}: {file} declares no [build-system], so no sdist can be built.", reference.unit.key)));
        };
        let dir = self.workspace.root.join(&reference.anchor.dir);
        let members = layer_members((self.build_sdist)(&dir, &system, &reference.unit.key)?, &reference.anchor.dir);
        Ok(AnchorEvidence {
            layer: Some(AnchorDigest::One(digest_file_set(&members)?)),
            files: members.iter().filter(|m| dir.join(m.path()).exists()).map(|m| joined(&reference.anchor.dir, m.path())).collect(),
            imports,
            ..AnchorEvidence::default()
        })
    }

    fn imports(&self, reference: AnchorRef<'_>) -> Result<Vec<UnitKey>, ReleaseError> {
        self.imports_of(reference)
    }

    fn destination(&self, reference: AnchorRef<'_>) -> Option<String> {
        self.registry_of(reference).map(|registry| pypi_destination(&registry, name_of(reference)))
    }

    fn read_back(&self, reference: AnchorRef<'_>, version: &str, recorded: Option<&AnchorDigest>) -> Option<Result<ReadBack, ReleaseError>> {
        Some(self.read_back_inner(reference, version, recorded))
    }

    fn published_versions(&self, reference: AnchorRef<'_>) -> Option<Result<Vec<String>, ReleaseError>> {
        Some(self.index_page(reference).map(|found| found.map(|(_, files)| versions_in_index(&files, name_of(reference))).unwrap_or_default()))
    }

    fn after_stamp(&self, reference: AnchorRef<'_>, version: &str, plan: &ReleasePlan, journal: &mut dyn FnMut(&str) -> Result<(), ReleaseError>) -> Result<Vec<String>, ReleaseError> {
        let _ = plan;
        if normalize_pypi_version(version).is_none() {
            let problem = pypi_version_problem(version).unwrap_or_else(|| format!("'{version}' is not a version PEP 440 can spell"));
            return Err(err(format!("{}: {problem}", reference.unit.key)));
        }
        let root = &self.workspace.root;
        let mut written = BTreeSet::new();
        let mut write = |relative: &str, text: &str| -> Result<(), ReleaseError> {
            journal(relative)?;
            let path = root.join(relative);
            fs::write(&path, text).map_err(|e| err(format!("{}: {e}", path.display())))?;
            written.insert(relative.to_string());
            Ok(())
        };
        let read = |relative: &str| self.workspace.tree_read(relative);
        let sha256 = |text: &str| sha256_hex(text.as_bytes());
        let projects = self.read_projects()?;
        let index = pypi_project_index(&projects);
        for project in &projects {
            if project.dir == reference.anchor.dir {
                continue;
            }
            let after = stamp_linked_requirements(&project.text, &project.dir, &index, &reference.anchor.dir, version)?;
            if after == project.text {
                continue;
            }
            for lockfile in ["poetry.lock", "pdm.lock"] {
                let lock = joined(&project.dir, lockfile);
                let Some(text) = read(&lock) else { continue };
                if let Some(moved) = move_pypi_lock_content_hash(&text, &lock, &project.text, &after, &file_of(&project.dir), &sha256)? {
                    write(&lock, &moved)?;
                }
            }
            write(&file_of(&project.dir), &after)?;
        }
        for lock in self.lockfile_paths() {
            let Some(text) = read(&lock) else { continue };
            if let Some(moved) = stamp_pypi_lockfile(&text, &lock, name_of(reference), &reference.anchor.dir, version)? {
                write(&lock, &moved)?;
            }
        }
        Ok(written.into_iter().collect())
    }
}

/// `new URL(href, base).href` for an http(s) base: RFC 3986 resolution, with
/// the path and query percent-encoded as the WHATWG URL standard encodes them.
fn resolve_url(base: &str, href: &str) -> String {
    fn scheme_of(url: &str) -> Option<usize> {
        let colon = url.find(':')?;
        let scheme = &url[..colon];
        let mut chars = scheme.chars();
        (chars.next().is_some_and(|c| c.is_ascii_alphabetic()) && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')))
            .then_some(colon)
    }
    fn remove_dot_segments(path: &str) -> String {
        let mut out: Vec<&str> = Vec::new();
        let segments: Vec<&str> = path.split('/').collect();
        for (i, segment) in segments.iter().enumerate() {
            let last = i + 1 == segments.len();
            match *segment {
                "." | "%2e" | "%2E" => {
                    if last {
                        out.push("");
                    }
                }
                ".." | ".%2e" | ".%2E" | "%2e." | "%2E." | "%2e%2e" | "%2E%2E" | "%2e%2E" | "%2E%2e" => {
                    if out.len() > 1 {
                        out.pop();
                    }
                    if last {
                        out.push("");
                    }
                }
                other => out.push(other),
            }
        }
        out.join("/")
    }
    fn encode(text: &str, escape: &dyn Fn(u8) -> bool) -> String {
        let mut out = String::new();
        for byte in text.bytes() {
            if byte >= 0x80 || escape(byte) {
                out.push_str(&format!("%{byte:02X}"));
            } else {
                out.push(byte as char);
            }
        }
        out
    }
    /// `(authority, path, query)` of what follows a scheme's colon.
    fn hierarchical(after_scheme: &str) -> (String, String, Option<String>) {
        let (part, query) = split_query(after_scheme);
        let after = part.strip_prefix("//").unwrap_or(&part);
        match after.find('/') {
            Some(slash) => (after[..slash].to_string(), after[slash..].to_string(), query),
            None => (after.to_string(), "/".to_string(), query),
        }
    }
    fn split_query(text: &str) -> (String, Option<String>) {
        match text.split_once('?') {
            Some((path, query)) => (path.replace('\\', "/"), Some(query.to_string())),
            None => (text.replace('\\', "/"), None),
        }
    }
    let href = href.trim_matches(|c: char| c <= ' ');
    let base_colon = scheme_of(base).unwrap_or(0);
    let (base_authority, base_path, base_query) = hierarchical(&base[base_colon + 1..]);
    let (scheme, authority, path, query) = match scheme_of(href) {
        Some(colon) => {
            let (authority, path, query) = hierarchical(&href[colon + 1..]);
            (href[..colon].to_string(), authority, path, query)
        }
        None => {
            let (part, query) = split_query(href);
            let (authority, path, query) = if part.starts_with("//") {
                hierarchical(href)
            } else if part.starts_with('/') {
                (base_authority, part, query)
            } else if part.is_empty() {
                (base_authority, base_path, if href.contains('?') { query } else { base_query })
            } else {
                let dir = &base_path[..base_path.rfind('/').map_or(0, |i| i + 1)];
                (base_authority, format!("{dir}{part}"), query)
            };
            (base[..base_colon].to_string(), authority, path, query)
        }
    };
    let path = encode(&remove_dot_segments(&path), &|b| b <= 0x20 || matches!(b, b'"' | b'#' | b'<' | b'>' | b'`' | b'{' | b'}' | 0x7f));
    let query = query.map(|q| format!("?{}", encode(&q, &|b| b <= 0x20 || matches!(b, b'"' | b'#' | b'<' | b'>' | b'\'' | 0x7f)))).unwrap_or_default();
    format!("{}://{authority}{path}{query}", scheme.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::resolve_url;

    #[test]
    fn resolves_a_link_as_a_browser_does() {
        let page = "https://index.example/simple/acme-api/";
        assert_eq!(resolve_url(page, "../../files/a-1.0.tar.gz"), "https://index.example/files/a-1.0.tar.gz");
        assert_eq!(resolve_url(page, "/f/a b.tar.gz?x=1&y=2"), "https://index.example/f/a%20b.tar.gz?x=1&y=2");
        assert_eq!(resolve_url(page, "a.tar.gz"), "https://index.example/simple/acme-api/a.tar.gz");
        assert_eq!(resolve_url(page, "//files.example/a.tar.gz"), "https://files.example/a.tar.gz");
        assert_eq!(resolve_url(page, "HTTPS://files.example/x/../a.tar.gz"), "https://files.example/a.tar.gz");
    }
}

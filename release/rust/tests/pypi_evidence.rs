//! The pypi evidence over a git repository on disk — the Rust half of the Node
//! package's `tests/node/pypi-evidence.test.ts`. A stand-in builder serves
//! every test but the last, which builds a real sdist when python3 with venv
//! and setuptools (from an index or pip's cache) are at hand.

use std::cell::RefCell;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Stdio};
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use flate2::write::GzEncoder;
use serde_json::{json, Map, Value};
use sha2::Digest;

use telorun_release::adapters::pypi::PypiBuildSystem;
use telorun_release::ledger::{AnchorDigest, Ledger};
use telorun_release::node::adapters::pypi_evidence::{isolated_sdist_builder, pypi_evidence_with, PypiEvidenceOptions, SdistBuilder};
use telorun_release::node::commands::release_commands;
use telorun_release::node::evidence::{AnchorRef, EvidenceAdapter, EvidenceSession, ReadBack, SessionOptions};
use telorun_release::node::files_digest::{digest_file_set, list_files, read_file_set_entry, FileSetEntry};
use telorun_release::node::host::{ReleaseHost, ReleaseOutput, Style};
use telorun_release::node::workspace::{load_release_workspace, LoadOptions, ReleaseWorkspace};
use telorun_release::release_settings::ReadReleaseOptions;
use telorun_release::{shipped_adapters, ReleaseError};

#[derive(Default)]
struct Recorded {
    stderr: RefCell<Vec<String>>,
    payloads: RefCell<Vec<Map<String, Value>>>,
    documents: RefCell<Vec<String>>,
}

impl ReleaseOutput for Recorded {
    fn line(&self, _text: &str) {}
    fn err_line(&self, text: &str) {
        self.stderr.borrow_mut().push(text.to_string());
    }
    fn emit(&self, payload: Map<String, Value>) {
        self.payloads.borrow_mut().push(payload);
    }
    fn document(&self, text: &str) {
        self.documents.borrow_mut().push(text.to_string());
    }
    fn progress(&self, _text: &str) {}
    fn style(&self) -> Style {
        Style { on: false }
    }
    fn err_style(&self) -> Style {
        Style { on: false }
    }
}

fn git(root: &Path, args: &[&str]) {
    let run = Command::new("git")
        .args(["-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(root)
        .output()
        .expect("git runs");
    assert!(run.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&run.stderr));
}

fn write(root: &Path, files: &[(&str, &str)]) {
    for (file, text) in files {
        let path = root.join(file);
        fs::create_dir_all(path.parent().expect("a parent")).expect("a directory");
        fs::write(path, text).expect("a file");
    }
}

fn commit(root: &Path, message: &str) {
    git(root, &["add", "-A"]);
    git(root, &["commit", "-q", "--allow-empty", "-m", message]);
}

fn repo(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("a scratch directory");
    write(dir.path(), files);
    git(dir.path(), &["init", "-q", "-b", "main"]);
    commit(dir.path(), "init");
    dir
}

fn read(root: &Path, file: &str) -> String {
    fs::read_to_string(root.join(file)).expect("a file")
}

fn run(root: &Path, args: &[&str], builder: Arc<SdistBuilder>) -> (Value, i32, Rc<Recorded>) {
    let recorded = Rc::new(Recorded::default());
    let evidence: Vec<Arc<dyn EvidenceAdapter>> = vec![Arc::new(pypi_evidence_with(PypiEvidenceOptions { build_sdist: Some(builder) }))];
    let host = ReleaseHost {
        command: "telo-release".into(),
        adapters: shipped_adapters(),
        evidence,
        ecosystem_hosts: ReadReleaseOptions::default(),
        ledger: None,
        read_marker: None,
        output: recorded.clone(),
        global_options: Vec::new(),
        subcommands: Vec::new(),
        check: None,
        after_apply: None,
    };
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    let code = release_commands(&host, &args, root);
    let payload = recorded.payloads.borrow().last().cloned().map(Value::Object).unwrap_or(Value::Null);
    (payload, code, recorded)
}

/// Every file of a directory as the digest reads it.
fn files_of(dir: &Path) -> Vec<FileSetEntry> {
    list_files(dir, &|_| false).expect("listed").iter().map(|file| read_file_set_entry(dir, file, file).expect("read")).collect()
}

/// Stands in for a backend: every file of the project, plus the metadata a
/// backend derives; it fails where `fail` says so.
fn fake_builder(fail: fn(&Path) -> bool) -> Arc<SdistBuilder> {
    Arc::new(move |project: &Path, system: &PypiBuildSystem, at: &str| {
        if fail(project) {
            return Err(ReleaseError::new(format!("{at}: the backend failed")));
        }
        let mut members = files_of(project);
        members.push(FileSetEntry::File {
            path: "PKG-INFO".into(),
            content: format!("Metadata-Version: 2.4\nBackend: {}\n", system.backend).into_bytes(),
            executable: false,
        });
        members.push(FileSetEntry::File { path: "src/acme_api.egg-info/SOURCES.txt".into(), content: b"x\n".to_vec(), executable: false });
        Ok(members)
    })
}

fn never(_: &Path) -> bool {
    false
}

const API: &str = "[project]\nname = \"Acme.API\"\nversion = \"1.0.0\"\n\n[build-system]\nrequires = [\"hatchling\"]\nbuild-backend = \"hatchling.build\"\n";
const WORKER: &str = "[project]\nname = \"worker\"\nversion = \"0.3.0\"\ndependencies = [\n  \"acme-api>=1.0.0\",\n  \"acme_api[x] >=1.0, <2\",\n  \"requests>=2\",\n]\n\n[build-system]\nrequires = [\"hatchling\"]\nbuild-backend = \"hatchling.build\"\n\n[tool.uv.sources]\nacme-api = { workspace = true }\n";
const UV_LOCK: &str = "version = 1\n\n[[package]]\nname = \"acme-api\"\nversion = \"1.0.0\"\nsource = { editable = \"apps/api\" }\n\n[[package]]\nname = \"requests\"\nversion = \"1.0.0\"\nsource = { registry = \"https://pypi.org/simple\" }\n\n[[package]]\nname = \"worker\"\nversion = \"0.3.0\"\nsource = { editable = \"apps/worker\" }\n";
const MARKER: &str = "release:\n  units:\n    - { path: apps/api, ecosystem: pypi }\n    - { path: apps/worker, ecosystem: pypi }\n";

fn workspace(marker: &str) -> Vec<(&str, &str)> {
    vec![
        ("telo-workspace.yaml", marker),
        ("apps/api/pyproject.toml", API),
        ("apps/api/src/acme_api/__init__.py", "x = 1\n"),
        ("apps/worker/pyproject.toml", WORKER),
        ("apps/worker/src/worker/__init__.py", "y = 1\n"),
        ("uv.lock", UV_LOCK),
    ]
}

fn load(root: &Path) -> ReleaseWorkspace {
    let adapters = shipped_adapters();
    load_release_workspace(root, &LoadOptions { adapters: &adapters, ecosystem_hosts: &ReadReleaseOptions::default(), read_marker: None, command: "telo-release" })
        .expect("the workspace loads")
}

fn open<'a>(ws: &'a ReleaseWorkspace, builder: Arc<SdistBuilder>) -> Box<dyn EvidenceSession + 'a> {
    let ledger = Ledger::default();
    pypi_evidence_with(PypiEvidenceOptions { build_sdist: Some(builder) }).open(ws, &SessionOptions { ledger: &ledger, argv: &Map::new() }).expect("opens")
}

fn reference<'a>(ws: &'a ReleaseWorkspace, key: &str) -> AnchorRef<'a> {
    let unit = ws.units.iter().find(|u| u.key == key).expect("the unit");
    AnchorRef { unit, anchor: &unit.anchors[0] }
}

#[test]
fn digests_the_sdists_members_less_the_metadata_its_backend_derives() {
    let dir = repo(&workspace(MARKER));
    let ws = load(dir.path());
    let session = open(&ws, fake_builder(never));
    let found = session.collect(reference(&ws, "apps/api")).expect("collected");
    let expected = digest_file_set(&files_of(&dir.path().join("apps/api"))).expect("a digest");
    assert_eq!(found.layer, Some(AnchorDigest::One(expected)));
    assert_eq!(found.files, vec!["apps/api/pyproject.toml", "apps/api/src/acme_api/__init__.py"]);
}

#[test]
fn plans_a_dependent_with_its_sibling_and_moves_its_linked_requirement_and_the_lockfile_on_apply() {
    let dir = repo(&workspace(MARKER));
    let root = dir.path();
    assert_eq!(run(root, &["baseline"], fake_builder(never)).1, 0);
    commit(root, "baseline");
    write(root, &[(".changes/pending/added-x.yaml", "units: { apps/api: Added }\nbody: A thing.\n")]);
    commit(root, "fragment");

    let (status, _, _) = run(root, &["status", "--base", "HEAD", "-o", "json"], fake_builder(never));
    let reasons: Vec<Value> = status["units"].as_array().expect("units").iter().map(|u| json!([u["key"], u["reasons"]])).collect();
    assert_eq!(reasons, vec![json!(["apps/api", ["declared"]]), json!(["apps/worker", ["imports apps/api"]])]);
    assert_eq!(run(root, &["apply", "--base", "HEAD"], fake_builder(never)).1, 0);
    assert_eq!(
        read(root, "apps/worker/pyproject.toml"),
        WORKER.replace("version = \"0.3.0\"", "version = \"0.4.0\"").replace("\"acme-api>=1.0.0\"", "\"acme-api>=1.1.0\"")
    );
    assert_eq!(
        read(root, "uv.lock"),
        UV_LOCK.replace("version = \"1.0.0\"\nsource = { editable", "version = \"1.1.0\"\nsource = { editable").replace("\"0.3.0\"", "\"0.4.0\"")
    );
}

#[test]
fn restores_the_lockfile_and_every_pyproject_when_the_apply_fails_after_moving_them() {
    let mut files = workspace(MARKER);
    files.push((".changes/ledger.yaml", "units:\n  apps/api: { version: 1.0.0, layers: { pypi: { .: sha256-old } } }\n"));
    files.push((".changes/pending/fixed-x.yaml", "units: { apps/api: Fixed }\nbody: A fix.\n"));
    let dir = repo(&files);
    let root = dir.path();
    // The second reading of the api, taken once the versions are written, fails.
    let failing = fake_builder(|project| fs::read_to_string(project.join("pyproject.toml")).is_ok_and(|text| text.contains("1.0.1")));
    let (_, code, recorded) = run(root, &["apply", "--base", "HEAD"], failing);
    assert_eq!(code, 1);
    let stderr = recorded.stderr.borrow().join("\n");
    let failed = stderr.find("the backend failed").expect("the failure is named");
    assert!(stderr[failed..].contains("The apply was undone"), "{stderr}");
    assert_eq!(read(root, "uv.lock"), UV_LOCK);
    assert_eq!(read(root, "apps/worker/pyproject.toml"), WORKER);
    assert_eq!(read(root, "apps/api/pyproject.toml"), API);
}

/// A gzipped ustar archive of `files` beneath `top/`.
fn sdist(top: &str, files: &[(&str, &str)]) -> Vec<u8> {
    let mut tar = Vec::new();
    for (name, text) in files {
        let mut header = [0u8; 512];
        let path = format!("{top}/{name}");
        header[..path.len()].copy_from_slice(path.as_bytes());
        header[100..108].copy_from_slice(b"0000644\0");
        header[124..136].copy_from_slice(format!("{:011o}\0", text.len()).as_bytes());
        header[156] = b'0';
        tar.extend_from_slice(&header);
        tar.extend_from_slice(text.as_bytes());
        tar.resize(tar.len().div_ceil(512) * 512, 0);
    }
    tar.resize(tar.len() + 1024, 0);
    let mut gz = GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(&tar).expect("gzipped");
    gz.finish().expect("gzipped")
}

/// A local index answering `answer(path)` with `(status, content type, body)`;
/// each request's path and `accept` header are recorded.
fn serve(answer: impl Fn(&str) -> (u16, &'static str, Vec<u8>) + Send + 'static) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a port");
    let base = format!("http://{}", listener.local_addr().expect("an address"));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut reader = BufReader::new(stream.try_clone().expect("a stream"));
            let mut request = String::new();
            if reader.read_line(&mut request).is_err() {
                continue;
            }
            let path = request.split_whitespace().nth(1).unwrap_or("").to_string();
            let mut accept = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("accept") {
                        accept = value.trim().to_string();
                    }
                }
            }
            log.lock().expect("the log").push(format!("{path} {accept}"));
            let (status, content_type, body) = answer(&path);
            let head = format!("HTTP/1.1 {status} X\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
            let _ = stream.write_all(head.as_bytes()).and_then(|()| stream.write_all(&body));
        }
    });
    (base, seen)
}

#[test]
fn reads_a_version_back_from_the_simple_index_in_pep_440_form_absent_where_the_index_serves_none() {
    let files = [("pyproject.toml", API), ("src/acme_api/__init__.py", "x = 1\n"), ("PKG-INFO", "Metadata-Version: 2.1\n")];
    let bytes = sdist("acme_api-1.0.0rc1", &files);
    let sha256: String = sha2::Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    let page = json!({ "meta": { "api-version": "1.0" }, "files": [{ "filename": "acme_api-1.0.0rc1.tar.gz", "url": "../../files/acme_api-1.0.0rc1.tar.gz", "hashes": { "sha256": sha256 } }] });
    let (base, seen) = serve(move |path| match path {
        "/simple/acme-api/" => (200, "application/vnd.pypi.simple.v1+json", page.to_string().into_bytes()),
        "/files/acme_api-1.0.0rc1.tar.gz" => (200, "application/octet-stream", bytes.clone()),
        _ => (404, "text/plain", Vec::new()),
    });
    let marker = format!(
        "release:\n  ecosystems: {{ pypi: {{ registry: {base}/simple/ }} }}\n  units:\n    - {{ path: apps/api, ecosystem: pypi }}\n    - {{ path: apps/worker, ecosystem: pypi }}\n"
    );
    let dir = repo(&workspace(&marker));
    let ws = load(dir.path());
    let session = open(&ws, fake_builder(never));
    let api = reference(&ws, "apps/api");
    assert_eq!(session.destination(api), Some(format!("{base}/simple/acme-api")));
    let local = digest_file_set(&[
        FileSetEntry::File { path: "pyproject.toml".into(), content: API.as_bytes().to_vec(), executable: false },
        FileSetEntry::File { path: "src/acme_api/__init__.py".into(), content: b"x = 1\n".to_vec(), executable: false },
    ])
    .expect("a digest");
    let recorded = AnchorDigest::One(local.clone());
    assert_eq!(
        session.read_back(api, "1.0.0-rc.1", Some(&recorded)).expect("a read-back").expect("read"),
        ReadBack::Published { layer: AnchorDigest::One(local), drift: Vec::new() }
    );
    assert_eq!(session.read_back(api, "1.0.0", None).expect("a read-back").expect("read"), ReadBack::Absent);
    assert_eq!(session.published_versions(api).expect("listed").expect("read"), vec!["1.0.0rc1".to_string()]);
    assert_eq!(seen.lock().expect("the log")[0], "/simple/acme-api/ application/vnd.pypi.simple.v1+json, text/html;q=0.1");
    let worker = reference(&ws, "apps/worker");
    assert_eq!(session.read_back(worker, "0.3.0", None).expect("a read-back").expect("read"), ReadBack::Absent);
}

/// Why a real build cannot run here, or `None` when a fresh venv can install
/// setuptools — Python 3 with venv, and an index or pip's cache.
fn cannot_build() -> Option<&'static str> {
    let quiet = |args: &[&str]| Command::new("python3").args(args).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
    if !quiet(&["-c", "import venv, ensurepip"]) {
        return Some("python3 with its venv and ensurepip modules is not installed");
    }
    let scratch = tempfile::tempdir().expect("a scratch directory");
    let target = scratch.path().to_string_lossy().into_owned();
    if !quiet(&["-I", "-m", "pip", "download", "--no-deps", "--quiet", "--disable-pip-version-check", "-d", &target, "setuptools>=61"]) {
        return Some("setuptools cannot be fetched from an index or pip's cache");
    }
    None
}

#[test]
fn builds_the_sdist_setuptools_makes_in_an_isolated_environment_and_leaves_the_project_as_it_was() {
    if let Some(reason) = cannot_build() {
        eprintln!("skipped: {reason}");
        return;
    }
    let dir = repo(&[
        ("telo-workspace.yaml", "release:\n  units:\n    - { path: apps/api, ecosystem: pypi }\n"),
        (
            "apps/api/pyproject.toml",
            "[project]\nname = \"acme-api\"\nversion = \"1.0.0\"\n\n[build-system]\nrequires = [\"setuptools>=61\"]\nbuild-backend = \"setuptools.build_meta\"\n",
        ),
        ("apps/api/src/acme_api/__init__.py", "x = 1\n"),
        ("apps/api/notes.txt", "not packaged\n"),
    ]);
    let root = dir.path();
    let ws = load(root);
    let session = open(&ws, Arc::new(isolated_sdist_builder));
    let api = reference(&ws, "apps/api");
    let listed = || list_files(root, &|name| name == ".git").expect("listed");
    let before = listed();
    let found = session.collect(api).expect("built");
    assert!(found.files.contains(&"apps/api/pyproject.toml".to_string()), "{:?}", found.files);
    assert!(found.files.contains(&"apps/api/src/acme_api/__init__.py".to_string()), "{:?}", found.files);
    assert!(!found.files.contains(&"apps/api/notes.txt".to_string()), "{:?}", found.files);
    assert_eq!(listed(), before);
    assert_eq!(session.collect(api).expect("built again").layer, found.layer);
}

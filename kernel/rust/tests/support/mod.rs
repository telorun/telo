//! Test support shared by the kernel's and the CLI's integration tests (the
//! CLI's include this file by path): an in-process loopback OCI registry,
//! publishing a module into it the way `telo publish` lays one out, and building
//! the in-repo console controller as a cdylib.
//!
//! The registry is a real HTTP/1.1 server on `127.0.0.1`, so the kernel's
//! client is exercised end to end with no network.

#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;

use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::{json, Value};
use telo_analyzer::artifact_selector::PlatformAxis;
use telo_analyzer::sources::integrity::sha256_base64url;
use telo_kernel::bundle::files_integrity::{compute_files_integrity, PayloadFile};
use telo_kernel::bundle::module_artifact::host_platform_target;
use telo_kernel::transports::oci::oci_client::blob_digest;
use telo_kernel::manifest_sources::local_manifest_cache_source::resolve_cache_root;

pub const MANIFEST_LAYER: &str = "application/vnd.telo.module.manifest.v1+tar";
pub const LEGACY_LAYER: &str = "application/vnd.telo.module.v1+tar";
pub const PAYLOAD_LAYER: &str = "application/vnd.telo.module.layer.v1+tar";
const TOKEN: &str = "test-token";

#[derive(Default)]
struct State {
    blobs: HashMap<String, Vec<u8>>,
    manifests: HashMap<String, String>,
    /// Request path → `Location` answered with a 307.
    redirects: HashMap<String, String>,
    requests: Vec<String>,
    /// Paths requested carrying an `authorization` header.
    authorized: Vec<String>,
    token_requests: usize,
}

pub struct TestRegistry {
    host: String,
    state: Arc<Mutex<State>>,
}

impl TestRegistry {
    /// `require_auth` gates every `/v2` route behind the bearer handshake.
    pub fn start(require_auth: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback registry");
        let host = listener.local_addr().unwrap().to_string();
        let state = Arc::new(Mutex::new(State::default()));
        let (served, served_host) = (Arc::clone(&state), host.clone());
        thread::spawn(move || {
            for stream in listener.incoming() {
                let (state, host) = (Arc::clone(&served), served_host.clone());
                thread::spawn(move || serve(stream.expect("accept"), &state, &host, require_auth));
            }
        });
        Self { host, state }
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    /// Every path requested, in order.
    pub fn requests(&self) -> Vec<String> {
        self.state.lock().unwrap().requests.clone()
    }

    pub fn token_requests(&self) -> usize {
        self.state.lock().unwrap().token_requests
    }

    /// Every path requested with an `authorization` header, in order.
    pub fn authorized_requests(&self) -> Vec<String> {
        self.state.lock().unwrap().authorized.clone()
    }

    /// Answer `path` with a 307 to `location`; `/storage/<digest>` serves a
    /// pushed blob with no authentication, as a registry's blob storage does.
    pub fn redirect(&self, path: &str, location: &str) {
        self.state
            .lock()
            .unwrap()
            .redirects
            .insert(path.to_string(), location.to_string());
    }

    pub fn push_blob(&self, bytes: Vec<u8>) -> String {
        let digest = blob_digest(&bytes);
        self.state.lock().unwrap().blobs.insert(digest.clone(), bytes);
        digest
    }

    /// Serve `bytes` for `digest` — a registry answering with other bytes.
    pub fn tamper_blob(&self, digest: &str, bytes: Vec<u8>) {
        self.state.lock().unwrap().blobs.insert(digest.to_string(), bytes);
    }

    pub fn push_manifest(&self, repo: &str, reference: &str, layers: &[(&str, &str)]) {
        let layers: Vec<Value> = layers
            .iter()
            .map(|(media_type, digest)| json!({ "mediaType": media_type, "digest": digest, "size": 0 }))
            .collect();
        let manifest = json!({
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": { "mediaType": "application/vnd.oci.empty.v1+json", "digest": blob_digest(b"{}"), "size": 2 },
            "layers": layers,
        });
        self.state
            .lock()
            .unwrap()
            .manifests
            .insert(format!("{repo}|{reference}"), manifest.to_string());
    }

    /// Publish a module as `telo publish` lays it out — each payload layer its
    /// own blob, the `layers:` index appended to the owner document, `telo.yaml`
    /// alone in the manifest layer.
    pub fn publish(&self, repo: &str, version: &str, owner_doc: &str, rest: &str, layers: &[Layer]) -> Published {
        let mut index = Vec::new();
        let mut descriptors = Vec::new();
        for layer in layers {
            let digest = self.push_blob(tar_gz(&layer.files));
            let mut entry = json!({
                "role": layer.role,
                "blob": digest,
                "integrity": compute_files_integrity(&layer.files),
            });
            if let Some(selector) = &layer.selector {
                entry["selector"] = selector.clone();
            }
            index.push(entry);
            descriptors.push(digest);
        }
        let layers_line = if index.is_empty() {
            String::new()
        } else {
            format!("layers: {}\n", Value::Array(index))
        };
        let manifest = format!("{owner_doc}{layers_line}{rest}");
        let manifest_blob = self.push_blob(tar_gz(&[regular("telo.yaml", manifest.as_bytes())]));
        let mut oci_layers = vec![(MANIFEST_LAYER, manifest_blob.as_str())];
        oci_layers.extend(descriptors.iter().map(|d| (PAYLOAD_LAYER, d.as_str())));
        self.push_manifest(repo, version, &oci_layers);
        Published {
            pinned: format!(
                "oci://{}/{repo}@{version}#sha256-{}",
                self.host,
                sha256_base64url(manifest.as_bytes())
            ),
            blobs: descriptors,
        }
    }
}

pub struct Published {
    /// The import ref with its `#sha256-…` pin.
    pub pinned: String,
    /// Each payload layer's blob digest, in the order the layers were given.
    pub blobs: Vec<String>,
}

pub struct Layer {
    pub role: &'static str,
    pub selector: Option<Value>,
    pub files: Vec<PayloadFile>,
}

pub fn regular(name: &str, content: &[u8]) -> PayloadFile {
    PayloadFile::Regular {
        name: name.to_string(),
        content: content.to_vec(),
        executable: false,
    }
}

pub fn tar_gz(files: &[PayloadFile]) -> Vec<u8> {
    let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
    for file in files {
        let mut header = tar::Header::new_gnu();
        match file {
            PayloadFile::Regular {
                name,
                content,
                executable,
            } => {
                header.set_entry_type(tar::EntryType::Regular);
                header.set_mode(if *executable { 0o755 } else { 0o644 });
                header.set_size(content.len() as u64);
                builder.append_data(&mut header, name, content.as_slice()).unwrap();
            }
            PayloadFile::Link { name, link } => {
                header.set_entry_type(tar::EntryType::Symlink);
                header.set_mode(0o644);
                header.set_size(0);
                builder.append_link(&mut header, name, link).unwrap();
            }
        }
    }
    builder.into_inner().unwrap().finish().unwrap()
}

fn serve(stream: TcpStream, state: &Mutex<State>, host: &str, require_auth: bool) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }
    let mut authorization = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("authorization") {
                authorization = Some(value.trim().to_string());
            }
        }
    }
    let target = request_line.split_whitespace().nth(1).unwrap_or("/").to_string();
    let path = target.split('?').next().unwrap_or("").to_string();

    let (status, headers, body): (&str, Vec<String>, Vec<u8>) = {
        let mut state = state.lock().unwrap();
        state.requests.push(path.clone());
        if authorization.is_some() {
            state.authorized.push(path.clone());
        }
        if let Some(location) = state.redirects.get(&path) {
            ("307 Temporary Redirect", vec![format!("location: {location}")], Vec::new())
        } else if let Some(digest) = path.strip_prefix("/storage/") {
            match state.blobs.get(digest) {
                Some(bytes) => ("200 OK", vec![], bytes.clone()),
                None => ("404 Not Found", vec![], Vec::new()),
            }
        } else if path == "/token" {
            state.token_requests += 1;
            ("200 OK", vec![], json!({ "token": TOKEN }).to_string().into_bytes())
        } else if require_auth
            && path.starts_with("/v2/")
            && authorization.as_deref() != Some(&format!("Bearer {TOKEN}"))
        {
            let challenge = format!(
                "www-authenticate: Bearer realm=\"http://{host}/token\",service=\"reg.test\",scope=\"repository:x:pull\""
            );
            ("401 Unauthorized", vec![challenge], Vec::new())
        } else if let Some((_, digest)) = path.strip_prefix("/v2/").and_then(|p| p.split_once("/blobs/")) {
            match state.blobs.get(digest) {
                Some(bytes) => ("200 OK", vec![], bytes.clone()),
                None => ("404 Not Found", vec![], Vec::new()),
            }
        } else if let Some((repo, reference)) =
            path.strip_prefix("/v2/").and_then(|p| p.split_once("/manifests/"))
        {
            match state.manifests.get(&format!("{repo}|{reference}")) {
                Some(manifest) => (
                    "200 OK",
                    vec!["content-type: application/vnd.oci.image.manifest.v1+json".to_string()],
                    manifest.clone().into_bytes(),
                ),
                None => ("404 Not Found", vec![], Vec::new()),
            }
        } else {
            ("404 Not Found", vec![], Vec::new())
        }
    };

    let mut response = format!(
        "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n",
        body.len()
    );
    for header in headers {
        response.push_str(&header);
        response.push_str("\r\n");
    }
    response.push_str("\r\n");
    let mut stream = stream;
    stream.write_all(response.as_bytes()).unwrap();
    stream.write_all(&body).unwrap();
}

/// The repository root, from this crate's manifest directory.
pub fn repo_root() -> PathBuf {
    let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    while !dir.join("telo-workspace.yaml").is_file() {
        assert!(dir.pop(), "no telo-workspace.yaml above {}", env!("CARGO_MANIFEST_DIR"));
    }
    dir
}

/// Build `modules/console/rust` with the SDK's native backend — the build
/// `pkg:cargo` resolution runs, into the same target directory — and return
/// the cdylib it produced.
pub fn build_console_cdylib() -> PathBuf {
    let crate_dir = repo_root().join("modules/console/rust");
    let target_dir = resolve_cache_root(&crate_dir).unwrap().join("cargo/native/target");
    let output = Command::new(env!("CARGO"))
        .current_dir(&crate_dir)
        .env("CARGO_TARGET_DIR", &target_dir)
        .args([
            "build",
            "--release",
            "--features",
            "telorun-sdk/native",
            "--message-format",
            "json-render-diagnostics",
        ])
        .output()
        .expect("cargo runs");
    assert!(
        output.status.success(),
        "building the console cdylib failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|message| message["reason"] == "compiler-artifact")
        .filter(|message| message["target"]["name"] == "telorun_console")
        .flat_map(|message| message["filenames"].as_array().cloned().unwrap_or_default())
        .filter_map(|file| file.as_str().map(PathBuf::from))
        .find(|file| matches!(file.extension().and_then(|e| e.to_str()), Some("so" | "dylib" | "dll")))
        .expect("cargo reported the console cdylib")
}

/// This host's layer-index selector for a `dylib` controller.
pub fn host_dylib_selector() -> Value {
    let host = host_platform_target();
    let mut selector = json!({ "format": "dylib" });
    for axis in PlatformAxis::ALL {
        if let Some(value) = host.axes.get(axis) {
            selector[axis.name()] = json!(value);
        }
    }
    selector
}

/// A `dylib` candidate for `selector`, naming `path` inside its layer.
pub fn dylib_candidate(path: &str, selector: &Value, entry: &str) -> String {
    let qualifiers: String = PlatformAxis::ALL
        .into_iter()
        .filter_map(|axis| selector[axis.name()].as_str().map(|v| format!("&{}={v}", axis.name())))
        .collect();
    format!("pkg:telo/local/dylib?path={path}{qualifiers}#{entry}")
}

/// The console library as published, with `controllers` as WriteLine's
/// candidate list: its owner document and the documents after it.
pub fn console_library(controllers: &[String]) -> (String, String) {
    let owner = "kind: Telo.Library\nmetadata:\n  name: Console\n  version: 1.0.0\n\
                 exports:\n  kinds: [WriteLine]\n  resources: [writeLine]\n"
        .to_string();
    let candidates: String = controllers.iter().map(|c| format!("  - {c}\n")).collect();
    let rest = format!(
        "---\nkind: Telo.Definition\nmetadata:\n  name: WriteLine\ncapability: Telo.Invocable\n\
         controllers:\n{candidates}\
         inputType:\n  kind: Telo.JsonSchema\n  schema:\n    type: object\n    properties:\n      output: {{ type: string }}\n    required: [output]\n\
         schema:\n  type: object\n  additionalProperties: false\n\
         ---\nkind: Self.WriteLine\nmetadata:\n  name: writeLine\n"
    );
    (owner, rest)
}

/// An application importing `Console` from `source` and printing one line.
pub fn write_app(dir: &Path, source: &str) -> PathBuf {
    let app = dir.join("telo.yaml");
    std::fs::write(
        &app,
        format!(
            "kind: Telo.Application\nmetadata:\n  name: App\nimports:\n  Console: {source}\n\
             targets:\n  - invoke: !ref Console.writeLine\n    inputs:\n      output: \"Hello from Telo!\"\n"
        ),
    )
    .unwrap();
    app
}

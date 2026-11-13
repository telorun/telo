//! The command tree over a git repository on disk, needing git alone: the
//! docker evidence's rows and refusals, a declared `{ command }` payload's
//! refusals, and one write lifecycle — the Rust half of the Node package's
//! `tests/node/commands.test.ts` and `tests/node/evidence.test.ts`.

use std::cell::RefCell;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::rc::Rc;

use serde_json::{json, Map, Value};

use telorun_release::node::commands::release_commands;
use telorun_release::node::host::{ReleaseHost, ReleaseOutput, Style};
use telorun_release::node::shipped_evidence;
use telorun_release::release_settings::ReadReleaseOptions;
use telorun_release::shipped_adapters;

#[derive(Default)]
struct Recorded {
    stderr: RefCell<Vec<String>>,
    payloads: RefCell<Vec<Map<String, Value>>>,
}

impl ReleaseOutput for Recorded {
    fn line(&self, _text: &str) {}
    fn err_line(&self, text: &str) {
        self.stderr.borrow_mut().push(text.to_string());
    }
    fn emit(&self, payload: Map<String, Value>) {
        self.payloads.borrow_mut().push(payload);
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
    let status = Command::new("git")
        .args(["-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(root)
        .output()
        .expect("git runs");
    assert!(status.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&status.stderr));
}

fn write(root: &Path, files: &[(&str, &str)]) {
    for (file, text) in files {
        let path = root.join(file);
        fs::create_dir_all(path.parent().expect("a parent")).expect("a directory");
        fs::write(path, text).expect("a file");
    }
}

fn repo(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("a scratch directory");
    write(dir.path(), files);
    git(dir.path(), &["init", "-q", "-b", "main"]);
    commit(dir.path(), "init");
    dir
}

fn commit(root: &Path, message: &str) {
    git(root, &["add", "-A"]);
    git(root, &["commit", "-q", "--allow-empty", "-m", message]);
}

/// Run one command line in `root`: the last envelope and the exit status.
fn run(root: &Path, args: &[&str]) -> (Value, i32, Rc<Recorded>) {
    let recorded = Rc::new(Recorded::default());
    let host = ReleaseHost {
        command: "telo-release".into(),
        adapters: shipped_adapters(),
        evidence: shipped_evidence(),
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

fn codes(payload: &Value) -> Vec<String> {
    let mut codes: Vec<String> = payload["diagnostics"].as_array().into_iter().flatten().map(|d| d["code"].as_str().unwrap_or("").to_string()).collect();
    codes.sort();
    codes
}

const DOCKER_MARKER: &str = "release:\n  ecosystems: { docker: { registry: ghcr.io/acme } }\n  units:\n    - path: app\n      version: VERSION\n      ecosystem: { docker: { '.': {}, worker: { context: ., name: app-worker } } }\n";

#[test]
fn docker_anchors_publish_from_their_own_rows() {
    let dir = repo(&[
        ("telo-workspace.yaml", DOCKER_MARKER),
        ("app/VERSION", "1.0.0\n"),
        ("app/Dockerfile", "FROM scratch\n"),
        ("app/Dockerfile.dockerignore", "Dockerfile*\nsecret.txt\n"),
        ("app/secret.txt", "s\n"),
        ("app/worker/Dockerfile", "FROM scratch\n"),
    ]);
    let (order, code, _) = run(dir.path(), &["order"]);
    assert_eq!(code, 0);
    assert_eq!(
        order["order"],
        json!([
            { "key": "app", "version": "1.0.0", "imports": [], "ecosystem": "docker", "path": "app", "destination": "ghcr.io/acme/app" },
            { "key": "app", "version": "1.0.0", "imports": [], "ecosystem": "docker", "path": "app/worker", "destination": "ghcr.io/acme/app-worker" },
        ])
    );
}

#[test]
fn an_anchor_with_no_registry_and_a_context_that_is_no_directory_are_refused() {
    let dir = repo(&[
        (
            "telo-workspace.yaml",
            "release:\n  units:\n    - { path: a, version: V, ecosystem: docker }\n    - path: b\n      version: V\n      ecosystem: { docker: { '.': { context: nowhere, registry: r } } }\n",
        ),
        ("a/V", "1.0.0\n"),
        ("a/Dockerfile", "FROM scratch\n"),
        ("b/V", "1.0.0\n"),
        ("b/Dockerfile", "FROM scratch\n"),
    ]);
    let (check, code, _) = run(dir.path(), &["check", "--base", "HEAD"]);
    assert_eq!(code, 1);
    assert_eq!(codes(&check), ["NO_DESTINATION_KNOWN", "WORKSPACE_ANCHOR_INVALID"]);
}

#[test]
fn a_declared_command_payload_is_read_exactly() {
    for (command, refusal) in [
        ("exit 3", "exited 3"),
        ("echo b.txt", "names no file"),
        ("echo a.txt; echo a.txt", "twice"),
        ("echo ../../etc/passwd", "outside the workspace"),
    ] {
        let marker = format!("release:\n  units:\n    - path: ext\n      version: VERSION\n      payload: {{ command: \"{command}\" }}\n");
        let dir = repo(&[("telo-workspace.yaml", &marker), ("ext/VERSION", "1.0.0\n"), ("ext/a.txt", "a\n")]);
        let (_, code, recorded) = run(dir.path(), &["status", "--base", "HEAD"]);
        assert_eq!(code, 1, "{command}");
        let stderr = recorded.stderr.borrow().join("\n");
        assert!(stderr.contains(refusal), "{command}: {stderr}");
    }
}

#[test]
fn adds_applies_a_candidate_and_a_final_and_tags() {
    let dir = repo(&[
        ("telo-workspace.yaml", "release:\n  ecosystems: { docker: { registry: ghcr.io/acme } }\n  units:\n    - { path: app, version: VERSION, ecosystem: docker }\n"),
        ("app/VERSION", "1.0.0\n"),
        ("app/Dockerfile", "FROM scratch\n"),
        ("app/worker/Dockerfile", "FROM scratch\n"),
    ]);
    let root = dir.path();
    let read = |file: &str| fs::read_to_string(root.join(file)).unwrap_or_default();

    let (added, code, _) = run(root, &["add", "--unit", "app", "--kind", "Added", "--body", "A new image."]);
    assert_eq!(code, 0);
    assert_eq!(added["units"], json!(["app"]));
    assert_eq!(run(root, &["add", "--unit", "app/worker", "--body", "x"]).1, 1);

    let (candidate, code, _) = run(root, &["apply", "--candidate", "--base", "HEAD", "--date", "2026-01-02"]);
    assert_eq!(code, 0, "{candidate}");
    assert_eq!(read("app/VERSION"), "1.1.0-rc.1\n");
    assert!(!root.join("app/CHANGELOG.md").exists());
    commit(root, "candidate");
    assert_eq!(run(root, &["tag", "--dry-run"]).0["tags"], json!(["app@1.1.0-rc.1"]));

    let (final_apply, code, _) = run(root, &["apply", "--base", "HEAD", "--date", "2026-01-03"]);
    assert_eq!(code, 0, "{final_apply}");
    assert_eq!(read("app/VERSION"), "1.1.0\n");
    assert_eq!(read("app/CHANGELOG.md"), "# Changelog\n\n## 1.1.0 - 2026-01-03\n### Added\n* A new image.\n");
    assert!(!read(".changes/ledger.yaml").contains("candidate:"));
    assert_eq!(run(root, &["tag"]).1, 1, "an apply that is not committed is not tagged");
    commit(root, "final");
    assert_eq!(run(root, &["tag"]).0["tags"], json!(["app@1.1.0"]));
    assert_eq!(run(root, &["status", "--base", "HEAD"]).0["units"], json!([]));
}

#[test]
fn an_apply_whose_reading_after_the_stamp_fails_is_undone() {
    // The payload command fails once the unit carries its planned version.
    let dir = repo(&[
        (
            "telo-workspace.yaml",
            "release:\n  units:\n    - path: tool\n      version: VERSION\n      payload: { command: \"test \\\"$(cat VERSION)\\\" = 1.0.0 && printf 'VERSION\\\\n'\" }\n",
        ),
        ("tool/VERSION", "1.0.0\n"),
    ]);
    let (_, added, _) = run(dir.path(), &["add", "--unit", "tool", "--body", "Fix."]);
    assert_eq!(added, 0);
    commit(dir.path(), "fragment");
    let (_, code, recorded) = run(dir.path(), &["apply", "--base", "HEAD", "--date", "2026-01-02"]);
    assert_eq!(code, 1);
    assert!(recorded.stderr.borrow().join("\n").contains("The apply was undone"), "{:?}", recorded.stderr.borrow());
    let status = Command::new("git").args(["status", "--porcelain"]).current_dir(dir.path()).output().expect("git runs");
    assert_eq!(String::from_utf8_lossy(&status.stdout), "");
}

#[test]
fn a_crate_layer_reads_a_license_file_outside_the_crate() {
    let dir = repo(&[
        ("telo-workspace.yaml", "release:\n  units:\n    - { path: c, ecosystem: cargo }\n"),
        ("LICENSE", "MIT\n"),
        ("c/Cargo.toml", "[package]\nname = \"outside-license\"\nversion = \"1.0.0\"\nedition = \"2021\"\nlicense-file = \"../LICENSE\"\n\n[workspace]\n"),
        ("c/src/lib.rs", "\n"),
    ]);
    // Reading the layer is what fails when the license is looked for inside the crate.
    let (status, code, recorded) = run(dir.path(), &["status", "--base", "HEAD"]);
    assert_eq!(code, 0, "{:?}", recorded.stderr.borrow());
    assert_eq!(status["diagnostics"], json!([]));
}

#[test]
fn a_packed_manifest_digests_its_dependency_maps_in_name_order() {
    use telorun_release::node::adapters::npm_evidence::canonical_manifest;
    use telorun_release::node::files_digest::FileSetEntry;
    let manifest = |text: &str| vec![FileSetEntry::File { path: "package.json".into(), content: text.as_bytes().to_vec(), executable: false }];
    let one = canonical_manifest(manifest("{\n  \"name\": \"a\",\n  \"dependencies\": { \"b\": \"1.0.0\", \"a\": \"2.0.0\" }\n}\n")).expect("canonical");
    let two = canonical_manifest(manifest("{\"name\":\"a\",\"dependencies\":{\"a\":\"2.0.0\",\"b\":\"1.0.0\"}}")).expect("canonical");
    assert_eq!(one, two);
    // The same bytes the Node half writes (`tests/node/evidence.test.ts`).
    let FileSetEntry::File { content, .. } = &one[0] else { panic!("a file") };
    assert_eq!(String::from_utf8_lossy(content), r#"{"name":"a","dependencies":{"a":"2.0.0","b":"1.0.0"}}"#);
}

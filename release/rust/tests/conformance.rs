//! Runs the twin-conformance vectors (`release/conformance/`) — the rows
//! `release/nodejs/tests/conformance.test.ts` answers — each row answered here
//! and compared whole with what it records.

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;

use base64::Engine;
use indexmap::IndexMap;
use serde_json::{json, Map, Value};

use telorun_release::adapter::AdapterRegistry;
use telorun_release::bump_level::{BumpLevel, FragmentKind};
use telorun_release::changelog::{prepend_changelog_release, render_changelog_release, ChangelogRelease};
use telorun_release::fragment::{parse_fragment, serialize_fragment};
use telorun_release::ledger::{parse_ledger, serialize_ledger, AnchorDigest, LayerChange, Ledger, ParseLedgerOptions, UnitLayers};
use telorun_release::marker_reader::{PathSeg, WORKSPACE_FILENAME};
use telorun_release::node::files_digest::{digest_file_set, FileSetEntry};
use telorun_release::release_plan::{plan_release, record_release, BumpReason, PlanOptions, RecordedReading, ReleaseEvidence, UnitEvidence};
use telorun_release::release_settings::{read_release_marker, PayloadSpec, ReadReleaseOptions};
use telorun_release::units::{resolve_units, VersionReading, WorkspaceTree};
use telorun_release::version_files::{read_version_at, write_version_at};
use telorun_release::adapter::VersionLocationSpec;
use telorun_release::adapters::cargo::stamp_locked_crate_version;
use telorun_release::adapters::cargo_closure::{closure_from_lock, closure_from_metadata, links_artifact};
use telorun_release::node::commands::release_commands;
use telorun_release::node::host::{ReleaseHost, ReleaseOutput, Style};
use telorun_release::node::shipped_evidence;
use telorun_release::{shipped_adapters, ReleaseError};

fn read(relative: &str) -> Value {
    let file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join(relative);
    serde_json::from_str(&fs::read_to_string(&file).unwrap_or_else(|err| panic!("{}: {err}", file.display())))
        .unwrap_or_else(|err| panic!("{}: {err}", file.display()))
}

fn rows<'a>(value: &'a Value, key: Option<&str>) -> &'a Vec<Value> {
    let value = match key {
        Some(key) => &value[key],
        None => value,
    };
    value.as_array().expect("a list of rows")
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_else(|| panic!("a string, not {value}"))
}

fn error(err: ReleaseError) -> Value {
    json!({ "error": err.message })
}

/// Checks one answer against the row, collecting every miss.
struct Misses(Vec<String>);

impl Misses {
    fn check(&mut self, family: &str, row: &Value, answer: Value) {
        if answer != row["expected"] {
            self.0.push(format!(
                "{family} {}:\n  expected {}\n  answered {}",
                row["name"],
                serde_json::to_string_pretty(&row["expected"]).unwrap_or_default(),
                serde_json::to_string_pretty(&answer).unwrap_or_default()
            ));
        }
    }
}

struct MemoryTree {
    files: IndexMap<String, String>,
    directories: Vec<String>,
}

impl MemoryTree {
    fn new(files: &Map<String, Value>) -> MemoryTree {
        let files: IndexMap<String, String> = files.iter().map(|(k, v)| (k.clone(), text(v).to_string())).collect();
        let mut dirs = std::collections::BTreeSet::new();
        for file in files.keys() {
            let parts: Vec<&str> = file.split('/').collect();
            for i in 1..parts.len() {
                dirs.insert(parts[..i].join("/"));
            }
        }
        MemoryTree { files, directories: dirs.into_iter().collect() }
    }
}

impl WorkspaceTree for MemoryTree {
    fn directories(&self) -> &[String] {
        &self.directories
    }

    fn files_under(&self, dir: &str) -> Vec<String> {
        let mut out: Vec<String> = self
            .files
            .keys()
            .filter(|f| dir.is_empty() || f.starts_with(&format!("{dir}/")))
            .map(|f| if dir.is_empty() { f.clone() } else { f[dir.len() + 1..].to_string() })
            .collect();
        out.sort();
        out
    }

    fn read_file(&self, path: &str) -> Option<String> {
        self.files.get(path).cloned()
    }
}

fn path_json(path: &[PathSeg]) -> Value {
    Value::Array(
        path.iter()
            .map(|seg| match seg {
                PathSeg::Key(key) => Value::String(key.clone()),
                PathSeg::Index(index) => json!(index),
            })
            .collect(),
    )
}

fn located(file: &str, pointer: Option<&str>) -> String {
    match pointer.filter(|p| !p.is_empty()) {
        Some(pointer) => format!("{file}#{pointer}"),
        None => file.to_string(),
    }
}

fn marker_answer(row: &Value) -> Value {
    let adapters = shipped_adapters();
    let registry = AdapterRegistry::new(&adapters).expect("the shipped adapters register");
    let files = row["files"].as_object().expect("files");
    let mut hosts = IndexMap::new();
    if let Some(Value::Object(map)) = row.get("ecosystemHosts") {
        for (k, v) in map {
            hosts.insert(k.clone(), text(v).to_string());
        }
    }
    let read = read_release_marker(text(&files[WORKSPACE_FILENAME]), WORKSPACE_FILENAME, &adapters, &ReadReleaseOptions { ecosystem_hosts: hosts })
        .expect("the marker reads");
    let diagnostic = |code: &str, severity: &str, message: &str, path: &[PathSeg]| {
        json!({ "code": code, "severity": severity, "message": message, "path": path_json(path) })
    };
    let mut diagnostics: Vec<Value> =
        read.diagnostics.iter().map(|d| diagnostic(d.code, d.severity.as_str(), &d.message, &d.path)).collect();
    let mut units = Value::Null;
    if let Some(release) = &read.release {
        let tree = MemoryTree::new(files);
        let resolution = resolve_units(release, &tree, &registry);
        diagnostics.extend(resolution.diagnostics.iter().map(|d| diagnostic(d.code, d.severity.as_str(), &d.message, &d.path)));
        units = Value::Array(
            resolution
                .units
                .iter()
                .map(|u| {
                    json!({
                        "key": u.key,
                        "dir": u.dir,
                        "anchors": u.anchors.iter().map(|a| json!({
                            "ecosystem": a.ecosystem,
                            "anchor": a.anchor,
                            "dir": a.dir,
                            "name": a.package.name,
                            "contributesLayer": a.package.contributes_layer,
                            "versionFiles": a.package.version_files,
                            "settings": Value::Object(a.settings.clone()),
                        })).collect::<Vec<_>>(),
                        "version": located(&u.version.file, u.version.pointer.as_deref()),
                        "versionLocations": u.version_locations.iter().map(|l| located(&l.file, l.pointer.as_deref())).collect::<Vec<_>>(),
                        "payload": match &u.payload {
                            Some(PayloadSpec::Patterns(patterns)) => json!({ "patterns": patterns }),
                            Some(PayloadSpec::Command(command)) => json!({ "command": command }),
                            None => Value::Null,
                        },
                        "metafile": u.metafile,
                        "ignore": u.ignore,
                        "maxBump": u.max_bump.as_str(),
                        "group": u.group,
                    })
                })
                .collect(),
        );
    }
    json!({ "diagnostics": diagnostics, "units": units })
}

fn layers_of(raw: &Value) -> UnitLayers {
    let mut layers = UnitLayers::default();
    for (key, value) in raw.as_object().into_iter().flatten() {
        if key == "payload" {
            layers.payload = Some(text(value).to_string());
            continue;
        }
        let mut anchors = IndexMap::new();
        for (anchor, digest) in value.as_object().expect("anchors") {
            let digest = match digest {
                Value::String(one) => AnchorDigest::One(one.clone()),
                Value::Object(map) => AnchorDigest::Keyed(map.iter().map(|(k, v)| (k.clone(), text(v).to_string())).collect()),
                other => panic!("a digest, not {other}"),
            };
            anchors.insert(anchor.clone(), digest);
        }
        layers.ecosystems.insert(key.clone(), anchors);
    }
    layers
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().into_iter().flatten().map(|v| text(v).to_string()).collect()
}

fn evidence_of(raw: &Value) -> UnitEvidence {
    let optional = |key: &str| raw.get(key).and_then(Value::as_str).map(str::to_string);
    UnitEvidence {
        key: text(&raw["key"]).to_string(),
        name: optional("name"),
        version: text(&raw["version"]).to_string(),
        layers: layers_of(&raw["layers"]),
        registry: optional("registry"),
        imports: strings(&raw["imports"]),
        inlines: raw["inlines"].as_object().into_iter().flatten().map(|(k, v)| (k.clone(), strings(v))).collect(),
        payload_files: raw.get("payloadFiles").map(strings).unwrap_or_default(),
        version_files: raw.get("versionFiles").map(strings).unwrap_or_default(),
        version_readings: raw
            .get("versionReadings")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|r| VersionReading {
                file: text(&r["file"]).to_string(),
                pointer: r.get("pointer").and_then(Value::as_str).map(str::to_string),
                value: r.get("value").and_then(Value::as_str).map(str::to_string),
                error: r.get("error").and_then(Value::as_str).map(str::to_string),
            })
            .collect(),
        own_files_changed: raw["ownFilesChanged"].as_bool().unwrap_or(false),
        max_bump: raw.get("maxBump").and_then(Value::as_str).and_then(BumpLevel::parse),
    }
}

fn reason_json(reason: &BumpReason) -> Value {
    match reason {
        BumpReason::Declared { fragment, kind } => json!({ "kind": "declared", "fragment": fragment, "as": kind.as_str() }),
        BumpReason::Inlines { unit, files } => json!({ "kind": "inlines", "unit": unit, "files": files }),
        BumpReason::Imports { unit } => json!({ "kind": "imports", "unit": unit }),
        BumpReason::VersionLocation { unit, files } => json!({ "kind": "version-location", "unit": unit, "files": files }),
        BumpReason::Group { group } => json!({ "kind": "group", "group": group }),
        BumpReason::Unattributed => json!({ "kind": "unattributed" }),
    }
}

fn change_json(change: &LayerChange) -> Value {
    let mut out = Map::new();
    out.insert("path".into(), json!(change.path));
    if let Some(before) = &change.before {
        out.insert("before".into(), json!(before));
    }
    if let Some(after) = &change.after {
        out.insert("after".into(), json!(after));
    }
    Value::Object(out)
}

fn plan_answer(row: &Value) -> Value {
    let evidence: Vec<UnitEvidence> = rows(&row["units"], None).iter().map(evidence_of).collect();
    let ledger = match &row["ledger"] {
        Value::Null => Ledger::default(),
        text_value => parse_ledger(text(text_value), "ledger.yaml", &ParseLedgerOptions::default()).expect("the row's ledger reads"),
    };
    let fragments: Vec<_> = rows(&row["fragments"], None)
        .iter()
        .map(|f| parse_fragment(text(&f["text"]), text(&f["source"])).expect("the row's fragment reads"))
        .collect();
    let groups: IndexMap<String, Vec<String>> = row
        .get("groups")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(k, v)| (k.clone(), strings(v)))
        .collect();
    let candidate = row.get("candidate").and_then(Value::as_str).map(str::to_string);
    let plan = match plan_release(
        &ReleaseEvidence { units: &evidence, ledger: &ledger, fragments: &fragments, groups: &groups },
        &PlanOptions { candidate },
    ) {
        Ok(plan) => plan,
        Err(err) => return error(err),
    };
    let readings: IndexMap<String, RecordedReading> =
        evidence.iter().map(|u| (u.key.clone(), RecordedReading { layers: u.layers.clone(), registry: u.registry.clone() })).collect();
    json!({
        "plan": {
            "units": plan.units.iter().map(|p| json!({
                "key": p.key,
                "name": p.name,
                "from": p.from,
                "to": p.to,
                "level": p.level.as_str(),
                "reasons": p.reasons.iter().map(reason_json).collect::<Vec<_>>(),
                "changed": p.changed.iter().map(change_json).collect::<Vec<_>>(),
                "entries": p.entries.iter().map(|e| json!({ "kind": e.kind.as_str(), "body": e.body, "fragment": e.fragment })).collect::<Vec<_>>(),
                "group": p.group,
            })).collect::<Vec<_>>(),
            "fragments": plan.fragments,
            "candidate": plan.candidate,
            "diagnostics": plan.diagnostics.iter().map(|d| json!({ "severity": d.severity.as_str(), "code": d.code, "message": d.message })).collect::<Vec<_>>(),
        },
        "recorded": serialize_ledger(&record_release(&ledger, &plan, &readings)),
    })
}

fn digest_answer(row: &Value) -> Value {
    let entries: Vec<FileSetEntry> = rows(&row["entries"], None)
        .iter()
        .map(|e| {
            let path = text(&e["path"]).to_string();
            if let Some(link) = e.get("link") {
                return FileSetEntry::Link { path, link: text(link).to_string() };
            }
            let content = match e.get("base64") {
                Some(b64) => base64::engine::general_purpose::STANDARD.decode(text(b64)).expect("base64"),
                None => text(&e["text"]).as_bytes().to_vec(),
            };
            FileSetEntry::File { path, content, executable: e.get("executable").and_then(Value::as_bool).unwrap_or(false) }
        })
        .collect();
    match digest_file_set(&entries) {
        Ok(digest) => json!({ "digest": digest }),
        Err(err) => error(err),
    }
}

#[test]
fn the_release_vectors_answer_as_recorded() {
    let mut misses = Misses(Vec::new());
    let mut counts = IndexMap::new();
    let mut count = |family: &str, n: usize| *counts.entry(family.to_string()).or_insert(0) += n;

    let markers = read("conformance/markers.json");
    for row in rows(&markers, None) {
        misses.check("marker", row, marker_answer(row));
    }
    count("markers", rows(&markers, None).len());

    let plans = read("conformance/plans.json");
    for row in rows(&plans, None) {
        misses.check("plan", row, plan_answer(row));
    }
    count("plans", rows(&plans, None).len());

    let digests = read("conformance/digests.json");
    for row in rows(&digests, None) {
        misses.check("digest", row, digest_answer(row));
    }
    count("digests", rows(&digests, None).len());

    let yaml = read("conformance/yaml.json");
    for row in rows(&yaml, Some("fragments")) {
        let units: IndexMap<String, FragmentKind> = row["units"]
            .as_object()
            .expect("units")
            .iter()
            .map(|(k, v)| (k.clone(), FragmentKind::parse(text(v)).expect("a kind")))
            .collect();
        misses.check("fragment written", row, json!({ "text": serialize_fragment(&units, text(&row["body"])) }));
    }
    for row in rows(&yaml, Some("ledgers")) {
        let answer = match parse_ledger(text(&row["text"]), "ledger.yaml", &ParseLedgerOptions::default()) {
            Ok(ledger) => json!({ "serialized": serialize_ledger(&ledger) }),
            Err(err) => error(err),
        };
        misses.check("ledger", row, answer);
    }
    for row in rows(&yaml, Some("fragmentTexts")) {
        let answer = match parse_fragment(text(&row["text"]), text(&row["source"])) {
            Ok(fragment) => json!({
                "units": fragment.units.iter().map(|(k, v)| (k.clone(), json!(v.as_str()))).collect::<Map<_, _>>(),
                "body": fragment.body,
            }),
            Err(err) => error(err),
        };
        misses.check("fragment read", row, answer);
    }
    count("yaml", rows(&yaml, Some("fragments")).len() + rows(&yaml, Some("ledgers")).len() + rows(&yaml, Some("fragmentTexts")).len());

    let adapters = shipped_adapters();
    let registry = AdapterRegistry::new(&adapters).expect("the shipped adapters register");
    let files = read("conformance/version-files.json");
    for row in rows(&files, Some("versionFiles")) {
        let pointer = row.get("pointer").and_then(Value::as_str).map(str::to_string);
        let location = VersionLocationSpec { file: text(&row["file"]).to_string(), pointer: pointer.clone() };
        let at = located(&location.file, pointer.as_deref());
        let source = text(&row["text"]);
        let read_answer = match read_version_at(&location, source, &at, &registry) {
            Ok(value) => json!({ "value": value }),
            Err(err) => error(err),
        };
        let write_answer = match write_version_at(&location, source, text(&row["version"]), &at, &registry) {
            Ok(written) => json!({ "text": written }),
            Err(err) => error(err),
        };
        misses.check("version file", row, json!({ "read": read_answer, "write": write_answer }));
    }
    for row in rows(&files, Some("lockfiles")) {
        let answer = match stamp_locked_crate_version(text(&row["text"]), text(&row["crate"]), text(&row["version"]), "Cargo.lock") {
            Ok(written) => json!({ "text": written }),
            Err(err) => error(err),
        };
        misses.check("lockfile", row, answer);
    }
    count("version files", rows(&files, Some("versionFiles")).len() + rows(&files, Some("lockfiles")).len());

    let closures = read("conformance/cargo-closures.json");
    for row in rows(&closures, Some("metadata")) {
        let root = text(&row["root"]);
        let package = rows(&row["metadata"], Some("packages")).iter().find(|pkg| pkg["id"].as_str() == Some(root));
        let answer = match package {
            None => error(ReleaseError::new(format!("cargo metadata lists no package '{root}'."))),
            Some(package) if !links_artifact(&package["targets"]) => json!({ "entry": null }),
            Some(_) => match closure_from_metadata(&row["metadata"], root) {
                Ok(entry) => json!({ "entry": entry }),
                Err(err) => error(err),
            },
        };
        misses.check("cargo closure from metadata", row, answer);
    }
    for row in rows(&closures, Some("locks")) {
        let members = strings(&row["members"]);
        let root = (text(&row["root"]["name"]), text(&row["root"]["version"]));
        let answer = match closure_from_lock(text(&row["lock"]), text(&row["manifest"]), root, &members, "fx-app-2.0.0.crate/Cargo.lock") {
            Ok(entry) => json!({ "entry": entry }),
            Err(err) => error(err),
        };
        misses.check("cargo closure from a lockfile", row, answer);
    }
    count("cargo closures", rows(&closures, Some("metadata")).len() + rows(&closures, Some("locks")).len());

    let changelogs = read("conformance/changelogs.json");
    for row in rows(&changelogs, None) {
        let entries: Vec<(FragmentKind, &str)> = rows(&row["entries"], None)
            .iter()
            .map(|e| (FragmentKind::parse(text(&e["kind"])).expect("a kind"), text(&e["body"])))
            .collect();
        let release = ChangelogRelease { version: text(&row["version"]), date: text(&row["date"]), entries };
        let existing = row["existing"].as_str();
        misses.check("changelog", row, json!({ "text": prepend_changelog_release(existing, &render_changelog_release(&release)) }));
    }
    count("changelogs", rows(&changelogs, None).len());

    let commands = read("conformance/commands.json");
    for row in rows(&commands, None) {
        let answer = commands_answer(row);
        if answer != json!(rows(&row["steps"], None).iter().map(|step| step["expected"].clone()).collect::<Vec<_>>()) {
            misses.0.push(format!("commands {}:\n  answered {}", row["name"], serde_json::to_string_pretty(&answer).unwrap_or_default()));
        }
    }
    count("commands", rows(&commands, None).len());

    assert!(misses.0.is_empty(), "{} of the vectors answered otherwise:\n{}", misses.0.len(), misses.0.join("\n"));
    let expected: IndexMap<String, usize> = [("markers", 15), ("plans", 17), ("digests", 7), ("yaml", 38), ("version files", 24), ("cargo closures", 8), ("changelogs", 5), ("commands", 1)]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
    assert_eq!(counts, expected, "the vector counts moved; a row was dropped or added unseen");
}

#[derive(Default)]
struct Envelopes(RefCell<Vec<Map<String, Value>>>);

impl ReleaseOutput for Envelopes {
    fn line(&self, _text: &str) {}
    fn err_line(&self, _text: &str) {}
    fn emit(&self, payload: Map<String, Value>) {
        self.0.borrow_mut().push(payload);
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

fn commit(root: &Path, message: &str) {
    git(root, &["add", "-A"]);
    git(root, &["commit", "-q", "--allow-empty", "-m", message]);
}

/// A row's files committed to a scratch repository, each step run there and
/// committed: per step, the exit status and the last envelope it emitted.
fn commands_answer(row: &Value) -> Value {
    let dir = tempfile::tempdir().expect("a scratch directory");
    let root = dir.path();
    for (file, text) in row["files"].as_object().expect("files") {
        let path = root.join(file);
        fs::create_dir_all(path.parent().expect("a parent")).expect("a directory");
        fs::write(path, self::text(text)).expect("a file");
    }
    git(root, &["init", "-q", "-b", "main"]);
    commit(root, "init");
    let envelopes = Rc::new(Envelopes::default());
    let host = ReleaseHost {
        command: "telo-release".into(),
        adapters: shipped_adapters(),
        evidence: shipped_evidence(),
        ecosystem_hosts: ReadReleaseOptions::default(),
        ledger: None,
        read_marker: None,
        output: envelopes.clone(),
        global_options: Vec::new(),
        subcommands: Vec::new(),
        check: None,
        after_apply: None,
    };
    let mut answers = Vec::new();
    for step in rows(&row["steps"], None) {
        let args = strings(&step["args"]);
        let before = envelopes.0.borrow().len();
        let code = release_commands(&host, &args, root);
        let emitted = envelopes.0.borrow();
        let payload = if emitted.len() > before { emitted.last().cloned().map(Value::Object).unwrap_or(Value::Null) } else { Value::Null };
        answers.push(json!({ "exitCode": code, "payload": payload }));
        drop(emitted);
        commit(root, &args.join(" "));
    }
    Value::Array(answers)
}

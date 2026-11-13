//! `telo check` end to end: the binary, real manifests, the envelope and text Node's
//! `telo check` writes, its exit status, and the inputs this build holds back.

#[path = "../../../kernel/rust/tests/support/mod.rs"]
mod support;

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::{json, Value};

const CLEAN: &str = "kind: Telo.Application\nmetadata: { name: Clean }\n";

/// The reference-form refusal of `analyzer/check-conformance/vectors/reference-form-target`.
const REFUSED: &str = "kind: Telo.Application\nmetadata: { name: TargetApp }\ntargets:\n  - { invoke: { kind: Self.Greeter, name: greeter } }\n---\nkind: Telo.Definition\nmetadata: { name: Greeter }\ncapability: Telo.Invocable\n---\nkind: Self.Greeter\nmetadata: { name: greeter }\n";
const REFUSED_MESSAGE: &str = "Telo.Application/TargetApp: object reference '{ kind, name }' at 'targets[0].invoke' is not supported; write it as '!ref greeter'";

/// `telo` run in `dir`, with colour off and a cache of its own.
fn telo(dir: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_telo"))
        .current_dir(dir)
        .env("NO_COLOR", "1")
        .env("TELO_CACHE_DIR", dir.join("cache"))
        .args(args)
        .output()
        .expect("telo runs")
}

fn write(dir: &Path, name: &str, content: &[u8]) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, content).unwrap();
    path
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn envelope(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|err| panic!("stdout is JSON: {err}: {}", stdout(output)))
}

#[test]
fn a_clean_manifest_is_no_issues_and_an_empty_envelope() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "telo.yaml", CLEAN.as_bytes());

    let text = telo(dir.path(), &["check", "telo.yaml"]);
    assert_eq!(text.status.code(), Some(0), "{}", stderr(&text));
    assert_eq!(stdout(&text), "✓  No issues found\n");
    assert_eq!(stderr(&text), "");

    let json_run = telo(dir.path(), &["check", "-o", "json", "telo.yaml"]);
    assert_eq!(json_run.status.code(), Some(0));
    assert_eq!(
        stdout(&json_run),
        "{\n  \"ok\": true,\n  \"errorCount\": 0,\n  \"warnCount\": 0,\n  \"diagnostics\": []\n}\n"
    );
}

#[test]
fn a_refused_manifest_is_a_located_diagnostic_in_both_forms_and_exits_one() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "telo.yaml", REFUSED.as_bytes());

    let text = telo(dir.path(), &["check", "telo.yaml"]);
    assert_eq!(text.status.code(), Some(1));
    assert_eq!(
        stdout(&text),
        format!("telo.yaml:4:15  error  {REFUSED_MESSAGE}  INVALID_REFERENCE_FORM\n\n1 error\n")
    );

    let json_run = telo(dir.path(), &["check", "telo.yaml", "--output", "json"]);
    assert_eq!(json_run.status.code(), Some(1));
    let payload = envelope(&json_run);
    assert_eq!(
        payload,
        json!({
            "ok": false,
            "errorCount": 1,
            "warnCount": 0,
            "diagnostics": [{
                "file": "telo.yaml",
                "line": 4,
                "column": 15,
                "severity": "error",
                "code": "INVALID_REFERENCE_FORM",
                "message": REFUSED_MESSAGE,
                "resource": "Telo.Application/TargetApp",
                "path": "targets[0].invoke",
            }]
        })
    );
    // Node's key order, which `Value` equality does not see.
    let keys: Vec<&String> = payload["diagnostics"][0].as_object().unwrap().keys().collect();
    assert_eq!(keys, ["file", "line", "column", "severity", "code", "message", "resource", "path"]);
    // stdout carries the payload and nothing else under json.
    assert!(stdout(&json_run).starts_with("{\n"));
}

#[test]
fn a_path_that_does_not_exist_is_a_load_failure_diagnostic() {
    let dir = tempfile::tempdir().unwrap();
    let output = telo(dir.path(), &["check", "-o", "json", "missing.yaml"]);
    assert_eq!(output.status.code(), Some(1));
    let payload = envelope(&output);
    assert_eq!(payload["errorCount"], 1);
    assert_eq!(payload["diagnostics"][0]["file"], "missing.yaml");
    assert!(
        payload["diagnostics"][0]["message"].as_str().unwrap().starts_with("ENOENT: no such file or directory"),
        "{payload}"
    );
    // The reason is on stderr in both formats.
    assert!(stderr(&output).starts_with("missing.yaml  error  ENOENT"), "{}", stderr(&output));
}

#[test]
fn a_construct_this_reader_cannot_hold_is_held_back_and_reported_on_stderr_while_other_paths_are_judged() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "old.yaml", format!("%YAML 1.1\n---\n{CLEAN}").as_bytes());
    write(dir.path(), "refused.yaml", REFUSED.as_bytes());

    let output = telo(dir.path(), &["check", "-o", "json", "old.yaml", "refused.yaml"]);
    assert_eq!(output.status.code(), Some(1));
    let reported = stderr(&output);
    assert!(reported.starts_with("[ERR_UNSUPPORTED_MANIFEST_FEATURE] 'old.yaml', document 1, line "), "{reported}");
    assert!(reported.contains("%YAML"), "{reported}");
    let payload = envelope(&output);
    assert_eq!(payload["ok"], false);
    assert_eq!(payload["errorCount"], 1, "{payload}");
    assert_eq!(payload["diagnostics"][0]["file"], "refused.yaml");

    // Alone, it is no diagnostic and no "No issues found" either.
    let alone = telo(dir.path(), &["check", "old.yaml"]);
    assert_eq!(alone.status.code(), Some(1));
    assert_eq!(stdout(&alone), "");
}

/// A packaged executable's trailer: version, length, sha256 and the magic.
fn trailer() -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(&0u64.to_le_bytes());
    bytes.extend_from_slice(&[0u8; 32]);
    bytes.extend_from_slice(b"TELOAPP1");
    bytes
}

fn macho_with_payload() -> Vec<u8> {
    let (header, command, section) = (32usize, 152usize, 72usize);
    let mut bytes = vec![0u8; header + command];
    bytes[0..4].copy_from_slice(&0xfeed_facfu32.to_le_bytes());
    bytes[16..20].copy_from_slice(&1u32.to_le_bytes());
    bytes[20..24].copy_from_slice(&(command as u32).to_le_bytes());
    let at = header;
    bytes[at..at + 4].copy_from_slice(&0x19u32.to_le_bytes());
    bytes[at + 4..at + 8].copy_from_slice(&(command as u32).to_le_bytes());
    bytes[at + 8..at + 8 + 8].copy_from_slice(b"TELO_APP");
    bytes[at + 64..at + 68].copy_from_slice(&1u32.to_le_bytes());
    let section_at = at + section;
    bytes[section_at..section_at + 16].copy_from_slice(b"TELO_APP_PAYLOAD");
    let payload_at = (header + command) as u32;
    bytes[section_at + 40..section_at + 48].copy_from_slice(&52u64.to_le_bytes());
    bytes[section_at + 48..section_at + 52].copy_from_slice(&payload_at.to_le_bytes());
    bytes.extend_from_slice(&trailer());
    // What follows the segment, so the magic does not end the file.
    bytes.extend_from_slice(&[0u8; 100]);
    bytes
}

fn pe_with_payload() -> Vec<u8> {
    let put32 = |bytes: &mut Vec<u8>, at: usize, value: u32| bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
    let put16 = |bytes: &mut Vec<u8>, at: usize, value: u16| bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
    let (section_va, section_file, section_len) = (0x1000u32, 264usize, 0x200usize);
    let mut bytes = vec![0u8; section_file + section_len];
    bytes[0..2].copy_from_slice(b"MZ");
    put32(&mut bytes, 60, 64);
    put32(&mut bytes, 64, 0x0000_4550);
    put16(&mut bytes, 64 + 4 + 2, 1);
    put16(&mut bytes, 64 + 4 + 16, 136);
    let optional = 88;
    put16(&mut bytes, optional, 0x20b);
    put32(&mut bytes, optional + 108, 3);
    // Data directory 2, the resources: the start of the one section.
    put32(&mut bytes, optional + 112 + 2 * 8, section_va);
    put32(&mut bytes, optional + 116 + 2 * 8, section_len as u32);
    let table = optional + 136;
    put32(&mut bytes, table + 12, section_va);
    put32(&mut bytes, table + 16, section_len as u32);
    put32(&mut bytes, table + 20, section_file as u32);
    // The tree: type RT_RCDATA (10) → name TELO_APP_PAYLOAD → one language → data.
    let tree = section_file;
    put16(&mut bytes, tree + 14, 1);
    put32(&mut bytes, tree + 16, 10);
    put32(&mut bytes, tree + 20, 0x8000_0000 | 24);
    put16(&mut bytes, tree + 24 + 12, 1);
    put32(&mut bytes, tree + 24 + 16, 0x8000_0000 | 72);
    put32(&mut bytes, tree + 24 + 20, 0x8000_0000 | 48);
    put16(&mut bytes, tree + 48 + 14, 1);
    put32(&mut bytes, tree + 48 + 16, 0);
    put32(&mut bytes, tree + 48 + 20, 108);
    let name: Vec<u16> = "TELO_APP_PAYLOAD".encode_utf16().collect();
    put16(&mut bytes, tree + 72, name.len() as u16);
    for (i, unit) in name.iter().enumerate() {
        put16(&mut bytes, tree + 74 + i * 2, *unit);
    }
    put32(&mut bytes, tree + 108, section_va + 128);
    put32(&mut bytes, tree + 112, 52);
    bytes[tree + 128..tree + 128 + 52].copy_from_slice(&trailer());
    bytes
}

#[test]
fn an_input_this_build_cannot_open_is_refused_by_what_it_is() {
    let dir = tempfile::tempdir().unwrap();
    let mut appended = b"just some executable bytes".to_vec();
    appended.extend_from_slice(&trailer());
    for (name, bytes, what) in [
        ("appended", appended, "packaged executable"),
        ("macho", macho_with_payload(), "packaged executable"),
        ("pe", pe_with_payload(), "packaged executable"),
    ] {
        write(dir.path(), name, &bytes);
        let output = telo(dir.path(), &["check", "-o", "json", name]);
        assert_eq!(output.status.code(), Some(1), "{name}: {}", stderr(&output));
        let reported = stderr(&output);
        assert!(
            reported.starts_with(&format!("[ERR_UNSUPPORTED_MANIFEST_FEATURE] '{name}' is a {what}")),
            "{name}: {reported}"
        );
        assert_eq!(envelope(&output)["ok"], false, "{name}");
        assert_eq!(envelope(&output)["diagnostics"], json!([]), "{name}");
    }

    let url = telo(dir.path(), &["check", "https://example.invalid/telo.yaml"]);
    assert_eq!(url.status.code(), Some(1));
    assert!(
        stderr(&url).starts_with("[ERR_UNSUPPORTED_MANIFEST_FEATURE] 'https://example.invalid/telo.yaml' is an http(s) manifest URL"),
        "{}",
        stderr(&url)
    );
}

#[test]
fn an_ordinary_file_carries_no_payload_even_with_a_mach_o_magic() {
    let dir = tempfile::tempdir().unwrap();
    let mut bytes = macho_with_payload();
    // The same Mach-O without its payload section's magic.
    let at = 32 + 152;
    bytes[at + 44..at + 52].copy_from_slice(b"XXXXXXXX");
    write(dir.path(), "plain", &bytes);
    let output = telo(dir.path(), &["check", "-o", "json", "plain"]);
    // Read as a manifest, which is what it is: not one the YAML reader holds.
    assert!(envelope(&output)["diagnostics"].is_array(), "{}", stderr(&output));
    assert!(!stderr(&output).contains("ERR_UNSUPPORTED_MANIFEST_FEATURE"), "{}", stderr(&output));
}

#[test]
fn refuses_a_command_line_with_exit_two_naming_the_reason() {
    let dir = tempfile::tempdir().unwrap();
    for (args, reason) in [
        (&["check"][..], "Not enough non-option arguments: got 0, need at least 1"),
        (&["check", "-o", "yaml", "telo.yaml"][..], "Invalid values:\n  Argument: output, Given: \"yaml\", Choices: \"text\", \"json\""),
    ] {
        let output = telo(dir.path(), args);
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert_eq!(stdout(&output), "");
        assert!(stderr(&output).trim_end().ends_with(reason), "{args:?}: {}", stderr(&output));
    }
}

#[test]
fn writes_the_manifest_cache_unless_told_not_to() {
    let registry = support::TestRegistry::start(false);
    let library = registry
        .publish("acme/lib", "1.0.0", "kind: Telo.Library\nmetadata:\n  name: Lib\n  version: 1.0.0\n", "", &[])
        .pinned;
    let app = format!("kind: Telo.Application\nmetadata:\n  name: App\nimports:\n  Lib: {library}\n");

    let cached = |dir: &Path| {
        let mut found = Vec::new();
        let mut pending = vec![dir.join("cache")];
        while let Some(next) = pending.pop() {
            let Ok(entries) = std::fs::read_dir(&next) else { continue };
            for entry in entries.flatten() {
                match entry.file_type() {
                    Ok(kind) if kind.is_dir() => pending.push(entry.path()),
                    _ => found.push(entry.path()),
                }
            }
        }
        found
    };

    let ephemeral = tempfile::tempdir().unwrap();
    write(ephemeral.path(), "telo.yaml", app.as_bytes());
    let output = telo(ephemeral.path(), &["check", "--no-cache-write", "telo.yaml"]);
    assert_eq!(output.status.code(), Some(0), "{}{}", stdout(&output), stderr(&output));
    assert_eq!(cached(ephemeral.path()), Vec::<PathBuf>::new());

    let persistent = tempfile::tempdir().unwrap();
    write(persistent.path(), "telo.yaml", app.as_bytes());
    let output = telo(persistent.path(), &["check", "telo.yaml"]);
    assert_eq!(output.status.code(), Some(0), "{}{}", stdout(&output), stderr(&output));
    let written = cached(persistent.path());
    assert_eq!(written.len(), 1, "{written:?}");
    assert!(written[0].ends_with("1.0.0/telo.yaml"), "{written:?}");
}

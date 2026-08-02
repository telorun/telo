//! `telo-rs run` end to end: the binary, a real manifest, real stdout.

use std::path::PathBuf;
use std::process::Command;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../kernel/rust/tests/fixtures")
        .join(name)
        .join("telo.yaml")
}

#[test]
fn prints_the_line_and_exits_zero() {
    let output = Command::new(env!("CARGO_BIN_EXE_telo-rs"))
        .arg("run")
        .arg(fixture("hello-world"))
        .output()
        .expect("telo-rs runs");

    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "Hello from Telo!\n",
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.status.code(), Some(0));
}

#[test]
fn reports_a_failing_manifest_on_stderr_and_exits_nonzero() {
    let output = Command::new(env!("CARGO_BIN_EXE_telo-rs"))
        .arg("run")
        .arg(fixture("javascript-only-kind"))
        .output()
        .expect("telo-rs runs");

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("ERR_CONTROLLER_NOT_FOUND"), "{stderr}");
    assert!(stderr.contains("console.WriteStream"), "{stderr}");
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn an_unknown_command_prints_usage() {
    let output = Command::new(env!("CARGO_BIN_EXE_telo-rs"))
        .arg("frobnicate")
        .output()
        .expect("telo-rs runs");

    assert!(String::from_utf8_lossy(&output.stderr).contains("Usage:"));
    assert_eq!(output.status.code(), Some(2));
}

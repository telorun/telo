//! `telo builtins` end to end: the binary prints the archive it was built with.
//! What each name selects is held to the renderer's record by
//! `analyzer/rust/src/builtin_vocabulary_slices.rs`, which the Node CLI's
//! slicer is held to as well.

use std::path::PathBuf;
use std::process::{Command, Output};

fn telo(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_telo"))
        .args(args)
        .output()
        .expect("telo runs")
}

#[test]
fn prints_the_rendered_archive_byte_for_byte() {
    let archive = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../analyzer/nodejs/src/builtin-vocabulary/builtins.yaml");
    let output = telo(&["builtins"]);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(output.stdout, std::fs::read(archive).expect("rendered archive"));
}

#[test]
fn exits_non_zero_naming_the_names_there_are() {
    let output = telo(&["builtins", "Aplication"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.starts_with("No built-in is named 'Aplication'. The names are:\n  kinds"),
        "{stderr}"
    );
}

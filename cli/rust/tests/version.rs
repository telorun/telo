//! `telo --version` end to end: the binary prints the telo it is — the release
//! its embedded built-in vocabulary is of, `X` or `X+unreleased`.

use std::path::PathBuf;
use std::process::Command;

#[test]
fn prints_the_identity_the_embedded_archive_carries() {
    let archive = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../analyzer/nodejs/src/builtin-vocabulary/builtins.yaml"),
    )
    .expect("rendered archive");
    // The root's `metadata.version`, read off the renderer's fixed layout: the
    // first `  version:` line, a JSON string.
    let line = archive
        .lines()
        .take_while(|line| *line != "---")
        .find_map(|line| line.strip_prefix("  version: "))
        .expect("the root's version");
    let identity: String = serde_json::from_str(line).expect("a JSON string");

    // A later token is not read: the version is answered first, as the Node CLI
    // answers it.
    for args in [&["--version"][..], &["--version", "run", "missing.yaml"][..]] {
        let output = Command::new(env!("CARGO_BIN_EXE_telo"))
            .args(args)
            .output()
            .expect("telo runs");
        assert_eq!(output.status.code(), Some(0), "{args:?}");
        assert_eq!(String::from_utf8_lossy(&output.stdout), format!("{identity}\n"));
        assert!(output.stderr.is_empty(), "{args:?}");
    }
}

//! `analyzer/check-conformance/`: each row is a manifest tree and the refusal a run of it
//! fails with. This runner loads each row and runs its targets, holding the refusal to the
//! row's `runFails` — or, when it runs, to `null`.

use std::path::{Path, PathBuf, MAIN_SEPARATOR};

use serde_json::Value;
use telo_kernel::{Kernel, KernelError};

fn vectors() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../analyzer/check-conformance/vectors")
        .canonicalize()
        .expect("vectors directory")
}

/// The refusal as one text: `[<code>] <message>`, then each diagnostic it carries on a line
/// of its own as `  [<CODE>] <message>`, the row directory's prefix removed.
fn refusal_text(error: &KernelError, dir: &Path) -> String {
    let mut lines = vec![format!("[{}] {}", error.code, error.message)];
    for diagnostic in &error.diagnostics {
        lines.push(match &diagnostic.code {
            Some(code) => format!("  [{code}] {}", diagnostic.message),
            None => format!("  {}", diagnostic.message),
        });
    }
    lines.join("\n").replace(&format!("{}{MAIN_SEPARATOR}", dir.display()), "")
}

fn run_fails(dir: &Path) -> Option<String> {
    let mut kernel = Kernel::new();
    let entry = dir.join("telo.yaml").display().to_string();
    let outcome = kernel.load(&entry).and_then(|()| kernel.run_targets().map(drop));
    outcome.err().map(|error| refusal_text(&error, dir))
}

#[test]
fn answers_every_check_conformance_row() {
    let mut ids: Vec<PathBuf> =
        std::fs::read_dir(vectors()).expect("read vectors").map(|entry| entry.expect("entry").path()).collect();
    ids.sort();
    assert!(!ids.is_empty(), "no rows");
    let mut failures = Vec::new();
    for dir in ids {
        let id = dir.file_name().unwrap().to_string_lossy().into_owned();
        let expected: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("expected.json")).expect("expected.json"),
        )
        .expect("expected.json parses");
        let mut keys: Vec<&String> = expected.as_object().expect("an object").keys().collect();
        keys.sort();
        assert_eq!(keys, ["diagnostics", "runFails"], "{id}");
        let want = match &expected["runFails"] {
            Value::Null => None,
            Value::String(text) => Some(text.clone()),
            other => panic!("{id}: runFails is {other}"),
        };
        let got = run_fails(&dir);
        if got != want {
            failures.push(format!("{id}:\n  expected {want:?}\n  got      {got:?}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

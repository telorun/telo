//! What no check-conformance row can hold: a refusal prints the diagnostics it carries, and a
//! construct only this kernel cannot read is its own refusal, ahead of every other.

use std::path::Path;

use telo_kernel::{Kernel, KernelError};

fn load(files: &[(&str, &str)]) -> (tempfile::TempDir, KernelError) {
    let dir = tempfile::tempdir().expect("temp dir");
    for (path, text) in files {
        let path = dir.path().join(path);
        std::fs::create_dir_all(path.parent().unwrap()).expect("create dir");
        std::fs::write(path, text).expect("write manifest");
    }
    let entry = dir.path().join("app/telo.yaml");
    let err = Kernel::new().load(&entry.display().to_string()).expect_err("load must fail");
    (dir, err)
}

fn source(dir: &Path, path: &str) -> String {
    dir.join(path).display().to_string()
}

/// The refusal names its cause wherever it is written, not its headline alone.
#[test]
fn a_refusal_prints_the_diagnostics_it_carries() {
    let (_dir, err) = load(&[
        ("app/telo.yaml", "kind: Telo.Application\nmetadata: { name: App }\nimports: { Lib: ../lib }\n"),
        (
            "lib/telo.yaml",
            "kind: Telo.Library\nmetadata: { name: CapLib }\n---\nkind: Telo.Definition\nmetadata: { name: Misspelled }\ncapability: Telo.Invokable\n",
        ),
    ]);
    assert!(
        err.to_string().starts_with(
            "[ERR_MANIFEST_VALIDATION_FAILED] Manifest validation failed\n  [CAPABILITY_UNKNOWN] Imported library 'CapLib'"
        ),
        "{err}"
    );
}

#[test]
fn a_construct_this_kernel_cannot_read_is_refused_first() {
    let (dir, err) = load(&[(
        "app/telo.yaml",
        "kind: Telo.Application\nmetadata: { name: App }\nname: 1\nname: 2\n---\nkind: Thing\nvalue: !cel \"1 + 1\"\n",
    )]);
    assert_eq!(err.code, "ERR_UNSUPPORTED_MANIFEST_FEATURE", "{err}");
    assert_eq!(
        err.message,
        format!(
            "'{}', document 2, line 7, column 13: `!cel` holds CEL, and this kernel has no expression engine: reading it as a literal would silently produce the wrong value",
            source(dir.path(), "app/telo.yaml")
        )
    );
    assert!(err.diagnostics.is_empty());
}

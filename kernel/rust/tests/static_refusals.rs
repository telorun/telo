//! A load the analysis refuses is refused before any module is created, as the Node kernel
//! refuses it: a file that does not parse as one `ERR_MANIFEST_VALIDATION_FAILED` naming each
//! file, the analysis's errors as one `ERR_MANIFEST_VALIDATION_FAILED`, each carrying its
//! diagnostics — and a construct only this kernel cannot read as its own refusal, ahead of both.

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

fn findings(err: &KernelError) -> Vec<(String, String)> {
    err.diagnostics.iter().map(|d| (d.code.clone().unwrap_or_default(), d.message.clone())).collect()
}

fn source(dir: &Path, path: &str) -> String {
    dir.join(path).display().to_string()
}

const DUPLICATE_KEY: &str = "This key is already written earlier in the same mapping; a mapping holds each key once, so remove or rename one of the two.";

#[test]
fn a_file_that_does_not_parse_is_refused_naming_it() {
    let (dir, err) = load(&[
        ("app/telo.yaml", "kind: Telo.Application\nmetadata: { name: App }\nimports: { Lib: ../lib }\n"),
        ("lib/telo.yaml", "kind: Telo.Library\nmetadata: { name: Lib }\nname: 1\nname: 2\n"),
    ]);
    assert_eq!(err.code, "ERR_MANIFEST_VALIDATION_FAILED", "{err}");
    assert_eq!(err.message, format!("{}: {DUPLICATE_KEY}", source(dir.path(), "lib/telo.yaml")));
    assert_eq!(findings(&err), [("MANIFEST_PARSE_FAILED".to_string(), DUPLICATE_KEY.to_string())]);
}

#[test]
fn a_loader_refusal_is_a_parse_failure() {
    let (dir, err) = load(&[(
        "app/telo.yaml",
        "kind: Telo.Application\nmetadata: !if { if: true, then: { name: A } }\n",
    )]);
    let message = "'!if' at 'metadata' of the Telo.Application document: the loader reads the module's name before anything is expanded, so it cannot be chosen or repeated. Write it plainly.";
    assert_eq!(err.code, "ERR_MANIFEST_VALIDATION_FAILED", "{err}");
    assert_eq!(err.message, format!("{}: {message}", source(dir.path(), "app/telo.yaml")));
    assert_eq!(findings(&err), [("BRANCH_POSITION_INVALID".to_string(), message.to_string())]);
}

#[test]
fn a_dependency_s_capability_is_refused_at_the_import_reaching_it() {
    let (_dir, err) = load(&[
        ("app/telo.yaml", "kind: Telo.Application\nmetadata: { name: App }\nimports: { Lib: ../lib }\n"),
        (
            "lib/telo.yaml",
            "kind: Telo.Library\nmetadata: { name: CapLib }\n---\nkind: Telo.Definition\nmetadata: { name: Misspelled }\ncapability: Telo.Invokable\n",
        ),
    ]);
    assert_eq!(err.code, "ERR_MANIFEST_VALIDATION_FAILED", "{err}");
    assert_eq!(err.message, "Manifest validation failed");
    // The refusal names its cause wherever it is written, not its headline alone.
    assert!(
        err.to_string().starts_with(
            "[ERR_MANIFEST_VALIDATION_FAILED] Manifest validation failed\n  [CAPABILITY_UNKNOWN] Imported library 'CapLib'"
        ),
        "{err}"
    );
    assert_eq!(
        findings(&err),
        [(
            "CAPABILITY_UNKNOWN".to_string(),
            "Imported library 'CapLib', reached through import 'Lib': Telo.Definition 'Misspelled': 'Telo.Invokable' is not a capability. Did you mean 'Telo.Invocable'? A capability names a lifecycle role — one of: Telo.Callable, Telo.Invocable, Telo.Mount, Telo.Provider, Telo.Runnable, Telo.Service, Telo.Sink, Telo.Type.".to_string()
        )]
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
            "'{}', document 1, line 7, column 13: `!cel` holds CEL, and this kernel has no expression engine: reading it as a literal would silently produce the wrong value",
            source(dir.path(), "app/telo.yaml")
        )
    );
    assert!(err.diagnostics.is_empty());
}

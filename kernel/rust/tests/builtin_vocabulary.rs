//! The built-in vocabulary archive is read, never run or imported, and the
//! refusal says what it is in the words the Node half uses.

use std::path::PathBuf;

use telo_kernel::Kernel;

fn fixture(name: &str) -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
        .join("telo.yaml")
        .display()
        .to_string()
}

#[test]
fn refuses_the_archive_as_an_entry() {
    let err = Kernel::new()
        .load(&fixture("builtins-entry"))
        .expect_err("load must fail");
    assert_eq!(err.code, "ERR_MANIFEST_VALIDATION_FAILED", "{err}");
    assert_eq!(
        err.message,
        "Telo.Builtins is the published built-in vocabulary of a telo release; it is read, never declared, run or imported."
    );
}

#[test]
fn refuses_the_archive_as_an_import_saying_what_to_write_instead() {
    let err = Kernel::new()
        .load(&fixture("builtins-import"))
        .expect_err("load must fail");
    assert_eq!(err.code, "ERR_INVALID_IMPORT_TARGET", "{err}");
    assert!(
        err.message.ends_with(
            "is the built-in vocabulary of telo 0.119.0; its kinds need no import — remove this `imports:` entry and write them as `Telo.<Kind>`."
        ),
        "{err}"
    );
}

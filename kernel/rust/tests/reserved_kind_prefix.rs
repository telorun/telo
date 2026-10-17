//! `Telo` and `Self` are the runtime's kind prefixes: no module may be named
//! after one and no import aliased one (`ERR_KIND_PREFIX_RESERVED`).

use std::path::PathBuf;

use telo_kernel::Kernel;

fn refusal(name: &str) -> telo_kernel::KernelError {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
        .join("telo.yaml");
    Kernel::new()
        .load(&path.display().to_string())
        .expect_err("load must fail")
}

#[test]
fn refuses_an_application_named_telo() {
    let err = refusal("reserved-application-name");
    assert_eq!(err.code, "ERR_KIND_PREFIX_RESERVED", "{err}");
    assert!(err.message.starts_with("A module may not be named 'Telo'"), "{err}");
}

#[test]
fn refuses_an_import_reaching_a_library_named_self() {
    let err = refusal("reserved-library-name");
    assert_eq!(err.code, "ERR_KIND_PREFIX_RESERVED", "{err}");
    assert!(err.message.contains("is a Telo.Library named 'Self'"), "{err}");
}

#[test]
fn refuses_an_import_aliased_telo() {
    let err = refusal("reserved-import-alias");
    assert_eq!(err.code, "ERR_KIND_PREFIX_RESERVED", "{err}");
    assert!(err.message.starts_with("An import may not be aliased 'Telo'"), "{err}");
}

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

fn findings(err: &telo_kernel::KernelError) -> Vec<(String, String)> {
    err.diagnostics
        .iter()
        .map(|d| (d.code.clone().unwrap_or_default(), d.message.clone()))
        .collect()
}

const WHY: &str = "`Telo.<Kind>` names a built-in kind and `Self.<Kind>` the declaring module's own";

/// The entry's own name is the load's analysis's: one `ERR_MANIFEST_VALIDATION_FAILED`.
#[test]
fn refuses_an_application_named_telo() {
    let err = refusal("reserved-application-name");
    assert_eq!(err.code, "ERR_MANIFEST_VALIDATION_FAILED", "{err}");
    assert_eq!(
        findings(&err),
        [(
            "KIND_PREFIX_RESERVED".to_string(),
            format!("Telo.Application/Telo: A module may not be named 'Telo': {WHY}, so its kinds would replace them. Rename the module.")
        )]
    );
}

/// An import's refusal is raised per import, under its own code and the loader's message.
#[test]
fn refuses_an_import_reaching_a_library_named_self() {
    let err = refusal("reserved-library-name");
    assert_eq!(err.code, "ERR_KIND_PREFIX_RESERVED", "{err}");
    let library = format!("'../self-named-library' is a Telo.Library named 'Self': {WHY}, so its kinds would replace them. It cannot be imported until it is renamed.");
    assert_eq!(err.message, library);
    assert_eq!(
        findings(&err),
        [("KIND_PREFIX_RESERVED".to_string(), format!("Cannot use import 'Lib' → '../self-named-library': {library}"))]
    );
}

#[test]
fn refuses_an_import_aliased_telo() {
    let err = refusal("reserved-import-alias");
    assert_eq!(err.code, "ERR_KIND_PREFIX_RESERVED", "{err}");
    let alias = format!("An import may not be aliased 'Telo': {WHY}, so this import would replace them. Choose another alias.");
    assert_eq!(err.message, alias);
    assert_eq!(
        findings(&err),
        [("KIND_PREFIX_RESERVED".to_string(), format!("Cannot use import 'Telo' → '../plain-library': {alias}"))]
    );
}

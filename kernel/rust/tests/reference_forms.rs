//! A reference is told from an inline declaration by the resolved-reference
//! marker, never by a `name`: a resource of a kind declaring a `name` field is
//! accepted, while `{ kind, name }` at a reference slot, for a kind declaring
//! none, is the legacy object form of a reference — refused in the entry's own
//! module, read as the reference it means in an imported library.

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
fn runs_a_resource_whose_kind_declares_a_name_field() {
    let mut kernel = Kernel::new();
    kernel.load(&fixture("name-field")).expect("manifest loads");
    assert_eq!(kernel.run_targets().expect("targets run"), vec![serde_json::json!("named")]);
}

#[test]
fn refuses_the_object_form_at_a_reference_slot() {
    let err = Kernel::new()
        .load(&fixture("object-reference-form"))
        .expect_err("load must fail");
    assert_eq!(err.code, "ERR_INVALID_REFERENCE_FORM", "{err}");
    assert_eq!(
        err.message,
        "Self.Server/server: object reference '{ kind, name }' at 'mounts[0].mount' is not supported; write it as '!ref usersApi'"
    );
}

#[test]
fn refuses_a_target_written_as_the_object_form() {
    let err = Kernel::new()
        .load(&fixture("bare-target-object-form"))
        .expect_err("load must fail");
    assert_eq!(err.code, "ERR_INVALID_REFERENCE_FORM", "{err}");
    assert_eq!(
        err.message,
        "Telo.Application/BareTargetObjectForm: object reference '{ kind, name }' at 'targets[0]' is not supported; write it as '!ref greeter'"
    );
}

#[test]
fn reads_a_library_object_form_as_the_reference_it_means() {
    Kernel::new()
        .load(&fixture("library-object-form"))
        .expect("a library carrying the legacy form loads");
}

#[test]
fn refuses_a_library_marker_when_the_import_loads_it() {
    let err = Kernel::new()
        .load(&fixture("library-marker-form"))
        .expect_err("load must fail");
    assert_eq!(err.code, "ERR_INVALID_REFERENCE_FORM", "{err}");
    assert_eq!(
        err.message,
        "Self.Server/server: '__ref' at 'mounts[0].mount' is not supported — it marks a reference the loader resolved; write a reference as '!ref usersApi'"
    );
}
